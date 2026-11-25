/**
 * The browser half must be loadable the way the host loads it.
 *
 * A client bundle that throws during activation takes the whole web app down
 * with it, so the contract is pinned here rather than discovered in the app:
 * the artifact is a classic script, it registers itself with the host's
 * module loader under the package name, the readout sits in the composer's
 * tool row beside the model picker, and it is only drawn — and only polled —
 * while this plugin's own provider is the one selected.
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
  const refs: { current: unknown }[] = []
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
    useRef: (initial: unknown) => {
      const index = cursor++
      if (refs.length <= index) {
        refs[index] = { current: initial }
      }
      return refs[index]!
    },
    useEffect: (effect: () => unknown) => {
      void effect()
    },
  }
  return {
    react,
    /**
     * Start from empty slots.
     *
     * The slots are positional, so a component rendered after another one
     * would read that one's state. Rendering a single component in isolation
     * has to clear them first.
     */
    reset() {
      states.length = 0
      refs.length = 0
      cursor = 0
    },
    render(component: (props: unknown) => unknown, props: unknown) {
      cursor = 0
      return component(props)
    },
  }
}

/**
 * Render a registered component through the gate that may wrap it.
 *
 * The gate returns the pill as its own element so the pill's hooks can come
 * and go with the selection; unwrapping one level reaches what a person sees.
 */
function renderDeep(
  harness: ReturnType<typeof reactHarness>,
  component: (props: unknown) => unknown,
  props: unknown,
): unknown {
  const first = harness.render(component, props)
  if (typeof first === 'object' && first !== null && typeof (first as { type?: unknown }).type === 'function') {
    const element = first as { type: (childProps: unknown) => unknown; props: unknown }
    return harness.render(element.type, element.props)
  }
  return first
}

interface Loaded {
  registrations: { id: string; factory(require: (id: string) => unknown): { inject: string[]; apply(ctx: unknown): void } }[]
  slotNames: string[]
  slots: {
    options: { name: string; id?: string; key?: string; order?: number; inject?: () => Record<string, unknown> }
    component: (props: unknown) => unknown
  }[]
  /** How many times the sandboxed status route has been fetched. */
  fetchCount: number
}

