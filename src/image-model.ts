/**
 * Expose MiniMax H3 image generation models through DSH's standard LLM model
 * picker by bridging `LlmAdapter` requests to `/v1/images/generations`.
 *
 * DSH's `ctx.llm` only accepts chat adapters, so image generation models are
 * advertised as non-reasoning text models and intercepted before reaching the
 * Anthropic Messages chat gateway.
 *
 * @module dsh-connect-minimaxcode/image-model
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { dshHome } from './credentials.ts'
import {
  GenerationError,
  IMAGE_AREAS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODELS,
  type ImageGenerationResult,
} from './generation.ts'

/** Canonical metadata for each MiniMax H3 image generation model. */
export interface ImageModelSpec {
  readonly id: (typeof IMAGE_MODELS)[number]
  readonly name: string
  readonly description: string
}

export const IMAGE_MODEL_SPECS: readonly ImageModelSpec[] = [
  {
    id: 'MiniMax-H3-Image',
    name: 'H3-Image (生图)',
    description: 'MiniMax H3 图像生成模型（支持在输入框工具栏或提示词 --ar / --2k 调整画幅与清晰度）',
  },
  {
    id: 'MiniMax-H3-Image-Highspeed',
    name: 'H3-Image-Highspeed (高速生图)',
    description: 'MiniMax H3 高速图像生成模型（出图更快，支持画幅与清晰度设置）',
  },
] as const

export const DEFAULT_IMAGE_ASPECT_RATIO = 'auto'
export const DEFAULT_IMAGE_AREA = '1K'

/** Local directory name under `dshHome()` for persisted generated images. */
export const MINIMAX_IMAGES_DIRNAME = 'minimax-images'

/** Maximum prompt length forwarded to the image generation endpoint. */
const MAX_IMAGE_PROMPT_CHARS = 2000

const FRAMEWORK_MARKERS = [
  'Current runtime context',
  'Current working directory:',
  'Time sampled while preparing',
  'Elapsed since the preceding',
  'Available skills:',
  '[Plugin context from',
  '[the previous turn was interrupted',
  '<system-reminder>',
  '<available_skills>',
  '<mcp_catalog>',
  '<hindsight_pages>',
  '<hindsight_page_refresh>',
  '<hindsight_knowledge',
  'A skill is a reusable set of task-specific instructions',
  'The following MCP servers are available',
  'You are an AI agent powered by',
] as const

const TITLE_PROMPT_PATTERNS = [
  /generate\s+a\s+(?:short|brief|concise)\s+title/i,
  /session\s+title/i,
  /conversation\s+title/i,
  /生成.*(?:简短)?标题/,
  /起一个.*标题/,
] as const

const COMPACTION_PROMPT_PATTERNS = [
  /summarize\s+the\s+conversation/i,
  /compact\s+the\s+conversation/i,
  /总结.*对话/,
] as const

/** Strip an optional `provider/` prefix from a model id. */
function bareModelId(model: string): string {
  const slash = model.lastIndexOf('/')
  return (slash >= 0 ? model.slice(slash + 1) : model).trim()
}

/** Resolve a model id to one of the canonical H3 image model ids, if it matches. */
export function resolveCanonicalImageModelId(model: string | undefined): ImageModelSpec['id'] | undefined {
  if (typeof model !== 'string' || model.trim().length === 0) return undefined
  const lower = bareModelId(model).toLowerCase()
  const found = IMAGE_MODEL_SPECS.find(spec => spec.id.toLowerCase() === lower)
  return found?.id
}

/** Whether `model` targets one of the MiniMax H3 image generation models. */
export function isImageGenerationModel(model: string | undefined): boolean {
  return resolveCanonicalImageModelId(model) !== undefined
}

/** Model descriptors advertised in DSH's model picker. */
export function listImageModels(provider: string): LlmModelInfo[] {
  return IMAGE_MODEL_SPECS.map(spec => ({
    provider,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputModalities: ['text'],
  }))
}

