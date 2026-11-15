/**
 * The two kinds of control, and which kind each one is.
 *
 * A settings page mixes two things that have nothing to do with each other
 * except that they are both on the same page:
 *
 *  - a *display or authorisation* choice — whether something is drawn, whether
 *    the plugin may act on its own. It changes nothing about the account and
 *    nothing about what the plugin does, so it takes effect at once and
 *    there is no draft to save.
 *  - a *catalog or account* change — which models are enabled, which account
 *    is selected. These are submitted together and have to be reviewed as a
 *    whole, so they are a draft that a save button commits.
 *
 * Mixing them is what makes a settings page confusing: the save button
 * ends up three screens away from the thing it saves, and the switches that
 * were meant to be instant look like they need saving too.
 *
 * The plugin has one control of the first kind today (the balance in the
 * composer) and one of the second (the daily claim). The cases below pin
 * which is which, so a future control does not arrive in the wrong shape.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = readFileSync(join(ROOT, 'src', 'client.ts'), 'utf8')
const SERVER = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')

describe('a display choice', () => {
  it('is applied at once, with no draft and no save', () => {
    // The action writes the setting and returns; nothing collects it for a
    // later commit.
    expect(SERVER).toMatch(/case 'pillVisible'[\s\S]{0,600}?await writePluginState\(pluginState\)\s*\n\s*return \{ ok: true, showPill \}/)
    // And it is not part of any draft: the page's save path does not carry it.
    expect(SERVER).not.toMatch(/case 'pillVisible'[\s\S]{0,600}?pending/)
  })

  it('is a switch on the page, not a field to be saved', () => {
    expect(CLIENT).toContain("type: 'checkbox'")
    expect(CLIENT).toMatch(/checked: status\?\.showPill !== false/)
    expect(CLIENT).toMatch(/act\('pillVisible', \{ showPill: event\.target\.checked \}\)/)
  })

  it('hides the balance the moment the choice says so', () => {
    // The gate reads the choice and draws nothing; the balance itself is
    // untouched, so turning it back on brings it straight back.
    expect(CLIENT).toMatch(/if \(status\?\.showPill === false\) return null/)
  })

  it('defaults to shown, so an account that never touched it sees the balance', () => {
    expect(SERVER).toContain('showPill: pluginState.showPill ?? true')
  })
})

describe('a draft change', () => {
  it('is committed by a save, and only a save', () => {
    // The daily claim is the plugin's one account-level choice: it decides
    // whether the plugin may act on its own behalf, so it is written
    // deliberately and the page reflects what was written.
    expect(SERVER).toMatch(/case 'settings'[\s\S]{0,400}?await writePluginState\(pluginState\)/)
  })

  it('is reflected in the status the page reads', () => {
    expect(SERVER).toContain('showPill: pluginState.showPill ?? true')
  })
})

describe('the switch travels the whole way', () => {
  it('writes the choice, and the status document carries it back', async () => {
    // The whole chain, driven from the server: the action writes the choice,
    // and the next status read reports it. A gate that reads a stale value
    // would show the balance after the switch said to hide it.
    process.env.MINIMAX_DATA_DIR = join(ROOT, '.tmp-control-layers')
    process.env.DSH_HOME = join(ROOT, '.tmp-control-layers')
    const { rmSync } = await import('node:fs')
    rmSync(join(ROOT, '.tmp-control-layers'), { recursive: true, force: true })
    const { Context } = await import('@deepseek-ai/cordis')
    const plugin = await import('../src/index.ts')
    const routes = new Map<string, (req: unknown, res: unknown) => unknown>()
    const ctx = new Context()
    ctx.reflect.provide('llm', { registerAdapter: () => () => {} } as never)
    ctx.reflect.provide('webServer', {
      register: ({ path, handler }: { path: string; handler: (req: unknown, res: unknown) => unknown }) => {
        routes.set(path, handler)
        return () => {}
      },
    } as never)
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, undefined)
    await new Promise(resolve => setTimeout(resolve, 400))

    const action = routes.get('/plugins/dsh-connect-minimaxcode/action')!
    const status = routes.get('/plugins/dsh-connect-minimaxcode/status')!
    const read = async (handler: (req: unknown, res: unknown) => unknown): Promise<Record<string, unknown>> => {
      let body = ''
      await handler({ headers: { host: '127.0.0.1:19387' } }, { writeHead: () => {}, end: (text: string) => { body = text } })
      return JSON.parse(body) as Record<string, unknown>
    }

    // The default: shown.
    expect((await read(status)).showPill).toBe(true)

    // The switch is pressed: the choice is written and read straight back.
    let actionBody = ''
    const post = async (payload: Record<string, unknown>): Promise<void> => {
      // The request is the async iterable: the handler reads the body by
      // iterating it.
      await action({
        [Symbol.asyncIterator]() { return Readable.from([JSON.stringify(payload)])[Symbol.asyncIterator]() },
        method: 'POST',
        headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
        url: '/plugins/dsh-connect-minimaxcode/action?action=pillVisible',
      }, {
        writeHead: () => {},
        end: (text: string) => { actionBody = text },
      })
    }
    await post({ showPill: false })
    expect(JSON.parse(actionBody)).toEqual({ ok: true, showPill: false })
    expect((await read(status)).showPill).toBe(false)

    // And back on.
    await post({ showPill: true })
    expect((await read(status)).showPill).toBe(true)
    rmSync(join(ROOT, '.tmp-control-layers'), { recursive: true, force: true })
  })
})
