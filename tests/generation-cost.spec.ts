/**
 * What a failed generation call costs, and what it answers.
 *
 * The distinction that matters to a person: a failure that happened before
 * the request left cost nothing and may be retried at once, while one that
 * happened after the upstream accepted the work may already have been
 * charged for, and a retry is another charge.
 *
 * The cases drive the real call path with a fake upstream, so what they
 * check is what the plugin would actually do.
 */

import { describe, expect, it, vi } from 'vitest'
import { generateImages, queryVideoTask, startVideoTask } from '../src/generation.ts'
import { GenerationError } from '../src/generation.ts'

const KEY = 'sk-cp-test'
const BASE = { apiKey: KEY, region: 'cn' as const }

/** A fake upstream that answers with one prepared response. */
function upstream(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('a refused image call', () => {
  it('spends nothing, because the upstream refused before producing anything', async () => {
    const fetchImpl = upstream(400, { base_resp: { status_code: 2013, status_msg: 'invalid parameter' } })
    const error = await generateImages({ ...BASE, prompt: 'x', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GenerationError)
    const failure = (error as GenerationError).verdict
    expect(failure.charged).toBe(false)
    expect(failure.kind).toBe('parameters')
    // The upstream's own words travel with the failure.
    expect(failure.upstream?.message).toBe('invalid parameter')
    expect(failure.upstream?.status).toBe(400)
  })

  it('keeps the upstream code and status beside the message', async () => {
    const fetchImpl = upstream(401, { error: { message: 'login fail', http_code: 1004 } })
    const error = await generateImages({ ...BASE, prompt: 'x', fetchImpl }).catch((e: unknown) => e)
    const failure = (error as GenerationError).verdict
    expect(failure.kind).toBe('credentials')
    expect(failure.upstream?.code).toBe(1004)
    expect(failure.upstream?.status).toBe(401)
  })

  it('reads a refusal that arrives with HTTP 200 and a body code', async () => {
    // The upstream reports some refusals with a 200 and a code in the body;
    // reading only the HTTP status would call those a success.
    const fetchImpl = upstream(200, { base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' } })
    const error = await generateImages({ ...BASE, prompt: 'x', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GenerationError)
    expect((error as GenerationError).verdict.kind).toBe('subscription')
  })
})

describe('a video task', () => {
  it('spends nothing when the submission itself is refused', async () => {
    const fetchImpl = upstream(400, { base_resp: { status_code: 2013, status_msg: 'invalid parameter' } })
    const error = await startVideoTask({ ...BASE, prompt: 'x', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GenerationError)
    expect((error as GenerationError).verdict.charged).toBe(false)
  })

  it('may already have been charged for when reading the task back fails', async () => {
    // The task was submitted, so the upstream had accepted the work before
    // this query failed. A retry would be a second task, and a second charge.
    const fetchImpl = upstream(500, { base_resp: { status_code: 5000, status_msg: 'internal error' } })
    const error = await queryVideoTask({ ...BASE, taskId: 'task-1', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GenerationError)
    expect((error as GenerationError).verdict.charged).toBe(true)
  })

  it('may already have been charged for when the task comes back unreadable', async () => {
    // The same fact, reached by the other road: the answer was not JSON at
    // all. Both roads lead to the same place — the task exists, so the work
    // may have been charged for.
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    const error = await queryVideoTask({ ...BASE, taskId: 'task-1', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GenerationError)
    expect((error as GenerationError).verdict.charged).toBe(true)
  })

  it('may already have been charged for when the task comes back with a refusal', async () => {
    // The third road: the answer was JSON, it carried HTTP 200, and the
    // refusal was in the body — the shape the upstream uses for some
    // refusals. The task still exists, so the work may have been charged.
    const fetchImpl = upstream(200, { base_resp: { status_code: 5000, status_msg: 'internal error' } })
    const error = await queryVideoTask({ ...BASE, taskId: 'task-1', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GenerationError)
    expect((error as GenerationError).verdict.charged).toBe(true)
  })
})
