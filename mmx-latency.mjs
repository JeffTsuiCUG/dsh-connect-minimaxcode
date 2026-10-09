/**
 * Measure what the user actually feels: time to first token, and how much of it
 * is thinking before any text appears.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'

const auth = JSON.parse(readFileSync(join(homedir(), '.minimax', 'local-runtime.auth.json'), 'utf8'))
const token = auth.auth.accessToken

function descriptor(id) {
  return {
    id,
    name: id,
    api: 'anthropic-messages',
    provider: 'minimaxcode',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 512000,
    maxTokens: 128000,
    headers: { authorization: `Bearer ${token}` },
    thinkingLevelMap: { off: null },
  }
}

const context = {
  messages: [{ role: 'user', content: '用一句话解释什么是递归，并举一个例子。' }],
}

async function measure(id, options) {
  const t0 = performance.now()
  let firstEvent = 0
  let firstText = 0
  let text = ''
  let thinkingChars = 0
  let budget
  const spy = async (input, init) => {
    const body = /"thinking":\{[^}]*\}/.exec(String(init?.body ?? ''))?.[0]
    budget = /budget_tokens\\*":(\d+)/.exec(body ?? '')?.[1]
    return globalThis.fetch(input, init)
  }
  try {
    const stream = streamSimple(descriptor(id), context, { apiKey: token, maxTokens: 4000, fetch: spy, ...options })
    for await (const chunk of stream) {
      if (!firstEvent) firstEvent = performance.now()
      if (chunk.type === 'thinking_delta') thinkingChars += String(chunk.delta ?? '').length
      if (chunk.type === 'text_delta') {
        if (!firstText) firstText = performance.now()
        text += String(chunk.delta ?? '')
      }
    }
  } catch (error) {
    return { id, options, error: String(error?.message).slice(0, 80) }
  }
  const total = performance.now() - t0
  return {
    id,
    label: options?.reasoning ? `effort=${options.reasoning}` : 'no effort',
    budget,
    ttft: Math.round(firstText || firstEvent),
    thinkingMs: firstText && firstEvent ? Math.round(firstText - firstEvent) : 0,
    total: Math.round(total),
    thinkingChars,
    chars: text.length,
  }
}

const rows = []
rows.push(await measure('MiniMax-M3.1-Flash-Preview', { reasoning: 'high' }))
rows.push(await measure('MiniMax-M3.1-Flash-Preview', { reasoning: 'low' }))
rows.push(await measure('MiniMax-M2.7-highspeed', { reasoning: 'low' }))
rows.push(await measure('MiniMax-M3', { reasoning: 'low' }))

console.log('\nmodel                        effort      budget   TTFT   think   total  chars')
for (const r of rows) {
  if (r.error) { console.log(`${r.id.padEnd(29)} ${r.options?.reasoning ?? '-'} ERROR ${r.error}`); continue }
  console.log(
    `${r.id.padEnd(29)} ${r.label.padEnd(11)} ${String(r.budget ?? '-').padEnd(8)} ${String(r.ttft).padStart(4)}ms ${String(r.thinkingMs).padStart(5)}ms ${String(r.total).padStart(5)}ms ${String(r.chars).padStart(5)}`,
  )
}