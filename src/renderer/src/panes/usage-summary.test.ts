import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { distinguishSubagentLabels, isGenericSubagentName, liveTokenLabel, providerOfCommand, subagentColorBuckets, subagentColorIndex, subagentCountLabel, subagentIdentityId, subagentModelLabel, subagentTokenLabel, summarizeSubagents, summarizeUsage, summarizeContext, summarizeWorkingUsage } from './usage-summary'
import { StructuredAgentTelemetry, StructuredLiveTokens, StructuredUsageSummary } from './StructuredAgentTelemetry'

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
    expect(liveTokenLabel(summarizeUsage([]))).toBeUndefined()
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
    const pending = renderToStaticMarkup(createElement(StructuredLiveTokens, { items: [] }))
    expect(pending).toContain('role="status"')
    expect(pending).toContain('aria-label="Output tokens pending"')
    expect(pending).not.toContain('Output tokens pending<')
    const usage = renderToStaticMarkup(createElement(StructuredUsageSummary, { items: [], runtimeId: 'runtime' }))
    expect(usage).toContain('View usage')
    expect(usage).toContain('aria-expanded="false"')
    const empty = renderToStaticMarkup(createElement(StructuredAgentTelemetry, { items: [], runtimeId: 'runtime', phase: 'idle' }))
    expect(empty).not.toContain('subagent')
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
      const html = renderToStaticMarkup(createElement(StructuredUsageSummary, { items: [context(used)], runtimeId: 'runtime' }))
      expect(html).toContain('sa-context-circle level-' + level)
    }
    const hidden = renderToStaticMarkup(createElement(StructuredUsageSummary, { items: [context(399)], runtimeId: 'runtime' }))
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
    expect(liveTokenLabel(summarizeWorkingUsage([context(700), prompt]))).toBeUndefined()
    const response = item(3, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 8000, cachedTokens: 7000, outputTokens: 19 })
    expect(liveTokenLabel(summarizeWorkingUsage([context(700), prompt, response]))).toBe('19 output tokens')
  })
})

describe('detached background tasks', () => {
  const task = (status: 'running' | 'completed' = 'running'): TimelineItem =>
    item(1, { type: 'subagent', name: 'Run Codex on the steering implementation', status, detached: true }, { nativeItemId: 'task:a' })

  it('keeps reporting a background task that outlives the turn that started it', () => {
    expect(summarizeSubagents([task()], 'runtime', 'completed')[0]?.status).toBe('running')
    expect(summarizeSubagents([task()], 'runtime', 'idle')[0]?.status).toBe('running')
  })

  it('still refuses to vouch for a background task from a different runtime', () => {
    expect(summarizeSubagents([task()], 'new-runtime', 'running')[0]?.status).toBe('unknown')
  })

  it('leaves ordinary subagents downgraded once their turn ends', () => {
    const child = item(1, { type: 'subagent', name: 'Research', status: 'running' }, { nativeItemId: 'task:a' })
    expect(summarizeSubagents([child], 'runtime', 'completed')[0]?.status).toBe('unknown')
  })

  it('filters a legacy background Bash record from the subagent roster without dropping its tool row', () => {
    const shell = item(1, { type: 'tool', name: 'Bash', status: 'running', input: { command: 'codex exec --approve-for-me steer' } }, { nativeItemId: 'launch' })
    const agents = summarizeSubagents([
      shell,
      item(2, { type: 'subagent', name: 'Run Codex', status: 'running', detached: true }, { parentId: 'launch', nativeItemId: 'task:a' })
    ], 'runtime', 'running')
    expect(agents).toEqual([])
    expect(shell.data.type).toBe('tool')
  })

  it('matches the executable rather than a passing mention of a runtime', () => {
    expect(providerOfCommand('codex exec --json')).toBe('codex')
    expect(providerOfCommand('C:/tools/claude.exe --print')).toBe('claude')
    expect(providerOfCommand('echo "ask codexional about it"')).toBeUndefined()
    expect(providerOfCommand('npm run build')).toBeUndefined()
  })
})

