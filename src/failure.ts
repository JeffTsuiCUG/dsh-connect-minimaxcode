/**
 * What a failure is, and what it costs.
 *
 * A refusal from the upstream arrives in several shapes: an HTTP status, a
 * business code, a sentence, sometimes all three. The reader needs three
 * things out of it and none of them is the code: what kind of failure it is
 * (so the remedy can be said), whether the upstream had already accepted the
 * work (so a retry is not made to spend twice), and the upstream's own words
 * (so a report carries the evidence).
 *
 * The classification reads the failure's *shape* — the HTTP status and the
 * wording — and never names another system's identifiers. A code that some
 * other component owns may be renamed or withdrawn; the fact it stands for
 * does not go with it, so a classifier that keyed on that code would one day
 * quietly stop matching. A classifier that keyed on the *kind* of failure
 * keeps working across renames, and only has to be extended when a genuinely
 * new kind appears.
 *
 * Two shapes are deliberately kept apart, because the difference decides
 * whether a retry is sensible:
 *
 *  - a failure that cost nothing (a bad parameter, a refused credential, a
 *    request this process refused to send) is fixed by changing something
 *    and trying again, so it carries no wait;
 *  - a failure that happened *after* the upstream accepted the work may
 *    already have been charged for, so the caller is told to hold off.
 */

/** The kinds of failure this plugin distinguishes. */
export type FailureKind =
  /** The credential was refused; signing in again is the remedy. */
  | 'credentials'
  /** The request itself was wrong; changing it is the remedy. */
  | 'parameters'
  /** The account holds no plan; only a subscription is the remedy. */
  | 'subscription'
  /** The allowance is spent; waiting is the remedy. */
  | 'quota'
  /** The upstream is throttling; waiting is the remedy. */
  | 'rate-limited'
  /** The upstream refused in a way this plugin does not recognise. */
  | 'upstream'
  /** The request never left this process, so nothing was spent. */
  | 'local'

/** The upstream's own words about a failure, kept verbatim. */
export interface UpstreamRefusal {
  /** The HTTP status the answer arrived with. */
  status: number
  /** The business code, when the body carried one. */
  code?: number
  /** The upstream's message, unchanged. */
  message: string
}

/** Everything a caller needs to know about a failure. */
export interface FailureVerdict {
  /** What kind of failure this is. */
  kind: FailureKind
  /**
   * Whether the upstream had already accepted the work.
   *
   * True means the work may have been charged for, so a retry is a new
   * charge rather than a repeat of the same one.
   */
  charged: boolean
  /** The upstream's own words, when there were any. */
  upstream?: UpstreamRefusal
}

/**
 * Match a shape of the upstream's message.
 *
 * The patterns name *facts* rather than identifiers: "no active subscription"
 * is a fact about the account, "2062" is a number another system chose.
 */
const SHAPES: { kind: FailureKind; pattern: RegExp }[] = [
  // The account holds no plan, or its plan does not reach this model.
  // Checked before the parameter shapes because this one is reported as a
  // bad request or a payment problem too, and it needs a different remedy:
  // no amount of changing the parameters helps.
  //
  // The Chinese half was measured on **2026-11-25**: asking for the video
  // model `MiniMax-H3` on a `Go` plan answers HTTP 402 with
  // `当前 Token Plan 套餐等级不支持该模型，请升级套餐后使用。 (2068)`. The
  // endpoint calls that body `insufficient_balance_error`, so a rule keyed on
  // "insufficient" would call a plan limit a spent allowance and send the
  // reader looking for credit they already have.
  { kind: 'subscription', pattern: /no active (token plan|subscription)|not subscribed|no subscription|套餐等级不支持|套餐不支持|升级套餐/i },
  // The credential was refused. The wording the upstream uses for it varies,
  // but every variant says the same thing: this key is not accepted.
  { kind: 'credentials', pattern: /login fail|log ?in fail|unauthorized|invalid api[ _-]?key|api secret key|invalid credential|authentication (failed|error)/i },
  // The allowance is spent.
  { kind: 'quota', pattern: /insufficient|quota (exceed|exhaust)|balance (is )?(not enough|insufficient)|not enough (credit|balance)|credit (exceed|exhaust)|超出|余额不足/i },
  // The upstream is throttling.
  { kind: 'rate-limited', pattern: /rate ?limit|too many requests|请求过于频繁|频率限制/i },
  // The request was wrong.
  { kind: 'parameters', pattern: /invalid (parameter|argument|request|value)|parameter .* (invalid|must be|not allowed)|unsupported (parameter|value|model)|must be (a |an )?(string|number|array|object|boolean)|参数(错误|无效)|不合法/i },
]

