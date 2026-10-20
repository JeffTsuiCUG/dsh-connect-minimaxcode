/**
 * The plugin's own credential and state.
 *
 * The plugin keeps its own files under the Harness home and never writes into
 * the desktop app's: the app's two files carry `generation` counters that must
 * stay in step, and writing there would look like a sign-in somewhere else.
 */

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dshHome,
  pluginCredentialPath,
  pluginStatePath,
  readPluginCredential,
  readPluginState,
  writePluginCredential,
  writePluginState,
} from '../src/credentials.ts'
import { dataDir } from '../src/auth.ts'

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'minimaxcode-home-'))
}

describe('the plugin\'s own files', () => {
  it('live under the Harness home, and honour DSH_HOME', () => {
    const env = { DSH_HOME: 'D:/custom-home' } as NodeJS.ProcessEnv
    expect(dshHome(env)).toBe('D:/custom-home')
    expect(pluginCredentialPath(env)).toContain('.minimaxcode-auth.json')
    expect(pluginStatePath(env)).toContain('.minimaxcode-state.json')
  })

  it('keep the credential out of the desktop app\'s directory', () => {
    const env = { DSH_HOME: 'D:/custom-home' } as NodeJS.ProcessEnv
    // The app's credential lives under the app's own data directory; the
    // plugin's must not be anywhere near it, or the app could mistake the
    // plugin's file for one of its own.
    const appDir = dataDir(env)
    expect(pluginCredentialPath(env).startsWith(appDir)).toBe(false)
    expect(pluginStatePath(env).startsWith(appDir)).toBe(false)
  })
})

describe('the credential', () => {
  it('round-trips', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    await writePluginCredential({
      schemaVersion: 1,
      clientId: 'mcode-public',
      scopes: ['agent.default'],
      audience: 'agent-backend',
      accessToken: 'mmoat_example',
      refreshToken: 'mmort_example',
      expiresAtMs: 1_800_000_000_000,
      obtainedAtMs: 1_700_000_000_000,
    }, env)
    const credential = await readPluginCredential(env)
    expect(credential?.accessToken).toBe('mmoat_example')
    expect(credential?.refreshToken).toBe('mmort_example')
    expect(credential?.expiresAtMs).toBe(1_800_000_000_000)
  })

  it('is readable by its owner only', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    await writePluginCredential({
      schemaVersion: 1,
      clientId: 'mcode-public',
      scopes: ['agent.default'],
      audience: 'agent-backend',
      accessToken: 'mmoat_example',
    }, env)
    const info = await stat(pluginCredentialPath(env))
    // Windows does not carry POSIX modes, so the mode is only checked where
    // it exists.
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600)
    }
  })

  it('reports nothing when there is no credential', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    expect(await readPluginCredential(env)).toBeUndefined()
  })

  it('ignores a file that is not a credential', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    await writePluginState({ schemaVersion: 1, autoCheckin: true }, env)
    // A state document in the credential's place is not a credential.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(pluginCredentialPath(env), 'not json')
    expect(await readPluginCredential(env)).toBeUndefined()
  })
})

describe('the state', () => {
  it('defaults to not claiming on its own', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    const state = await readPluginState(env)
    expect(state.autoCheckin).toBe(false)
  })

  it('round-trips the settings and the last claim', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    await writePluginState({
      schemaVersion: 1,
      autoCheckin: true,
      lastClaimDay: '2026-10-20',
      lastClaimAtMs: 1_700_000_000_000,
      lastClaimPoints: 1000,
    }, env)
    const state = await readPluginState(env)
    expect(state.autoCheckin).toBe(true)
    expect(state.lastClaimDay).toBe('2026-10-20')
    expect(state.lastClaimPoints).toBe(1000)
  })

  it('round-trips a pending device login', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    await writePluginState({
      schemaVersion: 1,
      autoCheckin: false,
      deviceLogin: {
        deviceCode: 'device_code_example',
        codeVerifier: 'verifier_example',
        userCode: 'XW6G-QEGA',
        verificationUri: 'https://account.minimax.cn/oauth-authorize',
        verificationUriComplete: 'https://account.minimax.cn/oauth-authorize?user_code=XW6G-QEGA',
        expiresAtMs: 1_800_000_000_000,
      },
    }, env)
    const state = await readPluginState(env)
    expect(state.deviceLogin?.userCode).toBe('XW6G-QEGA')
    expect(state.deviceLogin?.codeVerifier).toBe('verifier_example')
  })

  it('is written as a document a person can read', async () => {
    const env = { DSH_HOME: await home() } as NodeJS.ProcessEnv
    await writePluginState({ schemaVersion: 1, autoCheckin: true }, env)
    const text = await readFile(pluginStatePath(env), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text).autoCheckin).toBe(true)
  })
})
