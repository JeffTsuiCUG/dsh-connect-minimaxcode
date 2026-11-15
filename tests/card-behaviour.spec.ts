/**
 * What the card shows when something fails, and what its controls do.
 *
 * These cases render the real built artifact, the way the host loads it, and
 * assert on what a person would see — not on the source text. A message
 * whose wording drifts still passes here; a message that stops saying what
 * happened does not.
 *
 * The status the card reads arrives asynchronously, so every case renders
 * twice: once to start the read, and again once the answer has landed. That
 * is the same sequence a real render goes through.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH = join(ROOT, 'lib', 'client.js')

interface Slot {
  options: { name?: string; id?: string; key?: string; order?: number; inject?: (sessionId?: string) => Record<string, unknown> }
  component: (props: unknown) => unknown
}

interface Loaded {
  registrations: { id: string; factory(require: (id: string) => unknown): { inject: string[]; apply(ctx: unknown): void } }[]
  slots: Slot[]
  requests: { url: string; method: string; body?: string }[]
}

/** A React stand-in that keeps state between renders. */
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
      if (states.length <= index) states[index] = initial
      return [states[index], (next: unknown) => { states[index] = next }]
    },
    useEffect: (effect: () => unknown) => { void effect() },
  }
  return {
    react,
    render(component: (props: unknown) => unknown, props: unknown) {
      cursor = 0
      return component(props)
    },
    /** Render one component on its own, with its state starting fresh. */
    renderAlone(component: (props: unknown) => unknown, props: unknown) {
      cursor = 0
      return component(props)
    },
  }
}

/** Load the built artifact the way the host's loader does. */
function loadClient(answers: Record<string, unknown>): Loaded {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const loaded: Loaded = { registrations: [], slots: [], requests: [] }
  const sandbox: Record<string, unknown> = {
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const key = String(url).includes('generate') ? 'generate' : String(url).includes('action') ? 'action' : 'status'
      loaded.requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return { ok: true, json: async () => answers[key] ?? { ok: true } }
    },
    setInterval: () => 0,
    clearInterval: () => {},
    File: globalThis.File,
    atob: (value: string) => globalThis.atob(value),
    Uint8Array,
  }
  sandbox.globalThis = sandbox
  sandbox.__ModuleLoader__ = {
    load: (config: Loaded['registrations'][number]) => { loaded.registrations.push(config) },
  }
  runInContext(source, createContext(sandbox))
  return loaded
}

interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/**
 * Every element in a rendered tree.
 *
 * Function components are not rendered here: the harness has already
 * rendered the component that produced this tree, and rendering a function
 * again would restart its state from the beginning. The walk follows the
 * children the render left behind.
 */
function all(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) all(child, found)
    return found
  }
  if (typeof node !== 'object' || node === null) return found
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  if (element.props !== undefined) {
    found.push({ type: element.type, props: element.props, children: (element.children ?? []) as unknown[] })
  }
  all(element.children, found)
  return found
}

/** Every string in a rendered tree, however deeply it sits. */
function strings(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') { found.push(node); return found }
  if (Array.isArray(node)) { node.forEach(child => strings(child, found)); return found }
  if (typeof node !== 'object' || node === null) return found
  const element = node as { props?: { children?: unknown }; children?: unknown }
  strings(element.props?.children, found)
  strings(element.children, found)
  return found
}

/** The text a rendered tree carries. */
function textOf(node: unknown): string {
  return strings(node).join('\n')
}

/** Render, wait for the status read to land, then render again. */
async function settled(
  harness: ReturnType<typeof reactHarness>,
  component: (props: unknown) => unknown,
  props: unknown,
): Promise<unknown> {
  harness.render(component, props)
  await new Promise(resolve => setTimeout(resolve, 20))
  return harness.render(component, props)
}

/** The plugin page among the registered slots. */
function pageOf(loaded: Loaded): Slot {
  const slot = loaded.slots.find(entry => entry.options.name === 'plugins.bundle.config')
  expect(slot, 'the plugin page was not registered').toBeDefined()
  return slot!
}

/** The pill among the registered slots. */
function pillOf(loaded: Loaded): Slot {
  const slot = loaded.slots.find(entry => entry.options.id === 'minimax-credits')
  expect(slot, 'the credit pill was not registered').toBeDefined()
  return slot!
}

/** The host stand-in a card needs, with the slots it registers into. */
function host(loaded: Loaded): Record<string, unknown> {
  return {
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Slot['options'], component: (props: unknown) => unknown) => {
        loaded.slots.push({ options, component })
        return () => {}
      },
    },
    locale: { register: () => {}, bind: () => (key: string) => key },
    effect: (effect: () => unknown) => effect(),
  }
}

const STATUS = {
  ok: true,
  state: 'signed-in',
  showPill: true,
  credits: { state: 'ok', total: 100, free: 60, purchased: 40 },
  rateLimit: { state: 'unavailable', reason: 'no-subscription' },
  plan: { active: true, tier: 'Go', expiresAtMs: 1797033600000 },
}

