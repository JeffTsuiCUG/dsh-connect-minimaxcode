/**
 * Reading the MiniMax Code desktop app's own sign-in.
 *
 * The desktop app persists its bearer token as plaintext JSON under its data
 * directory. This module reads that file, decodes the JWT without verifying it
 * (the signature exists to stop *tampering*, and nobody tampers with a token we
 * only ever send back to the issuer), and reports expiry so the UI can warn
 * before the models go dark.
 *
 * Nothing here performs a login, a refresh, or any write. The token's lifetime
 * is owned by the desktop app: renewing it means signing in there again, which
 * is a deliberate step the user takes in the app, never one this plugin makes
 * on their behalf.
 *
 * @module dsh-connect-minimaxcode/auth
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** File the desktop app writes its runtime auth context into. */
export const MINIMAX_AUTH_FILENAME = 'local-runtime.auth.json'

/** Directory holding it, relative to the user's home. */
export const MINIMAX_DATA_DIR = '.minimax'

/** Region-specific gateways the desktop app ships with. */
export const MINIMAX_GATEWAYS = {
  cn: 'https://agent.minimax.cn',
  io: 'https://agent.minimax.io',
  com: 'https://agent.minimaxi.com',
} as const

/** A gateway this plugin knows how to talk to. */
export type MinimaxRegion = keyof typeof MINIMAX_GATEWAYS

/** Every region, for a fallback sweep when the configured one fails. */
export const MINIMAX_REGIONS: readonly MinimaxRegion[] = ['cn', 'io', 'com']

/** Base URL of the Anthropic-compatible endpoint on a region gateway. */
export function chatBaseUrl(region: MinimaxRegion): string {
  return `${MINIMAX_GATEWAYS[region]}/mavis/api/v1/llm/v1`
}

/** Base URL of the authoritative model catalog on a region gateway. */
export function catalogUrl(region: MinimaxRegion): string {
  return `${MINIMAX_GATEWAYS[region]}/mavis/api/v1/models`
}

/** Default data directory, honouring the app's own override variables. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINIMAX_DATA_DIR ?? env.MAVIS_DATA_DIR ?? join(homedir(), MINIMAX_DATA_DIR)
}

/** Absolute path of the auth file this plugin reads. */
export function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), MINIMAX_AUTH_FILENAME)
}

/** The JWT claims this plugin acts on. */
export interface TokenClaims {
  /** Expiry, seconds since the epoch. */
  exp: number
  /** Account id the issuer embedded, when present. */
  userId?: string
  /** Display name the issuer embedded, when present. */
  name?: string
}

/** A decoded, still-valid-at-read-time credential. */
export interface Credential {
  token: string
  claims: TokenClaims
  /** Milliseconds since the epoch, from the file's own `updatedAtMs`. */
  updatedAtMs?: number
}

/** Why a credential could not be used, in a form the UI can render. */
export type AuthFailure =
  | { state: 'signed-out'; reason: 'app-missing' | 'not-signed-in' | 'unreadable' | 'malformed' }
  | { state: 'expired'; expiresAtMs: number }

export type AuthState =
  | { state: 'signed-in'; credential: Credential }
  | AuthFailure

/**
 * Decode a JWT payload without verifying its signature.
 *
 * Only the expiry is trusted, and only to decide how loudly to warn: a token we
 * cannot parse is reported as malformed rather than silently accepted, and a
 * token that verifies as expired is reported as expired rather than sent. The
 * issuer remains the sole authority on both questions.
 */
export function decodeClaims(token: string): TokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof payload.exp !== 'number') return undefined
    const user = payload.user as Record<string, unknown> | undefined
    const claims: TokenClaims = { exp: payload.exp }
    if (typeof user?.id === 'string') claims.userId = user.id
    if (typeof user?.name === 'string') claims.name = user.name
    return claims
  } catch {
    return undefined
  }
}

/** Milliseconds until the token expires; negative once it has. */
export function expiresInMs(claims: TokenClaims, now = Date.now()): number {
  return claims.exp * 1000 - now
}

/** How a remaining lifetime should be presented to the user. */
export type ExpiryLevel = 'healthy' | 'expiring' | 'expired'

/** Warn inside the last day, and treat anything past it as already gone. */
const EXPIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000

/** Classify a token's remaining lifetime for display. */
export function expiryLevel(claims: TokenClaims, now = Date.now()): ExpiryLevel {
  const remaining = expiresInMs(claims, now)
  if (remaining <= 0) return 'expired'
  if (remaining <= EXPIRING_THRESHOLD_MS) return 'expiring'
  return 'healthy'
}

/** Whole days left, rounded up so 1 hour reads as "1 day", not "0 days". */
export function daysRemaining(claims: TokenClaims, now = Date.now()): number {
  const remaining = expiresInMs(claims, now)
  return remaining <= 0 ? 0 : Math.ceil(remaining / (24 * 60 * 60 * 1000))
}

/**
 * Read the desktop app's credential.
 *
 * Every failure mode is a state rather than an exception: a user who has not
 * installed or signed in yet is a normal condition the card renders, not an
 * error the host logs on every start.
 *
 * @param env - Environment used to locate the data directory.
 * @param now - Clock, injected so expiry is testable.
 * @returns The usable credential, or why there is none.
 */
export async function readCredential(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<AuthState> {
  let text: string
  try {
    text = await readFile(authPath(env), 'utf8')
  } catch {
    return { state: 'signed-out', reason: 'app-missing' }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { state: 'signed-out', reason: 'unreadable' }
  }
  const auth = parsed.auth as Record<string, unknown> | undefined
  const token = auth?.accessToken
  if (typeof token !== 'string' || token.length === 0) {
    return { state: 'signed-out', reason: 'not-signed-in' }
  }
  const claims = decodeClaims(token)
  if (claims === undefined) {
    return { state: 'signed-out', reason: 'malformed' }
  }
  if (expiresInMs(claims, now) <= 0) {
    return { state: 'expired', expiresAtMs: claims.exp * 1000 }
  }
  const updatedAtMs = typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : undefined
  return { state: 'signed-in', credential: { token, claims, updatedAtMs } }
}

/**
 * A token that satisfies no request, used where the seam demands an auth value
 * before a real one exists.
 *
 * The provider's auth resolver substitutes the live token at call time; this
 * placeholder only keeps construction total.
 */
export const INERT_AUTH = { auth: { apiKey: 'minimaxcode' } } as const