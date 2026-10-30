import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claudeHistoryPath } from './native-history'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { maskSecrets } from './structured-store'
import { ToolTimingRecorder } from './tool-timings'
import type { AgentSpec } from '../shared/models'
import type { StructuredProvider, AdapterEvent, ProviderCapabilities, SessionSettings } from '../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import { AgentManager } from './agent-manager'
import { anonymousConversations } from './local-models/anonymous'

// The main-process modules reach for Electron; nothing here may start it, a CLI or a model.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => undefined, on: () => undefined }, shell: {}, safeStorage: { isEncryptionAvailable: () => false } }))

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./machine-policy', async importOriginal => ({ ...await importOriginal<typeof import('./machine-policy')>(), detectMachine: async () => ({}) as never }))

const settings: SessionSettings = { permission: 'default', plan: false }
const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) { try { manager.dispose() } catch {} }
  for (const db of databases.splice(0)) { try { db.close() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  vi.unstubAllEnvs()
})

/** A synthetic runtime: reports a native conversation id and finishes turns on request; launches nothing. */
class FakeProvider implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: true, plans: true, permissions: ['default', 'accept-edits'], effort: ['low'], models: [], limitations: ['SYNTHETIC zero-inference fixture'] }
  startGate?: Promise<void>
  nativeIdentityOnStart = true
  disposed = false
  constructor(readonly options: AdapterOptions) {}
  async start(): Promise<void> { await this.startGate; this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: this.options.nativeSessionId ?? (this.nativeIdentityOnStart ? `native-${this.options.runtimeId}` : undefined) } }) }
  async submit(): Promise<void> { if (this.disposed) throw new Error('Fake runtime disposed') }
  async respond(): Promise<void> {}
  async interrupt(): Promise<void> { this.emit({ data: { type: 'session', phase: 'interrupted' } }) }
  dispose(): void { this.disposed = true }
  emit(event: AdapterEvent): void { this.options.emit(event) }
  finish(): void { this.emit({ data: { type: 'session', phase: 'completed' } }) }
}
function fixture(provider: 'claude' | 'codex' = 'claude', nativeIdentityOnStart = true) {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-cli-capture-')); roots.push(root)
  const workspace = join(root, 'Workspace 日本語 with spaces'); mkdirSync(workspace)
  const database = new ConductorDatabase(join(root, 'conductor.db')); databases.push(database)
  const project = database.upsertProject(workspace, 'Synthetic project')
  const session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'agent-session', projectId: project.id, sessionId: session.id, provider, title: 'Synthetic Claude', cwd: workspace }
  const adapters: FakeProvider[] = []
  let startGate: Promise<void> | undefined
  const factory = (_provider: StructuredProvider, options: AdapterOptions) => { const adapter = new FakeProvider(options); adapter.startGate = startGate; adapter.nativeIdentityOnStart = nativeIdentityOnStart; adapters.push(adapter); return adapter }
  const manager = new StructuredSessions(database, () => 'synthetic-executable', vi.fn(), factory); managers.push(manager)
  manager.ensure(spec)
  return { root, workspace, database, spec, factory, manager, gateStart(gate: Promise<void>) { startGate = gate }, get current() { return adapters.at(-1)! } }
}

/**
 * A raw Claude CLI view's tool timings through the real prepareCli / finishCli (docs/perf-evidence/
 * t3code-cli-capture-safety.md): the persisted boundary, the transcript file the CLI appends to, the
 * hook AgentManager wires to the recorder, and the recorder's report. No CLI or model is launched.
 */
