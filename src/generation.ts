/**
 * The MiniMax H3 generation endpoints, as the open platform documents them.
 *
 * Two different credentials and two different domains meet here:
 *
 * - The desktop app's OAuth bearer (`mmoat_`) reaches the account domain. It
 *   is what `token_plan_credit` answers, and that answer carries the
 *   account's own open-platform key (`sk-cp-…`).
 * - The generation endpoints want *that* key. The OAuth bearer is refused
 *   with `1004 login fail: Please carry the API secret key` — measured, not
 *   assumed.
 *
 * So the chain is: OAuth bearer → `token_plan_credit` → `sk-cp-` key →
 * generation. The key is a property of the account, so the person who
 * installed this plugin configured nothing.
 *
 * The image endpoint answers with a URL that expires in 24 hours, so the
 * bytes are fetched while they are fresh rather than kept as a link.
 *
 * @module dsh-connect-minimaxcode/generation
 */

import type { MinimaxRegion } from './auth.ts'

/** Open-platform API host per region. */
export const MINIMAX_API_HOSTS: Record<MinimaxRegion, string> = {
  cn: 'https://api.minimax.cn',
  io: 'https://api.minimaxi.com',
  com: 'https://api.minimaxi.com',
}

/** Image generation endpoint: the documented OpenAI-style path. */
export const IMAGE_GENERATIONS_PATH = '/v1/images/generations'

/** The endpoint that hands out the account's open-platform key. */
export const PLAN_CREDIT_PATH = '/backend/account/token_plan_credit'

/** The host the plan key comes from, per region. */
export const PLAN_CREDIT_HOSTS: Record<MinimaxRegion, string> = {
  cn: 'https://www.minimaxi.com',
  io: 'https://www.minimaxi.com',
  com: 'https://www.minimaxi.com',
}

/** Video generation task endpoint. */
export const VIDEO_GENERATION_PATH = '/v2/video_generation'

/** Video task query endpoint; the task id is the path segment. */
export const VIDEO_QUERY_PATH = '/v2/query/video_generation'

/** The image models the endpoint serves. */
export const IMAGE_MODELS = ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'] as const

/** The video model the endpoint serves. */
export const VIDEO_MODEL = 'MiniMax-H3'

/** Aspect ratios the desktop app offers for images. */
export const IMAGE_ASPECT_RATIOS = [
  'auto', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '3:1', '1:3',
] as const

/** Output areas the endpoint serves. */
export const IMAGE_AREAS = ['1K', '2K', '4K'] as const

/** Aspect ratios the desktop app offers for video. */
export const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const

/** Output resolutions the endpoint serves for video. */
export const VIDEO_RESOLUTIONS = ['768P', '2K'] as const

/** Durations the endpoint serves for video, in seconds. */
export const VIDEO_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const

/** One generated image, as the endpoint reports it. */
export interface GeneratedImage {
  /** Where the image is, valid for 24 hours. */
  url?: string
  /** The image's bytes, when the endpoint was asked for them inline. */
  bytes?: Uint8Array
  /** The media type of the bytes. */
  mediaType?: string
  /** The size the endpoint actually produced, "宽x高". */
  size?: string
  /** The prompt actually used, after the server's own enhancement. */
  revisedPrompt?: string
}

/** What one image request produced. */
export interface ImageGenerationResult {
  /** The images, in the order the endpoint returned them. */
  images: GeneratedImage[]
  /** How many were generated, as the endpoint counted them. */
  generatedImages?: number
  /** Total tokens the generation used, when the endpoint reported them. */
  totalTokens?: number
  /** The endpoint's own request id, useful when something went wrong. */
  requestId?: string
}

/** One generated video, as the task reports it. */
export interface VideoGenerationResult {
  /** The task's identifier. */
  taskId: string
  /** Where the finished video is. */
  url?: string
  /** The task's state; `succeeded` and `failed` are the two that end it. */
  status?: string
  /** The output resolution the task was made with. */
  resolution?: string
  /** The video's length in seconds. */
  duration?: number
  /** The aspect ratio the task was made with. */
  ratio?: string
  /** What the generation cost, as the task counts it. */
  totalSeconds?: number
  /** Total tokens the generation used. */
  totalTokens?: number
}

/** A generation call that the upstream refused, with the reason it gave. */
export class GenerationError extends Error {
  /** The upstream's own status code, when it gave one. */
  readonly code: number | undefined

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'GenerationError'
    this.code = code
  }
}

