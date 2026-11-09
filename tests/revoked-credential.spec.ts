/**
 * The plugin must recover from a credential the server refuses.
 *
 * A revoked token keeps its expiry date, so an expiry-only refresh check never
 * notices: every later request sends the same dead token, every endpoint
 * answers `401`, and the card goes on claiming a sign-in that no longer works.
 * These cases pin the two halves of the fix — the credential is dropped so the
 * card can ask for a new sign-in, and the sign-in state describes the
 * credential the gateway will actually be called with rather than a file on
 * disk that happens to exist.
 *
 * Every case stubs `globalThis.fetch`: the plugin resolves its fetches through
 * the global, so a stub here is what keeps the suite off the network.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { MINIMAX_AUTH_FILENAME } from '../src/auth.ts'
import { MINIMAX_STATUS_PATH } from '../src/status-route.ts'

const CREDENTIAL_FILENAME = '.minimaxcode-auth.json'

/** Point both data directories at one throwaway location. */
async function useDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mmx-revoked-'))
  process.env.MINIMAX_DATA_DIR = dir
  process.env.DSH_HOME = dir
  return dir
}

/** Write the plugin's own credential, as a completed device login would. */
async function writePluginCredential(
  dir: string,
  options: { accessToken?: string; refreshToken?: string; expiresAtMs?: number } = {},
): Promise<void> {
  await writeFile(
    join(dir, CREDENTIAL_FILENAME),
    JSON.stringify({
      schemaVersion: 1,
      clientId: 'mcode-public',
      scopes: ['agent.default'],
      audience: 'agent-backend',
      accessToken: options.accessToken ?? 'mmoat_revoked',
      refreshToken: options.refreshToken ?? 'mmort_revoked',
      expiresAtMs: options.expiresAtMs ?? Date.now() + 60 * 60 * 1000,
      obtainedAtMs: Date.now(),
    }),
    'utf8',
  )
}

