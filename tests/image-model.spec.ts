/**
 * Direct model-picker invocation for MiniMax H3 image generation models.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  buildAuxiliaryReply,
  detectAuxiliaryPurpose,
  extractImagePrompt,
  formatImageResponseMarkdown,
  isImageGenerationModel,
  listImageModels,
  materializeGeneratedImages,
  parseImagePromptDirectives,
  resolveCanonicalImageModelId,
  resolveImageModelInfo,
  saveImageToLocalDir,
  streamImageModelCall,
} from '../src/image-model.ts'
import { GenerationError } from '../src/generation.ts'
import { createMinimaxCodeAdapter } from '../src/adapter.ts'
import type { MinimaxCatalog } from '../src/catalog.ts'

function msg(role: Message['role'], text: string, source: Message['source'] = { kind: 'user' }): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}` as Message['id'],
    role,
    content: [{ type: 'text', text }],
    source,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('image model descriptors & matching', () => {
  it('recognises H3 image models with or without provider prefix and case-insensitively', () => {
    expect(isImageGenerationModel('MiniMax-H3-Image')).toBe(true)
    expect(isImageGenerationModel('minimaxcode/minimax-h3-image-highspeed')).toBe(true)
    expect(resolveCanonicalImageModelId('minimaxcode/minimax-h3-image')).toBe('MiniMax-H3-Image')
    expect(resolveCanonicalImageModelId('MiniMax-H3-Image-Highspeed')).toBe('MiniMax-H3-Image-Highspeed')
    expect(isImageGenerationModel('MiniMax-M3')).toBe(false)
    expect(isImageGenerationModel(undefined)).toBe(false)
  })

  it('publishes non-reasoning H3 models for the model picker', () => {
    const models = listImageModels('minimaxcode')
    expect(models.map(m => m.id)).toEqual(['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'])
    const resolved = resolveImageModelInfo('minimaxcode', 'MiniMax-H3-Image')
    expect(resolved.id).toBe('MiniMax-H3-Image')
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.context?.contextWindow).toBeGreaterThanOrEqual(1_000_000)
  })
})

describe('prompt extraction & directive parsing', () => {
  it('ignores plugin/framework messages and strips injected XML blocks', () => {
    const messages: Message[] = [
      msg('system', 'You are an AI agent powered by DSH.', { kind: 'plugin', plugin: 'system' }),
      msg('user', '<available_skills>lots of skills</available_skills>', { kind: 'plugin', plugin: 'skills' }),
      msg('user', '<system-reminder>turn 1 step 1</system-reminder>\n一只在窗台晒太阳的橘猫，电影感暖光', { kind: 'user' }),
      msg('user', 'Current runtime context: cwd=/tmp', { kind: 'plugin', plugin: 'runtime' }),
    ]
    expect(extractImagePrompt(messages)).toBe('一只在窗台晒太阳的橘猫，电影感暖光')
  })

  it('parses inline aspect ratio, resolution, and count directives while keeping defaults', () => {
    const parsed = parseImagePromptDirectives(
      '水彩风雪山日出 --ar 16:9 --2k --n 2',
      { aspectRatio: '1:1', area: '1K' },
    )
    expect(parsed).toEqual({
      prompt: '水彩风雪山日出',
      aspectRatio: '16:9',
      area: '2K',
      count: 2,
    })

    const fallback = parseImagePromptDirectives('赛博朋克雨夜街道', { aspectRatio: '3:4', area: '4K' })
    expect(fallback).toEqual({
      prompt: '赛博朋克雨夜街道',
      aspectRatio: '3:4',
      area: '4K',
      count: 1,
    })
  })
})

describe('auxiliary request guard', () => {
  it('intercepts session-title and compaction calls without invoking image generation', async () => {
    const execute = vi.fn()
    const options: GenerateOptions = {
      provider: 'minimaxcode',
      model: 'MiniMax-H3-Image',
      purpose: 'session-title',
      messages: [msg('user', '画一只在太空漫步的柴犬 --ar 16:9')],
    }
    expect(detectAuxiliaryPurpose(options)).toBe('session-title')
    expect(buildAuxiliaryReply('session-title', options)).toBe('生图：画一只在太空漫步的柴犬')

    const chunks = await collect(streamImageModelCall(options, {
      getDefaults: () => ({ aspectRatio: 'auto', area: '1K' }),
      execute,
    }))
    expect(execute).not.toHaveBeenCalled()
    expect(chunks.find(c => c.type === 'text-delta')).toMatchObject({ text: '生图：画一只在太空漫步的柴犬' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('also catches title prompts via system instructions when purpose is absent', async () => {
    const execute = vi.fn()
    const chunks = await collect(streamImageModelCall({
      provider: 'minimaxcode',
      model: 'MiniMax-H3-Image',
      system: 'Generate a concise title for this conversation.',
      messages: [msg('user', '医学心脏解剖示意图')],
    }, {
      getDefaults: () => ({ aspectRatio: 'auto', area: '1K' }),
      execute,
    }))
    expect(execute).not.toHaveBeenCalled()
    expect(chunks.find(c => c.type === 'text-delta')).toMatchObject({ text: '生图：医学心脏解剖示意图' })
  })
})

describe('image persistence & streaming bridge', () => {
  it('saves bytes locally and formats DSH-friendly Markdown image output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minimax-h3-img-'))
    try {
      const savedPath = await saveImageToLocalDir(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg', 0, { dir })
      const raw = await readFile(savedPath)
      expect(raw.length).toBe(3)
      const md = formatImageResponseMarkdown({
        model: 'MiniMax-H3-Image',
        aspectRatio: '16:9',
        area: '2K',
        images: [{ localPath: savedPath, size: '1920x1080' }],
        totalTokens: 6401,
      })
      expect(md).toContain(`![MiniMax H3 生图](${savedPath.replace(/\\/g, '/')})`)
      expect(md).toContain('1920x1080')
      expect(md).toContain('6,401 tokens')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('materializes images via download, local save, and best-effort attachment store', async () => {
    const saveAttachment = vi.fn(async () => {})
    const materialized = await materializeGeneratedImages({
      images: [{ url: 'https://cdn.example/img.jpg', size: '1184x880' }],
      totalTokens: 5000,
    }, {
      download: async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      saveLocal: async () => 'C:\\Users\\Z\\.dsh\\minimax-images\\test.png',
      saveAttachment,
    })
    expect(saveAttachment).toHaveBeenCalledTimes(1)
    expect(materialized.images[0]?.localPath).toBe('C:\\Users\\Z\\.dsh\\minimax-images\\test.png')
    expect(materialized.totalTokens).toBe(5000)
  })

  it('routes H3 image models through adapter.prepareCall and reports usage', async () => {
    const onUsage = vi.fn()
    const execute = vi.fn(async () => ({
      images: [{ localPath: 'C:/Users/Z/.dsh/minimax-images/demo.jpg', size: '1024x1024' }],
      totalTokens: 6401,
    }))
    const catalog = {
      source: 'live',
      error: undefined,
      current: () => [{
        id: 'MiniMax-M3',
        name: 'M3',
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        toolCall: true,
        reasoning: true,
        inputModalities: ['text'],
        attachment: false,
      }],
      invalidate: vi.fn(),
    } as unknown as MinimaxCatalog

    const { adapter } = createMinimaxCodeAdapter({
      catalog,
      region: () => 'cn',
      resolveApiKey: async () => 'tok',
      bearerToken: () => 'tok',
      onUsage,
      imageGeneration: {
        getDefaults: () => ({ aspectRatio: '4:3', area: '2K' }),
        execute,
      },
    })

    const listed = await adapter.listModels('minimaxcode')
    expect(listed.map(m => m.id)).toEqual(['MiniMax-M3', 'MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'])

    const prepared = await adapter.prepareCall('minimaxcode', 'MiniMax-H3-Image-Highspeed')
    expect(prepared.model.id).toBe('MiniMax-H3-Image-Highspeed')
    expect(prepared.model.reasoning).toBeUndefined()

    const chunks = await collect(prepared.stream({
      provider: 'minimaxcode',
      model: 'MiniMax-H3-Image-Highspeed',
      messages: [msg('user', '医学心电图波形海报')],
    }))

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      model: 'MiniMax-H3-Image-Highspeed',
      prompt: '医学心电图波形海报',
      aspectRatio: '4:3',
      area: '2K',
      count: 1,
    }))
    expect(onUsage).toHaveBeenCalledWith('MiniMax-H3-Image-Highspeed', expect.objectContaining({
      outputTokens: 6401,
    }))
    const delta = chunks.find(c => c.type === 'text-delta')
    expect(delta && delta.type === 'text-delta' ? delta.text : '').toContain('![MiniMax H3 生图](C:/Users/Z/.dsh/minimax-images/demo.jpg)')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('surfaces structured error finish chunk when generation fails', async () => {
    const chunks = await collect(streamImageModelCall({
      provider: 'minimaxcode',
      model: 'MiniMax-H3-Image',
      messages: [msg('user', '一片海滩')],
    }, {
      getDefaults: () => ({ aspectRatio: 'auto', area: '1K' }),
      execute: async () => {
        throw new GenerationError('insufficient balance', 402, {
          kind: 'quota',
          charged: false,
          upstream: { status: 402, message: 'insufficient balance' },
        })
      },
    }))
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'insufficient balance',
          code: 'MINIMAX_H3_QUOTA',
          status: 402,
        },
      },
    })
  })
})

describe('imageOptions host action & persistence', () => {
  it('validates, persists, and reflects imageDefaults in the status document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minimax-img-opts-'))
    const prevDsh = process.env.DSH_HOME
    const prevData = process.env.MINIMAX_DATA_DIR
    process.env.DSH_HOME = dir
    process.env.MINIMAX_DATA_DIR = dir
    try {
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
      await new Promise(resolve => setTimeout(resolve, 200))

      const action = routes.get('/plugins/dsh-connect-minimaxcode/action')!
      const status = routes.get('/plugins/dsh-connect-minimaxcode/status')!

      const readStatus = async () => {
        let body = ''
        await status({ headers: { host: '127.0.0.1:19387' } }, { writeHead: () => {}, end: (t: string) => { body = t } })
        return JSON.parse(body) as { imageDefaults?: { aspectRatio: string; area: string } }
      }
      const postOptions = async (payload: Record<string, unknown>) => {
        let body = ''
        await action({
          [Symbol.asyncIterator]() { return Readable.from([JSON.stringify(payload)])[Symbol.asyncIterator]() },
          method: 'POST',
          headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
          url: '/plugins/dsh-connect-minimaxcode/action?action=imageOptions',
        }, { writeHead: () => {}, end: (t: string) => { body = t } })
        return JSON.parse(body) as Record<string, unknown>
      }

      expect((await readStatus()).imageDefaults).toEqual({ aspectRatio: 'auto', area: '1K' })
      expect(await postOptions({ aspectRatio: '16:9', area: '2K' })).toEqual({ ok: true, aspectRatio: '16:9', area: '2K' })
      expect((await readStatus()).imageDefaults).toEqual({ aspectRatio: '16:9', area: '2K' })
      expect((await postOptions({ aspectRatio: 'invalid' })).ok).toBe(false)
    } finally {
      if (prevDsh === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevDsh
      if (prevData === undefined) delete process.env.MINIMAX_DATA_DIR
      else process.env.MINIMAX_DATA_DIR = prevData
      await rm(dir, { recursive: true, force: true })
    }
  })
})
