/**
 * The plugin's own credential and state.
 *
 * The desktop app signs in with the OAuth 2.0 device authorization grant
 * (RFC 8628): the app asks the authorization server for a device code, opens
 * the account page in the browser, and polls the token endpoint until the
 * person signed in. The plugin can run the same grant itself, which means the
 * plugin works on a machine where the desktop app was never installed, and
 * the only human step is the person signing in to their own account in their
 * own browser.
 *
 * What this module stores is deliberately *not* written into the desktop
 * app's files. The app keeps two files whose `generation` counters must stay
 * in step, and it treats a mismatch as "signed in somewhere else" and demands
 * a new sign-in; the plugin has no business writing there. So the plugin keeps
 * its own copy under the Harness home, next to the files the sibling desktop
 * connectors keep (`~/.dsh/.minimaxcode-auth.json`).
 *
 * @module dsh-connect-minimaxcode/credentials
 */

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MINIMAX_OAUTH_AUDIENCE,
  MINIMAX_OAUTH_CLIENT_ID,
  MINIMAX_OAUTH_SCOPES,
} from './credits.ts'
import type { MinimaxRegion } from './auth.ts'

/** The file the plugin's own credential lives in. */
export const PLUGIN_CREDENTIAL_FILENAME = '.minimaxcode-auth.json'

/** The file the plugin's own settings and session live in. */
export const PLUGIN_STATE_FILENAME = '.minimaxcode-state.json'

/** The credential the plugin obtained for itself. */
export interface PluginCredential {
  /** The document's shape. */
  schemaVersion: number
  /** The OAuth client the token was issued to. */
  clientId: string
  /** The scopes the token carries. */
  scopes: string[]
  /** The audience the token was issued for. */
  audience: string
  /** The `mmoat_` bearer token. */
  accessToken: string
  /** The refresh token, when the server issued one. */
  refreshToken?: string
  /** Expiry in milliseconds since the epoch. */
  expiresAtMs?: number
  /** When the token was obtained, in milliseconds since the epoch. */
  obtainedAtMs?: number
}

/** A device login waiting for the person to authorize it. */
export interface DeviceLoginSession {
  /** The device code the token endpoint is polled with. */
  deviceCode: string
  /** The PKCE verifier that goes with the device code. */
  codeVerifier: string
  /** The code the person types on the account page. */
  userCode: string
  /** Where to authorize. */
  verificationUri: string
  /** Where to authorize, with the code filled in. */
  verificationUriComplete: string
  /** When the device code stops working, in milliseconds since the epoch. */
  expiresAtMs: number
}

/** The plugin's own settings. */
export interface PluginState {
  /** The document's shape. */
  schemaVersion: number
  /** Whether the plugin claims the daily grant on its own. */
  autoCheckin: boolean
  /** The day the last claim happened, in the account's time zone. */
  lastClaimDay?: string
  /** When the last claim happened, in milliseconds since the epoch. */
  lastClaimAtMs?: number
  /** The points the last claim granted. */
  lastClaimPoints?: number
  /** A device login waiting to be authorized. */
  deviceLogin?: DeviceLoginSession
}

/**
 * The Harness home.
 *
 * The host resolves it the same way: the `DSH_HOME` environment variable when
 * it is set, otherwise `~/.dsh`. The plugin resolves it on its own rather
 * than importing the host's helper, so it also works in a plain command line
 * where the host's packages are not installed.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME
  return typeof override === 'string' && override.length > 0 ? override : join(homedir(), '.dsh')
}

/** Where the plugin's credential lives. */
export function pluginCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), PLUGIN_CREDENTIAL_FILENAME)
}

/** Where the plugin's state lives. */
export function pluginStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), PLUGIN_STATE_FILENAME)
}

/** Write a document atomically, readable by its owner only. */
async function writePrivate(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Read the plugin's own credential. */
export async function readPluginCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginCredential | undefined> {
  let text: string
  try {
    text = await readFile(pluginCredentialPath(env), 'utf8')
  } catch {
    return undefined
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const record = document as Record<string, unknown>
  const accessToken = record.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  const expiresAtMs = typeof record.expiresAtMs === 'number' ? record.expiresAtMs : undefined
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    clientId: typeof record.clientId === 'string' ? record.clientId : MINIMAX_OAUTH_CLIENT_ID,
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((s): s is string => typeof s === 'string') : [...MINIMAX_OAUTH_SCOPES],
    audience: typeof record.audience === 'string' ? record.audience : MINIMAX_OAUTH_AUDIENCE,
    accessToken,
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
    expiresAtMs,
    obtainedAtMs: typeof record.obtainedAtMs === 'number' ? record.obtainedAtMs : undefined,
  }
}

/** Write the plugin's own credential. */
export async function writePluginCredential(
  credential: PluginCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writePrivate(pluginCredentialPath(env), credential)
}

/** Remove the plugin's own credential, which is what signing out means. */
export async function deletePluginCredential(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(pluginCredentialPath(env), { force: true })
}

/** Read the plugin's own state. */
export async function readPluginState(env: NodeJS.ProcessEnv = process.env): Promise<PluginState> {
  let text: string
  try {
    text = await readFile(pluginStatePath(env), 'utf8')
  } catch {
    return { schemaVersion: 1, autoCheckin: false }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { schemaVersion: 1, autoCheckin: false }
  }
  if (typeof document !== 'object' || document === null) return { schemaVersion: 1, autoCheckin: false }
  const record = document as Record<string, unknown>
  const session = record.deviceLogin
  const deviceLogin = typeof session === 'object' && session !== null
    ? (() => {
        const value = session as Record<string, unknown>
        if (typeof value.deviceCode !== 'string' || typeof value.codeVerifier !== 'string') return undefined
        return {
          deviceCode: value.deviceCode,
          codeVerifier: value.codeVerifier,
          userCode: typeof value.userCode === 'string' ? value.userCode : '',
          verificationUri: typeof value.verificationUri === 'string' ? value.verificationUri : '',
          verificationUriComplete: typeof value.verificationUriComplete === 'string' ? value.verificationUriComplete : '',
          expiresAtMs: typeof value.expiresAtMs === 'number' ? value.expiresAtMs : 0,
        }
      })()
    : undefined
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    autoCheckin: record.autoCheckin === true,
    lastClaimDay: typeof record.lastClaimDay === 'string' ? record.lastClaimDay : undefined,
    lastClaimAtMs: typeof record.lastClaimAtMs === 'number' ? record.lastClaimAtMs : undefined,
    lastClaimPoints: typeof record.lastClaimPoints === 'number' ? record.lastClaimPoints : undefined,
    deviceLogin,
  }
}

/** Write the plugin's own state. */
export async function writePluginState(
  state: PluginState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writePrivate(pluginStatePath(env), state)
}

/** Whether the credential is close enough to expiry to be worth refreshing. */
export function credentialNeedsRefresh(credential: PluginCredential, now = Date.now()): boolean {
  if (credential.expiresAtMs === undefined) return false
  return credential.expiresAtMs - now <= 2 * 60 * 1000
}

/** The credential in the shape the account endpoints expect. */
export function toOAuthCredential(credential: PluginCredential) {
  return {
    token: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs,
    clientId: credential.clientId,
    scopes: credential.scopes,
    audience: credential.audience,
  }
}

/** The region a plugin credential belongs to; the plugin is CN-only today. */
export const PLUGIN_CREDENTIAL_REGION: MinimaxRegion = 'cn'
