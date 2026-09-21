import { describe, expect, it } from 'vitest'
import { boundedToolResult, assertRequestBudget, ContextBudgetError, requestBudget } from './context-budget.ts'
import { repairToolProtocol, trimMessages } from './agent.ts'
import type { ChatMessage, ToolSpec } from './client.ts'

describe('bounded tool history', () => {
  it('preserves tail answers and includes truthful omission counts within the limit', () => {
    const raw = 'HEAD\n' + '0123456789'.repeat(8000) + '\nANSWER_AT_TAIL'
    for (const limit of [256, 1024, 32000]) {
      const result = boundedToolResult(raw, limit)
      expect(result.length).toBeLessThanOrEqual(limit)
      expect(result).toContain('characters omitted')
      expect(result).toContain('positive 1-based offset')
      const marker = result.match(/\n\[\.\.\. (\d+) characters omitted[\s\S]*?\.\.\.\]\n/)!
      expect(Number(marker[1])).toBe(raw.length - (result.length - marker[0].length))
      if (limit >= 1024) { expect(result.startsWith('HEAD')).toBe(true); expect(result.endsWith('ANSWER_AT_TAIL')).toBe(true) }
    }
    expect(boundedToolResult('small')).toBe('small')
  })
})

describe('final request budget', () => {
  it('counts actual schemas, ids and all repaired tool results plus the response reserve', () => {
    const tools: ToolSpec[] = [{ type: 'function', function: { name: 'read_file', description: 'schema'.repeat(900), parameters: {} } }]
    const messages: ChatMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'question' }, { role: 'assistant', content: '', tool_calls: Array.from({ length: 10 }, (_, i) => ({ id: 'id'.repeat(100) + i, type: 'function', function: { name: 'read_file', arguments: '{}' } })) }]
    const transformed = repairToolProtocol(trimMessages(messages, 8192, 0))
    const before = requestBudget(messages, [], 8192, 4096)
    const final = requestBudget(transformed, tools, 8192, 4096)
    expect(final.promptTokens).toBeGreaterThan(before.promptTokens)
    expect(final.totalTokens).toBe(final.promptTokens + 4096)
    expect(() => assertRequestBudget(transformed, tools, final.totalTokens - 1, 4096)).toThrow(ContextBudgetError)
    expect(() => assertRequestBudget(transformed, tools, final.totalTokens, 4096)).not.toThrow()
  })
  it('detects a retained latest user message that trimming could not make fit', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'x'.repeat(30000) }]
    const final = repairToolProtocol(trimMessages(messages, 8192))
    expect(final[1]!.content).toHaveLength(30000)
    expect(() => assertRequestBudget(final, [], 8192, 4096)).toThrow('No request was sent')
  })
  it('counts UTF-8 bytes for non-ASCII and refuses an impossible response reserve', () => {
    const count = (content: string) => requestBudget([{ role: 'user', content }], [], 32768, 4096)
    expect(count('中'.repeat(100)).promptTokens).toBeGreaterThan(count('x'.repeat(100)).promptTokens)
    expect(() => assertRequestBudget([{ role: 'user', content: 'hi' }], [], 2048, 4096)).toThrow(ContextBudgetError)
  })
})
