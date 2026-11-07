/**
 * Reading the plan's rate-limit windows.
 *
 * The upstream answers with one entry per metered group, percents as strings,
 * and counts of -1 where the plan does not meter by count. These tests pin
 * which fields are read, that the general entry is preferred, and that the
 * window length is derived from the entry's own edges rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import {
  MinimaxCredits,
  REMAINS_PERCENT_PATH,
  fetchRateLimitWindows,
  parseRateLimitWindows,
  type OAuthCredential,
} from '../src/credits.ts'

const CREDENTIAL: OAuthCredential = {
  token: 'mmoat_example',
  clientId: 'mcode-public',
  scopes: ['agent.default'],
  audience: 'agent-backend',
}

/** A response captured from the desktop app's own traffic, trimmed to shape. */
function windowsDocument(overrides: Record<string, unknown> = {}): unknown {
  return {
    model_remains: [
      {
        model_name: 'general',
        start_time: 1_793_882_204_091,
        end_time: 1_793_900_204_091,
        remains_time: 8_744_666,
        current_interval_total_count: -1,
        current_interval_used_count: -1,
        current_interval_remains_count: -1,
        current_interval_used_percent: '19%',
        current_interval_total_percent: '100%',
        current_interval_status: 1,
        weekly_start_time: 1_793_783_898_054,
        weekly_end_time: 1_794_388_698_054,
        weekly_remains_time: 497_238_629,
        current_weekly_total_count: -1,
        current_weekly_used_count: -1,
        current_weekly_remains_count: -1,
        current_weekly_used_percent: '29%',
        current_weekly_total_percent: '100%',
        current_weekly_status: 1,
        ...overrides,
      },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  }
}

describe('parseRateLimitWindows', () => {
  it('reads both windows out of the captured response', () => {
    const windows = parseRateLimitWindows(windowsDocument())
    expect(windows).toEqual({
      interval: { usedPercent: 19, startAtMs: 1_793_882_204_091, resetAtMs: 1_793_900_204_091 },
      weekly: { usedPercent: 29, startAtMs: 1_793_783_898_054, resetAtMs: 1_794_388_698_054 },
    })
  })

  it('derives the window lengths from the edges, not from the plan terms', () => {
    const windows = parseRateLimitWindows(windowsDocument())
    expect(windows).toBeDefined()
    // 18,000,000 ms is five hours, 604,800,000 ms is seven days — but the
    // parser never hard-codes either: it only reports what the entry says.
    expect(windows!.interval.resetAtMs - windows!.interval.startAtMs).toBe(18_000_000)
    expect(windows!.weekly.resetAtMs - windows!.weekly.startAtMs).toBe(604_800_000)
  })

  it('prefers the general entry when other groups come first', () => {
    const document = windowsDocument() as Record<string, unknown>
    const entries = document.model_remains as Record<string, unknown>[]
    document.model_remains = [
      { ...entries[0], model_name: 'other', current_interval_used_percent: '5%' },
      entries[0],
    ]
    const windows = parseRateLimitWindows(document)
    expect(windows?.interval.usedPercent).toBe(19)
  })

  it('falls back to the first entry when no group is named general', () => {
    const document = windowsDocument({ model_name: 'coding' })
    expect(parseRateLimitWindows(document)?.interval.usedPercent).toBe(19)
  })

  it('reports nothing when the response carries no entries', () => {
    expect(parseRateLimitWindows({ model_remains: [] })).toBeUndefined()
    expect(parseRateLimitWindows({})).toBeUndefined()
    expect(parseRateLimitWindows('not json')).toBeUndefined()
  })

  it('reports nothing when a window field is missing', () => {
    expect(parseRateLimitWindows(windowsDocument({ current_interval_used_percent: undefined }))).toBeUndefined()
    expect(parseRateLimitWindows(windowsDocument({ weekly_end_time: undefined }))).toBeUndefined()
  })

  it('ignores the -1 counts the plan sends where it does not meter by count', () => {
    const windows = parseRateLimitWindows(windowsDocument())
    expect(windows?.interval.usedPercent).toBe(19)
    expect(windows?.weekly.usedPercent).toBe(29)
  })

  it('reads a percent that arrives as a number as well as a string', () => {
    // The desktop app parses both shapes, so both are accepted here.
    const windows = parseRateLimitWindows(windowsDocument({ current_interval_used_percent: 19 }))
    expect(windows?.interval.usedPercent).toBe(19)
  })

  it('reports no window for a quota the server marks as unlimited', () => {
    // The app reads the same field: `isUnlimited: 3 === status`. A window
    // without an allowance has no percentage to report, and a "0%" of an
    // unlimited quota is a number nobody can act on.
    expect(parseRateLimitWindows(windowsDocument({ current_interval_status: 3 }))).toBeUndefined()
    expect(parseRateLimitWindows(windowsDocument({ current_weekly_status: 3 }))).toBeUndefined()
    // A window that is merely metered (status 1) is still read.
    expect(parseRateLimitWindows(windowsDocument({ current_interval_status: 1 }))?.interval.usedPercent).toBe(19)
  })
})

describe('fetchRateLimitWindows', () => {
  it('asks the open-platform host with the query the app sends', async () => {
    let requestedUrl = ''
    let authorization = ''
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requestedUrl = String(url)
      authorization = String((init?.headers as Record<string, string>)?.authorization)
      return new Response(JSON.stringify(windowsDocument()), { status: 200 })
    }) as typeof fetch
    const windows = await fetchRateLimitWindows(CREDENTIAL, 'cn', fetchImpl)
    expect(windows?.weekly.usedPercent).toBe(29)
    expect(requestedUrl).toBe(`https://www.minimaxi.com${REMAINS_PERCENT_PATH}?business=Agent&device_platform=desktop`)
    expect(authorization).toBe('Bearer mmoat_example')
  })

  it('throws on a response that is not ok', async () => {
    const fetchImpl = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    await expect(fetchRateLimitWindows(CREDENTIAL, 'cn', fetchImpl)).rejects.toThrow('HTTP 401')
  })

  it('reports no windows when the account has none rather than throwing', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ model_remains: [] }), { status: 200 })) as typeof fetch
    expect(await fetchRateLimitWindows(CREDENTIAL, 'cn', fetchImpl)).toBeUndefined()
  })
})

