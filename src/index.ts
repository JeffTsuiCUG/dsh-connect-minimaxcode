/**
 * MiniMax Code models for DeepSeek Harness.
 *
 * Registers one provider, `minimaxcode`, that serves the models the signed-in
 * MiniMax Code desktop app has access to. Streaming, tool calls, and
 * permissions stay Harness-owned; this plugin only supplies the route and the
 * catalog.
 *
 * @module dsh-connect-minimaxcode
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: it brings in the `attachments` Context augmentation, which is
// what makes `ctx.get('attachments')` a typed read.
import type {} from '@deepseek-ai/dsh-attachment'
// Type-only: pulls in the `webServer` Context augmentation this file relies on.
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import {
  bearerToken,
  expiresInMs,
  expiryLevel,
  MINIMAX_REGIONS,
  readCredential,
  type Credential,
  type MinimaxRegion,
} from './auth.ts'
import { MinimaxCatalog } from './catalog.ts'
import { createMinimaxCodeAdapter } from './adapter.ts'
import { imageInputHooks } from './image-input.ts'
import { MINIMAX_ACTION_PATH, MINIMAX_CAPABILITY_PATH, MINIMAX_GENERATE_PATH, MINIMAX_STATUS_PATH, isLoopback, statusDocument, type CreditStatus, type PlanStatus, type RateLimitStatus, type StatusDeps, type UsageStatus, type UsageProfileStatus, type SigninStatus, type LoginStatus } from './status-route.ts'
import {
  GenerationError,
  IMAGE_AREAS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODELS,
  VIDEO_DURATIONS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  downloadImage,
  fetchPlanApiKey,
  generateImages,
  queryVideoTask,
  startVideoTask,
} from './generation.ts'
import { MinimaxCredits, ensureOAuthCredential, type OAuthCredential, type OAuthState } from './credits.ts'
import {
  credentialNeedsRefresh,
  deletePluginCredential,
  readPluginCredential,
  readPluginState,
  toOAuthCredential,
  writePluginCredential,
  writePluginState,
  type PluginCredential,
  type PluginState,
} from './credentials.ts'
import { pollDeviceLogin, refreshPluginCredential, startDeviceLogin } from './login.ts'
import {
  SIGNIN_DAY_STATUS,
  claimSignin,
  fetchSigninPanel,
  localDay,
  type SigninClaim,
  type SigninPanel,
} from './signin.ts'
import { UsageMeter } from './usage.ts'

export { MINIMAXCODE_PROVIDER_ID, MinimaxCatalog, parseCatalog, FALLBACK_MODELS } from './catalog.ts'
export type { CatalogModel, CatalogSource } from './catalog.ts'
export {
  MinimaxCredits,
  ensureOAuthCredential,
  fetchCreditSummary,
  fetchMembershipDocument,
  fetchRateLimitWindows,
  parseCreditSummary,
  parsePlanSummary,
  parseOAuthDocument,
  parseRateLimitWindows,
  readOAuthCredential,
  refreshOAuthCredential,
  writeOAuthCredential,
  MEMBERSHIP_PATH,
  MINIMAX_OAUTH_CLIENT_ID,
  REMAINS_PERCENT_PATH,
  type CreditSummary,
  type OAuthCredential,
  type PlanSummary,
  type OAuthState,
  type RateLimitWindows,
} from './credits.ts'
export { EMPTY_USAGE, MODEL_PRICES, UsageMeter, estimateCny, priceFor, type ModelUsage } from './usage.ts'
export {
  PLUGIN_CREDENTIAL_FILENAME,
  PLUGIN_STATE_FILENAME,
  deletePluginCredential,
  dshHome,
  pluginCredentialPath,
  pluginStatePath,
  readPluginCredential,
  readPluginState,
  writePluginCredential,
  writePluginState,
  type PluginCredential,
  type PluginState,
} from './credentials.ts'
export {
  DEVICE_CODE_GRANT,
  DEVICE_CODE_PATH,
  makePkce,
  pollDeviceLogin,
  refreshPluginCredential,
  startDeviceLogin,
  type DeviceLoginState,
} from './login.ts'
export {
  SIGNIN_CLAIM_PATH,
  SIGNIN_CLAIM_RESULT,
  SIGNIN_CYCLE_DAYS,
  SIGNIN_DAY_STATUS,
  SIGNIN_PANEL_PATH,
  claimSignin,
  fetchSigninPanel,
  localDay,
  parseSigninClaim,
  parseSigninPanel,
  timezoneId,
  type SigninClaim,
  type SigninDay,
  type SigninPanel,
} from './signin.ts'
export {
  MINIMAX_AUTH_FILENAME,
  MINIMAX_DATA_DIR,
  MINIMAX_GATEWAYS,
  MINIMAX_REGIONS,
  authPath,
  bearerToken,
  chatBaseUrl,
  catalogUrl,
  dataDir,
  daysRemaining,
  decodeClaims,
  expiresInMs,
  expiryLevel,
  parseAuthDocument,
  readCredential,
} from './auth.ts'
export type { AuthState, Credential, MinimaxRegion, TokenClaims } from './auth.ts'
export { MINIMAX_ACTION_PATH, MINIMAX_STATUS_PATH, statusDocument } from './status-route.ts'
export type { StatusDocument } from './status-route.ts'
export { MINIMAX_STREAM_IDLE_TIMEOUT_MS, createMinimaxCodeAdapter } from './adapter.ts'

/** Loader entry name; also the id the bundle patch inserts. */
/**
 * Whether a message says the server refused the credential itself.
 *
 * The account and catalog endpoints answer a revoked or unknown bearer with
 * `401`, and the only place that surfaces is the message the request layer
 * built. Matching the status code rather than the wording keeps this working
 * whatever language the message is written in.
 */
