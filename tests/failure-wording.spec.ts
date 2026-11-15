/**
 * What a failed call shows, and what a refused delivery shows.
 *
 * Two kinds of message reach the person, and each has to say something
 * different from the other:
 *
 *  - a failed generation call carries a verdict (what kind of failure, was
 *    it charged for) and the upstream's own words, so a report can be
 *    written without the person having to describe anything;
 *  - a refused delivery names the one thing that is missing, so the person
 *    knows which piece of the host to look at.
 *
 * The assertions below are about *properties*, not wording: a message may be
 * reworded freely as long as it still names what is wrong and does not
 * pretend to know what it does not.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'src', 'client.ts'), 'utf8')

describe('the wording of a failure', () => {
  it('has a sentence for every kind of failure, in both languages', () => {
    // Every kind the server can report needs a sentence here; a kind with no
    // sentence would show the reader an empty line.
    const keys = [
      'failureCredentials',
      'failureParameters',
      'failureSubscription',
      'failureQuota',
      'failureRateLimited',
      'failureLocal',
      'failureUpstream',
    ]
    for (const key of keys) {
      expect(SOURCE, `没有 ${key} 的文案`).toContain(`${key}:`)
    }
    // And the same seven in the other language, so an English reader is not
    // left with a Chinese sentence.
    for (const key of keys) {
      const occurrences = SOURCE.split(`${key}:`).length - 1
      expect(occurrences, `${key} 只有一种语言的文案`).toBe(2)
    }
  })

  it('names the upstream original and the charged case', () => {
    // The evidence and the warning are the two things a failed call adds
    // over a plain sentence.
    expect(SOURCE).toContain('failureUpstreamDetail:')
    expect(SOURCE).toContain('failureCharged:')
    expect(SOURCE).toContain('data-minimax-generation-upstream')
    expect(SOURCE).toContain('data-minimax-generation-charged')
  })

  it('shows the upstream words verbatim rather than paraphrasing them', () => {
    // The upstream's message reaches the screen as it arrived: the field is
    // carried through, not rebuilt from the code.
    expect(SOURCE).toContain('failure.upstream?.message ?? failure.error')
    expect(SOURCE).not.toMatch(/failure\.upstream\?\.message\s*\?\?\s*`/)
  })

  it('gives each delivery refusal its own sentence', () => {
    // The six ways a delivery can fail are six different facts about the
    // host; one sentence for all of them would tell the reader nothing.
    const keys = [
      'generateNoSession',
      'generateNoSessions',
      'generateNoBinding',
      'generateNoPrompt',
      'generateNoDraft',
      'generateNoInput',
    ]
    for (const key of keys) {
      expect(SOURCE, `没有 ${key} 的文案`).toContain(`${key}:`)
    }
    // And each of them names something the reader can go and look at.
    expect(SOURCE).toMatch(/generateNoSessions: '[^']*会话[^']*'/)
    expect(SOURCE).toMatch(/generateNoInput: '[^']*附件[^']*'/)
  })

  it('does not blame the account for a failure the account does not have', () => {
    // The upstream words are shown beside our sentence, not instead of it;
    // a sentence that named a cause the upstream never stated would send
    // the reader looking in the wrong place.
    const sentence = /failureUpstream: '([^']*)'/.exec(SOURCE)?.[1] ?? ''
    expect(sentence).not.toMatch(/账号|额度|网络/)
    expect(sentence).toContain('原文')
  })
})
