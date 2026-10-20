/**
 * The daily check-in that grants the free credits.
 *
 * MiniMax Code hands out a grant of points every day, and the desktop app
 * shows it as a "每日签到" card: a seven-day cycle worth 4000 points, each
 * grant valid for thirty days. The app does **not** claim on its own — the
 * card opens, and a button does the work — so an account that is only used
 * through the model gateway leaves those points unclaimed.
 *
 * The endpoints are the same ones the card calls:
 *
 * - `GET /minimax-cloud/api/v1/signin/status` — the cycle, with today's day
 *   marked
 * - `POST /minimax-cloud/api/v1/signin/claim` — claim today
 *
 * Both need the account's `mmoat_` bearer token, and both need a **time zone
 ***: the server answers `invalid timezone_id` when the request carries an
 * offset or nothing at all, and it is that time zone that decides which day
 * "today" is. The client sends an IANA name (`Asia/Shanghai`), so this does
 * too.
 *
 * The claim is the one request here that changes something upstream. It is
 * idempotent per day — claiming again answers "already claimed" and grants
 * nothing — but the caller still guards it, because "cannot double-grant" is
 * a property of the upstream that is verified rather than assumed.
 *
 * @module dsh-connect-minimaxcode/signin
 */

import { MINIMAX_ACCOUNT_HOSTS, type OAuthCredential } from './credits.ts'
import type { MinimaxRegion } from './auth.ts'

/** The claim endpoint. */
export const SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'

/** The cycle endpoint, which reports the panel. */
export const SIGNIN_PANEL_PATH = '/minimax-cloud/api/v1/signin/status'

/** Per-day status, as the desktop app enumerates it. */
export const SIGNIN_DAY_STATUS = {
  /** The day has not come yet. */
  upcoming: 1,
  /** The day is today and can be claimed. */
  claimable: 2,
  /** The day is claimed. */
  claimed: 3,
  /** The day does not grant anything. */
  disabled: 4,
} as const

/** The status of one day in the cycle. */
export type SigninDayStatus = (typeof SIGNIN_DAY_STATUS)[keyof typeof SIGNIN_DAY_STATUS]

/** How many days a cycle runs. */
export const SIGNIN_CYCLE_DAYS = 7

/** The outcome of a claim. */
export const SIGNIN_CLAIM_RESULT = {
  /** The grant was credited. */
  credited: 1,
  /** Today was already claimed; nothing was granted. */
  alreadyClaimed: 2,
} as const

/** The outcome of a claim. */
export type SigninClaimResult = (typeof SIGNIN_CLAIM_RESULT)[keyof typeof SIGNIN_CLAIM_RESULT]

/** One day of the cycle. */
export interface SigninDay {
  /** Which day of the cycle this is, 1 to 7. */
  dayNo: number
  /** Points the day grants. */
  points: number
  /** Extra points on top, when the day carries a bonus. */
  bonusPoints: number
  /** The day's status. */
  status: SigninDayStatus
  /** Whether this is today. */
  isToday: boolean
}

/** The cycle as the server reports it. */
export interface SigninPanel {
  /** Which cycle the account is in. */
  scene: number
  /** The days of the cycle. */
  days: SigninDay[]
}

/** The result of claiming today's grant. */
export interface SigninClaim {
  /** The server's identifier for the claim. */
  claimId: string
  /** Whether the grant was credited or the day was already claimed. */
  result: SigninClaimResult
  /** Which day of the cycle was claimed. */
  dayNo: number
  /** Points granted. */
  points: number
  /** Extra points granted. */
  bonusPoints: number
  /** When the granted points expire, in milliseconds since the epoch. */
  expireAtMs: number
  /** The cycle after the claim. */
  panel?: SigninPanel
}

/**
 * The time zone the server should treat the request as coming from.
 *
 * The server wants an IANA name; an offset or a missing value is refused.
 * The system's own name is the right answer, since "today" should be the
 * user's today.
 */
export function timezoneId(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Read a number the upstream may send as a string. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Unwrap the upstream's envelope.
 *
 * The account APIs answer `200` with a `base_resp` that carries the real
 * status, so the HTTP code alone says nothing.
 */
function unwrap(document: unknown): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof document !== 'object' || document === null) {
    return { ok: false, message: '签到接口返回了无法解析的响应' }
  }
  const record = document as Record<string, unknown>
  const base = record.base_resp
  if (typeof base === 'object' && base !== null) {
    const status = toNumber((base as Record<string, unknown>).status_code)
    if (status !== undefined && status !== 0) {
      const message = (base as Record<string, unknown>).status_msg
      return { ok: false, message: typeof message === 'string' ? message : `签到接口返回状态码 ${status}` }
    }
  }
  return { ok: true, data: record.data }
}

