import { describe, expect, it } from 'vitest'
import { statusDocument, isLoopback, MINIMAX_STATUS_PATH } from '../src/status-route.ts'

const MODELS = [{ id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 200000 }]

function base(overrides: Partial<Parameters<typeof statusDocument>[0]> = {}) {
  return {
    auth: { state: 'signed-in' as const, daysRemaining: 15, expiry: 'healthy' as const },
    region: 'cn',
    catalogSource: 'live' as const,
    models: MODELS,
    refreshing: false,
    ...overrides,
  }
}

describe('statusDocument', () => {
  it('names the route the card polls', () => {
    expect(MINIMAX_STATUS_PATH).toBe('/plugins/dsh-connect-minimaxcode/status')
  })

  it('reports remaining days when signed in', () => {
    const doc = statusDocument(base())
    expect(doc.state).toBe('signed-in')
    expect(doc.daysRemaining).toBe(15)
    expect(doc.expiry).toBe('healthy')
    expect(doc.hint).toBeUndefined()
  })

  it('surfaces the expiring state without changing the headline', () => {
    const doc = statusDocument(base({ auth: { state: 'signed-in', daysRemaining: 1, expiry: 'expiring' } }))
    expect(doc.state).toBe('signed-in')
    expect(doc.expiry).toBe('expiring')
  })

  it('gives a distinct remedy per signed-out reason', () => {
    const missing = statusDocument(base({ auth: { state: 'signed-out', reason: 'app-missing' } }))
    const signed = statusDocument(base({ auth: { state: 'signed-out', reason: 'not-signed-in' } }))
    expect(missing.hint).toContain('安装')
    expect(signed.hint).toContain('登录')
    expect(missing.hint).not.toBe(signed.hint)
  })

  it('always tells an expired user what to do', () => {
    const doc = statusDocument(base({ auth: { state: 'expired' } }))
    expect(doc.state).toBe('expired')
    expect(doc.expiry).toBe('expired')
    expect(doc.daysRemaining).toBe(0)
    expect(doc.hint).toContain('登录 MiniMax Code')
  })

  it('reports a catalog failure while still listing models', () => {
    const doc = statusDocument(base({ catalogSource: 'fallback', catalogError: 'HTTP 503' }))
    expect(doc.catalogError).toBe('HTTP 503')
    expect(doc.models).toHaveLength(1)
  })

  it('never carries a token', () => {
    const doc = JSON.stringify(statusDocument(base()))
    expect(doc).not.toMatch(/eyJ/)
    expect(doc).not.toContain('Bearer')
  })
})

describe('isLoopback', () => {
  it('accepts loopback hosts with and without ports', () => {
    expect(isLoopback('127.0.0.1:19387')).toBe(true)
    expect(isLoopback('localhost')).toBe(true)
    expect(isLoopback('[::1]:8080')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isLoopback('example.com')).toBe(false)
    expect(isLoopback('192.168.1.5')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })
})