import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEventData } from '../shared/structured-agent'
import { parseRecord, ToolTimingRecorder, toolTimingsQuery } from './tool-timings'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'tool-timings-')); dirs.push(dir); return dir }

function harness(options: { directory?: string; capacity?: number; retentionMs?: number; wall?: number; maxReadBytes?: number } = {}) {
  const clock = { mono: 1_000, wall: options.wall ?? Date.parse('2026-10-29T10:00:00.000Z') }
  const recorder = new ToolTimingRecorder({ directory: options.directory, capacity: options.capacity, retentionMs: options.retentionMs, maxReadBytes: options.maxReadBytes, flushMs: 60_000, now: () => clock.mono, wallNow: () => clock.wall, mask: text => text.replace(/hunter2/g, '[REDACTED]') })
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

  it('times an abandoned call that ends later in this process on the provider clock, and keeps review apart', () => {
    const { tool, session, advance, records } = harness()
    tool('p', 'running', { name: 'Command', providerStartedAtMs: 1_000 }, { provider: 'codex' })
    session('completed')
    advance(50)
    tool('p', 'completed', { name: 'Command', providerCompletedAtMs: 7_000, providerReviewMs: 250 }, { provider: 'codex' })
    expect(records()[0]).toMatchObject({ outcome: 'completed', elapsedMs: 6_000, elapsedSource: 'provider', reviewMs: 250, reviewSource: 'provider-review', waitMs: null, notes: ['turn-ended-without-tool-end', 'ended-after-abandon'] })
  })

  it('rejects an invalid provider review and never folds review into wait', () => {
    const { tool, advance, records } = harness()
    tool('r', 'awaiting_approval', { name: 'Command' }, { provider: 'codex' })
    advance(400)
    tool('r', 'running', { name: 'Command' }, { provider: 'codex' })
    tool('r', 'completed', { name: 'Command', providerReviewMs: -3 }, { provider: 'codex' })
    const [record] = records()
    expect(record).toMatchObject({ waitMs: 400, waitSource: 'observed-approval', notes: ['invalid-provider-review'] })
    expect(record!.reviewMs).toBeUndefined()
  })

  it('persists provider elapsed and review across a restart, and refuses a malformed review on load', async () => {
    const directory = tempDir()
    const first = harness({ directory })
    first.tool('c', 'running', { name: 'Command', providerStartedAtMs: 100 }, { provider: 'codex' })
    first.tool('c', 'completed', { name: 'Command', providerCompletedAtMs: 900, providerReviewMs: 40 }, { provider: 'codex' })
    first.recorder.dispose()
    const second = harness({ directory, wall: first.clock.wall + 1000 })
    await second.recorder.load()
    expect(second.records()).toEqual([expect.objectContaining({ itemId: 'c', elapsedMs: 800, elapsedSource: 'provider', reviewMs: 40, reviewSource: 'provider-review' })])
    second.recorder.dispose()
    const line = JSON.stringify({ v: 1, ...second.records()[0] })
    expect(parseRecord(line)).toMatchObject({ reviewMs: 40 })
    expect(parseRecord(line.replace('"reviewMs":40', '"reviewMs":-1'))).toBeNull()
    expect(parseRecord(line.replace('"reviewSource":"provider-review"', '"reviewSource":"observed-approval"'))).toBeNull()
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

  describe('loading a damaged or oversized file', () => {
    const now = Date.parse('2026-10-29T10:00:00.000Z')
    const line = (key: string, args = '', endedAt = new Date(now - 60_000).toISOString()): string => JSON.stringify({ v: 1, key, agentSessionId: 's', projectId: 'p', provider: 'codex', runtimeId: 'r', itemId: key, tool: 'Bash', category: 'shell', args, startedAt: null, endedAt, elapsedMs: null, elapsedSource: 'unavailable', waitMs: null, waitSource: 'unavailable', execMs: 4, execSource: 'provider', prepareMs: null, outcome: 'completed', concurrent: 0 })
    const fileOf = (directory: string): string => join(directory, 'tool-timings.jsonl')
    const lines = (directory: string): string[] => readFileSync(fileOf(directory), 'utf8').split('\n').filter(Boolean)

    it('reads only the newest 16 MiB of a 20 MiB file, keeps its recent records and rewrites it under the bound', async () => {
      const directory = tempDir()
      // 4 MiB of garbage a whole-file read would pull in, then just over 16 MiB of valid records,
      // so the newest 16 MiB hold valid records only (after the partial first line).
      const garbage = ('x'.repeat(1023) + '\n').repeat(4 * 1024)
      const lineBytes = Buffer.byteLength(line('k00000', 'a'.repeat(700))) + 1
      const count = Math.ceil(16.5 * 1024 * 1024 / lineBytes)
      const valid = Array.from({ length: count }, (_, index) => line(`k${String(index).padStart(5, '0')}`, 'a'.repeat(700))).join('\n') + '\n'
      writeFileSync(fileOf(directory), garbage + valid)
      expect(Buffer.byteLength(garbage + valid)).toBeGreaterThan(20 * 1024 * 1024)
      const last = (offset: number): string => `k${String(count - 1 - offset).padStart(5, '0')}`
      const { recorder } = harness({ directory, capacity: 5000, wall: now })
      await recorder.load()
      expect(recorder.loadedBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
      expect(recorder.loadedBytes).toBe(16 * 1024 * 1024)
      const report = recorder.report({ recent: 3 })
      expect(report.recent.map(record => record.key)).toEqual([last(0), last(1), last(2)])
      expect(report.storage).toMatchObject({ records: 5000, parseErrors: 0 })
      await recorder.flush()
      const kept = lines(directory)
      expect(kept).toHaveLength(5000)
      expect(kept.every(text => parseRecord(text))).toBe(true)
      expect(kept.at(-1)).toContain(`"${last(0)}"`)
    })

    it('drops a UTF-8 character split at the tail boundary with its partial line', async () => {
      const directory = tempDir()
      const first = line('first', 'café ✓ ünïcode'), second = line('second', 'naïve → ok'), third = line('third', 'emoji 😀 end')
      const content = [first, second, third].join('\n') + '\n'
      writeFileSync(fileOf(directory), content)
      // Start reading on the second byte of the first line's 2-byte “é”.
      const start = Buffer.from(content).indexOf(Buffer.from('é')) + 1
      const { recorder } = harness({ directory, wall: now, maxReadBytes: Buffer.byteLength(content) - start })
      await recorder.load()
      expect(recorder.loadedBytes).toBe(Buffer.byteLength(content) - start)
      const report = recorder.report({ recent: 10 })
      expect(report.recent.map(record => [record.key, record.args])).toEqual([['third', 'emoji 😀 end'], ['second', 'naïve → ok']])
      expect(report.storage.parseErrors).toBe(0)
      await recorder.flush()
      expect(lines(directory).map(text => parseRecord(text)?.key)).toEqual(['second', 'third'])
    })

    it('heals a line torn by a crash before an append can land on it, counting it as one parse error', async () => {
      const directory = tempDir()
      writeFileSync(fileOf(directory), line('kept') + '\n' + line('torn').slice(0, 40))
      const { recorder, tool } = harness({ directory, wall: now })
      const loading = recorder.load()
      // Observed and flushed while the load is still pending: the append must queue behind it.
      tool('fresh', 'completed', { durationMs: 3 })
      const flushed = recorder.flush()
      await loading
      // Healed inside the load step, before the queued append: whole lines only, and the fresh
      // record left to that append rather than written twice.
      const healed = readFileSync(fileOf(directory), 'utf8')
      expect(healed.endsWith('\n')).toBe(true)
      expect(healed.split('\n').filter(Boolean).map(text => parseRecord(text)?.key)).toEqual(['kept'])
      await flushed
      await recorder.flush()
      const keys = lines(directory).map(text => parseRecord(text)?.key)
      expect(keys).toEqual([expect.stringContaining('kept'), expect.stringContaining('fresh')])
      expect(recorder.report().storage.parseErrors).toBe(1)
      expect(recorder.errors).toBe(0)
    })

    it('survives a file that is one unterminated line larger than the read bound', async () => {
      const directory = tempDir()
      writeFileSync(fileOf(directory), 'y'.repeat(4096))
      const { recorder } = harness({ directory, wall: now, maxReadBytes: 1024 })
      await recorder.load()
      expect(recorder.loadedBytes).toBe(1024)
      expect(recorder.report().storage).toMatchObject({ records: 0, parseErrors: 0 })
      await recorder.flush()
      expect(readFileSync(fileOf(directory), 'utf8')).toBe('')
    })
  })

  it('persists and reports no secret from arguments or failure output (synthetic dummies)', async () => {
    const directory = tempDir()
    const { recorder, tool } = harness({ directory })
    tool('q', 'completed', { input: { command: 'curl "https://example.test/a?token=dummyZq1&x=1" -H "Cookie: sessionid=dummyZq2"' } })
    tool('j', 'completed', { input: { url: 'https://example.test/cb?code=dummyZq3' } })
    tool('f', 'failed', { input: { command: 'deploy' }, output: 'step 1\nError: rejected {"client_secret": "dummyZq4"} at https://u:dummyZq5@example.test\n' })
    await recorder.flush()
    const persisted = readFileSync(join(directory, 'tool-timings.jsonl'), 'utf8')
    const reported = JSON.stringify(recorder.report({ recent: 10 }))
    for (const secret of ['dummyZq1', 'dummyZq2', 'dummyZq3', 'dummyZq4', 'dummyZq5']) {
      expect(persisted).not.toContain(secret)
      expect(reported).not.toContain(secret)
    }
    expect(persisted).toContain('curl \\"https://example.test/a?token=[REDACTED]&x=1\\"')
  })

  describe('quitting while a write is in flight', () => {
    const gate = () => {
      let release!: () => void, started!: () => void
      const opened = new Promise<void>(resolve => { release = resolve })
      const reached = new Promise<void>(resolve => { started = resolve })
      return { release, reached, hold: async () => { started(); await opened } }
    }
    const keysOf = (report: { recent: Array<{ itemId: string; outcome: string }> }) => report.recent.map(record => `${record.itemId}:${record.outcome}`).sort()

    it('keeps every record exactly once when the quit lands while a compaction rename is held', async () => {
      const directory = tempDir()
      const held = gate()
      const recorder = new ToolTimingRecorder({ directory, capacity: 4, flushMs: 60_000, now: () => 0, io: { rename: (async (from: string, to: string) => { await held.hold(); return rename(from, to) }) as typeof rename } })
      const tool = (itemId: string, status: 'running' | 'completed') => recorder.observe({ id: itemId, sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p', itemId, timestamp: '', data: { type: 'tool', name: 'Bash', status } })
      for (let index = 0; index < 7; index++) tool(`c${index}`, 'completed')
      // Seven lines into a file bounded at 4 × 1.5: the append is followed by a compaction.
      const writing = recorder.flush()
      await held.reached
      tool('c7', 'completed'); tool('c8', 'completed'); tool('live', 'running')
      recorder.dispose()
      held.release()
      await writing

      const next = new ToolTimingRecorder({ directory, capacity: 100 })
      await next.load()
      expect(keysOf(next.report({ recent: 100 }))).toEqual(['c3:completed', 'c4:completed', 'c5:completed', 'c6:completed', 'c7:completed', 'c8:completed', 'live:abandoned'])
      expect(existsSync(join(directory, 'tool-timings.exit.jsonl'))).toBe(false)
      const durable = readFileSync(join(directory, 'tool-timings.jsonl'), 'utf8').split('\n').filter(Boolean).map(text => parseRecord(text)!.itemId)
      expect(durable.sort()).toEqual(['c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'live'])
    })

    const row = (itemId: string): string => JSON.stringify({ v: 1, key: `s\u0000r\u0000${itemId}`, agentSessionId: 's', projectId: 'p', provider: 'codex', runtimeId: 'r', itemId, tool: 'Bash', category: 'shell', args: '', startedAt: null, endedAt: new Date().toISOString(), elapsedMs: null, elapsedSource: 'unavailable', waitMs: null, waitSource: 'unavailable', execMs: 4, execSource: 'provider', prepareMs: null, outcome: 'completed', concurrent: 0 }) + '\n'
    const exitFiles = (directory: string): string[] => readdirSync(directory).filter(name => name.includes('.exit.')).sort()

    it('keeps an earlier quit\'s rows and a new quit\'s rows when the new quit lands while the load\'s rewrite is held', async () => {
      const directory = tempDir(), main = join(directory, 'tool-timings.jsonl')
      writeFileSync(main, row('m'))
      writeFileSync(join(directory, 'tool-timings.exit.jsonl'), row('old'))
      const held = gate()
      const recorder = new ToolTimingRecorder({ directory, flushMs: 60_000, now: () => 0, io: { rename: (async (from: string, to: string) => { if (to === main) await held.hold(); return rename(from, to) }) as typeof rename } })
      const tool = (itemId: string, status: 'running' | 'completed') => recorder.observe({ id: itemId, sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p', itemId, timestamp: '', data: { type: 'tool', name: 'Bash', status } })
      const loading = recorder.load()
      await held.reached
      tool('n', 'completed'); tool('live', 'running')
      recorder.dispose()
      held.release()
      await loading

      const next = new ToolTimingRecorder({ directory })
      await next.load()
      expect(keysOf(next.report({ recent: 100 }))).toEqual(['live:abandoned', 'm:completed', 'n:completed', 'old:completed'])
      expect(exitFiles(directory)).toEqual([])
      const durable = readFileSync(main, 'utf8').split('\n').filter(Boolean).map(text => parseRecord(text)!.itemId)
      expect(durable.sort()).toEqual(['live', 'm', 'n', 'old'])
    })

    it('deletes no exit rows when a quit lands while the load is still reading them, and the next load keeps old and new once', async () => {
      const directory = tempDir()
      writeFileSync(join(directory, 'tool-timings.jsonl'), row('m'))
      writeFileSync(join(directory, 'tool-timings.exit.jsonl'), row('old'))
      const held = gate()
      const recorder = new ToolTimingRecorder({ directory, flushMs: 60_000, now: () => 0, io: { open: (async (...args: Parameters<typeof open>) => { if (String(args[0]).includes('.exit.')) await held.hold(); return open(...args) }) as typeof open } })
      const loading = recorder.load()
      await held.reached
      recorder.observe({ id: 'n2', sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p', itemId: 'n2', timestamp: '', data: { type: 'tool', name: 'Bash', status: 'running' } })
      recorder.dispose()
      held.release()
      await loading
      // The skipped rewrite deleted nothing: the claimed earlier file and the new quit's file remain.
      expect(exitFiles(directory)).toEqual([expect.stringMatching(/^tool-timings\.exit\.\d{13}-\d+-[0-9a-z]+\.claimed\.jsonl$/), 'tool-timings.exit.jsonl'])

      const next = new ToolTimingRecorder({ directory })
      await next.load()
      expect(keysOf(next.report({ recent: 100 }))).toEqual(['m:completed', 'n2:abandoned', 'old:completed'])
      expect(exitFiles(directory)).toEqual([])
    })

    it('keeps every record exactly once when the quit lands while an append is held, and skips steps not yet started', async () => {
      const directory = tempDir()
      const held = gate()
      let appends = 0
      const recorder = new ToolTimingRecorder({ directory, flushMs: 60_000, now: () => 0, io: { appendFile: (async (...args: Parameters<typeof appendFile>) => { appends++; await held.hold(); return appendFile(...args) }) as typeof appendFile } })
      const tool = (itemId: string, status: 'running' | 'completed') => recorder.observe({ id: itemId, sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p', itemId, timestamp: '', data: { type: 'tool', name: 'Bash', status } })
      tool('a0', 'completed'); tool('a1', 'completed')
      const first = recorder.flush()
      await held.reached
      tool('a2', 'completed')
      const second = recorder.flush()
      tool('open', 'running')
      recorder.dispose()
      held.release()
      await first; await second
      expect(appends).toBe(1)

      const next = new ToolTimingRecorder({ directory })
      await next.load()
      expect(keysOf(next.report({ recent: 100 }))).toEqual(['a0:completed', 'a1:completed', 'a2:completed', 'open:abandoned'])
      expect(readFileSync(join(directory, 'tool-timings.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
      expect(existsSync(join(directory, 'tool-timings.exit.jsonl'))).toBe(false)
    })
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
