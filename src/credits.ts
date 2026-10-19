/**
 * The MiniMax Code account's credit balance.
 *
 * Two credentials exist on this machine and they are not interchangeable:
 *
 * - `local-runtime.auth.json` holds a JWT the model gateway accepts. It cannot
 *   read account data: every credit endpoint answers `401`.
 * - `auth/prod/<region>/mcode-public/auth.json` holds the desktop app's OAuth
 *   token (`mmoat_`). That is the credential the account endpoints accept.
 *
 * The balance itself comes from the membership endpoint the desktop app calls
 * itself: `POST /matrix/api/v1/commerce/get_membership_info`, whose response
 * carries `op_credit_summary` — the same three numbers the app's own settings
 * page renders ("remaining credits", free vs purchased).
 *
 * Nothing here performs a login. The plugin may refresh an *expired* token
 * with the refresh token the app already stored, and writes the rotated pair
 * back in the app's own format so the app keeps working; it never starts a
 * sign-in, never revokes, and never touches the app's accounts.
 *
 * @module dsh-connect-minimaxcode/credits
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir, type MinimaxRegion } from './auth.ts'

/** The desktop app's own OAuth client id. */
export const MINIMAX_OAUTH_CLIENT_ID = 'mcode-public'

/** The scope the app requests. */
export const MINIMAX_OAUTH_SCOPES: readonly string[] = ['agent.default']

/** The audience the app's tokens are issued for. */
export const MINIMAX_OAUTH_AUDIENCE = 'agent-backend'

/** Authorization server per region. */
export const MINIMAX_AUTH_HOSTS: Record<MinimaxRegion, string> = {
  cn: 'https://account.minimax.cn',
  io: 'https://account.minimax.io',
  com: 'https://account.minimaxi.com',
}

/** Gateway serving the account endpoints per region. */
export const MINIMAX_ACCOUNT_HOSTS: Record<MinimaxRegion, string> = {
  cn: 'https://agent.minimax.cn',
  io: 'https://agent.minimax.io',
  com: 'https://agent.minimaxi.com',
}

/** Open-platform account API, which serves the per-model usage summary. */
export const MINIMAX_OPEN_HOSTS: Record<MinimaxRegion, string> = {
  cn: 'https://www.minimaxi.com',
  io: 'https://www.minimaxi.com',
  com: 'https://www.minimaxi.com',
}

/** Membership endpoint: carries the credit summary. */
export const MEMBERSHIP_PATH = '/matrix/api/v1/commerce/get_membership_info'

/** Credit ledger endpoint: per-grant amounts and expiry. */
export const CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details'

/** Per-model token usage summary (open platform). */
export const USAGE_SUMMARY_PATH = '/backend/account/token_plan/usage_summary'

/** OAuth token endpoint. */
export const TOKEN_PATH = '/oauth2/token'

/** How long before expiry a token counts as stale and worth refreshing. */
export const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000

/** The OAuth credential the account endpoints accept. */
export interface OAuthCredential {
  /** The `mmoat_` bearer token. */
  token: string
  /** The refresh token, when the app stored one. */
  refreshToken?: string
  /** Expiry in milliseconds since the epoch, when known. */
  expiresAtMs?: number
  /** The client the token was issued to. */
  clientId: string
  /** Scopes the token carries. */
  scopes: string[]
  /** Audience the token was issued for. */
  audience: string
  /** The app's login generation; preserved verbatim on write-back. */
  generation?: number
}

/** Why the account data may be unavailable. */
export type OAuthState =
  | { state: 'signed-in'; credential: OAuthCredential }
  | { state: 'expired'; credential: OAuthCredential }
  | { state: 'signed-out'; reason: 'app-missing' | 'not-signed-in' | 'unreadable' | 'malformed' }

/** Absolute path of the app's credential file for a region. */
export function oauthAuthPath(region: MinimaxRegion, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'auth', 'prod', region, 'mcode-public', 'auth.json')
}

/** Milliseconds until the credential expires; negative once it has. */
export function expiresInMs(credential: OAuthCredential, now = Date.now()): number | undefined {
  return credential.expiresAtMs === undefined ? undefined : credential.expiresAtMs - now
}

/** Whether the credential is close enough to expiry to be worth refreshing. */
export function needsRefresh(credential: OAuthCredential, now = Date.now()): boolean {
  const remaining = expiresInMs(credential, now)
  return remaining !== undefined && remaining <= TOKEN_REFRESH_MARGIN_MS
}

/**
 * Parse the app's credential document.
 *
 * The record key is generated per install, so the record is found by value
 * rather than by a hard-coded name.
 */
