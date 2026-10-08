import { describe, expect, it, vi } from 'vitest'
import { MinimaxCatalog, parseCatalog, FALLBACK_MODELS } from '../src/catalog.ts'
import type { Credential } from '../src/auth.ts'

/** A catalog document shaped exactly like the upstream one, with no personal data. */
const UPSTREAM = {
  version: '1.0',
  ttlSeconds: 300,
  providers: [
    {
      providerId: 'minimax',
      config: {
        name: 'Example',
        npm: '@ai-sdk/anthropic',
        models: {
          'Example-Text': {
            name: 'Text',
            attachment: false,
            reasoning: true,
            tool_call: true,
            limit: { context: 200000, output: 128000 },
            modalities: { input: ['text'], output: ['text'] },
          },
          'Example-Vision': {
            name: 'Vision',
            attachment: true,
            reasoning: true,
            tool_call: true,
            limit: { context: 512000, output: 128000 },
            modalities: { input: ['text', 'image', 'video'], output: ['text'] },
          },
          'Example-Plain': {
            name: 'Plain',
            limit: { context: 128000 },
          },
        },
      },
    },
    {
      providerId: 'other-vendor',
      config: { models: { 'Other-1': { name: 'Other' } } },
    },
  ],
}

const CREDENTIAL: Credential = { token: 'test-token', claims: { exp: 1_800_000_000, userId: 'test-account' } }

/** Names must start with MiniMax-, so the fixture uses that prefix. */
function renamed(): unknown {
  const doc = structuredClone(UPSTREAM) as { providers: { providerId: string; config: { models: Record<string, unknown> } }[] }
  const models = doc.providers[0]!.config.models
  doc.providers[0]!.config.models = Object.fromEntries(
    Object.entries(models).map(([key, value]) => [`MiniMax-${key.replace('Example-', '')}`, value]),
  )
  return doc
}

describe('parseCatalog', () => {
  it('reads ids from the keys and keeps capability flags', () => {
    const models = parseCatalog(renamed())
    expect(models.map((m) => m.id)).toEqual(['MiniMax-Text', 'MiniMax-Vision', 'MiniMax-Plain'])
    expect(models[0]).toMatchObject({ contextWindow: 200000, toolCall: true, reasoning: true, attachment: false })
    expect(models[1]).toMatchObject({ contextWindow: 512000, attachment: true, inputModalities: ['text', 'image', 'video'] })
  })

  it('defaults the output limit when upstream omits it', () => {
    const models = parseCatalog(renamed())
    expect(models[2]!.maxOutputTokens).toBeUndefined()
    expect(models[2]!.contextWindow).toBe(128000)
  })

  it('ignores other vendors and malformed documents', () => {
    expect(parseCatalog({ providers: [{ providerId: 'other', config: { models: { 'x': {} } } }] })).toEqual([])
    expect(parseCatalog(null)).toEqual([])
    expect(parseCatalog({ providers: 'nope' })).toEqual([])
  })
})

describe('MinimaxCatalog', () => {
  it('serves the built-in list before any fetch', () => {
    const catalog = new MinimaxCatalog()
    expect(catalog.source).toBe('fallback')
    expect(catalog.current()).toEqual([...FALLBACK_MODELS])
  })

  it('adopts a live catalog', async () => {
    const catalog = new MinimaxCatalog()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(renamed()), { status: 200 }))
    await catalog.refresh('cn', CREDENTIAL, fetchImpl as unknown as typeof fetch)
    expect(catalog.source).toBe('live')
    expect(catalog.current()).toHaveLength(3)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://agent.minimax.cn/mavis/api/v1/models')
    expect(init.headers.authorization).toBe('Bearer test-token')
  })

  it('keeps serving the last good list when a refresh fails', async () => {
    const catalog = new MinimaxCatalog()
    await catalog.refresh('cn', CREDENTIAL, (async () => new Response(JSON.stringify(renamed()), { status: 200 })) as unknown as typeof fetch)
    await catalog.refresh('cn', CREDENTIAL, (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(catalog.source).toBe('live')
    expect(catalog.current()).toHaveLength(3)
    expect(catalog.error).toContain('500')
  })

  it('falls back when the first fetch fails', async () => {
    const catalog = new MinimaxCatalog()
    await catalog.refresh('cn', CREDENTIAL, (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch)
    expect(catalog.source).toBe('fallback')
    expect(catalog.current()).toEqual([...FALLBACK_MODELS])
    expect(catalog.error).toContain('503')
  })

  it('refuses a catalog that carries no usable models', async () => {
    const catalog = new MinimaxCatalog()
    await catalog.refresh('cn', CREDENTIAL, (async () => new Response(JSON.stringify({ providers: [] }), { status: 200 })) as unknown as typeof fetch)
    expect(catalog.source).toBe('fallback')
    expect(catalog.error).toContain('no MiniMax models')
  })

  it('reports whether a refresh actually changed anything', () => {
    const catalog = new MinimaxCatalog()
    expect(catalog.set([...FALLBACK_MODELS], 'fallback')).toBe(false)
    expect(catalog.set([{ ...FALLBACK_MODELS[0]!, contextWindow: 999 }], 'fallback')).toBe(true)
  })

  it('drops back to the built-in list on invalidate', async () => {
    const catalog = new MinimaxCatalog()
    await catalog.refresh('cn', CREDENTIAL, (async () => new Response(JSON.stringify(renamed()), { status: 200 })) as unknown as typeof fetch)
    catalog.invalidate()
    expect(catalog.source).toBe('fallback')
    expect(catalog.current()).toEqual([...FALLBACK_MODELS])
  })
})