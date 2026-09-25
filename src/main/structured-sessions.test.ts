import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { claudeHistoryPath } from './native-history'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import type { AgentSpec } from '../shared/models'
import type { StructuredProvider } from '../shared/structured-agent'
import { InteractionResponseRejectedError, SteeringUnavailableError, type AdapterOptions, type ProviderAdapter } from './providers/adapter'
import type { AdapterEvent, ContextAttachment, InteractionResponse, PromptOrigin, ProviderCapabilities, SessionSettings } from '../shared/structured-agent'
import { MAX_PROMPT_CHARS } from '../shared/structured-agent'
import { LocalSetupError } from './providers/local'
import { LOCAL_MODEL_SETUP_ERROR_CODE, LOCAL_MODEL_SETUP_URL } from '../shared/local-models'
import { composeLocalPrompt, LOCAL_BACKGROUND_OPEN, splitLocalPrompt } from './local-models/briefing'

const settings: SessionSettings = { permission: 'default', plan: false }
const remoteOrigin = (projectId: string): PromptOrigin => ({
  agentSessionId: 'remote-controller',
  label: 'Remote owner',
  authority: { kind: 'remote-peer', peerId: 'trusted-peer', projectId }
})
const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) { try { manager.dispose() } catch {} }
  for (const db of databases.splice(0)) { try { db.close() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  vi.unstubAllEnvs()
  vi.useRealTimers()
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
  autoDeliver = true
  steerIds: string[] = []
  async steer(text: string, settings: SessionSettings, attachments?: ContextAttachment[], inputId = 'fixture-input'): Promise<void> { this.steers.push({ text, settings, attachments }); this.steerIds.push(inputId); await this.onSteer?.(); if (this.autoDeliver) this.emit({ data: { type: 'input_delivery', inputId, status: 'delivered' } }) }
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
  /** Work the runtime backgrounded and will wake this conversation for; only the live process
   *  can answer, exactly as the real adapters report it. */
  background = 0
  backgroundWork(): number { return this.background }
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
function fixture(provider: 'claude' | 'codex' = 'claude', nativeIdentityOnStart = true, mcp?: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }, permissions?: ProviderCapabilities['permissions']) {
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
  const factory = (_provider: StructuredProvider, options: AdapterOptions) => { const adapter = new FakeProvider(options); if (permissions) adapter.capabilities.permissions = permissions; adapter.startGate = startGate; adapter.nativeIdentityOnStart = nativeIdentityOnStart; adapters.push(adapter); return adapter }
  const manager = new StructuredSessions(database, () => 'synthetic-executable', broadcast, factory, undefined, undefined, mcp); managers.push(manager)
  manager.ensure(spec)
  return { root, workspace, databasePath, database, spec, adapters, broadcast, factory, manager, gateStart(gate: Promise<void>) { startGate = gate }, get current() { return adapters.at(-1)! } }
}

describe('internal local adapter availability', () => {
  it('enforces stronger review before owner IPC can answer and never retries uncertain delivery', async () => {
    const f = fixture()
    let release!: (value: import('./approval-review').ReviewResult) => void, digest = ''
    f.manager.setApprovalReviewRouting({ enabled: () => true, supportsExactExecution: () => true,
      authorization: () => ({ id: 'owner-task', text: 'Owner authorized this workspace file write' }),
      run: async (_spec, _action, value) => { digest = value; return new Promise(resolve => { release = resolve }) } })
    await f.manager.submit(f.spec.id, 'Write panel.mjs', settings)
    const request = (id: string): AdapterEvent => ({ requestId: id, itemId: 'write-' + id,
      data: { type: 'interaction', interaction: { id, kind: 'approval', status: 'pending', title: 'Write?', input: { file_path: 'panel.mjs', content: 'one' }, choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] } },
      native: { method: 'can_use_tool', payload: { tool_name: 'Write', subtype: 'can_use_tool', input: { file_path: 'panel.mjs', content: 'one' } } } })
    f.current.emit(request('first'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.current.onResponse = async () => { throw new Error('Transport timed out after possible delivery') }
    release({ digest, decision: 'allow', rationale: 'Authorized fixture', reviewerId: 'reviewer', model: 'claude-opus-fixture', turnId: 'review-turn' })
    await vi.waitFor(() => expect(f.current.responses).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 10))
    f.current.emit(request('replacement'))
    await vi.waitFor(() => expect(f.database.structured.snapshot(f.spec.id)!.items.some(item => item.data.type === 'interaction' && item.data.interaction.id === 'replacement' && item.data.interaction.review?.phase === 'blocked')).toBe(true))
    expect(f.current.responses).toHaveLength(1)
  })
  it('lets the owner answer a request the stronger review is still considering, and drops the late reviewer result', async () => {
    const f = fixture()
    let release!: (value: import('./approval-review').ReviewResult) => void, digest = ''
    f.manager.setApprovalReviewRouting({ enabled: () => true, supportsExactExecution: () => true,
      authorization: () => ({ id: 'owner-task', text: 'Owner authorized this workspace file write' }),
      run: async (_spec, _action, value) => { digest = value; return new Promise(resolve => { release = resolve }) } })
    await f.manager.submit(f.spec.id, 'Write panel.mjs', settings)
    f.current.emit({ requestId: 'first', itemId: 'write-first',
      data: { type: 'interaction', interaction: { id: 'first', kind: 'approval', status: 'pending', title: 'Write?', input: { file_path: 'panel.mjs', content: 'one' }, choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] } },
      native: { method: 'can_use_tool', payload: { tool_name: 'Write', subtype: 'can_use_tool', input: { file_path: 'panel.mjs', content: 'one' } } } })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const runtimeId = f.database.structured.snapshot(f.spec.id)!.runtimeId!
    await f.manager.respond({ sessionId: f.spec.id, runtimeId, requestId: 'first', decision: 'allow' })
    expect(f.current.responses).toHaveLength(1)
    release({ digest, decision: 'deny', rationale: 'Too late', reviewerId: 'reviewer', model: 'claude-opus-fixture', turnId: 'review-turn' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.current.responses).toHaveLength(1)
    const item = f.database.structured.snapshot(f.spec.id)!.items.find(item => item.data.type === 'interaction' && item.data.interaction.id === 'first')
    expect(item?.data.type === 'interaction' ? item.data.interaction.status : 'missing').toBe('resolved')
  })
  it('reaches actionable local setup when no external executable or local config exists', async () => {
    const f = fixture()
    const localSpec: AgentSpec = { ...f.spec, id: 'local-session', provider: 'local', title: 'Local model' }
    const factory = vi.fn((_provider: StructuredProvider, options: AdapterOptions) => {
      const adapter = new FakeProvider(options)
      adapter.start = async () => { throw new LocalSetupError('Local models are not configured.') }
      return adapter
    })
    const manager = new StructuredSessions(f.database, () => null, f.broadcast, factory)
    managers.push(manager)

    expect(manager.ensure(localSpec)).toMatchObject({ available: true, status: 'running', executable: undefined, message: undefined })
    await expect(manager.submit(localSpec.id, 'Use the local model', settings)).rejects.toMatchObject({ code: LOCAL_MODEL_SETUP_ERROR_CODE, actionUrl: LOCAL_MODEL_SETUP_URL })

    const setupError = f.database.structured.snapshot(localSpec.id)?.items
      .map(item => item.data)
      .find(data => data.type === 'error')
    expect(setupError).toMatchObject({
      type: 'error',
      code: LOCAL_MODEL_SETUP_ERROR_CODE,
      message: expect.stringContaining(LOCAL_MODEL_SETUP_URL)
    })
    expect(factory).toHaveBeenCalledWith('local', expect.objectContaining({ executable: '' }))
  })
})

describe('backend session ownership and lifecycle — fake provider boundary', () => {
  it.each(['claude', 'codex'] as const)('configures the project browser for %s unless the owner switched it off', async provider => {
    const mcp = { configure: vi.fn(() => 'private-browser-config.json'), release: vi.fn() }
    const enabled = fixture(provider, true, mcp)
    await enabled.manager.submit(enabled.spec.id, 'With browser', enabled.database.structured.snapshot(enabled.spec.id)!.settings)
    expect(enabled.current.options.mcpConfig).toBe('private-browser-config.json')
    expect(mcp.configure).toHaveBeenCalledWith(enabled.spec)
    mcp.configure.mockClear()

    const disabled = fixture(provider, true, mcp)
    disabled.manager.saveSettings(disabled.spec.id, settings)
    mcp.configure.mockClear()
    await disabled.manager.submit(disabled.spec.id, 'Without browser', settings)
    expect(disabled.current.options.mcpConfig).toBe('')
    expect(mcp.configure).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)('hands every %s launch the conductor-local tools, browser or not, and releases them on close', async provider => {
    const localAssist = { configure: vi.fn(() => 'local-assist-config.json'), release: vi.fn() }
    const f = fixture(provider, true)
    f.manager.setLocalAssist(localAssist)
    f.manager.saveSettings(f.spec.id, settings)
    await f.manager.submit(f.spec.id, 'Run the tests', settings)
    expect(f.current.options.localAssistMcpConfig).toBe('local-assist-config.json')
    expect(f.current.options.mcpConfig).toBe('')
    expect(localAssist.configure).toHaveBeenCalledWith(f.spec)
    f.manager.killWhere(() => true)
    expect(localAssist.release).toHaveBeenCalledWith(f.spec.id)
  })

  it.each(['claude', 'codex'] as const)('reconnects the same idle native %s conversation when browser tools change', async provider => {
    const mcp = { configure: vi.fn(() => 'private-browser-config.json'), release: vi.fn() }
    const f = fixture(provider, true, mcp)
    await f.manager.connectSession(f.spec.id)
    const enabled = f.current
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    expect(enabled.options.mcpConfig).toBe('private-browser-config.json')

    f.manager.saveSettings(f.spec.id, settings)
    expect(enabled.disposed).toBe(true)
    expect(mcp.release).toHaveBeenCalledWith(f.spec.id)
    expect(f.database.structured.snapshot(f.spec.id)?.phase).toBe('disconnected')
    await f.manager.submit(f.spec.id, 'Browser-disabled turn', settings)
    const disabled = f.current
    expect(disabled).not.toBe(enabled)
    expect(disabled.options.nativeSessionId).toBe(nativeId)
    expect(disabled.options.mcpConfig).toBe('')
    disabled.finish()

    f.manager.saveSettings(f.spec.id, { ...settings, browserMcp: true })
    expect(disabled.disposed).toBe(true)
    await f.manager.submit(f.spec.id, 'Browser-enabled turn', { ...settings, browserMcp: true })
    expect(f.current.options.nativeSessionId).toBe(nativeId)
    expect(f.current.options.mcpConfig).toBe('private-browser-config.json')
  })

  it.each(['claude', 'codex'] as const)('revokes browser access during an active %s turn and refreshes before the next turn', async provider => {
    const mcp = { configure: vi.fn(() => 'private-browser-config.json'), release: vi.fn() }
    const f = fixture(provider, true, mcp)
    f.manager.saveSettings(f.spec.id, { ...settings, browserMcp: true })
    await f.manager.submit(f.spec.id, 'Active browser turn', { ...settings, browserMcp: true })
    const activeRuntime = f.current
    f.manager.saveSettings(f.spec.id, settings)
    expect(mcp.release).toHaveBeenCalledWith(f.spec.id)
    expect(activeRuntime.disposed).toBe(false)
    activeRuntime.finish()
    await f.manager.submit(f.spec.id, 'Next turn without browser', settings)
    expect(activeRuntime.disposed).toBe(true)
    expect(f.current.options.nativeSessionId).toBe(activeRuntime.options.nativeSessionId ?? 'native-' + activeRuntime.options.runtimeId)
    expect(f.current.options.mcpConfig).toBe('')
  })

  it.each(['claude', 'codex'] as const)('keeps a newer browser revocation when an older queued %s message drains', async provider => {
    const mcp = { configure: vi.fn(() => 'private-browser-config.json'), release: vi.fn() }
    const f = fixture(provider, true, mcp)
    const enabled = { ...settings, browserMcp: true }
    f.manager.saveSettings(f.spec.id, enabled)
    await f.manager.submit(f.spec.id, 'Active browser turn', enabled)
    const firstRuntime = f.current
    await f.manager.queue(f.spec.id, 'Captured while enabled', enabled)

    f.manager.saveSettings(f.spec.id, settings)
    firstRuntime.finish()
    await vi.waitFor(() => expect(f.adapters.flatMap(adapter => adapter.submissions)).toHaveLength(2))

    expect(f.database.structured.snapshot(f.spec.id)?.settings.browserMcp).toBeUndefined()
    expect(f.adapters.flatMap(adapter => adapter.submissions).at(-1)?.settings.browserMcp).toBeUndefined()
    expect(f.current.options.mcpConfig).toBe('')
  })

  it.each(['claude', 'codex'] as const)('opens every new %s conversation with browser tools on until the owner switches them off, whoever opens it', async provider => {
    const mcp = { configure: vi.fn(() => 'private-browser-config.json'), release: vi.fn() }
    const f = fixture(provider, true, mcp)
    // On by default, so the first connection is configured with the browser.
    expect(f.database.structured.snapshot(f.spec.id)?.settings.browserMcp).toBe(true)
    await f.manager.submit(f.spec.id, 'Opens with the browser', f.database.structured.snapshot(f.spec.id)!.settings)
    expect(f.current.options.mcpConfig).toBe('private-browser-config.json')
    f.current.finish()
    // A local model never gets a browser.
    const local: AgentSpec = { ...f.spec, id: 'local-session', provider: 'local', title: 'Local' }
    f.manager.ensure(local)
    expect(f.database.structured.snapshot(local.id)?.settings.browserMcp).toBeUndefined()
    // Switching it off is the new default for this provider's next conversations, and only this provider's.
    f.manager.saveSettings(f.spec.id, settings)
    const next: AgentSpec = { ...f.spec, id: 'next-session', title: 'Next' }
    f.manager.ensure(next)
    expect(f.database.structured.snapshot(next.id)?.settings.browserMcp).toBeUndefined()
    const other: AgentSpec = { ...f.spec, id: 'other-provider', provider: provider === 'claude' ? 'codex' : 'claude', title: 'Other' }
    f.manager.ensure(other)
    expect(f.database.structured.snapshot(other.id)?.settings.browserMcp).toBe(true)
    // Switching it back on is remembered the same way; existing conversations keep their own choice.
    f.manager.saveSettings(next.id, { ...settings, browserMcp: true })
    const later: AgentSpec = { ...f.spec, id: 'later-session', title: 'Later' }
    f.manager.ensure(later)
    expect(f.database.structured.snapshot(later.id)?.settings.browserMcp).toBe(true)
    expect(f.database.structured.snapshot(f.spec.id)?.settings.browserMcp).toBeUndefined()
    f.manager.ensure(f.spec)
    expect(f.database.structured.snapshot(f.spec.id)?.settings.browserMcp).toBeUndefined()
  })

  it('opens a new conversation on Auto until the owner chooses another mode for that provider', () => {
    const f = fixture('claude', true, undefined, ['default', 'read-only', 'accept-edits', 'auto'])
    expect(f.database.structured.snapshot(f.spec.id)?.settings.permission).toBe('auto')
    f.manager.saveSettings(f.spec.id, { ...settings, permission: 'accept-edits' })
    const next: AgentSpec = { ...f.spec, id: 'next-session', title: 'Next' }
    f.manager.ensure(next)
    expect(f.database.structured.snapshot(next.id)?.settings.permission).toBe('accept-edits')
    // A provider that does not offer Auto opens on its own neutral mode instead.
    const limited = fixture('claude', true, undefined, ['default', 'accept-edits'])
    expect(limited.database.structured.snapshot(limited.spec.id)?.settings.permission).toBe('default')
  })

  it('refuses local sandbox grants on a provider that has no local sandbox', () => {
    const f = fixture('claude')
    for (const grant of [{ localGit: true }, { localResearch: true }]) expect(() => f.manager.saveSettings(f.spec.id, { ...settings, ...grant })).toThrow(/local models only/)
    // Withdrawing one is always allowed, so a conversation can never be stuck holding a grant.
    f.manager.saveSettings(f.spec.id, { ...settings, localGit: false, localResearch: false })
    expect(f.database.structured.snapshot(f.spec.id)?.settings.localGit).toBe(false)
  })

  it('rejects enabling browser tools during active work without changing the saved preference', async () => {
    const mcp = { configure: vi.fn(() => 'private-browser-config.json'), release: vi.fn() }
    const f = fixture('claude', true, mcp)
    f.manager.saveSettings(f.spec.id, settings)
    mcp.release.mockClear()
    await f.manager.submit(f.spec.id, 'Active turn', settings)
    expect(() => f.manager.saveSettings(f.spec.id, { ...settings, browserMcp: true })).toThrow('current turn')
    expect(f.database.structured.snapshot(f.spec.id)?.settings.browserMcp).toBeUndefined()
    expect(mcp.release).not.toHaveBeenCalled()
  })

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

  it('resumes the same native conversation for a new message, sends it once, and ignores stale callbacks', async () => {
    const f = fixture()
    writeFileSync(join(f.workspace, 'panel.mjs'), 'before\n')
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    const previous = f.current
    previous.approval('old-request')
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    await previous.options.beforeTool?.('edit', ['panel.mjs'])
    previous.emit({ data: { type: 'session', phase: 'disconnected' } })
    await f.manager.submit(f.spec.id, 'One new follow up', settings)
    const current = f.current
    expect(current).not.toBe(previous)
    expect(current.options.nativeSessionId).toBe(nativeId)
    expect(current.options.runtimeId).not.toBe(previous.options.runtimeId)
    expect(current.submissions.map(input => input.text)).toEqual(['One new follow up'])
    expect(previous.submissions.map(input => input.text)).toEqual(['Synthetic turn'])
    const sequence = f.database.structured.snapshot(f.spec.id)!.sequence
    previous.emit({ itemId: 'stale', data: { type: 'text', role: 'assistant', text: 'late stale text', mode: 'delta' } })
    writeFileSync(join(f.workspace, 'panel.mjs'), 'after\n')
    await previous.options.afterTool?.('edit', ['panel.mjs'], true)
    expect(f.database.structured.snapshot(f.spec.id)!.sequence).toBe(sequence)
    await expect(f.manager.respond({ sessionId: f.spec.id, runtimeId: previous.options.runtimeId, requestId: 'old-request', decision: 'allow' })).rejects.toThrow('stale')
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

  it('relaunches idle conversations settled after a shutdown and marks only the in-flight turn disconnected', async () => {
    const f = fixture()
    const idle = { ...f.spec, id: 'idle-session' }, busy = { ...f.spec, id: 'busy-session' }
    f.manager.ensure(idle); f.manager.ensure(busy)
    await f.manager.submit(f.spec.id, 'Settled synthetic turn', settings)
    f.current.finish()
    await f.manager.submit(idle.id, 'Another settled turn', settings)
    f.current.finish()
    await f.manager.submit(busy.id, 'Still running at shutdown', settings)
    f.manager.flush(); f.manager.dispose(); f.database.close()
    const reopened = new ConductorDatabase(f.databasePath); databases.push(reopened)
    expect(reopened.structured.snapshot(f.spec.id)?.phase).toBe('completed')
    expect(reopened.structured.snapshot(idle.id)?.phase).toBe('completed')
    expect(reopened.structured.snapshot(busy.id)?.phase).toBe('disconnected')
    // The settled conversation reconnects its same native conversation on the next message.
    const nativeId = reopened.structured.snapshot(f.spec.id)?.nativeSessionId
    const adapters: FakeProvider[] = []
    const restored = new StructuredSessions(reopened, () => 'synthetic-executable', vi.fn(), (_provider, options) => { const adapter = new FakeProvider(options); adapters.push(adapter); return adapter }); managers.push(restored)
    restored.ensure(f.spec)
    await restored.submit(f.spec.id, 'After the restart', settings)
    expect(adapters).toHaveLength(1)
    expect(adapters[0]!.options.nativeSessionId).toBe(nativeId)
    expect(adapters[0]!.submissions.map(submission => submission.text)).toEqual([expect.stringContaining('After the restart')])
  })

  it('restores history lazily, then resumes the same native conversation only for a new message', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Historical synthetic turn', settings)
    f.current.approval('historical-request')
    f.manager.flush(); f.manager.dispose(); f.database.close()
    const reopened = new ConductorDatabase(f.databasePath); databases.push(reopened)
    const factory = vi.fn((_provider: StructuredProvider, options: AdapterOptions) => new FakeProvider(options))
    const restored = new StructuredSessions(reopened, () => 'synthetic-executable', vi.fn(), factory); managers.push(restored)
    const projection = reopened.structured.snapshot(f.spec.id)
    expect(projection?.phase).toBe('disconnected')
    expect(projection?.items.find((item) => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'expired' } })
    restored.ensure(f.spec)
    expect(factory).not.toHaveBeenCalled()
    expect(reopened.structured.events(f.spec.id).some((entry) => entry.data.type === 'text' && entry.data.role === 'user')).toBe(true)
    await restored.submit(f.spec.id, 'New message after restart', settings)
    expect(factory).toHaveBeenCalledOnce()
    const resumed = factory.mock.results[0]!.value as FakeProvider
    expect(resumed.options.nativeSessionId).toBe(projection?.nativeSessionId)
    expect(resumed.submissions.map(input => input.text)).toEqual(['New message after restart'])
    expect(resumed.responses).toEqual([])
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

  it('describes opaque media by verified workspace metadata without decoding it as text', async () => {
    const f = fixture()
    const bytes = Buffer.from([0, 1, 2, 3, 0xff])
    writeFileSync(join(f.workspace, 'clip.mp4'), bytes)
    await f.manager.submit(f.spec.id, 'Inspect media context', settings, [
      { id: 'media', kind: 'media', name: 'clip.mp4', path: 'clip.mp4', mimeType: 'video/mp4', size: 999_999 }
    ])
    const submission = f.current.submissions[0]!
    expect(submission.text).toContain('Attached opaque media: clip.mp4')
    expect(submission.text).toContain('media type: video/mp4; 5 bytes')
    expect(submission.text).toContain('Binary bytes were not decoded or inserted as readable text.')
    expect(submission.attachments).toEqual([])
    const user = f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'text' && item.data.role === 'user')
    expect(user?.data).toMatchObject({ attachments: [{ kind: 'media', path: 'clip.mp4', mimeType: 'video/mp4', size: 5 }] })
    expect(JSON.stringify(user?.data)).not.toContain(bytes.toString('utf8'))
  })

  it('refuses to dispatch once recalled memory or attachment expansion pushes the assembled prompt past the true CLI ceiling', async () => {
    const f = fixture()
    f.manager.dispose()
    const huge = 'x'.repeat(MAX_PROMPT_CHARS + 1)
    const withRecall = new StructuredSessions(f.database, () => 'synthetic-executable', f.broadcast, f.factory, () => huge)
    managers.push(withRecall); withRecall.ensure(f.spec)
    await expect(withRecall.submit(f.spec.id, 'short draft', settings)).rejects.toThrow('Prompt must contain')
    expect(f.adapters.reduce((count, adapter) => count + adapter.submissions.length, 0)).toBe(0)
  })

  it('puts recalled background before the owner\'s words for a local model and after them for a native one', async () => {
    const f = fixture()
    f.manager.dispose()
    const recalled = '- [semantic] The checkout tax total is computed from stale cart totals'
    const withRecall = new StructuredSessions(f.database, () => 'synthetic-executable', f.broadcast, f.factory, () => recalled)
    managers.push(withRecall)
    withRecall.ensure(f.spec)
    await withRecall.submit(f.spec.id, 'Fix the checkout tax', settings)
    expect(f.current.submissions[0]!.text).toBe(`Fix the checkout tax\n\n${recalled}`)

    const local: AgentSpec = { ...f.spec, id: 'local-recall', provider: 'local', title: 'Local' }
    withRecall.ensure(local)
    await withRecall.submit(local.id, 'paste back the prompt you received', settings)
    const submitted = f.current.submissions[0]!.text
    expect(submitted).toBe(composeLocalPrompt('paste back the prompt you received', recalled))
    expect(submitted.startsWith(LOCAL_BACKGROUND_OPEN)).toBe(true)
    expect(submitted.endsWith('\n\npaste back the prompt you received')).toBe(true)
    expect(splitLocalPrompt(submitted)).toEqual({ instruction: 'paste back the prompt you received', background: recalled })
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
    expect(original.submissions).toEqual([{ text: 'First effort-selected synthetic turn', settings: { ...selected, browserMcp: true }, attachments: [] }])
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
  it('applies the latest queued settings to the one combined followup on the same native Claude conversation', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original turn', settings)
    const original = f.current, nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    await f.manager.queue(f.spec.id, 'Low effort followup', { ...settings, effort: 'low' })
    await f.manager.queue(f.spec.id, 'Inherited effort followup', settings)
    original.finish()
    await vi.waitFor(() => expect(original.submissions).toHaveLength(2))
    expect(original.submissions.map(submission => submission.settings.effort)).toEqual([undefined, undefined])
    expect(original.submissions[1]?.text).toContain('Low effort followup')
    expect(original.submissions[1]?.text).toContain('Inherited effort followup')
    expect(f.current).toBe(original)
    expect(original.disposed).toBe(false)
    expect(f.database.structured.snapshot(f.spec.id)?.nativeSessionId).toBe(nativeId)
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toEqual([])
  })

})

describe('queued messages and native CLI handoff', () => {
  it('cancelling a refused CLI switch preserves the running Chat turn and its runtime', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Keep working', settings)
    const runtimeId = f.database.structured.snapshot(f.spec.id)!.runtimeId
    await expect(f.manager.prepareCli(f.spec.id)).rejects.toThrow(/Finish or stop/)
    f.manager.cancelCli(f.spec.id)
    expect(f.database.structured.snapshot(f.spec.id)).toMatchObject({ phase: 'running', view: 'visual', runtimeId })
    expect(f.current.disposed).toBe(false)
    expect(f.current.submissions).toHaveLength(1)
  })
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
  it('rechecks remote authority after attachment expansion before native steering', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'active', settings)
    f.current.capabilities.steering = true
    writeFileSync(join(f.workspace, 'remote-context.txt'), 'captured remote context')
    let authorized = true
    f.manager.setPromptDispatchAuthorityGuard((authority, spec) => {
      expect(authority).toEqual(remoteOrigin(f.spec.projectId).authority)
      expect(spec).toEqual(f.spec)
      if (!authorized) throw new Error('Remote prompt authority was revoked')
    })

    const dispatch = f.manager.steer(f.spec.id, 'remote followup', settings, [
      { id: 'remote-file', kind: 'file', name: 'remote-context.txt', path: 'remote-context.txt' }
    ], remoteOrigin(f.spec.projectId))
    authorized = false

    await expect(dispatch).rejects.toThrow('authority was revoked')
    expect(f.current.steers).toEqual([])
    const state = f.database.structured.snapshot(f.spec.id)!
    expect(state.pendingSteering ?? []).toEqual([])
    expect(state.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text === 'remote followup')).toBe(false)
  })
  it('rechecks remote authority after native connection without recording an accepted prompt', async () => {
    const f = fixture()
    let releaseStart!: () => void
    f.gateStart(new Promise<void>(resolve => { releaseStart = resolve }))
    let authorized = true
    f.manager.setPromptDispatchAuthorityGuard(() => {
      if (!authorized) throw new Error('Remote prompt authority was revoked')
    })

    const dispatch = f.manager.submit(f.spec.id, 'remote new turn', settings, [], remoteOrigin(f.spec.projectId))
    await vi.waitFor(() => expect(f.current.starts).toBe(1))
    authorized = false
    releaseStart()

    await expect(dispatch).rejects.toThrow('authority was revoked')
    expect(f.current.submissions).toEqual([])
    const state = f.database.structured.snapshot(f.spec.id)!
    expect(state.phase).toBe('idle')
    expect(state.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text === 'remote new turn')).toBe(false)
  })
  it('retains an authorized queued remote prompt when its authority is revoked before drain', async () => {
    const f = fixture()
    let authorized = true
    f.manager.setPromptDispatchAuthorityGuard(() => {
      if (!authorized) throw new Error('Remote prompt authority was revoked')
    })
    await f.manager.submit(f.spec.id, 'active', settings)
    await f.manager.queue(f.spec.id, 'remote queued turn', settings, [], remoteOrigin(f.spec.projectId))
    authorized = false
    f.current.finish()

    await vi.waitFor(() => expect(f.database.structured.snapshot(f.spec.id)?.items.some(item => item.data.type === 'notice' && item.data.message.includes('authority was revoked'))).toBe(true))
    expect(f.adapters.flatMap(adapter => adapter.submissions).map(input => input.text)).toEqual(['active'])
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toMatchObject([{
      text: 'remote queued turn',
      origin: { authority: { kind: 'remote-peer', peerId: 'trusted-peer', projectId: f.spec.projectId } }
    }])
  })
  it('fails closed after reload when a durable remote queue has no authority guard', async () => {
    const f = fixture()
    f.manager.setPromptDispatchAuthorityGuard(() => undefined)
    await f.manager.submit(f.spec.id, 'active', settings)
    await f.manager.queue(f.spec.id, 'durable remote queued turn', settings, [], remoteOrigin(f.spec.projectId))
    f.manager.dispose()

    const restarted = new StructuredSessions(f.database, () => 'synthetic-executable', f.broadcast, f.factory)
    managers.push(restarted)
    restarted.ensure(f.spec)
    await restarted.resume(f.spec.id)

    await vi.waitFor(() => expect(f.database.structured.snapshot(f.spec.id)?.items.some(item => item.data.type === 'notice' && item.data.message.includes('cannot be verified'))).toBe(true))
    expect(f.adapters.flatMap(adapter => adapter.submissions).map(input => input.text)).toEqual(['active'])
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toMatchObject([{
      text: 'durable remote queued turn',
      origin: { authority: { kind: 'remote-peer', peerId: 'trusted-peer', projectId: f.spec.projectId } }
    }])
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
  it('drains every queued message as one clearly separated turn in original order', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'first', settings)
    await f.manager.queue(f.spec.id, 'second', settings)
    await f.manager.queue(f.spec.id, 'third', settings)
    await f.manager.queue(f.spec.id, 'fourth', settings)
    await f.manager.queue(f.spec.id, 'fifth', settings)
    f.current.finish()
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.submissions[1]?.text).toBe([
      '--- Queued message 1 of 4 ---', 'second',
      '--- Queued message 2 of 4 ---', 'third',
      '--- Queued message 3 of 4 ---', 'fourth',
      '--- Queued message 4 of 4 ---', 'fifth'
    ].join('\n\n'))
    const userMessages = f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user') ?? []
    expect(userMessages).toHaveLength(2)
    expect(userMessages.at(-1)?.data).toMatchObject({ type: 'text', text: f.current.submissions[1]?.text })
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeNull()
  })

  it.each([
    ['claude', 'claude-fable-5-1', 'opus[1m]', 'Fable refused this turn; continuing on Opus 5.5'],
    ['codex', 'gpt-6-astra', 'gpt-5.6-sol', 'Astra refused this turn; continuing on Sol']
  ] as const)('continues one refused %s turn once on the next model', async (provider, model, fallback, notice) => {
    const f = fixture(provider)
    await f.manager.submit(f.spec.id, 'Safe ordinary request', { ...settings, model })
    f.current.emit({ data: { type: 'error', code: 'provider_safeguard_refusal', message: 'Provider safeguards flagged this message' } })
    f.current.emit({ data: { type: 'session', phase: 'failed' } })

    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.submissions[1]).toMatchObject({ text: 'Safe ordinary request', settings: { model: fallback } })
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.items.some(item => item.data.type === 'notice' && item.data.message === notice)).toBe(true)

    f.current.emit({ data: { type: 'error', code: 'provider_safeguard_refusal', message: 'Fallback also refused' } })
    f.current.emit({ data: { type: 'session', phase: 'failed' } })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(f.current.submissions).toHaveLength(2)
  })
  it('dispatches a queued message after a turn fails instead of holding it forever', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'first', settings)
    await f.manager.queue(f.spec.id, 'second', settings)
    f.current.emit({ data: { type: 'error', message: 'Local model request failed with HTTP 500' } })
    f.current.emit({ data: { type: 'session', phase: 'failed' } })
    await vi.waitFor(() => expect(f.current.submissions.map(item => item.text)).toEqual(['first', 'second']))
    expect(f.database.structured.snapshot(f.spec.id)?.queued).toBeNull()
  })
  it('retries a queued message into a failed phase only once', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'first', settings)
    await f.manager.queue(f.spec.id, 'second', settings)
    f.current.disposed = true
    f.current.emit({ data: { type: 'session', phase: 'failed' } })
    await vi.waitFor(() => expect(f.database.structured.snapshot(f.spec.id)!.items.some(item => item.data.type === 'notice' && item.data.message.startsWith('Queued message was not sent'))).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 50))
    const state = f.database.structured.snapshot(f.spec.id)!
    expect(state.items.filter(item => item.data.type === 'notice' && item.data.message.startsWith('Queued message was not sent'))).toHaveLength(1)
    expect(state.queued?.text).toBe('second')
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
    expect(f.current.steers).toEqual([{ text: expect.stringContaining('More data'), settings: { ...settings, browserMcp: true }, attachments: [] }])
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


