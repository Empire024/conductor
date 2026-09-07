import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { claudeHistoryPath } from './native-history'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AgentSpec } from '../shared/models'
import { SteeringUnavailableError, type AdapterOptions, type ProviderAdapter } from './providers/adapter'
import type { AdapterEvent, ContextAttachment, InteractionResponse, ProviderCapabilities, SessionSettings } from '../shared/structured-agent'

const settings: SessionSettings = { permission: 'default', plan: false }
const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) { try { manager.dispose() } catch {} }
  for (const db of databases.splice(0)) { try { db.close() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  vi.unstubAllEnvs()
})
class FakeProvider implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: true, plans: true, permissions: ['default', 'accept-edits'], effort: ['low'], models: [], limitations: ['SYNTHETIC zero-inference fixture'] }
  starts = 0
  nativeIdentityOnStart = true
  disposed = false
  submissions: Array<{ text: string; settings: SessionSettings; attachments?: ContextAttachment[] }> = []
  steers: Array<{ text: string; settings: SessionSettings; attachments?: ContextAttachment[] }> = []
  onSteer?: () => Promise<void>
  async steer(text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void> { this.steers.push({ text, settings, attachments }); await this.onSteer?.() }
  responses: InteractionResponse[] = []
  startGate?: Promise<void>
  responseGate?: Promise<void>
  renameGate?: Promise<void>
  onResponse?: (response: InteractionResponse) => Promise<void>
  constructor(readonly options: AdapterOptions) {}
  async start(): Promise<void> { this.starts++; await this.startGate; this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: this.options.nativeSessionId ?? (this.nativeIdentityOnStart ? `native-${this.options.runtimeId}` : undefined) } }) }
  async submit(text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void> { if (this.disposed) throw new Error('Fake runtime disposed'); this.submissions.push({ text, settings, attachments }) }
  async respond(response: InteractionResponse): Promise<void> { this.responses.push(response); await this.responseGate; await this.onResponse?.(response) }
  async interrupt(): Promise<void> { this.emit({ data: { type: 'session', phase: 'interrupted' } }) }
  async fork(): Promise<string> { return `forked-${this.options.nativeSessionId ?? this.options.runtimeId}` }
  async rename(): Promise<void> { await this.renameGate }
  dispose(): void { this.disposed = true }
  emit(event: AdapterEvent): void { this.options.emit(event) }
  finish(): void { this.emit({ data: { type: 'session', phase: 'completed' } }) }
  approval(id = 'request'): void {
    this.emit({ itemId: 'edit', requestId: id, data: { type: 'interaction', interaction: { id, kind: 'approval', title: 'Allow synthetic Edit?', input: { file_path: 'panel.mjs' }, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }], status: 'pending' } } })
    this.emit({ data: { type: 'session', phase: 'waiting_approval' } })
  }
}
function fixture(provider: 'claude' | 'codex' = 'claude', nativeIdentityOnStart = true) {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-session-fixture-')); roots.push(root)
  const workspace = join(root, 'Workspace 日本語 with spaces'); mkdirSync(workspace)
  const databasePath = join(root, 'conductor.db')
  const database = new ConductorDatabase(databasePath); databases.push(database)
  const project = database.upsertProject(workspace, 'Synthetic project')
  const session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'agent-session', projectId: project.id, sessionId: session.id, provider, title: 'Synthetic Claude', cwd: workspace }
  const adapters: FakeProvider[] = [], broadcast = vi.fn()
  let startGate: Promise<void> | undefined
  const factory = (_provider: 'claude' | 'codex', options: AdapterOptions) => { const adapter = new FakeProvider(options); adapter.startGate = startGate; adapter.nativeIdentityOnStart = nativeIdentityOnStart; adapters.push(adapter); return adapter }
  const manager = new StructuredSessions(database, () => 'synthetic-executable', broadcast, factory); managers.push(manager)
  manager.ensure(spec)
  return { root, workspace, databasePath, database, spec, adapters, broadcast, factory, manager, gateStart(gate: Promise<void>) { startGate = gate }, get current() { return adapters.at(-1)! } }
}

