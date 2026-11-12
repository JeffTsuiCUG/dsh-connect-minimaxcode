/**
 * Prove the free account sees exactly what it saw before.
 *
 * The plugin is for every MiniMax Code account, not only for subscribers, so
 * the plan work must not change what an account without one sees. This walks
 * the whole path an unsubscribed account takes — the membership answer it
 * gives, the quota answer it gives, and what the card renders — and pins it.
 */
import { describe, expect, it } from 'vitest'
import { parseCreditSummary, parsePlanSummary, parseRateLimitWindows } from '../src/credits.ts'

/** The membership answer an account without a plan gives. */
const FREE_MEMBERSHIP = {
  plan_type: 1,
  plan_name: '',
  next_plan_name: '',
  will_renewal: false,
  expires_at: 0,
  total_remains_credit: 2000,
  pending_credit: 0,
  purchase_source: 0,
  can_upgrade: false,
  is_pro_builder: false,
  daily_login_gift_credit_remaining: 0,
  is_migrated_to_op: true,
  op_group_id: '2086044123063652945',
  has_token_plan: false,
  opcredit_balance: 2000,
  upgrade_action: 'Month',
  op_credit_summary: {
    total_remaining_amount: '5640.755',
    purchased_remaining_amount: '1522.01',
    free_remaining_amount: '4118.745',
  },
  base_resp: { status_code: 0, status_msg: 'success' },
  subscription_type: 'none',
}

/** The quota answer an account without a plan gives. */
const FREE_QUOTA = {
  model_remains: null,
  base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' },
}

describe('an account without a plan', () => {
  it('reads its balance exactly as before', () => {
    const summary = parseCreditSummary(FREE_MEMBERSHIP)
    expect(summary?.total).toBeCloseTo(5640.755, 3)
    expect(summary?.purchased).toBeCloseTo(1522.01, 2)
    expect(summary?.free).toBeCloseTo(4118.745, 3)
  })

  it('reports no plan, so the card says nothing about one', () => {
    expect(parsePlanSummary(FREE_MEMBERSHIP)).toBeUndefined()
  })

  it('reads no windows, so the card explains that it has none', () => {
    expect(parseRateLimitWindows(FREE_QUOTA)).toBeUndefined()
  })
})

describe('an account with a plan', () => {
  const PLAN_MEMBERSHIP = {
    ...FREE_MEMBERSHIP,
    plan_type: 3,
    expires_at: 1_797_033_600_000,
    has_token_plan: true,
    token_plan_tier: 'Go',
    token_plan_expires_at: 1_797_033_600_000,
    subscription_type: 'mplan',
  }

  it('reads its balance the same way', () => {
    const summary = parseCreditSummary(PLAN_MEMBERSHIP)
    expect(summary?.total).toBeCloseTo(5640.755, 3)
  })

  it('names the tier and the day it ends', () => {
    const plan = parsePlanSummary(PLAN_MEMBERSHIP)
    expect(plan?.active).toBe(true)
    expect(plan?.tier).toBe('Go')
    expect(plan?.expiresAtMs).toBe(1_797_033_600_000)
  })

  it('reads the windows the plan meters', () => {
    const windows = parseRateLimitWindows({
      model_remains: [{
        model_name: 'general',
        start_time: 1_794_446_119_496,
        end_time: 1_794_464_119_496,
        weekly_start_time: 1_794_446_119_496,
        weekly_end_time: 1_795_050_919_496,
        current_interval_status: 1,
        current_weekly_status: 1,
        current_interval_remaining_percent: 90,
        current_weekly_remaining_percent: 99,
      }],
    })
    expect(windows?.interval.usedPercent).toBe(10)
    expect(windows?.weekly.usedPercent).toBe(1)
  })
})