/** A JWT with the given expiry and nothing personal. */
function fakeJwt(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: expSeconds })}.signature`
}

/** A catalog document with one usable model. */
const CATALOG = JSON.stringify({
  version: '1.0',
  providers: [
    {
      providerId: 'minimax',
      config: {
        models: {
          'MiniMax-M3.1-Flash': {
            name: 'M3.1-Flash',
            limit: { context: 512000, output: 128000 },
          },
        },
      },
    },
  ],
})

interface Route {
  status: number
  json: unknown
}

/**
 * Stub the global fetch with one answer per endpoint.
 *
 * The plugin builds every request from the global `fetch` binding, so replacing
 * it is enough to keep these cases offline and to choose exactly which endpoint
 * refuses the token.
 */
function stubFetch(routes: (url: string) => Route): void {
  const impl = async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    const route = routes(url)
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.json,
      text: async () => JSON.stringify(route.json),
    }
  }
  vi.stubGlobal('fetch', impl)
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
  // The startup prime reads the credential and refreshes the catalog; let it
  // settle so the assertions below describe a steady state, not a race.
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 25))
  return handlers.get(MINIMAX_STATUS_PATH)
}

interface StatusShape {
  state: 'signed-in' | 'signed-out' | 'expired'
  hint?: string
  catalogSource?: string
  credits?: { state: string; error?: string }
  login?: { state: string; source?: string }
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

describe('a credential the server refuses', () => {
  const original = process.env.MINIMAX_DATA_DIR
  const originalHome = process.env.DSH_HOME

  beforeEach(() => {
    delete process.env.MINIMAX_DATA_DIR
    delete process.env.DSH_HOME
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (original === undefined) delete process.env.MINIMAX_DATA_DIR
    else process.env.MINIMAX_DATA_DIR = original
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })

  it('drops the plugin credential when the account API answers 401', async () => {
    const dir = await useDataDir()
    await writePluginCredential(dir)
    stubFetch((url) => {
      // The refresh token is spent too, so the credential cannot come back.
      if (url.includes('/oauth2/token')) return { status: 400, json: { error: 'invalid_grant' } }
      if (url.includes('/mavis/api/v1/models')) return { status: 200, json: JSON.parse(CATALOG) }
      if (url.includes('remains_percent')) return { status: 401, json: { code: 401 } }
      return { status: 401, json: { code: 401, message: 'auth failed' } }
    })
    const handler = await mountStatusRoute()
    expect(handler).toBeTypeOf('function')
    const { status, body } = await callStatus(handler!)

    expect(status).toBe(200)
    // The dead credential is gone, so a later read cannot pick it up again.
    expect(existsSync(join(dir, CREDENTIAL_FILENAME))).toBe(false)
    // And the card stops claiming a sign-in it cannot back up.
    expect(body.state).toBe('signed-out')
    expect(body.login?.state).toBe('signed-out')
  })

  it('reports a refused credential as signed out with a remedy, not as expired', async () => {
    const dir = await useDataDir()
    await writePluginCredential(dir)
    stubFetch((url) => {
      if (url.includes('/oauth2/token')) return { status: 400, json: { error: 'invalid_grant' } }
      if (url.includes('/mavis/api/v1/models')) return { status: 200, json: JSON.parse(CATALOG) }
      return { status: 401, json: { code: 401 } }
    })
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)

    expect(body.state).toBe('signed-out')
    // The remedy is a new sign-in from the card, which the desktop app's
    // "restart DSH" advice would not give.
    expect(body.hint).toContain('重新登录')
  })

  it('keeps the credential when the refresh fails for a transient reason', async () => {
    const dir = await useDataDir()
    // Already inside the refresh margin, so a refresh is attempted.
    await writePluginCredential(dir, { expiresAtMs: Date.now() + 30 * 1000 })
    stubFetch((url) => {
      if (url.includes('/oauth2/token')) return { status: 503, json: { error: 'unavailable' } }
      if (url.includes('/mavis/api/v1/models')) return { status: 200, json: JSON.parse(CATALOG) }
      return { status: 200, json: { op_credit_summary: { total_remaining_amount: '10' } } }
    })
    const handler = await mountStatusRoute()
    await callStatus(handler!)

    // A bad minute upstream must not sign the person out.
    expect(existsSync(join(dir, CREDENTIAL_FILENAME))).toBe(true)
  })

  it('reports signed-in from the plugin credential when no desktop app is installed', async () => {
    const dir = await useDataDir()
    await writePluginCredential(dir, { expiresAtMs: Date.now() + 6 * 60 * 60 * 1000 })
    stubFetch((url) => {
      if (url.includes('/mavis/api/v1/models')) return { status: 200, json: JSON.parse(CATALOG) }
      if (url.includes('remains_percent')) return { status: 200, json: { remains_percent: [] } }
      return { status: 200, json: { op_credit_summary: { total_remaining_amount: '10' } } }
    })
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)

    // The card is about the credential the gateway will use; the desktop app's
    // absence must not make a working sign-in look like a signed-out one.
    expect(body.state).toBe('signed-in')
    expect(body.login?.state).toBe('signed-in')
    expect(body.login?.source).toBe('plugin')
    expect(body.catalogSource).toBe('live')
  })

  it('uses the desktop app OAuth grant for the gateway when there is no plugin credential', async () => {
    const dir = await useDataDir()
    // The desktop app's OAuth store, in the shape its reader expects.
    const oauthDir = join(dir, 'auth', 'prod', 'cn', 'mcode-public')
    await import('node:fs/promises').then(fs => fs.mkdir(oauthDir, { recursive: true }))
    await writeFile(
      join(oauthDir, 'auth.json'),
      JSON.stringify({
        schemaVersion: 1,
        records: {
          'com.minimax.mcode.oauth.prod.cn\u0000key': {
            schemaVersion: 1,
            accessToken: 'mmoat_from_desktop',
            refreshToken: 'mmort_from_desktop',
            clientId: 'mcode-public',
            scopes: ['agent.default'],
            audience: 'agent-backend',
            expiresAtMs: Date.now() + 6 * 60 * 60 * 1000,
          },
        },
      }),
      'utf8',
    )
    // A legacy JWT the gateway refuses, exactly as an upgraded install leaves
    // behind: it must not win over the OAuth grant above.
    await writeFile(
      join(dir, MINIMAX_AUTH_FILENAME),
      JSON.stringify({ version: 1, updatedAtMs: Date.now(), auth: { accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600) } }),
      'utf8',
    )
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      if (url.includes('/mavis/api/v1/models')) return { status: 200, json: JSON.parse(CATALOG) }
      if (url.includes('remains_percent')) return { status: 200, json: { remains_percent: [] } }
      return { status: 200, json: { op_credit_summary: { total_remaining_amount: '10' } } }
    })
    const handler = await mountStatusRoute()
    const { body } = await callStatus(handler!)

    expect(body.state).toBe('signed-in')
    expect(body.login?.source).toBe('desktop-app')
    expect(body.catalogSource).toBe('live')
    // The catalog was fetched, which only happens with a bearer the gateway
    // takes; the assertion above says that bearer came from the OAuth grant.
    expect(seen.some(url => url.includes('/mavis/api/v1/models'))).toBe(true)
  })

  it('never writes a token into the status document', async () => {
    const dir = await useDataDir()
    await writePluginCredential(dir)
    stubFetch((url) => {
      if (url.includes('/oauth2/token')) return { status: 400, json: { error: 'invalid_grant' } }
      if (url.includes('/mavis/api/v1/models')) return { status: 200, json: JSON.parse(CATALOG) }
      return { status: 401, json: { code: 401 } }
    })
    const handler = await mountStatusRoute()
    let raw = ''
    await handler!(
      { headers: { host: '127.0.0.1:19387' } },
      { writeHead: () => {}, end: (chunk: string) => { raw = chunk } },
    )

    expect(raw).not.toContain('mmoat_')
    expect(raw).not.toContain('mmort_')
    expect(raw).not.toContain('Bearer')
    expect(raw).not.toContain('eyJ')
    // The file itself is still readable as JSON, which the assertion above
    // needs in order to be about the document rather than about a crash.
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
