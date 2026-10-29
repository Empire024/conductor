import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEventData } from '../shared/structured-agent'
import { parseRecord, ToolTimingRecorder, toolTimingsQuery } from './tool-timings'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'tool-timings-')); dirs.push(dir); return dir }

function harness(options: { directory?: string; capacity?: number; retentionMs?: number; wall?: number } = {}) {
  const clock = { mono: 1_000, wall: options.wall ?? Date.parse('2026-10-29T10:00:00.000Z') }
  const recorder = new ToolTimingRecorder({ directory: options.directory, capacity: options.capacity, retentionMs: options.retentionMs, flushMs: 60_000, now: () => clock.mono, wallNow: () => clock.wall, mask: text => text.replace(/hunter2/g, '[REDACTED]') })
  let n = 0
  const tool = (itemId: string, status: Extract<AgentEventData, { type: 'tool' }>['status'], extra: Partial<Extract<AgentEventData, { type: 'tool' }>> = {}, at: { sessionId?: string; runtimeId?: string; provider?: string; projectId?: string } = {}) =>
    recorder.observe({ id: `e${++n}`, sessionId: at.sessionId ?? 's1', runtimeId: at.runtimeId ?? 'r1', provider: (at.provider ?? 'claude') as never, projectId: at.projectId ?? 'p1', itemId, timestamp: new Date(clock.wall).toISOString(), data: { type: 'tool', name: 'Bash', status, ...extra } }, 'opus')
  const session = (phase: 'completed' | 'disconnected', at: { sessionId?: string; runtimeId?: string } = {}) =>
    recorder.observe({ id: `e${++n}`, sessionId: at.sessionId ?? 's1', runtimeId: at.runtimeId ?? 'r1', provider: 'claude', projectId: 'p1', timestamp: new Date(clock.wall).toISOString(), data: { type: 'session', phase } })
  const advance = (ms: number) => { clock.mono += ms; clock.wall += ms }
  return { recorder, clock, tool, session, advance, records: () => recorder.report({ recent: 100, includeDetached: true }).recent.slice().reverse() }
}