/**
 * Read the account's open-platform key.
 *
 * The credit endpoint answers the desktop app's OAuth bearer, and its
 * answer carries the key. It is not a secret the person had to configure: it
 * belongs to the account, the same way the balance does.
 */
export async function fetchPlanApiKey(
  credential: { token: string },
  region: MinimaxRegion,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = `${PLAN_CREDIT_HOSTS[region]}${PLAN_CREDIT_PATH}?business=Agent&device_platform=desktop`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
  })
  if (!response.ok) {
    throw new GenerationError(`token plan credit request failed: HTTP ${response.status}`, response.status)
  }
  const document = (await response.json()) as Record<string, unknown>
  const key = document.api_key
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

/** The upstream's error message, when the body carries one. */
function readErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  const base = record.base_resp
  if (typeof base === 'object' && base !== null) {
    const message = (base as Record<string, unknown>).status_msg
    if (typeof message === 'string') return message
  }
  return undefined
}

/**
 * The upstream's own refusal, when it answers with one.
 *
 * The generation endpoints do not always use the HTTP status to say no: a
 * task that does not exist comes back as `200` with
 * `base_resp.status_code: 2013`. Reading only the HTTP status would turn
 * that into an empty answer and leave the caller polling a task that will
 * never arrive, so the body's own code is checked too.
 */
function readBodyRefusal(body: unknown): { message: string; code: number } | undefined {
  const code = readErrorCode(body)
  if (code === undefined || code === 0) return undefined
  return { message: readErrorMessage(body) ?? `the upstream refused the request (${code})`, code }
}

/** The upstream's own code, when the body carries one. */
function readErrorCode(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).http_code
    const parsed = typeof code === 'string' ? Number(code) : code
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  }
  const base = record.base_resp
  if (typeof base === 'object' && base !== null) {
    const code = (base as Record<string, unknown>).status_code
    if (typeof code === 'number' && Number.isFinite(code)) return code
  }
  return undefined
}

/**
 * Call a generation endpoint and turn its refusal into a readable error.
 *
 * The upstream reports a bad parameter as HTTP 400 with a code in the
 * message, and a bad credential as HTTP 401; both arrive as an error body
 * whose `error.message` says what was wrong. The message is kept verbatim
 * because it names the offending field.
 */
async function callGeneration(
  apiKey: string,
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    if (!response.ok) throw new GenerationError(`generation request failed: HTTP ${response.status}`, response.status)
    throw new GenerationError('generation response was not JSON')
  }
  if (!response.ok) {
    throw new GenerationError(
      readErrorMessage(document) ?? `generation request failed: HTTP ${response.status}`,
      readErrorCode(document) ?? response.status,
    )
  }
  const refusal = readBodyRefusal(document)
  if (refusal !== undefined) throw new GenerationError(refusal.message, refusal.code)
  return (document ?? {}) as Record<string, unknown>
}

/**
 * Generate images from a prompt.
 *
 * The bytes are fetched while the URL is still fresh: the endpoint's link
 * expires in 24 hours, and a plugin that only kept the link would leave the
 * picture behind.
 */
export async function generateImages(
  options: {
    apiKey: string
    region: MinimaxRegion
    prompt: string
    model?: string
    aspectRatio?: string
    area?: string
    count?: number
    fetchImpl?: typeof fetch
  },
): Promise<ImageGenerationResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const body: Record<string, unknown> = {
    model: options.model ?? IMAGE_MODELS[0],
    prompt: options.prompt,
    response_format: 'url',
  }
  if (options.count !== undefined) body.n = options.count
  if (options.aspectRatio !== undefined) body.aspect_ratio = options.aspectRatio
  if (options.area !== undefined) body.area = options.area

  const document = await callGeneration(
    options.apiKey,
    `${MINIMAX_API_HOSTS[options.region]}${IMAGE_GENERATIONS_PATH}`,
    body,
    fetchImpl,
  )

  const images: GeneratedImage[] = []
  for (const entry of (document.data as unknown[] | undefined) ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const image: GeneratedImage = {}
    if (typeof record.url === 'string') image.url = record.url
    if (typeof record.size === 'string') image.size = record.size
    if (typeof record.revised_prompt === 'string') image.revisedPrompt = record.revised_prompt
    if (typeof record.b64_json === 'string') {
      image.bytes = Buffer.from(record.b64_json, 'base64')
      image.mediaType = 'image/jpeg'
    }
    images.push(image)
  }

  const usage = document.usage as Record<string, unknown> | undefined
  return {
    images,
    generatedImages: typeof usage?.generated_images === 'number' ? usage.generated_images : undefined,
    totalTokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined,
    requestId: typeof document.request_id === 'string' ? document.request_id : undefined,
  }
}

