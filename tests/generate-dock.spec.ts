/**
 * The image dock in the composer tool row.
 *
 * The dock generates a picture and hands it to the conversation. Which door
 * it uses depends on what the host offers, and the host hands over the
 * session through the slot's own injection — the slot is session-scoped, so
 * its injection receives the session it belongs to. A dock that looked for
 * the session elsewhere would find nothing, and the picture would never
 * arrive; these cases therefore drive the dock exactly the way the host
 * does, through the injected props.
 *
 * Nothing here reaches the network: every fetch is a stub.
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
  options: { name?: string; id?: string; key?: string; order?: number; inject?: (sessionId?: string) => Record<string, unknown> }
  component: (props: unknown) => unknown
}

interface Loaded {
  registrations: { id: string; factory(require: (id: string) => unknown): { inject: string[]; apply(ctx: unknown): void } }[]
  slots: Slot[]
  fetchCount: number
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
    // The browser globals the draft path needs.
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

/** Every element in a rendered tree that carries an `onClick`. */
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

/** The dock among the registered slots. */
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

/** A conversation that only offers drafts, plus the input box's own channel. */
function draftFace(created: { id: string }[], added: string[][]) {
  return {
    scope: (id: string) => ({
      get: (key: string) => key === 'conversation'
        ? {
            createDrafts: (_sessionId: string, files: unknown[]) => {
              created.push(...files.map((_, index) => ({ id: `draft-${index}` })))
              return created
            },
          }
        : undefined,
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

  it('takes the session from the slot injection, the way the host hands it over', () => {
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
    // The slot is session-scoped, so its injection receives the session.
    const injected = dock.options.inject?.('session-42')
    expect(injected).toBeDefined()
    expect(injected?.sessionId).toBe('session-42')
  })

  it('sends the generated picture to the conversation as a turn', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    const sent: unknown[][] = []
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Slot['options'], component: (props: unknown) => unknown) => {
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      sessions: sessionFace(sent),
      effect: (effect: () => unknown) => effect(),
    })
    const dock = dockOf(loaded)
    // The props are the ones the host's injection produced.
    const props = { ...dock.options.inject?.('session-1'), t: (key: string) => key }

    const collapsed = JSON.stringify(renderDeep(harness, dock.component, props))
    expect(collapsed).toContain('generateToChat')

    clickables(renderDeep(harness, dock.component, props))[0]!.props.onClick!()
    fields(renderDeep(harness, dock.component, props))[0]!.props.onChange!({ target: { value: '一只橘猫' } })
    runButton(renderDeep(harness, dock.component, props))!.props.onClick!()
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
    const parts = content as { type: string; mediaType?: string; data?: string; text?: string }[]
    expect(parts[0]?.type).toBe('image')
    expect(parts[0]?.mediaType).toBe('image/jpeg')
    // The data is the raw base64, without the data-url prefix.
    expect(parts[0]?.data?.startsWith('/9j/')).toBe(true)
    expect(parts[0]?.data).not.toContain('data:')
    expect(parts[1]?.type).toBe('text')
    expect(parts[1]?.text).toBe('一只橘猫')
  })

  it('falls back to the input box when the host offers no way to send', async () => {
    const loaded = loadClient()
    const harness = reactHarness()
    const plugin = loaded.registrations[0]!.factory(() => harness.react)
    const created: { id: string }[] = []
    const added: string[][] = []
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Slot['options'], component: (props: unknown) => unknown) => {
          loaded.slots.push({ options, component })
          return () => {}
        },
      },
      locale: { register: () => {}, bind: () => (key: string) => key },
      sessions: draftFace(created, added),
      effect: (effect: () => unknown) => effect(),
    })
    const dock = dockOf(loaded)
    const props = {
      ...dock.options.inject?.('session-1'),
      t: (key: string) => key,
      inputActions: { addAttachments: (ids: string[]) => { added.push(ids) } },
    }

    clickables(renderDeep(harness, dock.component, props))[0]!.props.onClick!()
    fields(renderDeep(harness, dock.component, props))[0]!.props.onChange!({ target: { value: '一只橘猫' } })
    runButton(renderDeep(harness, dock.component, props))!.props.onClick!()
    await new Promise(resolve => setTimeout(resolve, 20))

    // The picture became a draft in the input box instead of a sent message.
    expect(created).toHaveLength(1)
    expect(added).toHaveLength(1)
    expect(added[0]).toEqual(['draft-0'])
    // The picture's arrival is the feedback: it is in the input box now.
    const tree = JSON.stringify(harness.render(dock.component, props))
    expect(tree).not.toContain('generateSendFailed')
  })

  it('says so when the host offers no session to send to', async () => {
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
    const props = { ...dock.options.inject?.('session-1'), t: (key: string) => key }

    clickables(renderDeep(harness, dock.component, props))[0]!.props.onClick!()
    fields(renderDeep(harness, dock.component, props))[0]!.props.onChange!({ target: { value: '一只橘猫' } })
    runButton(renderDeep(harness, dock.component, props))!.props.onClick!()
    await new Promise(resolve => setTimeout(resolve, 20))

    const tree = JSON.stringify(harness.render(dock.component, props))
    // The message now names the missing piece rather than one blanket failure.
    expect(tree).toContain('generateNoSessions')
  })

  it('reports what the host offers it, so a failure names the missing piece', async () => {
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
      // A host that offers the sessions service but no session for this one.
      sessions: { binding: () => undefined, scope: () => undefined },
      effect: (effect: () => unknown) => effect(),
    })
    const dock = dockOf(loaded)
    const props = { ...dock.options.inject?.('session-1'), t: (key: string) => key }

    harness.render(dock.component, props)
    await new Promise(resolve => setTimeout(resolve, 20))

    // The report went to the plugin's own route, so it can be read from the
    // status document rather than only from the screen that hit the problem.
    const report = loaded.requests.find(entry => entry.url.includes('/capability'))
    expect(report, 'the dock never reported what the host offers').toBeDefined()
    const findings = JSON.parse(decodeURIComponent(report!.url.split('report=')[1] ?? '{}')) as Record<string, string>
    expect(findings.sessionId).toBe('present')
    expect(findings.sessionsService).toBe('present')
    // This host has no binding and no scope for the session.
    expect(findings.binding).toBe('missing')
    expect(findings.scope).toBe('missing')
    expect(findings.inputActions).toBe('missing')
  })

  it('names the missing piece when the host gives no session at all', async () => {
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
    // A host that names no session at all.
    const props = { t: (key: string) => key }

    clickables(renderDeep(harness, dock.component, props))[0]!.props.onClick!()
    fields(renderDeep(harness, dock.component, props))[0]!.props.onChange!({ target: { value: '一只橘猫' } })
    runButton(renderDeep(harness, dock.component, props))!.props.onClick!()
    await new Promise(resolve => setTimeout(resolve, 20))

    const tree = JSON.stringify(harness.render(dock.component, props))
    expect(tree).toContain('generateNoSession')
  })
})
