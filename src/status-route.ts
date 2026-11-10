/**
 * The plugin's own status endpoint, consumed by its settings card.
 *
 * Everything here is read-only and secret-free: it reports whether a credential
 * was found, how long it has left, where the model list came from, and which
 * models are on offer. It never echoes the token, and it never performs a
 * login or a refresh.
 *
 * @module dsh-connect-minimaxcode/status-route
 */

import { daysRemaining, expiryLevel, MINIMAX_REGIONS } from './auth.ts'

/** Route this plugin mounts, matching its settings card. */
export const MINIMAX_STATUS_PATH = '/plugins/dsh-connect-minimaxcode/status'

/** Route the card posts to when it wants something done rather than read. */
export const MINIMAX_ACTION_PATH = '/plugins/dsh-connect-minimaxcode/action'

/** The daily check-in, as the card reads it. */
export interface SigninStatus {
  /** Whether the cycle could be read. */
  state: 'ok' | 'unavailable'
  /** Today's day in the cycle. */
  today?: {
    /** Which day of the cycle it is, 1 to 7. */
    dayNo: number
    /** Points the day grants. */
    points: number
    /** The day's status, as the upstream numbers it. */
    status: number
    /** Whether the day can be claimed. */
    claimable: boolean
    /** Whether the day is already claimed. */
    claimed: boolean
  }
  /** The days of the cycle. */
  days?: { dayNo: number; points: number; status: number; isToday: boolean }[]
  /** Points the whole cycle is worth. */
  cyclePoints?: number
  /** Whether the plugin claims the day's grant on its own. */
  autoCheckin: boolean
  /** The day the last claim happened. */
  lastClaimDay?: string
  /** When the last claim happened, in milliseconds since the epoch. */
  lastClaimAtMs?: number
  /** Points the last claim granted. */
  lastClaimPoints?: number
  /** Whether the last claim was credited, or the day was already claimed. */
  lastClaimResult?: number
  /** Why the cycle or the claim could not be read. */
  error?: string
}

/** How the plugin is signed in, as the card reads it. */
export interface LoginStatus {
  /** Whether the plugin has a usable credential. */
  state: 'signed-in' | 'signed-out' | 'pending'
  /** Where the credential came from. */
  source?: 'plugin' | 'desktop-app'
  /** The code to type on the account page, while a sign-in is waiting. */
  userCode?: string
  /** Where to authorize. */
  verificationUri?: string
  /** Where to authorize, with the code filled in. */
  verificationUriComplete?: string
  /** When the device code stops working, in milliseconds since the epoch. */
  expiresAtMs?: number
}

/** The account's credit balance, as the desktop app shows it. */
export interface CreditStatus {
  /** Whether the balance could be read. */
  state: 'ok' | 'unavailable' | 'expired' | 'signed-out'
  /** Remaining credits, free plus purchased. */
  total?: number
  /** Remaining purchased credits. */
  purchased?: number
  /** Remaining free (granted) credits. */
  free?: number
  /** Credits consumed between the two last reads. */
  consumed?: number
  /** When the balance was read, in milliseconds since the epoch. */
  updatedAtMs?: number
  /** Why the balance could not be read. */
  error?: string
  /** Credits that expire within the next week. */
  expiring?: number
  /** How many grants that is. */
  expiringLots?: number
  /** Credits that expire within the next month. */
  expiringSoon?: number
  /** When the next grant with credits left expires. */
  nextExpiryAtMs?: number
  /** The next grants with credits left, soonest first. */
  upcoming?: { amount: number; expireAtMs: number }[]
  /** When the ledger was read, in milliseconds since the epoch. */
  ledgerAtMs?: number
  /** Why the ledger could not be read. */
  ledgerError?: string
}

/** What the plugin's own requests have used. */
export interface UsageStatus {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Equivalent amount of everything this host spent, in 元. */
  estimatedCny: number
  /** The equivalent amount of the last request, in 元. */
  lastCny?: number
  /** The model of the last request. */
  lastModel?: string
  /** How many requests were measured. */
  requests: number
}

/** The plan's two rolling usage windows, as the card reads them. */
export interface RateLimitStatus {
  /** Whether the windows could be read. */
  state: 'ok' | 'unavailable' | 'expired' | 'signed-out'
  /** The short window (five hours on the plans seen so far). */
  interval?: { usedPercent: number; startAtMs: number; resetAtMs: number }
  /** The weekly window. */
  weekly?: { usedPercent: number; startAtMs: number; resetAtMs: number }
  /** When the windows were read, in milliseconds since the epoch. */
  updatedAtMs?: number
  /** Why the plan has no windows, when the upstream said so plainly. */
  reason?: 'no-subscription'
  /** Why the windows could not be read. */
  error?: string
}

/**
 * The account's usage profile, as the upstream summarizes it.
 *
 * This is the account's own history — how long it has been used, how much it
 * has consumed, how it ranks — and it is a different thing from the usage
 * this host has made, which the card reports separately.
 */
export interface UsageProfileStatus {
  /** Whether the profile could be read. */
  state: 'ok' | 'unavailable'
  /** Days the summary window covers. */
  totalDays?: number
  /** Days in the window that saw any usage. */
  activeDays?: number
  /** Consecutive days of use up to today. */
  consecutiveDays?: number
  /** Tokens consumed in the window, in the upstream's own wording. */
  totalTokenConsumed?: string
  /** Where the account sits among other users, in percent. */
  rankingPercent?: number
  /** The busiest day in the window. */
  mostActiveDay?: { date?: string; tokenCount?: string }
  /** When the upstream last refreshed the summary. */
  updatedAt?: string
  /** Why the profile could not be read. */
  error?: string
}