describe('backend session ownership and lifecycle — fake provider boundary', () => {
  it('registration and repeated pane subscriptions launch no process; one turn has one backend runtime', async () => {
    const f = fixture()
    for (let i = 0; i < 8; i++) { f.manager.ensure(f.spec); f.database.structured.snapshot(f.spec.id); f.database.structured.events(f.spec.id) }
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.starts, 0)).toBe(0)
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const runtime = f.current
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.starts, 0)).toBe(1)
    for (let i = 0; i < 8; i++) f.manager.ensure(f.spec)
    runtime.emit({ itemId: 'message', data: { type: 'text', role: 'assistant', text: 'Background while hidden', mode: 'delta' } })
    f.manager.flush()
    expect(runtime.submissions).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.items.some((item) => item.data.type === 'text' && item.data.text === 'Background while hidden')).toBe(true)
    expect(f.broadcast.mock.calls.some(([channel]) => channel === 'structured:events')).toBe(true)
    await expect(f.manager.submit(f.spec.id, 'Duplicate', settings)).rejects.toThrow('already active')
  })

  it('claims an approval once across views and rejects a wrong runtime or unsupported scope', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const runtime = f.current; runtime.approval()
    let release!: () => void
    runtime.responseGate = new Promise<void>((resolve) => { release = resolve })
    const response = { sessionId: f.spec.id, runtimeId: runtime.options.runtimeId, requestId: 'request', decision: 'allow' }
    await expect(f.manager.respond({ ...response, runtimeId: 'old-runtime' })).rejects.toThrow('stale')
    await expect(f.manager.respond({ ...response, decision: 'always-allow' })).rejects.toThrow('Unsupported approval scope')
    const first = f.manager.respond(response)
    await expect(f.manager.respond(response)).rejects.toThrow('already submitted')
    expect(runtime.responses).toHaveLength(1)
    release(); await first
    expect(f.database.structured.snapshot(f.spec.id)?.items.find((item) => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'resolved', outcome: 'allow' } })
  })

  it.each(['completed', 'waiting_approval'] as const)('a delayed native rename preserves the latest %s phase', async phase => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Synthetic active turn', settings)
    const runtime = f.current
    let release!: () => void
    runtime.renameGate = new Promise<void>(resolve => { release = resolve })
    const renamed = f.manager.rename(f.spec.id, 'New native title')
    if (phase === 'completed') runtime.finish()
    else runtime.approval()
    release(); await renamed
    expect(f.database.structured.snapshot(f.spec.id)).toMatchObject({ title: 'New native title', phase })
    if (phase === 'completed') {
      await f.manager.submit(f.spec.id, 'Next synthetic turn', settings)
      expect(runtime.submissions).toHaveLength(2)
    } else {
      expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'pending' } })
    }
  })

  it.each(['claude', 'codex'] as const)('invalid %s question answers remain pending and correctable before transport dispatch', async provider => {
    const f = fixture(provider)
    await f.manager.submit(f.spec.id, 'Synthetic question turn', settings)
    const runtime = f.current
    runtime.emit({ itemId: 'question-tool', requestId: 'question-request', data: { type: 'interaction', interaction: {
      id: 'question-request', kind: 'question', title: 'Synthetic question', input: { synthetic: true }, choices: [], status: 'pending',
      questions: [
        { id: 'choice', question: 'Pick a value', options: [{ label: 'Allowed' }], allowCustom: false },
        { id: 'detail', question: 'Give one detail', options: [], allowCustom: true }
      ]
    } } })
    runtime.emit({ data: { type: 'session', phase: 'waiting_input' } })
    const response = { sessionId: f.spec.id, runtimeId: runtime.options.runtimeId, requestId: 'question-request' }
    const invalid: Array<Record<string, string[]>> = [
      {}, { choice: ['Allowed'] }, { choice: ['Allowed'], detail: [] },
      { choice: ['Allowed'], detail: ['   '] }, { choice: ['Allowed'], detail: ['one', 'two'] },
      { choice: ['Unoffered'], detail: ['valid'] },
      { choice: ['Allowed'], detail: ['x'.repeat(provider === 'claude' ? 10_001 : 16_385)] },
      { choice: ['Allowed'], detail: ['valid'], unknown: ['unexpected'] }
    ]
    for (const answers of invalid) {
      await expect(f.manager.respond({ ...response, answers })).rejects.toThrow()
      expect(runtime.responses).toHaveLength(0)
      expect(f.database.structured.snapshot(f.spec.id)).toMatchObject({ phase: 'waiting_input' })
      expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'pending' } })
    }
    const corrected = { ...response, answers: { choice: ['Allowed'], detail: ['Corrected answer'] } }
    await f.manager.respond(corrected)
    expect(runtime.responses).toEqual([corrected])
    expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'resolved', outcome: 'answered' } })
    await expect(f.manager.respond(corrected)).rejects.toThrow('already submitted')
  })

  it('resumes the same native conversation explicitly and ignores stale callbacks from its old incarnation', async () => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'panel.mjs'), 'before\n')
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const previous = f.current
    previous.approval('old-request')
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    await previous.options.beforeTool?.('edit', ['panel.mjs'])
    previous.emit({ data: { type: 'session', phase: 'disconnected' } })
    await expect(f.manager.submit(f.spec.id, 'No silent retry', settings)).rejects.toThrow('Resume')
    await f.manager.resume(f.spec.id)
    const current = f.current
    expect(current).not.toBe(previous)
    expect(current.options.nativeSessionId).toBe(nativeId)
    expect(current.options.runtimeId).not.toBe(previous.options.runtimeId)
    expect(current.submissions).toHaveLength(0)
    const sequence = f.database.structured.snapshot(f.spec.id)!.sequence
    previous.emit({ itemId: 'stale', data: { type: 'text', role: 'assistant', text: 'late stale text', mode: 'delta' } })
    writeFileSync(join(f.workspace, 'panel.mjs'), 'after\n')
    await previous.options.afterTool?.('edit', ['panel.mjs'], true)
    expect(f.database.structured.snapshot(f.spec.id)!.sequence).toBe(sequence)
    await expect(f.manager.respond({ sessionId: f.spec.id, runtimeId: previous.options.runtimeId, requestId: 'old-request', decision: 'allow' })).rejects.toThrow('stale')
    await f.manager.submit(f.spec.id, 'One follow up', settings)
    expect(current.submissions).toHaveLength(1)
    expect(previous.submissions).toHaveLength(1)
  })

  it('does not send a queued prompt when the backend closes during initialization', async () => {
    const f = fixture()
    let release!: () => void
    f.gateStart(new Promise<void>((resolve) => { release = resolve }))
    const submitted = f.manager.submit(f.spec.id, 'Never dispatch after close', settings)
    const rejected = expect(submitted).rejects.toThrow('closed during initialization')
    await vi.waitFor(() => expect(f.current.starts).toBe(1))
    const runtime = f.current
    f.manager.dispose()
    release(); await rejected
    expect(runtime.submissions).toEqual([])
    expect(runtime.disposed).toBe(true)
  })

  it('restores historical UI without launching a runtime or answering prior approvals', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Historical synthetic turn', settings)
    f.current.approval('historical-request')
    f.manager.flush(); f.manager.dispose(); f.database.close()
    const reopened = new ConductorDatabase(f.databasePath); databases.push(reopened)
    const factory = vi.fn((_provider: 'claude' | 'codex', options: AdapterOptions) => new FakeProvider(options))
    const restored = new StructuredSessions(reopened, () => 'synthetic-executable', vi.fn(), factory); managers.push(restored)
    const projection = reopened.structured.snapshot(f.spec.id)
    expect(projection?.phase).toBe('disconnected')
    expect(projection?.items.find((item) => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'expired' } })
    restored.ensure(f.spec)
    expect(factory).not.toHaveBeenCalled()
    expect(reopened.structured.events(f.spec.id).some((entry) => entry.data.type === 'text' && entry.data.role === 'user')).toBe(true)
    await expect(restored.submit(f.spec.id, 'retry', settings)).rejects.toThrow('Resume')
    expect(factory).not.toHaveBeenCalled()
  })

  it('denying preserves bytes, approving edits once, Keep does not reapply, and undo preserves later work', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    const before = 'keep\nremove one\nremove two\nend\n', after = 'keep\nend\n'
    writeFileSync(path, before)
    await f.manager.submit(f.spec.id, 'Synthetic edit', settings)
    const runtime = f.current
    let executions = 0
    runtime.onResponse = async (response) => {
      if (response.decision === 'allow') {
        await runtime.options.beforeTool?.('edit', ['panel.mjs'])
        executions++; writeFileSync(path, after)
        await runtime.options.afterTool?.('edit', ['panel.mjs'], true)
      }
      runtime.finish()
    }
    runtime.approval('deny')
    await f.manager.respond({ sessionId: f.spec.id, runtimeId: runtime.options.runtimeId, requestId: 'deny', decision: 'deny' })
    expect(readFileSync(path, 'utf8')).toBe(before); expect(executions).toBe(0)
    await f.manager.submit(f.spec.id, 'Synthetic approved edit', settings)
    runtime.approval('allow')
    const decision = { sessionId: f.spec.id, runtimeId: runtime.options.runtimeId, requestId: 'allow', decision: 'allow' }
    await f.manager.respond(decision)
    await expect(f.manager.respond(decision)).rejects.toThrow('already submitted')
    expect(executions).toBe(1); expect(readFileSync(path, 'utf8')).toBe(after)
    const changeItem = f.database.structured.snapshot(f.spec.id)!.items.find((item) => item.data.type === 'changes')!
    if (changeItem.data.type !== 'changes') throw new Error('Missing change fixture')
    const change = changeItem.data.changes[0]!
    expect(change).toMatchObject({ additions: 0, deletions: 2, status: 'applied' })
    writeFileSync(path, `${after}later work\n`)
    expect(await f.manager.review(f.spec.id, change.artifactId!, 'keep')).toEqual({ outcome: 'kept' })
    expect(readFileSync(path, 'utf8')).toBe(`${after}later work\n`)
    expect((await f.manager.review(f.spec.id, change.artifactId!, 'undo')).outcome).toBe('conflict')
    expect(readFileSync(path, 'utf8')).toBe(`${after}later work\n`)
  })

  it('keeps simultaneous sessions independent and rejects workspace rebinding and unsafe file context', async () => {
    const f = fixture(), second = { ...f.spec, id: 'second-session' }
    f.manager.ensure(second)
    await Promise.all([f.manager.submit(f.spec.id, 'first', settings), f.manager.submit(second.id, 'second', settings)])
    const live = f.adapters.filter((adapter) => adapter.starts > 0)
    expect(live).toHaveLength(2)
    expect(new Set(live.map((adapter) => adapter.options.runtimeId)).size).toBe(2)
    expect(live.flatMap((adapter) => adapter.submissions.map((submission) => submission.text)).sort()).toEqual(['first', 'second'])
    expect(() => f.manager.ensure({ ...f.spec, provider: 'codex' })).toThrow('rebound')
    live.forEach((adapter) => adapter.finish())
    await expect(f.manager.submit(f.spec.id, 'bad context', settings, [{ id: 'bad', kind: 'file', name: 'outside', path: '../conductor.db' }])).rejects.toThrow('outside')
    await expect(f.manager.submit(f.spec.id, 'unsupported', { ...settings, permission: 'read-only' })).rejects.toThrow('unsupported')
  })

  it('submits exact selected context while keeping expanded file bytes outside the visible message', async () => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'context.txt'), 'saved content\n')
    await f.manager.submit(f.spec.id, 'Inspect selected context', settings, [
      { id: 'file', kind: 'file', name: 'context.txt', path: 'context.txt' },
      { id: 'editor', kind: 'editor', name: 'context.txt (unsaved)', path: 'context.txt', content: 'unsaved content\n' },
      { id: 'selection', kind: 'selection', name: 'selected lines', path: 'context.txt', content: 'selected', startLine: 2, endLine: 3 }
    ])
    const submitted = f.current.submissions[0]!.text
    expect(submitted).toContain('saved content'); expect(submitted).toContain('unsaved content'); expect(submitted).toContain('lines 2-3')
    const user = f.database.structured.snapshot(f.spec.id)?.items.find((item) => item.data.type === 'text' && item.data.role === 'user')
    expect(user?.data).toMatchObject({ text: 'Inspect selected context', attachments: [{ id: 'file', name: 'context.txt' }, { id: 'editor', name: 'context.txt (unsaved)' }, { id: 'selection', startLine: 2, endLine: 3 }] })
    expect(JSON.stringify(user?.data)).not.toContain('saved content')
    expect(JSON.stringify(user?.data)).not.toContain('[Attached')
  })

  it('forks native context and copies immutable historical artifacts without an inference submission', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, 'before\n')
    await f.manager.submit(f.spec.id, 'Synthetic fork origin', settings)
    await f.current.options.beforeTool?.('edit', ['panel.mjs'])
    writeFileSync(path, 'after\n')
    await f.current.options.afterTool?.('edit', ['panel.mjs'], true)
    f.current.finish()
    const totalPrompts = f.adapters.reduce((sum, adapter) => sum + adapter.submissions.length, 0)
    const forkId = await f.manager.fork(f.spec.id)
    const fork = f.database.structured.snapshot(forkId)!
    expect(fork.nativeSessionId).toContain('forked-')
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.submissions.length, 0)).toBe(totalPrompts)
    const changeItem = fork.items.find((item) => item.data.type === 'changes')!
    if (changeItem.data.type !== 'changes') throw new Error('Missing forked artifact')
    const artifact = f.database.structured.artifact(forkId, changeItem.data.changes[0]!.artifactId!)
    expect(artifact).toMatchObject({ sessionId: forkId, before: 'before\n', after: 'after\n' })
  })

  it('preserves native history and immutable review after an authorized project folder relocation', async () => {
    const f = fixture(), path = join(f.workspace, 'panel.mjs')
    writeFileSync(path, 'before move\n')
    await f.manager.submit(f.spec.id, 'Synthetic before project move', settings)
    const original = f.current
    await original.options.beforeTool?.('edit', ['panel.mjs'])
    writeFileSync(path, 'after edit\n')
    await original.options.afterTool?.('edit', ['panel.mjs'], true)
    original.finish()
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    f.manager.killWhere((spec) => spec.projectId === f.spec.projectId)
    const relocated = join(f.root, 'Relocated 日本語 workspace')
    expect(f.workspace.startsWith(f.root)).toBe(true)
    expect(relocated.startsWith(f.root)).toBe(true)
    renameSync(f.workspace, relocated)
    f.database.updateProjectLocation(f.spec.projectId, relocated, 'Renamed synthetic project')
    const relocatedSpec = f.database.structured.spec<AgentSpec>(f.spec.id)!
    expect(relocatedSpec.cwd).toBe(relocated)
    f.manager.ensure(relocatedSpec)
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.starts, 0)).toBe(1)
    await f.manager.resume(f.spec.id)
    expect(f.current.options).toMatchObject({ cwd: relocated, nativeSessionId: nativeId })
    expect(f.current.submissions).toEqual([])
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.starts, 0)).toBe(2)
    const changeItem = f.database.structured.snapshot(f.spec.id)!.items.find((item) => item.data.type === 'changes')!
    if (changeItem.data.type !== 'changes') throw new Error('Missing relocated artifact')
    const artifactId = changeItem.data.changes[0]!.artifactId!
    expect(await f.manager.review(f.spec.id, artifactId, 'undo')).toEqual({ outcome: 'reverted' })
    expect(readFileSync(join(relocated, 'panel.mjs'), 'utf8')).toBe('before move\n')
  })

  it('preserves legacy terminal history once as inspectable output without inferring a native session or starting a process', () => {
    const f = fixture(), legacy = { ...f.spec, id: 'legacy-terminal-session' }
    f.database.upsertAgent(legacy, 'idle')
    f.database.appendAgentTranscript(legacy.id, 'Synthetic old terminal output\r\nNo native identity was recorded.\r\n')
    f.manager.ensure(legacy); f.manager.ensure(legacy)
    const snapshot = f.database.structured.snapshot(legacy.id)!
    expect(snapshot.nativeSessionId).toBeUndefined()
    const notices = snapshot.items.filter((item) => item.data.type === 'notice')
    expect(notices).toHaveLength(1)
    const notice = notices[0]!.data
    if (notice.type !== 'notice' || !notice.outputArtifactId) throw new Error('Missing preserved terminal artifact')
    expect(f.database.structured.output(legacy.id, notice.outputArtifactId)).toBe(f.database.getAgentTranscript(legacy.id))
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.starts, 0)).toBe(0)
  })

  it('applies first-turn effort through the existing initialized Claude connection', async () => {
    const f = fixture('claude', false)
    await f.manager.connectSession(f.spec.id)
    const original = f.current, selected = { ...settings, effort: 'low' }
    await f.manager.submit(f.spec.id, 'First effort-selected synthetic turn', selected)
    expect(f.current).toBe(original)
    expect(original.disposed).toBe(false)
    expect(original.submissions).toEqual([{ text: 'First effort-selected synthetic turn', settings: selected, attachments: [] }])
    expect(f.adapters.reduce((sum, adapter) => sum + adapter.starts, 0)).toBe(1)
  })
  it('does not change runtime settings when context validation fails', async () => {
    const f = fixture('claude', false)
    await f.manager.connectSession(f.spec.id)
    const original = f.current
    await expect(f.manager.submit(f.spec.id, 'Invalid context', { ...settings, effort: 'low' }, [
      { id: 'outside', kind: 'file', name: 'outside', path: '../conductor.db' }
    ])).rejects.toThrow('outside')
    expect(original.disposed).toBe(false)
    expect(original.submissions).toEqual([])
    expect(f.database.structured.snapshot(f.spec.id)?.settings.effort).toBeUndefined()
  })
  it('keeps native identity arriving during context preparation when changing effort', async () => {
    const f = fixture('claude', false)
    writeFileSync(join(f.workspace, 'context.txt'), 'Synthetic context')
    await f.manager.connectSession(f.spec.id)
    const original = f.current
    const submitted = f.manager.submit(f.spec.id, 'Preserve current context', { ...settings, effort: 'low' }, [{ id: 'context', kind: 'file', name: 'context.txt', path: 'context.txt' }])
    original.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-arrived-during-context-read' } })
    await submitted
    expect(f.current).toBe(original)
    expect(original.disposed).toBe(false)
    expect(original.submissions).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.nativeSessionId).toBe('native-arrived-during-context-read')
  })
  it('applies each queued effort to the same native Claude conversation', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original turn', settings)
    const original = f.current, nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    await f.manager.queue(f.spec.id, 'Low effort followup', { ...settings, effort: 'low' })
    await f.manager.queue(f.spec.id, 'Inherited effort followup', settings)
    original.finish()
    await vi.waitFor(() => expect(original.submissions).toHaveLength(2))
    original.finish()
    await vi.waitFor(() => expect(original.submissions).toHaveLength(3))
    expect(original.submissions.map(submission => submission.settings.effort)).toEqual([undefined, 'low', undefined])
    expect(f.current).toBe(original)
    expect(original.disposed).toBe(false)
    expect(f.database.structured.snapshot(f.spec.id)?.nativeSessionId).toBe(nativeId)
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toEqual([])
  })

})

