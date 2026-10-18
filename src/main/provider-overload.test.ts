import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../shared/structured-agent'
import { isOverloadedErrorInfo, isProviderOverloadedMessage, OVERLOAD_RETRY_DELAYS_MS, overloadExhaustedMessage, overloadRetryNotice, turnProducedOutput } from './provider-overload'

describe('provider capacity refusals', () => {
  it('recognises Codex, OpenAI and Anthropic capacity errors', () => {
    for (const message of [
      'Selected model is at capacity. Please try a different model.',
      'server_overloaded: The server is overloaded, please try again later',
      'The engine is currently overloaded, please try again later',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'Overloaded',
      'unexpected status 503 Service Unavailable: upstream is at capacity',
      'Service Unavailable (HTTP 503)'
    ]) expect(isProviderOverloadedMessage(message), message).toBe(true)
  })

  it('leaves usage limits, rate limits and other failures alone', () => {
    for (const message of [
      "You've hit your usage limit. Upgrade to Pro or try again at 7:05 PM.",
      'Rate limit reached for requests',
      'synthetic failure',
      'Failed to authenticate: OAuth session expired',
      'The context window is full; start a new conversation',
      '503 tests passed'
    ]) expect(isProviderOverloadedMessage(message), message).toBe(false)
  })

  it("reads Codex's structured error info", () => {
    expect(isOverloadedErrorInfo('serverOverloaded')).toBe(true)
    expect(isOverloadedErrorInfo({ responseTooManyFailedAttempts: { httpStatusCode: 503 } })).toBe(true)
    expect(isOverloadedErrorInfo({ httpConnectionFailed: { httpStatusCode: 529 } })).toBe(true)
    expect(isOverloadedErrorInfo('usageLimitExceeded')).toBe(false)
    expect(isOverloadedErrorInfo({ responseStreamDisconnected: { httpStatusCode: 500 } })).toBe(false)
    expect(isOverloadedErrorInfo(undefined)).toBe(false)
  })

  it('says what happens next in one readable line, and what to do once it gave up', () => {
    expect(OVERLOAD_RETRY_DELAYS_MS).toEqual([20_000, 60_000, 180_000])
    expect(overloadRetryNotice('codex', 'gpt-6.1-sol', 60_000, 2)).toBe('OpenAI says gpt-6.1-sol is at capacity; retrying in 60 s (2/3).')
    expect(overloadRetryNotice('claude', undefined, 180_000, 3)).toBe('Anthropic says the model is at capacity; retrying in 3 min (3/3).')
    const exhausted = overloadExhaustedMessage('codex', 'gpt-6.1-sol', 'Selected model is at capacity.\nPlease try a different model.')
    expect(exhausted).toContain('after 3 automatic retries ("Selected model is at capacity. Please try a different model.")')
    expect(exhausted).toContain('Switch this conversation to another model or provider')
  })

  it('tells a turn that did work from one refused before it did anything', () => {
    const item = (sequence: number, data: TimelineItem['data']): TimelineItem => ({ id: 'i' + sequence, runtimeId: 'r', sequence, timestamp: '2026-10-19T00:00:00.000Z', data })
    const before = [item(1, { type: 'text', role: 'assistant', text: 'Earlier turn', mode: 'snapshot' }), item(3, { type: 'text', role: 'user', text: 'Build it', mode: 'snapshot' }), item(4, { type: 'notice', message: 'retrying' }), item(5, { type: 'text', role: 'assistant', text: '  ', mode: 'snapshot' })]
    expect(turnProducedOutput(before, 2)).toBe(false)
    expect(turnProducedOutput([...before, item(6, { type: 'tool', name: 'Bash', status: 'completed' })], 2)).toBe(true)
    expect(turnProducedOutput([...before, item(6, { type: 'text', role: 'assistant', text: 'Half an answer', mode: 'snapshot' })], 2)).toBe(true)
    expect(turnProducedOutput([...before, item(6, { type: 'changes', changes: [] })], 2)).toBe(true)
  })
})