describe('Claude CLI-view capture: persisted boundary, bounded read and explicit coverage', () => {
  const T0 = Date.parse('2026-10-30T10:00:00.000Z')
  const HOST_WALL = Date.parse('2026-10-30T12:00:00.000Z')
  const stamp = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()
  type Round = { f: ReturnType<typeof fixture>; nativeId: string; log: string; calls: Array<{ calls: any[]; coverage: any }>; recorder: ToolTimingRecorder; cli: () => ReturnType<ToolTimingRecorder['report']> }
  const call = (nativeId: string, tag: string, at: number, ms: number, command = 'npm test') => [
    JSON.stringify({ type: 'assistant', uuid: 'a-' + tag, sessionId: nativeId, timestamp: stamp(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + tag, name: 'Bash', input: { command } }] } }),
    JSON.stringify({ type: 'user', uuid: 'r-' + tag, sessionId: nativeId, timestamp: stamp(at + ms), sourceToolAssistantUUID: 'a-' + tag, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + tag, content: 'ok', is_error: false }] } })
  ].join('\n') + '\n'
  const useOnly = (nativeId: string, tag: string, at: number) => JSON.stringify({ type: 'assistant', uuid: 'a-' + tag, sessionId: nativeId, timestamp: stamp(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + tag, name: 'Bash', input: { command: 'sleep 99' } }] } }) + '\n'
  const filler = (nativeId: string, bytes: number) => { const line = JSON.stringify({ type: 'summary', sessionId: nativeId, summary: 'f'.repeat(900) }) + '\n'; return line.repeat(Math.ceil(bytes / line.length)) }

  /** A conversation with `before` already in its transcript, handed to the CLI view; `during` runs while the CLI view owns it. */
  async function handoff(before: (nativeId: string) => string, options: { provider?: 'claude' | 'codex'; directory?: string } = {}): Promise<Round & { finish(): Promise<void> }> {
    const f = fixture(options.provider ?? 'claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(f.root, 'claude-profile'))
    await f.manager.submit(f.spec.id, 'existing conversation', settings); f.current.finish()
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId!
    const log = claudeHistoryPath(f.workspace, nativeId)
    mkdirSync(dirname(log), { recursive: true })
    writeFileSync(log, before(nativeId))
    const recorder = new ToolTimingRecorder({ directory: options.directory, flushMs: 60_000, now: () => 1_000, wallNow: () => HOST_WALL, mask: maskSecrets })
    const calls: Round['calls'] = []
    // What AgentManager wires (src/main/agent-manager.ts): the same fields into the recorder.
    f.manager.cliToolCalls = (spec, native, found, coverage) => {
      calls.push({ calls: found, coverage })
      recorder.importCliTranscript({ projectId: spec.projectId, agentSessionId: spec.id, nativeSessionId: native, calls: found, coverage })
    }
    await f.manager.prepareCli(f.spec.id)
    return { f, nativeId, log, calls, recorder, cli: () => recorder.report({ origin: 'cli-transcript', recent: 100 }), finish: () => f.manager.finishCli(f.spec.id) }
  }
  const ids = (round: Round) => round.cli().recent.map(record => record.itemId).sort()
  const setHandoff = (round: Round, edit: (stored: any) => any) => { const key = 'cliHandoff:' + round.f.spec.id; round.f.database.setSetting(key, JSON.stringify(edit(JSON.parse(round.f.database.getSetting(key)!)))) }

  it('verifies the boundary, imports exactly the CLI\'s own calls for this conversation and reports the read complete', async () => {
    const round = await handoff(id => call(id, 'chat', 0, 2_000, 'echo SECRET-ROW-TEXT'))
    // The boundary holds sizes and hashes only: no row text.
    const stored = round.f.database.getSetting('cliHandoff:' + round.f.spec.id)!
    expect(JSON.parse(stored).claudeBoundary).toMatchObject({ bytes: statSync(round.log).size, head: expect.stringMatching(/^[0-9a-f]{64}$/), tail: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(stored).not.toContain('SECRET-ROW-TEXT')
    appendFileSync(round.log, call(round.nativeId, 'cli', 60_000, 1_250, 'git status') + useOnly(round.nativeId, 'hung', 70_000))
    await round.finish()
    expect(round.calls).toHaveLength(1)
    expect(round.calls[0]!.coverage).toMatchObject({ status: 'complete', reason: 'complete', unmatchedCalls: 1, unpairedResults: 0, bytesSkipped: 0, droppedCalls: 0, handoffId: expect.any(String) })
    expect(round.cli().recent).toEqual([expect.objectContaining({
      origin: 'cli-transcript', provider: 'claude-cli', agentSessionId: round.f.spec.id, runtimeId: round.nativeId, itemId: 'toolu_cli', tool: 'Bash',
      startedAt: stamp(60_000), endedAt: stamp(61_250), elapsedMs: 1_250, elapsedSource: 'transcript-wall', waitMs: null, execMs: null
    })])
    expect(round.recorder.report({}).totals.calls).toBe(0)
    expect(round.cli().captureCoverage?.cliTranscript).toMatchObject({ returns: 1, complete: 1, partial: 0, unavailable: 0, recentIncomplete: [] })
    expect(round.f.database.getSetting('cliHandoff:' + round.f.spec.id)).toBeNull()
  })

  it('adds nothing twice across a failed return that is retried, a repeated finish and a restart before the handoff is cleared', async () => {
    const round = await handoff(id => call(id, 'chat', 0, 1_000))
    appendFileSync(round.log, call(round.nativeId, 'cli', 60_000, 3_000))
    const saved = round.f.database.getSetting('cliHandoff:' + round.f.spec.id)!
    // The first attempt cannot reconnect: nothing is read or recorded, and the handoff stays.
    round.f.gateStart(Promise.reject(new Error('runtime would not start')))
    await expect(round.finish()).rejects.toThrow('would not start')
    expect(round.calls).toHaveLength(0)
    expect(round.f.database.getSetting('cliHandoff:' + round.f.spec.id)).toBe(saved)
    round.f.gateStart(Promise.resolve())
    await round.finish()
    await round.finish()
    expect(round.calls).toHaveLength(1)
    // A restart: a new manager over the same database finds the handoff still there (cleared after this read).
    round.f.database.setSetting('cliHandoff:' + round.f.spec.id, saved)
    const restarted = new StructuredSessions(round.f.database, () => 'synthetic-executable', vi.fn(), round.f.factory); managers.push(restarted)
    restarted.ensure(round.f.spec)
    restarted.cliToolCalls = round.f.manager.cliToolCalls
    await restarted.finishCli(round.f.spec.id)
    expect(round.calls).toHaveLength(2)
    expect(round.calls[1]!.coverage.handoffId).toBe(round.calls[0]!.coverage.handoffId)
    expect(ids(round)).toEqual(['toolu_cli'])
    expect(round.cli().captureCoverage?.cliTranscript).toMatchObject({ returns: 1, complete: 1 })
  })

  it('imports nothing from a transcript rewritten to the same size, with its identity unchanged, and says so', async () => {
    const round = await handoff(id => call(id, 'chat1', 0, 1_000) + call(id, 'chat2', 5_000, 2_000))
    const original = readFileSync(round.log, 'utf8')
    // Same length, other content (another conversation's rows under this file name), then the CLI's own call.
    const rewritten = original.replace(/toolu_chat/g, 'toolu_XXXX').replace(/npm test/g, 'npm pack')
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    writeFileSync(round.log, rewritten)
    appendFileSync(round.log, call(round.nativeId, 'cli', 60_000, 1_000))
    await round.finish()
    // Rows of a file that is no longer the one handed over are not the CLI's calls.
    expect(ids(round)).toEqual([])
    expect(round.calls).toHaveLength(1)
    expect(round.calls[0]!.coverage).toMatchObject({ status: 'unavailable', reason: 'file-changed', bytesRead: 0 })
    expect(round.calls[0]!.calls).toEqual([])
    expect(round.cli().captureCoverage?.cliTranscript).toMatchObject({ returns: 1, complete: 0, unavailable: 1, recentIncomplete: [expect.objectContaining({ reason: 'file-changed', agentSessionId: round.f.spec.id, nativeSessionId: round.nativeId })] })
    expect(round.cli().gaps.some(gap => /incomplete for 1 of 1 returns/.test(gap))).toBe(true)
    // The conversation still returns to Chat.
    expect(round.f.database.structured.snapshot(round.f.spec.id)?.view).toBe('visual')
  })

  it('does not read a prefix rewritten at its end, a shrunk file, or one that was replaced and regrown past the boundary', async () => {
    const shrunk = await handoff(id => call(id, 'chat1', 0, 1_000) + call(id, 'chat2', 5_000, 2_000))
    truncateSync(shrunk.log, Math.floor(statSync(shrunk.log).size / 2))
    await shrunk.finish()
    expect(shrunk.calls).toHaveLength(1)
    expect(shrunk.calls[0]!.coverage).toMatchObject({ status: 'unavailable', reason: 'file-shrank', bytesRead: 0 })
    expect(shrunk.calls[0]!.calls).toEqual([])

    const regrown = await handoff(id => call(id, 'chat1', 0, 1_000) + call(id, 'chat2', 5_000, 2_000))
    const size = statSync(regrown.log).size
    truncateSync(regrown.log, Math.floor(size / 2))
    appendFileSync(regrown.log, call(regrown.nativeId, 'other', 30_000, 4_000) + call(regrown.nativeId, 'cli', 60_000, 1_000))
    expect(statSync(regrown.log).size).toBeGreaterThan(size)
    await regrown.finish()
    expect(ids(regrown)).toEqual([])
    expect(regrown.calls[0]!.coverage).toMatchObject({ status: 'unavailable', reason: 'file-changed' })

    const gone = await handoff(id => call(id, 'chat1', 0, 1_000))
    rmSync(gone.log)
    await gone.finish()
    expect(gone.calls[0]!.coverage).toMatchObject({ status: 'unavailable', reason: 'file-missing' })
  })

  it('reports a lost, legacy size-only or malformed boundary as unavailable instead of reading from a guess', async () => {
    const cases: Array<[string, (stored: any, size: number) => any, string]> = [
      ['lost', ({ id, known }) => ({ id, known }), 'boundary-missing'],
      ['legacy size-only', ({ id, known }, size) => ({ id, known, claudeBytes: size }), 'boundary-unverified'],
      ['malformed size', ({ id, known }) => ({ id, known, claudeBytes: 'many' }), 'boundary-malformed'],
      ['malformed boundary', ({ id, known }) => ({ id, known, claudeBoundary: { bytes: -4, head: 'nope' } }), 'boundary-malformed'],
      ['boundary of the wrong type', ({ id, known }) => ({ id, known, claudeBoundary: 'a lot' }), 'boundary-malformed'],
      ['hashes missing', ({ id, known }, size) => ({ id, known, claudeBoundary: { bytes: size } }), 'boundary-malformed']
    ]
    for (const [label, edit, reason] of cases) {
      const round = await handoff(id => call(id, 'chat', 0, 1_000))
      const size = statSync(round.log).size
      setHandoff(round, stored => edit(stored, size))
      appendFileSync(round.log, call(round.nativeId, 'cli', 60_000, 1_000))
      await round.finish()
      expect(ids(round), label).toEqual([])
      expect(round.calls, label).toHaveLength(1)
      expect(round.calls[0]!.coverage, label).toMatchObject({ status: 'unavailable', reason })
      expect(round.calls[0]!.calls, label).toEqual([])
      expect(round.f.database.structured.snapshot(round.f.spec.id)?.view, label).toBe('visual')
    }
  })

  it('names what a transcript larger than the read window left unread, and never calls that complete', async () => {
    const round = await handoff(id => call(id, 'chat', 0, 1_000))
    const id = round.nativeId
    // Appended: an early call, a call whose result alone lands in the window, 17 MiB of other rows, a late call.
    appendFileSync(round.log, call(id, 'early', 60_000, 1_000) + useOnly(id, 'straddle', 62_000))
    appendFileSync(round.log, filler(id, 17 * 1024 * 1024))
    appendFileSync(round.log, JSON.stringify({ type: 'user', uuid: 'r-straddle', sessionId: id, timestamp: stamp(90_000), sourceToolAssistantUUID: 'a-straddle', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_straddle', content: 'ok', is_error: false }] } }) + '\n' + call(id, 'late', 100_000, 2_500))
    await round.finish()
    const { coverage, calls } = round.calls[0]!
    expect(coverage).toMatchObject({ status: 'partial', reason: 'window-truncated', unpairedResults: 1, unmatchedCalls: 0 })
    expect(coverage.bytesRead).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(coverage.bytesSkipped).toBeGreaterThan(1024 * 1024)
    expect(coverage.fileBytes).toBe(statSync(round.log).size)
    expect(coverage.bytesSkipped + coverage.bytesRead).toBeLessThanOrEqual(coverage.fileBytes - coverage.boundaryBytes)
    expect(calls.map((found: any) => found.toolUseId)).toEqual(['toolu_late'])
    // Never fabricated: the straddling call has no record and no duration; only the late call is timed.
    expect(round.cli().recent.map(record => [record.itemId, record.elapsedMs])).toEqual([['toolu_late', 2_500]])
    expect(round.cli().captureCoverage?.cliTranscript).toMatchObject({ returns: 1, complete: 0, partial: 1, recentIncomplete: [expect.objectContaining({ reason: 'window-truncated', bytesSkipped: coverage.bytesSkipped })] })
    expect(round.cli().gaps.some(gap => /incomplete for 1 of 1 returns/.test(gap))).toBe(true)
  })

  it('says so when more calls were appended than the pairing holds, and keeps only the newest ones, untouched', async () => {
    const round = await handoff(id => call(id, 'chat', 0, 1_000))
    const many = Array.from({ length: 9_000 }, (_, i) => call(round.nativeId, 'n' + String(i).padStart(5, '0'), 60_000 + i * 1_000, 400)).join('')
    appendFileSync(round.log, many)
    await round.finish()
    const { coverage, calls } = round.calls[0]!
    expect(coverage).toMatchObject({ status: 'partial', reason: 'call-limit', bytesSkipped: 0 })
    expect(coverage.droppedCalls).toBeGreaterThan(0)
    expect(calls.length).toBeLessThanOrEqual(2_000)
    expect(calls.at(-1).toolUseId).toBe('toolu_n08999')
    expect(round.cli().captureCoverage?.cliTranscript).toMatchObject({ partial: 1, complete: 0 })
  })

  it('reports no transcript as complete only when there was none at the handoff, and a fresh CLI-written one from byte zero', async () => {
    const fresh = fixture('claude', false)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(fresh.root, 'claude-profile'))
    const got: any[] = []
    fresh.manager.cliToolCalls = (_spec, _native, calls, coverage) => { got.push({ calls, coverage }) }
    await fresh.manager.prepareCli(fresh.spec.id)
    await fresh.manager.finishCli(fresh.spec.id)
    expect(got[0].coverage).toMatchObject({ status: 'complete', reason: 'no-transcript', boundaryBytes: 0 })

    const next = fixture('claude', false)
    const written: any[] = []
    next.manager.cliToolCalls = (_spec, _native, calls, coverage) => { written.push({ calls, coverage }) }
    const prepared = await next.manager.prepareCli(next.spec.id)
    const log = claudeHistoryPath(next.workspace, prepared.nativeSessionId)
    mkdirSync(dirname(log), { recursive: true })
    writeFileSync(log, call(prepared.nativeSessionId, 'first', 0, 800))
    await next.manager.finishCli(next.spec.id)
    expect(written[0].coverage).toMatchObject({ status: 'complete', boundaryBytes: 0 })
    expect(written[0].calls.map((found: any) => found.toolUseId)).toEqual(['toolu_first'])
  })

  it('never lets the recorder side keep the conversation in the CLI view, and does nothing for another provider', async () => {
    const throwing = await handoff(id => call(id, 'chat', 0, 1_000))
    throwing.f.manager.cliToolCalls = () => { throw new Error('recorder broke') }
    appendFileSync(throwing.log, call(throwing.nativeId, 'cli', 60_000, 1_000))
    await expect(throwing.finish()).resolves.toBeUndefined()
    expect(throwing.f.database.structured.snapshot(throwing.f.spec.id)?.view).toBe('visual')
    expect(throwing.f.database.getSetting('cliHandoff:' + throwing.f.spec.id)).toBeNull()

    const codex = fixture('codex')
    const hook = vi.fn()
    codex.manager.cliToolCalls = hook
    await codex.manager.prepareCli(codex.spec.id)
    expect(JSON.parse(codex.database.getSetting('cliHandoff:' + codex.spec.id)!)).not.toHaveProperty('claudeBoundary')
    await codex.manager.finishCli(codex.spec.id)
    expect(hook).not.toHaveBeenCalled()
  })

  it('keeps the one limit it has: a same-size rewrite strictly between the fingerprinted ends of a long prefix is not seen', async () => {
    // 4 KiB at each end are hashed. A prefix longer than 8 KiB changed only in its middle looks unchanged.
    const round = await handoff(id => call(id, 'chat', 0, 1_000) + filler(id, 20_000) + call(id, 'chat2', 9_000, 1_000))
    const original = readFileSync(round.log, 'utf8')
    const middle = original.length >> 1, rewritten = original.slice(0, middle) + 'Z' + original.slice(middle + 1)
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    writeFileSync(round.log, rewritten)
    appendFileSync(round.log, call(round.nativeId, 'cli', 60_000, 1_000))
    await round.finish()
    expect(round.calls[0]!.coverage).toMatchObject({ status: 'complete' })
    expect(ids(round)).toEqual(['toolu_cli'])
  })
})
describe('AgentManager hands a CLI view\'s calls and coverage to the recorder', () => {
  it('forwards the exact conversation, native id, model, calls and coverage, and nothing for an anonymous conversation', () => {
    const f = fixture('claude')
    const importCliTranscript = vi.fn()
    const agents = new AgentManager(f.database, undefined, undefined, undefined, { observe: vi.fn(), importCliTranscript })
    managers.push(agents.structured)
    const spec = { ...f.spec, model: 'claude-opus-5-5' }
    const calls = [{ toolUseId: 'toolu_1', name: 'Bash', input: {}, usedAt: null, resultAt: null, isError: false, denied: null, result: '', notes: [] }]
    const coverage = { status: 'partial' as const, reason: 'window-truncated' as const, boundaryBytes: 10, fileBytes: 99, bytesRead: 50, bytesSkipped: 39, unmatchedCalls: 0, unpairedResults: 2, droppedCalls: 0, handoffId: 'handoff-1' }
    agents.structured.cliToolCalls!(spec, 'native-1', calls, coverage)
    expect(importCliTranscript).toHaveBeenCalledWith({ projectId: spec.projectId, agentSessionId: spec.id, nativeSessionId: 'native-1', model: 'claude-opus-5-5', calls, coverage })
    anonymousConversations.mark(spec.id)
    try { agents.structured.cliToolCalls!(spec, 'native-1', calls, coverage) } finally { anonymousConversations.forget(spec.id) }
    expect(importCliTranscript).toHaveBeenCalledTimes(1)
  })
})
