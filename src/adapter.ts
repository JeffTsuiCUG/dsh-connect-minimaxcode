/**
 * Registering MiniMax Code's models as a DSH provider.
 *
 * The upstream endpoint is a standard Anthropic Messages API, so this plugin
 * reuses the shared pi-ai adapter rather than implementing a transport: the
 * work here is deciding *which* models to publish, pointing them at the right
 * base URL, and keeping that in step with the live catalog.
 *
 * @module dsh-connect-minimaxcode/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Model, Provider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { MinimaxCatalog, CatalogModel } from './catalog.ts'
import { MINIMAXCODE_PROVIDER_ID } from './catalog.ts'
import { chatBaseUrl, type Credential, type MinimaxRegion, INERT_AUTH } from './auth.ts'

/** How long a silent stream may last before the transport gives up. */
export const MINIMAX_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Adapter-owned defaults a resolved route must carry.
 *
 * `PiAiAdapterOptions.profiles` wants a *resolved* route, so the image bounds
 * below are the schema's own defaults (20MiB base64 payload, 2048px pixel
 * budget, 1MiB per inline version). The retry policy is resolved by the
 * library's public helper rather than hand-written. Both were previously hidden
 * behind a cast, which is also what hid the missing required `auth` option.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
} as const

/** Unknown price, stated as zero rather than invented. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Translate one catalog entry into the descriptor pi-ai expects.
 *
 * Capabilities come from upstream rather than being assumed, so a model that
 * loses tool support upstream stops advertising it here. `video` is dropped from
 * the declared input modalities because pi-ai models images, not video.
 */
function toPiModel(model: CatalogModel, baseUrl: string): Model<'anthropic-messages'> {
  const input = model.inputModalities.includes('image') ? (['text', 'image'] as const) : (['text'] as const)
  return {
    id: model.id,
    name: model.name,
    api: 'anthropic-messages',
    provider: MINIMAXCODE_PROVIDER_ID,
    baseUrl,
    reasoning: model.reasoning,
    input: [...input],
    cost: { ...NO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens ?? 128000,
  }
}

/** Options for building the provider. */
export interface AdapterOptions {
  catalog: MinimaxCatalog
  /** Region whose gateway the models are served from. */
  region: () => MinimaxRegion
  /** Live token, read fresh per call so a re-login takes effect at once. */
  resolveApiKey: () => Promise<string | undefined>
}

/** What {@link createMinimaxCodeAdapter} hands back. */
export interface AdapterBundle {
  adapter: PiAiAdapter
  /** Drop cached profiles so the next pick rebuilds them. */
  invalidate: () => void
}

/**
 * Build the DSH adapter that serves the catalog.
 *
 * The model list is rebuilt on demand rather than snapshotted, which is what
 * lets a refresh upstream appear without restarting the host.
 *
 * @param options - Catalog, region and token resolution.
 * @returns The adapter plus a way to drop its cached profiles.
 */
export function createMinimaxCodeAdapter(options: AdapterOptions): AdapterBundle {
  const { catalog } = options
  const buildModels = () => catalog.current().map((model) => toPiModel(model, chatBaseUrl(options.region())))
  const provider: Provider = { ...createProvider({
      id: MINIMAXCODE_PROVIDER_ID,
      name: 'MiniMax Code',
      auth: {
        apiKey: {
          name: 'MiniMax Code access token',
          async resolve({ credential }: { credential?: { key?: string } }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: 'MiniMax Code' }
          },
        },
      },
      models: buildModels(),
      api: anthropicMessagesApi(),
    }),
    // Delegated to a live read: stream dispatch still runs through the
    // constructed provider while the catalog answer tracks the upstream refresh.
    getModels: () => buildModels(),
  }
  /**
   * Build a fresh route map for the catalog and region of this moment.
   *
   * `getModels` already reads the live catalog on every call, so the model list
   * needs no invalidation; what a refresh does invalidate is the per-model state
   * carried by the route — configured maxTokens and recorded model errors, which
   * would otherwise outlive a catalog or region change.
   */
  const buildProfiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    const route: ResolvedPiAiProviderProfile = {
      provider: MINIMAXCODE_PROVIDER_ID,
      displayName: 'MiniMax Code',
      streamIdleTimeoutMs: MINIMAX_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-minimaxcode retryPolicy'),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: provider,
    }
    return new Map([[MINIMAXCODE_PROVIDER_ID, route]])
  }
  let profiles = buildProfiles()
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: options.resolveApiKey,
      auth: INERT_AUTH,
    }),
    invalidate: () => {
      profiles = buildProfiles()
    },
  }
}

/** The endpoint the models are pointed at, for the status card and logs. */
export function endpointFor(region: MinimaxRegion): string {
  return chatBaseUrl(region)
}

/** Re-exported so callers share one notion of the credential shape. */
export type { Credential }