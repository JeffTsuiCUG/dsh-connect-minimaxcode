/**
 * The H3 generation endpoints, as the plugin calls them.
 *
 * Two credentials meet here, and the plugin has to hand the right one to each
 * endpoint: the account's OAuth bearer reaches the account domain, and the
 * open platform's own key reaches the generation endpoints. The upstream is
 * strict about this — the OAuth bearer is refused with
 * `1004 login fail: Please carry the API secret key` — so a test that passed
 * the wrong credential would look like a working call that never worked.
 *
 * These cases pin the request shape, the credential each endpoint receives,
 * and the way a refusal is turned into a readable error. Nothing here reaches
 * the network: every fetch is a stub.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  GenerationError,
  IMAGE_ASPECT_RATIOS,
  IMAGE_AREAS,
  IMAGE_MODELS,
  VIDEO_DURATIONS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  downloadImage,
  fetchPlanApiKey,
  generateImages,
  queryVideoTask,
  startVideoTask,
} from '../src/generation.ts'

/** A request the stub saw. */
interface Seen {
  url: string
  method: string
  authorization: string
  body: unknown
}

/** A fetch stub that answers per path and records what it was asked. */
function stubFetch(responses: Record<string, { status?: number; body: unknown }>, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    seen.push({
      url: target,
      method: init?.method ?? 'GET',
      authorization: String((init?.headers as Record<string, string>)?.authorization ?? ''),
      body,
    })
    const path = new URL(target).pathname
    const answer = responses[path] ?? responses[target] ?? { status: 404, body: { error: { message: 'not found' } } }
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(answer.body)).buffer,
      headers: { get: () => 'image/jpeg' },
    }
  }) as unknown as typeof fetch
}

const API_KEY = 'sk-cp-example'

describe('the generation option lists', () => {
  it('names the models the upstream serves', () => {
    expect(IMAGE_MODELS).toContain('MiniMax-H3-Image')
    expect(IMAGE_AREAS).toContain('4K')
    expect(IMAGE_ASPECT_RATIOS).toContain('auto')
    expect(VIDEO_RESOLUTIONS).toContain('2K')
    expect(VIDEO_RATIOS).toContain('16:9')
    expect(VIDEO_DURATIONS).toContain(5)
  })
})

describe('fetchPlanApiKey', () => {
  it('asks the credit endpoint with the OAuth bearer and reads the key back', async () => {
    const seen: Seen[] = []
    const fetchImpl = stubFetch({
      '/backend/account/token_plan_credit': { body: { api_key: API_KEY } },
    }, seen)
    expect(await fetchPlanApiKey({ token: 'mmoat_example' }, 'cn', fetchImpl)).toBe(API_KEY)
    expect(seen[0]?.url).toContain('/backend/account/token_plan_credit')
    expect(seen[0]?.authorization).toBe('Bearer mmoat_example')
  })

  it('reports no key when the account has none', async () => {
    const fetchImpl = stubFetch({
      '/backend/account/token_plan_credit': { body: { total_credits: 2000 } },
    })
    expect(await fetchPlanApiKey({ token: 'mmoat_example' }, 'cn', fetchImpl)).toBeUndefined()
  })
})

describe('generateImages', () => {
  it('calls the documented endpoint with the plan key', async () => {
    const seen: Seen[] = []
    const fetchImpl = stubFetch({
      '/v1/images/generations': {
        body: {
          created: 1,
          data: [{ url: 'https://example.com/a.jpg', size: '2048x2048', revised_prompt: 'a cat' }],
          usage: { generated_images: 1, total_tokens: 7056 },
          request_id: 'req-1',
        },
      },
    }, seen)
    const result = await generateImages({
      apiKey: API_KEY,
      region: 'cn',
      prompt: '一只橘猫',
      aspectRatio: '16:9',
      area: '1K',
      count: 1,
      fetchImpl,
    })
    expect(seen[0]?.url).toBe('https://api.minimax.cn/v1/images/generations')
    // The generation endpoints want the API key, not the OAuth bearer.
    expect(seen[0]?.authorization).toBe(`Bearer ${API_KEY}`)
    expect(seen[0]?.body).toEqual({
      model: 'MiniMax-H3-Image',
      prompt: '一只橘猫',
      response_format: 'url',
      n: 1,
      aspect_ratio: '16:9',
      area: '1K',
    })
    expect(result.images[0]?.url).toBe('https://example.com/a.jpg')
    expect(result.images[0]?.size).toBe('2048x2048')
    expect(result.generatedImages).toBe(1)
    expect(result.totalTokens).toBe(7056)
    expect(result.requestId).toBe('req-1')
  })

  it('reads an inline image when the endpoint sends the bytes', async () => {
    const fetchImpl = stubFetch({
      '/v1/images/generations': {
        body: { data: [{ b64_json: Buffer.from('bytes').toString('base64'), size: '1024x1024' }] },
      },
    })
    const result = await generateImages({ apiKey: API_KEY, region: 'cn', prompt: 'x', fetchImpl })
    expect(result.images[0]?.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(result.images[0]!.bytes!).toString()).toBe('bytes')
  })

  it('turns a refusal into a readable error that names the code', async () => {
    const fetchImpl = stubFetch({
      '/v1/images/generations': {
        status: 402,
        body: { error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)', http_code: '402' } },
      },
    })
    await expect(generateImages({ apiKey: API_KEY, region: 'cn', prompt: 'x', fetchImpl }))
      .rejects.toThrow(/insufficient balance/)
    await expect(generateImages({ apiKey: API_KEY, region: 'cn', prompt: 'x', fetchImpl }))
      .rejects.toBeInstanceOf(GenerationError)
  })
})

