/**
 * What the adapter publishes, and what `invalidate()` actually guarantees.
 *
 * The model list is served by `getModels`, a closure over the live catalog, so
 * it is fresh on every call and needs no invalidation. What *does* carry state
 * is the profile: `configuredMaxTokens` and `modelErrors` accumulate as the
 * host configures and runs models, and a catalog or region change must not
 * leave that stale state attached. These tests pin both halves so the two
 * responsibilities cannot be confused again.
 *
 * `PiAiAdapter` keeps no public accessor for its `profiles` callback, so the
 * constructor is mocked to capture it — that callback is exactly the map the
 * adapter resolves per operation, and capturing it leaves production untouched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MinimaxCatalog, CatalogModel } from '../src/catalog.ts'
import type { Credential } from '../src/auth.ts'

/** The captured `profiles` callback of the most recent PiAiAdapter build. */
let lastProfiles: (() => ReadonlyMap<string, unknown>) | undefined

vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({
  PiAiAdapter: class {
    constructor(options: { profiles: () => ReadonlyMap<string, unknown> }) {
      lastProfiles = options.profiles
    }
  },
}))

const { createMinimaxCodeAdapter } = await import('../src/adapter.ts')

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200000,
    maxOutputTokens: 128000,
    toolCall: true,
    reasoning: true,
    inputModalities: ['text'],
    attachment: false,
  }
}

/** A catalog stub whose contents the test swaps between calls. */
function fakeCatalog(models: CatalogModel[]): MinimaxCatalog {
  return {
    source: 'live',
    error: undefined,
    current: () => models,
    invalidate: vi.fn(),
  } as unknown as MinimaxCatalog
}

const credential: Credential = { token: 'test-token', claims: { exp: Math.floor(Date.now() / 1000) + 3600 } }

/** Bearer values the adapter asked for, newest last. */
let bearerReads: (string | undefined)[] = []

function build(catalog: MinimaxCatalog, bearer: () => string | undefined = () => credential.token) {
  lastProfiles = undefined
  bearerReads = []
  return createMinimaxCodeAdapter({
    catalog,
    region: () => 'cn',
    resolveApiKey: async () => credential.token,
    bearerToken: () => {
      const token = bearer()
      bearerReads.push(token)
      return token
    },
  })
}

/** The profile the adapter resolves right now. */
function profile(): { piProvider?: { getModels?: () => { id: string; headers?: Record<string, string> }[] }; configuredMaxTokens?: Map<string, number>; modelErrors?: Map<string, Error> } {
  expect(lastProfiles, 'PiAiAdapter was never constructed').toBeDefined()
  return [...lastProfiles!().values()][0] as never
}

function publishedIds(): string[] {
  return (profile().piProvider?.getModels?.() ?? []).map(m => m.id)
}

/** Descriptors as pi-ai receives them, including any headers. */
function publishedModels(): { id: string; headers?: Record<string, string> }[] {
  return profile().piProvider?.getModels?.() ?? []
}

describe('adapter model publication', () => {
  beforeEach(() => {
    lastProfiles = undefined
  })

  it('publishes the catalog as it stands', () => {
    build(fakeCatalog([model('M-A')]))
    expect(publishedIds()).toEqual(['M-A'])
  })

  it('serves the live catalog without any invalidation', () => {
    const models = [model('M-A')]
    build(fakeCatalog(models))
    expect(publishedIds()).toEqual(['M-A'])

    // A refresh landing upstream is visible at once: getModels is a closure
    // over the catalog, not a snapshot taken at construction.
    models.push(model('M-B'))
    expect(publishedIds()).toEqual(['M-A', 'M-B'])
  })

  it('reflects a model retired upstream', () => {
    const models = [model('M-A'), model('M-B')]
    build(fakeCatalog(models))
    expect(publishedIds()).toEqual(['M-A', 'M-B'])
    models.length = 0
    models.push(model('M-C'))
    expect(publishedIds()).toEqual(['M-C'])
  })
})