describe('subagent identity and color for nested "Within X" labels', () => {
  it('prefers the native session id, falling back to runtime and native item, matching what the roster counts by', () => {
    const withNative = item(1, { type: 'subagent', name: 'Reviewer', nativeSessionId: 'native-1', status: 'running' })
    expect(withNative.data.type === 'subagent' && subagentIdentityId(withNative.data, withNative.runtimeId, withNative.nativeItemId, withNative.id)).toBe('native-1')
    const withoutNative = item(2, { type: 'subagent', name: 'Reviewer', status: 'running' }, { nativeItemId: 'task:9' })
    expect(withoutNative.data.type === 'subagent' && subagentIdentityId(withoutNative.data, withoutNative.runtimeId, withoutNative.nativeItemId, withoutNative.id)).toBe(JSON.stringify(['runtime', 'task:9']))
    const roster = summarizeSubagents([withNative], 'runtime', 'running')
    expect(roster[0]?.id).toBe('native-1')
  })

  it('derives a color bucket deterministically from identity so the same agent repaints the same color', () => {
    const first = subagentColorIndex('native-1')
    expect(subagentColorIndex('native-1')).toBe(first)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(subagentColorBuckets)
    expect(subagentColorIndex('native-2')).not.toBe(subagentColorIndex('native-2-different-enough'))
  })

  it('numbers same-named subagents in roster order but leaves a unique name untouched', () => {
    const labels = distinguishSubagentLabels([{ id: 'a', name: 'Codex agent' }, { id: 'b', name: 'Codex agent' }, { id: 'c', name: 'Reviewer' }])
    expect(labels.get('a')).toBe('Codex agent #1')
    expect(labels.get('b')).toBe('Codex agent #2')
    expect(labels.get('c')).toBe('Reviewer')
  })

  it('recognizes the generic native names the roster collapses across lifecycle events', () => {
    expect(isGenericSubagentName('Codex agent')).toBe(true)
    expect(isGenericSubagentName('Background activity')).toBe(true)
    expect(isGenericSubagentName('Reviewer')).toBe(false)
  })
})

describe('subagent model, effort and token reporting', () => {
  it('carries the model, effort and model provider a spawned agent thread reports, merging later confirmation', () => {
    const spawned = item(1, { type: 'subagent', name: 'Codex agent', nativeSessionId: 'child-1', status: 'running', model: 'gpt-5-high', effort: 'high' })
    const confirmed = item(2, { type: 'subagent', name: 'Researcher', nativeSessionId: 'child-1', status: 'running', modelProvider: 'openai' })
    const agent = summarizeSubagents([spawned, confirmed], 'runtime', 'running')[0]
    expect(agent).toMatchObject({ name: 'Researcher', model: 'gpt-5-high', effort: 'high', modelProvider: 'openai' })
  })

  it('leaves model, effort and provider unset for a subagent that never reported them', () => {
    const task = item(1, { type: 'subagent', name: 'Run checks', status: 'running', detached: true }, { nativeItemId: 'task:a' })
    const agent = summarizeSubagents([task], 'runtime', 'running')[0]
    expect(agent?.model).toBeUndefined()
    expect(agent?.modelProvider).toBeUndefined()
    expect(agent?.tokens).toBeUndefined()
  })

  it('attributes token usage reported for a spawned child thread to that subagent only', () => {
    const launch = item(1, { type: 'subagent', name: 'Researcher', status: 'running' }, { nativeItemId: 'thread:child-1' })
    const usage = item(2, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, { parentId: 'thread:child-1' })
    const agent = summarizeSubagents([launch, usage], 'runtime', 'running')[0]
    expect(agent?.tokens).toMatchObject({ totalTokens: 1000 })
    expect(subagentTokenLabel(agent!)).toBe('1,000 tokens')
  })

  it('formats a subagent model label using the same display convention as the composer, or nothing when unreported', () => {
    expect(subagentModelLabel({ model: 'gpt-5-high', effort: 'high' })).toBe('GPT 5 High · high')
    expect(subagentModelLabel({ model: undefined, effort: 'high' })).toBeUndefined()
  })
})
