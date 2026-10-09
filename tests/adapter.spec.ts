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

function build(catalog: MinimaxCatalog) {
  lastProfiles = undefined
  return createMinimaxCodeAdapter({
    catalog,
    region: () => 'cn',
    resolveApiKey: async () => credential.token,
  })
}

/** The profile the adapter resolves right now. */
function profile(): { piProvider?: { getModels?: () => { id: string }[] }; configuredMaxTokens?: Map<string, number>; modelErrors?: Map<string, Error> } {
  expect(lastProfiles, 'PiAiAdapter was never constructed').toBeDefined()
  return [...lastProfiles!().values()][0] as never
}

function publishedIds(): string[] {
  return (profile().piProvider?.getModels?.() ?? []).map(m => m.id)
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
