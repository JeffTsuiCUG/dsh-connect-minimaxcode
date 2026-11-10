/**
 * Reading the account's usage profile.
 *
 * The upstream summarizes the account's token use into a handful of headline
 * numbers plus a daily series, and it adds fields over time. These tests pin
 * which fields are read, that a field the upstream does not send — or sends in
 * a shape this does not recognise — costs only that field, and that a profile
 * that cannot be read never takes the balance down with it.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  MinimaxCredits,
  USAGE_SUMMARY_PATH,
  fetchUsageProfile,
  parseUsageProfile,
  type OAuthCredential,
} from '../src/credits.ts'

const CREDENTIAL: OAuthCredential = {
  token: 'mmoat_example',
  clientId: 'mcode-public',
  scopes: ['agent.default'],
  audience: 'agent-backend',
}

/** A response captured from the desktop app's own traffic, trimmed to shape. */
function summaryDocument(overrides: Record<string, unknown> = {}): unknown {
  return {
    total_days: 90,
    total_token_consumed: '826.14M',
    usage_ranking_percent: 10.296932108741714,
    most_active_day: {
      date: '2026-10-19',
      token_count: '234.25M',
      image_count: '0',
      video_count: '0',
    },
    active_days: 30,
    current_consecutive_days: 1,
    daily_token_usage: [0, 1_234_567, 0, 890_000],
    date_model_usage: [],
    last_update_time: '11-10 18:00',
    ...overrides,
  }
}

/** The query the desktop app sends, in the order it sends it. */
const EXPECTED_QUERY = 'token_type=5&heatmap_days=365&business=Agent&device_platform=desktop'

describe('parseUsageProfile', () => {
  it('reads the headline numbers out of the captured response', () => {
    const profile = parseUsageProfile(summaryDocument())
    expect(profile?.totalDays).toBe(90)
    expect(profile?.activeDays).toBe(30)
    expect(profile?.currentConsecutiveDays).toBe(1)
    expect(profile?.usageRankingPercent).toBe(10.296932108741714)
    expect(profile?.lastUpdateTime).toBe('11-10 18:00')
  })

  it('keeps the token counts in the wording the upstream used', () => {
    // The upstream writes them with their own unit ("826.14M"), so they are not
    // pulled apart into a number here.
    const profile = parseUsageProfile(summaryDocument())
    expect(profile?.totalTokenConsumed).toBe('826.14M')
    expect(profile?.mostActiveDay).toEqual({ date: '2026-10-19', tokenCount: '234.25M' })
  })

  it('keeps the daily series in the order it arrived', () => {
    const profile = parseUsageProfile(summaryDocument())
    expect(profile?.dailyTokenUsage).toEqual([0, 1_234_567, 0, 890_000])
  })

  it('drops the entries of the daily series that are not numbers', () => {
    const profile = parseUsageProfile(summaryDocument({ daily_token_usage: [1, 'two', null, 3, undefined, {}] }))
    expect(profile?.dailyTokenUsage).toEqual([1, 3])
  })

  it('reports nothing for a body that is not an object', () => {
    expect(parseUsageProfile('not json')).toBeUndefined()
    expect(parseUsageProfile(null)).toBeUndefined()
    expect(parseUsageProfile(42)).toBeUndefined()
  })

  it('reports a field the upstream did not send as absent', () => {
    const profile = parseUsageProfile(summaryDocument({ total_days: undefined, usage_ranking_percent: undefined }))
    expect(profile?.totalDays).toBeUndefined()
    expect(profile?.usageRankingPercent).toBeUndefined()
    // The fields that were sent are still read.
    expect(profile?.activeDays).toBe(30)
  })

  it('ignores a field that arrives in a shape it does not recognise', () => {
    const profile = parseUsageProfile(summaryDocument({
      total_days: 'ninety',
      total_token_consumed: 826_140_000,
      most_active_day: '2026-10-19',
      last_update_time: 1_762_800_000,
      daily_token_usage: 'not a series',
    }))
    expect(profile?.totalDays).toBeUndefined()
    expect(profile?.totalTokenConsumed).toBeUndefined()
    expect(profile?.mostActiveDay).toBeUndefined()
    expect(profile?.lastUpdateTime).toBeUndefined()
    expect(profile?.dailyTokenUsage).toBeUndefined()
  })

  it('reports no busiest day when the upstream named none', () => {
    expect(parseUsageProfile(summaryDocument({ most_active_day: undefined }))?.mostActiveDay).toBeUndefined()
    expect(parseUsageProfile(summaryDocument({ most_active_day: {} }))?.mostActiveDay).toBeUndefined()
  })

  it('reports the busiest day when only one half of it arrived', () => {
    const profile = parseUsageProfile(summaryDocument({ most_active_day: { date: '2026-10-19' } }))
    expect(profile?.mostActiveDay).toEqual({ date: '2026-10-19', tokenCount: undefined })
  })
})

