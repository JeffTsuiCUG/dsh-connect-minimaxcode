/**
 * The range of hosts the plugin claims to work on.
 *
 * The floor is not a guess: the host publishes its packages under the same
 * version numbers as the desktop, and each host capability the plugin uses
 * was found in a specific version of those packages. Two of them set the
 * floor — the `plugins.bundle.config` slot the plugin page lives in, and the
 * `cordis.patch` manifest patch — and both begin at `0.1.6-alpha.2`.
 *
 * These cases pin that number, so a later edit cannot quietly raise the
 * floor again, and so the peer ranges cannot drift away from it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  engines?: { dsh?: string }
  peerDependencies?: Record<string, string>
}

/** The oldest host release where every advertised feature exists. */
const FLOOR = '0.1.6-alpha.2'

describe('the supported host range', () => {
  it('admits every host from the floor upwards', () => {
    const range = PACKAGE.engines?.dsh ?? ''
    expect(range).toContain(`>=${FLOOR}`)
    // The upper bound keeps the plugin off the next major line.
    expect(range).toContain('<0.3.0-0')
  })

  it('asks the host packages for the same floor, so an older host satisfies them', () => {
    // The host ships its packages under its own version number; a peer range
    // that starts later would leave an older host unable to satisfy it.
    for (const [name, range] of Object.entries(PACKAGE.peerDependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      expect(range, `${name} 的下限与宿主版本不一致`).toContain(`>=${FLOOR}`)
    }
  })

  it('leaves the pi-ai contract at the version that introduced it', () => {
    // The provider shape the plugin builds — `createProvider` with `auth`,
    // `api` and `models` — is present from 0.85.1 onwards.
    expect(PACKAGE.peerDependencies?.['@earendil-works/pi-ai']).toBe('>=0.85.1')
  })
})