/**
 * Download a generated image's bytes.
 *
 * The link the endpoint hands out is good for a day; the picture is fetched
 * now so that nothing the plugin shows depends on that clock.
 */
export async function downloadImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const response = await fetchImpl(url)
  if (!response.ok) throw new GenerationError(`image download failed: HTTP ${response.status}`, response.status)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const header = response.headers.get('content-type') ?? 'image/jpeg'
  return { bytes, mediaType: header.split(';')[0] ?? 'image/jpeg' }
}

/**
 * Start a video generation task.
 *
 * The task is asynchronous: the endpoint answers with an identifier and the
 * video appears later, so the caller polls {@link queryVideoTask}.
 */
export async function startVideoTask(
  options: {
    apiKey: string
    region: MinimaxRegion
    prompt: string
    duration?: number
    resolution?: string
    ratio?: string
    firstFrameUrl?: string
    lastFrameUrl?: string
    fetchImpl?: typeof fetch
  },
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const content: Record<string, unknown>[] = [{ type: 'text', text: options.prompt }]
  if (options.firstFrameUrl !== undefined) {
    content.push({ type: 'image_url', image_url: { url: options.firstFrameUrl }, role: 'first_frame' })
  }
  if (options.lastFrameUrl !== undefined) {
    content.push({ type: 'image_url', image_url: { url: options.lastFrameUrl }, role: 'last_frame' })
  }
  const body: Record<string, unknown> = {
    model: VIDEO_MODEL,
    content,
  }
  if (options.duration !== undefined) body.duration = options.duration
  if (options.resolution !== undefined) body.resolution = options.resolution
  if (options.ratio !== undefined) body.ratio = options.ratio

  const document = await callGeneration(
    options.apiKey,
    `${MINIMAX_API_HOSTS[options.region]}${VIDEO_GENERATION_PATH}`,
    body,
    fetchImpl,
  )
  const taskId = document.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new GenerationError('the video task carried no task id')
  }
  return taskId
}

/**
 * Read a video task's state.
 *
 * The finished video's address is in the task's content; the endpoint also
 * reports a plain `status` string for the simpler shape.
 */
export async function queryVideoTask(
  options: { apiKey: string; region: MinimaxRegion; taskId: string; fetchImpl?: typeof fetch },
): Promise<VideoGenerationResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${MINIMAX_API_HOSTS[options.region]}${VIDEO_QUERY_PATH}/${encodeURIComponent(options.taskId)}`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${options.apiKey}` },
  })
  const text = await response.text()
  let document: Record<string, unknown>
  try {
    document = (JSON.parse(text) ?? {}) as Record<string, unknown>
  } catch {
    throw new GenerationError(`video task query failed: HTTP ${response.status}`, response.status)
  }
  if (!response.ok) {
    throw new GenerationError(
      readErrorMessage(document) ?? `video task query failed: HTTP ${response.status}`,
      readErrorCode(document) ?? response.status,
    )
  }
  const refusal = readBodyRefusal(document)
  if (refusal !== undefined) throw new GenerationError(refusal.message, refusal.code)

  // The task's own shape, measured against the live endpoint:
  // { task: { id, model, status, content: { url }, resolution, duration,
  //   ratio, usage: { total_seconds, total_tokens } } }.
  const task = (document.task ?? document) as Record<string, unknown>
  const content = task.content as Record<string, unknown> | undefined
  const usage = task.usage as Record<string, unknown> | undefined
  return {
    taskId: options.taskId,
    status: typeof task.status === 'string' ? task.status : undefined,
    url: typeof content?.url === 'string' ? content.url : undefined,
    resolution: typeof task.resolution === 'string' ? task.resolution : undefined,
    duration: typeof task.duration === 'number' ? task.duration : undefined,
    ratio: typeof task.ratio === 'string' ? task.ratio : undefined,
    totalSeconds: typeof usage?.total_seconds === 'number' ? usage.total_seconds : undefined,
    totalTokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined,
  }
}
