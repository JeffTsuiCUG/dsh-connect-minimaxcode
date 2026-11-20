/**
 * The catalog's failure has to be visible, and it has to be recoverable.
 *
 * Two defects met here once, and both were silent:
 *
 *  - the reason for a failed refresh was written and then wiped by the very
 *    call that installed the fallback, so the card could not say why the
 *    built-in list was being served;
 *  - the catalog was read once, at start. A fetch that failed then left the
 *    built-in list in place for the whole session, with no second attempt.
 *
 * The cases below pin both.
 */

import { describe, expect, it, vi } from 'vitest'
import { MinimaxCatalog } from '../src/catalog.ts'

const CATALOG_BODY = {
  version: '1.0',
  providers: [
    {
      providerId: 'minimax',
      config: {
        models: {
          'MiniMax-M3': {
            name: 'M3',
            attachment: true,
            reasoning: true,
            tool_call: true,
            limit: { context: 1000000, output: 128000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    },
  ],
}

const CREDENTIAL = {
  token: 'test-token',
  claims: { userId: 'u-1', exp: 4_000_000_000 },
}

describe('a failed catalog refresh', () => {
  it('keeps the reason it failed', async () => {
    const catalog = new MinimaxCatalog()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, fetchImpl)
    // The built-in list is served, and the reason is readable.
    expect(catalog.source).toBe('fallback')
    expect(catalog.error, '失败原因被自己抹掉了').toBeTruthy()
    expect(catalog.error).toContain('503')
  })

  it('reports a reason that names the failure, not a fallback', async () => {
    const catalog = new MinimaxCatalog()
    const fetchImpl = vi.fn(async () => { throw new Error('the network is down') }) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, fetchImpl)
    expect(catalog.error).toContain('the network is down')
  })

  it('serves the live list and no reason when it works', async () => {
    const catalog = new MinimaxCatalog()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CATALOG_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, fetchImpl)
    expect(catalog.source).toBe('live')
    expect(catalog.error).toBeUndefined()
    expect(catalog.current().map((model) => model.id)).toEqual(['MiniMax-M3'])
  })

  it('can be retried after a failure', async () => {
    const catalog = new MinimaxCatalog()
    const failing = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, failing)
    expect(catalog.source).toBe('fallback')

    // The second attempt, with the upstream answering: the catalog recovers.
    const working = vi.fn(async () => new Response(JSON.stringify(CATALOG_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, working)
    expect(catalog.source, '失败之后没有再试，目录一直停在回退列表').toBe('live')
    expect(catalog.error).toBeUndefined()
  })

  it('keeps serving the live list when a refresh fails, and says why', async () => {
    // A refresh that fails does not throw away a good list: the models
    // that were read last time keep being served, and the reason is
    // recorded beside them. The card can then say "these are from the last
    // successful read, and the last refresh failed" — which is the truth.
    const catalog = new MinimaxCatalog()
    const working = vi.fn(async () => new Response(JSON.stringify(CATALOG_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, working)
    expect(catalog.source).toBe('live')

    const failing = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await catalog.refresh('cn', CREDENTIAL, failing)
    expect(catalog.source, '一次失败的刷新不该丢掉已经读到的列表').toBe('live')
    expect(catalog.current().map((model) => model.id)).toEqual(['MiniMax-M3'])
    expect(catalog.error, '刷新失败没有留下原因').toContain('503')
  })
})
