/**
 * The diagnostics section: the facts a report is made of.
 *
 * The section exists so that a person can copy it into a report without
 * having to remember what to include. That only works if three things hold:
 * every line is a fact, nothing in it changes a setting, and the upstream's
 * own words travel verbatim.
 *
 * The cases below pin those three.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = readFileSync(join(ROOT, 'src', 'client.ts'), 'utf8')
const SERVER = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')

describe('the diagnostics section', () => {
  it('is drawn on the plugin page', () => {
    expect(CLIENT).toContain('data-minimax-diagnostics')
    expect(CLIENT).toContain('diagnosticsBlock(t, status?.diagnostics)')
  })

  it('has no control in it', () => {
    // The section is a list of facts. A button in it would be a setting
    // wearing a diagnostic's clothes.
    const start = CLIENT.indexOf('function diagnosticsBlock(')
    expect(start).toBeGreaterThan(-1)
    const body = CLIENT.slice(start, CLIENT.indexOf('\n      }', start))
    expect(body).not.toContain('onClick')
    expect(body).not.toContain('input')
    expect(body).not.toContain('button')
  })

  it('carries the upstream words as they arrived', () => {
    // The last error is the upstream's own text, not a summary of it.
    expect(SERVER).toContain('lastUpstreamError = error.verdict.upstream?.message ?? error.message')
    expect(CLIENT).toContain('add(t(\'diagnosticsLastError\'), diagnostics.lastUpstreamError)')
  })

  it('reports the plugin version from the installed package', () => {
    // The number has to be the one of the package that is installed, so it
    // is read at runtime rather than written into the bundle.
    expect(SERVER).toContain("new URL('../package.json', import.meta.url)")
    expect(SERVER).toContain('const PLUGIN_VERSION = readPluginVersion()')
    // And the read value is what the document carries — a constant that is
    // read but never used would say nothing.
    expect(SERVER).toContain('pluginVersion: PLUGIN_VERSION')
  })

  it('says which host capabilities it found', () => {
    // The eight pieces the card asks the host about are the facts that
    // decide whether a delivery can work at all.
    expect(CLIENT).toContain('diagnostics.capability')
    expect(SERVER).toContain('capability: capability.findings')
  })

  it('says it changes nothing', () => {
    // The hint tells the reader what the section is for, so a copy of it
    // does not look like a request for help.
    expect(CLIENT).toMatch(/diagnosticsHint: '[^']*只读[^']*'/)
    expect(CLIENT).toMatch(/diagnosticsHint: '[^']*read-only[^']*'/)
  })
})
