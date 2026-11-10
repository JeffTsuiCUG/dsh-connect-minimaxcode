/**
 * Where the rate-limit windows are read from.
 *
 * The open platform documents `GET /v1/token_plan/remains` as the way to read
 * the quota, and it asks for an API secret key rather than the desktop app's
 * OAuth bearer. The older path the plugin started with now answers 200 with
 * an empty body, so a plugin that kept using it would show nothing for every
 * account and say nothing about why.
 *
 * These cases pin the chain — the plan key comes from the open platform, the
 * quota comes from the documented path, an account with no plan key falls
 * back to the older path — and the one thing that matters most: an account
 * with no plan subscription is told so plainly, rather than being reported
 * as a read that failed.
 */

import { describe, expect, it } from 'vitest'
import {
  MinimaxCredits,
  REMAINS_PERCENT_PATH,
  TOKEN_PLAN_CREDIT_PATH,
  TOKEN_PLAN_REMAINS_PATH,
  fetchRateLimitWindows,
  fetchTokenPlanApiKey,
  fetchTokenPlanWindows,
  type OAuthCredential,
} from '../src/credits.ts'

const CREDENTIAL: OAuthCredential = {
  token: 'mmoat_example',
  clientId: 'mcode-public',
  scopes: ['agent.default'],
  audience: 'agent-backend',
}

const PLAN_KEY = 'sk-cp-example-plan-key'

/** A response captured from the desktop app's own traffic, trimmed to shape. */
function windowsDocument(): unknown {
  return {
    model_remains: [
      {
        model_name: 'general',
        start_time: 1_793_882_204_091,
        end_time: 1_793_900_204_091,
        current_interval_used_percent: '19%',
        current_interval_status: 1,
        weekly_start_time: 1_793_783_898_054,
        weekly_end_time: 1_794_388_698_054,
        current_weekly_used_percent: '29%',
        current_weekly_status: 1,
      },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  }
}

/** A request the fetch stub saw. */
interface Seen {
  url: string
  authorization: string
}

/** A fetch that answers per endpoint and records what it was asked. */
function routingFetch(handlers: Record<string, () => Response>, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    seen.push({
      url: target,
      authorization: String((init?.headers as Record<string, string>)?.authorization),
    })
    for (const [needle, respond] of Object.entries(handlers)) {
      if (target.includes(needle)) return respond()
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

/** A membership response carrying a balance. */
function membership(total: string): Response {
  return new Response(JSON.stringify({
    op_credit_summary: { total_remaining_amount: total, purchased_remaining_amount: '0', free_remaining_amount: total },
  }), { status: 200 })
}

describe('fetchTokenPlanApiKey', () => {
  it('asks the open platform with the OAuth bearer and reads the key back', async () => {
    const seen: Seen[] = []
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response(JSON.stringify({ api_key: PLAN_KEY }), { status: 200 }),
    }, seen)
    expect(await fetchTokenPlanApiKey(CREDENTIAL, 'cn', fetchImpl)).toBe(PLAN_KEY)
    expect(seen[0]?.url).toContain(TOKEN_PLAN_CREDIT_PATH)
    expect(seen[0]?.authorization).toBe('Bearer mmoat_example')
  })

  it('reports no key when the account has none', async () => {
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response(JSON.stringify({}), { status: 200 }),
    })
    expect(await fetchTokenPlanApiKey(CREDENTIAL, 'cn', fetchImpl)).toBeUndefined()
  })

  it('throws when the open platform cannot be reached', async () => {
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response('nope', { status: 503 }),
    })
    await expect(fetchTokenPlanApiKey(CREDENTIAL, 'cn', fetchImpl)).rejects.toThrow('HTTP 503')
  })
})

describe('fetchTokenPlanWindows', () => {
  it('asks the documented path with the plan key', async () => {
    const seen: Seen[] = []
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    }, seen)
    const read = await fetchTokenPlanWindows(PLAN_KEY, 'cn', fetchImpl)
    expect(read.windows?.interval.usedPercent).toBe(19)
    expect(read.windows?.weekly.usedPercent).toBe(29)
    expect(read.error).toBeUndefined()
    expect(seen[0]?.url).toContain(TOKEN_PLAN_REMAINS_PATH)
    // The documented path wants an API secret key, not the desktop app's
    // bearer; sending the wrong one is what it answers "not login" to.
    expect(seen[0]?.authorization).toBe(`Bearer ${PLAN_KEY}`)
  })

  it('reports an account with no subscription as having no windows, not as a failure', async () => {
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response(JSON.stringify({
        model_remains: null,
        base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' },
      }), { status: 200 }),
    })
    const read = await fetchTokenPlanWindows(PLAN_KEY, 'cn', fetchImpl)
    expect(read.absence).toBe('no-subscription')
    expect(read.windows).toBeUndefined()
    // No plan means no windows, which is a fact — not something that failed.
    expect(read.error).toBeUndefined()
  })

  it('reports a rejected plan key as an error', async () => {
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response(JSON.stringify({
        base_resp: { status_code: 1004, status_msg: 'login fail' },
      }), { status: 200 }),
    })
    const read = await fetchTokenPlanWindows(PLAN_KEY, 'cn', fetchImpl)
    expect(read.error).toBeDefined()
    expect(read.absence).toBeUndefined()
  })

  it('throws when the endpoint cannot be reached', async () => {
    const fetchImpl = routingFetch({
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response('nope', { status: 500 }),
    })
    await expect(fetchTokenPlanWindows(PLAN_KEY, 'cn', fetchImpl)).rejects.toThrow('HTTP 500')
  })
})

