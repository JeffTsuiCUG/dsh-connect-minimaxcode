/**
 * The MiniMax model catalog, read live from the desktop app's own endpoint.
 *
 * `GET /mavis/api/v1/models` returns every provider with per-model capability
 * declarations — context limits, tool-call support, reasoning, modalities —
 * behind a short TTL. The plugin fetches it rather than hardcoding a list, so a
 * model added upstream appears without a plugin release, and a model retired
 * upstream disappears on its own.
 *
 * @module dsh-connect-minimaxcode/catalog
 */

import { catalogUrl, type Credential, type MinimaxRegion } from './auth.ts'

/** One model as the upstream describes it. */
export interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens?: number
  /** Whether the model accepts tool definitions and emits `tool_use`. */
  toolCall: boolean
  /** Whether the model emits reasoning blocks. */
  reasoning: boolean
  /** Input modalities, e.g. `text`, `image`, `video`. */
  inputModalities: string[]
  /** Whether the model accepts images at all. */
  attachment: boolean
}

/** The provider block this plugin serves. */
export const MINIMAX_PROVIDER_ID = 'minimax'

/** Provider id registered with DSH, distinct from the upstream one. */
export const MINIMAXCODE_PROVIDER_ID = 'minimaxcode'

/**
 * Used when the catalog cannot be fetched, so the picker still offers the
 * models the desktop app is known to ship.
 *
 * Deliberately small and conservative: a fallback entry overstates nothing we
 * could not confirm.
 */
export const FALLBACK_MODELS: readonly CatalogModel[] = [
  {
    id: 'MiniMax-M2.7',
    name: 'M2.7',
    contextWindow: 200000,
    maxOutputTokens: 128000,
    toolCall: true,
    reasoning: true,
    inputModalities: ['text'],
    attachment: false,
  },
  {
    id: 'MiniMax-M3',
    name: 'M3',
    contextWindow: 512000,
    maxOutputTokens: 128000,
    toolCall: true,
    reasoning: true,
    inputModalities: ['text', 'image', 'video'],
    attachment: true,
  },
]

/** Where the currently served list came from. */
export type CatalogSource = 'live' | 'fallback'

/** A parsed catalog plus the fact of where it came from. */
export interface CatalogSnapshot {
  models: CatalogModel[]
  source: CatalogSource
  fetchedAtMs?: number
  /** Set when a live fetch failed and the fallback is being served. */
  error?: string
}

/** Model with the same id, from a newer snapshot. */
function sameCatalog(a: readonly CatalogModel[], b: readonly CatalogModel[]): boolean {
  if (a.length !== b.length) return false
  return a.every((model, index) => {
    const other = b[index]!
    return (
      model.id === other.id
      && model.contextWindow === other.contextWindow
      && model.toolCall === other.toolCall
      && model.reasoning === other.reasoning
      && model.attachment === other.attachment
    )
  })
}

/** Keep only models whose id the upstream keys them by. */
function usable(id: string, raw: Record<string, unknown>): boolean {
  return id.length > 0 && id.startsWith('MiniMax-') && typeof raw === 'object' && raw !== null
}

/** Read the fields the upstream sends, tolerating their absence. */
function readModel(id: string, raw: Record<string, unknown>): CatalogModel {
  const limit = (raw.limit ?? {}) as Record<string, unknown>
  const modalities = (raw.modalities ?? {}) as Record<string, unknown>
  const input = Array.isArray(modalities.input) ? modalities.input.filter((m): m is string => typeof m === 'string') : ['text']
  const contextWindow = typeof limit.context === 'number' ? limit.context : 200000
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    contextWindow,
    maxOutputTokens: typeof limit.output === 'number' ? limit.output : undefined,
    toolCall: raw.tool_call === true,
    reasoning: raw.reasoning === true,
    inputModalities: input,
    attachment: raw.attachment === true || input.includes('image'),
  }
}

