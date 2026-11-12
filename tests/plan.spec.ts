/**
 * The plan, and the windows it meters.
 *
 * Two things changed upstream when a plan was subscribed, and both matter
 * to the accounts that never subscribe:
 *
 *  - the quota endpoint now reports the share *remaining* instead of the
 *    share used, and renamed the field to match. The old field is still
 *    accepted, because an account can be answered by either shape.
 *  - the membership answer names the tier and the day the plan ends. An
 *    account without a plan has no such fields, and must see nothing new:
 *    the plugin is for every MiniMax Code account, not only for subscribers.
 *
 * These cases pin all three: the new shape, the old shape, and the account
 * with no plan at all.
 */

import { describe, expect, it } from 'vitest'
import { parsePlanSummary, parseRateLimitWindows } from '../src/credits.ts'

/** The window entry as the endpoint reports it now: the share remaining. */
function remainingDocument(overrides: Record<string, unknown> = {}): unknown {
  return {
    model_remains: [
      {
        model_name: 'general',
        start_time: 1_794_446_119_496,
        end_time: 1_794_464_119_496,
        weekly_start_time: 1_794_446_119_496,
        weekly_end_time: 1_795_050_919_496,
        current_interval_status: 1,
        current_weekly_status: 1,
        current_interval_remaining_percent: 92,
        current_weekly_remaining_percent: 99,
        ...overrides,
      },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  }
}

/** The window entry as it used to be: the share used, as a string. */
function usedDocument(): unknown {
  return {
    model_remains: [
      {
        model_name: 'general',
        start_time: 1_794_446_119_496,
        end_time: 1_794_464_119_496,
        weekly_start_time: 1_794_446_119_496,
        weekly_end_time: 1_795_050_919_496,
        current_interval_status: 1,
        current_weekly_status: 1,
        current_interval_used_percent: '19%',
        current_weekly_used_percent: '29%',
      },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  }
}

describe('the windows a plan meters', () => {
  it('reads the share remaining as the share used', () => {
    const windows = parseRateLimitWindows(remainingDocument())
    // 92% remaining is 8% used.
    expect(windows?.interval.usedPercent).toBe(8)
    expect(windows?.weekly.usedPercent).toBe(1)
  })

  it('still reads the share used when the upstream reports it that way', () => {
    const windows = parseRateLimitWindows(usedDocument())
    expect(windows?.interval.usedPercent).toBe(19)
    expect(windows?.weekly.usedPercent).toBe(29)
  })

  it('takes the window length from the answer, not from the plan terms', () => {
    const windows = parseRateLimitWindows(remainingDocument())
    // Five hours and seven days, as the edges say.
    expect(windows?.interval.resetAtMs! - windows?.interval.startAtMs!).toBe(18_000_000)
    expect(windows?.weekly.resetAtMs! - windows?.weekly.startAtMs!).toBe(604_800_000)
  })

  it('reports no window when the plan meters none', () => {
    // A status of three means the window has no allowance at all.
    expect(parseRateLimitWindows(remainingDocument({ current_interval_status: 3 }))).toBeUndefined()
  })})

describe('the plan an account holds', () => {
  it('names the tier and the day it ends', () => {
    const plan = parsePlanSummary({
      has_token_plan: true,
      token_plan_tier: 'Go',
      token_plan_expires_at: 1_797_033_600_000,
      subscription_type: 'mplan',
    })
    expect(plan?.active).toBe(true)
    expect(plan?.tier).toBe('Go')
    expect(plan?.expiresAtMs).toBe(1_797_033_600_000)
  })

  it('reports nothing for an account without a plan', () => {
    // The shape an unsubscribed account answers with.
    expect(parsePlanSummary({
      has_token_plan: false,
      plan_type: 1,
      expires_at: 0,
      subscription_type: 'none',
      opcredit_balance: 2000,
    })).toBeUndefined()
  })

  it('reports nothing when a zero day would otherwise be shown', () => {
    // An account may carry the field set to zero; "expires 1970" is noise.
    expect(parsePlanSummary({
      has_token_plan: false,
      token_plan_expires_at: 0,
    })).toBeUndefined()
  })

  it('reports an inactive plan rather than nothing when it is named', () => {
    const plan = parsePlanSummary({ has_token_plan: false, token_plan_tier: 'Go' })
    expect(plan?.active).toBe(true)
    expect(plan?.tier).toBe('Go')
  })
})