export function parseOAuthDocument(text: string, now = Date.now()): OAuthState {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { state: 'signed-out', reason: 'unreadable' }
  }
  const records = parsed.records
  if (typeof records !== 'object' || records === null) {
    return { state: 'signed-out', reason: 'not-signed-in' }
  }
  const record = Object.values(records as Record<string, unknown>)[0]
  if (typeof record !== 'object' || record === null) {
    return { state: 'signed-out', reason: 'not-signed-in' }
  }
  const entry = record as Record<string, unknown>
  const token = entry.accessToken
  if (typeof token !== 'string' || token.length === 0) {
    return { state: 'signed-out', reason: 'not-signed-in' }
  }
  const expiresAtMs = typeof entry.expiresAtMs === 'number' ? entry.expiresAtMs : undefined
  const credential: OAuthCredential = {
    token,
    refreshToken: typeof entry.refreshToken === 'string' ? entry.refreshToken : undefined,
    expiresAtMs,
    clientId: typeof entry.clientId === 'string' ? entry.clientId : MINIMAX_OAUTH_CLIENT_ID,
    scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((s): s is string => typeof s === 'string') : [...MINIMAX_OAUTH_SCOPES],
    audience: typeof entry.audience === 'string' ? entry.audience : MINIMAX_OAUTH_AUDIENCE,
    generation: typeof entry.generation === 'number' ? entry.generation : undefined,
  }
  return expiresAtMs !== undefined && expiresAtMs <= now
    ? { state: 'expired', credential }
    : { state: 'signed-in', credential }
}

/**
 * Read the desktop app's OAuth credential.
 *
 * Every failure is a state, not an exception: an app that is not installed, or
 * not signed in, is a normal condition the UI renders rather than an error the
 * host logs on every request.
 */
export async function readOAuthCredential(
  region: MinimaxRegion,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<OAuthState> {
  let text: string
  try {
    text = await readFile(oauthAuthPath(region, env), 'utf8')
  } catch {
    return { state: 'signed-out', reason: 'app-missing' }
  }
  return parseOAuthDocument(text, now)
}

/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * The authorization server rotates the refresh token, so the new pair is
 * written back into the app's own file, in the app's own format, with an
 * atomic replace. `generation` is left untouched on purpose: the app uses it
 * to decide whether a stored credential still belongs to its own login, and
 * raising it would make the app believe it had been signed in elsewhere.
 */
export async function refreshOAuthCredential(
  region: MinimaxRegion,
  credential: OAuthCredential,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthState> {
  if (credential.refreshToken === undefined) {
    return { state: 'expired', credential }
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
    scope: credential.scopes.join(' '),
    audience: credential.audience,
  })
  const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    throw new Error(`OAuth refresh failed: HTTP ${response.status}`)
  }
  const document = (await response.json()) as Record<string, unknown>
  const token = document.access_token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('OAuth refresh returned no access token')
  }
  const expiresInSec = typeof document.expires_in === 'number' ? document.expires_in : undefined
  const next: OAuthCredential = {
    ...credential,
    token,
    refreshToken: typeof document.refresh_token === 'string' ? document.refresh_token : credential.refreshToken,
    expiresAtMs: expiresInSec === undefined ? undefined : now + expiresInSec * 1000,
  }
  await writeOAuthCredential(region, next, env)
  return { state: 'signed-in', credential: next }
}

/**
 * Write a rotated credential back into the app's store.
 *
 * The document is rewritten as a whole so the app's own reader keeps seeing
 * the shape it wrote, and the replace is atomic so a crash mid-write cannot
 * leave a truncated credential file behind.
 */