describe('permission response acknowledgment and mode persistence', () => {
  it('retains a definitively rejected approval so another action can resolve it', async () => {
    const f = fixture(); await f.manager.submit(f.spec.id, 'Synthetic', settings)
    f.current.approval()
    f.current.onResponse = async () => { throw new InteractionResponseRejectedError('Native policy rejected auto mode before answering') }
    const response = { sessionId: f.spec.id, runtimeId: f.current.options.runtimeId, requestId: 'request', decision: 'allow' }
    await expect(f.manager.respond(response)).rejects.toThrow('Native policy rejected')
    expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'pending' } })
    f.current.onResponse = undefined
    await f.manager.respond({ ...response, decision: 'deny' })
    expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'resolved', outcome: 'deny' } })
  })
  it('persists confirmed provider mode while preserving cancellation during its acknowledgment', async () => {
    const f = fixture(); await f.manager.submit(f.spec.id, 'Synthetic', settings)
    f.current.approval()
    f.current.onResponse = async () => {
      f.current.emit({ requestId: 'request', data: { type: 'interaction', interaction: { id: 'request', kind: 'approval', title: 'Expired', input: {}, choices: [], status: 'expired', outcome: 'Provider cancelled request' } } })
      f.current.emit({ data: { type: 'session', phase: 'running', settings: { ...settings, permission: 'auto', plan: false } } })
    }
    await f.manager.respond({ sessionId: f.spec.id, runtimeId: f.current.options.runtimeId, requestId: 'request', decision: 'allow' })
    expect(f.database.structured.snapshot(f.spec.id)).toMatchObject({ settings: { permission: 'auto', plan: false }, phase: 'running' })
    expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'expired', outcome: 'Provider cancelled request' } })
    f.current.finish(); await f.manager.resume(f.spec.id)
    expect(f.current.options.settings.permission).toBe('auto')
  })
  it('rejects disabled scopes before transport dispatch and keeps uncertain delivery nonretryable', async () => {
    const f = fixture(); await f.manager.submit(f.spec.id, 'Synthetic', settings)
    f.current.emit({ requestId: 'request', data: { type: 'interaction', interaction: { id: 'request', kind: 'approval', title: 'Permission', input: {}, choices: [{ id: 'allow-session', label: 'Allow for this session', disabled: true }, { id: 'allow', label: 'Allow once' }], status: 'pending' } } })
    const response = { sessionId: f.spec.id, runtimeId: f.current.options.runtimeId, requestId: 'request', decision: 'allow-session' }
    await expect(f.manager.respond(response)).rejects.toThrow('Unsupported approval scope')
    expect(f.current.responses).toHaveLength(0)
    f.current.onResponse = async () => { throw new Error('Transport disconnected') }
    await expect(f.manager.respond({ ...response, decision: 'allow' })).rejects.toThrow('Transport disconnected')
    expect(f.database.structured.snapshot(f.spec.id)?.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'expired', outcome: 'Response delivery uncertain' } })
    await expect(f.manager.respond({ ...response, decision: 'allow' })).rejects.toThrow('already submitted')
  })
})

