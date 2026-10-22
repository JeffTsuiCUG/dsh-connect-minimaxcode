/**
 * The package metadata the Host reads for a plugin's own page.
 *
 * The Host resolves a plugin's display title, description and icon from the
 * package root, not from the plugin's runtime: the title and description
 * come from `locale/<language>.json` (English is the anchor file) and the
 * icon comes from a relative path in `package.json` or from an exported
 * `<package>/icon` resource. A mistake here is invisible in the code and
 * visible only on the plugin's page, so the contract is pinned here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string
  icon?: string
  exports: Record<string, unknown>
  files: string[]
}

/** The media types the Host admits, keyed by file extension. */
const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
/** The Host refuses an icon larger than this. */
const MAX_ICON_BYTES = 256 * 1024
/** A language id, as the Host's own pattern accepts it. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

describe('package metadata', () => {
  it('declares an icon inside the package root', () => {
    expect(typeof PACKAGE.icon).toBe('string')
    const icon = PACKAGE.icon as string
    // A relative path: the Host refuses absolute paths and URLs.
    expect(icon.startsWith('./')).toBe(true)
    expect(icon).not.toMatch(/^[A-Za-z][A-Za-z\d+.-]*:/u)
    const file = resolve(ROOT, icon)
    expect(file.startsWith(resolve(ROOT))).toBe(true)
    expect(ICON_EXTENSIONS).toContain(extname(file).toLowerCase())
    expect(statSync(file).isFile()).toBe(true)
    expect(statSync(file).size).toBeLessThanOrEqual(MAX_ICON_BYTES)
  })

  it('publishes the icon and the locale directory', () => {
    expect(PACKAGE.files).toContain('icon.svg')
    expect(PACKAGE.files).toContain('locale')
  })

  it('exports the locale directory so the Host can read it', () => {
    // The Host resolves `<package>/locale/en.json` through the package's
    // exports; without this entry it finds nothing and falls back.
    expect(Object.keys(PACKAGE.exports)).toContain('./locale/*')
  })

  it('ships an English anchor locale and a Chinese one', () => {
    const dir = join(ROOT, 'locale')
    const files = readdirSync(dir).filter(name => name.endsWith('.json'))
    expect(files).toContain('en.json')
    expect(files).toContain('zh.json')
    for (const name of files) {
      // The file name is the language id.
      expect(name.slice(0, -5)).toMatch(LANGUAGE_ID)
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        meta?: { title?: string; description?: string }
      }
      expect(typeof parsed.meta?.title).toBe('string')
      expect((parsed.meta?.title as string).trim()).not.toBe('')
      expect(typeof parsed.meta?.description).toBe('string')
      expect((parsed.meta?.description as string).trim()).not.toBe('')
    }
  })

  it('gives the two languages different text', () => {
    const read = (name: string) => JSON.parse(readFileSync(join(ROOT, 'locale', name), 'utf8')) as {
      meta: { title: string; description: string }
    }
    const en = read('en.json')
    const zh = read('zh.json')
    // A shared title is fine (it is a product name); a shared description
    // would mean one language was never written.
    expect(en.meta.description).not.toBe(zh.meta.description)
  })
})
