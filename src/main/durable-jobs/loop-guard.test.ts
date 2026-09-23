import { describe, expect, it } from 'vitest'
import { LoopGuard, failureSignature, nearCallKey } from './loop-guard.ts'

const KEY = 'fedcba9876543210fedcba9876543210fedcba98765432'
function guard(options = {}) {
  const state = { clock: 0 }
  return { state, guard: new LoopGuard('stage-2', () => state.clock, options) }
}

describe('loop guard', () => {
  it('treats trivial argument diffs on the same target as near-identical', () => {
    expect(nearCallKey('run_command', { command: 'npm  test -- --run', timeout: 60 })).toBe(nearCallKey('run_command', { command: 'npm test -- --run', timeout: 120 }))
    expect(nearCallKey('read_file', { path: 'src/a.ts', offset: 1 })).toBe(nearCallKey('read_file', { path: 'src/a.ts', offset: 200 }))
    expect(nearCallKey('read_file', { path: 'src/a.ts' })).not.toBe(nearCallKey('read_file', { path: 'src/b.ts' }))
    expect(failureSignature('FAIL src/a.test.ts:12:5 AssertionError expected 1 (34ms)')).toBe(failureSignature('FAIL src/a.test.ts:40:9 AssertionError expected 1 (51ms)'))
  })

  it('replans on identical repeated calls, then blocks with evidence on the next loop', () => {
    const { guard: g } = guard()
    const call = { name: 'run_command', arguments: { command: 'npm test' }, output: 'Tests: 3 passed', failed: false }
    const verdicts = Array.from({ length: 6 }, () => g.observeToolCall(call))
    expect(verdicts.find(v => v.action === 'warn')).toBeTruthy()
    const replan = verdicts.find(v => v.action === 'replan')
    expect(replan).toMatchObject({ action: 'replan', event: { kind: 'loop-detected' } })
    if (replan?.action === 'replan') expect(replan.instruction).toMatch(/materially different approach/)
    const again = Array.from({ length: 6 }, () => g.observeToolCall(call)).find(v => v.action === 'block')
    expect(again).toMatchObject({ action: 'block', event: { kind: 'loop-detected' } })
    expect(g.snapshot().replans).toBe(1)
  })

  it('detects near-identical calls that learn nothing new', () => {
    const { guard: g } = guard()
    const outputs = ['no matches', 'no matches', 'no matches', 'no matches']
    const verdicts = outputs.map((output, i) => g.observeToolCall({ name: 'search', arguments: { pattern: 'parseInvoice', maxResults: 10 + i }, output, failed: false }))
    expect(verdicts.at(-1)).toMatchObject({ action: 'replan', evidence: { pattern: 'near-identical-calls', tool: 'search' } })
  })

  it('does not count reading new windows of a file as a loop', () => {
    const { guard: g } = guard()
    const verdicts = Array.from({ length: 8 }, (_, i) => g.observeToolCall({ name: 'read_file', arguments: { path: 'src/big.ts', offset: i * 200 }, output: `line ${i} const value${i} = compute${i}()`, failed: false }))
    expect(verdicts.every(v => v.action === 'continue')).toBe(true)
  })

  it('detects the same failed approach three times even with other calls in between', () => {
    const { guard: g } = guard()
    const fail = (ms: number) => g.observeToolCall({ name: 'run_command', arguments: { command: 'npx vitest run src/parser.test.ts' }, output: `FAIL src/parser.test.ts:${ms}:3 TypeError: cannot read 'amount' (${ms}ms)`, failed: true })
    expect(fail(12).action).toBe('continue')
    g.observeToolCall({ name: 'edit_file', arguments: { path: 'src/parser.ts', old: 'a', new: 'b' }, output: 'edited (1 replacement)', failed: false })
    expect(fail(40).action).toBe('continue')
    g.observeToolCall({ name: 'edit_file', arguments: { path: 'src/parser.ts', old: 'b', new: 'c' }, output: 'edited (1 replacement)', failed: false })
    expect(fail(77)).toMatchObject({ action: 'replan', evidence: { pattern: 'failed-approach', count: 3 } })
  })

  it('counts repeated chat as no progress and a real progress signal as progress', () => {
    const { guard: g } = guard({ idleRoundsLimit: 5 })
    for (let i = 0; i < 4; i++) expect(g.observeChatRound().action).toBe('continue')
    g.observeProgress({ kind: 'tokens', count: 400 })
    expect(g.observeChatRound()).toMatchObject({ action: 'replan', evidence: { pattern: 'no-progress-rounds' } })
    for (let i = 0; i < 3; i++) g.observeChatRound()
    g.observeProgress({ kind: 'decision', summary: 'use the Fio parser' })
    for (let i = 0; i < 4; i++) expect(g.observeChatRound().action).toBe('continue')
    expect(g.observeChatRound().action).toBe('block')
  })

  it('blocks a stage that spends time without observable progress after one replan', () => {
    const { guard: g, state } = guard({ idleStageMs: 30 * 60_000 })
    state.clock += 20 * 60_000
    expect(g.checkStage().action).toBe('continue')
    state.clock += 11 * 60_000
    expect(g.checkStage()).toMatchObject({ action: 'replan', evidence: { pattern: 'no-progress-time' } })
    state.clock += 10 * 60_000
    g.observeProgress({ kind: 'file-diff', path: 'src/a.ts' })
    state.clock += 29 * 60_000
    expect(g.checkStage().action).toBe('continue')
    state.clock += 2 * 60_000
    expect(g.checkStage().action).toBe('block')
  })

  it('keeps the replan count across a restart of the same stage', () => {
    const { guard: g, state } = guard({ idleStageMs: 60_000 })
    state.clock += 61_000
    expect(g.checkStage().action).toBe('replan')
    const restored = new LoopGuard('stage-2', () => state.clock, { idleStageMs: 60_000 }, g.snapshot())
    state.clock += 61_000
    expect(restored.checkStage().action).toBe('block')
    expect(new LoopGuard('stage-3', () => state.clock, {}, g.snapshot()).snapshot().replans).toBe(0)
  })

  it('never puts credentials from tool output into loop evidence', () => {
    const { guard: g } = guard()
    const call = { name: 'run_command', arguments: { command: `curl -H "Authorization: Bearer ${KEY}" http://127.0.0.1:8081/v1/models` }, output: `401 invalid api key ${KEY}`, failed: true }
    const verdicts = [g.observeToolCall(call), g.observeToolCall(call), g.observeToolCall(call)]
    const loop = verdicts.at(-1)!
    expect(loop.action).toBe('replan')
    expect(JSON.stringify(loop)).not.toContain(KEY)
  })
})

describe('loop guard on long reads', () => {
  it('does not call reading new ranges of a large file a loop, but still stops re-reading the same range', () => {
    const g = new LoopGuard('stage-reads', () => 0, { idleRoundsLimit: 5 })
    for (let i = 0; i < 20; i++) expect(g.observeToolCall({ name: 'read_file', arguments: { path: 'modules/alpha.js', offset: i * 300, limit: 300 }, output: `lines ${i * 300}-${i * 300 + 299}: export function alphaTransform${i}() {}`, failed: false }).action).toBe('continue')
    const verdicts = Array.from({ length: 8 }, () => g.observeToolCall({ name: 'read_file', arguments: { path: 'modules/alpha.js', offset: 0, limit: 300 }, output: 'lines 0-299: the same text', failed: false }).action)
    expect(verdicts).toContain('replan')
  })
})