describe('ToolTimingRecorder', () => {
  it('measures only the phases it saw: elapsed, argument streaming and the running phase', () => {
    const { tool, advance, records } = harness()
    tool('t1', 'preparing', { inputDelta: '{"comm' })
    advance(300)
    tool('t1', 'running', { input: { command: 'npm test -- src/a.test.ts\nsecond line' } })
    advance(1200)
    tool('t1', 'completed', { output: 'ok' })
    const [record] = records()
    expect(record).toMatchObject({ tool: 'Bash', category: 'shell', args: 'npm test -- src/a.test.ts', model: 'opus', elapsedMs: 1500, elapsedSource: 'host-monotonic', prepareMs: 300, execMs: 1200, execSource: 'host-phase', waitMs: null, waitSource: 'unavailable', outcome: 'completed' })
  })

  it('records approval wait only when awaiting_approval was observed, and never derives exec from elapsed', () => {
    const { tool, advance, records } = harness()
    tool('t1', 'running', { input: { command: 'rm -rf build' } })
    advance(50)
    tool('t1', 'awaiting_approval')
    advance(20_000)
    tool('t1', 'running')
    advance(400)
    tool('t1', 'completed', { durationMs: 380 })
    const [record] = records()
    expect(record).toMatchObject({ elapsedMs: 20_450, waitMs: 20_000, waitSource: 'observed-approval', execMs: 380, execSource: 'provider' })
  })

  it('marks elapsed unavailable for a call first seen finished, keeping the provider duration', () => {
    const { tool, records } = harness()
    tool('c1', 'completed', { durationMs: 4, exitCode: 0, input: { command: 'pwsh -c ls' } }, { provider: 'codex' })
    expect(records()[0]).toMatchObject({ startedAt: null, elapsedMs: null, elapsedSource: 'unavailable', execMs: 4, execSource: 'provider', waitMs: null, prepareMs: null })
  })

  it('rejects an impossible provider duration instead of trusting it', () => {
    const { tool, records } = harness()
    tool('a', 'completed', { durationMs: -5 })
    tool('b', 'completed', { durationMs: Number.NaN })
    tool('c', 'completed', { durationMs: 30 * 24 * 3600 * 1000 })
    for (const record of records()) expect(record).toMatchObject({ execMs: null, execSource: 'unavailable', notes: ['invalid-provider-duration'] })
  })

  it('drops restated ends and late progress of a finished call', () => {
    const { recorder, tool, advance, records } = harness()
    tool('t1', 'running')
    advance(10)
    tool('t1', 'completed')
    tool('t1', 'completed')
    tool('t1', 'running')
    expect(records()).toHaveLength(1)
    expect(records()[0]!.restated).toBe(2)
    expect(recorder.report().storage.deduplicated).toBe(2)
  })

  it('keeps calls apart when item ids repeat across conversations and runtimes, and counts overlap', () => {
    const { tool, advance, records } = harness()
    tool('call-1', 'running', {}, { sessionId: 's1', runtimeId: 'r1' })
    tool('call-2', 'running', {}, { sessionId: 's1', runtimeId: 'r1' })
    tool('call-1', 'running', {}, { sessionId: 's2', runtimeId: 'r9' })
    tool('call-1', 'running', {}, { sessionId: 's1', runtimeId: 'r2' })
    advance(5)
    for (const [sessionId, runtimeId] of [['s1', 'r1'], ['s2', 'r9'], ['s1', 'r2']] as const) tool('call-1', 'completed', {}, { sessionId, runtimeId })
    tool('call-2', 'completed', {}, { sessionId: 's1', runtimeId: 'r1' })
    const list = records()
    expect(list).toHaveLength(4)
    expect(list.map(record => record.concurrent)).toEqual([0, 0, 2, 1])
  })

  it('measures with the monotonic clock when the wall clock jumps back', () => {
    const { tool, clock, records } = harness()
    tool('t1', 'running')
    clock.mono += 2000
    clock.wall -= 3_600_000
    tool('t1', 'failed', { output: 'line\nError: hunter2 rejected\n', exitCode: 1 })
    expect(records()[0]).toMatchObject({ elapsedMs: 2000, outcome: 'failed', exitCode: 1, error: 'Error: [REDACTED] rejected' })
  })

  it('abandons unended calls when their runtime ends, keeps detached work, and amends a late end', () => {
    const { tool, session, advance, records } = harness()
    tool('lost', 'running')
    tool('bg', 'running', { detached: true })
    tool('other', 'running', {}, { runtimeId: 'r2' })
    advance(100)
    session('completed')
    expect(records().map(record => [record.itemId, record.outcome, record.elapsedMs])).toEqual([['lost', 'abandoned', null]])
    advance(900)
    tool('lost', 'completed')
    expect(records().map(record => [record.itemId, record.outcome, record.elapsedMs, record.elapsedSource, record.notes])).toEqual([['lost', 'completed', 1000, 'host-monotonic', ['turn-ended-without-tool-end', 'ended-after-abandon']]])
  })

  it('amends an abandoned call of the same runtime even when its end names the tool differently', () => {
    const { tool, session, advance, records } = harness()
    tool('x', 'awaiting_approval', { name: 'Command' })
    session('completed')
    advance(40)
    tool('x', 'completed', { name: 'PowerShell', durationMs: 7 })
    expect(records().map(record => [record.tool, record.outcome, record.elapsedMs, record.execMs])).toEqual([['PowerShell', 'completed', 40, 7]])
  })

  it('survives a restart: open calls persist as abandoned and the next process amends them once', async () => {
    const directory = tempDir()
    const first = harness({ directory })
    first.tool('done', 'running')
    first.advance(10)
    first.tool('done', 'completed')
    first.tool('long', 'running', { input: { command: 'npm run build' } })
    first.recorder.dispose()

    const second = harness({ directory, wall: first.clock.wall + 5000 })
    await second.recorder.load()
    expect(second.records().map(record => [record.itemId, record.outcome])).toEqual([['done', 'completed'], ['long', 'abandoned']])
    // The runtime host kept the provider running; its incarnation (runtime id) is new.
    second.tool('long', 'completed', { durationMs: 4800 }, { runtimeId: 'r-next' })
    second.tool('long', 'completed', {}, { runtimeId: 'r-next' })
    expect(second.records().find(record => record.itemId === 'long')).toMatchObject({ outcome: 'completed', elapsedMs: 5000, elapsedSource: 'wall-clock', execMs: 4800, execSource: 'provider', restated: 1 })
    second.recorder.dispose()

    const third = harness({ directory, wall: first.clock.wall + 6000 })
    await third.recorder.load()
    expect(third.records().map(record => [record.itemId, record.outcome])).toEqual([['done', 'completed'], ['long', 'completed']])
  })

  it('bounds memory and file: capacity, retention, corrupt lines', async () => {
    const directory = tempDir()
    const now = Date.parse('2026-10-29T10:00:00.000Z')
    const old = { v: 1, key: 'old', agentSessionId: 's', projectId: 'p', provider: 'codex', runtimeId: 'r', itemId: 'old', tool: 'Bash', category: 'shell', args: '', startedAt: null, endedAt: new Date(now - 20 * 24 * 3600 * 1000).toISOString(), elapsedMs: null, elapsedSource: 'unavailable', waitMs: null, waitSource: 'unavailable', execMs: null, execSource: 'unavailable', prepareMs: null, outcome: 'completed', concurrent: 0 }
    writeFileSync(join(directory, 'tool-timings.jsonl'), [JSON.stringify(old), '{not json', JSON.stringify({ ...old, v: 2 }), ''].join('\n'))
    const { recorder, tool } = harness({ directory, capacity: 10, retentionMs: 14 * 24 * 3600 * 1000, wall: now })
    await recorder.load()
    expect(recorder.report().storage).toMatchObject({ records: 0, droppedOnLoad: 1, parseErrors: 2 })
    for (let index = 0; index < 40; index++) tool(`t${index}`, 'completed')
    const report = recorder.report({ recent: 100 })
    expect(report.storage.records).toBeLessThanOrEqual(11)
    expect(report.recent[0]!.itemId).toBe('t39')
    await recorder.flush()
    const lines = readFileSync(join(directory, 'tool-timings.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(15)
    expect(lines.every(line => parseRecord(line))).toBe(true)
  })

  it('caps open calls: the oldest becomes abandoned rather than growing without bound', () => {
    const recorder = new ToolTimingRecorder({ maxOpen: 3, now: () => 0 })
    for (let index = 0; index < 5; index++) recorder.observe({ id: `${index}`, sessionId: 's', runtimeId: 'r', provider: 'grok', projectId: 'p', itemId: `t${index}`, timestamp: '', data: { type: 'tool', name: 'Read', status: 'running' } })
    const report = recorder.report({ recent: 10 })
    expect(report.totals.inFlight).toBe(3)
    expect(report.recent.map(record => [record.itemId, record.notes])).toEqual([['t1', ['abandoned', 'open-limit']], ['t0', ['abandoned', 'open-limit']]])
  })

  it('costs little on the event path', () => {
    const recorder = new ToolTimingRecorder({ capacity: 5000 })
    const text = { id: 'x', sessionId: 's', runtimeId: 'r', provider: 'claude' as const, projectId: 'p', timestamp: '', data: { type: 'text' as const, role: 'assistant' as const, text: 'delta', mode: 'delta' as const } }
    let started = performance.now()
    for (let index = 0; index < 200_000; index++) recorder.observe(text)
    const perText = (performance.now() - started) / 200_000 * 1e6
    started = performance.now()
    for (let index = 0; index < 20_000; index++) {
      const base = { id: 'x', sessionId: 's', runtimeId: 'r', provider: 'claude' as const, projectId: 'p', itemId: `t${index}`, timestamp: '' }
      recorder.observe({ ...base, data: { type: 'tool', name: 'Bash', status: 'running', input: { command: `npm test -- ${'x'.repeat(2000)} --token=abc` } } })
      recorder.observe({ ...base, data: { type: 'tool', name: 'Bash', status: 'completed', output: 'ok' } })
    }
    const perCall = (performance.now() - started) / 20_000 * 1e3
    console.log(`tool-timings hot path: ${perText.toFixed(0)} ns per non-tool event, ${perCall.toFixed(1)} µs per tool call (start + end)`)
    expect(recorder.errors).toBe(0)
    expect(perText).toBeLessThan(2_000)
    expect(perCall).toBeLessThan(200)
  })
})

describe('toolTimingsQuery', () => {
  it('accepts bounded filters and rejects the rest', () => {
    expect(toolTimingsQuery({ projectId: ' p ', since: '2026-10-01', limit: 5, recent: 0, includeDetached: true })).toEqual({ projectId: 'p', since: '2026-10-01T00:00:00.000Z', limit: 5, recent: 0, includeDetached: true })
    expect(() => toolTimingsQuery({ limit: 51 })).toThrow(/limit/)
    expect(() => toolTimingsQuery({ recent: 101 })).toThrow(/recent/)
    expect(() => toolTimingsQuery({ since: 'yesterday' })).toThrow(/since/)
    expect(() => toolTimingsQuery({ provider: '' })).toThrow(/provider/)
  })
})