describe('remembered permission mirrored between the renderer and the main process', () => {
  it('registers a brand-new session on the owner\'s remembered mode for its provider', () => {
    const f = fixture()
    f.database.setSetting('rememberedPermission:claude', 'accept-edits')
    const second: AgentSpec = { ...f.spec, id: 'agent-session-second' }
    f.manager.ensure(second)
    expect(f.database.structured.snapshot(second.id)?.settings.permission).toBe('accept-edits')
    // The first session was already registered before the preference existed; it keeps its own history.
    expect(f.database.structured.snapshot(f.spec.id)?.settings.permission).toBe('default')
  })
  it('never re-applies a later remembered mode to an already-registered session', () => {
    const f = fixture()
    expect(f.database.structured.snapshot(f.spec.id)?.settings.permission).toBe('default')
    f.database.setSetting('rememberedPermission:claude', 'accept-edits')
    f.manager.ensure(f.spec)
    expect(f.database.structured.snapshot(f.spec.id)?.settings.permission).toBe('default')
  })
  it('never lets a different provider\'s remembered mode leak into a new session', () => {
    const f = fixture()
    f.database.setSetting('rememberedPermission:codex', 'accept-edits')
    const second: AgentSpec = { ...f.spec, id: 'agent-session-second' }
    f.manager.ensure(second)
    expect(f.database.structured.snapshot(second.id)?.settings.permission).toBe('default')
  })
  it('never seeds a mode this runtime does not actually offer', () => {
    const f = fixture()
    f.database.setSetting('rememberedPermission:claude', 'auto')
    const second: AgentSpec = { ...f.spec, id: 'agent-session-second' }
    f.manager.ensure(second)
    // The fake provider's capabilities stop at accept-edits; 'auto' is never applied.
    expect(f.database.structured.snapshot(second.id)?.settings.permission).toBe('default')
  })
  it('remembers a deliberate saveSettings permission choice for the next session of the same provider', async () => {
    const f = fixture(); await f.manager.submit(f.spec.id, 'Synthetic', settings)
    f.manager.saveSettings(f.spec.id, { ...settings, permission: 'accept-edits' })
    expect(f.database.getSetting('rememberedPermission:claude')).toBe('accept-edits')
    const second: AgentSpec = { ...f.spec, id: 'agent-session-second' }
    f.manager.ensure(second)
    expect(f.database.structured.snapshot(second.id)?.settings.permission).toBe('accept-edits')
  })
})