describe('invalidate()', () => {
  beforeEach(() => {
    lastProfiles = undefined
  })

  it('keeps the published model list stable when nothing changed', () => {
    const { invalidate } = build(fakeCatalog([model('M-A')]))
    invalidate()
    invalidate()
    expect(publishedIds()).toEqual(['M-A'])
  })

  it('discards the configured maxTokens cached on the profile', () => {
    const { invalidate } = build(fakeCatalog([model('M-A')]))
    profile().configuredMaxTokens!.set('M-A', 4096)
    expect(profile().configuredMaxTokens!.size).toBe(1)

    invalidate()

    // A region or catalog change must not carry the old ceiling forward.
    expect(profile().configuredMaxTokens!.size).toBe(0)
  })

  it('discards model errors recorded against the previous catalog', () => {
    const { invalidate } = build(fakeCatalog([model('M-A')]))
    profile().modelErrors!.set('M-A', new Error('upstream 503'))
    expect(profile().modelErrors!.size).toBe(1)

    invalidate()

    expect(profile().modelErrors!.size).toBe(0)
  })

  it('replaces the profile rather than mutating it in place', () => {
    const { invalidate } = build(fakeCatalog([model('M-A')]))
    const before = profile()
    invalidate()
    const after = profile()
    expect(after).not.toBe(before)
    expect(after.configuredMaxTokens).not.toBe(before.configuredMaxTokens)
    expect(after.modelErrors).not.toBe(before.modelErrors)
  })

  it('keeps one profile, for the one provider route', () => {
    const { invalidate } = build(fakeCatalog([model('M-A')]))
    invalidate()
    expect(lastProfiles!().size).toBe(1)
    expect([...lastProfiles!().keys()]).toEqual(['minimaxcode'])
  })
})

describe('the Authorization header models carry', () => {
  beforeEach(() => {
    lastProfiles = undefined
  })

  /**
   * pi-ai's anthropic client sends the resolved apiKey as `x-api-key`, and
   * MiniMax's gateway answers 401 `{"code":401,"message":"token is required"}`
   * for that header alone. It accepts both headers, so every model descriptor
   * must carry the bearer value as well — measured against the live gateway,
   * not inferred.
   */
  it('is set on every published model when a token exists', () => {
    build(fakeCatalog([model('M-A'), model('M-B')]))
    const headers = publishedModels().map(m => m.headers?.authorization)
    expect(headers).toEqual(['Bearer test-token', 'Bearer test-token'])
  })

  it('is absent rather than empty when there is no token', () => {
    build(fakeCatalog([model('M-A')]), () => undefined)
    expect(publishedModels()[0]?.headers).toBeUndefined()
  })

  it('is read fresh on every getModels call, so a re-login needs no restart', () => {
    let token: string | undefined = 'first-token'
    build(fakeCatalog([model('M-A')]), () => token)

    expect(publishedModels()[0]?.headers?.authorization).toBe('Bearer first-token')

    token = 'second-token'
    expect(publishedModels()[0]?.headers?.authorization).toBe('Bearer second-token')
    // The descriptor is rebuilt from the live token rather than captured once:
    // the newest read is the current token, and more than one read happened.
    expect(bearerReads.at(-1)).toBe('second-token')
    expect(bearerReads.length).toBeGreaterThan(1)
  })

  it('stops carrying a token once the desktop app signs out', () => {
    let token: string | undefined = 'live-token'
    build(fakeCatalog([model('M-A')]), () => token)
    expect(publishedModels()[0]?.headers?.authorization).toBe('Bearer live-token')

    token = undefined
    expect(publishedModels()[0]?.headers).toBeUndefined()
  })

  it('does not disturb the rest of the descriptor', () => {
    build(fakeCatalog([model('M-A')]))
    const descriptor = publishedModels()[0] as unknown as Record<string, unknown>
    expect(descriptor['api']).toBe('anthropic-messages')
    expect(descriptor['provider']).toBe('minimaxcode')
    // The SDK base, which pi-ai extends with /v1/messages. A trailing /v1 here
    // doubled the version segment and the gateway answered 503.
    expect(descriptor['baseUrl']).toBe('https://agent.minimax.cn/mavis/api/v1/llm')
  })
})

describe('the thinking requirement', () => {
  beforeEach(() => {
    lastProfiles = undefined
  })

  /**
   * Every MiniMax model here requires reasoning, and pi-ai turns an explicit
   * `thinkingEnabled: false` into `thinking: {type: "disabled"}`, which the
   * gateway refuses with `400 ... requires adaptive thinking`. Marking the "off"
   * level unsupported makes pi-ai omit the field instead, which the gateway
   * accepts.
   */
  it('marks "off" unsupported so pi-ai never sends thinking disabled', () => {
    build(fakeCatalog([model('M-A')]))
    const descriptor = publishedModels()[0] as unknown as { thinkingLevelMap?: Record<string, unknown> }
    expect(descriptor.thinkingLevelMap).toEqual({ off: null })
  })

  it('leaves a non-reasoning model alone', () => {
    const plain = { ...model('M-A'), reasoning: false }
    build(fakeCatalog([plain]))
    const descriptor = publishedModels()[0] as unknown as { reasoning?: boolean; thinkingLevelMap?: unknown }
    expect(descriptor.reasoning).toBe(false)
    expect(descriptor.thinkingLevelMap).toBeUndefined()
  })
})