/**
 * Classify a failure by what the upstream said and how it said it.
 *
 * @param message - The upstream's message, or a description of what went
 *   wrong locally.
 * @param status - The HTTP status the answer arrived with, when there was one.
 * @returns The kind of failure. A failure this plugin does not recognise is
 *   `upstream` rather than a guess: the remedy for an unknown failure is to
 *   show the upstream's words, not to pretend to know better.
 */
export function classifyFailure(message: string, status?: number): FailureKind {
  // The status is the stronger fact when it names a class outright: a
  // refused credential and a throttled request are told apart by it even
  // when the wording is unhelpful.
  if (status === 401 || status === 403) return 'credentials'
  if (status === 429) return 'rate-limited'

  for (const shape of SHAPES) {
    if (shape.pattern.test(message)) return shape.kind
  }

  // HTTP 402 is "payment required", which covers both a spent allowance and
  // a plan that does not reach this model. The wording is what tells them
  // apart, and it was read first above; only a 402 whose words matched
  // nothing is attributed to the plan, because that is what the generation
  // endpoint actually used it for — measured **2026-11-25** on a `Go` account
  // asking for `MiniMax-H3`.
  if (status === 402) return 'subscription'
  // A bad request with no more specific wording is a bad request.
  if (status === 400 || status === 422) return 'parameters'
  return 'upstream'
}

/**
 * How long to hold off before trying the same thing again.
 *
 * A failure that spent nothing has nothing to cool down: the caller fixed
 * something and may try again at once. A failure that happened after the
 * upstream accepted the work may already have been charged for, so a retry
 * right away is another charge — that one waits.
 *
 * @returns The wait in milliseconds, or zero when no wait is warranted.
 */
export function cooldownFor(failure: FailureVerdict): number {
  return failure.charged ? COOLDOWN_MS : 0
}

/** The wait after a failure that may already have been charged for. */
export const COOLDOWN_MS = 30_000

/**
 * The sentence that says what to do next.
 *
 * It names the remedy rather than the code, because the code is the
 * upstream's business and the remedy is the reader's.
 */
export function remedyFor(kind: FailureKind): string {
  switch (kind) {
    case 'credentials':
      return '登录凭据被拒绝。请在插件页重新登录 MiniMax Code。'
    case 'parameters':
      return '请求的参数被上游拒绝。请调整提示词或选项后重试。'
    case 'subscription':
      return '账户没有可用的订阅套餐，因此调用被拒绝。请确认 M Plan 订阅是否生效。'
    case 'quota':
      return '账户的额度已用尽。请等待额度恢复，或检查套餐的限额窗口。'
    case 'rate-limited':
      return '上游正在限流。请稍后重试。'
    case 'local':
      return '请求没有发出，因此没有产生任何消耗。'
    case 'upstream':
      return '上游拒绝了这次请求。请把下面的原文一并反馈，以便定位。'
  }
}

/** The same sentences in English. */
export function remedyForEnglish(kind: FailureKind): string {
  switch (kind) {
    case 'credentials':
      return 'The credential was refused. Sign in to MiniMax Code again on the plugin page.'
    case 'parameters':
      return 'The upstream rejected the request parameters. Adjust the prompt or the options and try again.'
    case 'subscription':
      return 'The account holds no plan, so the call was refused. Check whether the M Plan subscription is active.'
    case 'quota':
      return 'The allowance is spent. Wait for it to recover, or check the plan\'s limit windows.'
    case 'rate-limited':
      return 'The upstream is throttling. Try again a little later.'
    case 'local':
      return 'The request never left the plugin, so nothing was spent.'
    case 'upstream':
      return 'The upstream refused the request. Please report the original words below so it can be traced.'
  }
}