/** A membership response carrying a balance. */
function membership(total: string): Response {
  return new Response(JSON.stringify({
    op_credit_summary: { total_remaining_amount: total, purchased_remaining_amount: '0', free_remaining_amount: total },
  }), { status: 200 })
}

/** A fetch that answers per endpoint, so the three account reads can differ. */
function routingFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL) => {
    const target = String(url)
    for (const [needle, respond] of Object.entries(handlers)) {
      if (target.includes(needle)) return respond()
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

describe('MinimaxCredits rate-limit windows', () => {
  it('rides along with a balance refresh', async () => {
    const credits = new MinimaxCredits()
    const fetchImpl = routingFetch({
      'get_membership_info': () => membership('100'),
      [REMAINS_PERCENT_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    })
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    expect(credits.rateLimit?.interval.usedPercent).toBe(19)
    expect(credits.rateLimit?.weekly.usedPercent).toBe(29)
    expect(credits.rateLimitError).toBeUndefined()
    expect(credits.rateLimitAtMs).toBe(1000)
  })

  it('keeps the balance readable when the windows cannot be read', async () => {
    const credits = new MinimaxCredits()
    const fetchImpl = routingFetch({
      'get_membership_info': () => membership('100'),
      [REMAINS_PERCENT_PATH]: () => new Response('forbidden', { status: 403 }),
    })
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    expect(credits.snapshot?.summary.total).toBe(100)
    expect(credits.error).toBeUndefined()
    expect(credits.rateLimit).toBeUndefined()
    expect(credits.rateLimitError).toContain('403')
  })

  it('keeps the last windows when a later read fails', async () => {
    const credits = new MinimaxCredits()
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('100'),
      [REMAINS_PERCENT_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    }), 1000)
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('90'),
      [REMAINS_PERCENT_PATH]: () => new Response('unauthorized', { status: 401 }),
    }), 2000)
    expect(credits.rateLimit?.weekly.usedPercent).toBe(29)
    expect(credits.rateLimitError).toContain('401')
  })
})
