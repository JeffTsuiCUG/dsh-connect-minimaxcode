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

/** Open-platform credit endpoint that carries the account's plan key. */
export const TOKEN_PLAN_CREDIT_PATH = '/backend/account/token_plan_credit'

/**
 * Rate-limit window endpoint, as the open platform documents it.
 *
 * The M Plan FAQ names `GET /v1/token_plan/remains` as the way to read the
 * quota over HTTP. It asks for an API secret key rather than the desktop
 * app's OAuth bearer, and it is the path the upstream still maintains: the
 * older path this plugin started with now answers 200 with an empty body
 * even for accounts that do have windows.
 */
export const TOKEN_PLAN_REMAINS_PATH = '/v1/token_plan/remains'

/**
 * Rate-limit window endpoint the plugin used first.
 *
 * Kept as a fallback for an account whose open platform hands out no plan
 * key, since the documented path needs one.
 */
export const REMAINS_PERCENT_PATH = '/backend/account/token_plan/remains_percent'

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
 * The plan the account subscribes to.
 *
 * An account without one still reads a balance — it simply has no rolling
 * windows, which is what the limit readout used to report as missing. With a
 * plan the upstream names the tier and the day it ends, and both are worth
 * showing: the tier says what the account has, the day says how long it has.
 */
export interface PlanSummary {
  /** The tier's name, as the upstream spells it ("Go"). */
  tier?: string
  /** When the plan ends, in milliseconds since the epoch. */
  expiresAtMs?: number
  /** Whether the upstream reports an active plan at all. */
  active: boolean
}

/**
 * Read the plan out of a membership response.
 *
 * The upstream only fills these in for an account that subscribes: without a
 * plan `has_token_plan` is false and the tier is absent. `subscription_type`
 * says so too — "mplan" once a plan is held, "none" before.
 *
 * @returns The plan, or `undefined` when the response carries no plan fields.
 */
export function parsePlanSummary(document: unknown): PlanSummary | undefined {
  if (typeof document !== 'object' || document === null) return undefined
  const record = document as Record<string, unknown>
  const hasTokenPlan = record.has_token_plan
  const tier = typeof record.token_plan_tier === 'string' && record.token_plan_tier.length > 0
    ? record.token_plan_tier
    : undefined
  // A zero day is not a day: an account without a plan may carry the field
  // set to zero, and reporting "expires 1970" would be noise on a card that
  // every free account sees.
  const expires = toNumber(record.token_plan_expires_at)
  const expiresAtMs = expires === undefined || expires <= 0 ? undefined : expires
  if (hasTokenPlan !== true && tier === undefined && expiresAtMs === undefined) return undefined
  return {
    tier,
    expiresAtMs,
    active: hasTokenPlan === true || tier !== undefined,
  }
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
 * Fetch the membership document.
 *
 * One answer carries several things: the credit balance, the plan the
 * account subscribes to, and when that plan ends. They are read together so
 * that the account is asked once.
 */
export async function fetchMembershipDocument(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${MEMBERSHIP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
    body: '{}',
  })
  if (!response.ok) {
    throw new Error(`membership request failed: HTTP ${response.status}`)
  }
  const document = await response.json()
  return typeof document === 'object' && document !== null
    ? document as Record<string, unknown>
    : undefined
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
  const document = await fetchMembershipDocument(credential, region, fetchImpl)
  return document === undefined ? undefined : parseCreditSummary(document)
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
 * One grant of credits.
 *
 * Credits are granted in lots, and each lot carries its own expiry: the
 * desktop app grants credits daily, and a lot falls due thirty calendar days
 * after the day it was granted, at midnight in the account's own timezone.
 * Credits in a lot are lost when that moment arrives.
 */
export interface CreditLot {
  /** How much this lot was granted. */
  granted: number
  /** How much of it is left. */
  remaining: number
  /** How much of it has been used. */
  consumed: number
  /** When the lot was granted, in milliseconds since the epoch. */
  grantedAtMs: number
  /** When the lot expires, in milliseconds since the epoch. */
  expireAtMs: number
  /** The upstream's kind of lot, when it says. */
  creditType?: number
}

/**
 * Read the credit lots out of a ledger response.
 *
 * Lots that carry no expiry are ignored: a lot without an expiry date would
 * otherwise be treated as one that never expires.
 */
export function parseCreditLots(document: unknown): CreditLot[] {
  if (typeof document !== 'object' || document === null) return []
  const details = (document as Record<string, unknown>).details
  if (!Array.isArray(details)) return []
  const lots: CreditLot[] = []
  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const expireAtMs = toNumber(record.expire_at_ms)
    if (expireAtMs === undefined) continue
    const granted = toNumber(record.granted_amount) ?? 0
    const remaining = toNumber(record.remaining_amount) ?? 0
    lots.push({
      granted,
      remaining,
      consumed: toNumber(record.consumed_amount) ?? Math.max(0, granted - remaining),
      grantedAtMs: toNumber(record.granted_at_ms) ?? 0,
      expireAtMs,
      creditType: toNumber(record.credit_type),
    })
  }
  return lots.sort((a, b) => a.expireAtMs - b.expireAtMs)
}