export async function writeOAuthCredential(
  region: MinimaxRegion,
  credential: OAuthCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = oauthAuthPath(region, env)
  let document: Record<string, unknown>
  try {
    document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }
  const records = document.records
  if (typeof records !== 'object' || records === null) return
  const entries = Object.entries(records as Record<string, unknown>)
  const first = entries[0]
  if (first === undefined) return
  const [key, record] = first
  if (typeof record !== 'object' || record === null) return
  const existing = record as Record<string, unknown>
  const updated: Record<string, unknown> = {
    ...existing,
    accessToken: credential.token,
    refreshToken: credential.refreshToken ?? existing.refreshToken,
    tokenType: 'Bearer',
    clientId: credential.clientId,
    scopes: credential.scopes,
    audience: credential.audience,
    expiresAtMs: credential.expiresAtMs,
  }
  const payload = { ...document, records: { ...(records as Record<string, unknown>), [key]: updated } }
  const temporary = `${path}.dsh-connect-minimaxcode.tmp`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Read the credential, refreshing it when it is close to expiry.
 *
 * A refresh is only attempted for a credential the app already stored, and
 * only when it is actually stale: a fresh token is left alone, so the plugin
 * never competes with the app for the same grant.
 */
export async function ensureOAuthCredential(
  region: MinimaxRegion,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthState> {
  const state = await readOAuthCredential(region, env, now)
  if (state.state === 'signed-in' && !needsRefresh(state.credential, now)) {
    return state
  }
  if (state.state === 'signed-out') return state
  try {
    return await refreshOAuthCredential(region, state.credential, env, now, fetchImpl)
  } catch {
    // A failed refresh leaves the stored credential untouched; the UI reports
    // the expiry instead of a refresh error.
    return state
  }
}

/** The credit balance the desktop app shows. */
export interface CreditSummary {
  /** Remaining credits, free plus purchased. */
  total: number
  /** Remaining purchased credits. */
  purchased: number
  /** Remaining free (granted) credits. */
  free: number
}

/**
 * Read the credit summary out of a membership response.
 *
 * The app's settings page prefers the summary and falls back to the flat
 * balance fields, so the same fallback chain is used here.
 */
export function parseCreditSummary(document: unknown): CreditSummary | undefined {
  if (typeof document !== 'object' || document === null) return undefined
  const record = document as Record<string, unknown>
  const summary = record.op_credit_summary
  if (typeof summary === 'object' && summary !== null) {
    const entry = summary as Record<string, unknown>
    const total = toNumber(entry.total_remaining_amount)
    if (total !== undefined) {
      // The split into free and purchased is optional upstream; an account
      // whose grants are all free simply has no purchased part.
      const purchased = toNumber(entry.purchased_remaining_amount) ?? 0
      const free = toNumber(entry.free_remaining_amount) ?? total - purchased
      return { total, purchased, free }
    }
  }
  // The flat balance fields are a legacy account view: on an account that has
  // migrated to the credit pool they read zero even though credits remain, so
  // they are only used when the summary is absent altogether.
  const flat = toNumber(record.opcredit_balance) ?? toNumber(record.total_remains_credit)
  return flat === undefined ? undefined : { total: flat, purchased: 0, free: flat }
}

/** Read a numeric field the upstream may send as a string. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Fetch the current credit balance.
 *
 * @returns The balance, or `undefined` when the account has no credit summary.
 */
export async function fetchCreditSummary(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<CreditSummary | undefined> {
  const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${MEMBERSHIP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
    body: '{}',
  })
  if (!response.ok) {
    throw new Error(`membership request failed: HTTP ${response.status}`)
  }
  return parseCreditSummary(await response.json())
}

/** The balance plus what changed since the previous read. */
export interface CreditSnapshot {
  summary: CreditSummary
  /** Milliseconds since the epoch, when the balance was read. */
  fetchedAtMs: number
  /**
   * Credits consumed since the previous read.
   *
   * The upstream balance is a live counter, so the difference between two
   * reads is the credits actually spent in between. It can be negative when
   * credits are granted (the app grants credits daily), and it counts every
   * client of the account, not just this one.
   */
  consumed: number
}

/**
 * Keeps the current balance and the change between reads.
 *
 * The first read has nothing to compare against, so it reports no movement
 * rather than pretending the whole balance was spent.
 */
export class MinimaxCredits {
  #snapshot: CreditSnapshot | undefined
  #error: string | undefined

  /** The balance as last read. */
  get snapshot(): CreditSnapshot | undefined {
    return this.#snapshot
  }

  /** Why the last read failed, when one did. */
  get error(): string | undefined {
    return this.#error
  }

  /**
   * Read the balance and record how much was consumed since the last read.
   *
   * @returns Whether the balance changed.
   */
  async refresh(
    credential: OAuthCredential,
    region: MinimaxRegion,
    fetchImpl: typeof fetch = fetch,
    now = Date.now(),
  ): Promise<boolean> {
    try {
      const summary = await fetchCreditSummary(credential, region, fetchImpl)
      if (summary === undefined) {
        this.#error = 'membership response carried no credit summary'
        return false
      }
      const previous = this.#snapshot
      this.#snapshot = {
        summary,
        fetchedAtMs: now,
        consumed: previous === undefined ? 0 : previous.summary.total - summary.total,
      }
      this.#error = undefined
      return previous === undefined || previous.summary.total !== summary.total
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error)
      return false
    }
  }
}
