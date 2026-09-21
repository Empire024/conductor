import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, distribution, parseClaudeLines, parseCodexLines } from './measure-context-churn.mjs'

const at = second => `2026-09-21T16:${String(second).padStart(2, '0')}:00.000Z`
const claudeAssistant = (requestId, usage, options = {}) => ({ type: 'assistant', requestId, uuid: `${requestId}-event`, timestamp: options.timestamp ?? at(20), isSidechain: options.sidechain ?? false, message: { id: `${requestId}-message`, model: 'claude-test', usage } })
const codexCount = (timestamp, total, last = total) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200_000 } } })

test('Claude deduplicates repeated cumulative response records by request and keeps sidechains separate', () => {
  const same = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 5 }
  const session = parseClaudeLines([
    { type: 'user', timestamp: at(10), isSidechain: false, message: { content: 'owner turn' } },
    claudeAssistant('request-1', same),
    claudeAssistant('request-1', same),
    { type: 'user', timestamp: at(21), isSidechain: true, message: { content: 'child turn' } },
    claudeAssistant('request-2', { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 6, output_tokens: 2 }, { sidechain: true, timestamp: at(22) })
  ])
  assert.equal(session.calls.length, 2)
  assert.equal(session.duplicateUsageEvents, 1)
  assert.deepEqual(session.calls.map(call => call.role), ['parent', 'sidechain'])
  assert.equal(session.calls[0].inputTokens, 100)
  assert.equal(session.calls[0].cachedInputTokens, 70)
  assert.equal(session.calls[0].uncachedInputTokens, 30)
  assert.equal(session.userTurns.length, 2)
})

test('Claude preserves calls on both sides of a compaction boundary', () => {
  const session = parseClaudeLines([
    claudeAssistant('before', { input_tokens: 2, cache_creation_input_tokens: 8, cache_read_input_tokens: 90, output_tokens: 1 }, { timestamp: at(20) }),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(21) },
    claudeAssistant('after', { input_tokens: 3, cache_creation_input_tokens: 17, cache_read_input_tokens: 10, output_tokens: 2 }, { timestamp: at(22) })
  ])
  assert.equal(session.compactions, 1)
  assert.deepEqual(session.calls.map(call => call.segment), [0, 1])
})

test('Codex turns cumulative snapshots into calls, ignores duplicates, and handles reset after compaction', () => {
  const first = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 }
  const second = { input_tokens: 250, cached_input_tokens: 200, output_tokens: 30, total_tokens: 280 }
  const reset = { input_tokens: 40, cached_input_tokens: 10, output_tokens: 5, total_tokens: 45 }
  const session = parseCodexLines([
    { type: 'session_meta', timestamp: at(10), payload: { source: 'vscode' } },
    codexCount(at(20), first), codexCount(at(20), first), codexCount(at(21), second),
    { type: 'event_msg', timestamp: at(22), payload: { type: 'context_compacted' } },
    codexCount(at(23), reset)
  ], { id: 'parent' })
  assert.equal(session.calls.length, 3)
  assert.equal(session.duplicateUsageEvents, 1)
  assert.equal(session.compactions, 1)
  assert.deepEqual(session.calls.map(call => [call.inputTokens, call.cachedInputTokens, call.uncachedInputTokens, call.segment]), [[100, 80, 20, 0], [150, 120, 30, 0], [40, 10, 30, 1]])
})

test('Codex identifies guardian sessions as child usage', () => {
  const session = parseCodexLines([
    { type: 'session_meta', timestamp: at(10), payload: { parent_thread_id: 'parent', source: { subagent: { other: 'guardian' } } } },
    codexCount(at(20), { input_tokens: 50, cached_input_tokens: 40, output_tokens: 4, total_tokens: 54 })
  ], { id: 'guardian' })
  assert.equal(session.role, 'guardian')
  assert.equal(session.parentId, 'parent')
  assert.equal(session.calls[0].role, 'guardian')
})

test('report separates calls from turns, periods, and parent from all child work', () => {
  const parent = parseClaudeLines([
    { type: 'user', timestamp: at(20), message: { content: 'one turn' } },
    claudeAssistant('before', { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90, output_tokens: 1 }, { timestamp: at(20) }),
    claudeAssistant('after', { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 80, output_tokens: 1 }, { timestamp: at(40) })
  ])
  const guardian = parseCodexLines([{ type: 'session_meta', payload: { parent_thread_id: 'p', source: { subagent: { other: 'guardian' } } } }, codexCount(at(40), { input_tokens: 50, cached_input_tokens: 25, output_tokens: 5, total_tokens: 55 })])
  const report = buildReport([parent, guardian], { since: Date.parse(at(0)), changeAt: at(30), generatedAt: at(59) })
  assert.equal(report.ingestion.userTurns, 1)
  assert.equal(report.ingestion.apiCalls, 3)
  assert.equal(report.byPeriod.beforeV0136.apiCalls, 1)
  assert.equal(report.byPeriod.afterV0136.apiCalls, 2)
  assert.equal(report.byRole.parent.apiCalls, 2)
  assert.equal(report.byRole.guardian.apiCalls, 1)
  assert.equal(report.byRole.child.apiCalls, 1)
})

test('distribution reports interpolated percentiles as well as the mean', () => {
  assert.deepEqual(distribution([1, 2, 3, 100]), { n: 4, min: 1, p25: 2, p50: 3, p75: 27, p90: 71, p95: 85, max: 100, mean: 27 })
})
