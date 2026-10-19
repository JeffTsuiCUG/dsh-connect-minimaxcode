/**
 * Reading the account's credits.
 *
 * The upstream answers with three numbers in one object, and the two flat
 * balance fields beside it are a legacy view that reads zero on an account
 * that has migrated to the credit pool. These tests pin which field is the
 * balance, and how a missing split is handled.
 */

import { describe, expect, it } from 'vitest'
import {
  MinimaxCredits,
  ensureOAuthCredential,
  expiresInMs,
  fetchCreditLots,
  needsRefresh,
  parseCreditLots,
  parseCreditSummary,
  parseOAuthDocument,
  readOAuthCredential,
  summarizeExpiry,
  type OAuthCredential,
} from '../src/credits.ts'

/** A document shaped like the app's credential file. */
function credentialDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    records: {
      'com.minimax.mcode.oauth.prod.cn key': {
        schemaVersion: 1,
        accessToken: 'mmoat_example',
        refreshToken: 'mmort_example',
        tokenType: 'Bearer',
        clientId: 'mcode-public',
        scopes: ['agent.default'],
        audience: 'agent-backend',
        expiresAtMs: 1_800_000_000_000,
        generation: 154,
        ...overrides,
      },
    },
  })
}

const CREDENTIAL: OAuthCredential = {
  token: 'mmoat_example',
  refreshToken: 'mmort_example',
  expiresAtMs: 1_800_000_000_000,
  clientId: 'mcode-public',
  scopes: ['agent.default'],
  audience: 'agent-backend',
  generation: 154,
}

describe('parseOAuthDocument', () => {
  it('reads the credential the account endpoints accept', () => {
    const state = parseOAuthDocument(credentialDocument(), 1_700_000_000_000)
    expect(state.state).toBe('signed-in')
    if (state.state !== 'signed-in') return
    expect(state.credential.token).toBe('mmoat_example')
    expect(state.credential.refreshToken).toBe('mmort_example')
    expect(state.credential.clientId).toBe('mcode-public')
    expect(state.credential.audience).toBe('agent-backend')
    expect(state.credential.generation).toBe(154)
  })

  it('reports an expired credential without losing the refresh token', () => {
    const state = parseOAuthDocument(credentialDocument(), 1_900_000_000_000)
    expect(state.state).toBe('expired')
    if (state.state !== 'expired') return
    expect(state.credential.refreshToken).toBe('mmort_example')
  })

  it('reports a missing sign-in rather than throwing', () => {
    expect(parseOAuthDocument(JSON.stringify({ schemaVersion: 1, records: {} })).state).toBe('signed-out')
    expect(parseOAuthDocument('not json').state).toBe('signed-out')
  })
})

describe('token lifetime', () => {
  it('counts the remaining lifetime', () => {
    expect(expiresInMs(CREDENTIAL, 1_800_000_000_000 - 5000)).toBe(5000)
  })

  it('wants a refresh shortly before expiry', () => {
    // Five minutes of life left is still plenty; one minute is not.
    expect(needsRefresh(CREDENTIAL, 1_800_000_000_000 - 5 * 60_000)).toBe(false)
    expect(needsRefresh(CREDENTIAL, 1_800_000_000_000 - 60_000)).toBe(true)
  })
})

describe('parseCreditSummary', () => {
  it('reads the credit summary the desktop app shows', () => {
    const summary = parseCreditSummary({
      op_credit_summary: {
        total_remaining_amount: '11459.454',
        purchased_remaining_amount: '0',
        free_remaining_amount: '11459.454',
      },
    })
    expect(summary).toEqual({ total: 11459.454, purchased: 0, free: 11459.454 })
  })

  it('treats a missing split as an all-free balance', () => {
    const summary = parseCreditSummary({ op_credit_summary: { total_remaining_amount: '12.5' } })
    expect(summary).toEqual({ total: 12.5, purchased: 0, free: 12.5 })
  })

  it('falls back to the flat balance only when there is no summary', () => {
    const summary = parseCreditSummary({ opcredit_balance: 7, total_remains_credit: 7 })
    expect(summary).toEqual({ total: 7, purchased: 0, free: 7 })
  })

  it('reports nothing when the account carries no balance', () => {
    expect(parseCreditSummary({ plan_type: 1 })).toBeUndefined()
    expect(parseCreditSummary(null)).toBeUndefined()
  })
})

