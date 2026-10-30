import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { maskSecrets } from '../structured-store'
import { ToolTimingRecorder } from '../tool-timings'
import { parseTranscript } from './runs'

/**
 * Cloud-coworker tool timings (docs/perf-evidence/t3code-cloud-transcript-timings.md): the real
 * parser over teleported transcript rows shaped like Claude Code 2.1.312 writes them, into the
 * recorder, out through its report. The host clock never takes part: wall and monotonic are pinned
 * far from the rows' own times.
 */
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const HOST_WALL = Date.parse('2026-10-30T12:00:00.000Z')
let rowSeq = 0
const assistant = (uuid: string, at: string | undefined, tools: Array<{ id: string; name?: string; input?: unknown }>) => ({
  type: 'assistant', uuid, parentUuid: null, isSidechain: false, sessionId: 'local-teleport-id', ...(at !== undefined ? { timestamp: at } : {}),
  message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content: tools.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name ?? 'Bash', input: tool.input ?? { command: 'npm test' }, caller: { type: 'direct' } })) }
})
const result = (toolUseId: string, at: string | undefined, options: { source?: string; isError?: boolean; content?: string; denied?: string } = {}) => ({
  type: 'user', uuid: `result-${++rowSeq}`, isSidechain: false, sessionId: 'local-teleport-id', ...(at !== undefined ? { timestamp: at } : {}),
  ...(options.source ? { sourceToolAssistantUUID: options.source } : {}), ...(options.denied ? { toolDenialKind: options.denied } : {}),
  permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule', ruleSource: 'cliArg' }, sandboxed: false,
  toolUseResult: { stdout: options.content ?? 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: options.content ?? 'ok', is_error: options.isError ?? false }] }
})
const teleportNote = { type: 'user', isMeta: true, timestamp: '2026-10-30T11:59:00.000Z', message: { role: 'user', content: 'This session is being continued from another machine. Application state may have changed. The updated working directory is /w' } }
const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

function recorder(options: { directory?: string; cloudCapacity?: number; wall?: number } = {}) {
  const clock = { wall: options.wall ?? HOST_WALL }
  const rec = new ToolTimingRecorder({ directory: options.directory, cloudCapacity: options.cloudCapacity, flushMs: 60_000, now: () => 7_777_777, wallNow: () => clock.wall, mask: maskSecrets })
  const pull = (text: string, cloudSessionId = 'session_01AAA', runId = 'cloud_run1') =>
    rec.importCloudTranscript({ projectId: 'p1', runId, cloudSessionId, model: 'claude-opus-5-5', calls: parseTranscript(text).tools })
  const cloud = (extra: Record<string, unknown> = {}) => rec.report({ origin: 'cloud-transcript', recent: 100, ...extra })
  return { rec, clock, pull, cloud }
}

const basic = jsonl([
  { type: 'user', timestamp: '2026-10-30T00:39:50.000Z', message: { role: 'user', content: 'Ship it' } },
  assistant('a1', '2026-10-30T00:39:52.117Z', [{ id: 'toolu_013ecUXPwrWv6anEf6JfSbVU', input: { command: 'git fetch origin' } }]),
  result('toolu_013ecUXPwrWv6anEf6JfSbVU', '2026-10-30T00:39:55.197Z', { source: 'a1' }),
  teleportNote
])

