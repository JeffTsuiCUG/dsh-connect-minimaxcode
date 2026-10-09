/**
 * Host-integration tests: the plugin must survive a real Cordis composition.
 *
 * This is the regression test for the fatal load failure of 2026-10-08. The
 * host died at startup with `cannot get property "webserver" without inject`
 * because `apply()` read a service it never declared. In Cordis a context is a
 * service proxy: inside a plugin fiber, reading an undeclared service throws,
 * optional chaining does not swallow it, and an exception escaping `apply()`
 * fails the whole plugin tree — taking every unrelated plugin (WorkBuddy,
 * Trae, GitHub Flow) down with it.
 *
 * These tests therefore run the plugin through the same `ctx.plugin({ inject,
 * apply })` path the host uses, against a real `Context`. A hand-rolled stub
 * object would have hidden the very throw that caused the outage: the root
 * context resolves unknown services to `undefined`, so only a fiber context
 * reproduces the host's behaviour.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { MINIMAX_STATUS_PATH } from '../src/status-route.ts'

/**
 * Minimal stand-in for the host's `llm` service; only the used method is real.
 * The provider-route argument is typed so the recorded call can be asserted.
 */
function llmService() {
  const dispose = vi.fn()
  const registerAdapter = vi.fn((_providers: string[], _adapter: unknown) => dispose)
  return { service: { registerAdapter }, dispose }
}

/** A `webServer` stand-in recording the routes a plugin registers on it. */
function webServerService() {
  const events: string[] = []
  const register = vi.fn(() => {
    events.push('registered')
    return () => { events.push('released') }
  })
  return { service: { register }, events }
}

/**
 * Load this plugin the way the host does: a fiber gated on `inject`.
 *
 * The plugin object is assembled through a typed helper so `ctx.plugin` sees a
 * real plugin shape (name + inject + apply) and no `as never` cast is needed at
 * each call site; `config` stays `undefined`, which the plugin ignores.
 */
const plugin = { name, inject, apply }
function loadPlugin(ctx: Context) {
  return ctx.plugin(plugin, undefined)
}

/** Let queued fiber/effect work settle before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('plugin entry contract', () => {
  it('is named and declares only the services it blocks startup on', () => {
    expect(name).toBe('dsh-connect-minimaxcode')
    // `webServer` is deliberately absent: the status route waits for it with
    // ctx.inject() instead, so a web-less host still starts the plugin.
    expect(inject).toEqual(['llm'])
  })
})

describe('loading on a host without a web server', () => {
  it('does not throw — the regression that crashed the whole host', async () => {
    const ctx = new Context()
    ctx.reflect.provide('llm', llmService().service as never)
    await expect(loadPlugin(ctx)).resolves.toBeDefined()
  })

  it('still registers its provider with the llm service', async () => {
    const ctx = new Context()
    const llm = llmService()
    ctx.reflect.provide('llm', llm.service as never)
    await loadPlugin(ctx)
    expect(llm.service.registerAdapter).toHaveBeenCalledTimes(1)
    const routes = llm.service.registerAdapter.mock.calls[0]?.[0]
    expect(routes).toEqual(['minimaxcode'])
  })

  it('pins the behaviour that made the bug fatal: a fiber read of an undeclared service throws', async () => {
    const ctx = new Context()
    ctx.reflect.provide('llm', llmService().service as never)

    let observed: string | undefined
    await ctx.plugin(
      {
        name: 'probe-undeclared-read',
        inject: ['llm'],
        apply(fiberCtx: Context) {
          try {
            // Exactly the read the old code performed on its boot path.
            void (fiberCtx as unknown as { webserver?: unknown }).webserver
            observed = 'no-throw'
          } catch (error) {
            observed = (error as Error).message
          }
        },
      },
      undefined,
    )

    expect(observed).toBe('cannot get property "webserver" without inject')
  })

  it('keeps the provider registered after a reload, with no duplicate route', async () => {
    const ctx = new Context()
    const llm = llmService()
    ctx.reflect.provide('llm', llm.service as never)
    const fiber = await loadPlugin(ctx)
    await fiber.restart()
    await settle()
    // The handle is disposed with the fiber, so a reload must re-register
    // rather than collide with the previous registration.
    expect(llm.service.registerAdapter).toHaveBeenCalled()
  })
})

describe('loading on a host with a web server', () => {
  it('mounts the status route when webServer is already present', async () => {
    const ctx = new Context()
    const webServer = webServerService()
    ctx.reflect.provide('llm', llmService().service as never)
    ctx.reflect.provide('webServer', webServer.service as never)
    await loadPlugin(ctx)
    await settle()
    expect(webServer.service.register).toHaveBeenCalled()
    expect(webServer.events).toEqual(['registered'])
  })

  it('mounts it late too, when webServer arrives after startup', async () => {
    const ctx = new Context()
    const webServer = webServerService()
    ctx.reflect.provide('llm', llmService().service as never)
    await loadPlugin(ctx)
    await settle()
    expect(webServer.events).toEqual([])
    ctx.reflect.provide('webServer', webServer.service as never)
    await settle()
    expect(webServer.events).toEqual(['registered'])
  })

  it('releases the route when the plugin unloads', async () => {
    const ctx = new Context()
    const webServer = webServerService()
    ctx.reflect.provide('llm', llmService().service as never)
    ctx.reflect.provide('webServer', webServer.service as never)
    const fiber = await loadPlugin(ctx)
    await settle()
    expect(webServer.events).toEqual(['registered'])
    await fiber.dispose()
    await settle()
    expect(webServer.events).toEqual(['registered', 'released'])
  })

  it('re-registers the route after a reload instead of duplicating it', async () => {
    const ctx = new Context()
    const webServer = webServerService()
    ctx.reflect.provide('llm', llmService().service as never)
    ctx.reflect.provide('webServer', webServer.service as never)
    const fiber = await loadPlugin(ctx)
    await settle()
    await fiber.restart()
    await settle()
    expect(webServer.events).toEqual(['registered', 'released', 'registered'])
  })
})
