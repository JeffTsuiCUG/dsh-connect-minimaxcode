/**
 * What a conversation cost.
 *
 * The gateway reports four token counts, and the one that decides the bill is
 * easy to miss: `input_tokens` counts only the tokens that missed the prompt
 * cache, so a conversation that mostly reads cache would look almost free if
 * the cached tokens were left out.
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_USAGE, UsageMeter, estimateCny, priceFor } from '../src/usage.ts'

describe('estimateCny', () => {
  it('prices M3.1-Flash at the published domestic rate', () => {
    const cny = estimateCny('MiniMax-M3.1-Flash', {
      ...EMPTY_USAGE,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    })
    // 1.00 + 4.00 + 0.10 元 per million tokens
    expect(cny).toBeCloseTo(5.1, 6)
  })

  it('prices M3 in its small-input tier', () => {
    const cny = estimateCny('MiniMax-M3', { ...EMPTY_USAGE, inputTokens: 100_000, outputTokens: 1_000_000 })
    // 0.21 元 输入 + 8.40 元 输出
    expect(cny).toBeCloseTo(8.61, 6)
  })

  it('prices M3 in its large-input tier', () => {
    const cny = estimateCny('MiniMax-M3', { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 })
    // 超过 512k 输入后价格翻倍：4.20 元 输入 + 16.80 元 输出
    expect(cny).toBeCloseTo(21, 6)
  })

  it('doubles M3 above 512k input tokens', () => {
    const small = priceFor('MiniMax-M3', 512_000)
    const large = priceFor('MiniMax-M3', 512_001)
    expect(small?.input).toBe(2.1)
    expect(large?.input).toBe(4.2)
  })

  it('counts cached reads as input for the tier decision', () => {
    const cny = estimateCny('MiniMax-M3', { ...EMPTY_USAGE, cacheReadTokens: 600_000 })
    expect(cny).toBeCloseTo(0.84 * 0.6, 6)
  })

  it('declines to price a model it does not know', () => {
    expect(estimateCny('MiniMax-M9', { ...EMPTY_USAGE, inputTokens: 10 })).toBeUndefined()
  })
})

describe('UsageMeter', () => {
  it('adds up what the requests used', () => {
    const meter = new UsageMeter()
    meter.record('MiniMax-M3.1-Flash', { ...EMPTY_USAGE, inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 })
    meter.record('MiniMax-M3.1-Flash', { ...EMPTY_USAGE, inputTokens: 50, outputTokens: 10, cacheReadTokens: 100 })
    const totals = meter.totals()
    expect(totals.inputTokens).toBe(150)
    expect(totals.outputTokens).toBe(30)
    expect(totals.cacheReadTokens).toBe(1000)
    expect(meter.records).toHaveLength(2)
    expect(meter.last?.model).toBe('MiniMax-M3.1-Flash')
  })

  it('keeps the models apart', () => {
    const meter = new UsageMeter()
    meter.record('MiniMax-M3.1-Flash', { ...EMPTY_USAGE, inputTokens: 10 })
    meter.record('MiniMax-M3', { ...EMPTY_USAGE, inputTokens: 20 })
    expect(meter.byModel().get('MiniMax-M3')?.inputTokens).toBe(20)
    expect(meter.byModel().get('MiniMax-M3.1-Flash')?.inputTokens).toBe(10)
  })

  it('adds up the equivalent amount', () => {
    const meter = new UsageMeter()
    meter.record('MiniMax-M3.1-Flash', { ...EMPTY_USAGE, inputTokens: 1_000_000 })
    expect(meter.estimatedCny()).toBeCloseTo(1, 6)
  })

  it('forgets everything when reset', () => {
    const meter = new UsageMeter()
    meter.record('MiniMax-M3', { ...EMPTY_USAGE, inputTokens: 5 })
    meter.reset()
    expect(meter.records).toHaveLength(0)
    expect(meter.totals().inputTokens).toBe(0)
  })
})
