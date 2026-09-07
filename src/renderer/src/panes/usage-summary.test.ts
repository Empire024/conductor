import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { liveTokenLabel, subagentCountLabel, summarizeSubagents, summarizeUsage, summarizeContext, summarizeWorkingUsage } from './usage-summary'
import { StructuredAgentTelemetry, StructuredLiveTokens } from './StructuredAgentTelemetry'

function item(sequence: number, data: AgentEventData, extra: Partial<TimelineItem> = {}): TimelineItem {
  return { id: String(sequence), runtimeId: 'runtime', sequence, timestamp: '2026-09-07T00:00:00Z', data, ...extra }
}

describe('reported live usage', () => {
  it('selects the latest cumulative session snapshot without adding snapshots or child usage', () => {
    const summary = summarizeUsage([
      item(1, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 100, outputTokens: 40 }),
      item(2, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 200, outputTokens: 50, totalTokens: 250, reasoningTokens: 30 }),
      item(3, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 1000, outputTokens: 800 }, { parentId: 'child-tool' })
    ])
    expect(summary).toMatchObject({ scope: 'session', tokens: { inputTokens: 200, outputTokens: 50, totalTokens: 250, reasoningTokens: 30 } })
    expect(liveTokenLabel(summary)).toBe('50 output tokens')
  })

  it('uses reconciled update order rather than the original timeline position', () => {
    const summary = summarizeUsage([
      item(1, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 200, outputTokens: 80 }, { updatedSequence: 10 }),
      item(3, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 100, outputTokens: 40 })
    ])
    expect(summary.tokens?.totalTokens).toBe(280)
  })

  it('replaces streamed message snapshots with final turn usage and accumulates other turns once', () => {
    const summary = summarizeUsage([
      item(1, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 50, outputTokens: 10 }, { turnId: 'one', nativeItemId: 'm1' }),
      item(2, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 50, outputTokens: 20 }, { turnId: 'one', nativeItemId: 'm1' }),
      item(3, { type: 'usage', source: 'provider', scope: 'turn', inputTokens: 100, outputTokens: 30 }, { turnId: 'one' }),
      item(4, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 70, outputTokens: 4 }, { turnId: 'two', nativeItemId: 'm2' }),
      item(5, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 70, outputTokens: 8 }, { turnId: 'two', nativeItemId: 'm2' })
    ])
    expect(summary).toMatchObject({ scope: 'reported', tokens: { inputTokens: 170, outputTokens: 38, totalTokens: 208 } })
  })

  it('keeps distinct runtime turns separate and does not sum repeated final estimates', () => {
    const summary = summarizeUsage([
      item(1, { type: 'usage', source: 'estimate', scope: 'turn', costUsd: 0.1 }, { turnId: 'same' }),
      item(2, { type: 'usage', source: 'estimate', scope: 'turn', costUsd: 0.2 }, { turnId: 'same' }),
      item(3, { type: 'usage', source: 'estimate', scope: 'turn', costUsd: 0.3 }, { turnId: 'same', runtimeId: 'second-runtime' })
    ])
    expect(summary.costUsd).toBeCloseTo(0.5)
    expect(summary.costEstimated).toBe(true)
    expect(summary.tokens).toBeUndefined()
  })

  it('keeps missing or invalid metrics unknown, while displaying partial output counts honestly', () => {
    const summary = summarizeUsage([item(1, { type: 'usage', source: 'provider', outputTokens: 14, inputTokens: Number.NaN, cachedTokens: -1 })])
    expect(summary.tokens).toEqual({ outputTokens: 14 })
    expect(liveTokenLabel(summary)).toBe('14 output tokens')
    expect(liveTokenLabel(summarizeUsage([]))).toBe('Output tokens pending')
    expect(liveTokenLabel(summarizeUsage([item(1, { type: 'usage', source: 'provider', inputTokens: 0, outputTokens: 0 })]))).toBe('0 output tokens')
  })

  it('does not imply complete totals when a streamed message lacks input usage', () => {
    const summary = summarizeUsage([
      item(1, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 100, outputTokens: 5 }, { turnId: 'one' }),
      item(2, { type: 'usage', source: 'provider', scope: 'message', outputTokens: 8 }, { turnId: 'one' })
    ])
    expect(summary.tokens).toEqual({ outputTokens: 13 })
    expect(liveTokenLabel(summary)).toBe('13 output tokens')
  })

  it('renders the provider token count beside working status and exposes usage before any report', () => {
    const html = renderToStaticMarkup(createElement(StructuredLiveTokens, { items: [item(1, { type: 'usage', source: 'provider', inputTokens: 1000, outputTokens: 50 })] }))
    expect(html).toContain('50 output tokens')
    expect(html).not.toContain('1,050')
    const empty = renderToStaticMarkup(createElement(StructuredAgentTelemetry, { items: [], runtimeId: 'runtime', phase: 'idle' }))
    expect(empty).toContain('View usage')
    expect(empty).toContain('aria-expanded="false"')
    expect(empty).not.toContain('0 subagents')
  })
})

