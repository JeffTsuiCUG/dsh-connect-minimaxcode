/**
 * Image input: the adapter must be given the host's attachment service.
 *
 * A pi-ai-backed route only accepts an image when the plugin hands it the
 * durable attachment store. Both `PiAiAdapterOptions` hooks are optional, so
 * forgetting them type-checks and fails only at request time — with a message
 * about the attachment service that reads like a model limitation, which is
 * exactly how it was reported:
 *
 *   pi-ai image input requires the durable attachment service
 *
 * These tests pin the wiring at the two seams that can drop it: the module
 * that builds the hooks, and `apply()` that passes them to the adapter.
 */

import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Options the most recent `PiAiAdapter` build received. */
let lastOptions: Record<string, unknown> | undefined

vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({
  PiAiAdapter: class {
    constructor(options: Record<string, unknown>) {
      lastOptions = options
    }
  },
}))

const { imageInputHooks } = await import('../src/image-input.ts')
const { apply, inject, name } = await import('../src/index.ts')

/** A durable attachment store stand-in: only the host-path lookup is used. */
function attachmentStore(hostPath = 'C:/host/normalized/x.png') {
  return {
    imageHostPath: vi.fn(() => hostPath),
    imageLimits: { maxImageBytes: 1024 * 1024 },
  }
}

/** The same store for a reference the host never persisted to disk. */
function attachmentStoreWithoutHostObject() {
  return {
    imageHostPath: vi.fn(() => undefined),
    imageLimits: { maxImageBytes: 1024 * 1024 },
  }
}

/** A filesystem stand-in exposing the one bridge method the hook calls. */
function fileSystem(mapped: string | undefined = '/work/x.png') {
  return { processPathFromHostPath: vi.fn(() => mapped) }
}

/** One durable image reference, shaped as the adapter passes it back. */
const ref = {
  attachmentId: 'sha256:0123456789abcdef',
  mediaType: 'image/png' as const,
  bytes: 1234,
  width: 800,
  height: 600,
}

/** Minimal `llm` service: the plugin only registers one adapter on it. */
function llmService() {
  return { registerAdapter: vi.fn(() => vi.fn()) }
}

describe('imageInputHooks', () => {
  it('resolves the attachment store the host provides', () => {
    const ctx = new Context()
    const attachments = attachmentStore()
    ctx.reflect.provide('attachments', attachments as never)

    const hooks = imageInputHooks(ctx)
    expect(hooks.resolveAttachments?.()).toBe(attachments)
  })

  it('reports no store on a host that provides none, instead of throwing', () => {
    const ctx = new Context()
    // `ctx.get` reads without the inject requirement, so an absent service is
    // `undefined` rather than the throw a declared read would produce.
    expect(imageInputHooks(ctx).resolveAttachments?.()).toBeUndefined()
  })

  it('bridges one attachment into the tool execution world', () => {
    const ctx = new Context()
    const attachments = attachmentStore()
    const fs = fileSystem('/work/normalized/x.png')
    ctx.reflect.provide('attachments', attachments as never)
    ctx.reflect.provide('fs', fs as never)

    const access = imageInputHooks(ctx).resolveImageAccess?.(attachments as never, ref as never)

    expect(attachments.imageHostPath).toHaveBeenCalledWith(ref)
    expect(fs.processPathFromHostPath).toHaveBeenCalledWith('C:/host/normalized/x.png')
    expect(access).toEqual({ readonlyPath: '/work/normalized/x.png' })
  })

  it('yields no local path when the host exposes no filesystem', () => {
    const ctx = new Context()
    const attachments = attachmentStore()
    ctx.reflect.provide('attachments', attachments as never)

    // The image is still sent inline; the model simply gets no path to read.
    expect(imageInputHooks(ctx).resolveImageAccess?.(attachments as never, ref as never)).toBeUndefined()
  })

  it('yields no local path when the attachment has no host object', () => {
    const ctx = new Context()
    const attachments = attachmentStoreWithoutHostObject()
    ctx.reflect.provide('attachments', attachments as never)
    ctx.reflect.provide('fs', fileSystem() as never)

    expect(imageInputHooks(ctx).resolveImageAccess?.(attachments as never, ref as never)).toBeUndefined()
  })
})

describe('apply() wires image input into the adapter', () => {
  beforeEach(() => {
    lastOptions = undefined
  })

  /** Load the plugin the way the host does, with the given services present. */
  async function load(services: { attachments?: unknown, fs?: unknown }) {
    const ctx = new Context()
    const llm = llmService()
    ctx.reflect.provide('llm', llm as never)
    if (services.attachments !== undefined) ctx.reflect.provide('attachments', services.attachments as never)
    if (services.fs !== undefined) ctx.reflect.provide('fs', services.fs as never)
    await ctx.plugin({ name, inject, apply }, undefined)
    return { ctx, llm }
  }

  it('passes both hooks to PiAiAdapter', async () => {
    const attachments = attachmentStore()
    await load({ attachments, fs: fileSystem() })

    expect(lastOptions, 'PiAiAdapter was never constructed').toBeDefined()
    expect(typeof lastOptions?.['resolveAttachments']).toBe('function')
    expect(typeof lastOptions?.['resolveImageAccess']).toBe('function')
  })

  it('gives the adapter a hook that reaches the live store', async () => {
    const attachments = attachmentStore()
    await load({ attachments, fs: fileSystem() })

    const resolveAttachments = lastOptions?.['resolveAttachments'] as () => unknown
    expect(resolveAttachments()).toBe(attachments)
  })

  it('gives the adapter a hook that maps the attachment path', async () => {
    const attachments = attachmentStore()
    const fs = fileSystem('/work/normalized/x.png')
    await load({ attachments, fs })

    const resolveImageAccess = lastOptions?.['resolveImageAccess'] as (store: unknown, reference: unknown) => unknown
    expect(resolveImageAccess(attachments, ref)).toEqual({ readonlyPath: '/work/normalized/x.png' })
  })

  it('still loads on a host without the attachment service, serving text', async () => {
    // The hooks are present but resolve to nothing: text-only requests work,
    // and an image is refused by the adapter as before rather than crashing
    // the plugin at load time.
    await load({})

    const resolveAttachments = lastOptions?.['resolveAttachments'] as () => unknown
    expect(resolveAttachments()).toBeUndefined()
  })
})