describe('downloadImage', () => {
  it('fetches the bytes while the link is fresh', async () => {
    const seen: Seen[] = []
    const fetchImpl = stubFetch({ 'https://example.com/a.jpg': { body: 'jpeg-bytes' } }, seen)
    const image = await downloadImage('https://example.com/a.jpg', fetchImpl)
    expect(image.mediaType).toBe('image/jpeg')
    expect(image.bytes.length).toBeGreaterThan(0)
  })
})

describe('video tasks', () => {
  it('starts a task with the documented shape', async () => {
    const seen: Seen[] = []
    const fetchImpl = stubFetch({
      '/v2/video_generation': { body: { task_id: 'task-1' } },
    }, seen)
    const taskId = await startVideoTask({
      apiKey: API_KEY,
      region: 'cn',
      prompt: 'a cat on a windowsill',
      duration: 5,
      resolution: '768P',
      ratio: '16:9',
      fetchImpl,
    })
    expect(taskId).toBe('task-1')
    expect(seen[0]?.url).toBe('https://api.minimax.cn/v2/video_generation')
    expect(seen[0]?.authorization).toBe(`Bearer ${API_KEY}`)
    expect(seen[0]?.body).toEqual({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: 'a cat on a windowsill' }],
      duration: 5,
      resolution: '768P',
      ratio: '16:9',
    })
  })

  it('carries a first frame when one is given', async () => {
    const seen: Seen[] = []
    const fetchImpl = stubFetch({ '/v2/video_generation': { body: { task_id: 'task-2' } } }, seen)
    await startVideoTask({
      apiKey: API_KEY,
      region: 'cn',
      prompt: 'move',
      firstFrameUrl: 'https://example.com/first.png',
      fetchImpl,
    })
    const body = seen[0]?.body as { content: unknown[] }
    expect(body.content).toHaveLength(2)
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/first.png' },
      role: 'first_frame',
    })
  })

  it('refuses a task that carries no identifier', async () => {
    const fetchImpl = stubFetch({ '/v2/video_generation': { body: { task_id: '' } } })
    await expect(startVideoTask({ apiKey: API_KEY, region: 'cn', prompt: 'x', fetchImpl }))
      .rejects.toThrow(/task id/)
  })

  it('reads the finished video out of the task', async () => {
    const fetchImpl = stubFetch({
      '/v2/query/video_generation/task-1': {
        body: {
          task: {
            id: 'task-1',
            model: 'MiniMax-H3',
            status: 'succeeded',
            content: { url: 'https://example.com/out.mp4' },
            resolution: '768P',
            duration: 5,
            ratio: '16:9',
            usage: { total_seconds: 5, total_tokens: 162745 },
          },
        },
      },
    })
    const task = await queryVideoTask({ apiKey: API_KEY, region: 'cn', taskId: 'task-1', fetchImpl })
    expect(task.status).toBe('succeeded')
    expect(task.url).toBe('https://example.com/out.mp4')
    expect(task.resolution).toBe('768P')
    expect(task.duration).toBe(5)
    expect(task.ratio).toBe('16:9')
    expect(task.totalSeconds).toBe(5)
    expect(task.totalTokens).toBe(162745)
  })

  it('reports a task that does not exist', async () => {
    const fetchImpl = stubFetch({
      '/v2/query/video_generation/nope': {
        body: { base_resp: { status_code: 2013, status_msg: 'invalid params, This task_id does not exist' } },
      },
    })
    await expect(queryVideoTask({ apiKey: API_KEY, region: 'cn', taskId: 'nope', fetchImpl }))
      .rejects.toThrow(/does not exist/)
  })
})
