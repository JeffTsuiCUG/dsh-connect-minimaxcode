import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authPath,
  chatBaseUrl,
  decodeClaims,
  daysRemaining,
  expiresInMs,
  expiryLevel,
  readCredential,
  INERT_AUTH,
  MINIMAX_AUTH_FILENAME,
} from '../src/auth.ts'

/** A JWT with the given expiry and no personal fields. */
function fakeJwt(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: expSeconds, user: { id: 'test-account', name: 'test' } })}.signature`
}

/** Write an auth file into a throwaway data directory. */
async function withAuthFile(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mmx-auth-'))
  await writeFile(join(dir, MINIMAX_AUTH_FILENAME), typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

describe('decodeClaims', () => {
  it('reads exp and the optional account fields', () => {
    const claims = decodeClaims(fakeJwt(1_800_000_000))
    expect(claims).toBeDefined()
    expect(claims!.exp).toBe(1_800_000_000)
    expect(claims!.userId).toBe('test-account')
  })

  it('rejects a token that is not three segments', () => {
    expect(decodeClaims('not-a-jwt')).toBeUndefined()
    expect(decodeClaims('a.b')).toBeUndefined()
  })

  it('rejects a payload without a numeric exp', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    expect(decodeClaims(`${encode({})}.${encode({ sub: 'x' })}.s`)).toBeUndefined()
  })
})

describe('expiry helpers', () => {
  it('counts whole days, rounding up', () => {
    expect(daysRemaining({ exp: NOW / 1000 + 1 }, NOW)).toBe(1)
    expect(daysRemaining({ exp: NOW / 1000 + 1.5 * DAY / 1000 }, NOW)).toBe(2)
  })

  it('reports zero once expired', () => {
    expect(daysRemaining({ exp: NOW / 1000 - 10 }, NOW)).toBe(0)
    expect(expiresInMs({ exp: NOW / 1000 - 10 }, NOW)).toBeLessThan(0)
  })

  it('turns yellow inside the last day and red past it', () => {
    expect(expiryLevel({ exp: NOW / 1000 + 10 * DAY / 1000 }, NOW)).toBe('healthy')
    expect(expiryLevel({ exp: NOW / 1000 + 0.5 * DAY / 1000 }, NOW)).toBe('expiring')
    expect(expiryLevel({ exp: NOW / 1000 - 1 }, NOW)).toBe('expired')
  })
})

describe('readCredential', () => {
  it('reports app-missing when the file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmx-empty-'))
    const state = await readCredential({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv, NOW)
    expect(state).toEqual({ state: 'signed-out', reason: 'app-missing' })
  })

  it('reports not-signed-in when the token is empty', async () => {
    const dir = await withAuthFile({ version: 1, auth: { accessToken: '' } })
    const state = await readCredential({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv, NOW)
    expect(state).toEqual({ state: 'signed-out', reason: 'not-signed-in' })
  })

  it('reports unreadable for a corrupt file', async () => {
    const dir = await withAuthFile('{not json')
    const state = await readCredential({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv, NOW)
    expect(state).toEqual({ state: 'signed-out', reason: 'unreadable' })
  })

  it('reports malformed for an undecodable token', async () => {
    const dir = await withAuthFile({ version: 1, auth: { accessToken: 'garbage' } })
    const state = await readCredential({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv, NOW)
    expect(state).toEqual({ state: 'signed-out', reason: 'malformed' })
  })

  it('reports expired rather than handing back a dead token', async () => {
    const dir = await withAuthFile({ version: 1, auth: { accessToken: fakeJwt(NOW / 1000 - 60) } })
    const state = await readCredential({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv, NOW)
    expect(state.state).toBe('expired')
  })

  it('returns the credential for a live token', async () => {
    const token = fakeJwt(NOW / 1000 + 15 * DAY / 1000)
    const dir = await withAuthFile({ version: 1, updatedAtMs: NOW, auth: { accessToken: token } })
    const state = await readCredential({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv, NOW)
    expect(state.state).toBe('signed-in')
    if (state.state !== 'signed-in') throw new Error('unreachable')
    expect(state.credential.token).toBe(token)
    expect(state.credential.updatedAtMs).toBe(NOW)
  })
})

describe('paths and endpoints', () => {
  it('honours the app data-dir override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmx-dir-'))
    expect(authPath({ MINIMAX_DATA_DIR: dir } as NodeJS.ProcessEnv)).toBe(join(dir, MINIMAX_AUTH_FILENAME))
  })

  it('falls back to the home directory', () => {
    const expected = join(tmpdir(), '.minimax', MINIMAX_AUTH_FILENAME)
    // Only assert the suffix; the home directory is machine-specific.
    expect(authPath({} as NodeJS.ProcessEnv).endsWith(join('.minimax', MINIMAX_AUTH_FILENAME))).toBe(true)
    expect(expected.endsWith(MINIMAX_AUTH_FILENAME)).toBe(true)
  })

  it('builds the Anthropic-compatible endpoint per region', () => {
    expect(chatBaseUrl('cn')).toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1')
    expect(chatBaseUrl('io')).toBe('https://agent.minimax.io/mavis/api/v1/llm/v1')
  })
})

describe('INERT_AUTH', () => {
  /**
   * `PiAiAdapterOptions.auth` is required and must be the pi-ai auth pair
   * `{ credentials, authContext }`. An earlier version passed
   * `{ auth: { apiKey: 'minimaxcode' } }` instead, which is not that shape:
   * pi-ai fell back to its own empty in-memory credential store and every
   * request came back "API key is invalid" while the status card still reported
   * `signed-in`, because the two read different things.
   */
  it('is the pi-ai auth pair, not a request-shaped stub', () => {
    expect(INERT_AUTH).toHaveProperty('credentials')
    expect(INERT_AUTH).toHaveProperty('authContext')
    expect(INERT_AUTH).not.toHaveProperty('auth')
  })

  it('stores nothing and discovers no ambient credential', async () => {
    await expect(INERT_AUTH.credentials.read('minimaxcode')).resolves.toBeUndefined()
    await expect(INERT_AUTH.credentials.list()).resolves.toEqual([])
    await expect(INERT_AUTH.authContext.env('MINIMAX_API_KEY')).resolves.toBeUndefined()
    await expect(INERT_AUTH.authContext.fileExists('~/.minimax')).resolves.toBe(false)
  })

  it('refuses a pi-ai login, which would mask the real credential path', async () => {
    await expect(
      INERT_AUTH.credentials.modify('minimaxcode', async () => undefined),
    ).rejects.toThrow()
  })

  it('accepts a delete without failing the unload path', async () => {
    await expect(INERT_AUTH.credentials.delete('minimaxcode')).resolves.toBeUndefined()
  })
})