it.each(['resume', 'handoff', 'restore'] as const)('expires a provider session Edit grant on %s', async transition => {
  const f = fixture(); await f.manager.submit(f.spec.id, 'Synthetic', settings)
  const current = f.current
  current.emit({ data: { type: 'session', phase: 'completed', settings: { ...settings, permission: 'accept-edits', temporaryPermission: { runtimeId: current.options.runtimeId, restore: 'default' } } } })
  const grant = f.database.structured.snapshot(f.spec.id)!.settings
  await f.manager.submit(f.spec.id, 'Same runtime retains Edit', grant)
  expect(current.submissions.at(-1)?.settings.permission).toBe('accept-edits')
  current.finish()
  if (transition === 'handoff') {
    const cli = await f.manager.prepareCli(f.spec.id)
    expect(cli.settings).toMatchObject({ permission: 'default' })
    expect(cli.settings.temporaryPermission).toBeUndefined()
  } else if (transition === 'restore') {
    f.manager.dispose()
    const recovered = new StructuredSessions(f.database, () => 'synthetic-executable', f.broadcast, f.factory); managers.push(recovered)
    await recovered.resume(f.spec.id)
    expect(f.current.options.settings.permission).toBe('default')
    expect(f.current.options.settings.temporaryPermission).toBeUndefined()
  } else {
    await f.manager.resume(f.spec.id, grant)
    expect(f.current.options.settings.permission).toBe('default')
    expect(f.current.options.settings.temporaryPermission).toBeUndefined()
  }
  expect(f.database.structured.snapshot(f.spec.id)?.settings.permission).toBe('default')
  expect(f.database.structured.snapshot(f.spec.id)?.settings.temporaryPermission).toBeUndefined()
})