describe('queued messages and native CLI handoff', () => {
  it('restores an interrupted queue after restart without submitting it', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'active', settings)
    await f.manager.queue(f.spec.id, 'durable queued text', settings)
    f.manager.dispose()
    const restarted = new StructuredSessions(f.database, () => 'synthetic-executable', f.broadcast, f.factory)
    managers.push(restarted); restarted.ensure(f.spec)
    expect(f.database.structured.snapshot(f.spec.id)?.queued?.text).toBe('durable queued text')
    expect(f.adapters.reduce((count, adapter) => count + adapter.submissions.length, 0)).toBe(1)
    expect(restarted.cancelQueued(f.spec.id)?.text).toBe('durable queued text')
  })
  it('imports only the CLI portion of Claude history after returning to Chat', async () => {
    const f = fixture('claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(f.root, 'claude-profile'))
    await f.manager.submit(f.spec.id, 'existing conversation', settings); f.current.finish()
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId!
    const log = claudeHistoryPath(f.workspace, nativeId)
    mkdirSync(dirname(log), { recursive: true })
    const row = (uuid: string, type: string, content: unknown) => JSON.stringify({ uuid, type, sessionId: nativeId, message: { content } }) + '\n'
    const original = row('before', 'user', 'existing conversation')
    writeFileSync(log, original)
    await f.manager.prepareCli(f.spec.id)
    writeFileSync(log, original + row('cli-user', 'user', 'native CLI question') + row('cli-answer', 'assistant', [{ type: 'text', text: 'native CLI answer' }]) + row('cli-tool', 'assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'file.ts' } }]) + row('cli-result', 'user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }]))
    await f.manager.finishCli(f.spec.id)
    await f.manager.finishCli(f.spec.id)
    const state = f.database.structured.snapshot(f.spec.id)!
    const texts = state.items.flatMap(item => item.data.type === 'text' ? [item.data.text] : [])
    expect(texts.filter(text => text === 'existing conversation')).toHaveLength(1)
    expect(texts.filter(text => text === 'native CLI answer')).toHaveLength(1)
    expect(texts).toContain('native CLI question')
    expect(state.items.some(item => item.data.type === 'tool' && item.data.status === 'completed' && item.data.output === 'file content')).toBe(true)
    expect(state.nativeSessionId).toBe(nativeId)
  })
  it('owns a queued message across views and dispatches it exactly once after completion', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'first', settings)
    await f.manager.queue(f.spec.id, 'second', settings)
    expect(f.database.structured.snapshot(f.spec.id)?.queued?.text).toBe('second')
    await f.manager.queue(f.spec.id, 'third', settings)
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts?.map(prompt => prompt.text)).toEqual(['second', 'third'])
    f.current.finish()
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.submissions.map((item) => item.text)).toEqual(['first', 'second'])
    expect(f.database.structured.snapshot(f.spec.id)?.queued?.text).toBe('third')
    f.current.finish()
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(3))
    expect(f.current.submissions.map(item => item.text)).toEqual(['first', 'second', 'third'])
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeNull()
  })
  it('captures file contents when queued and removes a selected message without dropping its neighbors', async () => {
    const f = fixture(), path = join(f.workspace, 'queued.txt')
    writeFileSync(path, 'original queued bytes')
    await f.manager.submit(f.spec.id, 'active', settings)
    await Promise.all([
      f.manager.queue(f.spec.id, 'first followup', settings, [{ id: 'file', kind: 'file', name: 'queued.txt', path: 'queued.txt' }]),
      f.manager.queue(f.spec.id, 'remove this', settings),
      f.manager.queue(f.spec.id, 'last followup', settings)
    ])
    const prompts = f.database.structured.snapshot(f.spec.id)!.queuedPrompts!
    expect(prompts.map(prompt => prompt.text)).toEqual(['first followup', 'remove this', 'last followup'])
    expect(f.manager.cancelQueued(f.spec.id, prompts[1]!.id)?.text).toBe('remove this')
    expect(f.database.structured.snapshot(f.spec.id)!.queuedPrompts!.map(prompt => prompt.text)).toEqual(['first followup', 'last followup'])
    writeFileSync(path, 'changed disk bytes')
    f.current.finish()
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.submissions[1]!.text).toContain('original queued bytes')
    expect(f.current.submissions[1]!.text).not.toContain('changed disk bytes')
  })
  it('keeps a queued message through interruption and returns its exact context when removed', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'first', settings)
    await f.manager.queue(f.spec.id, 'queued', settings, [{ id: 'context', kind: 'selection', name: 'selection', content: 'exact text' }])
    await f.manager.interrupt(f.spec.id)
    expect(f.current.submissions).toHaveLength(1)
    const queued = f.manager.cancelQueued(f.spec.id)!
    expect(queued.text).toBe('queued')
    expect(queued.attachments[0]?.content).toBe('exact text')
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeNull()
  })
  it('does not replace conversation identity when moving between Chat and CLI', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'existing conversation', settings); f.current.finish()
    const original = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    const previous = f.current
    const handoff = await f.manager.prepareCli(f.spec.id)
    expect(handoff.nativeSessionId).toBe(original)
    expect(previous.disposed).toBe(true)
    expect(f.database.structured.snapshot(f.spec.id)?.view).toBe('cli')
    await expect(f.manager.submit(f.spec.id, 'wrong view', settings)).rejects.toThrow('CLI')
    await expect(f.manager.connectSession(f.spec.id)).rejects.toThrow('CLI')
    await f.manager.finishCli(f.spec.id)
    expect(f.current.options.nativeSessionId).toBe(original)
    expect(f.database.structured.snapshot(f.spec.id)?.view).toBe('visual')
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter((item) => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(1)
  })
  it('rejects CLI handoff while a turn or queued prompt owns execution', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'active', settings)
    await expect(f.manager.prepareCli(f.spec.id)).rejects.toThrow('Finish or stop')
    expect(f.current.disposed).toBe(false)
  })
  it('allocates one Claude native ID before a new CLI conversation and reuses it in Chat', async () => {
    const f = fixture('claude', false)
    const handoff = await f.manager.prepareCli(f.spec.id)
    expect(handoff.fresh).toBe(true)
    expect(handoff.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/)
    await f.manager.finishCli(f.spec.id)
    expect(f.current.options.nativeSessionId).toBe(handoff.nativeSessionId)
    expect(f.current.options.newNativeSession).toBe(true)
  })
})