/**
 * Read the cycle out of a panel response.
 *
 * The server marks exactly one day as today and at most one day as claimable;
 * a panel that says otherwise is not something to act on, so it is refused
 * rather than half-believed.
 */
export function parseSigninPanel(document: unknown): SigninPanel | undefined {
  const unwrapped = unwrap(document)
  if (!unwrapped.ok) return undefined
  const data = unwrapped.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const scene = toNumber(record.scene)
  const rawDays = record.days
  if (scene === undefined || !Array.isArray(rawDays)) return undefined

  const days: SigninDay[] = []
  let claimable = 0
  let today = 0
  for (const entry of rawDays) {
    if (typeof entry !== 'object' || entry === null) continue
    const day = entry as Record<string, unknown>
    const dayNo = toNumber(day.day_no)
    const points = toNumber(day.points)
    const status = toNumber(day.status)
    if (dayNo === undefined || points === undefined || status === undefined) continue
    if (status < 1 || status > 4) continue
    const isToday = day.is_today === true
    if (status === SIGNIN_DAY_STATUS.claimable) claimable += 1
    if (isToday) today += 1
    days.push({
      dayNo,
      points,
      bonusPoints: toNumber(day.bonus_points) ?? 0,
      status: status as SigninDayStatus,
      isToday,
    })
  }
  if (days.length === 0) return undefined
  if (claimable > 1 || today > 1) return undefined
  return { scene, days }
}

/** Read the result of a claim. */
export function parseSigninClaim(document: unknown): SigninClaim | undefined {
  const unwrapped = unwrap(document)
  if (!unwrapped.ok) return undefined
  const data = unwrapped.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const claimId = record.claim_id
  const result = toNumber(record.claim_result)
  const dayNo = toNumber(record.day_no)
  const points = toNumber(record.points)
  const expireAtMs = toNumber(record.expire_at_ms)
  if (typeof claimId !== 'string' || claimId.length === 0) return undefined
  if (result !== SIGNIN_CLAIM_RESULT.credited && result !== SIGNIN_CLAIM_RESULT.alreadyClaimed) return undefined
  if (dayNo === undefined || dayNo < 1 || dayNo > SIGNIN_CYCLE_DAYS) return undefined
  if (points === undefined || points < 0) return undefined
  if (expireAtMs === undefined) return undefined
  return {
    claimId,
    result,
    dayNo,
    points,
    bonusPoints: toNumber(record.bonus_points) ?? 0,
    expireAtMs,
    panel: parseSigninPanel({ data: record.panel }),
  }
}

/**
 * Read the cycle.
 *
 * @returns The panel, or `undefined` when the account cannot read it.
 */
export async function fetchSigninPanel(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
  timezone: string = timezoneId(),
): Promise<SigninPanel | undefined> {
  const url = `${MINIMAX_ACCOUNT_HOSTS[region]}${SIGNIN_PANEL_PATH}?timezone_id=${encodeURIComponent(timezone)}`
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${credential.token}` } })
  if (!response.ok) {
    throw new Error(`签到状态请求失败: HTTP ${response.status}`)
  }
  return parseSigninPanel(await response.json())
}

/**
 * Claim today's grant.
 *
 * This is the only request in the plugin that changes something upstream. It
 * grants the day's points, which expire thirty days later.
 *
 * @returns What the server answered, or `undefined` when it refused.
 */
export async function claimSignin(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
  timezone: string = timezoneId(),
): Promise<SigninClaim | undefined> {
  const url = `${MINIMAX_ACCOUNT_HOSTS[region]}${SIGNIN_CLAIM_PATH}?timezone_id=${encodeURIComponent(timezone)}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!response.ok) {
    throw new Error(`签到请求失败: HTTP ${response.status}`)
  }
  return parseSigninClaim(await response.json())
}

/** The day's key in the account's own time zone, `YYYY-MM-DD`. */
export function localDay(now = Date.now(), timezone: string = timezoneId()): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    return formatter.format(new Date(now))
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}
