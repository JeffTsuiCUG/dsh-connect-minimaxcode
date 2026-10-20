/**
 * The daily check-in.
 *
 * The upstream answers `200` with a `base_resp` that carries the real status,
 * and the time zone decides which day "today" is — a request without an IANA
 * time zone is refused. These tests pin both, and the guards the desktop app
 * applies to a panel before it acts on it.
 */

import { describe, expect, it } from 'vitest'
import {
  SIGNIN_CLAIM_RESULT,
  SIGNIN_DAY_STATUS,
  claimSignin,
  fetchSigninPanel,
  localDay,
  parseSigninClaim,
  parseSigninPanel,
  timezoneId,
} from '../src/signin.ts'
import type { OAuthCredential } from '../src/credits.ts'

const CREDENTIAL: OAuthCredential = {
  token: 'mmoat_example',
  clientId: 'mcode-public',
  scopes: ['agent.default'],
  audience: 'agent-backend',
}

const day = (overrides: Record<string, unknown> = {}) => ({
  day_no: 1,
  points: 400,
  bonus_points: 0,
  status: 3,
  is_today: false,
  ...overrides,
})

const panel = (days: unknown[]) => ({
  data: { scene: 3, days },
  base_resp: { status_code: 0, status_msg: 'ok' },
})

describe('parseSigninPanel', () => {
  it('reads the cycle, with the days in order', () => {
    const parsed = parseSigninPanel(panel([
      day({ day_no: 1, points: 400 }),
      day({ day_no: 2, points: 1000, status: 2, is_today: true }),
    ]))
    expect(parsed?.scene).toBe(3)
    expect(parsed?.days).toHaveLength(2)
    expect(parsed?.days[1]).toEqual({
      dayNo: 2,
      points: 1000,
      bonusPoints: 0,
      status: SIGNIN_DAY_STATUS.claimable,
      isToday: true,
    })
  })

  it('refuses a panel that marks two days claimable', () => {
    const parsed = parseSigninPanel(panel([
      day({ day_no: 1, status: 2 }),
      day({ day_no: 2, status: 2 }),
    ]))
    expect(parsed).toBeUndefined()
  })

  it('refuses a panel that marks two days as today', () => {
    const parsed = parseSigninPanel(panel([
      day({ day_no: 1, is_today: true }),
      day({ day_no: 2, is_today: true }),
    ]))
    expect(parsed).toBeUndefined()
  })

  it('refuses a panel that is not one', () => {
    expect(parseSigninPanel({ data: { scene: 3 }, base_resp: { status_code: 0 } })).toBeUndefined()
    expect(parseSigninPanel({ data: { days: [] }, base_resp: { status_code: 0 } })).toBeUndefined()
  })

  it('reports the upstream refusal rather than a panel', () => {
    const parsed = parseSigninPanel({ base_resp: { status_code: 1406010011, status_msg: 'invalid timezone_id' } })
    expect(parsed).toBeUndefined()
  })
})

describe('parseSigninClaim', () => {
  const claim = (overrides: Record<string, unknown> = {}) => ({
    data: {
      claim_id: '2112320565451703124',
      claim_result: 1,
      day_no: 7,
      points: 1000,
      expire_at_ms: 1_795_017_600_000,
      ...overrides,
    },
    base_resp: { status_code: 0, status_msg: 'ok' },
  })

  it('reads a granted claim', () => {
    const parsed = parseSigninClaim(claim())
    expect(parsed?.result).toBe(SIGNIN_CLAIM_RESULT.credited)
    expect(parsed?.dayNo).toBe(7)
    expect(parsed?.points).toBe(1000)
    expect(parsed?.expireAtMs).toBe(1_795_017_600_000)
  })

  it('reads an already-claimed day as what it is', () => {
    const parsed = parseSigninClaim(claim({ claim_result: 2 }))
    expect(parsed?.result).toBe(SIGNIN_CLAIM_RESULT.alreadyClaimed)
  })

  it('refuses a day outside the cycle', () => {
    expect(parseSigninClaim(claim({ day_no: 8 }))).toBeUndefined()
    expect(parseSigninClaim(claim({ day_no: 0 }))).toBeUndefined()
  })

  it('refuses a claim without an expiry', () => {
    const document = claim()
    delete (document.data as Record<string, unknown>).expire_at_ms
    expect(parseSigninClaim(document)).toBeUndefined()
  })
})

describe('the check-in requests', () => {
  it('asks for the panel with the time zone in the query', async () => {
    const asked: string[] = []
    const fetchImpl = (async (url: string) => {
      asked.push(String(url))
      return { ok: true, json: async () => panel([day()]) } as unknown as Response
    }) as unknown as typeof fetch
    const result = await fetchSigninPanel(CREDENTIAL, 'cn', fetchImpl, 'Asia/Shanghai')
    expect(result?.days).toHaveLength(1)
    expect(asked[0]).toContain('/minimax-cloud/api/v1/signin/status')
    expect(asked[0]).toContain('timezone_id=Asia%2FShanghai')
  })

  it('claims with a post and an empty body', async () => {
    const asked: { url: string; method?: string; body?: unknown }[] = []
    const fetchImpl = (async (url: string, init?: { method?: string; body?: unknown }) => {
      asked.push({ url: String(url), method: init?.method, body: init?.body })
      return {
        ok: true,
        json: async () => ({
          data: { claim_id: 'x', claim_result: 2, day_no: 7, points: 1000, expire_at_ms: 1 },
          base_resp: { status_code: 0 },
        }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const result = await claimSignin(CREDENTIAL, 'cn', fetchImpl, 'Asia/Shanghai')
    expect(result?.result).toBe(SIGNIN_CLAIM_RESULT.alreadyClaimed)
    expect(asked[0]?.method).toBe('POST')
    expect(asked[0]?.body).toBe('{}')
    expect(asked[0]?.url).toContain('/minimax-cloud/api/v1/signin/claim')
  })
})

describe('the time zone', () => {
  it('is an IANA name, because the upstream refuses anything else', () => {
    const zone = timezoneId()
    expect(zone.length).toBeGreaterThan(0)
    expect(zone).not.toMatch(/^[+-]\d/)
  })

  it('names the day in that zone', () => {
    const instant = Date.parse('2026-10-20T16:30:00Z')
    expect(localDay(instant, 'Asia/Shanghai')).toBe('2026-10-21')
    expect(localDay(instant, 'UTC')).toBe('2026-10-20')
  })
})