/** Resolved metadata for one exact image model route (non-reasoning). */
export function resolveImageModelInfo(provider: string, model: string): LlmResolvedModelInfo {
  const canonical = resolveCanonicalImageModelId(model)
  const spec = IMAGE_MODEL_SPECS.find(entry => entry.id === canonical) ?? IMAGE_MODEL_SPECS[0]!
  return {
    provider,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputModalities: ['text'],
    // Keep a large declared window (matching M3/M3.1-Flash) so switching to an
    // image model mid-conversation never fails DSH's compaction headroom check
    // (65536 headroom + 4096 maxTokens) or triggers unwanted compaction.
    context: { contextWindow: 1_000_000 },
    defaultMaxTokens: 4096,
  }
}

/** Flatten all text blocks of a message into a single string. */
function textOfBlocks(blocks: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Remove framework-injected XML blocks that may ride inside a user message. */
export function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<hindsight_page_refresh>[\s\S]*?<\/hindsight_page_refresh>/gi, '')
    .replace(/<hindsight_pages>[\s\S]*?<\/hindsight_pages>/gi, '')
    .replace(/<hindsight_knowledge[\s\S]*?<\/hindsight_knowledge>/gi, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '')
    .replace(/<mcp_catalog>[\s\S]*?<\/mcp_catalog>/gi, '')
    .trim()
}

function looksLikeFramework(text: string): boolean {
  const head = text.slice(0, 400)
  if (head.startsWith('<')) return true
  if (/^[<[]/.test(head) && head.includes('>')) return true
  return FRAMEWORK_MARKERS.some(marker => head.includes(marker))
}

/**
 * Detect host auxiliary requests (session title generation, compaction) so
 * selecting an image model for a new session never spends image quota on a
 * title call.
 */
export function detectAuxiliaryPurpose(options: GenerateOptions): 'session-title' | 'compaction' | undefined {
  if (options.purpose === 'session-title' || options.purpose === 'compaction') {
    return options.purpose
  }
  const systemParts: string[] = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    systemParts.push(options.system)
  }
  for (const msg of options.messages ?? []) {
    if (msg.role === 'system') {
      systemParts.push(textOfBlocks(msg.content))
    }
  }
  const systemText = systemParts.join('\n')
  if (systemText.length > 0) {
    if (TITLE_PROMPT_PATTERNS.some(pattern => pattern.test(systemText))) return 'session-title'
    if (COMPACTION_PROMPT_PATTERNS.some(pattern => pattern.test(systemText))) return 'compaction'
  }
  return undefined
}

/**
 * Extract the real user prompt from a DSH conversation transcript.
 *
 * Prefers messages explicitly tagged `source.kind === 'user'`, which excludes
 * plugin-injected context (`source.kind === 'plugin'`) and tool results
 * (`source.kind === 'tool'`). Falls back to content heuristics when a caller
 * constructs messages without `source`.
 */
export function extractImagePrompt(messages: readonly Message[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''

  // Pass 1: trust DSH's typed `source.kind === 'user'` provenance.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined || message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    const cleaned = stripInjectedBlocks(textOfBlocks(message.content))
    if (cleaned.length > 0) {
      return cleaned.slice(0, MAX_IMAGE_PROMPT_CHARS)
    }
  }

  // Pass 2: fallback for synthetic transcripts without `source.kind === 'user'`.
  let fallback = ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined || message.role !== 'user') continue
    if (message.source?.kind === 'plugin' || message.source?.kind === 'tool') continue
    const cleaned = stripInjectedBlocks(textOfBlocks(message.content))
    if (cleaned.length === 0 || looksLikeFramework(cleaned)) continue
    if (cleaned.length <= MAX_IMAGE_PROMPT_CHARS) return cleaned
    if (fallback.length === 0) fallback = cleaned.slice(0, MAX_IMAGE_PROMPT_CHARS)
  }
  return fallback
}

/** Parsed prompt plus effective image generation parameters. */
export interface ParsedImageRequest {
  prompt: string
  aspectRatio: string
  area: string
  count: number
}

