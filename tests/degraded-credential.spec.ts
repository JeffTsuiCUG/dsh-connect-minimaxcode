/**
 * The plugin must load and report state honestly when there is no usable token.
 *
 * A user who has not installed MiniMax Code, has not signed in, or whose token
 * aged out is a normal condition, not an error: the host still has to start, the
 * provider still has to register, and the status route has to say which of the
 * three it is. Each state needs its own remedy, so each is exercised here.
 *
 * These paths never reach the network: without a usable credential `apply()`
 * does not attempt a catalog fetch.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { MINIMAX_AUTH_FILENAME } from '../src/auth.ts'
import { MINIMAX_STATUS_PATH } from '../src/status-route.ts'

/** A JWT with the given expiry and nothing personal. */
function fakeJwt(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: expSeconds })}.signature`
}

/** Point the plugin's data directory at a throwaway location. */
async function useDataDir(body?: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mmx-degraded-'))
  if (body !== undefined) await writeFile(join(dir, MINIMAX_AUTH_FILENAME), body)
  process.env.MINIMAX_DATA_DIR = dir
}

const plugin = { name, inject, apply }

/** Capture the status route the plugin registers, with a webServer stand-in. */
async function mountStatusRoute() {
  const handlers = new Map<string, (req: unknown, res: unknown) => unknown>()
  const ctx = new Context()
  ctx.reflect.provide('llm', { registerAdapter: () => vi.fn() } as never)
  ctx.reflect.provide('webServer', {
    register: ({ path, handler }: { path: string; handler: (req: unknown, res: unknown) => unknown }) => {
      handlers.set(path, handler)
      return () => handlers.delete(path)
    },
  } as never)
  await ctx.plugin(plugin, undefined)
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  return handlers.get(MINIMAX_STATUS_PATH)
}

/** Invoke the route as the host would, and read the JSON it writes. */
async function callStatus(handler: (req: unknown, res: unknown) => unknown) {
  let status = 0
  let body = ''
  await handler(
    { headers: { host: '127.0.0.1:19387' } },
    {
      writeHead: (code: number) => { status = code },
      end: (chunk: string) => { body = chunk },
    },
  )
  return { status, body: JSON.parse(body) as StatusShape }
}

interface StatusShape {
  state: 'signed-in' | 'signed-out' | 'expired'
  hint?: string
  region?: string
  models?: { id: string }[]
  catalogSource?: string
}

describe('without a usable token', () => {
  const original = process.env.MINIMAX_DATA_DIR

  beforeEach(() => {
    delete process.env.MINIMAX_DATA_DIR
  })

  afterEach(() => {
    if (original === undefined) delete process.env.MINIMAX_DATA_DIR
    else process.env.MINIMAX_DATA_DIR = original
  })

  it('still loads and registers its provider, so the host starts', async () => {
    await useDataDir()
    const registerAdapter = vi.fn(() => vi.fn())
    const ctx = new Context()
    ctx.reflect.provide('llm', { registerAdapter } as never)
    await expect(ctx.plugin(plugin, undefined)).resolves.toBeDefined()
    expect(registerAdapter).toHaveBeenCalledTimes(1)
  })

  it('reports app-missing when the desktop app was never installed', async () => {
    await useDataDir()
    const handler = await mountStatusRoute()
    expect(handler).toBeDefined()
    const { status, body } = await callStatus(handler!)
    expect(status).toBe(200)
    expect(body.state).toBe('signed-out')
    expect(body.hint).toContain('安装')
  })

  it('reports not-signed-in when the app has no token yet', async () => {
    await useDataDir(JSON.stringify({ auth: { accessToken: '' } }))
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)
    expect(body.state).toBe('signed-out')
    expect(body.hint).toContain('登录')
  })

  it('reports expired, and says to re-login, when the token aged out', async () => {
    await useDataDir(JSON.stringify({ auth: { accessToken: fakeJwt(1) } }))
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)
    expect(body.state).toBe('expired')
    expect(body.hint).toContain('登录 MiniMax Code')
    // The remedy names the app and the restart, since neither is implicit.
    expect(body.hint).toContain('桌面 App')
    expect(body.hint).toContain('重启 DSH')
  })

  it('reports unreadable rather than throwing on a corrupt file', async () => {
    await useDataDir('{ this is not json')
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)
    expect(body.state).toBe('signed-out')
    expect(body.hint).toContain('无法读取')
  })

  it('never carries a token in any of those responses', async () => {
    await useDataDir(JSON.stringify({ auth: { accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600) } }))
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)
    expect(body.state).toBe('signed-in')
    expect(JSON.stringify(body)).not.toMatch(/eyJ/)
    expect(JSON.stringify(body)).not.toContain('Bearer')
  })

  it('refuses a non-loopback caller', async () => {
    await useDataDir()
    const handler = await mountStatusRoute()
    expect(handler).toBeDefined()
    let status = 0
    await handler!(
      { headers: { host: 'evil.example.com' } },
      { writeHead: (code: number) => { status = code }, end: () => undefined },
    )
    expect(status).toBe(403)
  })

  it('still offers the fallback roster, which is why the README says so', async () => {
    await useDataDir()
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)
    // Honest about provenance: these are the built-in guesses, not a live list.
    expect(body.catalogSource).toBe('fallback')
    expect(body.models?.length ?? 0).toBeGreaterThan(0)
  })
})