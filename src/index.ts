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
import { MINIMAX_ACTION_PATH, MINIMAX_STATUS_PATH, isLoopback, statusDocument, type CreditStatus, type UsageStatus, type SigninStatus, type LoginStatus } from './status-route.ts'
import { MinimaxCredits, ensureOAuthCredential, type OAuthCredential, type OAuthState } from './credits.ts'
import {
  credentialNeedsRefresh,
  readPluginCredential,
  readPluginState,
  toOAuthCredential,
  writePluginCredential,
  writePluginState,
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
  parseCreditSummary,
  parseOAuthDocument,
  readOAuthCredential,
  refreshOAuthCredential,
  writeOAuthCredential,
  MEMBERSHIP_PATH,
  MINIMAX_OAUTH_CLIENT_ID,
  type CreditSummary,
  type OAuthCredential,
  type OAuthState,
} from './credits.ts'
export { EMPTY_USAGE, MODEL_PRICES, UsageMeter, estimateCny, priceFor, type ModelUsage } from './usage.ts'
export {
  PLUGIN_CREDENTIAL_FILENAME,
  PLUGIN_STATE_FILENAME,
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

  /**
   * The credential the model gateway is called with.
   *
   * The plugin's own sign-in comes first: it is the credential the person
   * chose, and on a machine where the desktop app was never installed it is
   * the only one there is. The desktop app's token is the fallback, and the
   * two are interchangeable as far as the gateway is concerned — it accepts
   * either bearer.
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
          return { token: next.accessToken, claims: { exp: Math.floor((next.expiresAtMs ?? Date.now()) / 1000) } }
        } catch {
          // A refresh that fails is not fatal: the desktop app may still hold
          // a working token.
        }
      } else {
        loginSource = 'plugin'
        modelToken = own.accessToken
        return { token: own.accessToken, claims: { exp: Math.floor((own.expiresAtMs ?? Date.now()) / 1000) } }
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
        } catch {
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
      signinError = error instanceof Error ? error.message : String(error)
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
      signinError = error instanceof Error ? error.message : String(error)
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

  /** Build the document the card renders, without ever exposing the token. */
  const buildStatus = async () => {
    const state = await readCredential()
    const auth = state.state === 'signed-in'
      ? {
          state: 'signed-in' as const,
          daysRemaining: Math.ceil(expiresInMs(state.credential.claims) / (24 * 60 * 60 * 1000)),
          expiry: expiryLevel(state.credential.claims),
        }
      : state.state === 'expired'
        ? { state: 'expired' as const }
        : { state: 'signed-out' as const, reason: state.reason }
    // The balance is read on demand: a card that is never opened costs the
    // account API nothing.
    await refreshCredits()
    await refreshSignin()
    return statusDocument({
      auth,
      region,
      catalogSource: catalog.source,
      catalogError: catalog.error,
      models: catalog.current().map(({ id, name: modelName, contextWindow }) => ({ id, name: modelName, contextWindow })),
      refreshing,
      credits: buildCreditStatus(),
      usage: buildUsageStatus(),
      signin: buildSigninStatus(),
      login: buildLoginStatus(),
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