describe('steering receipts and Escape delivery', () => {
  async function pendingFixture() {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.capabilities.steering = true; f.current.autoDeliver = false
    f.current.emit({ turnId: 'original-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
    await f.manager.steer(f.spec.id, 'Already submitted', settings)
    const id = f.current.steerIds[0]!
    return { ...f, inputId: id, receipt: (status: 'accepted' | 'delivered' | 'cancelled' | 'uncertain') => f.current.emit({ data: { type: 'input_delivery', inputId: id, status } }) }
  }
  it('keeps input pending across a tool result until the native consumption receipt, and ignores duplicate receipts', async () => {
    const f = await pendingFixture()
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering?.[0]).toMatchObject({ text: 'Already submitted', status: 'sending' })
    f.receipt('accepted')
    f.current.emit({ itemId: 'tool', data: { type: 'tool', name: 'Read', status: 'completed', output: 'Synthetic result' } })
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering?.[0]?.status).toBe('accepted')
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(1)
    f.receipt('delivered'); f.receipt('delivered'); f.receipt('accepted')
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toEqual([])
    expect(f.database.structured.snapshot(f.spec.id)?.items.filter(item => item.data.type === 'text' && item.data.role === 'user')).toHaveLength(2)
    expect(f.current.submissions).toHaveLength(1)
  })
  it('cancels receipt timers before disposal and keeps a late acknowledgement uncertain', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    const runtime = f.current
    runtime.capabilities.steering = true; runtime.autoDeliver = false
    runtime.emit({ turnId: 'original-turn', data: { type: 'session', phase: 'running', capabilities: runtime.capabilities } })
    let release!: () => void
    runtime.onSteer = () => new Promise<void>(resolve => { release = resolve })
    const pending = f.manager.steerAccepted(f.spec.id, 'Assignment awaiting receipt', settings)
    await vi.waitFor(() => expect(runtime.steerIds).toHaveLength(1))
    f.manager.dispose()
    await expect(pending).rejects.toThrow('backend closed before native steering acceptance')
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toMatchObject([{ status: 'uncertain' }])
    runtime.emit({ data: { type: 'input_delivery', inputId: runtime.steerIds[0]!, status: 'accepted' } })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toMatchObject([{ status: 'uncertain' }])
    release()
    vi.useRealTimers()
  })
  it('does not let a retired runtime acknowledgement cross into a replacement connection', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    const retired = f.current
    retired.capabilities.steering = true; retired.autoDeliver = false
    retired.emit({ turnId: 'original-turn', data: { type: 'session', phase: 'running', capabilities: retired.capabilities } })
    let release!: () => void
    retired.onSteer = () => new Promise<void>(resolve => { release = resolve })
    const pending = f.manager.steerAccepted(f.spec.id, 'Assignment on retiring runtime', settings)
    await vi.waitFor(() => expect(retired.steerIds).toHaveLength(1))
    f.manager.killWhere(spec => spec.id === f.spec.id)
    await expect(pending).rejects.toThrow('backend closed before native steering acceptance')
    f.manager.ensure(f.spec)
    await f.manager.resume(f.spec.id)
    const replacement = f.current
    expect(replacement).not.toBe(retired)
    retired.emit({ data: { type: 'input_delivery', inputId: retired.steerIds[0]!, status: 'accepted' } })
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toMatchObject([{ status: 'uncertain' }])
    release()
  })
  it.each(['receipt-first', 'completion-first'])('Escape submits the exact cancelled pending input once after both confirmations (%s)', async order => {
    const f = await pendingFixture()
    f.receipt('accepted')
    let finishInterrupt = () => {}
    f.current.interrupt = () => new Promise<void>(resolve => { finishInterrupt = resolve })
    const stopping = f.manager.interrupt(f.spec.id, true)
    const secondStop = f.manager.interrupt(f.spec.id, true)
    if (order === 'receipt-first') f.receipt('cancelled')
    f.current.emit({ data: { type: 'session', phase: 'interrupted' } })
    await Promise.resolve()
    expect(f.current.submissions).toHaveLength(1)
    if (order === 'completion-first') f.receipt('cancelled')
    finishInterrupt(); await Promise.all([stopping, secondStop])
    await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
    expect(f.current.submissions[1]?.text).toBe('Already submitted')
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toEqual([])
  })
  it('does not replay input absorbed during interruption, or interrupt without submitted input', async () => {
    const f = await pendingFixture()
    f.current.interrupt = async () => { f.receipt('delivered'); f.current.emit({ data: { type: 'session', phase: 'interrupted' } }) }
    await f.manager.interrupt(f.spec.id, true)
    expect(f.current.submissions).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toEqual([])
    f.current.emit({ data: { type: 'session', phase: 'running' } })
    await f.manager.interrupt(f.spec.id, true)
    expect(f.current.submissions).toHaveLength(1)
  })
  it('does not replay a cancellation without proof, or replay from a budget stop', async () => {
    const f = await pendingFixture()
    await f.manager.interrupt(f.spec.id, true)
    expect(f.current.submissions).toHaveLength(1)
    f.current.emit({ data: { type: 'session', phase: 'running' } })
    f.current.interrupt = async () => { f.receipt('cancelled'); f.current.emit({ data: { type: 'session', phase: 'interrupted' } }) }
    await f.manager.interrupt(f.spec.id)
    expect(f.current.submissions).toHaveLength(1)
    expect(f.manager.cancelQueued(f.spec.id, f.inputId)?.text).toBe('Already submitted')
  })
  it('promotes a message queued during native startup into the active turn once steering becomes available', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Original', settings)
    f.current.emit({ data: { type: 'session', phase: 'running' } })
    await f.manager.steer(f.spec.id, 'After next tool', settings)
    expect(f.current.steers).toHaveLength(0)
    f.current.capabilities.steering = true
    f.current.emit({ turnId: 'ready-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
    await vi.waitFor(() => expect(f.current.steers).toHaveLength(1))
    expect(f.current.submissions).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toEqual([])
  })
})