describe('empty native conversation handoff', () => {
  it('saves the existing title before reading an empty Codex history', async () => {
    const f = fixture('codex')
    await f.manager.connectSession(f.spec.id)
    const rename = vi.spyOn(f.current, 'rename')
    const history = vi.fn(async () => { expect(rename).toHaveBeenCalledWith(f.spec.title); return [] })
    Object.assign(f.current, { history })
    const original = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    await expect(f.manager.prepareCli(f.spec.id)).resolves.toMatchObject({ nativeSessionId: original })
    expect(history).toHaveBeenCalledOnce()
    f.manager.cancelCli(f.spec.id)
    expect(f.database.structured.snapshot(f.spec.id)).toMatchObject({ view: 'visual', nativeSessionId: original, phase: 'disconnected' })
    expect(f.database.getSetting('cliHandoff:' + f.spec.id)).toBeNull()
  })
})


describe('mid-turn steering and input retention', () => {
  it.each(['running', 'waiting_input', 'waiting_approval'] as const)('dispatches immediately inside a %s turn, keeping explicit queue entries intact', async phase => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = true
    f.current.emit({ turnId: 'active-turn', data: { type: 'session', phase, capabilities: f.current.capabilities } })
    await f.manager.queue(f.spec.id, 'Explicitly queued', settings)
    await f.manager.steer(f.spec.id, 'More data', settings, [{ id: 'selection', kind: 'selection', name: 'Selected lines', content: 'Exact context' }])
    expect(f.current.steers).toEqual([{ text: expect.stringContaining('More data'), settings, attachments: [] }])
    expect(f.current.steers[0]?.text).toContain('Exact context')
    expect(f.current.submissions).toHaveLength(1)
    const state = f.database.structured.snapshot(f.spec.id)
    expect(state?.phase).toBe(phase)
    expect(state?.queuedPrompts?.map(prompt => prompt.text)).toEqual(['Explicitly queued'])
    expect(state?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(2)
    expect(state?.items.at(-1)).toMatchObject({ turnId: 'active-turn', data: { type: 'text', role: 'user', text: 'More data', attachments: [{ id: 'selection' }] } })
    expect(JSON.stringify(state?.items.at(-1))).not.toContain('Exact context')
  })

  it.each(['unsupported', 'stale expectedTurnId', 'review', 'compact'])('queues a definite %s refusal without losing text or captured attachments', async refusal => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'context.txt'), 'Captured bytes')
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = refusal !== 'unsupported'
    f.current.onSteer = async () => { writeFileSync(join(f.workspace, 'context.txt'), 'Later bytes'); throw new SteeringUnavailableError(refusal) }
    const attachments: ContextAttachment[] = [{ id: 'file', kind: 'file', name: 'context.txt', path: 'context.txt' }]
    await f.manager.steer(f.spec.id, 'Keep my text', settings, attachments)
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toMatchObject({ text: 'Keep my text', attachments: [{ content: 'Captured bytes' }] })
    expect(attachments[0]?.content).toBeUndefined()
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.items.at(-1)?.data).toMatchObject({ type: 'notice', message: expect.stringContaining('queued instead of steered') })
    f.current.finish()
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.submissions[1]?.text).toContain('Captured bytes')
    expect(f.current.submissions[1]?.text).not.toContain('Later bytes')
  })

  it('queues when a turn completes during attachment capture and dispatches once as the next turn', async () => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'context.txt'), 'Captured bytes')
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = true
    const steering = f.manager.steer(f.spec.id, 'Next turn', settings, [{ id: 'file', kind: 'file', name: 'context.txt', path: 'context.txt' }])
    f.current.finish()
    await steering
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.steers).toHaveLength(0)
    expect(f.current.submissions[1]?.text).toContain('Next turn')
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeNull()
  })

  it('retains ordering across a pending steer and explicit queue insertion', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = true
    let release = () => {}
    f.current.onSteer = () => new Promise<void>((_resolve, reject) => { release = () => reject(new SteeringUnavailableError('stale expectedTurnId')) })
    const first = f.manager.steer(f.spec.id, 'First', settings)
    await vi.waitFor(() => expect(f.current.steers).toHaveLength(1))
    const second = f.manager.queue(f.spec.id, 'Second', settings)
    release(); await Promise.all([first, second])
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts?.map(prompt => prompt.text)).toEqual(['First', 'Second'])
  })

  it('never claims delivery while the provider acknowledgement is pending', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = true
    f.current.emit({ turnId: 'original-turn', data: { type: 'session', phase: 'running' } })
    let release = () => {}
    f.current.onSteer = () => new Promise<void>(resolve => { release = resolve })
    const steering = f.manager.steer(f.spec.id, 'Delayed acknowledgement', settings)
    await vi.waitFor(() => expect(f.current.steers).toHaveLength(1))
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(1)
    f.current.finish()
    await expect(f.manager.resume(f.spec.id)).rejects.toThrow('active work')
    release(); await steering
    expect(f.database.structured.snapshot(f.spec.id)?.phase).toBe('completed')
    expect(f.database.structured.snapshot(f.spec.id)?.items.at(-1)).toMatchObject({ turnId: 'original-turn', data: { text: 'Delayed acknowledgement' } })
  })

  it.each(['acknowledgement timed out', 'stdin write failed'])('returns a %s error to the composer without queueing or recording success', async message => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = true
    f.current.onSteer = async () => { throw new Error(message) }
    await expect(f.manager.steer(f.spec.id, 'Keep my draft', settings)).rejects.toThrow('your draft was kept')
    expect(f.current.steers).toHaveLength(1)
    expect(f.current.submissions).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeFalsy()
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(1)
  })

  it.each(['closed', 'cli', 'interrupted', 'swap'])('preserves the draft when %s wins the attachment capture race', async race => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'context.txt'), 'Captured bytes')
    await f.manager.submit(f.spec.id, 'Original', settings)
    const original = f.current
    original.capabilities.steering = true
    const steering = f.manager.steer(f.spec.id, 'Keep my draft', settings, [{ id: 'file', kind: 'file', name: 'context.txt', path: 'context.txt' }])
    const rejected = expect(steering).rejects.toThrow('draft was kept')
    if (race === 'closed' || race === 'swap') f.manager.killWhere(spec => spec.id === f.spec.id)
    if (race === 'cli') f.database.setSetting('cliHandoff:' + f.spec.id, '{}')
    if (race === 'interrupted') await f.manager.interrupt(f.spec.id)
    if (race === 'swap') await f.manager.resume(f.spec.id)
    await rejected
    expect(original.steers).toHaveLength(0)
    expect(f.current.steers).toHaveLength(0)
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeFalsy()
  })

  it('rejects invalid input and queue overflow so the composer keeps the original draft', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    await expect(f.manager.steer(f.spec.id, '', settings)).rejects.toThrow('Prompt must contain')
    await expect(f.manager.steer(f.spec.id, 'Keep my draft', settings, [{ id: 'file', kind: 'file', name: 'missing.txt', path: 'missing.txt' }])).rejects.toThrow()
    for (let index = 0; index < 100; index++) await f.manager.queue(f.spec.id, 'Queued ' + index, settings)
    await expect(f.manager.steer(f.spec.id, 'Keep my draft', settings)).rejects.toThrow('queue is full')
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toHaveLength(100)
    expect(f.current.steers).toHaveLength(0)
  })
})