const VALID_ASPECT_RATIOS = new Map<string, string>(
  IMAGE_ASPECT_RATIOS.map(value => [value.toLowerCase(), value]),
)
const VALID_AREAS = new Map<string, string>(
  IMAGE_AREAS.map(value => [value.toLowerCase(), value]),
)

/** Validate an aspect ratio against MiniMax H3's supported list. */
export function normalizeAspectRatio(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return VALID_ASPECT_RATIOS.get(value.trim().toLowerCase())
}

/** Validate an output area (`1K` / `2K` / `4K`) against MiniMax H3's list. */
export function normalizeImageArea(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return VALID_AREAS.get(value.trim().toLowerCase())
}

/**
 * Parse optional inline directives (`--ar 16:9`, `--2k`, `--area 4K`, `--n 2`)
 * out of a user's prompt while keeping defaults from the composer pill.
 */
export function parseImagePromptDirectives(
  rawPrompt: string,
  defaults?: { aspectRatio?: string; area?: string },
): ParsedImageRequest {
  let aspectRatio = normalizeAspectRatio(defaults?.aspectRatio) ?? DEFAULT_IMAGE_ASPECT_RATIO
  let area = normalizeImageArea(defaults?.area) ?? DEFAULT_IMAGE_AREA
  let count = 1

  let prompt = rawPrompt
    // --ar 16:9 / --aspect 16:9 / --ratio 16:9 (supports `=` or whitespace)
    .replace(/(?:^|\s)--(?:ar|aspect|ratio)(?:=|\s+)([^\s]+)/gi, (full, rawValue: string) => {
      const normalized = normalizeAspectRatio(rawValue)
      if (normalized === undefined) return full
      aspectRatio = normalized
      return ' '
    })
    // --area 2K / --size 4K
    .replace(/(?:^|\s)--(?:area|size)(?:=|\s+)([^\s]+)/gi, (full, rawValue: string) => {
      const normalized = normalizeImageArea(rawValue)
      if (normalized === undefined) return full
      area = normalized
      return ' '
    })
    // Shorthand flags: --1k / --2k / --4k
    .replace(/(?:^|\s)--(1k|2k|4k)(?=\s|$)/gi, (_full, rawValue: string) => {
      const normalized = normalizeImageArea(rawValue)
      if (normalized !== undefined) area = normalized
      return ' '
    })
    // --n 2 / --count 2 (bounded to 1..4)
    .replace(/(?:^|\s)--(?:n|count)(?:=|\s+)(\d+)(?=\s|$)/gi, (full, rawValue: string) => {
      const parsed = Number.parseInt(rawValue, 10)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) return full
      count = parsed
      return ' '
    })

  prompt = prompt.replace(/[ \t]{2,}/g, ' ').trim()
  return { prompt, aspectRatio, area, count }
}

/** Build a short text reply for auxiliary host requests without generating images. */
export function buildAuxiliaryReply(
  purpose: 'session-title' | 'compaction',
  options: GenerateOptions,
): string {
  const userText = extractImagePrompt(options.messages)
  const parsed = parseImagePromptDirectives(userText)
  const compact = parsed.prompt.replace(/\s+/g, ' ').trim()
  if (purpose === 'session-title') {
    if (compact.length === 0) return 'MiniMax H3 生图'
    const clipped = compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
    return `生图：${clipped}`
  }
  return compact.length > 0 ? `图像生成会话：${compact.slice(0, 120)}` : 'MiniMax H3 图像生成会话'
}

/** Map an image MIME type to a file extension. */
function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'jpg'
  }
}

/** Escape characters that break Markdown image links. */
function markdownSafeUrl(raw: string): string {
  const queryIndex = raw.indexOf('?')
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex)
  const queryPart = queryIndex === -1 ? '' : raw.slice(queryIndex)
  return (
    pathPart.replace(/~/g, '%7E').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')
    + queryPart.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')
  )
}