describe('cloud transcript tool timings: parseTranscript → importCloudTranscript → report', () => {
  it('times a paired call on the cloud rows\' own clock, apart from native timings', () => {
    const { rec, pull, cloud } = recorder()
    expect(pull(basic)).toEqual({ added: 1, known: 0, skipped: 0 })
    const [record] = cloud().recent
    expect(record).toMatchObject({
      provider: 'claude-cloud', origin: 'cloud-transcript', agentSessionId: 'cloud_run1', runtimeId: 'session_01AAA', itemId: 'toolu_013ecUXPwrWv6anEf6JfSbVU', projectId: 'p1',
      tool: 'Bash', args: 'git fetch origin', startedAt: '2026-10-30T00:39:52.117Z', endedAt: '2026-10-30T00:39:55.197Z',
      elapsedMs: 3_080, elapsedSource: 'transcript-wall', waitMs: null, waitSource: 'unavailable', execMs: null, execSource: 'unavailable', prepareMs: null, outcome: 'completed'
    })
    // The default report is native tabs only; a cloud call never enters its totals.
    expect(rec.report({}).totals.calls).toBe(0)
    expect(rec.report({ provider: 'claude-cloud' }).totals.calls).toBe(0)
    expect(cloud().gaps.some(gap => gap.startsWith('Cloud coworkers (origin cloud-transcript)'))).toBe(true)
    expect(cloud().coverage).toMatchObject({ elapsed: 1, wait: 0, exec: 0 })
  })

  it('adds nothing twice: repeated pulls, a pull after a restart, and reordered rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-timings-')); dirs.push(directory)
    const first = recorder({ directory })
    first.pull(basic)
    expect(first.pull(basic)).toEqual({ added: 0, known: 1, skipped: 0 })
    first.rec.dispose()
    const second = recorder({ directory })
    await second.rec.load()
    expect(second.cloud().totals.calls).toBe(1)
    const lines = basic.trim().split('\n')
    // The cloud's rows in another order; the teleport's own note always follows them.
    const reordered = [lines[2], lines[0], lines[1], lines[3]].join('\n')
    expect(parseTranscript(reordered).tools).toEqual(parseTranscript(basic).tools)
    expect(parseTranscript(reordered).tools).toHaveLength(1)
    expect(second.pull(reordered)).toEqual({ added: 0, known: 1, skipped: 0 })
    expect(second.cloud().recent).toHaveLength(1)
    expect(second.cloud().recent[0]).toMatchObject({ elapsedMs: 3_080 })
    second.rec.dispose()
    const persisted = readFileSync(join(directory, 'tool-timings.jsonl'), 'utf8') + (() => { try { return readFileSync(join(directory, 'tool-timings.exit.jsonl'), 'utf8') } catch { return '' } })()
    expect(new Set(persisted.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).key)).size).toBe(1)
  })

  it('waits for a partial pull\'s call to have its result, and ignores a result whose call is not in the file', () => {
    const { pull, cloud } = recorder()
    const partial = jsonl([assistant('a1', '2026-10-30T01:00:00.000Z', [{ id: 'toolu_running' }]), result('toolu_orphan', '2026-10-30T01:00:01.000Z')])
    expect(parseTranscript(partial).unmatched).toBe(1)
    expect(pull(partial)).toEqual({ added: 0, known: 0, skipped: 0 })
    const full = jsonl([assistant('a1', '2026-10-30T01:00:00.000Z', [{ id: 'toolu_running' }]), result('toolu_running', '2026-10-30T01:00:04.500Z', { source: 'a1' }), teleportNote])
    expect(pull(full)).toEqual({ added: 1, known: 0, skipped: 0 })
    expect(cloud().recent.map(record => [record.itemId, record.elapsedMs])).toEqual([['toolu_running', 4_500]])
  })

  it('keeps the same tool_use_id in two cloud sessions apart', () => {
    const { pull, cloud } = recorder()
    pull(basic, 'session_01AAA', 'cloud_run1')
    pull(basic, 'session_01BBB', 'cloud_run2')
    pull(basic, 'session_01AAA', 'cloud_run1')
    expect(cloud().recent.map(record => [record.runtimeId, record.agentSessionId]).sort()).toEqual([['session_01AAA', 'cloud_run1'], ['session_01BBB', 'cloud_run2']])
    expect(cloud({ agentSessionId: 'cloud_run2' }).totals.calls).toBe(1)
  })

  it('times nothing it cannot pair on one clock: missing, reversed, conflicting, misattributed, denied and teleport-local rows', () => {
    const { pull, cloud } = recorder()
    const rows = jsonl([
      assistant('a-missing', undefined, [{ id: 'toolu_missing' }]),
      result('toolu_missing', '2026-10-30T02:00:01.000Z', { source: 'a-missing' }),
      assistant('a-reversed', '2026-10-30T02:00:05.000Z', [{ id: 'toolu_reversed' }]),
      result('toolu_reversed', '2026-10-30T02:00:04.000Z', { source: 'a-reversed' }),
      assistant('a-conflict', '2026-10-30T02:00:06.000Z', [{ id: 'toolu_conflict' }]),
      result('toolu_conflict', '2026-10-30T02:00:07.000Z', { source: 'a-conflict' }),
      result('toolu_conflict', '2026-10-30T02:00:09.000Z', { source: 'a-conflict' }),
      assistant('a-other', '2026-10-30T02:00:10.000Z', [{ id: 'toolu_other' }]),
      result('toolu_other', '2026-10-30T02:00:11.000Z', { source: 'a-someone-else' }),
      assistant('a-denied', '2026-10-30T02:00:12.000Z', [{ id: 'toolu_denied' }]),
      result('toolu_denied', '2026-10-30T02:00:13.000Z', { source: 'a-denied', isError: true, denied: 'interrupted', content: 'Interrupted by user' }),
      assistant('a-bad', 'not a time', [{ id: 'toolu_bad_time' }]),
      result('toolu_bad_time', '2026-10-30T02:00:14.000Z', { source: 'a-bad' }),
      // In flight when the teleport ran: its "result" is the resumed side's, on this machine's clock.
      assistant('a-inflight', '2026-10-30T02:00:15.000Z', [{ id: 'toolu_inflight' }]),
      teleportNote,
      result('toolu_inflight', '2026-10-30T12:00:00.000Z', { source: 'a-inflight' }),
      assistant('a-local', '2026-10-30T12:00:01.000Z', [{ id: 'toolu_local' }]),
      result('toolu_local', '2026-10-30T12:00:02.000Z', { source: 'a-local' })
    ])
    expect(parseTranscript(rows).unmatched).toBe(1)
    pull(rows)
    const byId = Object.fromEntries(cloud().recent.map(record => [record.itemId, record]))
    expect(Object.keys(byId).sort()).toEqual(['toolu_bad_time', 'toolu_conflict', 'toolu_denied', 'toolu_missing', 'toolu_other', 'toolu_reversed'])
    for (const record of Object.values(byId)) expect(record).toMatchObject({ elapsedMs: null, elapsedSource: 'unavailable', waitMs: null, execMs: null })
    expect(byId.toolu_missing!.notes).toEqual(['missing-transcript-time'])
    expect(byId.toolu_bad_time!.notes).toEqual(['missing-transcript-time'])
    expect(byId.toolu_reversed!.notes).toEqual(['invalid-transcript-interval'])
    expect(byId.toolu_conflict!.notes).toEqual(['conflicting-restatement'])
    // Its first statements' own times stay its labels; this host's clock is never one.
    expect(byId.toolu_conflict).toMatchObject({ startedAt: '2026-10-30T02:00:06.000Z', endedAt: '2026-10-30T02:00:07.000Z' })
    expect(Object.values(byId).every(record => !record.notes?.includes('ended-at-import'))).toBe(true)
    expect(byId.toolu_other!.notes).toEqual(['result-names-another-row'])
    expect(byId.toolu_denied).toMatchObject({ outcome: 'interrupted', notes: ['denied-or-interrupted-result'] })
    // No record ever takes this host's time as a measurement.
    expect(cloud().tools.every(tool => tool.elapsed.measured === 0)).toBe(true)
  })

  it('masks secrets in arguments and failures, and stores no output body', () => {
    const { pull, cloud } = recorder()
    const token = 'ghp_' + 'Z'.repeat(36)
    const rows = jsonl([
      assistant('a1', '2026-10-30T03:00:00.000Z', [{ id: 'toolu_secret', input: { command: `curl -H "Authorization: Bearer ${token}" https://x.example/?token=${token}` } }]),
      result('toolu_secret', '2026-10-30T03:00:02.000Z', { source: 'a1', isError: true, content: `BODY-FIRST-LINE ${token}\nfatal: authentication failed for password=${token}\n` + 'q'.repeat(9_000) + '\nBODY-LAST-LINE' })
    ])
    pull(rows)
    const [record] = cloud().recent
    expect(record).toMatchObject({ outcome: 'failed', elapsedMs: 2_000 })
    expect(record!.args.length).toBeLessThanOrEqual(161)
    expect(record!.error!.length).toBeLessThanOrEqual(161)
    const serialized = JSON.stringify(cloud())
    expect(serialized).not.toContain(token)
    // Only the failure's first line, masked and bounded: never the rest of the output.
    expect(record!.error).toContain('[REDACTED]')
    expect(record!.error).toMatch(/^fatal: authentication failed/)
    expect(serialized).not.toContain('BODY-FIRST-LINE')
    expect(serialized).not.toContain('BODY-LAST-LINE')
    expect(serialized).not.toContain('q'.repeat(100))
  })

  it('bounds what it keeps: the cloud allowance, retention, and native records untouched', () => {
    const { rec, pull, cloud } = recorder({ cloudCapacity: 3 })
    rec.observe({ id: 'n1', sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p1', itemId: 'native-1', timestamp: '', data: { type: 'tool', name: 'Command', status: 'completed', durationMs: 5 } })
    const rows = (from: number, count: number) => jsonl(Array.from({ length: count }, (_, i) => {
      const at = (offset: number) => new Date(Date.parse('2026-10-30T04:00:00.000Z') + (from + i) * 60_000 + offset).toISOString()
      return [assistant(`a${from + i}`, at(0), [{ id: `toolu_${from + i}` }]), result(`toolu_${from + i}`, at(100), { source: `a${from + i}` })]
    }).flat())
    expect(pull(rows(0, 5))).toEqual({ added: 5, known: 0, skipped: 0 })
    expect(cloud().recent.map(record => record.itemId)).toEqual(['toolu_4', 'toolu_3', 'toolu_2'])
    // A later pull of the same transcript does not re-add what the allowance already let go.
    expect(pull(rows(0, 5))).toEqual({ added: 0, known: 3, skipped: 2 })
    expect(cloud().totals.calls).toBe(3)
    expect(rec.report({}).totals.calls).toBe(1)
    // Beyond retention (14 days before this host's now): never added.
    const old = jsonl([assistant('old', '2026-10-01T00:00:00.000Z', [{ id: 'toolu_old' }]), result('toolu_old', '2026-10-01T00:00:01.000Z', { source: 'old' })])
    expect(pull(old, 'session_01OLD')).toEqual({ added: 0, known: 0, skipped: 1 })
    // One transcript yields at most 2000 calls.
    expect(parseTranscript(rows(100, 2_050)).tools).toHaveLength(2_000)
  })

  it('refuses a malformed origin on load and in a query', () => {
    return import('../tool-timings').then(module => {
      expect(() => module.toolTimingsQuery({ origin: 'mirror' })).toThrow(/origin/)
      expect(module.toolTimingsQuery({ origin: 'cloud-transcript' })).toEqual({ origin: 'cloud-transcript' })
      const { rec, pull } = recorder()
      pull(basic)
      const line = JSON.stringify({ v: 1, ...rec.report({ origin: 'cloud-transcript', recent: 1 }).recent[0] })
      expect(module.parseRecord(line)).toMatchObject({ origin: 'cloud-transcript' })
      expect(module.parseRecord(line.replace('"origin":"cloud-transcript"', '"origin":"elsewhere"'))).toBeNull()
    })
  })
})