describe('what the card draws', () => {
  it('hides the balance when the switch says so, and shows it again otherwise', async () => {
    const hidden = loadClient({ status: { ...STATUS, showPill: false } })
    const harnessHidden = reactHarness()
    hidden.registrations[0]!.factory(() => harnessHidden.react).apply(host(hidden))
    const gateHidden = await settled(harnessHidden, pillOf(hidden).component, { t: (key: string) => key })
    expect(JSON.stringify(gateHidden), '关掉开关后胶囊仍被画出').toBe('null')

    const shown = loadClient({ status: STATUS })
    const harnessShown = reactHarness()
    shown.registrations[0]!.factory(() => harnessShown.react).apply(host(shown))
    const gateShown = await settled(harnessShown, pillOf(shown).component, { t: (key: string) => key })
    expect(JSON.stringify(gateShown), '开着开关时胶囊没有被画出').not.toBe('null')
  })

  it('draws the diagnostics with the facts it was given', async () => {
    const loaded = loadClient({
      status: {
        ...STATUS,
        diagnostics: {
          pluginVersion: '0.7.0',
          region: 'cn',
          hosts: ['https://agent.minimax.cn', 'https://api.minimax.cn'],
          authSource: 'desktop-app',
          catalogSource: 'live',
          lastUpstreamError: 'no active token plan subscription',
          capability: { sessionId: 'present', sessionsService: 'present' },
        },
      },
    })
    const harness = reactHarness()
    loaded.registrations[0]!.factory(() => harness.react).apply(host(loaded))
    const rendered = await settled(harness, pageOf(loaded).component, { t: (key: string) => key })
    const text = textOf(rendered)
    expect(text).toContain('0.7.0')
    expect(text).toContain('desktop-app')
    expect(text).toContain('no active token plan subscription')
    // The whole block is one element's content, so a report can quote it.
    const block = all(rendered).find(entry => entry.props['data-minimax-diagnostics-text'] === true)
    expect(block, '诊断文本不是单个可复制的元素').toBeDefined()
    // The pre element's content is its child, a single string: the block can
    // be quoted as it stands.
    const content = block!.children[0]
    expect(String(content)).toContain('sessionId=present')
    expect(String(content)).toContain('diagnosticsRegion: cn')
  })

  it('draws the display switch, and pressing it calls the action once', async () => {
    const loaded = loadClient({ status: STATUS, action: { ok: true, showPill: false } })
    const harness = reactHarness()
    loaded.registrations[0]!.factory(() => harness.react).apply(host(loaded))
    const rendered = await settled(harness, pageOf(loaded).component, { t: (key: string) => key })
    // The switch is the one checkbox on the page.
    const boxes = all(rendered).filter(entry => entry.props.type === 'checkbox')
    expect(boxes.length, '插件页上只有一个开关').toBe(1)
    // Pressing it asks the plugin once, with the opposite of the current state.
    ;(boxes[0]!.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } })
    await new Promise(resolve => setTimeout(resolve, 20))
    const calls = loaded.requests.filter(entry => entry.url.includes('action'))
    expect(calls.length, '开关拨动后 action 没有被调用').toBe(1)
    expect(calls[0]!.url).toContain('action=pillVisible')
    expect(calls[0]!.body).toContain('"showPill":false')
  })

  it('shows the remedy, the charged warning and the upstream words when a call fails', async () => {
    const loaded = loadClient({
      status: STATUS,
      generate: {
        ok: false,
        error: 'no active token plan subscription',
        kind: 'subscription',
        charged: true,
        cooldownMs: 30000,
        upstream: { status: 200, code: 2062, message: 'no active token plan subscription' },
      },
    })
    const harness = reactHarness()
    loaded.registrations[0]!.factory(() => harness.react).apply(host(loaded))
    const rendered = await settled(harness, pageOf(loaded).component, { t: (key: string) => key })
    // The generation panel is a component of its own inside the page: it is
    // rendered with the same props the page received, and its state starts
    // from its own beginning — the cursor is the harness's, so it is reset
    // before the panel is rendered on its own.
    const panel = all(rendered).find(entry => typeof entry.type === 'function')
    expect(panel, '生成面板没有被找到').toBeDefined()
    const panelTree = harness.renderAlone(panel!.type as (childProps: unknown) => unknown, panel!.props)
    // The run control, in the panel's own tree.
    const run = all(panelTree).find(entry => entry.props.onClick !== undefined && JSON.stringify(entry.children).includes('generateRun'))
    expect(run, '生成按钮没有被找到').toBeDefined()
    ;(run!.props.onClick as () => void)()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Re-render the panel: the note is its state, and the harness keeps it
    // between renders. The click landed while the panel was being rendered,
    // so the note is read on the render after that.
    const panelComponent = all(rendered).find(entry => typeof entry.type === 'function')!.type as (childProps: unknown) => unknown
    const panelAfter = harness.renderAlone(panelComponent, panel!.props)
    const text = textOf(harness.renderAlone(panelComponent, panel!.props))
    // The remedy is the failure's own sentence, not the upstream's words alone.
    expect(text).toContain('failureSubscription')
    // The charged warning is its own line.
    expect(text).toContain('failureCharged')
    // The upstream's words are in the collapsed detail.
    expect(text).toContain('no active token plan subscription')
    // And the three parts are distinguishable in the drawn tree.
    expect(JSON.stringify(panelAfter)).toContain('data-minimax-generation-note')
    expect(JSON.stringify(panelAfter)).toContain('data-minimax-generation-charged')
    expect(JSON.stringify(panelAfter)).toContain('data-minimax-generation-upstream')
  })
})
