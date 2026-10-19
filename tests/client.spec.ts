/**
 * The browser half must be loadable the way the host loads it.
 *
 * A client bundle that throws during activation takes the whole web app down
 * with it, so the contract is pinned here rather than discovered in the app:
 * the artifact is a classic script, it registers itself with the host's
 * module loader under the package name, and the plugin it returns registers
 * exactly one slot in the composer's dock.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** The status document the pill reads. */
const STATUS = {
  credits: {
    state: 'ok',
    total: 11326.884,
    purchased: 0,
    free: 11326.884,
    consumed: 12.5,
    expiring: 2858.09,
    expiringLots: 2,
    expiringSoon: 9258.09,
    nextExpiryAtMs: Date.parse('2026-10-29T00:00:00Z'),
    upcoming: [{ amount: 2858.09, expireAtMs: Date.parse('2026-10-29T00:00:00Z') }],
  },
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 8000,
    estimatedCny: 0.0042,
    lastCny: 0.002,
    lastModel: 'MiniMax-M3.1-Flash',
    requests: 3,
  },
}

/**
 * A React stand-in that keeps state between renders.
 *
 * The pill reads its data in an effect, so a single call would always render
 * the empty state. This harness keeps the state the way React does and lets
 * the test render again once the fetch has resolved.
 */
function reactHarness() {
  const states: unknown[] = []
  let cursor = 0
  const react = {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => ({
      type,
      props: (props ?? {}) as Record<string, unknown>,
      children,
    }),
    useState: (initial: unknown) => {
      const index = cursor++
      if (states.length <= index) {
        states[index] = initial
      }
      return [states[index], (next: unknown) => {
        states[index] = next
      }]
    },
    useEffect: (effect: () => unknown) => {
      void effect()
    },
  }
  return {
    react,
    render(component: (props: unknown) => unknown, props: unknown) {
      cursor = 0
      return component(props)
    },
  }
}

interface Loaded {
  registrations: { id: string; factory(require: (id: string) => unknown): { inject: string[]; apply(ctx: unknown): void } }[]
  slotNames: string[]
  slots: { options: { name: string; id?: string; key?: string; order?: number }; component: (props: unknown) => unknown }[]
}

/** Load the built artifact the way the host's loader does. */
function loadClient(): Loaded {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const loaded: Loaded = { registrations: [], slotNames: [], slots: [] }
  const sandbox: Record<string, unknown> = {
    fetch: async () => ({ ok: true, json: async () => STATUS }),
    setInterval: () => 0,
    clearInterval: () => {},
  }
  sandbox.globalThis = sandbox
  sandbox.__ModuleLoader__ = {
    load: (config: Loaded['registrations'][number]) => { loaded.registrations.push(config) },
  }
  runInContext(source, createContext(sandbox))
  return loaded
}

describe('client bundle', () => {
  it('is a classic script, not a module', () => {
    const source = readFileSync(CLIENT_PATH, 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/^\s*export\s/m)
    expect(source).not.toMatch(/\bmodule\.exports\b/)
  })

  it('registers itself with the host module loader under the package name', () => {
    const { registrations } = loadClient()
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.id).toBe('dsh-connect-minimaxcode')
  })

  it('declares the client services it needs', () => {
    const { registrations } = loadClient()
    const harness = reactHarness()
    const plugin = registrations[0]!.factory((id: string) => {
      if (id === 'react') return harness.react
      throw new Error(`unexpected require: ${id}`)
    })
    expect(plugin.inject).toContain('slots')
    expect(plugin.inject).toContain('locale')
  })

  it('registers one slot in the composer dock and nothing else', () => {
    const loaded = loadClient()
    const plugin = loaded.registrations[0]!.factory(() => reactHarness().react)
    plugin.apply({
      slots: {
        inject: (name: string, register: () => unknown) => {
          loaded.slotNames.push(name)
          return register()
        },
        register: (options: { name: string; id?: string; order?: number }, component: (props: unknown) => unknown) => {
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: {
        register: () => {},
        bind: () => (key: string) => key,
      },
      effect: (effect: () => unknown) => effect(),
    })
    expect(loaded.slotNames).toEqual(['conversation.composer.dock', 'plugins.bundle.config'])
    expect(loaded.slots).toHaveLength(2)
    expect(loaded.slots[0]?.options.name).toBe('conversation.composer.dock')
    expect(loaded.slots[0]?.options.id).toBe('minimax-credits')
    // The page card is keyed by the package name, which is how the plugins
    // page finds the entry that belongs to this bundle.
    expect(loaded.slots[1]?.options.name).toBe('plugins.bundle.config')
    expect(loaded.slots[1]?.options.key).toBe('dsh-connect-minimaxcode')
  })

  it('shows the credits that are about to expire', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    let page: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (_options: unknown, rendered: (props: unknown) => unknown) => {
          page = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    // The first render subscribes to the shared store, which starts the
    // ticker; the second render sees what it fetched. Without a `t` prop the
    // card falls back to its own copy, so the text is the real Chinese one.
    harness.render(page!, { view: 'page' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const tree = JSON.stringify(harness.render(page!, { view: 'page' }))
    expect(tree).toContain('即将过期')
    expect(tree).toContain('2,858.09')
    expect(tree).toContain('2026-10-29')
    expect(tree).toMatch(/11[,.]?326[.,]88/)
  })

  it('renders the balance it was given', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    let component: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (_options: unknown, rendered: (props: unknown) => unknown) => {
          component = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    const props = { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` }

    // The first render has no data yet: the pill says so rather than lying.
    const first = JSON.stringify(harness.render(component!, props))
    expect(first).toContain('unavailable')

    // Once the status route answered, the balance is shown.
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = JSON.stringify(harness.render(component!, props))
    expect(second).toContain('balance')
    // The amount is grouped for the reader, so the digits are matched loosely.
    expect(second).toMatch(/11[,.]?326[.,]88/)
  })
})
