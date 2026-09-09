import { concreteModel } from '../shared/agent-model-selection'
import { readClaudeHistory, hasClaudeHistory, historyEvent } from './native-history'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { AgentActivityPhase, AgentSpec, LayoutNode, RuntimeEnsureResult } from '../shared/models'
import { settingsForRuntime } from '../shared/structured-agent'
import type { AdapterEvent, AgentEvent, ContextAttachment, InteractionResponse, Json, PromptOrigin, SessionPhase, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { AgentChangeHistory, RevertOutcome, RevertScope } from '../shared/agent-change-history'
import type { ConductorDatabase } from './database'
import { AgentArtifacts, workspacePath } from './agent-artifacts'
import { InteractionResponseRejectedError, SteeringUnavailableError, type AdapterOptions, type ProviderAdapter } from './providers/adapter'
import { createProviderAdapter } from './providers/factory'
import { validateLiveTurn } from './live-test-policy'
import { activeUsageCap, usageCapKey } from './usage-limit'
import { describeUsageCap, evaluateUsageCap, summarizeUsageRun, type UsageCapStatus } from '../shared/usage-accounting'
import { LiveRuntimeBudget } from './live-runtime-budget'
import { sanitizeDiagnostic } from './structured-store'

interface LiveSession {
  spec: AgentSpec
  executable: string
  runtimeId: string
  adapter?: ProviderAdapter
  starting?: Promise<void>
  handoff?: boolean
  dispatchingQueue?: boolean
  dispatchingPromptId?: string
  queueing?: Promise<void>
  steering?: boolean
  interrupting?: Promise<void>
  expediteInput?: Set<string>
  expediteQueued?: Set<string>
  expediteReady?: boolean
  sendAfterInterrupt?: boolean
  turnId?: string
  submitting: boolean
  closed: boolean
  responses: Set<string>
  budget?: LiveRuntimeBudget
  shutdownTimer?: NodeJS.Timeout
  /** The cap decision that stopped this conversation; cleared when the owner changes the cap. */
  capStop?: { reason: string; capKey: string }
  capTimer?: NodeJS.Timeout
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
    // `itemId` is the user message this context rides along with: recall is recorded against
    // it so the conversation can show which memories reached the turn.
    private context?: (spec: AgentSpec, prompt: string, itemId: string) => string,
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
    if (!previousSpec) store.update(spec.id, { settings: { ...state.settings, model: concreteModel(spec.provider, spec.model, state.capabilities), effort: spec.effort && spec.effort !== 'auto' ? spec.effort : undefined } })
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
      settings: settingsForRuntime(state.settings, runtimeId),
      newNativeSession: live.spec.provider === 'claude' && Boolean(state.nativeSessionId) && this.database.getSetting('newNative:' + id) === 'true' && !hasClaudeHistory(live.spec.cwd, state.nativeSessionId!),
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
    const options = this.options(live, live.runtimeId)
    live.adapter = this.factory(live.spec.provider as StructuredProvider, options)
    this.emit(live, { data: { type: 'session', phase: 'starting', capabilities: live.adapter.capabilities, settings: options.settings } })
    live.starting = live.adapter.start().catch(error => {
      this.emit(live, { data: { type: 'error', message: error instanceof Error ? error.message : 'Provider initialization failed' } })
      this.emit(live, { data: { type: 'session', phase: 'disconnected' } })
      live.adapter?.dispose(); live.adapter = undefined
      throw error
    }).finally(() => { live.starting = undefined })
    return live.starting
  }

  cliSpec(id: string): AgentSpec { return this.get(id).spec }
  private cliOwned(id: string): boolean { return this.database.getSetting('cliHandoff:' + id) !== null }
  async prepareCli(id: string): Promise<{ spec: AgentSpec; nativeSessionId: string; settings: SessionSettings; fresh: boolean }> {
    const live = this.get(id), store = this.database.structured
    let state = store.snapshot(id)!
    if (live.handoff || live.submitting || live.dispatchingQueue || live.queueing || state.queued || active.has(state.phase)) throw new Error('Finish or stop this turn and remove queued messages before switching to CLI.')
    live.handoff = true
    try {
      if (!this.cliOwned(id)) {
        if (live.spec.provider === 'codex') {
          await this.connect(live)
          const connected = store.snapshot(id)!
          // An empty native thread has no durable history until metadata is saved.
          // Persist its existing Conductor title before reading/resuming that exact ID.
          if (!connected.truncated && !connected.items.some(item => item.data.type === 'text' && item.data.role !== 'status')) {
            await live.adapter?.rename?.(connected.title || live.spec.title)
          }
        }
        state = store.snapshot(id)!
        if (active.has(state.phase)) throw new Error('The native conversation is still running. Stop it before switching.')
        let nativeSessionId = state.nativeSessionId
        if (!nativeSessionId) {
          nativeSessionId = randomUUID()
          this.database.setSetting('newNative:' + id, 'true')
          this.emit(live, { data: { type: 'session', phase: 'idle', nativeSessionId } })
        }
        const history = live.spec.provider === 'claude' ? await readClaudeHistory(live.spec.cwd, nativeSessionId) : await live.adapter?.history?.() ?? []
        const handoff = { id: randomUUID(), known: history.map((item) => item.id) }
        // Persist ownership before releasing the structured process.
        this.database.setSetting('cliHandoff:' + id, JSON.stringify(handoff))
      }
      const previous = live.adapter
      live.closed = true
      try { if (previous?.stop) await previous.stop(); else previous?.dispose() } catch (reason) { live.closed = false; throw reason }
      live.adapter = undefined; live.closed = false
      state = store.snapshot(id)!
      const settings = settingsForRuntime(state.settings)
      this.emit(live, { data: { type: 'session', phase: 'idle', view: 'cli', settings } })
      return { spec: live.spec, nativeSessionId: state.nativeSessionId!, settings, fresh: live.spec.provider === 'claude' && this.database.getSetting('newNative:' + id) === 'true' && !hasClaudeHistory(live.spec.cwd, state.nativeSessionId!) }
    } finally { live.handoff = false }
  }
  cancelCli(id: string): void {
    const live = this.get(id)
    this.database.removeSetting('cliHandoff:' + id)
    this.emit(live, { data: { type: 'session', phase: live.adapter ? 'idle' : 'disconnected', view: 'visual' } })
  }
  async finishCli(id: string): Promise<void> {
    const live = this.get(id)
    if (live.handoff) throw new Error('A view switch is already in progress')
    const serialized = this.database.getSetting('cliHandoff:' + id)
    if (!serialized) return
    live.handoff = true
    try {
      const handoff = JSON.parse(serialized) as { id: string; known: string[] }
      // A previous switch may have timed out while stopping its process.
      if (live.adapter) {
        live.closed = true
        try { if (live.adapter.stop) await live.adapter.stop(); else live.adapter.dispose(); live.adapter = undefined } finally { live.closed = false }
      }
      await this.connect(live)
      const state = this.database.structured.snapshot(id)!
      const history = live.spec.provider === 'claude' ? await readClaudeHistory(live.spec.cwd, state.nativeSessionId!) : await this.get(id).adapter?.history?.() ?? []
      const known = new Set(handoff.known)
      // A failed/retried import reuses the handoff identity, so journal replay reconciles each item.
      for (const item of history) if (!known.has(item.id)) this.emit(live, historyEvent(item, handoff.id))
      this.database.removeSetting('cliHandoff:' + id)
      this.emit(live, { data: { type: 'session', phase: state.phase, view: 'visual' } })
    } finally { live.handoff = false }
  }

  bindWorkspace(id: string, sessionId: string): void {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (live.spec.sessionId === sessionId) return
    const workspace = this.database.getSession(sessionId)
    if (!workspace || workspace.projectId !== live.spec.projectId || !this.database.listSessions(live.spec.projectId).some(item => item.id === sessionId)) throw new Error('A native conversation can move only to an open workspace in its project')
    if (active.has(state.phase) || live.submitting || live.handoff || live.queueing || state.queued || this.cliOwned(id)) throw new Error('Finish active work before moving this conversation')
    const contains = (node: LayoutNode): boolean => node.type === 'split' ? node.children.some(contains) : node.tabs.some(tab => tab.kind === 'agent' && tab.resourceId === id)
    if (this.database.listSessions(live.spec.projectId).some(item => item.id !== sessionId && contains(item.layout.root)) || this.database.listDetachedWindows().some(item => item.projectId === live.spec.projectId && item.sessionId !== sessionId && contains(item.layout.root))) throw new Error('This conversation is already open in another workspace. Show its existing tab first.')
    const process = this.database.listProcesses(live.spec.projectId).find(process => process.id === id)
    live.spec = { ...live.spec, sessionId }
    this.database.structured.rebindWorkspace(id, sessionId)
    this.database.upsertAgent(live.spec, process?.status ?? 'running', process?.activityPhase ?? 'idle')
    this.database.removeSetting('agentControlParent:' + id)
  }

  /** The composer chooses model, effort and permission for the next message, which can be long
   *  before that message exists. Persisting the choice keeps a reopened pane on what the user
   *  picked instead of resetting it to the registration defaults; it starts no runtime. */
  saveSettings(id: string, settings: SessionSettings): void {
    const state = this.database.structured.snapshot(id)
    if (!state) throw new Error('Session not found')
    this.validateSettings(settings, state.capabilities)
    this.database.structured.update(id, { settings })
  }

  async resume(id: string, settings?: SessionSettings): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (live.handoff || this.cliOwned(id)) throw new Error('Switch this conversation from CLI to Chat first')
    if (active.has(state.phase) || live.queueing) throw new Error('Session still has active work')
    if (!state.nativeSessionId) throw new Error('This history has no native conversation to resume')
    if (settings) { this.validateSettings(settings, state.capabilities); this.database.structured.update(id, { settings }) }
    live.closed = true; live.adapter?.dispose(); live.adapter = undefined; live.closed = false
    await this.connect(live)
  }
  async connectSession(id: string): Promise<void> {
    if (this.get(id).handoff || this.cliOwned(id)) throw new Error('Switch this conversation from CLI to Chat first')
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
    this.emit(fork, { data: { type: 'session', phase: 'idle', nativeSessionId, title: spec.title }, nativeSessionId })
    this.flush()
    return forkId
  }

  async queue(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = [], origin?: PromptOrigin): Promise<void> {
    return this.followup(id, text, settings, attachments, false, undefined, origin)
  }
  async steer(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = [], origin?: PromptOrigin): Promise<void> {
    return this.followup(id, text, settings, attachments, true, undefined, origin)
  }
  private async followup(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[], steer: boolean, queuedPromptId?: string, origin?: PromptOrigin): Promise<void> {
    const live = this.get(id), adapter = live.adapter, runtimeId = live.runtimeId, turnId = live.turnId
    const captured = structuredClone(attachments)
    settings = structuredClone(settings)
    // Serialize validation as well as insertion so slow file reads cannot reorder messages.
    const previous = live.queueing
    const queued = (async () => {
      if (previous) await previous.catch(() => undefined)
      const state = this.database.structured.snapshot(id)!
      if (live.handoff || this.cliOwned(id)) throw new Error('Switch this conversation from CLI to Chat first')
      if (!live.adapter || !['starting', 'running', 'waiting_input', 'waiting_approval', 'completed', 'idle'].includes(state.phase)) throw new Error('There is no active turn to queue behind')
      if (typeof text !== 'string' || !text.trim() || text.length > 60000) throw new Error('Prompt must contain 1-60000 characters')
      this.validateSettings(settings, state.capabilities)
      const context = await this.attachments(live, captured)
      let latest = this.database.structured.snapshot(id)!
      if (live.closed || this.live.get(id) !== live || live.handoff || this.cliOwned(id) || live.adapter !== adapter || live.runtimeId !== runtimeId || !['starting', 'running', 'waiting_input', 'waiting_approval', 'completed', 'idle'].includes(latest.phase)) throw new Error('The turn stopped before this message was queued. Your draft was kept.')
      let refusal = 'The current turn does not support steering'
      let maySteer = steer
      let refusedInputId: string | undefined
      if (steer && live.turnId === turnId && adapter?.steer && adapter.capabilities.steering && ['running', 'waiting_input', 'waiting_approval'].includes(latest.phase)) {
        this.reserveLive(live, latest.settings, text.trim() + context)
        if ((latest.pendingSteering?.length ?? 0) >= 100) throw new Error('There are already 100 pending steering messages')
        live.steering = true
        const inputId = randomUUID()
        this.setSteering(live, [...latest.pendingSteering ?? [], { id: inputId, text: text.trim(), settings: structuredClone(latest.settings), attachments: captured, runtimeId, turnId, status: 'sending', ...(origin ? { origin } : {}) }])
        // Transfer ownership before the native attempt. An uncertain response must
        // leave only the pending record, never an automatically drainable copy.
        if (queuedPromptId) this.setQueue(live, (latest.queuedPrompts ?? (latest.queued ? [latest.queued] : [])).filter(input => input.id !== queuedPromptId))
        try {
          await adapter.steer(text.trim() + context, settings, captured.filter(item => item.kind === 'image'), inputId)
          if (live.closed || this.live.get(id) !== live || live.runtimeId !== runtimeId) throw new Error('The runtime changed after steering was sent. Check the conversation before resending; your draft was kept.')
          return
        } catch (error) {
          if (!(error instanceof SteeringUnavailableError)) {
            this.reconcileInput(live, { data: { type: 'input_delivery', inputId, status: 'uncertain' } })
            throw new Error((error instanceof Error ? error.message : String(error)) + (queuedPromptId ? '. Steering was not confirmed; the pending input was retained. Check the conversation before resending.' : '. Steering was not confirmed; your draft was kept. Check the conversation before resending.'))
          }
          // A transferred queue entry has no composer draft to fall back to.
          // Retain a recoverable cancelled record until fallback queueing is safe.
          if (queuedPromptId) this.reconcileInput(live, { data: { type: 'input_delivery', inputId, status: 'cancelled' } })
          else this.setSteering(live, (this.database.structured.snapshot(id)?.pendingSteering ?? []).filter(input => input.id !== inputId))
          maySteer = false
          refusal = error.message
        } finally { live.steering = false }
        latest = this.database.structured.snapshot(id)!
        if (live.closed || this.live.get(id) !== live || live.handoff || this.cliOwned(id) || live.adapter !== adapter || live.runtimeId !== runtimeId || !['starting', 'running', 'waiting_input', 'waiting_approval', 'completed', 'idle'].includes(latest.phase)) throw new Error('The turn stopped before this message was queued. Your draft was kept.')
        if (queuedPromptId) refusedInputId = inputId
      }
      const prompts = latest.queuedPrompts ?? (latest.queued ? [latest.queued] : [])
      if (prompts.length >= 100) throw new Error('The queue is full (100 messages)')
      this.setQueue(live, [...prompts, { id: randomUUID(), text, settings: structuredClone(settings), attachments: captured, ...(maySteer ? { steer: true } : {}), ...(origin ? { origin } : {}) }])
      if (refusedInputId) this.setSteering(live, (this.database.structured.snapshot(id)?.pendingSteering ?? []).filter(input => input.id !== refusedInputId))
      if (steer) this.emit(live, { data: { type: 'notice', message: 'Message queued instead of steered: ' + refusal } })
      void this.drainQueue(live)
    })()
    live.queueing = queued
    try { await queued } finally { if (live.queueing === queued) live.queueing = undefined; void this.drainQueue(live) }
  }
  private setSteering(live: LiveSession, prompts: import('../shared/structured-agent').PendingSteering[], native?: AdapterEvent['native']): void {
    this.emit(live, { data: { type: 'steering', prompts }, native })
  }
  private reconcileInput(live: LiveSession, source: AdapterEvent): void {
    if (source.data.type !== 'input_delivery') return
    const { inputId, status } = source.data
    const state = this.database.structured.snapshot(live.spec.id)!
    const prompts = state.pendingSteering ?? []
    const input = prompts.find(prompt => prompt.id === inputId && prompt.runtimeId === live.runtimeId)
    if (!input) return
    if (status === 'delivered') {
      this.setSteering(live, prompts.filter(prompt => prompt.id !== inputId), source.native)
      live.expediteInput?.delete(inputId)
      this.emit(live, { turnId: input.turnId, itemId: inputId, data: { type: 'text', role: 'user', text: input.text, mode: 'snapshot', ...(input.attachments.length ? { attachments: input.attachments.map(({ content: _content, ...metadata }) => metadata) } : {}), ...(input.origin ? { origin: input.origin } : {}) }, native: source.native })
    } else {
      // A delayed ACK cannot downgrade a terminal/uncertain outcome.
      if (status === 'accepted' && input.status !== 'sending') return
      this.setSteering(live, prompts.map(prompt => prompt.id === inputId ? { ...prompt, status } : prompt), source.native)
    }
    queueMicrotask(() => { void this.drainQueue(live) })
  }
  private setQueue(live: LiveSession, prompts: import('../shared/structured-agent').QueuedPrompt[]): void {
    this.emit(live, { data: { type: 'queue', prompt: prompts[0] ?? null, prompts } })
  }
  cancelQueued(id: string, promptId?: string): import('../shared/structured-agent').QueuedPrompt | null {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    const pending = promptId ? state.pendingSteering?.find(input => input.id === promptId) : undefined
    if (pending) {
      if (!['cancelled', 'uncertain'].includes(pending.status)) throw new Error('The provider still owns this pending message')
      this.setSteering(live, state.pendingSteering!.filter(input => input.id !== pending.id))
      return pending
    }
    const prompts = state.queuedPrompts ?? (state.queued ? [state.queued] : [])
    const queued = promptId ? prompts.find(prompt => prompt.id === promptId) ?? null : prompts[0] ?? null
    if (live.dispatchingQueue && queued?.id === live.dispatchingPromptId) throw new Error('The queued message is already being sent')
    if (queued) this.setQueue(live, prompts.filter(prompt => prompt.id !== queued.id))
    return queued
  }
  private async drainQueue(live: LiveSession): Promise<void> {
    let state = this.database.structured.snapshot(live.spec.id)
    if (!state || live.closed || live.submitting || live.steering || live.dispatchingQueue || !live.adapter) return
    if (live.capStop && this.capSetting(live)?.key === live.capStop.capKey) return
    if (live.expediteReady && ['interrupted', 'completed'].includes(state.phase)) {
      const recovered = (state.pendingSteering ?? []).filter(input => live.expediteInput?.has(input.id) && input.status === 'cancelled')
      const queued = state.queuedPrompts ?? (state.queued ? [state.queued] : [])
      const held = queued.filter(input => live.expediteQueued?.has(input.id))
      live.expediteReady = false; live.expediteInput = undefined; live.expediteQueued = undefined
      if (recovered.length || held.length) {
        const ids = new Set(recovered.map(input => input.id))
        this.setSteering(live, (state.pendingSteering ?? []).filter(input => !ids.has(input.id)))
        this.setQueue(live, [...recovered.map(({ runtimeId: _runtime, turnId: _turn, status: _status, ...input }) => ({ ...input, steer: true })), ...held, ...queued.filter(input => !held.includes(input))])
        live.sendAfterInterrupt = true
        state = this.database.structured.snapshot(live.spec.id)!
      }
    }
    if (!state.queued) return
    const steerable = live.adapter.capabilities.steering && ['running', 'waiting_input', 'waiting_approval'].includes(state.phase)
    const queued = (steerable && state.queuedPrompts?.find(input => input.steer)) || state.queued
    const canSteer = queued.steer && steerable
    if (!canSteer && !['completed', 'idle'].includes(state.phase) && !(state.phase === 'interrupted' && live.sendAfterInterrupt)) return
    live.dispatchingQueue = true
    live.dispatchingPromptId = queued.id
    let sent = false
    try {
      if (canSteer) await this.followup(live.spec.id, queued.text, queued.settings, structuredClone(queued.attachments), true, queued.id, queued.origin)
      else { live.sendAfterInterrupt = false; await this.submit(live.spec.id, queued.text, queued.settings, structuredClone(queued.attachments), queued.origin) }
      const latest = this.database.structured.snapshot(live.spec.id)!
      this.setQueue(live, (latest.queuedPrompts ?? (latest.queued ? [latest.queued] : [])).filter(prompt => prompt.id !== queued.id))
      sent = true
    } catch (reason) {
      const retained = this.database.structured.snapshot(live.spec.id)?.queuedPrompts?.some(input => input.id === queued.id)
      this.emit(live, { data: { type: 'notice', message: (retained ? 'Queued message was not sent. It is still available above the composer: ' : 'Steering delivery was not confirmed. Check the retained pending message above the composer: ') + (reason instanceof Error ? reason.message : String(reason)) } })
    } finally {
      live.dispatchingQueue = false
      live.dispatchingPromptId = undefined
      // Some runtimes finish before submit resolves; that completion still drains the next item.
      if (sent) queueMicrotask(() => { void this.drainQueue(live) })
    }
  }

  async submit(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = [], origin?: PromptOrigin): Promise<void> {
    const live = this.get(id), store = this.database.structured, state = store.snapshot(id)!
    if (live.handoff || this.cliOwned(id)) throw new Error('Switch this conversation from CLI to Chat first')
    if (live.submitting || live.steering || active.has(state.phase)) throw new Error('A turn or request is already active in this session')
    this.assertUnderUsageCap(live)
    if (state.phase === 'disconnected' && state.nativeSessionId) throw new Error('Execution became uncertain. Resume the native conversation explicitly before sending another turn.')
    if (typeof text !== 'string' || !text.trim() || text.length > 60_000) throw new Error('Prompt must contain 1–60000 characters')
    settings = settingsForRuntime(settings, live.adapter ? live.runtimeId : undefined)
    this.validateSettings(settings, state.capabilities)
    live.submitting = true
    try {
      const context = await this.attachments(live, attachments)
      const userItemId = randomUUID()
      const recalled = process.env.CONDUCTOR_LIVE_TESTS === '1' ? '' : this.context?.(live.spec, text, userItemId) ?? ''
      const submitted = `${text.trim()}${context}${recalled ? `\n\n${recalled}` : ''}`
      this.reserveLive(live, settings, submitted)
      store.update(id, { settings, title: state.title || text.trim().replace(/\s+/g, ' ').slice(0, 80) })
      await this.connect(live)
      if (live.closed || this.live.get(id) !== live || !live.adapter) throw new Error('Session closed during initialization; no prompt was sent')
      // Keep expanded file bytes and recalled context in the provider request, outside the user's message.
      this.emit(live, { itemId: userItemId, data: { type: 'text', role: 'user', text: text.trim(), mode: 'snapshot', ...(attachments.length ? { attachments: attachments.map(({ content: _content, ...metadata }) => metadata) } : {}), ...(origin ? { origin } : {}) } })
      this.emit(live, { data: { type: 'session', phase: 'running' } })
      if (process.env.CONDUCTOR_LIVE_TESTS === '1') live.budget = new LiveRuntimeBudget(boundary => this.stopLive(live, boundary === 'active-runtime' ? 'Live prompt reached its 90 second active runtime allowance' : 'Live prompt reached its 30 second cumulative human-input wait allowance'))
      await live.adapter!.submit(submitted, settings, attachments.filter(item => item.kind === 'image'))
    } catch (error) {
      if (store.snapshot(id)?.phase === 'running') {
        this.emit(live, { data: { type: 'error', message: `Prompt dispatch failed: ${error instanceof Error ? error.message : 'Unknown provider error'}` } })
        this.emit(live, { data: { type: 'session', phase: 'failed' } })
      }
      throw error
    } finally { live.submitting = false; void this.drainQueue(live) }
  }
  private validateSettings(settings: SessionSettings, capabilities: import('../shared/structured-agent').ProviderCapabilities | undefined): void {
    if (!settings || !['default', 'read-only', 'accept-edits', 'auto'].includes(settings.permission) || typeof settings.plan !== 'boolean') throw new Error('Invalid session settings')
    if (settings.temporaryPermission && (typeof settings.temporaryPermission.runtimeId !== 'string' || !['default', 'read-only', 'accept-edits', 'auto'].includes(settings.temporaryPermission.restore))) throw new Error('Invalid temporary permission scope')
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
      item.content = content
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
    if (interaction.kind === 'approval' && !interaction.choices.some(choice => choice.id === response.decision && !choice.disabled)) throw new Error('Unsupported approval scope')
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
      const current = this.database.structured.snapshot(response.sessionId)?.items.find(entry => entry.runtimeId === response.runtimeId && entry.data.type === 'interaction' && entry.data.interaction.id === response.requestId)
      if (current?.data.type === 'interaction' && current.data.interaction.status === 'pending') this.emit(live, { requestId: response.requestId, itemId: item.nativeItemId, data: { type: 'interaction', interaction: { ...interaction, status: 'resolved', outcome: response.decision ?? 'answered' } } })
    } catch (error) {
      if (error instanceof InteractionResponseRejectedError) {
        live.responses.delete(response.requestId)
        throw error
      }
      // Uncertain transport delivery cannot be retried automatically or double submitted.
      this.emit(live, { requestId: response.requestId, data: { type: 'interaction', interaction: { ...interaction, status: 'expired', outcome: 'Response delivery uncertain' } } })
      throw error
    }
  }
  async interrupt(id: string, expediteSubmittedInput = false): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (live.interrupting) return live.interrupting
    if (!live.adapter || !active.has(state.phase)) return
    // Escape expedites only already-submitted input; composer drafts never reach here.
    const pending = (state.pendingSteering ?? []).filter(input => input.runtimeId === live.runtimeId && ['sending', 'accepted'].includes(input.status))
    live.expediteInput = expediteSubmittedInput && pending.length ? new Set(pending.map(input => input.id)) : undefined
    live.expediteQueued = expediteSubmittedInput ? new Set((state.queuedPrompts ?? []).filter(input => input.steer && input.id !== live.dispatchingPromptId).map(input => input.id)) : undefined
    this.emit(live, { data: { type: 'session', phase: 'interrupting' } })
    const interrupted = live.adapter.interrupt()
    live.interrupting = interrupted
    try { await interrupted; live.expediteReady = Boolean(live.expediteInput?.size || live.expediteQueued?.size) }
    catch (error) { live.expediteInput = undefined; live.expediteQueued = undefined; live.expediteReady = false; throw error }
    finally { live.interrupting = undefined; void this.drainQueue(live) }
  }
  private stopLive(live: LiveSession, message: string): void {
    if (!active.has(this.database.structured.snapshot(live.spec.id)!.phase) || live.shutdownTimer) return
    live.budget?.dispose(); live.budget = undefined
    const runtimeId = live.runtimeId
    this.emit(live, { data: { type: 'notice', message: `${message}. Interruption requested; in-flight work and delayed cost reporting may overshoot.` } })
    void this.interrupt(live.spec.id, false).catch(() => { /* Owned process cleanup is bounded independently of protocol acknowledgement. */ })
    live.shutdownTimer = setTimeout(() => {
      live.shutdownTimer = undefined
      if (live.runtimeId !== runtimeId || live.closed || !active.has(this.database.structured.snapshot(live.spec.id)!.phase)) return
      live.adapter?.dispose(); live.adapter = undefined
      this.emit(live, { data: { type: 'session', phase: 'disconnected', message } })
    }, 2000)
  }

  /* --- Usage caps ------------------------------------------------------- *
   * The cap is the owner's own stop rule. It reads the same provider-reported
   * figures the usage panel shows and never estimates a percentage the provider
   * did not report; an unmeasurable cap simply does not fire. Unlike a provider
   * usage limit, a cap is never continued automatically: `continueOnLimit`
   * resumes work when the provider's window reopens, which is precisely what a
   * deliberate cap exists to prevent.
   * ---------------------------------------------------------------------- */

  private capSetting(live: LiveSession): { setting: import('../shared/usage-accounting').UsageCapSetting; scope: string; key: string } | null {
    const stored = {
      tab: this.database.getSetting(usageCapKey('tab', live.spec.id)),
      workspace: this.database.getSetting(usageCapKey('workspace', live.spec.sessionId)),
      default: this.database.getSetting(usageCapKey('default'))
    }
    const resolved = activeUsageCap(stored)
    // The key changes whenever the owner edits any cap, which releases a previous stop.
    return resolved ? { setting: resolved.setting, scope: resolved.scope, key: JSON.stringify([stored.tab, stored.workspace, stored.default]) } : null
  }

  /** The cap status for this conversation, or null when no cap applies. */
  usageCapStatus(id: string): (UsageCapStatus & { scope: string; description: string }) | null {
    const live = this.live.get(id)
    if (!live) return null
    const configured = this.capSetting(live)
    const state = this.database.structured.snapshot(id)
    if (!configured || configured.setting.metric === 'none' || !state) return null
    const report = summarizeUsageRun(state.items)
    return { ...evaluateUsageCap(configured.setting, report.conversation), scope: configured.scope, description: describeUsageCap(configured.setting, report.currentWindows) }
  }

  private assertUnderUsageCap(live: LiveSession): void {
    const configured = this.capSetting(live)
    if (!configured) { live.capStop = undefined; return }
    // Re-evaluated rather than remembered, so raising the cap or a window rollover releases the stop.
    const status = this.usageCapStatus(live.spec.id)
    if (!status?.reached) { live.capStop = undefined; return }
    live.capStop = { reason: status.detail, capKey: configured.key }
    throw new Error(`Usage cap reached, so this conversation is stopped. ${status.detail} Raise or clear the cap under Usage & limits to continue.`)
  }

  /** Called after every recorded usage report; stops cleanly the first time the cap is crossed. */
  private enforceUsageCap(live: LiveSession): void {
    const configured = this.capSetting(live)
    if (!configured) { live.capStop = undefined; return }
    if (live.capStop?.capKey === configured.key) return
    const status = this.usageCapStatus(live.spec.id)
    if (!status?.reached) return
    live.capStop = { reason: status.detail, capKey: configured.key }
    // Drop queued work first: a cap that stops the turn but lets the queue restart it is not a cap.
    const state = this.database.structured.snapshot(live.spec.id)
    if (state?.queuedPrompts?.length || state?.queued) this.setQueue(live, [])
    this.emit(live, { data: { type: 'notice', message: `Usage cap reached (${configured.scope} cap). ${status.detail} Stopping this conversation. Automatic limit continuation does not apply to a cap you set; raise or clear it under Usage & limits to continue.`, payload: { metric: status.cap.metric, basis: status.cap.basis, limit: status.limit, value: status.value ?? null, scope: configured.scope } } })
    const phase = this.database.structured.snapshot(live.spec.id)?.phase
    if (phase && active.has(phase)) {
      void this.interrupt(live.spec.id, false).catch(() => { /* The stop is recorded either way; the process is cleaned up on dispose. */ })
    }
  }

  private emit(live: LiveSession, source: AdapterEvent): void {
    const store = this.database.structured, state = store.snapshot(live.spec.id)
    if (!state || live.closed) return
    if (source.data.type === 'input_delivery') { this.reconcileInput(live, source); return }
    // Host lifecycle hooks retain the exact tool identity; recover its recorded turn,
    // never associate output with a tool by its displayed name or position alone.
    if (source.itemId && !source.turnId) {
      const correlated = state.items.filter(item => item.runtimeId === live.runtimeId && item.nativeItemId === source.itemId).at(-1)
      if (correlated?.turnId) source = { ...source, turnId: correlated.turnId }
    }
    if (source.data.type === 'session' && source.turnId) live.turnId = source.turnId
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
    // Claude reports usage per stream delta, so evaluating a cap on every event would
    // rescan the whole timeline many times a second. A cap acting a moment late is
    // indistinguishable to the owner; rescanning per delta is not.
    if (data.type === 'usage' && !live.capTimer) live.capTimer = setTimeout(() => {
      live.capTimer = undefined
      if (live.closed) return
      try { this.enforceUsageCap(live) } catch { /* A cap never breaks the event pipeline it observes. */ }
    }, 250)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 32)
    if (data.type === 'session') queueMicrotask(() => { void this.drainQueue(live) })
    if (data.type === 'session') {
      const phase: AgentActivityPhase = data.phase === 'running' || data.phase === 'starting' || data.phase === 'interrupting' ? 'working' : data.phase.startsWith('waiting') ? 'waiting_input' : data.phase === 'completed' ? 'complete' : data.phase === 'failed' ? 'failed' : data.phase === 'disconnected' ? 'disconnected' : data.phase === 'interrupted' ? 'stopped' : 'idle'
      // AgentRecord.status is a coarser union than the phase, so the unhappy phases collapse
      // back onto its own vocabulary here rather than leaking new values into stored rows.
      const status = phase === 'working' || phase === 'idle' ? 'running' : phase === 'failed' || phase === 'disconnected' ? 'error' : phase === 'stopped' ? 'exited' : phase
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
  /** The conversation's own change history, independent of whether anything was committed. */
  changeHistory(id: string): Promise<AgentChangeHistory> {
    return this.artifacts.changeHistory(id, this.get(id).spec.cwd)
  }
  /** Restore files from this conversation's snapshots. Recorded in the timeline so the
   *  conversation itself shows that the owner took the work back. */
  async revertChanges(id: string, scope: RevertScope): Promise<RevertOutcome> {
    const live = this.get(id)
    if (active.has(this.database.structured.snapshot(id)!.phase)) return { reverted: [], blocked: [], message: 'Wait until the agent finishes before restoring files.' }
    const outcome = await this.artifacts.revertChanges(id, live.spec.cwd, scope)
    for (const entry of outcome.reverted) for (const artifactId of entry.artifactIds) this.emit(live, { data: { type: 'review', artifactId, outcome: 'reverted' } })
    return outcome
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
      live.closed = true; live.budget?.dispose(); if (live.shutdownTimer) clearTimeout(live.shutdownTimer); if (live.capTimer) clearTimeout(live.capTimer); live.adapter?.dispose(); this.live.delete(id)
    }
    this.flush()
  }
  dispose(): void { this.killWhere(() => true); this.database.structured.flush() }
}