describe('subagent roster', () => {
  it('counts native children once across lifecycle events and retains a useful name', () => {
    const agents = summarizeSubagents([
      item(1, { type: 'subagent', name: 'Research', nativeSessionId: 'child', status: 'running' }),
      item(2, { type: 'subagent', name: 'Codex agent', nativeSessionId: 'child', status: 'completed' }),
      item(3, { type: 'subagent', name: 'Tests', nativeSessionId: 'other-child', status: 'running' })
    ], 'runtime', 'running')
    expect(agents).toHaveLength(2)
    expect(agents[0]).toMatchObject({ name: 'Research', status: 'completed' })
    expect(subagentCountLabel(agents)).toBe('2 subagents · 1 running · 1 completed')
  })

  it('uses latest reconciled status when native lifecycle rows arrive through different item IDs', () => {
    const agents = summarizeSubagents([
      item(1, { type: 'subagent', name: 'Research', nativeSessionId: 'child', status: 'completed' }, { updatedSequence: 9 }),
      item(3, { type: 'subagent', name: 'Research', nativeSessionId: 'child', status: 'running' })
    ], 'runtime', 'running')
    expect(agents[0]?.status).toBe('completed')
  })

  it('does not claim a disconnected or previous-runtime child is still running or completed', () => {
    const facts = [item(1, { type: 'subagent', name: 'Research', status: 'running' }, { nativeItemId: 'task:a' })]
    expect(summarizeSubagents(facts, 'runtime', 'disconnected')[0]?.status).toBe('unknown')
    expect(summarizeSubagents(facts, 'new-runtime', 'running')[0]?.status).toBe('unknown')
  })

  it('shows approvals and failures in the compact control with escaped agent data', () => {
    const items = [
      item(1, { type: 'subagent', name: '<script>oops</script>', status: 'awaiting_approval' }),
      item(2, { type: 'subagent', name: 'Tests', status: 'failed' })
    ]
    const html = renderToStaticMarkup(createElement(StructuredAgentTelemetry, { items, runtimeId: 'runtime', phase: 'waiting_approval' }))
    expect(html).toContain('2 subagents · 1 awaiting approval · 1 failed')
    expect(html).not.toContain('<script>')
  })
})


it('correlates child task, nested tools and response without mixing runtime or sibling output', () => {
  const facts = [
    item(1, { type: 'tool', name: 'Agent', input: { prompt: 'Review permissions' }, status: 'completed' }, { nativeItemId: 'launch' }),
    item(2, { type: 'subagent', name: 'Reviewer', status: 'completed' }, { nativeItemId: 'task:1', parentId: 'launch' }),
    item(3, { type: 'tool', name: 'Read', status: 'completed' }, { parentId: 'launch', nativeItemId: 'read' }),
    item(4, { type: 'text', role: 'assistant', text: 'Reviewed', mode: 'snapshot' }, { parentId: 'read' }),
    item(5, { type: 'text', role: 'assistant', text: 'Other runtime', mode: 'snapshot' }, { runtimeId: 'other', parentId: 'launch' }),
    item(6, { type: 'text', role: 'assistant', text: 'Other child', mode: 'snapshot' }, { parentId: 'other-launch' })
  ]
  const agent = summarizeSubagents(facts, 'runtime', 'running')[0]!
  expect(agent.task).toBe('Review permissions')
  expect(agent.activity.map(value => value.sequence)).toEqual([3, 4])
  const shared = summarizeSubagents([...facts, item(7, { type: 'subagent', name: 'Sibling', status: 'running' }, { parentId: 'launch', nativeItemId: 'task:2' })], 'runtime', 'running')
  expect(shared.every(value => value.activity.length === 0 && !value.task)).toBe(true)
})


describe('context and working output are separate', () => {
  const context = (used: number, capacity = 1000) => item(1, { type: 'usage', source: 'provider', scope: 'session', totalTokens: 9_000_000, outputTokens: 4000, limits: { contextUsedTokens: used, contextCapacityTokens: capacity, workingOutputTokens: 25 } })
  it('uses the current context snapshot, never cumulative usage, and respects thresholds', () => {
    for (const [used, level] of [[400, 'normal'], [699, 'normal'], [700, 'warning'], [899, 'warning'], [900, 'critical'], [1000, 'critical']] as const) {
      expect(summarizeContext([context(used)])).toMatchObject({ level })
      expect(summarizeContext([context(used)])?.percent).toBeCloseTo(used / 10)
      const html = renderToStaticMarkup(createElement(StructuredAgentTelemetry, { items: [context(used)], runtimeId: 'runtime', phase: 'idle' }))
      expect(html).toContain('sa-context-circle level-' + level)
    }
    const hidden = renderToStaticMarkup(createElement(StructuredAgentTelemetry, { items: [context(399)], runtimeId: 'runtime', phase: 'idle' }))
    expect(hidden).not.toContain('sa-context-circle')
    expect(summarizeContext([context(2000)])?.percent).toBe(100)
    expect(liveTokenLabel(summarizeWorkingUsage([context(900)]))).toBe('25 output tokens')
  })
  it('clears stale context on compaction, invalid reports, or a runtime change', () => {
    expect(summarizeContext([context(900), item(2, { type: 'usage', source: 'provider', limits: { contextUsedTokens: null } })])).toBeUndefined()
    expect(summarizeContext([context(900)], 'new-runtime')).toBeUndefined()
    expect(summarizeContext([context(900, 0)])).toBeUndefined()
    expect(summarizeContext([context(Number.NaN)])).toBeUndefined()
    expect(summarizeContext([context(900), item(2, { type: 'usage', source: 'provider', limits: { contextUsedTokens: 150 } })])?.percent).toBe(15)
  })
  it('ignores child context and does not carry working counts into a new prompt', () => {
    const child = { ...context(990), parentId: 'child' }
    expect(summarizeContext([child])).toBeUndefined()
    const prompt = item(2, { type: 'text', role: 'user', text: 'Next', mode: 'snapshot' })
    expect(liveTokenLabel(summarizeWorkingUsage([context(700), prompt]))).toBe('Output tokens pending')
    const response = item(3, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 8000, cachedTokens: 7000, outputTokens: 19 })
    expect(liveTokenLabel(summarizeWorkingUsage([context(700), prompt, response]))).toBe('19 output tokens')
  })
})
