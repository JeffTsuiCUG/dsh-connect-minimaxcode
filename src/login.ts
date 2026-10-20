/**
 * Signing in without the desktop app.
 *
 * The desktop app's only sign-in is the OAuth 2.0 device authorization grant
 * (RFC 8628). The plugin runs the same grant:
 *
 * 1. `POST /oauth2/device/code` asks for a device code. The answer carries a
 *    short `user_code` and the page where the person authorizes it.
 * 2. The person opens that page, signs in to their own MiniMax account, and
 *    approves the request.
 * 3. `POST /oauth2/token` is polled with the device code until the grant
 *    arrives.
 *
 * The plugin never sees a password and never sees a verification code: the
 * one human step happens in the person's own browser, on the account site.
 * PKCE is used, so a device code that leaks cannot be redeemed without the
 * verifier that never left this process.
 *
 * The token this produces is the same `mmoat_` token the desktop app holds.
 * The account endpoints need it, and the model gateway accepts it too — so
 * one sign-in is enough for models, credits and the daily grant.
 *
 * @module dsh-connect-minimaxcode/login
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  MINIMAX_AUTH_HOSTS,
  MINIMAX_OAUTH_AUDIENCE,
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_SCOPES,
} from './credits.ts'
import type { MinimaxRegion } from './auth.ts'
import type { DeviceLoginSession, PluginCredential } from './credentials.ts'

/** The endpoint that issues device codes. */
export const DEVICE_CODE_PATH = '/oauth2/device/code'

/** The endpoint that exchanges a device code for a token. */
export const TOKEN_PATH = '/oauth2/token'

/** The device authorization grant type. */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** How a device login is going. */
export type DeviceLoginState =
  /** The person has not authorized it yet. */
  | { state: 'pending' }
  /** The authorization server asked the client to slow down. */
  | { state: 'slow-down' }
  /** The device code expired before the person authorized it. */
  | { state: 'expired'; message?: string }
  /** The person declined. */
  | { state: 'denied'; message?: string }
  /** The grant arrived. */
  | { state: 'signed-in'; credential: PluginCredential }

/**
 * Make a PKCE verifier and its S256 challenge.
 *
 * The verifier is 43 characters of base64url entropy, which is what RFC 7636
 * asks for, and it never leaves this process.
 */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Ask for a device code.
 *
 * @returns The session the person authorizes, or `undefined` when the server
 *   would not issue one.
 */
export async function startDeviceLogin(
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<DeviceLoginSession | undefined> {
  const { verifier, challenge } = makePkce()
  const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${DEVICE_CODE_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MINIMAX_OAUTH_CLIENT_ID,
      scope: MINIMAX_OAUTH_SCOPES.join(' '),
      audience: MINIMAX_OAUTH_AUDIENCE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  })
  if (!response.ok) {
    throw new Error(`申请设备码失败: HTTP ${response.status}`)
  }
  const document = await response.json() as Record<string, unknown>
  const deviceCode = document.device_code
  const userCode = document.user_code
  const verificationUri = document.verification_uri
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    throw new Error('设备码响应里没有 device_code')
  }
  const expiresInSec = typeof document.expires_in === 'number' ? document.expires_in : 300
  const intervalSec = typeof document.interval === 'number' ? document.interval : 3
  return {
    deviceCode,
    codeVerifier: verifier,
    userCode: typeof userCode === 'string' ? userCode : '',
    verificationUri: typeof verificationUri === 'string' ? verificationUri : '',
    verificationUriComplete: typeof document.verification_uri_complete === 'string'
      ? document.verification_uri_complete
      : '',
    expiresAtMs: now + expiresInSec * 1000,
    // The interval is part of the server's answer, so it is carried along.
    ...({ intervalSec } as Record<string, unknown>),
  }
}

/** Read the token document the authorization server answers with. */
function readToken(document: unknown): { token: string; refreshToken?: string; expiresInSec?: number; scope?: string } | undefined {
  if (typeof document !== 'object' || document === null) return undefined
  const record = document as Record<string, unknown>
  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  return {
    token: accessToken,
    refreshToken: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
    expiresInSec: typeof record.expires_in === 'number' ? record.expires_in : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  }
}

/**
 * Poll for the grant.
 *
 * The authorization server answers `400` while the person has not authorized
 * yet, with `authorization_pending` in the body; that is a normal answer, not
 * an error.
 */
export async function pollDeviceLogin(
  session: DeviceLoginSession,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<DeviceLoginState> {
  if (session.expiresAtMs !== 0 && session.expiresAtMs <= now) {
    return { state: 'expired', message: '设备码已过期，请重新发起登录' }
  }
  const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MINIMAX_OAUTH_CLIENT_ID,
      grant_type: DEVICE_CODE_GRANT,
      device_code: session.deviceCode,
      code_verifier: session.codeVerifier,
    }),
  })
  const text = await response.text()
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    document = undefined
  }
  if (response.ok) {
    const token = readToken(document)
    if (token === undefined) {
      return { state: 'expired', message: '登录响应里没有访问令牌' }
    }
    return {
      state: 'signed-in',
      credential: {
        schemaVersion: 1,
        clientId: MINIMAX_OAUTH_CLIENT_ID,
        scopes: [...MINIMAX_OAUTH_SCOPES],
        audience: MINIMAX_OAUTH_AUDIENCE,
        accessToken: token.token,
        refreshToken: token.refreshToken,
        expiresAtMs: token.expiresInSec === undefined ? undefined : now + token.expiresInSec * 1000,
        obtainedAtMs: now,
      },
    }
  }
  const error = typeof document === 'object' && document !== null
    ? (document as Record<string, unknown>).error
    : undefined
  const description = typeof document === 'object' && document !== null
    ? (document as Record<string, unknown>).error_description
    : undefined
  const message = typeof description === 'string' ? description : undefined
  if (error === 'authorization_pending') return { state: 'pending' }
  if (error === 'slow_down') return { state: 'slow-down' }
  if (error === 'expired_token') return { state: 'expired', message }
  if (error === 'access_denied') return { state: 'denied', message }
  return { state: 'expired', message: message ?? `登录失败: HTTP ${response.status}` }
}

/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * The authorization server rotates the refresh token, so the new pair
 * replaces the old one wherever it is kept.
 */
export async function refreshPluginCredential(
  credential: PluginCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<PluginCredential> {
  if (credential.refreshToken === undefined) {
    throw new Error('没有可用于续期的 refresh token，请重新登录')
  }
  const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      scope: credential.scopes.join(' '),
      audience: credential.audience,
    }),
  })
  if (!response.ok) {
    throw new Error(`续期失败: HTTP ${response.status}`)
  }
  const token = readToken(await response.json())
  if (token === undefined) {
    throw new Error('续期响应里没有访问令牌')
  }
  return {
    ...credential,
    accessToken: token.token,
    refreshToken: token.refreshToken ?? credential.refreshToken,
    expiresAtMs: token.expiresInSec === undefined ? undefined : now + token.expiresInSec * 1000,
    obtainedAtMs: now,
  }
}
