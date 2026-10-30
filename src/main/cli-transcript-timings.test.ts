import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeHistoryPath, claudeHistorySize, readClaudeCliToolCalls } from './native-history'
import { maskSecrets } from './structured-store'
import { ToolTimingRecorder } from './tool-timings'
import { parseTranscript } from './cloud/runs'

/**
 * Raw Claude CLI-view tool timings (docs/perf-evidence/t3code-cli-transcript-timings.md): rows in
 * the shape Claude Code 2.1.312 writes to ~/.claude/projects/<cwd>/<session>.jsonl, read by the real
 * bounded reader from the handoff's byte offset, into the recorder, out through its report. This
 * host's clock is pinned far from the rows' own times.
 */
const HOST_WALL = Date.parse('2026-10-30T12:00:00.000Z')
const NATIVE = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
let config: string, cwd: string, seq = 0
const dirs: string[] = []
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'cli-timings-config-')); cwd = mkdtempSync(join(tmpdir(), 'cli-timings-project-'))
  dirs.push(config, cwd)
  vi.stubEnv('CLAUDE_CONFIG_DIR', config)
})
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const use = (session: string, uuid: string, at: string | undefined, id: string, input: unknown = { command: 'npm test' }, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, parentUuid: null, isSidechain: false, sessionId: session, cwd, ...(at !== undefined ? { timestamp: at } : {}), ...extra,
  message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input, caller: { type: 'direct' } }] }
})
const result = (session: string, id: string, at: string | undefined, source: string, options: { isError?: boolean; content?: string; denied?: string; extra?: Record<string, unknown> } = {}) => ({
  type: 'user', uuid: `r-${++seq}`, isSidechain: false, sessionId: session, cwd, ...(at !== undefined ? { timestamp: at } : {}), sourceToolAssistantUUID: source,
  ...(options.denied ? { toolDenialKind: options.denied } : {}), ...options.extra,
  permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule', ruleSource: 'cliArg' }, sandboxed: false,
  toolUseResult: { stdout: options.content ?? 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: options.content ?? 'ok', is_error: options.isError ?? false }] }
})
const lines = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const file = (session = NATIVE): string => { const path = claudeHistoryPath(cwd, session); mkdirSync(dirname(path), { recursive: true }); return path }
const write = (rows: unknown[], session = NATIVE) => writeFileSync(file(session), lines(rows))
const append = (rows: unknown[], session = NATIVE) => appendFileSync(file(session), lines(rows))

function recorder(options: { directory?: string; cliCapacity?: number } = {}) {
  const rec = new ToolTimingRecorder({ directory: options.directory, cliCapacity: options.cliCapacity, flushMs: 60_000, now: () => 5_555_555, wallNow: () => HOST_WALL, mask: maskSecrets })
  const importFrom = async (from: number, session = NATIVE, conversation = 'agent_tab1', known?: string[], maxBytes?: number) => {
    const read = await readClaudeCliToolCalls(cwd, session, from, { known, maxBytes })
    return { read, counts: rec.importCliTranscript({ projectId: 'p1', agentSessionId: conversation, nativeSessionId: session, model: 'claude-opus-5-5', calls: read.tools }) }
  }
  const cli = (extra: Record<string, unknown> = {}) => rec.report({ origin: 'cli-transcript', recent: 100, ...extra })
  return { rec, importFrom, cli }
}

/** What the structured (chat) view had already written before the tab switched to the CLI. */
const beforeHandoff = [use(NATIVE, 'a-chat', '2026-10-30T09:00:00.000Z', 'toolu_chat'), result(NATIVE, 'toolu_chat', '2026-10-30T09:00:02.000Z', 'a-chat')]