it('steers startup-held input past an explicitly after-turn queued message', async () => {
  const f = fixture()
  await f.manager.submit(f.spec.id, 'Original', settings)
  f.current.emit({ data: { type: 'session', phase: 'running' } })
  await f.manager.queue(f.spec.id, 'After the whole turn', settings)
  await f.manager.steer(f.spec.id, 'Next tool please', settings)
  f.current.capabilities.steering = true
  f.current.emit({ turnId: 'ready-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
  await vi.waitFor(() => expect(f.current.steers).toHaveLength(1))
  expect(f.current.steers[0]?.text).toBe('Next tool please')
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts?.map(input => input.text)).toEqual(['After the whole turn'])
  expect(f.current.submissions).toHaveLength(1)
})

it('Escape expedites a host-held steering message after native interruption', async () => {
  const f = fixture()
  await f.manager.submit(f.spec.id, 'Original', settings)
  f.current.emit({ data: { type: 'session', phase: 'running' } })
  await f.manager.steer(f.spec.id, 'Held during startup', settings)
  await f.manager.interrupt(f.spec.id, true)
  await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
  expect(f.current.submissions[1]?.text).toBe('Held during startup')
  expect(f.current.steers).toHaveLength(0)
})


it('transfers a promoted queue entry to native pending ownership even when delivery becomes uncertain', async () => {
  const f = fixture()
  await f.manager.submit(f.spec.id, 'Original', settings)
  f.current.emit({ data: { type: 'session', phase: 'running' } })
  await f.manager.queue(f.spec.id, 'Unrelated after turn', settings)
  await f.manager.steer(f.spec.id, 'Do not deliver twice', settings)
  f.current.capabilities.steering = true
  f.current.onSteer = async () => { throw new Error('Native acknowledgment lost') }
  f.current.emit({ turnId: 'ready-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
  await vi.waitFor(() => expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering?.[0]?.status).toBe('uncertain'))
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts?.map(input => input.text)).toEqual(['Unrelated after turn'])
  expect(f.current.steers).toHaveLength(1)
  f.current.emit({ data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
  f.current.finish()
  await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
  expect(f.current.steers).toHaveLength(1)
  expect(f.current.submissions[1]?.text).toBe('Unrelated after turn')
  f.current.finish()
  await new Promise(resolve => setImmediate(resolve))
  await f.manager.resume(f.spec.id)
  expect(f.current.submissions).toHaveLength(0)
  expect(f.current.steers).toHaveLength(0)
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toEqual([])
  expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toMatchObject([{ text: 'Do not deliver twice', status: 'uncertain' }])
})


it('retains transferred input when a definite native refusal races with Stop', async () => {
  const f = fixture()
  await f.manager.submit(f.spec.id, 'Original', settings)
  f.current.emit({ data: { type: 'session', phase: 'running' } })
  await f.manager.steer(f.spec.id, 'Recover after Stop', settings, [{ id: 'context', kind: 'selection', name: 'Selected text', content: 'Exact captured bytes' }])
  let refuse = () => {}
  f.current.onSteer = () => new Promise<void>((_resolve, reject) => { refuse = () => reject(new SteeringUnavailableError('The active turn stopped')) })
  f.current.capabilities.steering = true
  f.current.emit({ turnId: 'ready-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
  await vi.waitFor(() => expect(f.current.steers).toHaveLength(1))
  await f.manager.interrupt(f.spec.id)
  refuse()
  await vi.waitFor(() => expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering?.[0]?.status).toBe('cancelled'))
  expect(f.database.structured.snapshot(f.spec.id)?.phase).toBe('interrupted')
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toEqual([])
  expect(f.current.submissions).toHaveLength(1)
  expect(f.manager.cancelQueued(f.spec.id, f.current.steerIds[0])).toMatchObject({ text: 'Recover after Stop', attachments: [{ content: 'Exact captured bytes' }] })
  expect(f.database.structured.snapshot(f.spec.id)?.pendingSteering).toEqual([])
})


it('retains explicitly queued unsupported-turn input after a normal Stop', async () => {
  const f = fixture()
  await f.manager.submit(f.spec.id, 'Original', settings)
  f.current.capabilities.steering = false
  f.current.emit({ turnId: 'non-steerable-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
  await f.manager.queue(f.spec.id, 'Explicit after-turn queue', settings)
  await f.manager.interrupt(f.spec.id, false)
  expect(f.database.structured.snapshot(f.spec.id)?.phase).toBe('interrupted')
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toMatchObject([{ text: 'Explicit after-turn queue' }])
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts?.[0]?.steer).toBeUndefined()
  expect(f.current.steers).toHaveLength(0)
  expect(f.current.submissions).toHaveLength(1)
})

it('Escape flushes every queued message in original order after interruption', async () => {
  const f = fixture()
  await f.manager.submit(f.spec.id, 'Original', settings)
  f.current.capabilities.steering = false
  f.current.emit({ turnId: 'non-steerable-turn', data: { type: 'session', phase: 'running', capabilities: f.current.capabilities } })
  await f.manager.queue(f.spec.id, 'Queued first', settings)
  await f.manager.queue(f.spec.id, 'Queued second', settings)
  await f.manager.queue(f.spec.id, 'Queued third', settings)
  f.current.capabilities.steering = true
  await f.manager.interrupt(f.spec.id, true)
  await vi.waitFor(() => expect(f.current.submissions).toHaveLength(2))
  expect(f.current.submissions[1]?.text).toBe([
    '--- Queued message 1 of 3 ---', 'Queued first',
    '--- Queued message 2 of 3 ---', 'Queued second',
    '--- Queued message 3 of 3 ---', 'Queued third'
  ].join('\n\n'))
  expect(f.current.steers).toEqual([])
  expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts).toEqual([])
})

describe('composer settings persistence', () => {
  it('keeps a chosen model and effort with the conversation, across a restart, without starting a runtime', () => {
    const f = fixture()
    f.manager.saveSettings(f.spec.id, { ...settings, model: 'opus', effort: 'low' })
    expect(f.database.structured.snapshot(f.spec.id)?.settings).toMatchObject({ model: 'opus', effort: 'low' })
    expect(f.adapters.some(adapter => adapter.starts > 0)).toBe(false)
    f.database.close()
    const reopened = new ConductorDatabase(f.databasePath); databases.push(reopened)
    expect(reopened.structured.snapshot(f.spec.id)?.settings).toMatchObject({ model: 'opus', effort: 'low' })
  })
  it('refuses a setting the provider never offered, leaving the saved conversation settings alone', () => {
    const f = fixture()
    expect(() => f.manager.saveSettings(f.spec.id, { ...settings, effort: 'ultra' })).toThrow(/Effort/)
    expect(f.database.structured.snapshot(f.spec.id)?.settings.effort).toBeUndefined()
  })
})

describe('activity reported for a lost connection', () => {
  // recordActivityPhase now coalesces the durable status write and its broadcast to `flush`,
  // so a synchronous check of the persisted row must flush first.
  const activityPhase = (f: ReturnType<typeof fixture>) => {
    f.manager.flush()
    return f.database.listProcesses().find(process => process.id === f.spec.id)?.activityPhase
  }

  it('reports disconnected when the connection is lost while the turn is still in flight', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    expect(activityPhase(f)).toBe('working')
    f.current.emit({ data: { type: 'session', phase: 'disconnected' } })
    expect(activityPhase(f)).toBe('disconnected')
  })

  it('keeps the state a settled conversation finished in when its connection is lost afterwards', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Synthetic turn', settings)
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    expect(activityPhase(f)).toBe('complete')
    f.current.emit({ data: { type: 'session', phase: 'disconnected' } })
    expect(activityPhase(f)).toBe('complete')
  })
})

describe('activity reported while subagent work outlives its turn', () => {
  // recordActivityPhase now coalesces the durable status write and its broadcast to `flush`,
  // so a synchronous check of the persisted row must flush first.
  const activityPhase = (f: ReturnType<typeof fixture>) => {
    f.manager.flush()
    return f.database.listProcesses().find(process => process.id === f.spec.id)?.activityPhase
  }
  const subagent = (name: string, status: 'running' | 'completed' | 'failed', detached = true) =>
    ({ itemId: name, data: { type: 'subagent' as const, name, status, detached } })

  it('keeps a conversation working while a subagent it launched runs past the end of its turn', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Dispatch the wave', settings)
    f.current.emit(subagent('worker-1', 'running'))
    // Claude reports its turn result as soon as it hands work off; the children keep streaming.
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    expect(activityPhase(f)).toBe('working')
    f.current.emit(subagent('worker-2', 'running'))
    expect(activityPhase(f)).toBe('working')
    f.current.emit(subagent('worker-1', 'completed'))
    expect(activityPhase(f)).toBe('working')
    f.current.emit(subagent('worker-2', 'completed'))
    expect(activityPhase(f)).toBe('complete')
  })

  it('reports the conversation done when every subagent settled before its turn ended', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Dispatch the wave', settings)
    f.current.emit(subagent('worker-1', 'running'))
    f.current.emit(subagent('worker-1', 'failed'))
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    expect(activityPhase(f)).toBe('complete')
  })

  it('never lets a child revive a turn that stopped, failed or lost its runtime', async () => {
    for (const phase of ['interrupted', 'failed', 'disconnected'] as const) {
      const f = fixture()
      await f.manager.submit(f.spec.id, 'Dispatch the wave', settings)
      f.current.emit(subagent('worker-1', 'running'))
      f.current.emit({ data: { type: 'session', phase } })
      f.current.emit(subagent('worker-2', 'running'))
      expect(activityPhase(f)).toBe(phase === 'interrupted' ? 'stopped' : phase === 'failed' ? 'failed' : 'disconnected')
    }
  })

  it('forgets subagents reported by a runtime that is no longer the live one', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Dispatch the wave', settings)
    f.current.emit(subagent('worker-1', 'running'))
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    expect(activityPhase(f)).toBe('working')
    // A fresh runtime cannot vouch for a child the previous process launched.
    await f.manager.resume(f.spec.id)
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    expect(activityPhase(f)).toBe('complete')
  })
})

