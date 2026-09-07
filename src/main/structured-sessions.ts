import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { AgentSpec, RuntimeEnsureResult } from '../shared/models'
import type { AdapterEvent, AgentEvent, ContextAttachment, InteractionResponse, Json, SessionPhase, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { ConductorDatabase } from './database'
import { AgentArtifacts, workspacePath } from './agent-artifacts'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import { createProviderAdapter } from './providers/factory'
import { validateLiveTurn } from './live-test-policy'
import { LiveRuntimeBudget } from './live-runtime-budget'
import { sanitizeDiagnostic } from './structured-store'

interface LiveSession {
  spec: AgentSpec
  executable: string
  runtimeId: string
  adapter?: ProviderAdapter
  starting?: Promise<void>
  submitting: boolean
  closed: boolean
  responses: Set<string>
  budget?: LiveRuntimeBudget
  shutdownTimer?: NodeJS.Timeout
}
type Factory = (provider: StructuredProvider, options: AdapterOptions) => ProviderAdapter
const active = new Set<SessionPhase>(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])

export class StructuredSessions {
  private live = new Map<string, LiveSession>()
  private pending: AgentEvent[] = []
  private flushTimer?: NodeJS.Timeout
  private artifacts: AgentArtifacts
  constructor(
    private database: ConductorDatabase,
    private resolveExecutable: (provider: StructuredProvider) => string | null,
    private broadcast: (channel: string, payload: unknown) => void,
    private factory: Factory = createProviderAdapter,
    private context?: (spec: AgentSpec, prompt: string) => string,
    private observe?: (spec: AgentSpec, event: AgentEvent) => void
  ) { this.artifacts = new AgentArtifacts(database.structured) }