/**
 * Parse the upstream catalog document.
 *
 * Unknown providers are ignored rather than rejected: the endpoint serves every
 * provider the desktop app is configured for, and only MiniMax models belong in
 * this plugin's picker.
 *
 * @param document - Decoded response body.
 * @returns Models in upstream order, or an empty list when none qualify.
 */
export function parseCatalog(document: unknown): CatalogModel[] {
  if (typeof document !== 'object' || document === null) return []
  const providers = (document as Record<string, unknown>).providers
  if (!Array.isArray(providers)) return []
  const models: CatalogModel[] = []
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null) continue
    const provider = entry as Record<string, unknown>
    if (provider.providerId !== MINIMAX_PROVIDER_ID) continue
    const config = (provider.config ?? {}) as Record<string, unknown>
    const declared = config.models
    if (typeof declared !== 'object' || declared === null) continue
    for (const [id, raw] of Object.entries(declared as Record<string, unknown>)) {
      if (!usable(id, raw as Record<string, unknown>)) continue
      models.push(readModel(id, raw as Record<string, unknown>))
    }
  }
  return models
}

/**
 * Holds the catalog and answers the picker's questions about it.
 *
 * Refreshes are explicit: the plugin refreshes at startup and on demand, and
 * keeps serving the last good snapshot while a refresh is in flight, so a
 * network blip never empties the model list.
 */
export class MinimaxCatalog {
  #snapshot: CatalogSnapshot = { models: [...FALLBACK_MODELS], source: 'fallback' }
  #inflight: Promise<void> | undefined
  #lastIdentity: string | undefined

  /** The models to serve right now. */
  current(): CatalogModel[] {
    return this.#snapshot.models
  }

  /** Provenance of {@link current}. */
  get source(): CatalogSource {
    return this.#snapshot.source
  }

  /** When {@link current} was fetched, when it came from upstream. */
  get fetchedAtMs(): number | undefined {
    return this.#snapshot.fetchedAtMs
  }

  /** Why the last refresh failed, if one did. */
  get error(): string | undefined {
    return this.#snapshot.error
  }

  /**
   * Replace the served list, adopting upstream's own ordering.
   *
   * @returns Whether anything changed, so callers can skip a needless reload.
   */
  set(models: readonly CatalogModel[], source: CatalogSource, fetchedAtMs?: number): boolean {
    if (source === this.#snapshot.source && sameCatalog(this.#snapshot.models, models)) {
      if (source === 'live') this.#snapshot.fetchedAtMs = fetchedAtMs ?? this.#snapshot.fetchedAtMs
      return false
    }
    this.#snapshot = { models: [...models], source, fetchedAtMs, error: undefined }
    return true
  }

  /** Drop back to the built-in list, e.g. when the account signs out. */
  invalidate(): void {
    this.#snapshot = { models: [...FALLBACK_MODELS], source: 'fallback' }
  }

  /**
   * Fetch the live catalog for a credential.
   *
   * Serialised through a single in-flight promise: a second caller joins the
   * first run rather than starting a duplicate request.
   *
   * @returns Whether the served list changed.
   */
  async refresh(region: MinimaxRegion, credential: Credential, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const identity = credential.claims.userId ?? credential.claims.exp.toString()
    if (this.#inflight !== undefined) {
      await this.#inflight
      return false
    }
    this.#lastIdentity = identity
    this.#inflight = (async () => {
      try {
        const response = await fetchImpl(catalogUrl(region), {
          headers: { authorization: `Bearer ${credential.token}` },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const models = parseCatalog(await response.json())
        if (models.length === 0) throw new Error('catalog contained no MiniMax models')
        this.set(models, 'live', Date.now())
      } catch (error) {
        // Keep serving whatever we had; only record why the refresh failed.
        this.#snapshot.error = error instanceof Error ? error.message : String(error)
        if (this.#snapshot.source !== 'live') this.set(FALLBACK_MODELS, 'fallback')
      }
    })()
    try {
      await this.#inflight
    } finally {
      this.#inflight = undefined
    }
    return true
  }

  /** Identity the served catalog belongs to, if any. */
  get identity(): string | undefined {
    return this.#lastIdentity
  }
}