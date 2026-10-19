/**
 * What a conversation actually cost.
 *
 * Every response from the gateway carries its own usage counters, so the
 * consumption of a session can be measured exactly rather than estimated from
 * the transcript. The upstream sends four numbers, and the distinction
 * between them matters: `input_tokens` counts only the tokens that missed the
 * prompt cache, so a naive sum understates a long conversation badly.
 *
 * The conversion to money uses MiniMax's published domestic price list
 * (元/百万 tokens). It is an equivalent amount, not a charge: the credits the
 * desktop app shows are a separate resource, and MiniMax publishes no
 * numeric exchange rate between the two.
 *
 * @module dsh-connect-minimaxcode/usage
 */

/** Token counts of one request, as the gateway reported them. */
export interface ModelUsage {
  /** Tokens sent that missed the prompt cache. */
  inputTokens: number
  /** Tokens produced. */
  outputTokens: number
  /** Tokens served from the prompt cache. */
  cacheReadTokens: number
  /** Tokens written into the prompt cache. */
  cacheWriteTokens: number
  /** Tokens spent reasoning, when the model reports them separately. */
  reasoningTokens: number
}

/** An empty usage record. */
export const EMPTY_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

/** Prices in 元 per million tokens, from MiniMax's domestic price list. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
}

/** The published domestic prices of the models this plugin serves. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'MiniMax-M3.1-Flash': { input: 1.0, output: 4.0, cacheRead: 0.1 },
  'MiniMax-M3': { input: 2.1, output: 8.4, cacheRead: 0.42 },
}

/** The tier boundary above which M3 costs twice as much. */
export const M3_LARGE_TIER_TOKENS = 512_000

/**
 * The price for one model at one input size.
 *
 * M3 is billed in two tiers: requests above 512k input tokens cost double.
 * The tier is decided by the billed input, which is the uncached input plus
 * the cache read.
 */
export function priceFor(model: string, billedInputTokens: number): ModelPrice | undefined {
  const price = MODEL_PRICES[model]
  if (price === undefined) return undefined
  if (model === 'MiniMax-M3' && billedInputTokens > M3_LARGE_TIER_TOKENS) {
    return { input: price.input * 2, output: price.output * 2, cacheRead: price.cacheRead * 2 }
  }
  return price
}

/**
 * The equivalent amount of one request, in 元.
 *
 * Returns `undefined` for a model without a published price, rather than
 * pretending the request was free.
 */
export function estimateCny(model: string, usage: ModelUsage): number | undefined {
  const billedInput = usage.inputTokens + usage.cacheReadTokens
  const price = priceFor(model, billedInput)
  if (price === undefined) return undefined
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate
  return (
    perMillion(usage.inputTokens, price.input)
    + perMillion(usage.outputTokens, price.output)
    + perMillion(usage.cacheReadTokens, price.cacheRead)
  )
}

/** One recorded request. */
export interface UsageRecord {
  model: string
  usage: ModelUsage
  /** Equivalent amount in 元, when the model has a published price. */
  cny?: number
}

/**
 * Accumulates what the sessions routed through this plugin have used.
 *
 * The meter is the plugin's own view: it counts the requests this host made,
 * with the counters the gateway returned. It is not the account's total, and
 * it is not the credit balance — the balance comes from the account API.
 */
export class UsageMeter {
  #records: UsageRecord[] = []
  #byModel = new Map<string, ModelUsage>()

  /** Every recorded request, oldest first. */
  get records(): readonly UsageRecord[] {
    return this.#records
  }

  /** The most recent request. */
  get last(): UsageRecord | undefined {
    return this.#records[this.#records.length - 1]
  }

  /** Record one request's usage. */
  record(model: string, usage: ModelUsage): UsageRecord {
    const entry: UsageRecord = { model, usage: { ...usage }, cny: estimateCny(model, usage) }
    this.#records.push(entry)
    const totals = this.#byModel.get(model) ?? { ...EMPTY_USAGE }
    this.#byModel.set(model, {
      inputTokens: totals.inputTokens + usage.inputTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
      reasoningTokens: totals.reasoningTokens + usage.reasoningTokens,
    })
    return entry
  }

  /** Totals across every recorded request. */
  totals(): ModelUsage {
    let total = { ...EMPTY_USAGE }
    for (const usage of this.#byModel.values()) {
      total = {
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
        cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
        reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
      }
    }
    return total
  }

  /** Totals per model. */
  byModel(): ReadonlyMap<string, ModelUsage> {
    return this.#byModel
  }

  /** The equivalent amount of everything recorded, in 元. */
  estimatedCny(): number {
    let total = 0
    for (const record of this.#records) {
      if (record.cny !== undefined) total += record.cny
    }
    return total
  }

  /** Forget everything recorded. */
  reset(): void {
    this.#records = []
    this.#byModel.clear()
  }
}