/** Persist generated image bytes under `~/.dsh/minimax-images/`. */
export async function saveImageToLocalDir(
  bytes: Uint8Array,
  mediaType: string,
  index: number,
  options?: { dir?: string; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const dir = options?.dir ?? join(dshHome(options?.env), MINIMAX_IMAGES_DIRNAME)
  await mkdir(dir, { recursive: true })
  const now = options?.now ?? new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const suffix = Math.random().toString(36).slice(2, 6)
  const ext = extensionForMediaType(mediaType)
  const filePath = join(dir, `minimax-h3-${stamp}-${suffix}-${index + 1}.${ext}`)
  await writeFile(filePath, bytes)
  return filePath
}

/** One materialized generated image ready for Markdown output. */
export interface MaterializedImage {
  /** Local file path on disk, when saving succeeded. */
  localPath?: string
  /** Fallback remote URL, when local save failed. */
  url?: string
  size?: string
  revisedPrompt?: string
}

/** Format generated images and metadata into Markdown rendered by DSH chat. */
export function formatImageResponseMarkdown(params: {
  model: string
  aspectRatio: string
  area: string
  images: readonly MaterializedImage[]
  totalTokens?: number
}): string {
  const sections: string[] = []
  for (const [index, image] of params.images.entries()) {
    const label = params.images.length > 1 ? `MiniMax H3 生图 ${index + 1}` : 'MiniMax H3 生图'
    const target = image.localPath !== undefined
      ? markdownSafeUrl(image.localPath.replace(/\\/g, '/'))
      : image.url !== undefined
        ? markdownSafeUrl(image.url)
        : undefined
    if (target !== undefined) {
      sections.push(`![${label}](${target})`)
    }
  }

  const metaParts: string[] = [`模型：\`${params.model}\``]
  const sizes = params.images.map(img => img.size).filter((s): s is string => typeof s === 'string' && s.length > 0)
  if (sizes.length > 0) metaParts.push(`尺寸：${sizes.join(', ')}`)
  metaParts.push(`画幅：${params.aspectRatio}`)
  metaParts.push(`清晰度：${params.area}`)
  if (params.totalTokens !== undefined && params.totalTokens > 0) {
    metaParts.push(`消耗：${params.totalTokens.toLocaleString('en-US')} tokens`)
  }
  sections.push(`> ${metaParts.join(' · ')}`)

  const savedPaths = params.images
    .map(img => img.localPath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (savedPaths.length === 1) {
    sections.push(`> 已保存：\`${savedPaths[0]}\``)
  } else if (savedPaths.length > 1) {
    sections.push(`> 已保存：\n${savedPaths.map(p => `> - \`${p}\``).join('\n')}`)
  }

  return sections.join('\n\n')
}

/** One completed image generation handled by the plugin host layer. */
export interface ImageModelRunResult {
  images: MaterializedImage[]
  totalTokens?: number
  requestId?: string
}

/** Host callback invoked when an image model is called from the model picker. */
export type ImageModelExecutor = (request: {
  model: ImageModelSpec['id']
  prompt: string
  aspectRatio: string
  area: string
  count: number
  signal?: AbortSignal
}) => Promise<ImageModelRunResult>

/** Options for streaming an image generation call through `LlmAdapter`. */
export interface ImageStreamBridgeOptions {
  /** Read current default aspect ratio and output area. */
  getDefaults: () => { aspectRatio: string; area: string }
  /** Execute the actual MiniMax H3 image generation and persistence. */
  execute: ImageModelExecutor
}

/**
 * Helper to turn raw `generateImages` output into persisted local files plus
 * optional DSH attachment copies.
 */
export async function materializeGeneratedImages(
  result: ImageGenerationResult,
  deps: {
    download: (url: string) => Promise<{ bytes: Uint8Array; mediaType: string }>
    saveAttachment?: (bytes: Uint8Array, mediaType: string) => Promise<unknown>
    saveLocal?: (bytes: Uint8Array, mediaType: string, index: number) => Promise<string>
  },
): Promise<ImageModelRunResult> {
  const images: MaterializedImage[] = []
  const saveLocal = deps.saveLocal ?? ((bytes, mediaType, index) => saveImageToLocalDir(bytes, mediaType, index))

  for (const [index, entry] of result.images.entries()) {
    if (entry.bytes === undefined && entry.url === undefined) continue
    let bytes = entry.bytes
    let mediaType = entry.mediaType ?? 'image/jpeg'
    if (bytes === undefined && entry.url !== undefined) {
      try {
        const downloaded = await deps.download(entry.url)
        bytes = downloaded.bytes
        mediaType = downloaded.mediaType
      } catch {
        images.push({ url: entry.url, size: entry.size, revisedPrompt: entry.revisedPrompt })
        continue
      }
    }
    let localPath: string | undefined
    if (bytes !== undefined) {
      try {
        localPath = await saveLocal(bytes, mediaType, index)
      } catch {
        localPath = undefined
      }
      if (deps.saveAttachment !== undefined) {
        try {
          await deps.saveAttachment(bytes, mediaType)
        } catch {
          // Attachment persistence is best-effort.
        }
      }
    }
    images.push({
      localPath,
      url: localPath === undefined ? entry.url : undefined,
      size: entry.size,
      revisedPrompt: entry.revisedPrompt,
    })
  }

  return {
    images,
    totalTokens: result.totalTokens,
    requestId: result.requestId,
  }
}

/** Emit one plain-text assistant response over DSH's `StreamChunk` protocol. */
async function* emitTextStream(
  text: string,
  totalTokens?: number,
): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  if (totalTokens !== undefined && totalTokens > 0) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: 0,
        outputTokens: totalTokens,
        totalTokens,
      },
    }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Stream one model-picker request targeted at a MiniMax H3 image model. */
export function streamImageModelCall(
  options: GenerateOptions,
  bridge: ImageStreamBridgeOptions,
): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      if (options.signal?.aborted) {
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: { message: '图片生成已取消', code: 'ABORTED' },
          },
        }
        return
      }

      const auxiliary = detectAuxiliaryPurpose(options)
      if (auxiliary !== undefined) {
        yield* emitTextStream(buildAuxiliaryReply(auxiliary, options))
        return
      }

      const canonicalModel = resolveCanonicalImageModelId(options.model) ?? IMAGE_MODELS[0]
      const rawPrompt = extractImagePrompt(options.messages)
      const parsed = parseImagePromptDirectives(rawPrompt, bridge.getDefaults())
      if (parsed.prompt.length === 0) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: '请提供要生成的画面描述（提示词为空）。',
              code: 'INVALID_PROMPT',
            },
          },
        }
        return
      }

      try {
        const result = await bridge.execute({
          model: canonicalModel,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          area: parsed.area,
          count: parsed.count,
          signal: options.signal,
        })
        if (options.signal?.aborted) {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { message: '图片生成已取消', code: 'ABORTED' },
            },
          }
          return
        }
        if (result.images.length === 0) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: 'MiniMax H3 上游没有返回图片，请稍后重试。',
                code: 'EMPTY_IMAGE_RESULT',
              },
            },
          }
          return
        }
        const markdown = formatImageResponseMarkdown({
          model: canonicalModel,
          aspectRatio: parsed.aspectRatio,
          area: parsed.area,
          images: result.images,
          totalTokens: result.totalTokens,
        })
        yield* emitTextStream(markdown, result.totalTokens)
      } catch (error) {
        if (options.signal?.aborted) {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { message: '图片生成已取消', code: 'ABORTED' },
            },
          }
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof GenerationError
          ? `MINIMAX_H3_${error.verdict.kind.toUpperCase().replace(/-/g, '_')}`
          : 'MINIMAX_H3_ERROR'
        const status = error instanceof GenerationError ? error.verdict.upstream?.status : undefined
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message,
              code,
              ...(status === undefined ? {} : { status }),
            },
          },
        }
      }
    },
  }
}