describe('MinimaxCredits quota reading', () => {
  it('reads the windows from the documented endpoint', async () => {
    const credits = new MinimaxCredits()
    const seen: Seen[] = []
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('100'),
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response(JSON.stringify({ api_key: PLAN_KEY }), { status: 200 }),
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    }, seen), 1000)

    expect(credits.rateLimit?.interval.usedPercent).toBe(19)
    expect(credits.rateLimit?.weekly.usedPercent).toBe(29)
    expect(credits.rateLimitError).toBeUndefined()
    expect(credits.rateLimitAbsence).toBeUndefined()
    // The documented path was asked, and with the plan key rather than the
    // desktop app's bearer.
    expect(seen.some(s => s.url.includes(TOKEN_PLAN_REMAINS_PATH))).toBe(true)
    const quota = seen.find(s => s.url.includes(TOKEN_PLAN_REMAINS_PATH))
    expect(quota?.authorization).toBe(`Bearer ${PLAN_KEY}`)
  })

  it('remembers the plan key between reads', async () => {
    const credits = new MinimaxCredits()
    const seen: Seen[] = []
    const fetchImpl = routingFetch({
      'get_membership_info': () => membership('100'),
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response(JSON.stringify({ api_key: PLAN_KEY }), { status: 200 }),
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    }, seen)
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 2000)
    expect(seen.filter(s => s.url.includes(TOKEN_PLAN_CREDIT_PATH))).toHaveLength(1)
  })

  it('falls back to the older path when the account has no plan key', async () => {
    const credits = new MinimaxCredits()
    const seen: Seen[] = []
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('100'),
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response(JSON.stringify({}), { status: 200 }),
      [REMAINS_PERCENT_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    }, seen), 1000)

    expect(credits.rateLimit?.weekly.usedPercent).toBe(29)
    expect(credits.rateLimitError).toBeUndefined()
    // The older path is asked with the desktop app's own bearer.
    const legacy = seen.find(s => s.url.includes(REMAINS_PERCENT_PATH))
    expect(legacy?.authorization).toBe('Bearer mmoat_example')
  })

  it('says an account with no subscription has no windows, without an error', async () => {
    const credits = new MinimaxCredits()
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('100'),
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response(JSON.stringify({ api_key: PLAN_KEY }), { status: 200 }),
      [TOKEN_PLAN_REMAINS_PATH]: () => new Response(JSON.stringify({
        model_remains: null,
        base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' },
      }), { status: 200 }),
    }), 1000)

    expect(credits.rateLimit).toBeUndefined()
    expect(credits.rateLimitAbsence).toBe('no-subscription')
    expect(credits.rateLimitError).toBeUndefined()
    // The balance is untouched by any of it.
    expect(credits.snapshot?.summary.total).toBe(100)
  })

  it('keeps the balance readable when the quota cannot be read at all', async () => {
    const credits = new MinimaxCredits()
    await credits.refresh(CREDENTIAL, 'cn', routingFetch({
      'get_membership_info': () => membership('100'),
      [TOKEN_PLAN_CREDIT_PATH]: () => new Response('nope', { status: 403 }),
    }), 1000)

    expect(credits.snapshot?.summary.total).toBe(100)
    expect(credits.error).toBeUndefined()
    expect(credits.rateLimitError).toContain('403')
  })

  it('still reads the older path directly', async () => {
    // The older reader is kept as a fallback, so it has to keep working.
    const fetchImpl = routingFetch({
      [REMAINS_PERCENT_PATH]: () => new Response(JSON.stringify(windowsDocument()), { status: 200 }),
    })
    const windows = await fetchRateLimitWindows(CREDENTIAL, 'cn', fetchImpl)
    expect(windows?.interval.usedPercent).toBe(19)
  })
})