describe('fetchUsageProfile', () => {
  it('asks the open-platform host with the query the app sends', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(summaryDocument()), { status: 200 }))
    const profile = await fetchUsageProfile(CREDENTIAL, 'cn', fetchImpl as unknown as typeof fetch)
    expect(profile?.totalTokenConsumed).toBe('826.14M')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe(`https://www.minimaxi.com${USAGE_SUMMARY_PATH}?${EXPECTED_QUERY}`)
    expect(String(url)).toContain(EXPECTED_QUERY)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer mmoat_example')
  })

  it('throws on a response that is not ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    await expect(fetchUsageProfile(CREDENTIAL, 'cn', fetchImpl as unknown as typeof fetch)).rejects.toThrow('HTTP 401')
  })

  it('reports no profile when the body carries no object', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }))
    expect(await fetchUsageProfile(CREDENTIAL, 'cn', fetchImpl as unknown as typeof fetch)).toBeUndefined()
  })
})

/** A membership response carrying a balance. */
function membership(total: string): Response {
  return new Response(JSON.stringify({
    op_credit_summary: { total_remaining_amount: total, purchased_remaining_amount: '0', free_remaining_amount: total },
  }), { status: 200 })
}

/** A fetch that answers per endpoint, so the account reads can differ. */
function routingFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL) => {
    const target = String(url)
    for (const [needle, respond] of Object.entries(handlers)) {
      if (target.includes(needle)) return respond()
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

describe('MinimaxCredits usage profile', () => {
  it('rides along with a balance refresh', async () => {
    const credits = new MinimaxCredits()
    const fetchImpl = routingFetch({
      'get_membership_info': () => membership('100'),
      'usage_summary': () => new Response(JSON.stringify(summaryDocument()), { status: 200 }),
    })
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    expect(credits.usageProfile?.totalDays).toBe(90)
    expect(credits.usageProfile?.totalTokenConsumed).toBe('826.14M')
    expect(credits.usageProfile?.mostActiveDay?.date).toBe('2026-10-19')
    expect(credits.usageProfile?.dailyTokenUsage).toEqual([0, 1_234_567, 0, 890_000])
    expect(credits.usageProfileError).toBeUndefined()
  })

  it('reads the profile after the rate-limit windows', async () => {
    const asked: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url)
      asked.push(target)
      if (target.includes('get_membership_info')) return membership('100')
      if (target.includes('usage_summary')) return new Response(JSON.stringify(summaryDocument()), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const credits = new MinimaxCredits()
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    const profile = asked.findIndex(url => url.includes('usage_summary'))
    const windows = asked.findIndex(url => url.includes('remains_percent'))
    expect(profile).toBeGreaterThan(-1)
    expect(windows).toBeGreaterThan(-1)
    expect(profile).toBeGreaterThan(windows)
  })

  it('keeps the balance readable when the profile cannot be read', async () => {
    const credits = new MinimaxCredits()
    const fetchImpl = routingFetch({
      'get_membership_info': () => membership('100'),
      'usage_summary': () => new Response('forbidden', { status: 403 }),
    })
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    expect(credits.snapshot?.summary.total).toBe(100)
    expect(credits.error).toBeUndefined()
    expect(credits.usageProfile).toBeUndefined()
    expect(credits.usageProfileError).toContain('403')
  })

  it('keeps the last profile when a later read fails', async () => {
    const credits = new MinimaxCredits()
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('100'),
      'usage_summary': () => new Response(JSON.stringify(summaryDocument()), { status: 200 }),
    }), 1000)
    expect(credits.usageProfile?.totalDays).toBe(90)

    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('90'),
      'usage_summary': () => new Response('unauthorized', { status: 401 }),
    }), 2000)
    expect(credits.usageProfile?.totalDays).toBe(90)
    expect(credits.usageProfileError).toContain('401')
    // The balance keeps moving regardless.
    expect(credits.snapshot?.summary.total).toBe(90)
  })
})