const isUnauthorized = (message: string | undefined): boolean =>
  message !== undefined && /\bHTTP 401\b/.test(message)

/**
 * Whether a failed refresh means the credential can never be used again.
 *
 * The authorization server answers a revoked or already-spent refresh token
 * with `400`/`401`, and a credential that carries no refresh token can never
 * be renewed at all. Both are final. A `5xx` or a dropped connection is not:
 * throwing the credential away over a bad minute upstream would sign the
 * person out for nothing.
 */
const isRefreshRefused = (message: string): boolean =>
  message.includes('没有可用于续期的 refresh token') || /\bHTTP (400|401)\b/.test(message)

const name = 'dsh-connect-minimaxcode'

/** Services this plugin needs before it can serve anything. */
const inject = ['llm']

export { inject, name }

/** Which gateway a given account should be served from. */
function pickRegion(preferred: string | undefined): MinimaxRegion {
  if (preferred !== undefined && (MINIMAX_REGIONS as readonly string[]).includes(preferred)) {
    return preferred as MinimaxRegion
  }
  return 'cn'
}

/** How often the card may pull a fresh catalog. */
const CATALOG_TTL_MS = 5 * 60 * 1000

/**
 * How often the account's credit balance may be re-read.
 *
 * The balance is a live counter upstream, but it is an account-wide value:
 * reading it too often buys nothing except load on the account API.
 */
const CREDIT_TTL_MS = 30 * 1000

/**
 * How often the check-in cycle may be re-read.
 *
 * The cycle changes once a day, so reading it as often as the balance is
 * read would buy nothing but load on the account API.
 */
const SIGNIN_TTL_MS = 5 * 60 * 1000

/**
 * Compose the plugin.
 *
 * The credential is re-read on every request rather than cached at start: the
 * desktop app refreshes its token independently, and a long-lived host would
 * otherwise pin an expired one for the rest of the process.
 *
 * @param ctx - Service container.
 */