describe('Claude CLI-view tool timings: transcript rows → bounded reader → importCliTranscript → report', () => {
  it('times only the CLI view\'s own calls, on its row clock, apart from native and cloud timings', async () => {
    expect(await claudeHistorySize(cwd, NATIVE)).toBe(0)
    write(beforeHandoff)
    const offset = (await claudeHistorySize(cwd, NATIVE))!
    append([use(NATIVE, 'a-cli', '2026-10-30T10:00:00.000Z', 'toolu_cli', { command: 'git status' }), result(NATIVE, 'toolu_cli', '2026-10-30T10:00:01.250Z', 'a-cli')])
    const { rec, importFrom, cli } = recorder()
    const { read, counts } = await importFrom(offset)
    expect(read).toMatchObject({ truncated: false, shrank: false, unmatched: 0 })
    expect(read.bytesRead).toBeLessThan(2_000)
    expect(counts).toEqual({ added: 1, known: 0, skipped: 0 })
    expect(cli().recent).toEqual([expect.objectContaining({
      origin: 'cli-transcript', provider: 'claude-cli', agentSessionId: 'agent_tab1', runtimeId: NATIVE, itemId: 'toolu_cli', tool: 'Bash', args: 'git status',
      startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:01.250Z', elapsedMs: 1_250, elapsedSource: 'transcript-wall',
      waitMs: null, waitSource: 'unavailable', execMs: null, execSource: 'unavailable', prepareMs: null, outcome: 'completed'
    })])
    // The chat view's own call is the live recorder's, never read again here.
    expect(cli().recent.some(record => record.itemId === 'toolu_chat')).toBe(false)
    expect(rec.report({}).totals.calls).toBe(0)
    expect(rec.report({ origin: 'cloud-transcript' }).totals.calls).toBe(0)
    expect(cli().gaps.some(gap => gap.startsWith('Claude CLI-view tabs (origin cli-transcript)'))).toBe(true)
  })

  it('leaves out calls the handoff already knew, even when they are restated after it', async () => {
    write(beforeHandoff)
    const offset = (await claudeHistorySize(cwd, NATIVE))!
    append([use(NATIVE, 'a-chat', '2026-10-30T09:00:00.000Z', 'toolu_chat'), result(NATIVE, 'toolu_chat', '2026-10-30T09:00:02.000Z', 'a-chat'),
      use(NATIVE, 'a-new', '2026-10-30T10:05:00.000Z', 'toolu_new'), result(NATIVE, 'toolu_new', '2026-10-30T10:05:03.000Z', 'a-new')])
    const { importFrom, cli } = recorder()
    await importFrom(offset, NATIVE, 'agent_tab1', ['toolu_chat'])
    expect(cli().recent.map(record => record.itemId)).toEqual(['toolu_new'])
  })

  it('adds nothing twice: a partial read, the full read, a repeat, a restart and reordered rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-timings-store-')); dirs.push(directory)
    write(beforeHandoff)
    const offset = (await claudeHistorySize(cwd, NATIVE))!
    append([use(NATIVE, 'a1', '2026-10-30T10:10:00.000Z', 'toolu_slow')])
    const first = recorder({ directory })
    const partial = await first.importFrom(offset)
    expect(partial.read.unmatched).toBe(1)
    expect(partial.counts).toEqual({ added: 0, known: 0, skipped: 0 })
    append([result(NATIVE, 'toolu_slow', '2026-10-30T10:10:42.000Z', 'a1')])
    expect((await first.importFrom(offset)).counts).toEqual({ added: 1, known: 0, skipped: 0 })
    expect((await first.importFrom(offset)).counts).toEqual({ added: 0, known: 1, skipped: 0 })
    first.rec.dispose()
    const second = recorder({ directory })
    await second.rec.load()
    expect((await second.importFrom(offset)).counts).toEqual({ added: 0, known: 1, skipped: 0 })
    expect(second.cli().recent).toEqual([expect.objectContaining({ itemId: 'toolu_slow', elapsedMs: 42_000 })])
    // The same rows in another order pair the same.
    const shuffled = [result(NATIVE, 'toolu_x', '2026-10-30T10:20:05.000Z', 'ax'), use(NATIVE, 'ax', '2026-10-30T10:20:00.000Z', 'toolu_x')]
    write([...beforeHandoff, ...shuffled])
    const reordered = await readClaudeCliToolCalls(cwd, NATIVE, offset)
    write([...beforeHandoff, ...shuffled.slice().reverse()])
    expect((await readClaudeCliToolCalls(cwd, NATIVE, offset)).tools).toEqual(reordered.tools)
    expect(reordered.tools.map(call => call.toolUseId)).toEqual(['toolu_x'])
  })

  it('keeps one tool_use_id in two conversations apart, and two calls with the same arguments apart', async () => {
    const { importFrom, cli } = recorder()
    write([use(NATIVE, 'a1', '2026-10-30T10:30:00.000Z', 'toolu_same'), result(NATIVE, 'toolu_same', '2026-10-30T10:30:01.000Z', 'a1'),
      use(NATIVE, 'a2', '2026-10-30T10:31:00.000Z', 'toolu_twin'), result(NATIVE, 'toolu_twin', '2026-10-30T10:31:04.000Z', 'a2')])
    write([use(OTHER, 'b1', '2026-10-30T10:30:00.000Z', 'toolu_same'), result(OTHER, 'toolu_same', '2026-10-30T10:30:09.000Z', 'b1')], OTHER)
    await importFrom(0, NATIVE, 'agent_tab1')
    await importFrom(0, OTHER, 'agent_tab2')
    await importFrom(0, NATIVE, 'agent_tab1')
    expect(cli().recent.map(record => [record.runtimeId, record.itemId, record.elapsedMs]).sort()).toEqual([[NATIVE, 'toolu_same', 1_000], [NATIVE, 'toolu_twin', 4_000], [OTHER, 'toolu_same', 9_000]])
    expect(cli({ agentSessionId: 'agent_tab2' }).totals.calls).toBe(1)
  })

  it('takes no row from another session, a cloud teleport or a copy, so cloud calls are never counted here', async () => {
    write(beforeHandoff)
    const offset = (await claudeHistorySize(cwd, NATIVE))!
    append([
      use(OTHER, 'x1', '2026-10-30T10:40:00.000Z', 'toolu_foreign'), result(OTHER, 'toolu_foreign', '2026-10-30T10:40:01.000Z', 'x1'),
      use(NATIVE, 'c1', '2026-10-30T08:00:00.000Z', 'toolu_copied', undefined, { remoteSourced: true }), result(NATIVE, 'toolu_copied', '2026-10-30T08:00:01.000Z', 'c1', { extra: { remoteSourced: true } }),
      // A cloud session teleported into this conversation: its rows, then the teleport's note.
      use(NATIVE, 'cloud1', '2026-10-30T07:00:00.000Z', 'toolu_cloud'), result(NATIVE, 'toolu_cloud', '2026-10-30T07:00:05.000Z', 'cloud1'),
      { type: 'user', isMeta: true, sessionId: NATIVE, timestamp: '2026-10-30T10:41:00.000Z', message: { role: 'user', content: 'This session is being continued from another machine. Application state may have changed.' } },
      use(NATIVE, 'local1', '2026-10-30T10:42:00.000Z', 'toolu_after'), result(NATIVE, 'toolu_after', '2026-10-30T10:42:02.000Z', 'local1')
    ])
    const { importFrom, cli } = recorder()
    await importFrom(offset)
    expect(cli().recent.map(record => record.itemId)).toEqual(['toolu_after'])
  })

  it('times nothing it cannot pair on one clock: missing, reversed, conflicting, misattributed and denied', async () => {
    write([
      use(NATIVE, 'm', undefined, 'toolu_missing'), result(NATIVE, 'toolu_missing', '2026-10-30T11:00:01.000Z', 'm'),
      use(NATIVE, 'r', '2026-10-30T11:00:05.000Z', 'toolu_reversed'), result(NATIVE, 'toolu_reversed', '2026-10-30T11:00:04.000Z', 'r'),
      use(NATIVE, 'c', '2026-10-30T11:00:06.000Z', 'toolu_conflict'), result(NATIVE, 'toolu_conflict', '2026-10-30T11:00:07.000Z', 'c'), result(NATIVE, 'toolu_conflict', '2026-10-30T11:00:08.000Z', 'c'),
      use(NATIVE, 'o', '2026-10-30T11:00:09.000Z', 'toolu_other'), result(NATIVE, 'toolu_other', '2026-10-30T11:00:10.000Z', 'not-o'),
      use(NATIVE, 'd', '2026-10-30T11:00:11.000Z', 'toolu_denied'), result(NATIVE, 'toolu_denied', '2026-10-30T11:00:12.000Z', 'd', { isError: true, denied: 'permission-rule', content: 'Permission denied' })
    ])
    const { importFrom, cli } = recorder()
    await importFrom(0)
    const byId = Object.fromEntries(cli().recent.map(record => [record.itemId, record]))
    for (const record of Object.values(byId)) expect(record).toMatchObject({ elapsedMs: null, elapsedSource: 'unavailable', waitMs: null, execMs: null })
    expect(byId.toolu_missing!.notes).toEqual(['missing-transcript-time'])
    expect(byId.toolu_reversed!.notes).toEqual(['invalid-transcript-interval'])
    expect(byId.toolu_conflict!.notes).toEqual(['conflicting-restatement'])
    expect(byId.toolu_other!.notes).toEqual(['result-names-another-row'])
    expect(byId.toolu_denied).toMatchObject({ outcome: 'rejected', notes: ['denied-or-interrupted-result'] })
    expect(cli().tools.every(tool => tool.elapsed.measured === 0)).toBe(true)
  })

  it('reads only a bounded window from the handoff on, and nothing from a file that shrank', async () => {
    write(beforeHandoff)
    const offset = (await claudeHistorySize(cwd, NATIVE))!
    const many = Array.from({ length: 200 }, (_, i) => {
      const at = (ms: number) => new Date(Date.parse('2026-10-30T11:10:00.000Z') + i * 1000 + ms).toISOString()
      return [use(NATIVE, `w${i}`, at(0), `toolu_w${i}`, { command: 'echo ' + 'p'.repeat(400) }), result(NATIVE, `toolu_w${i}`, at(10), `w${i}`)]
    }).flat()
    append(many)
    const read = await readClaudeCliToolCalls(cwd, NATIVE, offset, { maxBytes: 20_000 })
    expect(read.truncated).toBe(true)
    expect(read.bytesRead).toBe(20_000)
    expect(read.tools.length).toBeGreaterThan(5)
    expect(read.tools.length).toBeLessThan(40)
    // Only the newest calls: the window ends at the file's end.
    expect(read.tools.at(-1)!.toolUseId).toBe('toolu_w199')
    expect(read.tools.every(call => call.notes.length === 0)).toBe(true)
    write(beforeHandoff.slice(0, 1))
    expect(await readClaudeCliToolCalls(cwd, NATIVE, offset)).toMatchObject({ tools: [], shrank: true, bytesRead: 0 })
    expect(await readClaudeCliToolCalls(cwd, NATIVE, -1)).toMatchObject({ tools: [], bytesRead: 0 })
    expect(await readClaudeCliToolCalls(cwd, '33333333-3333-4333-8333-333333333333', 0)).toMatchObject({ tools: [], bytesRead: 0 })
  })

  it('keeps at most its own allowance, leaving native and cloud records alone', async () => {
    const { rec, importFrom, cli } = recorder({ cliCapacity: 2 })
    rec.observe({ id: 'n1', sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p1', itemId: 'native-1', timestamp: '', data: { type: 'tool', name: 'Command', status: 'completed', durationMs: 5 } })
    rec.importCloudTranscript({ projectId: 'p1', runId: 'cloud_1', cloudSessionId: 'session_01A', calls: parseTranscript(lines([use('cloud', 'k', '2026-10-30T11:20:00.000Z', 'toolu_k'), result('cloud', 'toolu_k', '2026-10-30T11:20:01.000Z', 'k')])).tools })
    write(Array.from({ length: 4 }, (_, i) => [use(NATIVE, `q${i}`, `2026-10-30T11:3${i}:00.000Z`, `toolu_q${i}`), result(NATIVE, `toolu_q${i}`, `2026-10-30T11:3${i}:01.000Z`, `q${i}`)]).flat())
    expect((await importFrom(0)).counts).toEqual({ added: 4, known: 0, skipped: 0 })
    expect(cli().recent.map(record => record.itemId)).toEqual(['toolu_q3', 'toolu_q2'])
    expect((await importFrom(0)).counts).toEqual({ added: 0, known: 2, skipped: 2 })
    expect(rec.report({}).totals.calls).toBe(1)
    expect(rec.report({ origin: 'cloud-transcript' }).totals.calls).toBe(1)
  })

  it('masks secrets in arguments and failures, and stores no output body', async () => {
    const token = 'sk-ant-' + 'Q'.repeat(40)
    write([use(NATIVE, 's1', '2026-10-30T11:40:00.000Z', 'toolu_secret', { command: `curl -H "x-api-key: ${token}" "https://api.example/v1?api_key=${token}"` }),
      result(NATIVE, 'toolu_secret', '2026-10-30T11:40:03.000Z', 's1', { isError: true, content: `BODY-START ${token}\nerror: request failed api_key=${token}\n` + 'z'.repeat(20_000) + '\nBODY-END' })])
    const { importFrom, cli } = recorder()
    await importFrom(0)
    const [record] = cli().recent
    expect(record).toMatchObject({ outcome: 'failed', elapsedMs: 3_000 })
    expect(record!.error).toMatch(/^error: request failed/)
    expect(record!.error!.length).toBeLessThanOrEqual(161)
    const serialized = JSON.stringify(cli())
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('BODY-START')
    expect(serialized).not.toContain('BODY-END')
    expect(serialized).not.toContain('z'.repeat(100))
  })

  it('accepts the cli origin in queries and on load, and nothing else new', async () => {
    const module = await import('./tool-timings')
    expect(module.toolTimingsQuery({ origin: 'cli-transcript' })).toEqual({ origin: 'cli-transcript' })
    expect(() => module.toolTimingsQuery({ origin: 'cli' })).toThrow(/origin/)
    write([use(NATIVE, 'a', '2026-10-30T11:50:00.000Z', 'toolu_line'), result(NATIVE, 'toolu_line', '2026-10-30T11:50:01.000Z', 'a')])
    const { importFrom, cli } = recorder()
    await importFrom(0)
    const line = JSON.stringify({ v: 1, ...cli({ recent: 1 }).recent[0] })
    expect(module.parseRecord(line)).toMatchObject({ origin: 'cli-transcript' })
    expect(module.parseRecord(line.replace('"origin":"cli-transcript"', '"origin":"cli"'))).toBeNull()
  })
})
