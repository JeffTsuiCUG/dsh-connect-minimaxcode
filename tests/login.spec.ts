/**
 * Signing in without the desktop app.
 *
 * The plugin runs the OAuth 2.0 device authorization grant the desktop app
 * runs, so the person authorizes in their own browser and the plugin never
 * sees a password. These tests pin the request shapes and the states the
 * authorization server answers with.
 */

import { describe, expect, it } from 'vitest'
import {
  DEVICE_CODE_GRANT,
  makePkce,
  pollDeviceLogin,
  refreshPluginCredential,
  startDeviceLogin,
} from '../src/login.ts'
import type { DeviceLoginSession, PluginCredential } from '../src/credentials.ts'

const SESSION: DeviceLoginSession = {
  deviceCode: 'device_code_example',
  codeVerifier: 'verifier_example',
  userCode: 'XW6G-QEGA',
  verificationUri: 'https://account.minimax.cn/oauth-authorize',
  verificationUriComplete: 'https://account.minimax.cn/oauth-authorize?user_code=XW6G-QEGA',
  expiresAtMs: 1_800_000_000_000,
}

describe('PKCE', () => {
  it('makes a verifier and its challenge', () => {
    const { verifier, challenge } = makePkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).not.toBe(verifier)
  })

  it('makes a different verifier every time', () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier)
  })
})

describe('startDeviceLogin', () => {
  it('asks for a device code with the app\'s own client and a challenge', async () => {
    const asked: { url: string; body: URLSearchParams }[] = []
    const fetchImpl = (async (url: string, init: { body: URLSearchParams }) => {
      asked.push({ url: String(url), body: init.body })
      return {
        ok: true,
        json: async () => ({
          device_code: 'device_code_example',
          expires_in: 300,
          interval: 3,
          user_code: 'XW6G-QEGA',
          verification_uri: 'https://account.minimax.cn/oauth-authorize',
          verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=XW6G-QEGA',
        }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const session = await startDeviceLogin('cn', fetchImpl, 1_700_000_000_000)
    expect(session?.userCode).toBe('XW6G-QEGA')
    expect(session?.verificationUri).toBe('https://account.minimax.cn/oauth-authorize')
    expect(session?.expiresAtMs).toBe(1_700_000_000_000 + 300_000)
    expect(asked[0]?.url).toBe('https://account.minimax.cn/oauth2/device/code')
    expect(asked[0]?.body.get('client_id')).toBe('mcode-public')
    expect(asked[0]?.body.get('scope')).toBe('agent.default')
    expect(asked[0]?.body.get('audience')).toBe('agent-backend')
    expect(asked[0]?.body.get('code_challenge_method')).toBe('S256')
    expect(asked[0]?.body.get('code_challenge')).toBeTruthy()
  })

  it('refuses a response without a device code', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ user_code: 'X' }) }) as unknown as Response) as unknown as typeof fetch
    await expect(startDeviceLogin('cn', fetchImpl)).rejects.toThrow(/device_code/)
  })
})

describe('pollDeviceLogin', () => {
  const answer = (status: number, body: unknown) => (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response) as unknown as typeof fetch

  it('waits while the person has not authorized yet', async () => {
    const state = await pollDeviceLogin(SESSION, 'cn', answer(400, { error: 'authorization_pending' }))
    expect(state.state).toBe('pending')
  })

  it('reports the server asking the client to slow down', async () => {
    const state = await pollDeviceLogin(SESSION, 'cn', answer(400, { error: 'slow_down' }))
    expect(state.state).toBe('slow-down')
  })

  it('reports an expired device code', async () => {
    const state = await pollDeviceLogin(SESSION, 'cn', answer(400, { error: 'expired_token' }))
    expect(state.state).toBe('expired')
  })

  it('reports a refusal', async () => {
    const state = await pollDeviceLogin(SESSION, 'cn', answer(400, { error: 'access_denied' }))
    expect(state.state).toBe('denied')
  })

  it('reads the grant when it arrives', async () => {
    const state = await pollDeviceLogin(SESSION, 'cn', answer(200, {
      access_token: 'mmoat_new',
      refresh_token: 'mmort_new',
      expires_in: 3600,
      scope: 'agent.default',
    }), 1_700_000_000_000)
    expect(state.state).toBe('signed-in')
    if (state.state !== 'signed-in') return
    expect(state.credential.accessToken).toBe('mmoat_new')
    expect(state.credential.refreshToken).toBe('mmort_new')
    expect(state.credential.expiresAtMs).toBe(1_700_000_000_000 + 3_600_000)
  })

  it('does not call the server once the device code has expired', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return {} as Response }) as unknown as typeof fetch
    const state = await pollDeviceLogin({ ...SESSION, expiresAtMs: 1 }, 'cn', fetchImpl, 1_000)
    expect(state.state).toBe('expired')
    expect(called).toBe(false)
  })

  it('sends the device grant type and the verifier', async () => {
    const asked: URLSearchParams[] = []
    const fetchImpl = (async (_url: string, init: { body: URLSearchParams }) => {
      asked.push(init.body)
      return { ok: true, text: async () => JSON.stringify({ error: 'authorization_pending' }), status: 400 } as unknown as Response
    }) as unknown as typeof fetch
    await pollDeviceLogin(SESSION, 'cn', fetchImpl)
    expect(asked[0]?.get('grant_type')).toBe(DEVICE_CODE_GRANT)
    expect(asked[0]?.get('device_code')).toBe('device_code_example')
    expect(asked[0]?.get('code_verifier')).toBe('verifier_example')
  })
})

describe('refreshPluginCredential', () => {
  const credential: PluginCredential = {
    schemaVersion: 1,
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    accessToken: 'mmoat_old',
    refreshToken: 'mmort_old',
    expiresAtMs: 1_800_000_000_000,
  }

  it('keeps the rotated refresh token', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ access_token: 'mmoat_new', refresh_token: 'mmort_new', expires_in: 3600 }),
    }) as unknown as Response) as unknown as typeof fetch
    const next = await refreshPluginCredential(credential, 'cn', fetchImpl, 1_700_000_000_000)
    expect(next.accessToken).toBe('mmoat_new')
    // The server rotates the refresh token, so the new one has to replace the
    // old one or the next refresh fails.
    expect(next.refreshToken).toBe('mmort_new')
    expect(next.expiresAtMs).toBe(1_700_000_000_000 + 3_600_000)
  })

  it('refuses without a refresh token', async () => {
    await expect(refreshPluginCredential({ ...credential, refreshToken: undefined }, 'cn')).rejects.toThrow(/refresh token/)
  })
})
