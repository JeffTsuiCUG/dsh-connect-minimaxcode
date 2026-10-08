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
}

const HINTS: Record<string, string> = {
  'app-missing': '未找到 MiniMax Code 的登录信息。请先安装并登录 MiniMax Code 桌面 App，然后重启 DSH。',
  'not-signed-in': 'MiniMax Code 尚未登录。请在 MiniMax Code 桌面 App 中登录后重启 DSH。',
  unreadable: '登录信息文件无法读取。请确认 MiniMax Code 仍处于登录状态。',
  malformed: '登录令牌格式无法解析。请在 MiniMax Code 中重新登录后重启 DSH。',
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
  }
  if (auth.state === 'expired') {
    return {
      ...base,
      expiry: 'expired',
      daysRemaining: 0,
      hint: '登录令牌已过期。请打开并登录 MiniMax Code 桌面 App 以获取新令牌，然后重启 DSH。',
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