/** What the card renders. */
export interface StatusDocument {
  state: 'signed-in' | 'signed-out' | 'expired'
  /** Human-readable next step, present when not signed in. */
  hint?: string
  /** Whole days until expiry; absent when unknown. */
  daysRemaining?: number
  /** Traffic-light state for the expiry warning. */
  expiry?: 'healthy' | 'expiring' | 'expired'
  region?: string
  /** Provenance of the model list. */
  catalogSource?: 'live' | 'fallback'
  catalogError?: string
  models?: { id: string; name: string; contextWindow: number }[]
  /** Whether a catalog refresh is in flight. */
  refreshing?: boolean
  /** The account's credit balance, when it could be read. */
  credits?: CreditStatus
  /** The plan's rolling usage windows, when they could be read. */
  rateLimit?: RateLimitStatus
  /** What this host's requests have used. */
  usage?: UsageStatus
  /** The daily check-in, when it could be read. */
  signin?: SigninStatus
  /** How the plugin is signed in. */
  login?: LoginStatus
  /** The account's usage profile, when it could be read. */
  usageProfile?: UsageProfileStatus
}

/** Inputs the document is derived from. */
export interface StatusDeps {
  auth: {
    state: 'signed-in' | 'signed-out' | 'expired'
    daysRemaining?: number
    expiry?: 'healthy' | 'expiring' | 'expired'
    reason?: string
  }
  region: string
  catalogSource: 'live' | 'fallback'
  catalogError?: string
  models: { id: string; name: string; contextWindow: number }[]
  refreshing: boolean
  /** The account's credit balance, when the account API could be reached. */
  credits?: CreditStatus
  /** The plan's rolling usage windows, when the open platform could be reached. */
  rateLimit?: RateLimitStatus
  /** What this host's requests have used. */
  usage?: UsageStatus
  /** The daily check-in, when the account API could be reached. */
  signin?: SigninStatus
  /** How the plugin is signed in. */
  login?: LoginStatus
  /** The account's usage profile, when the account API could be reached. */
  usageProfile?: UsageProfileStatus
}

const HINTS: Record<string, string> = {
  'app-missing': '未找到 MiniMax Code 的登录信息。请先安装并登录 MiniMax Code 桌面 App，然后重启 DSH。',
  'not-signed-in': 'MiniMax Code 尚未登录。请在 MiniMax Code 桌面 App 中登录后重启 DSH。',
  unreadable: '登录信息文件无法读取。请确认 MiniMax Code 仍处于登录状态。',
  malformed: '登录令牌格式无法解析。请在 MiniMax Code 中重新登录后重启 DSH。',
  'credential-revoked': '登录凭据已被服务器撤销，模型请求无法通过。请点击下方登录按钮重新登录 MiniMax Code。',
  'credential-expired': '登录凭据已过期。请点击下方登录按钮重新登录 MiniMax Code。',
}

/**
 * Build the card's status document.
 *
 * The three non-signed-in states carry different remedies, and the difference
 * is the whole point of the card: a user who has never installed the app needs
 * a different next step than one whose token simply aged out.
 */
export function statusDocument(deps: StatusDeps): StatusDocument {
  const { auth } = deps
  const base: StatusDocument = {
    state: auth.state,
    region: deps.region,
    catalogSource: deps.catalogSource,
    ...deps.catalogError === undefined ? {} : { catalogError: deps.catalogError },
    models: deps.models,
    refreshing: deps.refreshing,
    ...deps.credits === undefined ? {} : { credits: deps.credits },
    ...deps.rateLimit === undefined ? {} : { rateLimit: deps.rateLimit },
    ...deps.usage === undefined ? {} : { usage: deps.usage },
    ...deps.signin === undefined ? {} : { signin: deps.signin },
    ...deps.login === undefined ? {} : { login: deps.login },
    ...deps.usageProfile === undefined ? {} : { usageProfile: deps.usageProfile },
  }
  if (auth.state === 'expired') {
    return {
      ...base,
      expiry: 'expired',
      daysRemaining: 0,
      // A plugin credential is renewed from the card itself, so its remedy
      // differs from the desktop app's; a bare expiry keeps the app's advice.
      hint: HINTS[auth.reason ?? ''] ?? '登录令牌已过期。请打开并登录 MiniMax Code 桌面 App 以获取新令牌，然后重启 DSH。',
    }
  }
  if (auth.state === 'signed-out') {
    return { ...base, hint: HINTS[auth.reason ?? 'not-signed-in'] ?? HINTS['not-signed-in'] }
  }
  return { ...base, expiry: auth.expiry, daysRemaining: auth.daysRemaining }
}

/** Only loopback callers may read the document. */
export function isLoopback(host: string | undefined): boolean {
  if (host === undefined) return false
  const name = host.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** A redacted view of the credential, for the status document's tests. */
export function describeExpiry(exp: number, now = Date.now()): StatusDocument['expiry'] {
  const remaining = exp * 1000 - now
  if (remaining <= 0) return 'expired'
  return daysRemaining({ exp }) <= 1 && remaining <= 24 * 60 * 60 * 1000 ? 'expiring' : expiryLevel({ exp }, now)
}

export { MINIMAX_REGIONS }