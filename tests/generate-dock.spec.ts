/**
 * The image dock in the composer tool row.
 *
 * The dock generates a picture and hands it to the conversation the way the
 * composer itself hands over a message: through the session's own `prompt`.
 * That is the whole point of using the session face rather than writing to
 * the input box directly — the picture travels the same road a dragged-in
 * picture would, and the host admits it, validates it against the current
 * model and turns it into a durable attachment.
 *
 * These cases pin that path: the dock asks the plugin's own route for a
 * picture, turns the answer into the content shape the session admits, and
 * sends it. They also pin what happens when the host offers no session face —
 * the dock says so instead of failing silently.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** A one-pixel JPEG, as the upstream would answer with. */
const PIXEL_JPEG =
  'data:image/jpeg;base64,/9j/4QTsRXhpZgAATAAAACAgIAAAEAAQMABAFBAAAABQAAAAcAAABBBAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

interface Slot {
  options: { name?: string; id?: string; key?: string; order?: number; inject?: () => Record<string, unknown> }
  component: (props: unknown) => unknown
}

interface Loaded {
  registrations: { id: string; factory(require: (id: string) => unknown): { inject: string[]; apply(ctx: unknown): void } }[]
  slots: Slot[]
  fetchCount: number
  /** Every request the client made. */
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
  }
}