/** Load the built artifact the way the host's loader does. */
function loadClient(status: unknown = STATUS): Loaded {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const loaded: Loaded = { registrations: [], slotNames: [], slots: [], fetchCount: 0 }
  const sandbox: Record<string, unknown> = {
    fetch: async () => {
      loaded.fetchCount += 1
      return { ok: true, json: async () => status }
    },
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

  it('registers the readout in the composer tool row and nothing else', () => {
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
    // The tool row, not the ambient strip below the composer: the balance
    // belongs beside the model picker that decides whose balance it is.
    expect(loaded.slotNames).toEqual([
      'conversation.input.left', 'conversation.input.left', 'conversation.input.left', 'plugins.bundle.config',
    ])
    expect(loaded.slots).toHaveLength(4)
    // The balance readout, image dock and image options pill sit side by side in the tool row:
    // all belong to the provider the picker has selected.
    expect(loaded.slots[0]?.options.name).toBe('conversation.input.left')
    expect(loaded.slots[0]?.options.id).toBe('minimax-credits')
    expect(loaded.slots[0]?.options.order).toBe(4)
    expect(loaded.slots[1]?.options.name).toBe('conversation.input.left')
    expect(loaded.slots[1]?.options.id).toBe('minimax-generate')
    expect(loaded.slots[1]?.options.order).toBe(5)
    expect(loaded.slots[2]?.options.name).toBe('conversation.input.left')
    expect(loaded.slots[2]?.options.id).toBe('minimax-image-options')
    expect(loaded.slots[2]?.options.order).toBe(6)
    // The page card is keyed by the package name, which is how the plugins
    // page finds the entry that belongs to this bundle.
    expect(loaded.slots[3]?.options.name).toBe('plugins.bundle.config')
    expect(loaded.slots[3]?.options.key).toBe('dsh-connect-minimaxcode')
  })

  it('injects the bound locale into every slot', () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    plugin.apply({
      slots: {
        inject: (name: string, register: () => unknown) => {
          loaded.slotNames.push(name)
          return register()
        },
        register: (options: { name: string; id?: string; key?: string; order?: number; inject?: () => Record<string, unknown> }, component: (props: unknown) => unknown) => {
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: {
        register: () => {},
        // A translator that echoes its key, so the test can tell it apart
        // from the components' own Chinese copy.
        bind: () => (key: string) => `T:${key}`,
      },
      effect: (effect: () => unknown) => effect(),
    })
    // The composer and plugin-page slots carry no translator of their own,
    // so the bound one has to be injected into both.
    expect(loaded.slots).toHaveLength(4)
    for (const slot of loaded.slots) {
      expect(typeof slot.options.inject).toBe('function')
      const props = slot.options.inject!()
      expect(typeof props.t).toBe('function')
      expect((props.t as (key: string) => string)('balance')).toBe('T:balance')
    }
  })

  it('renders the injected translation rather than its own Chinese copy', () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: { name: string; id?: string; key?: string; order?: number; inject?: () => Record<string, unknown> }, component: (props: unknown) => unknown) => {
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: {
        register: () => {},
        bind: () => (key: string) => `T:${key}`,
      },
      effect: (effect: () => unknown) => effect(),
    })
    const slot = loaded.slots.find(entry => entry.options.id === 'minimax-credits')!
    const tree = JSON.stringify(renderDeep(harness, slot.component, { ...slot.options.inject!() }))
    // The host's translator wins; the Chinese fallback stays out of it.
    expect(tree).toContain('T:unavailable')
    expect(tree).not.toContain('积分不可用')
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
    // The expiring row names its window and carries only the amount; the date
    // it lands on is the pill detail's row, not the page card's.
    expect(tree).toContain('3天内过期')
    expect(tree).toContain('2,858.09')
    expect(tree).not.toContain('即将过期')
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
        register: (options: { name?: string; id?: string }, rendered: (props: unknown) => unknown) => {
          // The tool-row readout, not the image dock or the page card.
          if (options?.id === 'minimax-credits') component = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    const props = { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` }

    // The first render has no data yet: the pill says so rather than lying.
    const first = JSON.stringify(renderDeep(harness, component!, props))
    expect(first).toContain('unavailable')

    // Once the status route answered, the balance is shown.
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = JSON.stringify(renderDeep(harness, component!, props))
    expect(second).toContain('balance')
    // The amount is grouped for the reader, so the digits are matched loosely.
    expect(second).toMatch(/11[,.]?326[.,]88/)
  })

  /**
   * Render the pill once the status route has answered, with the given
   * rate-limit windows riding on the shared status fixture.
   */
  async function pillWithWindows(rateLimit: unknown): Promise<string> {
    const loaded = loadClient({ ...STATUS, rateLimit })
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    let component: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: { name?: string; id?: string }, rendered: (props: unknown) => unknown) => {
          if (options?.id === 'minimax-credits') component = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    const props = { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` }
    // The first render starts the fetch; the second one sees the answer.
    renderDeep(harness, component!, props)
    await new Promise(resolve => setTimeout(resolve, 10))
    return JSON.stringify(renderDeep(harness, component!, props))
  }

  /**
   * A metered window. Its length comes from its own edges, which is what the
   * pill names it by — so the fixture's span is the label the pill shows.
   */
  const window = (usedPercent: number, durationMs = 5 * 60 * 60_000) => {
    const start = Date.now()
    return { usedPercent, startAtMs: start, resetAtMs: start + durationMs }
  }

  it('leads with the short window while nothing is used up', async () => {
    const pill = await pillWithWindows({
      state: 'ok',
      interval: window(50),
      weekly: window(29),
    })
    expect(pill).toContain('5h')
    expect(pill).toContain('50%')
    expect(pill).not.toContain('"balance')
  })

  it('names the window by the length the server gives it', async () => {
    // The plan's terms have changed before: a three-hour window must read
    // "3h", not the five hours the plan meters today.
    const pill = await pillWithWindows({
      state: 'ok',
      interval: window(50, 3 * 60 * 60_000),
      weekly: window(29, 3 * 60 * 60_000),
    })
    expect(pill).toContain('3h')
    expect(pill).not.toContain('5h')
  })

  it('shows the balance once the short window is used up', async () => {
    const pill = await pillWithWindows({
      state: 'ok',
      interval: window(100),
      weekly: window(29),
    })
    expect(pill).toContain('"balance')
    expect(pill).not.toContain('5h  100%')
  })

  it('shows the balance once the weekly window is used up', async () => {
    const pill = await pillWithWindows({
      state: 'ok',
      interval: window(50),
      weekly: window(100),
    })
    expect(pill).toContain('"balance')
  })

  it('falls back to the balance when no windows were read', async () => {
    const pill = await pillWithWindows({ state: 'unavailable' })
    expect(pill).toContain('"balance')
    expect(pill).not.toContain('5h')
  })

  /** The registered readout component (the tool-row seat), bound to the test's harness. */
  function registeredComponent(loaded: Loaded, harness: ReturnType<typeof reactHarness>): (props: unknown) => unknown {
    // The same harness instance the test renders with: the component's hooks
    // must share the state the assertions read.
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    let component: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        // Two slots register; the readout is the one in the tool row.
        register: (options: { name?: string; id?: string }, rendered: (props: unknown) => unknown) => {
          if (options?.id === 'minimax-credits') component = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    if (component === undefined) throw new Error('no readout component registered')
    return component
  }

  it('hides the readout while another provider is selected', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const component = registeredComponent(loaded, harness)

    const projection = { next: { provider: 'workbuddy' }, lastUsed: { provider: 'minimaxcode' } }
    const tree = harness.render(component, { useProjection: () => projection })
    // Nothing at all: another connector's balance would be the wrong number.
    expect(tree).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 15))
    // The gate's hooks run before its conditional return — React tracks
    // hooks by order, and a hook that skipped a render used to make the
    // component collapse on the way back. The shared store therefore
    // subscribes even while hidden, which costs one lightweight poll and
    // keeps the gate stable across the provider changes it guards.
    expect(loaded.fetchCount).toBe(1)
  })

  it('draws the readout when a MiniMax model is the one selected', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const component = registeredComponent(loaded, harness)
    const props = { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` }

    // `next` is what the picker wrote for the next request; `lastUsed` is
    // what the previous request used. Either naming MiniMax counts.
    for (const projection of [
      { next: { provider: 'minimaxcode' }, lastUsed: { provider: 'workbuddy' } },
      { lastUsed: { provider: 'minimaxcode' } },
      {},
    ]) {
      const withProjection = { ...props, useProjection: () => projection }
      const first = renderDeep(harness, component, withProjection)
      expect(first).not.toBeNull()
      await new Promise(resolve => setTimeout(resolve, 10))
      const second = JSON.stringify(renderDeep(harness, component, withProjection))
      expect(second).toContain('balance')
    }
    expect(loaded.fetchCount).toBeGreaterThan(0)
  })

  it('keeps the readout when the host offers no projection at all', () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const component = registeredComponent(loaded, harness)
    // An older host, or a slot the host forgot to hand the hook to: the
    // balance is still true, so it is still shown.
    expect(harness.render(component, {})).not.toBeNull()
  })

  it('shows the account usage profile the upstream summarized', async () => {
    const loaded = loadClient({
      credits: { state: 'ok', total: 100, purchased: 0, free: 100, consumed: 0 },
      usageProfile: {
        state: 'ok',
        totalDays: 90,
        activeDays: 30,
        consecutiveDays: 4,
        totalTokenConsumed: '826.14M',
        rankingPercent: 10.296932108741714,
        mostActiveDay: { date: '2026-10-19', tokenCount: '234.25M' },
      },
    })
    const harness = reactHarness()
    let page: ((props: unknown) => unknown) | undefined
    loaded.registrations[0]!.factory(() => harness.react).apply({
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
    harness.render(page!, { view: 'page' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const tree = JSON.stringify(harness.render(page!, { view: 'page' }))
    expect(tree).toContain('连续使用 4 天')
    expect(tree).toContain('90')
    expect(tree).toContain('30')
    expect(tree).toContain('826.14M')
    expect(tree).toContain('10.3')
    expect(tree).toContain('2026-10-19')
  })

  it('says why there are no usage windows when the plan has none', async () => {
    const loaded = loadClient({
      credits: { state: 'ok', total: 100, purchased: 0, free: 100, consumed: 0 },
      rateLimit: { state: 'unavailable', reason: 'no-subscription' },
    })
    const harness = reactHarness()
    let page: ((props: unknown) => unknown) | undefined
    loaded.registrations[0]!.factory(() => harness.react).apply({
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
    harness.render(page!, { view: 'page' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const tree = JSON.stringify(harness.render(page!, { view: 'page' }))
    // The rolling windows belong to the subscription; an account holding only
    // a credit package has none, and the card says so rather than leaving the
    // reader to wonder whether a read failed.
    expect(tree).toContain('未订阅 M Plan')
  })

  it('shows the H3 image options pill only when an H3 image model is selected', async () => {
    const loaded = loadClient({
      ...STATUS,
      imageDefaults: { aspectRatio: '16:9', area: '2K' },
      generation: {
        imageModels: ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'],
        imageAspectRatios: ['auto', '16:9', '1:1'],
        imageAreas: ['1K', '2K', '4K'],
        videoDurations: [5],
        videoResolutions: ['768P'],
        videoRatios: ['16:9'],
      },
    })
    const harness = reactHarness()
    let optionsSlot: ((props: unknown) => unknown) | undefined
    loaded.registrations[0]!.factory(() => harness.react).apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: { id?: string }, rendered: (props: unknown) => unknown) => {
          if (options?.id === 'minimax-image-options') optionsSlot = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    expect(optionsSlot).toBeDefined()

    // Hidden for text models or other providers.
    expect(harness.render(optionsSlot!, {
      useProjection: () => ({ next: { provider: 'minimaxcode', model: 'MiniMax-M3' } }),
    })).toBeNull()
    expect(harness.render(optionsSlot!, {
      useProjection: () => ({ next: { provider: 'other', model: 'MiniMax-H3-Image' } }),
    })).toBeNull()

    // Shown when an H3 image model is active (including provider prefix).
    const activeProps = {
      useProjection: () => ({ next: { provider: 'minimaxcode', model: 'minimaxcode/MiniMax-H3-Image-Highspeed' } }),
    }
    const first = renderDeep(harness, optionsSlot!, activeProps)
    expect(first).not.toBeNull()
    await new Promise(resolve => setTimeout(resolve, 15))
    const second = JSON.stringify(renderDeep(harness, optionsSlot!, activeProps))
    expect(second).toContain('16:9')
    expect(second).toContain('2K')
  })
})

describe('the video controls follow the model they belong to', () => {
  /**
   * Read back the <select> controls the panel offers for video.
   *
   * Which combinations a model accepts is the endpoint's own answer, not our
   * taste: `MiniMax-H3-Max` refuses 4 seconds and 2K while `MiniMax-H3`
   * takes both, and a Go plan refuses `MiniMax-H3` outright (2068, measured
   * 2026-11-25). Offering a combination that is certain to be refused spends
   * an attempt that cannot succeed, so each model's row is checked against
   * the limits it actually has.
   */
  async function videoSelects(generation: Record<string, unknown>): Promise<{
    model: string[]
    duration: string[]
    resolution: string[]
    ratio: string[]
    chosen: { model: string; duration: string; resolution: string; ratio: string }
  }> {
    const harness = reactHarness()
    const loaded = loadClient({ ...STATUS, generation })
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    let page: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: { name?: string }, rendered: (props: unknown) => unknown) => {
          if (options?.name === 'plugins.bundle.config') page = rendered
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    expect(page, 'the plugin page is not registered').toBeDefined()

    const findPanel = (node: unknown): { type: (props: unknown) => unknown; props: unknown } | undefined => {
      if (typeof node !== 'object' || node === null) return undefined
      const element = node as { type?: unknown; props?: unknown; children?: unknown[] }
      if (typeof element.type === 'function' && (element.type as { name?: string }).name === 'GenerationPanel') {
        return element as { type: (props: unknown) => unknown; props: unknown }
      }
      for (const child of element.children ?? []) {
        const found = findPanel(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    const panel = findPanel(harness.render(page!, { view: 'page' }))
    expect(panel, 'the page does not draw the generation panel').toBeDefined()

    // The panel is rendered on its own, so its hook slots start empty: the
    // page's own state would otherwise sit in the slots the panel reads.
    harness.reset()
    harness.render(panel!.type, panel!.props)
    // The panel reads the status in an effect; the fetch settles a tick later.
    await new Promise(resolve => setTimeout(resolve, 15))
    // The panel opens on the picture tab, so the video row only exists after
    // the video tab is chosen: the click is what a person does first.
    const tree = harness.render(panel!.type, panel!.props) as unknown
    const press = (node: unknown, label: string): boolean => {
      if (typeof node !== 'object' || node === null) return false
      const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
      if (element.type === 'button') {
        const text = (element.children ?? []).map(child => typeof child === 'string' ? child : '').join('')
        if (text === label) {
          ;(element.props?.onClick as (() => void) | undefined)?.()
          return true
        }
      }
      for (const child of element.children ?? []) if (press(child, label)) return true
      return false
    }
    // The label comes from the injected translator, which is the identity
    // here, so the Chinese copy is what a person sees.
    expect(press(tree, '视频'), 'the panel offers no video tab').toBe(true)
    const videoTree = harness.render(panel!.type, panel!.props) as unknown

    const walk = (node: unknown, found: { value: string; options: string[] }[]): void => {
      if (typeof node !== 'object' || node === null) return
      const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
      if (element.type === 'select') {
        const children = (element.children ?? []) as { props?: Record<string, unknown> }[]
        found.push({
          value: String(element.props?.value ?? ''),
          options: children.map(child => String(child.props?.value ?? '')),
        })
        return
      }
      for (const child of element.children ?? []) walk(child, found)
    }
    const selects: { value: string; options: string[] }[] = []
    walk(videoTree, selects)

    // The video row is the one whose first select lists nothing but video
    // models: a test may hand it a single model, so the name to look for is
    // the prefix the endpoint uses, not one model in particular.
    const row = selects.find(entry =>
      entry.options.length > 0 && entry.options.every(option => option.startsWith('MiniMax-H3')))
    expect(row, 'the video row offers no model choice').toBeDefined()
    const index = selects.indexOf(row!)
    const rowSelects = selects.slice(index, index + 4)
    expect(rowSelects.length, 'the video row is missing a control').toBe(4)
    const [model, duration, resolution, ratio] = rowSelects
    return {
      model: model!.options,
      duration: duration!.options,
      resolution: resolution!.options,
      ratio: ratio!.options,
      chosen: {
        model: model!.value,
        duration: duration!.value,
        resolution: resolution!.value,
        ratio: ratio!.value,
      },
    }
  }

  const limits = {
    'MiniMax-H3-Max': { durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480P', '720P', '768P'], ratios: ['21:9', '16:9'] },
    'MiniMax-H3': { durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480P', '720P', '768P', '2K'], ratios: ['21:9', '16:9'] },
  }

  it('offers both video models, defaulting to the one a subscribed account can use', async () => {
    const row = await videoSelects({
      imageModels: ['MiniMax-H3-Image'],
      imageAspectRatios: ['auto'],
      imageAreas: ['1K'],
      videoModels: ['MiniMax-H3-Max', 'MiniMax-H3'],
      videoDurations: [5],
      videoResolutions: ['768P'],
      videoRatios: ['16:9'],
      videoModelOptions: limits,
    })
    expect(row.model).toEqual(['MiniMax-H3-Max', 'MiniMax-H3'])
    expect(row.chosen.model).toBe('MiniMax-H3-Max')
  })

  it('does not offer 4 seconds or 2K on the model that refuses them', async () => {
    const row = await videoSelects({
      imageModels: ['MiniMax-H3-Image'],
      imageAspectRatios: ['auto'],
      imageAreas: ['1K'],
      videoModels: ['MiniMax-H3-Max'],
      videoDurations: [4, 5],
      videoResolutions: ['768P', '2K'],
      videoRatios: ['16:9'],
      videoModelOptions: limits,
    })
    expect(row.duration).not.toContain('4')
    expect(row.resolution).not.toContain('2K')
  })

  it('narrows the aspect ratios when 720P is the chosen resolution', async () => {
    // 720P is legal on both models but takes only 16:9 and 9:16, answering
    // "invalid params, resolution 720P only supports ratio 16:9 or 9:16" for
    // the rest (measured 2026-11-25). The model here accepts 4:3 at other
    // resolutions, so a panel that forgot the limit would list it.
    const row = await videoSelects({
      imageModels: ['MiniMax-H3-Image'],
      imageAspectRatios: ['auto'],
      imageAreas: ['1K'],
      videoModels: ['MiniMax-H3-Max'],
      videoDurations: [5],
      videoResolutions: ['720P'],
      videoRatios: ['16:9'],
      videoModelOptions: {
        'MiniMax-H3-Max': { durations: [5], resolutions: ['720P'], ratios: ['4:3', '16:9', '9:16'] },
      },
    })
    expect(row.chosen.resolution).toBe('720P')
    expect(row.ratio).not.toContain('4:3')
    expect(row.ratio).toEqual(['16:9', '9:16'])
  })

  it('offers the full set on the model that accepts it', async () => {
    const row = await videoSelects({
      imageModels: ['MiniMax-H3-Image'],
      imageAspectRatios: ['auto'],
      imageAreas: ['1K'],
      videoModels: ['MiniMax-H3'],
      videoDurations: [4],
      videoResolutions: ['2K'],
      videoRatios: ['16:9'],
      videoModelOptions: limits,
    })
    expect(row.duration).toContain('4')
    expect(row.resolution).toContain('2K')
  })
})
