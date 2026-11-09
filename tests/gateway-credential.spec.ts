/**
 * Which credential the model gateway is actually called with.
 *
 * This is the defect that made a working machine look broken: the gateway
 * read the plugin's own sign-in and the *legacy* JWT an older desktop app
 * left behind, but current installs store an OAuth grant instead. Once the
 * legacy JWT aged out, every model request answered `401 auth failed` — while
 * credits, which read the OAuth file, kept working perfectly.
 *
 * These cases pin the order the gateway tries credentials in, and pin it at
 * the point that matters: the `Authorization` header the model descriptor
 * carries is the header the request goes out with.
 *
 * `PiAiAdapter` keeps no public accessor for its `profiles` callback, so the
 * constructor is mocked to capture it — that callback is exactly the map the
 * adapter resolves per operation, and capturing it leaves production
 * untouched.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MINIMAX_AUTH_FILENAME } from '../src/auth.ts'

/** The captured `profiles` callback of the most recent PiAiAdapter build. */
let lastProfiles: (() => ReadonlyMap<string, unknown>) | undefined

vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({
  PiAiAdapter: class {
    constructor(options: { profiles: () => ReadonlyMap<string, unknown> }) {
      lastProfiles = options.profiles
    }
  },
}))

const { apply, inject, name } = await import('../src/index.ts')

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

/** A JWT whose value is distinctive enough to spot in an assertion. */
function fakeJwt(label: string, expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: expSeconds, label })}.signature`
}

/** Write the desktop app's OAuth store, in the shape its reader expects. */
async function writeDesktopOAuth(dir: string, accessToken: string): Promise<void> {
  const oauthDir = join(dir, 'auth', 'prod', 'cn', 'mcode-public')
  await mkdir(oauthDir, { recursive: true })
  await writeFile(
    join(oauthDir, 'auth.json'),
    JSON.stringify({
      schemaVersion: 1,
      records: {
        'com.minimax.mcode.oauth.prod.cn\u0000key': {
          schemaVersion: 1,
          accessToken,
          refreshToken: 'mmort_desktop',
          clientId: 'mcode-public',
          scopes: ['agent.default'],
          audience: 'agent-backend',
          expiresAtMs: Date.now() + 6 * 60 * 60 * 1000,
        },
      },
    }),
    'utf8',
  )
}

/** Write the legacy JWT an older install leaves behind. */
async function writeLegacyJwt(dir: string, token: string): Promise<void> {
  await writeFile(
    join(dir, MINIMAX_AUTH_FILENAME),
    JSON.stringify({ version: 1, updatedAtMs: Date.now(), auth: { accessToken: token } }),
    'utf8',
  )
}

/** Stub the global fetch: the plugin builds every request from it. */
function stubFetch(seen: string[] = []): void {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    seen.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(CATALOG),
      text: async () => CATALOG,
    }
  })
}

/** Mount the plugin and let its startup prime settle. */
async function mount(): Promise<void> {
  lastProfiles = undefined
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  ctx.reflect.provide('llm', { registerAdapter: () => vi.fn() } as never)
  ctx.reflect.provide('webServer', { register: () => () => {} } as never)
  await ctx.plugin({ name, inject, apply }, undefined)
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 50))
}

/** The `Authorization` header the published models carry, if any. */
function publishedAuthorization(): string | undefined {
  expect(lastProfiles, 'PiAiAdapter was never constructed').toBeDefined()
  const route = [...lastProfiles!().values()][0] as {
    piProvider?: { getModels?: () => { id: string; headers?: Record<string, string> }[] }
  }
  const models = route?.piProvider?.getModels?.() ?? []
  expect(models.length, 'no models were published').toBeGreaterThan(0)
  return models[0]?.headers?.authorization
}

describe('the credential the model gateway uses', () => {
  const originalDataDir = process.env.MINIMAX_DATA_DIR
  const originalHome = process.env.DSH_HOME

  beforeEach(() => {
    delete process.env.MINIMAX_DATA_DIR
    delete process.env.DSH_HOME
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalDataDir === undefined) delete process.env.MINIMAX_DATA_DIR
    else process.env.MINIMAX_DATA_DIR = originalDataDir
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })

  it('prefers the desktop app OAuth grant over the legacy JWT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmx-gateway-'))
    process.env.MINIMAX_DATA_DIR = dir
    process.env.DSH_HOME = dir
    await writeDesktopOAuth(dir, 'mmoat_oauth_grant')
    await writeLegacyJwt(dir, fakeJwt('legacy', Math.floor(Date.now() / 1000) + 3600))
    stubFetch()
    await mount()

    // The OAuth grant is what the gateway accepts; the legacy JWT is what it
    // answers `401 auth failed` with.
    expect(publishedAuthorization()).toBe('Bearer mmoat_oauth_grant')
  })

  it('falls back to the legacy JWT when there is no OAuth grant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmx-gateway-'))
    process.env.MINIMAX_DATA_DIR = dir
    process.env.DSH_HOME = dir
    const jwt = fakeJwt('legacy-only', Math.floor(Date.now() / 1000) + 3600)
    await writeLegacyJwt(dir, jwt)
    stubFetch()
    await mount()

    // An old install with only the old file still works.
    expect(publishedAuthorization()).toBe(`Bearer ${jwt}`)
  })

  it('publishes no authorization header when nothing is signed in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmx-gateway-'))
    process.env.MINIMAX_DATA_DIR = dir
    process.env.DSH_HOME = dir
    stubFetch()
    await mount()

    expect(publishedAuthorization()).toBeUndefined()
  })
})