describe('activity reported while background work outlives its turn', () => {
  // recordActivityPhase now coalesces the durable status write and its broadcast to `flush`,
  // so a synchronous check of the persisted row must flush first.
  const activityPhase = (f: ReturnType<typeof fixture>) => {
    f.manager.flush()
    return f.database.listProcesses().find(process => process.id === f.spec.id)?.activityPhase
  }
  const tick = (f: ReturnType<typeof fixture>) => f.current.emit({ data: { type: 'notice', message: 'Claude task lifecycle' } })

  it('keeps a conversation waiting while work it backgrounded runs past the end of its turn', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Relaunch the showcase render', settings)
    expect(activityPhase(f)).toBe('working')
    f.current.background = 1
    // The turn result lands the moment the command is backgrounded; the render runs for hours.
    f.current.finish()
    expect(activityPhase(f)).toBe('waiting_background')
    expect(f.database.structured.snapshot(f.spec.id)?.backgroundTasks).toBe(1)
    // A wake between turns settles back to the same wait, never to a checkmark.
    f.current.emit({ data: { type: 'session', phase: 'idle' } })
    expect(activityPhase(f)).toBe('waiting_background')
  })

  it('turns the tab green the moment the inventory drains, without waiting for another turn', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Relaunch the showcase render', settings)
    f.current.background = 1
    f.current.finish()
    expect(activityPhase(f)).toBe('waiting_background')
    // Nothing about a task reporting is a lifecycle event, so the change itself has to re-decide.
    f.current.background = 0
    tick(f)
    expect(activityPhase(f)).toBe('complete')
    expect(f.database.structured.snapshot(f.spec.id)?.backgroundTasks).toBe(0)
  })

  it('starts waiting as soon as the runtime reports work it backgrounded mid-turn', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Relaunch the showcase render', settings)
    f.current.background = 1
    tick(f)
    // The turn itself is still running: that wins, and the count rides along for the renderer.
    expect(activityPhase(f)).toBe('working')
    expect(f.database.structured.snapshot(f.spec.id)?.backgroundTasks).toBe(1)
  })

  it('never masks a turn that was interrupted, failed, or lost its runtime', async () => {
    for (const phase of ['interrupted', 'failed', 'disconnected'] as const) {
      const f = fixture()
      await f.manager.submit(f.spec.id, 'Relaunch the showcase render', settings)
      f.current.background = 1
      f.current.emit({ data: { type: 'session', phase } })
      expect(activityPhase(f)).toBe(phase === 'interrupted' ? 'stopped' : phase === 'failed' ? 'failed' : 'disconnected')
    }
  })

  it('reports a connection lost while waiting on background work, which dies with the process', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Relaunch the showcase render', settings)
    f.current.background = 1
    f.current.finish()
    expect(activityPhase(f)).toBe('waiting_background')
    f.current.emit({ data: { type: 'session', phase: 'disconnected' } })
    expect(activityPhase(f)).toBe('disconnected')
  })

  it('leaves a conversation whose inventory was empty all along exactly as it was', async () => {
    const f = fixture('codex')
    await f.manager.submit(f.spec.id, 'Ordinary turn', settings)
    f.current.finish()
    expect(activityPhase(f)).toBe('complete')
    tick(f)
    expect(activityPhase(f)).toBe('complete')
  })
})