function apply(ctx: Context) {
  const catalog = new MinimaxCatalog()
  const credits = new MinimaxCredits()
  const meter = new UsageMeter()
  let region: MinimaxRegion = 'cn'
  let credential: Credential | undefined
  let lastCatalogAtMs = 0
  let lastCreditAtMs = 0
  let lastSigninAtMs = 0
  let refreshing = false
  let creditState: 'ok' | 'unavailable' | 'expired' | 'signed-out' = 'unavailable'
  /** The token the model descriptors carry, refreshed with the credential. */
  let modelToken: string | undefined
  /** The plugin's own settings, read from its own file. */
  let pluginState: PluginState = { schemaVersion: 1, autoCheckin: false }
  /** The cycle as the account last reported it. */
  let signinPanel: SigninPanel | undefined
  /** What the last claim answered. */
  let signinClaim: SigninClaim | undefined
  /** Why the cycle or the claim could not be read. */
  let signinError: string | undefined
  /** Where the sign-in came from. */
  let loginSource: 'plugin' | 'desktop-app' | undefined
  /** Whether a device login is waiting to be authorized. */
  let loginPending = false
  /** Whether the server refused the plugin's own credential. */
  let revokedByServer = false
  /** What the card last reported about what the host offered it. */
  let capability: { at: number; findings: Record<string, string> } | undefined
  /** The plan the account subscribes to, as the last read found it. */
  let plan: PlanStatus | undefined

  /**
   * Give up on the plugin's own credential after the server refused it.
   *
   * A revoked token keeps its expiry date, so every later call would send the
   * same dead token and fail the same way. The only way back is a new sign-in,
   * so the credential is deleted, the cached views of the account it belonged
   * to are dropped, and the card is left asking for one.
   */
  const revokePluginCredential = async (): Promise<void> => {
    await deletePluginCredential()
    if (pluginState.deviceLogin !== undefined) {
      pluginState = { ...pluginState, deviceLogin: undefined }
      await writePluginState(pluginState)
    }
    revokedByServer = true
    credential = undefined
    modelToken = undefined
    loginSource = undefined
    loginPending = false
    creditState = 'signed-out'
    signinPanel = undefined
    signinClaim = undefined
    signinError = undefined
    catalog.invalidate()
    // Throttled rather than immediate: the refusal is already known, and a new
    // credential is what should change these reads, not another retry.
    lastCreditAtMs = Date.now()
    lastSigninAtMs = Date.now()
    lastCatalogAtMs = 0
  }

  /**
   * The credential the model gateway is called with.
   *
   * The plugin's own sign-in comes first: it is the credential the person
   * chose, and on a machine where the desktop app was never installed it is
   * the only one there is.
   *
   * The desktop app's OAuth grant is next, and it is not a mere fallback: it
   * is the credential a current install actually holds. Its `mmoat_` bearer is
   * what the gateway accepts, while the legacy JWT older installs left behind
   * is refused with `401 auth failed` — so the OAuth file has to be consulted
   * before that JWT, or a working machine looks broken.
   */
  const resolveGatewayCredential = async (): Promise<Credential | undefined> => {
    const own = await readPluginCredential()
    if (own !== undefined) {
      if (credentialNeedsRefresh(own)) {
        try {
          const next = await refreshPluginCredential(own, region)
          await writePluginCredential(next)
          loginSource = 'plugin'
          modelToken = next.accessToken
          revokedByServer = false
          return { token: next.accessToken, claims: { exp: Math.floor((next.expiresAtMs ?? Date.now()) / 1000) } }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isRefreshRefused(message)) {
            // The refresh token is spent: no retry can bring this credential
            // back, so it is dropped and a new sign-in is asked for.
            await revokePluginCredential()
            return undefined
          }
          // Any other failure is transient: the desktop app may still hold a
          // working token, so the chain below is still worth walking.
        }
      } else {
        loginSource = 'plugin'
        modelToken = own.accessToken
        return { token: own.accessToken, claims: { exp: Math.floor((own.expiresAtMs ?? Date.now()) / 1000) } }
      }
    }
    const oauth = await ensureOAuthCredential(region, process.env)
    if (oauth.state === 'signed-in') {
      loginSource = 'desktop-app'
      modelToken = oauth.credential.token
      return {
        token: oauth.credential.token,
        claims: { exp: Math.floor((oauth.credential.expiresAtMs ?? Date.now()) / 1000) },
      }
    }
    const state = await readCredential()
    if (state.state !== 'signed-in') {
      loginSource = undefined
      modelToken = undefined
      return undefined
    }
    loginSource = 'desktop-app'
    modelToken = state.credential.token
    return state.credential
  }

  /**
   * The credential the account endpoints are called with.
   *
   * The account API needs the `mmoat_` token, not the gateway's JWT, so this
   * is a second credential: the plugin's own sign-in when there is one, and
   * otherwise the token the desktop app stored.
   */
  const resolveAccountCredential = async (now = Date.now()): Promise<OAuthState> => {
    const own = await readPluginCredential()
    if (own !== undefined) {
      if (credentialNeedsRefresh(own, now)) {
        try {
          const next = await refreshPluginCredential(own, region, fetch, now)
          await writePluginCredential(next)
          return { state: 'signed-in', credential: toOAuthCredential(next) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isRefreshRefused(message)) {
            // The grant is gone for good: reporting "expired" would only
            // invite another doomed refresh and hide the sign-in button.
            await revokePluginCredential()
            return { state: 'signed-out', reason: 'not-signed-in' }
          }
          return { state: 'expired', credential: toOAuthCredential(own) }
        }
      }
      return { state: 'signed-in', credential: toOAuthCredential(own) }
    }
    return ensureOAuthCredential(region, process.env, now)
  }

  const readNow = async (): Promise<Credential | undefined> => {
    const state = await resolveGatewayCredential()
    if (state === undefined) {
      credential = undefined
      catalog.invalidate()
      return undefined
    }
    credential = state
    return state
  }

  /** Refresh the catalog at most once per TTL, never blocking a request. */
  const refreshCatalog = async (current: Credential): Promise<void> => {
    const now = Date.now()
    if (refreshing || now - lastCatalogAtMs < CATALOG_TTL_MS) return
    refreshing = true
    try {
      await catalog.refresh(region, current)
      lastCatalogAtMs = Date.now()
    } finally {
      refreshing = false
    }
  }

  /**
   * Read the account's credit balance, at most once per TTL.
   *
   * The account API needs the desktop app's own OAuth token, not the model
   * gateway's JWT, so this reads a second credential file. A stale token is
   * refreshed through the app's own grant and written back in the app's own
   * format, which keeps the app signed in.
   */
  const refreshCredits = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastCreditAtMs < CREDIT_TTL_MS) return
    lastCreditAtMs = now
    const state = await resolveAccountCredential(now)
    if (state.state === 'signed-out') {
      creditState = 'signed-out'
      return
    }
    if (state.state === 'expired') {
      creditState = 'expired'
      return
    }
    await credits.refresh(state.credential, region, fetch, now)
    creditState = credits.snapshot === undefined ? 'unavailable' : 'ok'
    // The account API answers a refused token with `401`. That is the one
    // signal that the credential itself is the problem, and the balance, the
    // ledger and the rate-limit window all carry it, so any of them counts.
    // The quota endpoint is deliberately left out: it is asked with the
    // open platform's plan key, so a 401 there says the key is wrong, not
    // that the person's own credential was revoked.
    const refused = [credits.error, credits.ledgerError]
      .find(message => isUnauthorized(message))
    if (refused !== undefined) {
      await revokePluginCredential()
      return
    }
    // A working read is proof the credential is alive again, whatever an
    // earlier refusal said.
    if (credits.snapshot !== undefined) revokedByServer = false
  }

  /**
   * Read the check-in cycle, and claim the day's grant when asked to.
   *
   * The claim is the one request here that changes something upstream. It is
   * made at most once a day, only when the person turned it on, and only when
   * the server itself says the day can be claimed — so a day that is already
   * claimed never produces a request, and a claim that already happened
   * upstream is answered with "already claimed" and grants nothing.
   */
  const refreshSignin = async (): Promise<void> => {
    const now = Date.now()
    // The cycle only changes once a day, so it is not worth reading as often
    // as the balance is. The claim itself is gated on the day, not on this.
    if (now - lastSigninAtMs < SIGNIN_TTL_MS && signinPanel !== undefined) return
    lastSigninAtMs = now
    const state = await resolveAccountCredential()
    if (state.state !== 'signed-in') {
      signinPanel = undefined
      return
    }
    let panel: SigninPanel | undefined
    try {
      panel = await fetchSigninPanel(state.credential, region, fetch)
      signinPanel = panel
      signinError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnauthorized(message)) {
        await revokePluginCredential()
        return
      }
      signinError = message
      return
    }
    if (!pluginState.autoCheckin || panel === undefined) return
    const today = panel.days.find(day => day.isToday)
    if (today === undefined || today.status !== SIGNIN_DAY_STATUS.claimable) return
    if (pluginState.lastClaimDay === localDay()) return
    await performClaim(state.credential)
  }

  /** Claim today's grant and remember that it happened. */
  const performClaim = async (credential: OAuthCredential): Promise<SigninClaim | undefined> => {
    try {
      const claim = await claimSignin(credential, region, fetch)
      if (claim === undefined) {
        signinError = '签到接口没有返回可识别的结果'
        return undefined
      }
      signinClaim = claim
      signinError = undefined
      if (claim.panel !== undefined) signinPanel = claim.panel
      // The claim happened, whatever the day was; the day is what stops a
      // second claim from being made.
      pluginState = {
        ...pluginState,
        lastClaimDay: localDay(),
        lastClaimAtMs: Date.now(),
        lastClaimPoints: claim.points,
      }
      await writePluginState(pluginState)
      // The balance moved, so the balance is worth re-reading.
      lastCreditAtMs = 0
      void refreshCredits()
      return claim
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnauthorized(message)) {
        await revokePluginCredential()
        return undefined
      }
      signinError = message
      return undefined
    }
  }

  /** The credit balance as the card and the browser half read it. */
  const buildCreditStatus = (): CreditStatus => {
    const snapshot = credits.snapshot
    const expiry = credits.expiry
    if (snapshot === undefined) {
      return { state: creditState, ...credits.error === undefined ? {} : { error: credits.error } }
    }
    return {
      state: 'ok',
      total: snapshot.summary.total,
      purchased: snapshot.summary.purchased,
      free: snapshot.summary.free,
      consumed: snapshot.consumed,
      updatedAtMs: snapshot.fetchedAtMs,
      ...expiry === undefined
        ? {}
        : {
            expiring: expiry.expiring,
            expiringLots: expiry.expiringLots,
            expiringSoon: expiry.expiringSoon,
            nextExpiryAtMs: expiry.nextExpiryAtMs,
            upcoming: expiry.upcoming,
          },
      ...credits.ledgerAtMs === undefined ? {} : { ledgerAtMs: credits.ledgerAtMs },
      ...credits.ledgerError === undefined ? {} : { ledgerError: credits.ledgerError },
    }
  }

  /**
   * The account's usage profile as the card reads it.
   *
   * The upstream's own summary of the account's history: how many days it has
   * been used in a row, how much it has consumed, and where it ranks. It is
   * about the account rather than about this host, which is what the pill's
   * own token count reports.
   */
  const buildUsageProfileStatus = (): UsageProfileStatus | undefined => {
    const profile = credits.usageProfile
    if (profile === undefined) {
      return credits.usageProfileError === undefined
        ? undefined
        : { state: 'unavailable', error: credits.usageProfileError }
    }
    return {
      state: 'ok',
      totalDays: profile.totalDays,
      activeDays: profile.activeDays,
      consecutiveDays: profile.currentConsecutiveDays,
      totalTokenConsumed: profile.totalTokenConsumed,
      rankingPercent: profile.usageRankingPercent,
      mostActiveDay: profile.mostActiveDay,
      updatedAt: profile.lastUpdateTime,
    }
  }

  /**
   * The plan the account holds, as the card reads it.
   *
   * It comes from the same membership answer as the balance, so it is free.
   */
  const buildPlanStatus = (): PlanStatus | undefined => {
    const held = credits.plan
    if (held === undefined) return undefined
    return { active: held.active, tier: held.tier, expiresAtMs: held.expiresAtMs }
  }

  /** The plan's rolling usage windows as the card reads them. */
  const buildRateLimitStatus = (): RateLimitStatus => {
    if (creditState === 'signed-out' || creditState === 'expired') {
      return { state: creditState }
    }
    const windows = credits.rateLimit
    if (windows === undefined) {
      return {
        state: 'unavailable',
        ...credits.rateLimitAbsence === undefined ? {} : { reason: credits.rateLimitAbsence },
        ...credits.rateLimitError === undefined ? {} : { error: credits.rateLimitError },
      }
    }
    return {
      state: 'ok',
      interval: windows.interval,
      weekly: windows.weekly,
      ...credits.rateLimitAtMs === undefined ? {} : { updatedAtMs: credits.rateLimitAtMs },
    }
  }

  /** What this host's own requests have used. */
  const buildUsageStatus = (): UsageStatus => {
    const totals = meter.totals()
    const last = meter.last
    return {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      reasoningTokens: totals.reasoningTokens,
      estimatedCny: meter.estimatedCny(),
      ...last?.cny === undefined ? {} : { lastCny: last.cny },
      ...last === undefined ? {} : { lastModel: last.model },
      requests: meter.records.length,
    }
  }

  /** The check-in cycle, as the card reads it. */
  const buildSigninStatus = (): SigninStatus | undefined => {
    if (signinPanel === undefined && signinError === undefined) return undefined
    const panel = signinPanel
    const today = panel?.days.find(day => day.isToday)
    return {
      state: panel === undefined ? 'unavailable' : 'ok',
      ...today === undefined
        ? {}
        : {
            today: {
              dayNo: today.dayNo,
              points: today.points,
              status: today.status,
              claimable: today.status === SIGNIN_DAY_STATUS.claimable,
              claimed: today.status === SIGNIN_DAY_STATUS.claimed,
            },
          },
      ...panel === undefined
        ? {}
        : {
            days: panel.days.map(day => ({
              dayNo: day.dayNo,
              points: day.points,
              status: day.status,
              isToday: day.isToday,
            })),
            cyclePoints: panel.days.reduce((sum, day) => sum + day.points, 0),
          },
      autoCheckin: pluginState.autoCheckin,
      ...pluginState.lastClaimDay === undefined ? {} : { lastClaimDay: pluginState.lastClaimDay },
      ...pluginState.lastClaimAtMs === undefined ? {} : { lastClaimAtMs: pluginState.lastClaimAtMs },
      ...pluginState.lastClaimPoints === undefined ? {} : { lastClaimPoints: pluginState.lastClaimPoints },
      ...signinClaim === undefined
        ? {}
        : { lastClaimResult: signinClaim.result, lastClaimPoints: signinClaim.points },
      ...signinError === undefined ? {} : { error: signinError },
    }
  }

  /** How the plugin is signed in, as the card reads it. */
  const buildLoginStatus = (): LoginStatus => {
    const session = pluginState.deviceLogin
    const pending = loginPending && session !== undefined
    return {
      state: pending ? 'pending' : loginSource === undefined ? 'signed-out' : 'signed-in',
      ...loginSource === undefined ? {} : { source: loginSource },
      ...pending && session !== undefined
        ? {
            userCode: session.userCode,
            verificationUri: session.verificationUri,
            verificationUriComplete: session.verificationUriComplete,
            expiresAtMs: session.expiresAtMs,
          }
        : {},
    }
  }

  const { adapter, invalidate } = createMinimaxCodeAdapter({
    catalog,
    region: () => region,
    resolveApiKey: async () => (await readNow())?.token,
    // The gateway needs `Authorization: Bearer`, which only the model
    // descriptor can carry; see `bearerToken` for why it reads synchronously.
    // The value is the one the last credential resolution produced, so a
    // sign-in that came from the plugin alone is carried as well.
    bearerToken: () => modelToken,
    // Image input: the catalog advertises `image` for models that take it, and
    // these two hooks are what lets pi-ai turn a durable attachment into the
    // request bytes that modality promises. Without them every image upload
    // fails as `UNSUPPORTED_CONTENT` before reaching the gateway.
    ...imageInputHooks(ctx),
    // Every response carries its own usage counters, so the consumption of
    // this host is measured rather than estimated.
    onUsage: (model, usage) => {
      meter.record(model, usage)
      // A finished request is the moment the balance moved, so it is also the
      // moment worth re-reading it.
      void refreshCredits()
    },
  })

  // No disposer is kept: `registerAdapter` releases its routes with the fiber
  // (LlmRuntime.registerAdapter: "Disposed with the fiber"). Calling the handle
  // here would run an async disposer that unload never awaits.
  ctx.llm.registerAdapter(['minimaxcode'], adapter)

  /**
   * The sign-in state the card reports.
   *
   * It describes the credential the gateway will actually be called with, not
   * a particular file on disk: the card exists to answer "will a request
   * work", and a token the server refused is not a sign-in however unexpired
   * it looks. Reading the legacy JWT alone is what made a machine whose model
   * gateway was working report a signed-out, expired card.
   */
  const buildAuthStatus = async (): Promise<StatusDeps['auth']> => {
    if (revokedByServer) return { state: 'signed-out', reason: 'credential-revoked' }
    const current = await readNow()
    if (current !== undefined) {
      const remaining = expiresInMs(current.claims)
      if (remaining <= 0) return { state: 'expired', reason: 'credential-expired' }
      return {
        state: 'signed-in',
        daysRemaining: Math.ceil(remaining / (24 * 60 * 60 * 1000)),
        expiry: expiryLevel(current.claims),
      }
    }
    const state = await readCredential()
    if (state.state === 'expired') return { state: 'expired' }
    if (state.state === 'signed-out') return { state: 'signed-out', reason: state.reason }
    return { state: 'signed-in' }
  }

  /** Build the document the card renders, without ever exposing the token. */
  const buildStatus = async () => {
    // The balance and the cycle are read on demand: a card that is never
    // opened costs the account API nothing. They come first because a
    // credential the server refuses is repaired, or dropped, while they run —
    // and the sign-in state below has to describe what is left afterwards.
    await refreshCredits()
    await refreshSignin()
    return statusDocument({
      auth: await buildAuthStatus(),
      region,
      catalogSource: catalog.source,
      catalogError: catalog.error,
      models: catalog.current().map(({ id, name: modelName, contextWindow }) => ({ id, name: modelName, contextWindow })),
      refreshing,
      credits: buildCreditStatus(),
      rateLimit: buildRateLimitStatus(),
      usage: buildUsageStatus(),
      signin: buildSigninStatus(),
      login: buildLoginStatus(),
      usageProfile: buildUsageProfileStatus(),
      plan: buildPlanStatus(),
      capability,
      generation: {
        imageModels: [...IMAGE_MODELS],
        imageAspectRatios: [...IMAGE_ASPECT_RATIOS],
        imageAreas: [...IMAGE_AREAS],
        videoDurations: [...VIDEO_DURATIONS],
        videoResolutions: [...VIDEO_RESOLUTIONS],
        videoRatios: [...VIDEO_RATIOS],
      },
    })
  }

  // Prime the catalog once at start so the picker is not empty on first open.
  void (async () => {
    const current = await readNow()
    if (current !== undefined) {
      region = pickRegion(undefined)
      await refreshCatalog(current)
      invalidate()
    }
  })()

  /**
   * The actions the card can ask for.
   *
   * Every one of them is a request the person made by clicking something, so
   * they are all safe to repeat: a claim that was already made upstream
   * answers "already claimed", and a sign-in that is already waiting answers
   * with the same device code.
   */
  const runAction = async (action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (action) {
      case 'claim': {
        const state = await resolveAccountCredential()
        if (state.state !== 'signed-in') {
          return { ok: false, state: state.state, error: '尚未登录' }
        }
        const claim = await performClaim(state.credential)
        return claim === undefined
          ? { ok: false, error: signinError ?? '签到失败' }
          : { ok: true, claim, panel: signinPanel }
      }
      case 'login-start': {
        const session = await startDeviceLogin(region)
        if (session === undefined) {
          return { ok: false, error: '没有拿到设备码' }
        }
        pluginState = { ...pluginState, deviceLogin: session }
        await writePluginState(pluginState)
        loginPending = true
        return {
          ok: true,
          userCode: session.userCode,
          verificationUri: session.verificationUri,
          verificationUriComplete: session.verificationUriComplete,
          expiresAtMs: session.expiresAtMs,
        }
      }
      case 'login-poll': {
        const session = pluginState.deviceLogin
        if (session === undefined) {
          return { ok: false, state: 'signed-out', error: '没有待完成的登录' }
        }
        const result = await pollDeviceLogin(session, region)
        if (result.state === 'signed-in') {
          await writePluginCredential(result.credential)
          pluginState = { ...pluginState, deviceLogin: undefined }
          await writePluginState(pluginState)
          loginPending = false
          revokedByServer = false
          loginSource = 'plugin'
          modelToken = result.credential.accessToken
          // A fresh sign-in changes what the models and the balance are, so
          // both are worth reading again.
          catalog.invalidate()
          lastCatalogAtMs = 0
          lastCreditAtMs = 0
          void readNow()
          return { ok: true, state: 'signed-in' }
        }
        if (result.state === 'expired' || result.state === 'denied') {
          pluginState = { ...pluginState, deviceLogin: undefined }
          await writePluginState(pluginState)
          loginPending = false
          return { ok: false, state: result.state, error: result.message }
        }
        return { ok: true, state: result.state }
      }
      case 'settings': {
        const autoCheckin = body.autoCheckin
        if (typeof autoCheckin !== 'boolean') {
          return { ok: false, error: 'autoCheckin 必须是布尔值' }
        }
        pluginState = { ...pluginState, autoCheckin }
        await writePluginState(pluginState)
        // Turning the claim on is only useful if the cycle is read, and the
        // claim itself happens on the next read.
        if (autoCheckin) void refreshSignin()
        return { ok: true, autoCheckin }
      }
      default:
        return { ok: false, error: `未知操作: ${action}` }
    }
  }

  /**
   * The plan's own API key, remembered for the session.
   *
   * The generation endpoints want the open platform's key rather than the
   * desktop app's OAuth bearer, and the key belongs to the account: the
   * credit endpoint hands it out to the OAuth credential the plugin already
   * holds. It is fetched once and kept for as long as the plugin runs.
   */
  let planApiKey: string | undefined
  const resolvePlanApiKey = async (): Promise<string> => {
    if (planApiKey !== undefined) return planApiKey
    const account = await resolveAccountCredential()
    if (account.state !== 'signed-in') {
      throw new GenerationError('尚未登录 MiniMax Code')
    }
    const key = await fetchPlanApiKey(account.credential, region)
    if (key === undefined) {
      throw new GenerationError('账户没有开放平台密钥，无法调用生成接口')
    }
    planApiKey = key
    return key
  }

  /**
   * Commit a generated picture to the host's attachment store.
   *
   * The store is read per request: the host may provide it after this plugin
   * loads, and a host without one must still show the picture. The media type
   * is narrowed to the four the store accepts, because it checks the declared
   * type against the decoded bytes.
   *
   * @returns The durable reference, when the picture was stored.
   */
  const saveGeneratedImage = async (
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const store = ctx.get('attachments')
    if (store === undefined) return undefined
    const type = mediaType === 'image/png' || mediaType === 'image/webp' || mediaType === 'image/gif'
      ? mediaType
      : 'image/jpeg'
    try {
      const ref = await store.saveImage({ data: bytes, mediaType: type, name: 'minimax-h3-image' })
      return { attachmentId: ref.attachmentId, width: ref.width, height: ref.height, bytes: ref.bytes }
    } catch {
      // A store that refuses the picture must not fail the generation: the
      // inline copy is still shown.
      return undefined
    }
  }

  /**
   * Make a picture or start a video.
   *
   * A picture comes back at once, as bytes: the upstream's link is good for
   * a day, and a link that expires would leave the picture behind. A video
   * is a task that takes a minute and a half, so this answers with the task's
   * identifier and the card polls for the result.
   */
  const runGeneration = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const kind = body.kind
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt.length === 0) return { ok: false, error: '请填写提示词' }
    const apiKey = await resolvePlanApiKey()
    if (kind === 'video') {
      const taskId = await startVideoTask({
        apiKey,
        region,
        prompt,
        duration: typeof body.duration === 'number' ? body.duration : undefined,
        resolution: typeof body.resolution === 'string' ? body.resolution : undefined,
        ratio: typeof body.ratio === 'string' ? body.ratio : undefined,
        firstFrameUrl: typeof body.firstFrameUrl === 'string' ? body.firstFrameUrl : undefined,
        lastFrameUrl: typeof body.lastFrameUrl === 'string' ? body.lastFrameUrl : undefined,
      })
      return { ok: true, kind: 'video', taskId }
    }
    const result = await generateImages({
      apiKey,
      region,
      prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      aspectRatio: typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
      area: typeof body.area === 'string' ? body.area : undefined,
      count: typeof body.count === 'number' ? body.count : undefined,
    })
    const first = result.images[0]
    if (first === undefined) return { ok: false, error: '上游没有返回图片' }
    if (first.bytes === undefined && first.url === undefined) {
      return { ok: false, error: '上游没有返回图片' }
    }
    // The bytes come back inline, so the picture survives the upstream's
    // link expiring a day later.
    const image = first.bytes !== undefined
      ? { bytes: first.bytes, mediaType: first.mediaType ?? 'image/jpeg' }
      : await downloadImage(first.url!)
    // The picture is also committed to the host's own attachment store, so it
    // lives in DSH's storage rather than only in this browser tab. A host
    // without an attachment service simply keeps the inline copy.
    const saved = await saveGeneratedImage(image.bytes, image.mediaType)
    return {
      ok: true,
      kind: 'image',
      size: first.size,
      revisedPrompt: first.revisedPrompt,
      totalTokens: result.totalTokens,
      requestId: result.requestId,
      mediaType: image.mediaType,
      dataUrl: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`,
      ...saved === undefined ? {} : { attachment: saved },
    }
  }

  /** Read a video task's state. */
  const readVideoTask = async (taskId: string): Promise<Record<string, unknown>> => {
    const apiKey = await resolvePlanApiKey()
    const task = await queryVideoTask({ apiKey, region, taskId })
    return {
      ok: true,
      kind: 'video',
      taskId: task.taskId,
      status: task.status,
      url: task.url,
    }
  }

  // Mount the card's status route when the host offers a web server.
  //
  // The service is `webServer` (a WebServer with `register`), not a `webserver`
  // with `get('router')`: reading an undeclared service through the Cordis
  // context proxy throws "cannot get property ... without inject", and an
  // exception escaping apply() is a fatal load failure for the whole host. The
  // injection callback waits for the service instead of touching it eagerly.
  ctx.inject(['webServer'], (webCtx: Context & { webServer: WebServer }) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: MINIMAX_STATUS_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'loopback only' }))
          return
        }
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(await buildStatus()))
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }))

    // The route that acts rather than reports.
    //
    // It is POST and loopback-only: a claim changes the account, a sign-in
    // hands out a token, and a setting changes how the plugin behaves. A page
    // that is not the host's own loopback must not be able to trigger any of
    // them.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: MINIMAX_ACTION_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'loopback only' }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'POST only' }))
          return
        }
        let action = ''
        let body: Record<string, unknown> = {}
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          action = url.searchParams.get('action') ?? ''
          const text = await readRequestBody(req as unknown as AsyncIterable<Buffer>)
          if (text.length > 0) {
            const parsed = JSON.parse(text) as unknown
            if (typeof parsed === 'object' && parsed !== null) {
              body = parsed as Record<string, unknown>
            }
          }
        } catch {
          // An unreadable body simply means no settings in it.
        }
        try {
          const result = await runAction(action, body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }))

    // The route the card reports what the host offers it on.
    //
    // It is a GET and loopback-only, and it records rather than acts: the
    // answer tells the card — and whoever reads the status document next —
    // which piece of the host is missing when a picture cannot be delivered.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: MINIMAX_CAPABILITY_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'loopback only' }))
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const raw = url.searchParams.get('report') ?? ''
          let findings: Record<string, string> = {}
          try {
            const parsed = JSON.parse(raw) as unknown
            if (typeof parsed === 'object' && parsed !== null) {
              for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                findings[key] = String(value)
              }
            }
          } catch {
            // An unreadable report is still worth recording: it says the card
            // looked, and could not describe what it saw.
            findings = { report: 'unreadable' }
          }
          capability = { at: Date.now(), findings }
          res.writeHead(204)
          res.end()
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }))

    // The route that makes a picture or a video.
    //
    // It is POST and loopback-only, like the action route, and it spends the
    // account's own allowance — so it must not be reachable from a page that
    // is not the host's own. GET reads a video task's state, which spends
    // nothing; POST starts one.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: MINIMAX_GENERATE_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'loopback only' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        try {
          if (req.method === 'GET') {
            const taskId = url.searchParams.get('taskId') ?? ''
            if (taskId.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: '缺少 taskId' }))
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(await readVideoTask(taskId)))
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'POST only' }))
            return
          }
          let body: Record<string, unknown> = {}
          try {
            const text = await readRequestBody(req as unknown as AsyncIterable<Buffer>)
            if (text.length > 0) {
              const parsed = JSON.parse(text) as unknown
              if (typeof parsed === 'object' && parsed !== null) {
                body = parsed as Record<string, unknown>
              }
            }
          } catch {
            // An unreadable body simply means no prompt in it.
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(await runGeneration(body)))
        } catch (error) {
          // A refusal from the upstream is the caller's answer, not a
          // failure of the plugin: the reason is what the person needs.
          const status = error instanceof GenerationError ? 400 : 500
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof GenerationError && error.code !== undefined ? { code: error.code } : {}),
          }))
        }
      },
    }))
  })
}

/** Read a request body, up to a size that no card needs to exceed. */
async function readRequestBody(req: AsyncIterable<Buffer | string>): Promise<string> {
  let text = ''
  for await (const chunk of req) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // A card never sends more than a few bytes; anything larger is a mistake
    // or an attack, and either way it is not read.
    if (text.length > 64 * 1024) break
  }
  return text
}

export { apply }