describe('credit lots and expiry', () => {
  const DAY = 86_400_000
  const NOW = Date.parse('2026-10-19T12:00:00Z')

  /** A ledger shaped like the upstream's. */
  const ledger = {
    total_count: 3,
    details: [
      {
        granted_amount: '400.00',
        remaining_amount: '0.00',
        consumed_amount: '400.00',
        granted_at_ms: NOW - 29 * DAY,
        expire_at_ms: NOW - DAY,
        credit_type: 2,
      },
      {
        granted_amount: '1000.00',
        remaining_amount: '58.09',
        consumed_amount: '941.91',
        granted_at_ms: NOW - 20 * DAY,
        expire_at_ms: NOW + 9 * DAY,
        credit_type: 2,
      },
      {
        granted_amount: '2000.00',
        remaining_amount: '2000.00',
        consumed_amount: '0.00',
        granted_at_ms: NOW - 2 * DAY,
        expire_at_ms: NOW + 27 * DAY,
        credit_type: 2,
      },
    ],
  }

  it('reads the lots, soonest expiry first', () => {
    const lots = parseCreditLots(ledger)
    expect(lots).toHaveLength(3)
    expect(lots[0]?.remaining).toBe(0)
    expect(lots[1]?.remaining).toBe(58.09)
    expect(lots[1]?.expireAtMs).toBe(NOW + 9 * DAY)
    expect(lots[2]?.remaining).toBe(2000)
  })

  it('ignores a lot without an expiry date', () => {
    const lots = parseCreditLots({ details: [{ granted_amount: '10', remaining_amount: '10' }] })
    expect(lots).toEqual([])
  })

  it('counts only the credits that are actually at risk', () => {
    const summary = summarizeExpiry(parseCreditLots(ledger), NOW)
    // The lot that expired yesterday is used up, and the 27-day lot is not
    // within the week: only the 58.09 due in nine days counts as near.
    expect(summary.expiring).toBe(0)
    expect(summary.expiringLots).toBe(0)
    expect(summary.expiringSoon).toBe(2058.09)
    expect(summary.nextExpiryAtMs).toBe(NOW + 9 * DAY)
    expect(summary.totalRemaining).toBe(2058.09)
  })

  it('counts a lot that expires inside the week', () => {
    const soon = {
      details: [{
        granted_amount: '400.00',
        remaining_amount: '400.00',
        consumed_amount: '0.00',
        granted_at_ms: NOW - 25 * DAY,
        expire_at_ms: NOW + 3 * DAY,
        credit_type: 2,
      }],
    }
    const summary = summarizeExpiry(parseCreditLots(soon), NOW)
    expect(summary.expiring).toBe(400)
    expect(summary.expiringLots).toBe(1)
    expect(summary.upcoming[0]).toEqual({ amount: 400, expireAtMs: NOW + 3 * DAY })
  })

  it('pages the ledger with the parameter the upstream reads', async () => {
    const asked: string[] = []
    const fetchImpl = (async (url: string) => {
      asked.push(String(url))
      return {
        ok: true,
        json: async () => ({ total_count: 1, details: [{
          granted_amount: '10.00',
          remaining_amount: '10.00',
          consumed_amount: '0.00',
          granted_at_ms: NOW,
          expire_at_ms: NOW + DAY,
          credit_type: 2,
        }] }),
      }
    }) as unknown as typeof fetch
    await fetchCreditLots(CREDENTIAL, 'cn', fetchImpl)
    expect(asked).toHaveLength(1)
    // `page` is accepted and then ignored upstream, so asking for it would
    // return the same rows for every page.
    expect(asked[0]).toContain('page_number=1')
    expect(asked[0]).toContain('page_size=100')
    expect(asked[0]).not.toMatch(/[?&]page=/)
  })
})

describe('MinimaxCredits', () => {
  const membership = (total: string) => JSON.stringify({
    op_credit_summary: {
      total_remaining_amount: total,
      purchased_remaining_amount: '0',
      free_remaining_amount: total,
    },
  })

  it('reports the movement between two reads', async () => {
    const credits = new MinimaxCredits()
    const fetchImpl = (async () => new Response(membership('100')) as unknown as Response) as unknown as typeof fetch
    await credits.refresh(CREDENTIAL, 'cn', fetchImpl, 1000)
    expect(credits.snapshot?.summary.total).toBe(100)
    // The first read has nothing to compare against, so it claims no movement.
    expect(credits.snapshot?.consumed).toBe(0)

    const lower = (async () => new Response(membership('92.5')) as unknown as Response) as unknown as typeof fetch
    await credits.refresh(CREDENTIAL, 'cn', lower, 2000)
    expect(credits.snapshot?.summary.total).toBe(92.5)
    expect(credits.snapshot?.consumed).toBe(7.5)
  })

  it('keeps the last balance when a read fails', async () => {
    const credits = new MinimaxCredits()
    const ok = (async () => new Response(membership('100')) as unknown as Response) as unknown as typeof fetch
    await credits.refresh(CREDENTIAL, 'cn', ok, 1000)
    const broken = (async () => { throw new Error('HTTP 401') }) as unknown as typeof fetch
    await credits.refresh(CREDENTIAL, 'cn', broken, 2000)
    expect(credits.snapshot?.summary.total).toBe(100)
    expect(credits.error).toContain('401')
  })
})

describe('readOAuthCredential', () => {
  it('reports a missing app rather than throwing', async () => {
    const state = await readOAuthCredential('cn', { MINIMAX_DATA_DIR: 'D:/does-not-exist' })
    expect(state.state).toBe('signed-out')
  })

  it('leaves a signed-out account alone', async () => {
    const state = await ensureOAuthCredential('cn', { MINIMAX_DATA_DIR: 'D:/does-not-exist' })
    expect(state.state).toBe('signed-out')
  })
})
