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
import { MINIMAX_STATUS_PATH, isLoopback, statusDocument, type CreditStatus, type UsageStatus } from './status-route.ts'
import { MinimaxCredits, ensureOAuthCredential } from './credits.ts'
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
export { MINIMAX_STATUS_PATH, statusDocument } from './status-route.ts'
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
  let refreshing = false
  let creditState: 'ok' | 'unavailable' | 'expired' | 'signed-out' = 'unavailable'

  const readNow = async (): Promise<Credential | undefined> => {
    const state = await readCredential()
    if (state.state !== 'signed-in') {
      credential = undefined
      catalog.invalidate()
      return undefined
    }
    credential = state.credential
    return credential
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
    const state = await ensureOAuthCredential(region, process.env, now)
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

  const { adapter, invalidate } = createMinimaxCodeAdapter({
    catalog,
    region: () => region,
    resolveApiKey: async () => (await readNow())?.token,
    // The gateway needs `Authorization: Bearer`, which only the model
    // descriptor can carry; see `bearerToken` for why it reads synchronously.
    bearerToken: () => bearerToken(),
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
    return statusDocument({
      auth,
      region,
      catalogSource: catalog.source,
      catalogError: catalog.error,
      models: catalog.current().map(({ id, name: modelName, contextWindow }) => ({ id, name: modelName, contextWindow })),
      refreshing,
      credits: buildCreditStatus(),
      usage: buildUsageStatus(),
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
  })
}

export { apply }