/**
 * Fetch the credit ledger.
 *
 * The ledger is paginated, and the page parameter is `page_number` — `page`
 * is accepted and then ignored, which would make every page return the same
 * rows. The page size is capped upstream at 100.
 *
 * The default view already excludes expired grants, which is what this wants:
 * a grant that expired has nothing left to lose.
 */
export async function fetchCreditLots(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<CreditLot[]> {
  const pageSize = 100
  const lots: CreditLot[] = []
  let page = 1
  let total = Number.POSITIVE_INFINITY
  while (lots.length < total && page <= 50) {
    const url = `${MINIMAX_ACCOUNT_HOSTS[region]}${CREDIT_DETAILS_PATH}?page_number=${page}&page_size=${pageSize}`
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${credential.token}` } })
    if (!response.ok) {
      throw new Error(`credit ledger request failed: HTTP ${response.status}`)
    }
    const document = await response.json() as Record<string, unknown>
    const batch = parseCreditLots(document)
    const before = lots.length
    lots.push(...batch)
    const count = toNumber(document.total_count)
    if (count !== undefined) total = count
    if (batch.length < pageSize) break
    // A page that adds nothing new would otherwise loop forever.
    if (lots.length === before) break
    page += 1
  }
  return lots
}

/** One metered window: a span of time and how much of its allowance went. */
export interface UsageWindow {
  /** The share of the window's allowance already used, in percent. */
  usedPercent: number
  /** When the window opened, in milliseconds since the epoch. */
  startAtMs: number
  /** When the window closes and the allowance resets, in milliseconds since the epoch. */
  resetAtMs: number
}

/** The two rolling windows the plan meters usage in. */
export interface RateLimitWindows {
  /** The short window (five hours on the plans seen so far). */
  interval: UsageWindow
  /** The weekly window (seven days on the plans seen so far). */
  weekly: UsageWindow
}

/**
 * Read the two rate-limit windows out of a remains response.
 *
 * The upstream answers with one entry per metered group; the general one is
 * the only one the plan meters today, and the first entry is used when it is
 * absent. The window length is derived from the entry's own endpoints rather
 * than assumed to be five hours or seven days — the plan's terms have
 * changed before, and the display should follow whatever the server says.
 *
 * A window the server marks as unlimited (`current_*_status` of 3) carries no
 * allowance to be a percentage of, so it produces no window at all: reporting
 * "0%" of an unlimited quota would be a number nobody can act on.
 *
 * **Which share the upstream reports changed.** It used to answer with the
 * share already used, as a string ("19%"); with a plan subscribed it answers
 * with the share still *remaining*, as a plain number (90). Both are
 * accepted, and the two are opposites, so what leaves this function is
 * always the share used — otherwise the same window would read 90% used on
 * a plan that has barely spent anything.
 */
export function parseRateLimitWindows(document: unknown): RateLimitWindows | undefined {
  if (typeof document !== 'object' || document === null) return undefined
  const remains = (document as Record<string, unknown>).model_remains
  if (!Array.isArray(remains) || remains.length === 0) return undefined
  const entry = remains.find(
    item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).model_name === 'general',
  ) ?? remains[0]
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const interval = readWindow(
    usedPercentFrom(record.current_interval_used_percent, record.current_interval_remaining_percent),
    record.start_time,
    record.end_time,
    record.current_interval_status,
  )
  const weekly = readWindow(
    usedPercentFrom(record.current_weekly_used_percent, record.current_weekly_remaining_percent),
    record.weekly_start_time,
    record.weekly_end_time,
    record.current_weekly_status,
  )
  if (interval === undefined || weekly === undefined) return undefined
  return { interval, weekly }
}

/**
 * The status the upstream gives a window that is not limited at all.
 *
 * The desktop app reads it the same way: `isUnlimited: 3 === status`.
 */
const UNLIMITED_STATUS = 3

/**
 * The used share of a window, from either shape the upstream sends.
 *
 * The older path reports how much of the allowance went ("3%"); the documented
 * quota endpoint reports how much is left (96). Both describe the same window,
 * so a response that only carries the remaining share is turned into the used
 * one rather than treated as unreadable — the documented endpoint sends no
 * used field at all, which is what left the plan's windows off the card.
 */
function usedPercentFrom(used: unknown, remaining: unknown): number | undefined {
  const direct = parsePercent(used)
  if (direct !== undefined) return direct
  const rest = parsePercent(remaining)
  return rest === undefined ? undefined : 100 - rest
}

/** Assemble one window from its percent and edge fields; all must be present. */
function readWindow(
  percent: unknown,
  startAtMs: unknown,
  resetAtMs: unknown,
  status: unknown,
): UsageWindow | undefined {
  if (status === UNLIMITED_STATUS) return undefined
  const usedPercent = parsePercent(percent)
  const start = toNumber(startAtMs)
  const reset = toNumber(resetAtMs)
  if (usedPercent === undefined || start === undefined || reset === undefined) return undefined
  return { usedPercent, startAtMs: start, resetAtMs: reset }
}

/**
 * Read "19%" as 19, and a bare 19 as 19 as well.
 *
 * The desktop app parses both shapes, so both are accepted here: anything
 * unreadable stays unreadable rather than becoming a zero.
 */
function parsePercent(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const parsed = Number(value.replace(/%\s*$/, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Fetch the plan's two rate-limit windows from the older open-platform path.
 *
 * The endpoint lives on the open-platform host, like the usage summary, and
 * answers the same OAuth credential the membership endpoint takes. The JWT the
 * model gateway accepts does not work here: this is an account endpoint.
 *
 * @returns The windows, or `undefined` when the response carries none.
 */
export async function fetchRateLimitWindows(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<RateLimitWindows | undefined> {
  const url = `${MINIMAX_OPEN_HOSTS[region]}${REMAINS_PERCENT_PATH}?business=Agent&device_platform=desktop`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
  })
  if (!response.ok) {
    throw new Error(`rate-limit window request failed: HTTP ${response.status}`)
  }
  return parseRateLimitWindows(await response.json())
}

/**
 * Read the open platform's plan key.
 *
 * The documented quota endpoint wants an API secret key, and the open
 * platform is where the account's key comes from: the desktop app asks the
 * same endpoint with its OAuth bearer and gets the key back in the answer,
 * so the key is a property of the account rather than something the person
 * has to configure.
 *
 * @returns The key, or `undefined` when the account has none.
 */
export async function fetchTokenPlanApiKey(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = `${MINIMAX_OPEN_HOSTS[region]}${TOKEN_PLAN_CREDIT_PATH}?business=Agent&device_platform=desktop`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
  })
  if (!response.ok) {
    throw new Error(`token plan credit request failed: HTTP ${response.status}`)
  }
  const document = (await response.json()) as Record<string, unknown>
  const key = document.api_key
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * The account's usage profile, as the upstream summarizes it.
 *
 * The desktop app asks for this once a day and shows it as a yearly heatmap
 * with a few headline numbers. It is the only place the upstream says how the
 * account actually uses its tokens, and none of it is visible elsewhere: the
 * balance says how much is left, not how much was spent or how the account
 * compares with other users.
 */
export interface UsageProfile {
  /** Days the summary window covers. */
  totalDays?: number
  /** Days in the window that saw any usage. */
  activeDays?: number
  /** Consecutive days of use up to today. */
  currentConsecutiveDays?: number
  /** Tokens consumed in the window, in the upstream's own wording ("826.14M"). */
  totalTokenConsumed?: string
  /** Where the account sits among other users, in percent (10.3 = above 89.7% of users). */
  usageRankingPercent?: number
  /** The busiest day in the window. */
  mostActiveDay?: { date?: string; tokenCount?: string }
  /** When the upstream last refreshed the summary. */
  lastUpdateTime?: string
  /** Daily token usage, oldest first. */
  dailyTokenUsage?: number[]
}

/**
 * Read a string field, ignoring anything that is not a string.
 *
 * The upstream's token counts carry their own unit ("826.14M"), so they are
 * kept as the wording it used rather than pulled apart into a number.
 */
function toText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Read the usage profile out of a summary response.
 *
 * Every field is optional in practice: the upstream adds fields over time, and
 * an account with no history at all answers with a body that carries none of
 * them. A field that is missing — or that arrives in a shape this does not
 * recognise — is therefore reported as absent rather than as an error, so one
 * odd field never costs the whole profile. A body that is not an object at
 * all carries no profile and yields none.
 */
export function parseUsageProfile(document: unknown): UsageProfile | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const record = document as Record<string, unknown>
  const day = record.most_active_day
  const mostActiveDay = typeof day === 'object' && day !== null ? (day as Record<string, unknown>) : undefined
  const date = toText(mostActiveDay?.date)
  const tokenCount = toText(mostActiveDay?.token_count)
  const daily = Array.isArray(record.daily_token_usage)
    ? record.daily_token_usage.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : undefined
  return {
    totalDays: toNumber(record.total_days),
    activeDays: toNumber(record.active_days),
    currentConsecutiveDays: toNumber(record.current_consecutive_days),
    totalTokenConsumed: toText(record.total_token_consumed),
    usageRankingPercent: toNumber(record.usage_ranking_percent),
    mostActiveDay: date === undefined && tokenCount === undefined ? undefined : { date, tokenCount },
    lastUpdateTime: toText(record.last_update_time),
    dailyTokenUsage: daily,
  }
}

/**
 * Fetch the account's usage profile.
 *
 * The endpoint lives on the open-platform host and takes the same OAuth
 * bearer the membership endpoint takes; the JWT the model gateway accepts
 * does not work here. The query is the one the desktop app sends, and it is
 * not trimmed down: `token_type` picks which token kind is counted and
 * `heatmap_days` sets how far back the daily series reaches.
 *
 * @returns The profile, or `undefined` when the response carries no object.
 */
export async function fetchUsageProfile(
  credential: OAuthCredential,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageProfile | undefined> {
  const url = `${MINIMAX_OPEN_HOSTS[region]}${USAGE_SUMMARY_PATH}?token_type=5&heatmap_days=365&business=Agent&device_platform=desktop`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
  })
  if (!response.ok) {
    throw new Error(`usage summary request failed: HTTP ${response.status}`)
  }
  return parseUsageProfile(await response.json())
}

/** What a quota read found. */
export interface RateLimitRead {
  /** The windows, when the plan meters any. */
  windows?: RateLimitWindows
  /** Why there are none, when the upstream said so plainly. */
  absence?: 'no-subscription'
  /** Why the read failed, when it did. */
  error?: string
}

/** The upstream's own code for "this account has no plan subscription". */
const NO_SUBSCRIPTION_CODE = 2062

/** The upstream's own code for "the request carried no usable API key". */
const MISSING_API_KEY_CODE = 1004

/** The upstream's status code inside a response body, when it carries one. */
function readBaseRespCode(document: Record<string, unknown>): number | undefined {
  const base = document.base_resp
  if (typeof base !== 'object' || base === null) return undefined
  const code = (base as Record<string, unknown>).status_code
  return typeof code === 'number' ? code : undefined
}

/**
 * Read the windows from the documented quota endpoint.
 *
 * The upstream says plainly when there is nothing to report: `2062` means
 * the account has no plan subscription, and the quota does not exist for it
 * at all. That is a fact about the plan rather than a failure to read, so
 * it is reported as such and not as an error — the windows of a plan the
 * account does not hold are not missing data.
 */
export async function fetchTokenPlanWindows(
  apiKey: string,
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<RateLimitRead> {
  const url = `${MINIMAX_OPEN_HOSTS[region]}${TOKEN_PLAN_REMAINS_PATH}`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`rate-limit window request failed: HTTP ${response.status}`)
  }
  const document = (await response.json()) as Record<string, unknown>
  const code = readBaseRespCode(document)
  if (code === NO_SUBSCRIPTION_CODE) return { absence: 'no-subscription' }
  if (code === MISSING_API_KEY_CODE) return { error: 'the open platform did not accept the plan key' }
  const windows = parseRateLimitWindows(document)
  if (windows === undefined) return { error: 'response carried no rate-limit windows' }
  return { windows }
}

/** How many days of expiry the plugin calls "about to expire". */
export const EXPIRING_WINDOW_DAYS = 3

/** How many days it looks ahead for the wider bucket. */
export const EXPIRING_HORIZON_DAYS = 30

/** What the lots say about credits that are about to be lost. */
export interface ExpirySummary {
  /** Credits in lots that expire within {@link EXPIRING_WINDOW_DAYS} days. */
  expiring: number
  /** How many lots that is. */
  expiringLots: number
  /** Credits in lots that expire within {@link EXPIRING_HORIZON_DAYS} days. */
  expiringSoon: number
  /** When the next lot with credits left expires. */
  nextExpiryAtMs?: number
  /** The next lots with credits left, soonest first. */
  upcoming: { amount: number; expireAtMs: number }[]
  /** Credits left across every lot. */
  totalRemaining: number
}

/**
 * Summarize what is about to expire.
 *
 * Only lots that still hold credits count: a lot that was granted and used up
 * expires with nothing to lose, and counting it would make every account look
 * like it is about to lose credits.
 */
export function summarizeExpiry(lots: readonly CreditLot[], now = Date.now()): ExpirySummary {
  const alive = lots.filter(lot => lot.remaining > 0 && lot.expireAtMs > now)
  const within = (days: number) => alive.filter(lot => lot.expireAtMs - now <= days * 86_400_000)
  const week = within(EXPIRING_WINDOW_DAYS)
  const month = within(EXPIRING_HORIZON_DAYS)
  return {
    expiring: week.reduce((sum, lot) => sum + lot.remaining, 0),
    expiringLots: week.length,
    expiringSoon: month.reduce((sum, lot) => sum + lot.remaining, 0),
    nextExpiryAtMs: alive[0]?.expireAtMs,
    upcoming: alive.slice(0, 5).map(lot => ({ amount: lot.remaining, expireAtMs: lot.expireAtMs })),
    totalRemaining: lots.reduce((sum, lot) => sum + lot.remaining, 0),
  }
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
  #lots: CreditLot[] = []
  #expiry: ExpirySummary | undefined
  #ledgerAtMs: number | undefined
  #ledgerError: string | undefined
  #rateLimit: RateLimitWindows | undefined
  #rateLimitError: string | undefined
  #plan: PlanSummary | undefined
  #rateLimitAbsence: 'no-subscription' | undefined
  #rateLimitAtMs: number | undefined
  #usageProfile: UsageProfile | undefined
  #usageProfileError: string | undefined
  #apiKey: string | undefined

  /** The balance as last read. */
  get snapshot(): CreditSnapshot | undefined {
    return this.#snapshot
  }

  /** Why the last read failed, when one did. */
  get error(): string | undefined {
    return this.#error
  }

  /** The credit lots as last read. */
  get lots(): readonly CreditLot[] {
    return this.#lots
  }

  /** What the lots say about expiry, when the ledger could be read. */
  get expiry(): ExpirySummary | undefined {
    return this.#expiry
  }

  /** When the ledger was last read. */
  get ledgerAtMs(): number | undefined {
    return this.#ledgerAtMs
  }

  /** Why the ledger could not be read, when it could not. */
  get ledgerError(): string | undefined {
    return this.#ledgerError
  }

  /** The plan's rate-limit windows as last read. */
  get rateLimit(): RateLimitWindows | undefined {
    return this.#rateLimit
  }

  /** Why the windows could not be read, when they could not. */
  get rateLimitError(): string | undefined {
    return this.#rateLimitError
  }

  /** The plan the account subscribes to, as the last read found it. */
  get plan(): PlanSummary | undefined {
    return this.#plan
  }

  /** Why the plan has no windows, when the upstream said so plainly. */
  get rateLimitAbsence(): 'no-subscription' | undefined {
    return this.#rateLimitAbsence
  }

  /** When the windows were last read. */
  get rateLimitAtMs(): number | undefined {
    return this.#rateLimitAtMs
  }

  /** The account's usage profile as last read. */
  get usageProfile(): UsageProfile | undefined {
    return this.#usageProfile
  }

  /** Why the usage profile could not be read, when it could not. */
  get usageProfileError(): string | undefined {
    return this.#usageProfileError
  }

  /**
   * Read the balance and record how much was consumed since the last read.
   *
   * The credit ledger is read alongside it, but a ledger that cannot be read
   * never hides the balance: the two come from different endpoints and only
   * the balance is essential. The rate-limit windows and the usage profile
   * ride along under the same rule — they come from yet other endpoints, and
   * none of the four takes the others down with it.
   *
   * @returns Whether the balance changed.
   */
  async refresh(
    credential: OAuthCredential,
    region: MinimaxRegion,
    fetchImpl: typeof fetch = fetch,
    now = Date.now(),
  ): Promise<boolean> {
    let changed = false
    try {
      const document = await fetchMembershipDocument(credential, region, fetchImpl)
      // The same answer carries the plan, so it is read here rather than by
      // asking the account a second time.
      if (document !== undefined) this.#plan = parsePlanSummary(document)
      const summary = document === undefined ? undefined : parseCreditSummary(document)
      if (summary === undefined) {
        this.#error = 'membership response carried no credit summary'
      } else {
        const previous = this.#snapshot
        this.#snapshot = {
          summary,
          fetchedAtMs: now,
          consumed: previous === undefined ? 0 : previous.summary.total - summary.total,
        }
        this.#error = undefined
        changed = previous === undefined || previous.summary.total !== summary.total
      }
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error)
    }
    await this.refreshLedger(credential, region, fetchImpl, now)
    await this.refreshRateLimit(credential, region, fetchImpl, now)
    await this.refreshUsageProfile(credential, region, fetchImpl)
    return changed
  }

  /**
   * Read the credit ledger and work out what is about to expire.
   *
   * A failure here is remembered but never thrown: the balance is what the
   * user needs most, and a ledger that is temporarily unavailable must not
   * take it down with it.
   */
  async refreshLedger(
    credential: OAuthCredential,
    region: MinimaxRegion,
    fetchImpl: typeof fetch = fetch,
    now = Date.now(),
  ): Promise<void> {
    try {
      const lots = await fetchCreditLots(credential, region, fetchImpl)
      this.#lots = lots
      this.#expiry = summarizeExpiry(lots, now)
      this.#ledgerAtMs = now
      this.#ledgerError = undefined
    } catch (error) {
      this.#ledgerError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Read the plan's rate-limit windows.
   *
   * Same rule as the ledger: a failure is remembered but never thrown, and a
   * window that cannot be read leaves the last one on display.
   */
  async refreshRateLimit(
    credential: OAuthCredential,
    region: MinimaxRegion,
    fetchImpl: typeof fetch = fetch,
    now = Date.now(),
  ): Promise<void> {
    try {
      const read = await this.readWindows(credential, region, fetchImpl)
      // A read that failed keeps the last windows on display; a read that
      // succeeded replaces them, including with none when the plan has none.
      if (read.error === undefined) this.#rateLimit = read.windows
      this.#rateLimitAbsence = read.absence
      this.#rateLimitError = read.error
      this.#rateLimitAtMs = now
    } catch (error) {
      this.#rateLimitError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Read the account's usage profile.
   *
   * Same rule as the ledger: a failure is remembered but never thrown, and a
   * profile that cannot be read leaves the last one on display.
   */
  async refreshUsageProfile(
    credential: OAuthCredential,
    region: MinimaxRegion,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    try {
      const profile = await fetchUsageProfile(credential, region, fetchImpl)
      this.#usageProfile = profile
      this.#usageProfileError = undefined
    } catch (error) {
      this.#usageProfileError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Read the windows from whichever endpoint can answer.
   *
   * The documented endpoint needs the open platform's plan key, which the
   * same platform hands out; the key is remembered because it does not
   * change from one read to the next. An account with no key at all still
   * gets the older path's answer.
   */
  async readWindows(
    credential: OAuthCredential,
    region: MinimaxRegion,
    fetchImpl: typeof fetch = fetch,
  ): Promise<RateLimitRead> {
    const apiKey = this.#apiKey ?? (await fetchTokenPlanApiKey(credential, region, fetchImpl))
    this.#apiKey = apiKey
    if (apiKey !== undefined) {
      try {
        const read = await fetchTokenPlanWindows(apiKey, region, fetchImpl)
        // "No subscription" is the documented path's own plain answer and is
        // not worth a second request; a shape it failed to read is. The older
        // path still might carry windows the documented one did not.
        if (read.error === undefined || read.absence !== undefined) return read
        const legacy = await fetchRateLimitWindows(credential, region, fetchImpl)
        if (legacy !== undefined) return { windows: legacy }
        return read
      } catch (error) {
        // The documented path could not answer. The older one still might.
        const legacy = await fetchRateLimitWindows(credential, region, fetchImpl)
        if (legacy !== undefined) return { windows: legacy }
        throw error
      }
    }
    const legacy = await fetchRateLimitWindows(credential, region, fetchImpl)
    return legacy === undefined
      ? { error: 'response carried no rate-limit windows' }
      : { windows: legacy }
  }
}
