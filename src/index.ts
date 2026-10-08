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
import {
  expiresInMs,
  expiryLevel,
  MINIMAX_REGIONS,
  readCredential,
  type Credential,
  type MinimaxRegion,
} from './auth.ts'
import { MinimaxCatalog } from './catalog.ts'
import { createMinimaxCodeAdapter } from './adapter.ts'
import { MINIMAX_STATUS_PATH, isLoopback, statusDocument } from './status-route.ts'

export { MINIMAXCODE_PROVIDER_ID, MinimaxCatalog, parseCatalog, FALLBACK_MODELS } from './catalog.ts'
export type { CatalogModel, CatalogSource } from './catalog.ts'
export {
  MINIMAX_AUTH_FILENAME,
  MINIMAX_DATA_DIR,
  MINIMAX_GATEWAYS,
  MINIMAX_REGIONS,
  authPath,
  chatBaseUrl,
  catalogUrl,
  dataDir,
  daysRemaining,
  decodeClaims,
  expiresInMs,
  expiryLevel,
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
  let region: MinimaxRegion = 'cn'
  let credential: Credential | undefined
  let lastCatalogAtMs = 0
  let refreshing = false

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

  const { adapter, invalidate } = createMinimaxCodeAdapter({
    catalog,
    region: () => region,
    resolveApiKey: async () => (await readNow())?.token,
  })

  const releaseAdapter = ctx.llm.registerAdapter(['minimaxcode'], adapter)

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
    return statusDocument({
      auth,
      region,
      catalogSource: catalog.source,
      catalogError: catalog.error,
      models: catalog.current().map(({ id, name: modelName, contextWindow }) => ({ id, name: modelName, contextWindow })),
      refreshing,
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
  const mountStatus = async () => {
    const webserver = (ctx as unknown as { webserver?: { get?: (n: string) => unknown } }).webserver
    const router = webserver?.get?.('router')
    if (router === undefined) return
    try {
      (router as {
        get: (path: string, handler: (req: { headers: Record<string, string> }, res: (status: number, body: string) => void) => void) => void
      }).get(MINIMAX_STATUS_PATH, async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          res(403, JSON.stringify({ error: 'loopback only' }))
          return
        }
        try {
          res(200, JSON.stringify(await buildStatus()))
        } catch (error) {
          res(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })
    } catch {
      // A host without a matching router simply has no card; the models still work.
    }
  }
  void mountStatus()

  return async () => {
    releaseAdapter()
  }
}

export { apply }