describe('provider usage limits and automatic continuation', () => {
  const limited = "You've hit your session limit · resets in 2 hours"
  // recordActivityPhase now coalesces the durable status write and its broadcast to `flush`,
  // so a synchronous check of the persisted row must flush first.
  const activityPhase = (f: ReturnType<typeof fixture>) => {
    f.manager.flush()
    return f.database.listProcesses().find(process => process.id === f.spec.id)?.activityPhase
  }
  /** How a provider reports an exhausted quota: an ordinary failed turn whose text names a time. */
  const hitLimit = (f: ReturnType<typeof fixture>): void => {
    f.current.emit({ data: { type: 'error', message: limited } })
    f.current.emit({ data: { type: 'session', phase: 'failed' } })
  }

  it('waits out the provider window and continues the conversation itself', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.manager.ensure({ ...f.spec, continueOnLimit: true })
    await f.manager.submit(f.spec.id, 'Long running work', settings)
    hitLimit(f)

    expect(f.database.getContinuation(f.spec.id)).toMatchObject({ status: 'pending' })
    // A closed window is a wait with a known end, not a failure the owner has to notice.
    expect(activityPhase(f)).toBe('limited')
    expect(f.current.submissions).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(f.current.submissions.at(-1)?.text).toBe('continue')
    expect(f.database.getContinuation(f.spec.id)).toMatchObject({ status: 'resumed' })
    expect(activityPhase(f)).toBe('working')
  })

  it('records the wait but sends nothing when the workspace has not opted in', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Long running work', settings)
    hitLimit(f)

    expect(f.database.getContinuation(f.spec.id)).toMatchObject({ status: 'pending' })
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    expect(f.current.submissions.map(submission => submission.text)).toEqual(['Long running work'])
  })

  it('follows the toggle after registration and arms the wait it was turned on for', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Long running work', settings)
    hitLimit(f)
    // Turned on while the conversation is already waiting: the spec was registered without it.
    f.manager.ensure({ ...f.spec, continueOnLimit: true })

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(f.current.submissions.at(-1)?.text).toBe('continue')
  })

  it('stops waiting when the owner continues the conversation first', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.manager.ensure({ ...f.spec, continueOnLimit: true })
    await f.manager.submit(f.spec.id, 'Long running work', settings)
    hitLimit(f)

    await f.manager.submit(f.spec.id, 'continue', settings)
    f.current.emit({ data: { type: 'session', phase: 'completed' } })
    expect(f.database.getContinuation(f.spec.id)).toMatchObject({ status: 'resumed' })
    // The turn the owner sent settled normally; nothing relabels it as still limited.
    expect(activityPhase(f)).toBe('complete')

    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    expect(f.current.submissions.map(submission => submission.text)).toEqual(['Long running work', 'continue'])
  })

  it('re-arms a wait that outlived the backend that recorded it', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.manager.ensure({ ...f.spec, continueOnLimit: true })
    await f.manager.submit(f.spec.id, 'Long running work', settings)
    hitLimit(f)
    // Closing the project drops this process's timer; the reset time lives in SQLite.
    f.manager.killWhere(spec => spec.id === f.spec.id)

    const reopened = new StructuredSessions(f.database, () => 'synthetic-executable', f.broadcast, f.factory)
    managers.push(reopened)
    reopened.ensure({ ...f.spec, continueOnLimit: true })
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(f.current.submissions.at(-1)?.text).toBe('continue')
  })
})

describe('a burst of synchronous events batches its durable write, its status write, and its broadcast', () => {
  it('stages every event of the burst in memory and writes the whole batch in one flush, split into bounded broadcasts', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Burst turn', settings)
    const from = f.database.structured.snapshot(f.spec.id)!.sequence
    const before = f.broadcast.mock.calls.filter(call => call[0] === 'structured:events').length
    const burstSize = 1_200
    // All staged synchronously, in one JS turn, the way a fast provider's stdout chunk arrives.
    for (let index = 0; index < burstSize; index++) f.current.emit({ itemId: `burst-${index}`, data: { type: 'notice', message: `burst ${index}` } })
    // Nothing durable yet: `emit` only stages events in memory until a flush runs.
    expect(f.database.structured.events(f.spec.id, from)).toHaveLength(0)
    f.manager.flush()
    expect(f.database.structured.events(f.spec.id, from)).toHaveLength(burstSize)
    // The broadcast itself is spread across more than one IPC message, each bounded, rather than
    // one message holding the whole burst.
    await vi.waitFor(() => expect(f.broadcast.mock.calls.filter(call => call[0] === 'structured:events').length - before).toBeGreaterThan(1))
    const batches = f.broadcast.mock.calls.filter(call => call[0] === 'structured:events').slice(before).map(call => call[1] as unknown[])
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(500)
    expect(batches.reduce((sum, batch) => sum + batch.length, 0)).toBe(burstSize)
  })
  it('coalesces many phase reports within one burst into a single status write and a single broadcast', async () => {
    const f = fixture()
    await f.manager.submit(f.spec.id, 'Coalesce turn', settings)
    f.manager.flush()
    const before = f.broadcast.mock.calls.filter(call => call[0] === 'agent:status').length
    for (let index = 0; index < 50; index++) f.current.emit({ data: { type: 'session', phase: index % 2 ? 'running' : 'waiting_input' } })
    f.manager.flush()
    const statusBroadcasts = f.broadcast.mock.calls.filter(call => call[0] === 'agent:status').slice(before)
    expect(statusBroadcasts).toHaveLength(1)
    expect(statusBroadcasts[0]![1]).toMatchObject({ id: f.spec.id })
  })
})