/** Load the built artifact the way the host's loader does. */
function loadClient(answer: unknown = { ok: true, dataUrl: PIXEL_JPEG, mediaType: 'image/jpeg' }): Loaded {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const loaded: Loaded = { registrations: [], slots: [], fetchCount: 0, requests: [] }
  const sandbox: Record<string, unknown> = {
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      loaded.fetchCount += 1
      loaded.requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return { ok: true, json: async () => answer }
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

/** Render one level deeper, past a gate that returns its own element. */
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

/**
 * Every element in a rendered tree that carries an `onClick`.
 *
 * The dock is a button when it is closed and a row of controls when it is
 * open, so the tests look for the control they mean rather than for a
 * position in the tree.
 */
function clickables(node: unknown, found: { props: { onClick?: () => void } }[] = []): { props: { onClick?: () => void } }[] {
  if (Array.isArray(node)) {
    for (const child of node) clickables(child, found)
    return found
  }
  if (typeof node !== 'object' || node === null) return found
  const element = node as { props?: { onClick?: unknown }; children?: unknown }
  if (typeof element.props?.onClick === 'function') {
    found.push(element as { props: { onClick?: () => void } })
  }
  clickables(element.children, found)
  return found
}

/** Every element in a rendered tree that carries an `onChange`. */
function fields(node: unknown, found: { props: { onChange?: (event: { target: { value: string } }) => void } }[] = []): { props: { onChange?: (event: { target: { value: string } }) => void } }[] {
  if (Array.isArray(node)) {
    for (const child of node) fields(child, found)
    return found
  }
  if (typeof node !== 'object' || node === null) return found
  const element = node as { props?: { onChange?: unknown }; children?: unknown }
  if (typeof element.props?.onChange === 'function') {
    found.push(element as { props: { onChange?: (event: { target: { value: string } }) => void } })
  }
  fields(element.children, found)
  return found
}

/** The clickable that runs the generation, not the one that closes the dock. */
function runButton(node: unknown): { props: { onClick?: () => void } } | undefined {
  return clickables(node).find(element => {
    const text = JSON.stringify(element)
    return text.includes('generateRun') || text.includes('generateRunning')
  })
}

/** Find the dock among the registered slots. */
function dockOf(loaded: Loaded): Slot {
  const slot = loaded.slots.find(entry => entry.options.id === 'minimax-generate')
  expect(slot, 'the image dock was not registered').toBeDefined()
  return slot!
}

/** A session face that records what it was asked to send. */
function sessionFace(sent: unknown[][]) {
  return {
    binding: (id: string) => ({
      session: {
        prompt: async (content: unknown[], mode: string, _signal?: AbortSignal, requestId?: string) => {
          sent.push([content, mode, requestId])
          return { ok: true }
        },
      },
    }),
  }
}

describe('the image dock', () => {
  it('is registered in the composer tool row beside the balance', () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Slot['options'], component: (props: unknown) => unknown) => {
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    const dock = dockOf(loaded)
    expect(dock.options.name).toBe('conversation.input.left')
  })

  it('declares the sessions service it needs to reach the conversation', () => {
    const loaded = loadClient()
    const plugin = loaded.registrations[0]!.factory(() => reactHarness().react)
    expect(plugin.inject).toContain('sessions')
  })

  it('sends the generated picture to the conversation as a turn', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    const sent: unknown[][] = []
    let dock: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Slot['options'], component: (props: unknown) => unknown) => {
          if (options.id === 'minimax-generate') dock = component
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      sessions: sessionFace(sent),
      effect: (effect: () => unknown) => effect(),
    })
    expect(dock).toBeDefined()

    const props = { t: (key: string) => key, sessionId: 'session-1' }
    // The collapsed dock is a single button.
    const collapsed = JSON.stringify(renderDeep(harness, dock!, props))
    expect(collapsed).toContain('generateToChat')

    // Open it: the closed dock offers exactly one way in.
    const closed = clickables(renderDeep(harness, dock!, props))
    expect(closed.length, 'the dock did not offer a way to open it').toBeGreaterThan(0)
    closed[0]!.props.onClick!()

    // Type a prompt.
    const inputs = fields(renderDeep(harness, dock!, props))
    expect(inputs.length, 'the dock did not offer a prompt field').toBeGreaterThan(0)
    inputs[0]!.props.onChange!({ target: { value: '一只橘猫' } })

    // Send: the open dock offers the run button, beside the one that closes it.
    const sendButton = runButton(renderDeep(harness, dock!, props))
    expect(sendButton, 'the dock did not offer a way to send').toBeDefined()
    sendButton!.props.onClick!()
    await new Promise(resolve => setTimeout(resolve, 20))

    // The plugin's own route was asked for the picture.
    const request = loaded.requests.find(entry => entry.url.includes('/generate'))
    expect(request, 'the dock never asked for a picture').toBeDefined()
    expect(request?.method).toBe('POST')
    expect(request?.body).toContain('一只橘猫')
    expect(request?.body).toContain('"kind":"image"')

    // And the picture reached the conversation as the content of a turn.
    expect(sent).toHaveLength(1)
    const [content, mode] = sent[0]!
    expect(mode).toBe('queue')
    expect(Array.isArray(content)).toBe(true)
    const parts = content as { type: string; mediaType?: string; data?: string; text?: string }[]
    expect(parts[0]?.type).toBe('image')
    expect(parts[0]?.mediaType).toBe('image/jpeg')
    // The data is the raw base64, without the data-url prefix.
    expect(parts[0]?.data?.startsWith('/9j/')).toBe(true)
    expect(parts[0]?.data).not.toContain('data:')
    expect(parts[1]?.type).toBe('text')
    expect(parts[1]?.text).toBe('一只橘猫')
  })

  it('says so when the host offers no session to send to', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    let dock: ((props: unknown) => unknown) | undefined
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Slot['options'], component: (props: unknown) => unknown) => {
          if (options.id === 'minimax-generate') dock = component
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      effect: (effect: () => unknown) => effect(),
    })
    const props = { t: (key: string) => key, sessionId: 'session-1' }
    clickables(renderDeep(harness, dock!, props))[0]!.props.onClick!()
    fields(renderDeep(harness, dock!, props))[0]!.props.onChange!({ target: { value: '一只橘猫' } })
    runButton(renderDeep(harness, dock!, props))!.props.onClick!()
    await new Promise(resolve => setTimeout(resolve, 20))

    const tree = JSON.stringify(harness.render(dock!, props))
    expect(tree).toContain('generateSendFailed')
  })
})
