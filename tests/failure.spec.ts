/**
 * The classification of a failure, and what it costs.
 *
 * The classification decides two things a person acts on: the remedy to
 * offer, and whether a retry would spend again. Both are read out of the
 * failure's *shape* — the status and the wording — rather than out of a code
 * some other system chose, so a renamed code keeps its meaning.
 *
 * The cases below pin that shape. Each one would fail if the classifier
 * stopped distinguishing the class it names.
 */

import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  classifyFailure,
  cooldownFor,
  remedyFor,
  remedyForEnglish,
  type FailureVerdict,
} from '../src/failure.ts'

describe('classifying a failure', () => {
  it('names a refused credential', () => {
    expect(classifyFailure('login fail: please carry the api secret key', 401)).toBe('credentials')
    expect(classifyFailure('unauthorized', 401)).toBe('credentials')
    expect(classifyFailure('forbidden', 403)).toBe('credentials')
  })

  it('names a bad parameter', () => {
    expect(classifyFailure('invalid parameter: aspect_ratio', 400)).toBe('parameters')
    expect(classifyFailure('prompt must be a string', 422)).toBe('parameters')
    expect(classifyFailure('unsupported model', 400)).toBe('parameters')
  })

  it('names a missing subscription, even when it arrives as a bad request', () => {
    // The upstream reports this one as a bad request too, and the remedies
    // are completely different: no change to the parameters helps.
    expect(classifyFailure('no active token plan subscription', 400)).toBe('subscription')
    expect(classifyFailure('not subscribed', 400)).toBe('subscription')
  })

  it('names a spent allowance', () => {
    expect(classifyFailure('insufficient balance', 400)).toBe('quota')
    expect(classifyFailure('余额不足', 400)).toBe('quota')
  })

  it('names throttling', () => {
    expect(classifyFailure('too many requests', 429)).toBe('rate-limited')
    expect(classifyFailure('rate limit exceeded', 400)).toBe('rate-limited')
  })

  it('says upstream when it does not recognise the failure', () => {
    // An unknown failure is not guessed at: the remedy is to show the
    // upstream's own words, which is what a report needs.
    expect(classifyFailure('something nobody has seen before', 500)).toBe('upstream')
    expect(classifyFailure('', undefined)).toBe('upstream')
  })

  it('reads the status when the wording is unhelpful', () => {
    expect(classifyFailure('nope', 401)).toBe('credentials')
    expect(classifyFailure('nope', 429)).toBe('rate-limited')
    expect(classifyFailure('nope', 400)).toBe('parameters')
  })
})

describe('what a failure costs', () => {
  const verdict = (charged: boolean): FailureVerdict => ({ kind: 'upstream', charged })

  it('waits only when the work may already have been charged for', () => {
    expect(cooldownFor(verdict(false))).toBe(0)
    expect(cooldownFor(verdict(true))).toBe(COOLDOWN_MS)
  })

  it('offers a remedy that names what to do, not a code', () => {
    // Every kind says something a person can act on, and none of them
    // blames the account for a problem the account does not have.
    for (const kind of ['credentials', 'parameters', 'subscription', 'quota', 'rate-limited', 'upstream', 'local'] as const) {
      const remedy = remedyFor(kind)
      expect(remedy.length, `${kind} 没有给出可执行的建议`).toBeGreaterThan(4)
      expect(remedyForEnglish(kind).length, `${kind} 的英文建议是空的`).toBeGreaterThan(4)
    }
    expect(remedyFor('parameters')).toContain('参数')
    expect(remedyForEnglish('parameters')).toContain('parameters')
    // An unknown failure must not pretend to know the cause.
    expect(remedyFor('upstream')).toContain('原文')
    expect(remedyForEnglish('upstream')).toContain('original words')
  })
})