  ensure(spec: AgentSpec): RuntimeEnsureResult {
    this.validateSpec(spec)
    const store = this.database.structured
    const previousSpec = store.spec<AgentSpec>(spec.id)
    if (previousSpec && (previousSpec.projectId !== spec.projectId || previousSpec.provider !== spec.provider || realpathSync(previousSpec.cwd) !== realpathSync(spec.cwd))) throw new Error('A session cannot be rebound to a different provider or workspace')
    const executable = process.env.CONDUCTOR_OFFLINE_TESTS === '1' ? process.execPath : this.resolveExecutable(spec.provider as StructuredProvider)
    if (!store.snapshot(spec.id)) this.database.upsertAgent(spec, 'running', 'idle')
    const state = store.register(spec.id, spec.projectId, spec.provider as StructuredProvider, spec)
    if (!previousSpec) store.update(spec.id, { settings: { ...state.settings, model: spec.model && spec.model !== 'default' ? spec.model : undefined, effort: spec.effort && spec.effort !== 'auto' ? spec.effort : undefined } })
    // Registration constructs no process. Views subscribe to this backend resource.
    if (!this.live.has(spec.id)) this.live.set(spec.id, { spec: previousSpec ?? spec, executable: executable ?? '', runtimeId: '', submitting: false, closed: false, responses: new Set() })
    const live = this.live.get(spec.id)!
    if (!previousSpec) {
      const legacy = this.database.getAgentTranscript(spec.id)
      if (legacy) {
        let outputArtifactId: string | undefined
        try { outputArtifactId = store.putOutput(spec.id, legacy) } catch { /* Original legacy bytes remain in their existing SQLite transcript. */ }
        this.emit(live, { data: { type: 'notice', message: 'Saved pre-upgrade terminal history. Native conversation identity was not recorded; sending a message here starts a new conversation.', outputArtifactId } })
      }
    }
    if (!state.capabilities && executable) {
      const adapter = this.factory(spec.provider as StructuredProvider, this.options(live, randomUUID()))
      const projection = store.snapshot(spec.id)!
      projection.capabilities = adapter.capabilities
      store.checkpoint(spec.id)
    }
    return { id: spec.id, available: Boolean(executable), status: executable ? 'running' : 'unavailable', transcript: '', executable: executable ?? undefined, model: state.settings.model ?? spec.model ?? 'default', message: executable ? undefined : 'Provider CLI not found. Configure its executable before connecting.' }
  }
  private validateSpec(spec: AgentSpec): void {
    if (!spec || !/^[a-zA-Z0-9_-]{1,160}$/.test(spec.id) || !['claude', 'codex'].includes(spec.provider)) throw new Error('Invalid structured agent session')
    const project = this.database.getProject(spec.projectId), workspace = this.database.getSession(spec.sessionId)
    if (!project || !workspace || workspace.projectId !== project.id) throw new Error('Invalid project/workspace binding')
    // Existing project model has no separate authorized-worktree catalog.
    if (realpathSync(spec.cwd).toLocaleLowerCase() !== realpathSync(project.path).toLocaleLowerCase()) throw new Error('Agent working directory must match its registered project')
  }
  private get(id: string): LiveSession {
    let session = this.live.get(id)
    if (!session) {
      const spec = this.database.structured.spec<AgentSpec>(id)
      if (!spec) throw new Error('Session not found')
      this.ensure(spec)
      session = this.live.get(id)!
    }
    return session
  }
  private options(live: LiveSession, runtimeId: string): AdapterOptions {
    const id = live.spec.id, state = this.database.structured.snapshot(id)!
    return {
      executable: live.executable, cwd: live.spec.cwd, runtimeId, nativeSessionId: state.nativeSessionId,
      settings: state.settings,
      emit: event => { if (live.runtimeId === runtimeId && !live.closed) this.emit(live, event) },
      beforeTool: async (itemId, paths) => {
        if (live.runtimeId !== runtimeId || live.closed) return
        try { await this.artifacts.beforeTool(id, live.spec.cwd, `${runtimeId}:${itemId}`, paths) }
        catch (error) { if (live.runtimeId === runtimeId && !live.closed) this.emit(live, { itemId, data: { type: 'notice', message: `Snapshot unavailable: ${error instanceof Error ? error.message : 'unsupported file'}` } }) }
      },
      afterTool: async (itemId, paths, success) => {
        if (live.runtimeId !== runtimeId || live.closed) return
        try { const changes = await this.artifacts.afterTool(id, live.spec.cwd, `${runtimeId}:${itemId}`, paths, success); if (changes.length && live.runtimeId === runtimeId && !live.closed) this.emit(live, { itemId, data: { type: 'changes', changes } }) }
        catch (error) { if (live.runtimeId === runtimeId && !live.closed) this.emit(live, { itemId, data: { type: 'notice', message: `Snapshot unavailable: ${error instanceof Error ? error.message : 'unsupported file'}` } }) }
      }
    }
  }
  private async connect(live: LiveSession): Promise<void> {
    if (live.starting) return live.starting
    if (live.adapter) return
    this.validateSpec(live.spec)
    if (!live.executable) throw new Error('Provider executable unavailable')
    live.runtimeId = randomUUID(); live.closed = false; live.responses.clear()
    live.adapter = this.factory(live.spec.provider as StructuredProvider, this.options(live, live.runtimeId))
    this.emit(live, { data: { type: 'session', phase: 'starting', capabilities: live.adapter.capabilities } })
    live.starting = live.adapter.start().catch(error => {
      this.emit(live, { data: { type: 'error', message: error instanceof Error ? error.message : 'Provider initialization failed' } })
      this.emit(live, { data: { type: 'session', phase: 'disconnected' } })
      live.adapter?.dispose(); live.adapter = undefined
      throw error
    }).finally(() => { live.starting = undefined })
    return live.starting
  }
  async resume(id: string, settings?: SessionSettings): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (active.has(state.phase)) throw new Error('Session still has active work')
    if (!state.nativeSessionId) throw new Error('This history has no native conversation to resume')
    if (settings) { this.validateSettings(settings, state.capabilities); this.database.structured.update(id, { settings }) }
    live.closed = true; live.adapter?.dispose(); live.adapter = undefined; live.closed = false
    await this.connect(live)
  }
  async connectSession(id: string): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (state.phase === 'disconnected' && state.nativeSessionId) throw new Error('Resume this disconnected native conversation explicitly')
    await this.connect(live)
  }
  async discover(id: string): Promise<Json> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (state.phase === 'disconnected') throw new Error('Resume the native conversation before discovering runtime features')
    await this.connect(live)
    if (!live.adapter?.discover) throw new Error('Native discovery is unavailable on this adapter')
    return sanitizeDiagnostic(await live.adapter.discover()) as Json
  }
  async rename(id: string, title: string): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (live.adapter?.rename && state.phase !== 'disconnected') await live.adapter.rename(title)
    this.emit(live, { data: { type: 'session', phase: this.database.structured.snapshot(id)!.phase, title } })
    this.flush()
  }
  async archive(id: string, archived: boolean): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (active.has(state.phase)) throw new Error('Wait for the active turn before archiving')
    if (live.adapter?.archive && state.phase !== 'disconnected') await live.adapter.archive(archived)
    this.emit(live, { data: { type: 'session', phase: this.database.structured.snapshot(id)!.phase, archived } })
    this.flush()
  }
  async fork(id: string): Promise<string> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (!state.capabilities?.fork || !state.nativeSessionId || active.has(state.phase)) throw new Error('Fork requires an idle supported native conversation')
    await this.connect(live)
    if (!live.adapter?.fork) throw new Error('Native fork is unsupported')
    const nativeSessionId = await live.adapter.fork()
    const forkId = randomUUID(), spec = { ...live.spec, id: forkId, title: `${state.title || live.spec.title} (fork)` }
    this.ensure(spec)
    const fork = this.get(forkId)
    fork.runtimeId = randomUUID()
    // Saved history is copied for presentation; native context is provided only by thread/fork.
    this.database.structured.cloneHistory(id, forkId)
    this.emit(fork, { data: { type: 'session', phase: 'idle', nativeSessionId }, nativeSessionId })
    this.flush()
    return forkId
  }
  async submit(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = []): Promise<void> {
    const live = this.get(id), store = this.database.structured, state = store.snapshot(id)!
    if (live.submitting || active.has(state.phase)) throw new Error('A turn or request is already active in this session')
    if (state.phase === 'disconnected' && state.nativeSessionId) throw new Error('Execution became uncertain. Resume the native conversation explicitly before sending another turn.')
    if (typeof text !== 'string' || !text.trim() || text.length > 60_000) throw new Error('Prompt must contain 1–60000 characters')
    this.validateSettings(settings, state.capabilities)
    if (live.adapter && live.spec.provider === 'claude' && settings.effort !== state.settings.effort) throw new Error('Resume the Claude connection with the selected effort before sending this message')
    live.submitting = true
    try {
      const context = await this.attachments(live, attachments)
      const recalled = process.env.CONDUCTOR_LIVE_TESTS === '1' ? '' : this.context?.(live.spec, text) ?? ''
      const submitted = `${text.trim()}${context}${recalled ? `\n\n${recalled}` : ''}`
      store.update(id, { settings, title: state.title || text.trim().replace(/\s+/g, ' ').slice(0, 80) })
      this.reserveLive(live, settings, submitted)
      await this.connect(live)
      if (live.closed || this.live.get(id) !== live || !live.adapter) throw new Error('Session closed during initialization; no prompt was sent')
      // User-visible text is exactly the submitted context; provider adapters must not emit a duplicate user item.
      this.emit(live, { itemId: randomUUID(), data: { type: 'text', role: 'user', text: submitted, mode: 'snapshot' } })
      this.emit(live, { data: { type: 'session', phase: 'running' } })
      if (process.env.CONDUCTOR_LIVE_TESTS === '1') live.budget = new LiveRuntimeBudget(boundary => this.stopLive(live, boundary === 'active-runtime' ? 'Live prompt reached its 90 second active runtime allowance' : 'Live prompt reached its 30 second cumulative human-input wait allowance'))
      await live.adapter!.submit(submitted, settings, attachments.filter(item => item.kind === 'image'))
    } catch (error) {
      if (store.snapshot(id)?.phase === 'running') {
        this.emit(live, { data: { type: 'error', message: `Prompt dispatch failed: ${error instanceof Error ? error.message : 'Unknown provider error'}` } })
        this.emit(live, { data: { type: 'session', phase: 'failed' } })
      }
      throw error
    } finally { live.submitting = false }
  }
  private validateSettings(settings: SessionSettings, capabilities: import('../shared/structured-agent').ProviderCapabilities | undefined): void {
    if (!settings || !['default', 'read-only', 'accept-edits'].includes(settings.permission) || typeof settings.plan !== 'boolean') throw new Error('Invalid session settings')
    if (settings.plan && !capabilities?.plans) throw new Error('Planning is unavailable on this adapter baseline')
    if (capabilities?.permissions && !capabilities.permissions.includes(settings.permission)) throw new Error('Permission policy unsupported by this provider')
    if (settings.sandbox && !capabilities?.sandboxModes?.includes(settings.sandbox)) throw new Error('Execution sandbox unsupported by this provider')
    if (settings.approvalPolicy && !capabilities?.approvalPolicies?.includes(settings.approvalPolicy)) throw new Error('Approval policy unsupported by this provider')
    if (settings.model && (settings.model.length > 160 || /[\r\n\0]/.test(settings.model))) throw new Error('Invalid model')
    if (settings.effort && settings.effort !== 'auto' && !capabilities?.effort.includes(settings.effort)) throw new Error('Effort is not supported by this provider')
  }
  private async attachments(live: LiveSession, attachments: ContextAttachment[]): Promise<string> {
    if (!Array.isArray(attachments) || attachments.length > 20) throw new Error('Too many attachments')
    let context = ''
    let imageBytes = 0
    for (const item of attachments) {
      if (!item || typeof item.name !== 'string' || !['file', 'selection', 'editor', 'terminal', 'diagnostics', 'image'].includes(item.kind)) throw new Error('Invalid attachment')
      if (item.kind === 'image') {
        if (!this.database.structured.snapshot(live.spec.id)?.capabilities?.imageAttachments) throw new Error('Image attachments are unsupported by this provider connection')
        if (!item.path || !/\.(png|jpe?g|gif|webp)$/i.test(item.path)) throw new Error('A supported local PNG, JPEG, GIF or WebP image path is required')
        const imagePath = await workspacePath(live.spec.cwd, item.path)
        const { stat } = await import('node:fs/promises')
        const size = (await stat(imagePath)).size
        imageBytes += size
        if (size > 10 * 1024 * 1024 || live.spec.provider === 'claude' && imageBytes > 4 * 1024 * 1024) throw new Error('Image context exceeds the provider limit (10 MiB per image; 4 MiB total for Claude JSON transport)')
        item.path = imagePath
        context += `\n\n[Attached image: ${item.name}; path: ${item.path}; ${size} bytes. Native image content is submitted separately.]`
        continue
      }
      let content = item.content
      if (item.kind === 'file' && item.path && content === undefined) {
        const { readFile, stat } = await import('node:fs/promises')
        const path = await workspacePath(live.spec.cwd, item.path)
        if ((await stat(path)).size > 128_000) throw new Error('File context exceeds 128 KB; attach a selection')
        content = await readFile(path, 'utf8')
      } else if (item.path) await workspacePath(live.spec.cwd, item.path)
      if (typeof content !== 'string' || content.length > 128_000) throw new Error('Attachment content is unavailable or oversized')
      context += `\n\n[Attached ${item.kind}: ${item.name}${item.startLine ? ` lines ${item.startLine}-${item.endLine ?? item.startLine}` : ''}]\n${content}`
      if (context.length > 250_000) throw new Error('Total attached context exceeds 250 KB')
    }
    return context
  }
  private reserveLive(live: LiveSession, settings: SessionSettings, text: string): void {
    if (process.env.CONDUCTOR_LIVE_TESTS !== '1') return
    const allowed = validateLiveTurn(live.spec.provider as StructuredProvider, live.spec.cwd, text, settings)
    this.database.structured.reserveLive(allowed.suiteId, live.spec.provider as StructuredProvider, 2, 4, allowed.prompt)
  }
  async respond(response: InteractionResponse): Promise<void> {
    if (!response || typeof response.requestId !== 'string' || typeof response.runtimeId !== 'string') throw new Error('Invalid response')
    const live = this.get(response.sessionId), state = this.database.structured.snapshot(response.sessionId)!
    if (!live.adapter || live.runtimeId !== response.runtimeId || state.runtimeId !== response.runtimeId || live.responses.has(response.requestId)) throw new Error('This request is stale or already submitted')
    const item = state.items.find(item => item.runtimeId === response.runtimeId && item.data.type === 'interaction' && item.data.interaction.id === response.requestId && item.data.interaction.status === 'pending')
    if (!item || item.data.type !== 'interaction') throw new Error('Request is no longer pending')
    const interaction = item.data.interaction
    if (interaction.kind === 'approval' && !interaction.choices.some(choice => choice.id === response.decision)) throw new Error('Unsupported approval scope')
    if (interaction.kind === 'question') {
      if (!response.answers || Object.keys(response.answers).some(key => !interaction.questions?.some(question => question.id === key))) throw new Error('Invalid question answers')
      for (const question of interaction.questions ?? []) {
        const values = response.answers[question.id]
        const maximum = live.spec.provider === 'claude' ? 10_000 : 16_384
        if (!Array.isArray(values) || !values.length || !question.multiSelect && values.length !== 1 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > maximum)) throw new Error('Every question requires a valid answer within its supported format')
        if (question.allowCustom === false && values.some(value => !question.options.some(option => option.label === value))) throw new Error('Choose one of the answers offered by this question')
      }
    }
    live.responses.add(response.requestId)
    try {
      await live.adapter.respond(response)
      this.emit(live, { requestId: response.requestId, itemId: item.nativeItemId, data: { type: 'interaction', interaction: { ...interaction, status: 'resolved', outcome: response.decision ?? 'answered' } } })
    } catch (error) {
      // Uncertain transport delivery cannot be retried automatically or double submitted.
      this.emit(live, { requestId: response.requestId, data: { type: 'interaction', interaction: { ...interaction, status: 'expired', outcome: 'Response delivery uncertain' } } })
      throw error
    }
  }
  async interrupt(id: string): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (!live.adapter || !active.has(state.phase)) return
    this.emit(live, { data: { type: 'session', phase: 'interrupting' } })
    await live.adapter.interrupt()
  }
  private stopLive(live: LiveSession, message: string): void {
    if (!active.has(this.database.structured.snapshot(live.spec.id)!.phase) || live.shutdownTimer) return
    live.budget?.dispose(); live.budget = undefined
    const runtimeId = live.runtimeId
    this.emit(live, { data: { type: 'notice', message: `${message}. Interruption requested; in-flight work and delayed cost reporting may overshoot.` } })
    void this.interrupt(live.spec.id).catch(() => { /* Owned process cleanup is bounded independently of protocol acknowledgement. */ })
    live.shutdownTimer = setTimeout(() => {
      live.shutdownTimer = undefined
      if (live.runtimeId !== runtimeId || live.closed || !active.has(this.database.structured.snapshot(live.spec.id)!.phase)) return
      live.adapter?.dispose(); live.adapter = undefined
      this.emit(live, { data: { type: 'session', phase: 'disconnected', message } })
    }, 2000)
  }
  private emit(live: LiveSession, source: AdapterEvent): void {
    const store = this.database.structured, state = store.snapshot(live.spec.id)
    if (!state || live.closed) return
    // Host lifecycle hooks retain the exact tool identity; recover its recorded turn,
    // never associate output with a tool by its displayed name or position alone.
    if (source.itemId && !source.turnId) {
      const correlated = state.items.filter(item => item.runtimeId === live.runtimeId && item.nativeItemId === source.itemId).at(-1)
      if (correlated?.turnId) source = { ...source, turnId: correlated.turnId }
    }
    let data = source.data
    if (data.type === 'changes') data = { ...data, changes: data.changes.map(change => this.artifacts.fromPatch(live.spec.id, change, live.spec.cwd)) }
    if (data.type === 'tool' && data.output && data.output.length > 32_000) {
      const output = data.output
      try { data = { ...data, outputArtifactId: store.putOutput(live.spec.id, output), output: output.slice(-32_000) } }
      catch { data = { ...data, output: '[Output artifact unavailable: storage allowance reached. Bounded tail follows.]\n' + output.slice(-32_000) } }
    }
    const event = store.append({ ...source, data, schemaVersion: 1, id: randomUUID(), sequence: state.sequence + 1, sessionId: live.spec.id, runtimeId: live.runtimeId, provider: live.spec.provider as StructuredProvider, projectId: live.spec.projectId, workspaceId: live.spec.sessionId, cwd: live.spec.cwd, timestamp: new Date().toISOString(), nativeSessionId: source.nativeSessionId ?? state.nativeSessionId })
    this.pending.push(event)
    this.observe?.(live.spec, event)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 32)
    if (data.type === 'session') {
      const phase = data.phase === 'running' || data.phase === 'starting' || data.phase === 'interrupting' ? 'working' : data.phase.startsWith('waiting') ? 'waiting_input' : data.phase === 'completed' ? 'complete' : ['failed', 'disconnected'].includes(data.phase) ? 'error' : 'idle'
      const status = phase === 'working' || phase === 'idle' ? 'running' : phase
      this.database.setAgentStatus(live.spec.id, status, phase)
      this.broadcast('agent:status', { id: live.spec.id, status, phase })
      live.budget?.setPhase(data.phase)
      if (['disconnected', 'failed', 'interrupted', 'completed'].includes(data.phase)) this.artifacts.discardSession(live.spec.id)
      if (!active.has(data.phase)) { live.budget?.dispose(); live.budget = undefined }
    }
    if (data.type === 'usage' && data.costUsd && process.env.CONDUCTOR_LIVE_TESTS === '1') {
      store.addLiveCost(process.env.CONDUCTOR_LIVE_SUITE_ID!, live.spec.provider as StructuredProvider, data.costUsd)
      for (const session of this.live.values()) if (store.liveCostExceeded(process.env.CONDUCTOR_LIVE_SUITE_ID!, session.spec.provider as StructuredProvider)) this.stopLive(session, 'Live suite observed cost threshold reached')
    }
  }
  async review(id: string, artifactId: string, action: 'keep' | 'undo'): Promise<{ outcome: 'kept' | 'reverted' | 'conflict'; message?: string }> {
    const live = this.get(id), store = this.database.structured, artifact = store.artifact(id, artifactId)
    if (!['keep', 'undo'].includes(action)) throw new Error('Invalid review action')
    if (action === 'keep') { this.emit(live, { data: { type: 'review', artifactId, outcome: 'kept' } }); return { outcome: 'kept' } }
    if (active.has(store.snapshot(id)!.phase)) return { outcome: 'conflict', message: 'Wait until the agent finishes before restoring files' }
    const result = await this.artifacts.undo(live.spec.cwd, artifact)
    if (result.outcome === 'reverted') this.emit(live, { data: { type: 'review', artifactId, outcome: 'reverted' } })
    return result
  }
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const events = this.pending.splice(0)
    for (const id of new Set(events.map(event => event.sessionId))) this.database.structured.checkpoint(id)
    if (events.length) this.broadcast('structured:events', events)
  }
  killWhere(predicate: (spec: AgentSpec) => boolean): void {
    for (const [id, live] of this.live) if (predicate(live.spec)) {
      if (live.adapter) this.emit(live, { data: { type: 'session', phase: 'disconnected', message: 'Backend stopped; native resume is an explicit action' } })
      live.closed = true; live.budget?.dispose(); if (live.shutdownTimer) clearTimeout(live.shutdownTimer); live.adapter?.dispose(); this.live.delete(id)
    }
    this.flush()
  }
  dispose(): void { this.killWhere(() => true); this.database.structured.flush() }
}
