import { concreteModel } from '../shared/agent-model-selection'
import { sessionCheckpoint } from './local-models/session-checkpoint'
import { deriveConversationTitle } from '../shared/conversation-title'
import { readClaudeHistory, hasClaudeHistory, readGrokHistory, hasGrokHistory, historyEvent } from './native-history'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { AgentActivityPhase, AgentSpec, LayoutNode, RuntimeEnsureResult } from '../shared/models'
import { isFrontierModel, MAX_PROMPT_CHARS, PROVIDER_SAFEGUARD_REFUSAL, settingsForRuntime, WIZARD_MODEL_HINT, wizardActive } from '../shared/structured-agent'
import type { ActivityStatus, AdapterEvent, AgentEvent, ContextAttachment, InteractionResponse, Json, PromptDispatchAuthority, PromptOrigin, QueuedPrompt, SessionPhase, SessionSettings, StructuredProvider } from '../shared/structured-agent'
import type { AgentChangeHistory, RevertOutcome, RevertScope } from '../shared/agent-change-history'
import type { ConductorDatabase } from './database'
import { AgentArtifacts, workspacePath } from './agent-artifacts'
import { InteractionResponseRejectedError, SteeringUnavailableError, type AdapterOptions, type ProviderAdapter } from './providers/adapter'
import { createProviderAdapter } from './providers/factory'
import { validateLiveTurn } from './live-test-policy'
import { activeUsageCap, parseUsageLimitReset, usageCapKey } from './usage-limit'
import { carriesAccountLimits, describeAccountLimits, describeUsageCap, evaluateUsageCap, recordAccountLimits, summarizeContext, summarizeUsageRun, type AccountLimitRecord, type AccountLimitsReport, type UsageCapStatus } from '../shared/usage-accounting'
import { LiveRuntimeBudget } from './live-runtime-budget'
import { sanitizeDiagnostic } from './structured-store'
import { rememberedBrowserTools, rememberBrowserTools, rememberedPermission, rememberPermission } from './app-settings'
import { assertLocalControlAllowed } from './local-models/tools.ts'
import { normaliseContract } from './local-models/completion.ts'
import { composeLocalPrompt } from './local-models/briefing.ts'
import { LOCAL_MODEL_SETUP_ERROR_CODE } from '../shared/local-models.ts'
import { ApprovalReviewGate, type ApprovalReviewRouting } from './approval-review-gate'

interface LiveSession {
  spec: AgentSpec
  executable: string
  runtimeId: string
  adapter?: ProviderAdapter
  starting?: Promise<void>
  handoff?: boolean
  dispatchingQueue?: boolean
  dispatchingPromptId?: string
  dispatchingPromptIds?: Set<string>
  queueing?: Promise<void>
  steering?: boolean
  interrupting?: Promise<void>
  expediteInput?: Set<string>
  expediteQueued?: Set<string>
  expediteReady?: boolean
  sendAfterInterrupt?: boolean
  /** Queued messages already dispatched once into a failed phase; never retried a second time. */
  failedDrain?: Set<string>
  turnId?: string
  submitting: boolean
  closed: boolean
  responses: Set<string>
  nativeAcceptance?: Map<string, { timer: NodeJS.Timeout; resolve(): void; reject(reason: Error): void }>
  /** The current provider process was launched with the previous browser-MCP preference. */
  browserConfigStale?: boolean
  budget?: LiveRuntimeBudget
  /** Snapshot failure reasons already reported in this conversation, so an unactionable
   *  reason is stated once instead of on every tool call that hits it. */
  snapshotNotices?: Set<string>
  shutdownTimer?: NodeJS.Timeout
  activityPhase?: AgentActivityPhase
  /** The background-task count this conversation last reported, so a change in the provider's
   *  inventory between turns can be noticed and restated. */
  backgroundTasks?: number
  /** The cap decision that stopped this conversation; cleared when the owner changes the cap. */
  capStop?: { reason: string; capKey: string }
  capTimer?: NodeJS.Timeout
  /** Set while the provider's own usage window is closed; the moment it reopens, in ISO. */
  limitResumeAt?: string
  currentTurn?: { text: string; settings: SessionSettings; attachments: ContextAttachment[]; origin?: PromptOrigin; fallbackAttempted: boolean }
  refusalFallback?: { text: string; settings: SessionSettings; attachments: ContextAttachment[]; origin?: PromptOrigin; model: string; notice: string }
}
type Factory = (provider: StructuredProvider, options: AdapterOptions) => ProviderAdapter
const active = new Set<SessionPhase>(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
/** Settings row holding the newest reported allowance per provider and bucket (`usageLimits`). */
const ACCOUNT_LIMITS_KEY = 'usageLimits.latest'
/** Activity states a conversation can be cut off in; anything else has already settled. A
 *  conversation waiting on background work is one of them: that work belongs to the runtime
 *  process, so losing the connection ends it rather than leaving it running somewhere. */
const inFlight = new Set<AgentActivityPhase>(['working', 'waiting_input', 'waiting_background'])
/** A subagent in one of these has not produced its result yet, whatever its parent turn says. */
const runningSubagent = new Set<ActivityStatus>(['preparing', 'running', 'awaiting_approval'])
/** The runtime's own lifecycle vocabulary, in the terms every activity indicator speaks. */
const activityPhaseOf = (phase: SessionPhase): AgentActivityPhase =>
  phase === 'running' || phase === 'starting' || phase === 'interrupting' ? 'working'
    : phase.startsWith('waiting') ? 'waiting_input'
      : phase === 'completed' ? 'complete'
        : phase === 'failed' ? 'failed'
          : phase === 'disconnected' ? 'disconnected'
            : phase === 'interrupted' ? 'stopped' : 'idle'

const queuedText = (prompts: QueuedPrompt[]): string => prompts.length === 1 ? prompts[0]!.text.trim() : prompts
  .map((prompt, index) => `--- Queued message ${index + 1} of ${prompts.length}${prompt.origin ? ` (${prompt.origin.label})` : ''} ---\n\n${prompt.text.trim()}`)
  .join('\n\n')

const fallbackAfterRefusal = (provider: StructuredProvider, model: string): { model: string; notice: string } | null => {
  if (provider === 'claude' && /fable/i.test(model)) return { model: 'opus[1m]', notice: 'Fable refused this turn; continuing on Opus 5.5' }
  if (provider === 'claude' && /opus/i.test(model)) return { model: 'sonnet', notice: 'Opus 5.5 refused this turn; continuing on Sonnet 5' }
  if (provider === 'codex' && /astra/i.test(model)) return { model: 'gpt-5.6-sol', notice: 'Astra refused this turn; continuing on Sol' }
  return null
}

/** Only a public, renderer-understood error code crosses the adapter boundary. Provider errors
 *  can carry arbitrary fields, so never project an unrecognised value into durable history. */
const safeErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && error.code === LOCAL_MODEL_SETUP_ERROR_CODE
    ? LOCAL_MODEL_SETUP_ERROR_CODE
    : undefined

export class StructuredSessions {
  private approvalGate: ApprovalReviewGate
  private reviewRouting?: ApprovalReviewRouting
  setApprovalReviewRouting(routing: ApprovalReviewRouting): void { this.reviewRouting = routing; this.approvalGate.routing = routing }
  markApprovalReviewer(id: string): void { this.database.setSetting('approval-reviewer:' + id, 'true') }
  isApprovalReviewer(id: string): boolean { return this.database.getSetting('approval-reviewer:' + id) === 'true' }
  /** Whether this process holds a runtime for the conversation (connected or connecting). */
  hasRuntime(id: string): boolean { const live = this.live.get(id); return Boolean(live?.adapter || live?.starting) }
  private localControl?: (spec: AgentSpec, method: string, args: Record<string, unknown>) => Promise<unknown>
  setLocalControl(handler: (spec: AgentSpec, method: string, args: Record<string, unknown>) => Promise<unknown>): void {
    this.localControl = handler
  }
  private promptDispatchAuthorityGuard?: (authority: PromptDispatchAuthority, spec: AgentSpec) => void
  setPromptDispatchAuthorityGuard(guard: (authority: PromptDispatchAuthority, spec: AgentSpec) => void): void {
    this.promptDispatchAuthorityGuard = guard
  }
  private live = new Map<string, LiveSession>()
  private pending: AgentEvent[] = []
  private flushTimer?: NodeJS.Timeout
  private artifacts: AgentArtifacts
  private continuationTimers = new Map<string, NodeJS.Timeout>()
  constructor(
    private database: ConductorDatabase,
    private resolveExecutable: (provider: StructuredProvider) => string | null,
    private broadcast: (channel: string, payload: unknown) => void,
    private factory: Factory = createProviderAdapter,
    // `itemId` is the user message this context rides along with: recall is recorded against
    // it so the conversation can show which memories reached the turn. `runtimeId` names the
    // adapter the message will reach, or is '' when dispatching it is what creates the adapter,
    // so the caller can tell a runtime that has already been briefed from a new one.
    private context?: (spec: AgentSpec, prompt: string, itemId: string, runtimeId: string, context?: { percent: number }) => string,
    private observe?: (spec: AgentSpec, event: AgentEvent) => void,
    // Conductor-owned MCP servers for one session, serialized for the CLI's --mcp-config. Bound
    // at launch because a running conversation cannot be handed a new server later.
    private mcp?: { configure(spec: AgentSpec): string; release(agentSessionId: string): void }
  ) {
    this.artifacts = new AgentArtifacts(database.structured)
    this.approvalGate = new ApprovalReviewGate(database, id => database.structured.snapshot(id)?.settings,
      (id, runtimeId, source) => { const live = this.live.get(id); if (live && live.runtimeId === runtimeId && !live.closed) this.emit(live, source, true) },
      response => this.respond(response, true))
  }

  ensure(spec: AgentSpec): RuntimeEnsureResult {
    this.validateSpec(spec)
    const store = this.database.structured
    const previousSpec = store.spec<AgentSpec>(spec.id)
    if (previousSpec && (previousSpec.projectId !== spec.projectId || previousSpec.provider !== spec.provider || realpathSync(previousSpec.cwd) !== realpathSync(spec.cwd))) throw new Error('A session cannot be rebound to a different provider or workspace')
    const executable = process.env.CONDUCTOR_OFFLINE_TESTS === '1' ? process.execPath : this.resolveExecutable(spec.provider as StructuredProvider)
    // Local is an internal adapter, not an external CLI. Its setup is validated by start(),
    // which emits the actionable local-setup-required error when config or weights are absent.
    const available = spec.provider === 'local' || Boolean(executable)
    if (!store.snapshot(spec.id)) this.database.upsertAgent(spec, 'running', 'idle')
    const state = store.register(spec.id, spec.projectId, spec.provider as StructuredProvider, spec)
    // A brand-new conversation opens with the browser tools on — unless the owner last switched
    // them off for this provider (saveSettings remembers the composer's toggle) — whoever opened
    // it: an owner tab, a coworker a controller opened, or a router task. An existing conversation
    // keeps its own choice, and local models have no browser.
    const browserOn = (spec.provider === 'claude' || spec.provider === 'codex' || spec.provider === 'grok') && (rememberedBrowserTools(key => this.database.getSetting(key), spec.provider) ?? true)
    if (!previousSpec) store.update(spec.id, { settings: { ...state.settings, model: concreteModel(spec.provider, spec.model, state.capabilities), effort: spec.effort && spec.effort !== 'auto' ? spec.effort : undefined, ...(browserOn ? { browserMcp: true } : {}) } })
    // Registration constructs no process. Views subscribe to this backend resource.
    if (!this.live.has(spec.id)) this.live.set(spec.id, { spec: previousSpec ?? spec, executable: executable ?? '', runtimeId: '', submitting: false, closed: false, responses: new Set() })
    const live = this.live.get(spec.id)!
    // Re-resolved rather than kept from the first registration. A provider CLI installed after this
    // session was opened - or one that was simply not on the PATH the app was launched with - left
    // the live entry holding an empty string for ever, so every later turn failed with "Provider
    // executable unavailable" while `ensure` itself kept reporting the session as available.
    live.executable = executable ?? ''
    // The registered spec is otherwise frozen at first registration, so a conversation opened
    // before the owner switched limit continuation on kept answering `false` for ever. This is
    // the one field the owner can still change, so every `ensure` carries the current answer.
    // A wizard conversation continues after a usage limit whatever its workspace says.
    this.setContinueOnLimit(spec.id, Boolean(spec.continueOnLimit) || wizardActive(store.snapshot(spec.id)?.settings, spec.provider))
    // A wait that outlives the app, a closed tab, or a backend restart is only re-armed here:
    // the timer lives in this process, the reset time lives in SQLite.
    this.armPersistedContinuation(live)
    if (!previousSpec) {
      const legacy = this.database.getAgentTranscript(spec.id)
      if (legacy) {
        let outputArtifactId: string | undefined
        try { outputArtifactId = store.putOutput(spec.id, legacy) } catch { /* Original legacy bytes remain in their existing SQLite transcript. */ }
        this.emit(live, { data: { type: 'notice', message: 'Saved pre-upgrade terminal history. Native conversation identity was not recorded; sending a message here starts a new conversation.', outputArtifactId } })
      }
    }
    if (!state.capabilities && available) {
      const adapter = this.factory(spec.provider as StructuredProvider, this.options(live, randomUUID()))
      const projection = store.snapshot(spec.id)!
      projection.capabilities = adapter.capabilities
      store.checkpoint(spec.id)
    }
    // A brand-new conversation opens on the owner's remembered mode for this provider — Auto until
    // they ever choose otherwise — the same preference a manually opened renderer tab seeds from
    // localStorage (permission-memory.ts); an already-registered session keeps whatever permission
    // its own history carries, and only a mode this runtime just advertised as supported is applied.
    if (!previousSpec) {
      const remembered = rememberedPermission(key => this.database.getSetting(key), spec.provider as StructuredProvider) ?? 'auto'
      const capabilities = store.snapshot(spec.id)?.capabilities
      const offered = capabilities?.permissions
      // A runtime that does not offer the neutral default at all (the local models never ask
      // for anything, so 'Ask' would be a mode they cannot honour) opens on its own first mode
      // instead of a permission the composer could not show as selected.
      const opening = remembered && offered?.includes(remembered) ? remembered
        : offered?.length && !offered.includes(store.snapshot(spec.id)!.settings.permission) ? offered[0]
          : undefined
      if (opening) store.update(spec.id, { settings: { ...store.snapshot(spec.id)!.settings, permission: opening } })
    }
    return { id: spec.id, available, status: available ? 'running' : 'unavailable', transcript: '', executable: executable ?? undefined, model: state.settings.model ?? spec.model ?? 'default', message: available ? undefined : 'Provider CLI not found. Configure its executable before connecting.' }
  }
  private validateSpec(spec: AgentSpec): void {
    if (!spec || !/^[a-zA-Z0-9_-]{1,160}$/.test(spec.id) || !['claude', 'codex', 'grok', 'local'].includes(spec.provider)) throw new Error('Invalid structured agent session')
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
      mcpConfig: this.isApprovalReviewer(id) || live.spec.provider === 'local' || !state.settings.browserMcp ? '' : this.mcp?.configure(live.spec) ?? '',
      approvalReviewer: this.isApprovalReviewer(id),
      reviewApprovals: Boolean(this.reviewRouting?.enabled(live.spec)),
      authorizeTool: (name, input) => this.approvalGate.guardTool(live.spec, name, input),
      ...(live.spec.provider === 'local' ? { localTaskId: id,
        localCheckpoint: sessionCheckpoint(this.database, { projectId: live.spec.projectId, taskId: id }, () => {
          if (live.closed || live.runtimeId !== runtimeId || this.live.get(id) !== live) throw new Error('Local checkpoint is unavailable for this runtime')
          this.validateSpec(live.spec)
          if (this.database.structured.spec<AgentSpec>(id)?.projectId !== live.spec.projectId) throw new Error('Local checkpoint session is no longer registered')
        }),
        localControl: async (method: string, args: Record<string, unknown>) => {
        if (live.closed || live.runtimeId !== runtimeId || !this.localControl) throw new Error('Local Conductor bridge is unavailable for this runtime')
        this.validateSpec(live.spec)
        const current = this.database.structured.snapshot(id)!
        assertLocalControlAllowed(method, args, current.settings.permission === 'read-only' || current.settings.sandbox === 'read-only' || current.settings.plan)
        return this.localControl(live.spec, method, args)
      } } : {}),
      newNativeSession: live.spec.provider === 'claude' && Boolean(state.nativeSessionId) && this.database.getSetting('newNative:' + id) === 'true' && !hasClaudeHistory(live.spec.cwd, state.nativeSessionId!),
      emit: event => { if (live.runtimeId === runtimeId && !live.closed) this.emit(live, event) },
      beforeTool: async (itemId, paths) => {
        if (live.runtimeId !== runtimeId || live.closed) return
        try { await this.artifacts.beforeTool(id, live.spec.cwd, `${runtimeId}:${itemId}`, paths) }
        catch (error) { this.snapshotNotice(live, runtimeId, itemId, error) }
      },
      afterTool: async (itemId, paths, success) => {
        if (live.runtimeId !== runtimeId || live.closed) return
        try { const changes = await this.artifacts.afterTool(id, live.spec.cwd, `${runtimeId}:${itemId}`, paths, success); if (changes.length && live.runtimeId === runtimeId && !live.closed) this.emit(live, { itemId, data: { type: 'changes', changes } }) }
        catch (error) { this.snapshotNotice(live, runtimeId, itemId, error) }
      }
    }
  }
  /** Report a snapshot failure the owner could not have predicted — once. The same reason
   *  recurring on every tool call says nothing new after the first time, and burying the
   *  conversation under identical notices is worse than not mentioning it again. Paths the
   *  snapshot layer has nothing to capture for never reach here at all. */
  private snapshotNotice(live: LiveSession, runtimeId: string, itemId: string, error: unknown): void {
    if (live.runtimeId !== runtimeId || live.closed) return
    const message = `Snapshot unavailable: ${error instanceof Error ? error.message : 'unsupported file'}`
    const seen = live.snapshotNotices ??= new Set<string>()
    if (seen.has(message)) return
    seen.add(message)
    this.emit(live, { itemId, data: { type: 'notice', message } })
  }
  private async connect(live: LiveSession): Promise<void> {
    if (live.starting) return live.starting
    if (live.adapter) return
    this.validateSpec(live.spec)
    if (!live.executable && live.spec.provider !== 'local') throw new Error('Provider executable unavailable')
    live.runtimeId = randomUUID(); live.closed = false; live.responses.clear()
    const options = this.options(live, live.runtimeId)
    live.adapter = this.factory(live.spec.provider as StructuredProvider, options)
    this.emit(live, { data: { type: 'session', phase: 'starting', capabilities: live.adapter.capabilities, settings: options.settings } })
    live.starting = live.adapter.start().catch(error => {
      this.emit(live, { data: { type: 'error', message: error instanceof Error ? error.message : 'Provider initialization failed', code: safeErrorCode(error) } })
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
          this.emit(live, { data: { type: 'session', phase: state.phase, nativeSessionId } })
        }
        const history = live.spec.provider === 'claude' ? await readClaudeHistory(live.spec.cwd, nativeSessionId) : live.spec.provider === 'grok' ? await readGrokHistory(nativeSessionId) : await live.adapter?.history?.() ?? []
        const handoff = { id: randomUUID(), known: history.map((item) => item.id) }
        // Persist ownership before releasing the structured process.
        this.database.setSetting('cliHandoff:' + id, JSON.stringify(handoff))
      }
      const previous = live.adapter
      this.cancelNativeAcceptances(live, 'The runtime changed before native steering acceptance was confirmed. The pending input was retained; inspect the conversation before retrying.')
      live.closed = true
      try { if (previous?.stop) await previous.stop(); else previous?.dispose() } catch (reason) { live.closed = false; throw reason }
      live.adapter = undefined; live.closed = false
      state = store.snapshot(id)!
      const settings = settingsForRuntime(state.settings)
      this.emit(live, { data: { type: 'session', phase: state.phase, view: 'cli', settings } })
      return { spec: live.spec, nativeSessionId: state.nativeSessionId!, settings, fresh: this.database.getSetting('newNative:' + id) === 'true' && (live.spec.provider === 'claude' ? !hasClaudeHistory(live.spec.cwd, state.nativeSessionId!) : live.spec.provider === 'grok' && !hasGrokHistory(state.nativeSessionId!)) }
    } finally { live.handoff = false }
  }
  cancelCli(id: string): void {
    const live = this.get(id)
    this.database.removeSetting('cliHandoff:' + id)
    const state = this.database.structured.snapshot(id)!
    // A refused handoff may be cancelled while the original turn is still running.
    // Returning to Chat is presentation, not evidence that its turn ended.
    const phase = live.adapter || active.has(state.phase) ? state.phase : 'disconnected'
    this.emit(live, { data: { type: 'session', phase, view: 'visual' } })
  }
  async finishCli(id: string): Promise<void> {
    const live = this.get(id)
    if (live.handoff) throw new Error('A view switch is already in progress')
    const serialized = this.database.getSetting('cliHandoff:' + id)
    if (!serialized) return
    if (active.has(this.database.structured.snapshot(id)!.phase)) { this.cancelCli(id); return }
    live.handoff = true
    try {
      const handoff = JSON.parse(serialized) as { id: string; known: string[] }
      // A previous switch may have timed out while stopping its process.
      if (live.adapter) {
        this.cancelNativeAcceptances(live, 'The runtime changed before native steering acceptance was confirmed. The pending input was retained; inspect the conversation before retrying.')
        live.closed = true
        try { if (live.adapter.stop) await live.adapter.stop(); else live.adapter.dispose(); live.adapter = undefined } finally { live.closed = false }
      }
      await this.connect(live)
      const state = this.database.structured.snapshot(id)!
      const history = live.spec.provider === 'claude' ? await readClaudeHistory(live.spec.cwd, state.nativeSessionId!) : live.spec.provider === 'grok' ? await readGrokHistory(state.nativeSessionId!) : await this.get(id).adapter?.history?.() ?? []
      const known = new Set(handoff.known)
      // A failed/retried import reuses the handoff identity, so journal replay reconciles each item.
      for (const item of history) if (!known.has(item.id)) this.emit(live, historyEvent(item, handoff.id))
      this.database.removeSetting('cliHandoff:' + id)
      this.emit(live, { data: { type: 'session', phase: this.database.structured.snapshot(id)!.phase, view: 'visual' } })
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
  /** The one spec field that changes after registration: whether a usage limit is waited out and
   *  the turn continued. The timer lives in this process, the reset time in SQLite. */
  setContinueOnLimit(id: string, enabled: boolean): void {
    const live = this.live.get(id)
    if (!live || Boolean(live.spec.continueOnLimit) === enabled) return
    live.spec = { ...live.spec, continueOnLimit: enabled }
    this.database.structured.setContinueOnLimit(id, enabled)
    this.database.setAgentContinueOnLimit(id, enabled)
    if (!enabled) this.cancelContinuation(id)
  }

  saveSettings(id: string, settings: SessionSettings): void {
    const state = this.database.structured.snapshot(id)
    if (!state) throw new Error('Session not found')
    this.validateSettings(settings, state.capabilities)
    const browserChanged = Boolean(settings.browserMcp) !== Boolean(state.settings.browserMcp)
    if (browserChanged && settings.browserMcp && active.has(state.phase)) throw new Error('Wait for the current turn to finish before enabling browser tools')
    this.database.structured.update(id, { settings })
    // Turning the wand on is also the decision to wait out usage limits; turning it off leaves the
    // workspace's own choice, which the next ensure() re-applies.
    if (wizardActive(settings, state.capabilities?.provider ?? this.database.structured.spec<AgentSpec>(id)?.provider)) this.setContinueOnLimit(id, true)
    if (browserChanged) {
      // Revocation is synchronous and precedes every later await: a disabled credential cannot
      // finish a tool call merely because its browser lookup was already in flight.
      this.mcp?.release(id)
      // The owner's deliberate toggle is the default for this provider's next conversations.
      rememberBrowserTools((key, value) => this.database.setSetting(key, value), this.database.structured.spec<AgentSpec>(id)?.provider, Boolean(settings.browserMcp))
      const live = this.live.get(id)
      if (live?.adapter) {
        if (active.has(state.phase)) live.browserConfigStale = true
        else this.retireBrowserTransport(live)
      }
    }
    // This is the one path a deliberate composer change always takes (see updateSettings in
    // StructuredAgentPane.tsx), so it is also where the owner's choice is remembered for the
    // next conversation of this provider, manual or agent-opened.
    if (state.capabilities) rememberPermission((key, value) => this.database.setSetting(key, value), state.capabilities.provider, settings.permission, state.capabilities)
  }

  async resume(id: string, settings?: SessionSettings): Promise<void> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (live.handoff || this.cliOwned(id)) throw new Error('Switch this conversation from CLI to Chat first')
    if (active.has(state.phase) || live.queueing) throw new Error('Session still has active work')
    if (!state.nativeSessionId) throw new Error('This history has no native conversation to resume')
    if (settings) {
      settings = this.messageSettings(state, settings)
      this.validateSettings(settings, state.capabilities)
      this.database.structured.update(id, { settings })
    }
    await this.reconnect(live)
  }
  /** Replace only the transport incarnation; options() keeps using the exact persisted native
   *  conversation id, while callbacks from the disposed incarnation are closed first. */
  private async reconnect(live: LiveSession): Promise<void> {
    this.cancelNativeAcceptances(live, 'The runtime changed before native steering acceptance was confirmed. The pending input was retained; inspect the conversation before retrying.')
    live.closed = true
    live.adapter?.dispose()
    live.adapter = undefined
    live.turnId = undefined
    live.closed = false
    await this.connect(live)
    // connect() rebuilds the provider command from the currently persisted settings. Once it
    // succeeds, a browser-setting retirement has reached the replacement transport even when
    // the owner resumed explicitly instead of submitting the next message.
    live.browserConfigStale = false
  }
  private retireBrowserTransport(live: LiveSession, reason = 'Browser tool settings changed.'): void {
    this.cancelNativeAcceptances(live, reason.replace(/\.$/, '') + ' before native steering acceptance was confirmed. The pending input was retained; inspect the conversation before retrying.')
    live.closed = true
    live.adapter?.dispose()
    live.adapter = undefined
    live.turnId = undefined
    live.browserConfigStale = false
    live.closed = false
    const state = this.database.structured.snapshot(live.spec.id)
    if (state?.nativeSessionId) this.emit(live, { data: { type: 'session', phase: 'disconnected', message: reason + ' The same native conversation will reconnect before the next message.' } })
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
  /** Fold a local conversation's transcript into its durable task state without ending it:
   *  the fresh-tab pattern inside the same logical agent. Only between turns. */
  async compactContext(id: string): Promise<Json | null> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (state.phase === 'disconnected') return null
    await this.connect(live)
    if (!live.adapter?.compactContext) throw new Error('This provider compacts its own context; there is nothing for Conductor to fold')
    if (['starting', 'running', 'waiting_input', 'waiting_approval', 'interrupting'].includes(this.database.structured.snapshot(id)!.phase)) throw new Error('Wait for the current turn to finish before compacting')
    return await live.adapter.compactContext()
  }
  /** The local runtime's own compact view of its last run, when it keeps one. */
  runStatus(id: string): Json | null {
    return this.live.get(id)?.adapter?.runStatus?.() ?? null
  }
  async refreshUsage(id: string): Promise<boolean> {
    const live = this.get(id), state = this.database.structured.snapshot(id)!
    if (state.phase === 'disconnected') return false
    await this.connect(live)
    if (!live.adapter?.refreshUsage) return false
    await live.adapter.refreshUsage()
    return true
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
  /** What the composer does with a message, for a caller that cannot see the conversation: steer
   *  it into (or queue it behind) a turn that is under way, and otherwise start a turn with it
   *  exactly as `submit` does. A turn that is still stopping is refused rather than raced. */
  async steerOrStart(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = [], origin?: PromptOrigin): Promise<'started' | 'queued'> {
    const live = this.get(id), phase = this.database.structured.snapshot(id)!.phase
    if (phase === 'interrupting') throw new Error('The conversation is still stopping its last turn; send the message again once it has stopped')
    if (live.submitting || live.steering || live.queueing || active.has(phase)) {
      await this.steer(id, text, settings, attachments, origin)
      return 'queued'
    }
    await this.submit(id, text, settings, attachments, origin)
    return 'started'
  }
  /** Project-task ownership is transferred only after the native runtime acknowledges custody.
   * Unlike an ordinary composer steer, this never degrades into an unbounded host-side queue. */
  async steerAccepted(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = [], origin?: PromptOrigin): Promise<void> {
    return this.followup(id, text, settings, attachments, true, undefined, origin, true)
  }
  private async followup(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[], steer: boolean, queuedPromptId?: string, origin?: PromptOrigin, requireNativeAcceptance = false): Promise<void> {
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
      settings = this.messageSettings(state, settings)
      this.validateSettings(settings, state.capabilities)
      const context = await this.attachments(live, captured)
      this.assertPromptWithinLimit(text.trim().length + context.length)
      let latest = this.database.structured.snapshot(id)!
      // Attachment validation can yield while the owner changes the browser toggle. Model and
      // effort belong to this captured message; browser authority belongs to the current session.
      settings = this.messageSettings(latest, settings)
      if (live.closed || this.live.get(id) !== live || live.handoff || this.cliOwned(id) || live.adapter !== adapter || live.runtimeId !== runtimeId || !['starting', 'running', 'waiting_input', 'waiting_approval', 'completed', 'idle'].includes(latest.phase)) throw new Error('The turn stopped before this message was queued. Your draft was kept.')
      this.assertPromptDispatchAuthority(origin, live.spec)
      let refusal = 'The current turn does not support steering'
      let maySteer = steer
      let refusedInputId: string | undefined
      if (steer && live.turnId === turnId && adapter?.steer && adapter.capabilities.steering && ['running', 'waiting_input', 'waiting_approval'].includes(latest.phase)) {
        this.reserveLive(live, latest.settings, text.trim() + context)
        if ((latest.pendingSteering?.length ?? 0) >= 100) throw new Error('There are already 100 pending steering messages')
        live.steering = true
        const inputId = randomUUID()
        this.setSteering(live, [...latest.pendingSteering ?? [], { id: inputId, text: text.trim(), settings: structuredClone(latest.settings), attachments: captured, runtimeId, turnId, status: 'sending', ...(origin ? { origin } : {}) }])
        const acceptance = requireNativeAcceptance ? this.nativeAcceptanceWaiter(live, inputId) : undefined
        // Transfer ownership before the native attempt. An uncertain response must
        // leave only the pending record, never an automatically drainable copy.
        if (queuedPromptId) this.setQueue(live, (latest.queuedPrompts ?? (latest.queued ? [latest.queued] : [])).filter(input => input.id !== queuedPromptId))
        let transport: Promise<void>
        try { transport = Promise.resolve(adapter.steer!(text.trim() + context, settings, captured.filter(item => item.kind === 'image'), inputId)) }
        catch (error) { transport = Promise.reject(error) }
        try {
          if (acceptance) {
            // Observe the receipt immediately. The CLI method is only a transport attempt and
            // may stay pending after the native runtime has accepted (or refused) the input.
            // Racing its rejection against the receipt bounds the public call without leaving
            // either promise unobserved.
            await Promise.race([acceptance.promise, transport.then(() => acceptance.promise)])
          } else await transport
          if (live.closed || this.live.get(id) !== live || live.runtimeId !== runtimeId) throw new Error('The runtime changed after steering was sent. Check the conversation before resending; your draft was kept.')
          return
        } catch (error) {
          acceptance?.cancel()
          // Receipt-level cancellation/uncertainty is already durable. Never make a second,
          // drainable copy and never authorize a Project-task handoff from it.
          if (requireNativeAcceptance) {
            const pending = this.database.structured.snapshot(id)?.pendingSteering?.find(input => input.id === inputId)
            if (pending?.status === 'sending') this.reconcileInput(live, { data: { type: 'input_delivery', inputId, status: 'uncertain' } })
            throw error
          }
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
      if (requireNativeAcceptance) throw new Error(refusal + '. Native acceptance was not confirmed, so the selected tasks were not claimed.')
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
  private nativeAcceptanceWaiter(live: LiveSession, inputId: string): { promise: Promise<void>; cancel(): void } {
    let resolve!: () => void, reject!: (reason: Error) => void
    const promise = new Promise<void>((accepted, refused) => { resolve = accepted; reject = refused })
    const timer = setTimeout(() => {
      const waiter = live.nativeAcceptance?.get(inputId)
      if (!waiter) return
      live.nativeAcceptance!.delete(inputId)
      const state = this.database.structured.snapshot(live.spec.id)
      const prompts = state?.pendingSteering ?? []
      const pending = prompts.find(input => input.id === inputId && input.runtimeId === live.runtimeId)
      if (pending?.status === 'sending') this.setSteering(live, prompts.map(input => input.id === inputId ? { ...input, status: 'uncertain' } : input))
      waiter.reject(new Error('Native steering acceptance was not confirmed. The pending input was retained; inspect the conversation before retrying.'))
    }, 30_000)
    const waiters = live.nativeAcceptance ??= new Map()
    waiters.set(inputId, { timer, resolve, reject })
    return { promise, cancel: () => {
      const waiter = live.nativeAcceptance?.get(inputId)
      if (!waiter) return
      clearTimeout(waiter.timer)
      live.nativeAcceptance!.delete(inputId)
    } }
  }
  private settleNativeAcceptance(live: LiveSession, inputId: string, status: 'accepted' | 'delivered' | 'cancelled' | 'uncertain'): void {
    const waiter = live.nativeAcceptance?.get(inputId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    live.nativeAcceptance!.delete(inputId)
    if (status === 'accepted' || status === 'delivered') waiter.resolve()
    else waiter.reject(new Error(status === 'cancelled'
      ? 'The native runtime cancelled the assignment before accepting it.'
      : 'Native steering delivery is uncertain. The pending input was retained; inspect the conversation before retrying.'))
  }
  /** End every receipt wait before replacing or disposing its transport. Pending ownership is
   * retained as uncertain, so a late callback from the retired runtime cannot authorize a claim. */
  private cancelNativeAcceptances(live: LiveSession, message: string): void {
    const waiters = live.nativeAcceptance
    if (!waiters?.size) return
    const ids = new Set(waiters.keys())
    const state = this.database.structured.snapshot(live.spec.id)
    const prompts = state?.pendingSteering ?? []
    if (prompts.some(input => ids.has(input.id) && input.status === 'sending')) {
      this.setSteering(live, prompts.map(input => ids.has(input.id) && input.status === 'sending' ? { ...input, status: 'uncertain' } : input))
    }
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
    waiters.clear()
  }
  private reconcileInput(live: LiveSession, source: AdapterEvent): void {
    if (source.data.type !== 'input_delivery') return
    const { inputId, status } = source.data
    const state = this.database.structured.snapshot(live.spec.id)!
    const prompts = state.pendingSteering ?? []
    const input = prompts.find(prompt => prompt.id === inputId && prompt.runtimeId === live.runtimeId)
    if (!input) return
    // A late accepted acknowledgement cannot reverse a terminal/uncertain result or authorize a
    // Project-task handoff. Every other status settles a caller waiting for native custody.
    if (status === 'accepted' && input.status !== 'sending') return
    this.settleNativeAcceptance(live, inputId, status)
    if (status === 'delivered') {
      this.setSteering(live, prompts.filter(prompt => prompt.id !== inputId), source.native)
      live.expediteInput?.delete(inputId)
      this.emit(live, { turnId: input.turnId, itemId: inputId, data: { type: 'text', role: 'user', text: input.text, mode: 'snapshot', ...(input.attachments.length ? { attachments: input.attachments.map(({ content: _content, ...metadata }) => metadata) } : {}), ...(input.origin ? { origin: input.origin } : {}) }, native: source.native })
    } else {
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
    if (live.dispatchingQueue && queued && (live.dispatchingPromptIds?.has(queued.id) || queued.id === live.dispatchingPromptId)) throw new Error('The queued message is already being sent')
    if (queued) this.setQueue(live, prompts.filter(prompt => prompt.id !== queued.id))
    return queued
  }
  private async drainQueue(live: LiveSession): Promise<void> {
    let state = this.database.structured.snapshot(live.spec.id)
    if (!state || live.closed || live.submitting || live.steering || live.dispatchingQueue || live.refusalFallback || !live.adapter) return
    if (live.capStop && this.capSetting(live)?.key === live.capStop.capKey) return
    if (live.expediteReady && ['interrupted', 'completed'].includes(state.phase)) {
      const recovered = (state.pendingSteering ?? []).filter(input => live.expediteInput?.has(input.id) && input.status === 'cancelled')
      const queued = state.queuedPrompts ?? (state.queued ? [state.queued] : [])
      const held = queued.filter(input => live.expediteQueued?.has(input.id))
      live.expediteReady = false; live.expediteInput = undefined; live.expediteQueued = undefined
      if (recovered.length || held.length) {
        const ids = new Set(recovered.map(input => input.id))
        this.setSteering(live, (state.pendingSteering ?? []).filter(input => !ids.has(input.id)))
        this.setQueue(live, [...recovered.map(({ runtimeId: _runtime, turnId: _turn, status: _status, ...input }) => ({ ...input, steer: true })), ...held.map(input => ({ ...input, steer: true })), ...queued.filter(input => !held.includes(input))])
        live.sendAfterInterrupt = true
        state = this.database.structured.snapshot(live.spec.id)!
      }
    }
    if (!state.queued) return
    const steerable = live.adapter.capabilities.steering && ['running', 'waiting_input', 'waiting_approval'].includes(state.phase)
    const queued = (steerable && state.queuedPrompts?.find(input => input.steer)) || state.queued
    const canSteer = queued.steer && steerable
    const allQueued = state.queuedPrompts ?? (state.queued ? [state.queued] : [])
    const batch: QueuedPrompt[] = canSteer ? [queued] : []
    if (!canSteer) {
      const origin = JSON.stringify(queued.origin ?? null)
      for (const prompt of allQueued) {
        if (JSON.stringify(prompt.origin ?? null) !== origin) break
        const candidate = [...batch, prompt]
        if (candidate.flatMap(item => item.attachments).length > 20 || queuedText(candidate).length > 60_000) break
        batch.push(prompt)
      }
    }
    const dispatch = batch.length ? batch : [queued]
    const dispatchIds = new Set(dispatch.map(prompt => prompt.id))
    // A turn that ended in error is as settled as one that completed, and the queued message is
    // usually the continuation that recovers it — a local model fails its whole turn on a single
    // bad request. Without this the message waits behind a phase that never comes back.
    // Dispatched at most once per message, so a runtime that fails every dispatch and re-enters
    // this drain from its own failure event cannot spin on the same text.
    const afterFailure = state.phase === 'failed' && !live.failedDrain?.has(queued.id)
    if (!canSteer && !['completed', 'idle'].includes(state.phase) && !afterFailure && !(state.phase === 'interrupted' && live.sendAfterInterrupt)) return
    if (afterFailure) for (const prompt of dispatch) (live.failedDrain ??= new Set()).add(prompt.id)
    live.dispatchingQueue = true
    live.dispatchingPromptId = queued.id
    live.dispatchingPromptIds = dispatchIds
    let sent = false
    try {
      if (canSteer) await this.followup(live.spec.id, queued.text, queued.settings, structuredClone(queued.attachments), true, queued.id, queued.origin)
      else {
        live.sendAfterInterrupt = false
        const latest = dispatch.at(-1)!
        await this.submit(live.spec.id, queuedText(dispatch), latest.settings, structuredClone(dispatch.flatMap(prompt => prompt.attachments)), latest.origin)
      }
      const latest = this.database.structured.snapshot(live.spec.id)!
      this.setQueue(live, (latest.queuedPrompts ?? (latest.queued ? [latest.queued] : [])).filter(prompt => !dispatchIds.has(prompt.id)))
      sent = true
    } catch (reason) {
      const retained = this.database.structured.snapshot(live.spec.id)?.queuedPrompts?.some(input => dispatchIds.has(input.id))
      this.emit(live, { data: { type: 'notice', message: (retained ? 'Queued message was not sent. It is still available above the composer: ' : 'Steering delivery was not confirmed. Check the retained pending message above the composer: ') + (reason instanceof Error ? reason.message : String(reason)) } })
    } finally {
      live.dispatchingQueue = false
      live.dispatchingPromptId = undefined
      live.dispatchingPromptIds = undefined
      // Some runtimes finish before submit resolves; that completion still drains the next item.
      if (sent) queueMicrotask(() => { void this.drainQueue(live) })
    }
  }

  async submit(id: string, text: string, settings: SessionSettings, attachments: ContextAttachment[] = [], origin?: PromptOrigin, refusalRetry = false): Promise<void> {
    const live = this.get(id), store = this.database.structured
    let state = store.snapshot(id)!
    if (live.handoff || this.cliOwned(id)) throw new Error('Switch this conversation from CLI to Chat first')
    if (live.submitting || live.steering || active.has(state.phase)) throw new Error('A turn or request is already active in this session')
    this.assertUnderUsageCap(live)
    if (typeof text !== 'string' || !text.trim() || text.length > 60_000) throw new Error('Prompt must contain 1–60000 characters')
    settings = this.messageSettings(state, settings)
    this.validateSettings(settings, state.capabilities)
    // A remote-origin prompt does not authorize waking or reconnecting its retained native
    // runtime. Reject a revoked peer before any attachment I/O or provider lifecycle work.
    this.assertPromptDispatchAuthority(origin, live.spec)
    // Any new turn ends the wait, whether Conductor sent it on the timer or the owner got there
    // first. Leaving the record pending would relabel the next settled turn as limited.
    if (live.limitResumeAt) this.clearUsageLimit(live)
    live.submitting = true
    let resumedIntoActiveTurn = false
    try {
      if (live.browserConfigStale) {
        await this.reconnect(live)
        this.assertPromptDispatchAuthority(origin, live.spec)
        live.browserConfigStale = false
        state = store.snapshot(id)!
      }
      if (state.phase === 'disconnected' && state.nativeSessionId) {
        await this.reconnect(live)
        this.assertPromptDispatchAuthority(origin, live.spec)
        state = store.snapshot(id)!
        // A resumed Codex thread can reveal that its turn survived the transport loss. Send this
        // new owner message to that same turn once; never replay any earlier uncertain input.
        if (active.has(state.phase)) {
          resumedIntoActiveTurn = true
          live.submitting = false
          return await this.followup(id, text, settingsForRuntime(settings, live.runtimeId), attachments, true, undefined, origin)
        }
      }
      settings = settingsForRuntime(settings, live.adapter ? live.runtimeId : undefined)
      const context = await this.attachments(live, attachments)
      this.assertPromptDispatchAuthority(origin, live.spec)
      const userItemId = randomUUID()
      // How full the runtime's window is, from its own last usage report, so the briefing can
      // say once per band when the remaining work belongs in a fresh tab.
      const share = summarizeContext(state.items, live.adapter ? live.runtimeId : undefined)
      const recalled = process.env.CONDUCTOR_LIVE_TESTS === '1' || this.isApprovalReviewer(id) ? '' : this.context?.(live.spec, text, userItemId, live.adapter ? live.runtimeId : '', share ? { percent: share.percent } : undefined) ?? ''
      // A local model reads recalled background before the owner's words, fenced as reference, so
      // the owner's instruction is the last thing it reads; native providers keep it after.
      const submitted = live.spec.provider === 'local'
        ? composeLocalPrompt(`${text.trim()}${context}`, recalled)
        : `${text.trim()}${context}${recalled ? `\n\n${recalled}` : ''}`
      this.assertPromptWithinLimit(submitted.length)
      if (!refusalRetry) {
        live.refusalFallback = undefined
        live.currentTurn = { text: text.trim(), settings: structuredClone(settings), attachments: structuredClone(attachments), ...(origin ? { origin: structuredClone(origin) } : {}), fallbackAttempted: false }
      }
      // A queued message may have captured settings before the owner revoked browser access.
      // Never let that per-message snapshot overwrite the explicit, newer session authority.
      state = store.snapshot(id)!
      settings = this.messageSettings(state, settings)
      await this.connect(live)
      if (live.closed || this.live.get(id) !== live || !live.adapter) throw new Error('Session closed during initialization; no prompt was sent')
      // connect/reconnect and attachment expansion can all yield to peer revocation. This final
      // synchronous guard is adjacent to the adapter call: no accepted user/running event exists
      // until the durable remote authority has survived every one of those boundaries.
      this.assertPromptDispatchAuthority(origin, live.spec)
      this.reserveLive(live, settings, submitted)
      // Short and word-bounded, so history rows read the same name the tab strip auto-names
      // itself from (see conversation-tab.ts's bindConversationTab).
      store.update(id, { settings, title: state.title || deriveConversationTitle(text) })
      // Keep expanded file bytes and recalled context in the provider request, outside the user's message.
      if (!refusalRetry) this.emit(live, { itemId: userItemId, data: { type: 'text', role: 'user', text: text.trim(), mode: 'snapshot', ...(attachments.length ? { attachments: attachments.map(({ content: _content, ...metadata }) => metadata) } : {}), ...(origin ? { origin } : {}) } })
      this.emit(live, { data: { type: 'session', phase: 'running' } })
      if (process.env.CONDUCTOR_LIVE_TESTS === '1') live.budget = new LiveRuntimeBudget(boundary => this.stopLive(live, boundary === 'active-runtime' ? 'Live prompt reached its 90 second active runtime allowance' : 'Live prompt reached its 30 second cumulative human-input wait allowance'))
      const dispatch = live.adapter.submit(submitted, settings, attachments.filter(item => item.kind === 'image'))
      await dispatch
    } catch (error) {
      if (!resumedIntoActiveTurn && store.snapshot(id)?.phase === 'running') {
        this.emit(live, { data: { type: 'error', message: `Prompt dispatch failed: ${error instanceof Error ? error.message : 'Unknown provider error'}`, code: safeErrorCode(error) } })
        this.emit(live, { data: { type: 'session', phase: 'failed' } })
      }
      throw error
    } finally { live.submitting = false; void this.drainQueue(live) }
  }
  private validateSettings(settings: SessionSettings, capabilities: import('../shared/structured-agent').ProviderCapabilities | undefined): void {
    if (settings.reviewDelegatedActions !== undefined && typeof settings.reviewDelegatedActions !== 'boolean') throw new Error('Invalid delegated review setting')
    if (settings.wizard !== undefined && typeof settings.wizard !== 'boolean') throw new Error('Invalid wizard setting')
    if (settings.wizard && capabilities && (capabilities.provider === 'local' || !isFrontierModel(capabilities.provider, settings.model))) throw new Error(`Wizard mode needs a frontier model (${WIZARD_MODEL_HINT}); this conversation runs ${settings.model ?? 'the provider default'}`)
    if (!settings || !['default', 'read-only', 'accept-edits', 'auto'].includes(settings.permission) || typeof settings.plan !== 'boolean') throw new Error('Invalid session settings')
    if (settings.browserMcp !== undefined && typeof settings.browserMcp !== 'boolean') throw new Error('Invalid browser MCP setting')
    for (const key of ['localGit', 'localResearch'] as const) {
      if (settings[key] === undefined) continue
      if (typeof settings[key] !== 'boolean') throw new Error('Invalid local sandbox grant')
      // These grants only mean anything to the local runtime; accepting them elsewhere would
      // record an authority no adapter reads and no pane can explain.
      if (settings[key] && capabilities && capabilities.provider !== 'local') throw new Error('Repository and research grants apply to local models only')
    }
    if (settings.localContract !== undefined) {
      if (settings.localContract !== null && capabilities && capabilities.provider !== 'local') throw new Error('A task contract applies to local models only')
      normaliseContract(settings.localContract)
    }
    if (settings.temporaryPermission && (typeof settings.temporaryPermission.runtimeId !== 'string' || !['default', 'read-only', 'accept-edits', 'auto'].includes(settings.temporaryPermission.restore))) throw new Error('Invalid temporary permission scope')
    if (settings.plan && !capabilities?.plans) throw new Error('Planning is unavailable on this adapter baseline')
    if (capabilities?.permissions && !capabilities.permissions.includes(settings.permission)) throw new Error('Permission policy unsupported by this provider')
    if (settings.sandbox && !capabilities?.sandboxModes?.includes(settings.sandbox)) throw new Error('Execution sandbox unsupported by this provider')
    if (settings.approvalPolicy && !capabilities?.approvalPolicies?.includes(settings.approvalPolicy)) throw new Error('Approval policy unsupported by this provider')
    if (settings.model && (settings.model.length > 160 || /[\r\n\0]/.test(settings.model))) throw new Error('Invalid model')
    if (settings.effort && settings.effort !== 'auto' && !capabilities?.effort.includes(settings.effort)) throw new Error('Effort is not supported by this provider')
  }
  /** Browser access is an explicit session authority, not a per-message generation setting.
   * Queued prompts, delayed attachment reads, native resume calls, and provider-emitted settings
   * may carry an older copy; preserve their model/effort/permission while taking browserMcp only
   * from the current durable projection. */
  private messageSettings(state: { settings: SessionSettings }, incoming: SessionSettings): SessionSettings {
    const { browserMcp: _capturedBrowser, localGit: _capturedGit, localResearch: _capturedResearch, localContract: _capturedContract, reviewDelegatedActions: _capturedReview, wizard: _capturedWizard, ...message } = incoming
    const authority: SessionSettings = { ...message }
    // Same rule for the local grants: a queued prompt must not carry a repository or research
    // grant the owner has since withdrawn, nor lose one they have since given.
    for (const key of ['browserMcp', 'localGit', 'localResearch', 'reviewDelegatedActions', 'wizard'] as const) if (state.settings[key] !== undefined) authority[key] = state.settings[key]
    if (state.settings.localContract !== undefined) authority.localContract = state.settings.localContract
    return authority
  }
  private assertPromptDispatchAuthority(origin: PromptOrigin | undefined, spec: AgentSpec): void {
    const authority = origin?.authority
    if (!authority) return
    if (authority.kind !== 'remote-peer'
      || typeof authority.peerId !== 'string' || !authority.peerId || authority.peerId.length > 200 || /[\r\n\0]/.test(authority.peerId)
      || typeof authority.projectId !== 'string' || !authority.projectId || authority.projectId.length > 200 || /[\r\n\0]/.test(authority.projectId)
      || authority.projectId !== spec.projectId) throw new Error('Remote prompt authority is invalid for this project; no message was sent')
    if (!this.promptDispatchAuthorityGuard) throw new Error('Remote prompt authority cannot be verified on this runtime; no message was sent')
    this.promptDispatchAuthorityGuard(authority, spec)
  }
  /** The CLI/API refuses the whole turn with an opaque error past this ceiling. Attachment and
   *  recalled-memory expansion can silently inflate a short-looking draft well past it, so the
   *  final assembled text is checked here rather than trusting the raw typed length. */
  private assertPromptWithinLimit(length: number): void {
    if (length > MAX_PROMPT_CHARS) throw new Error(`Prompt must contain 1-${MAX_PROMPT_CHARS} characters; this message is ${length.toLocaleString()} characters including attached context. Remove or shorten an attachment, or trim the message.`)
  }
  private async attachments(live: LiveSession, attachments: ContextAttachment[]): Promise<string> {
    if (!Array.isArray(attachments) || attachments.length > 20) throw new Error('Too many attachments')
    let context = ''
    let imageBytes = 0
    for (const item of attachments) {
      if (!item || typeof item.name !== 'string' || !['file', 'selection', 'editor', 'terminal', 'diagnostics', 'image', 'media'].includes(item.kind)) throw new Error('Invalid attachment')
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
      if (item.kind === 'media') {
        if (!item.path) throw new Error('Opaque media requires a project file path')
        const path = await workspacePath(live.spec.cwd, item.path)
        const { lstat } = await import('node:fs/promises')
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Opaque media must be a regular project file')
        const mimeType = typeof item.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mimeType) ? item.mimeType.toLowerCase() : 'application/octet-stream'
        item.size = stat.size
        item.mimeType = mimeType
        context += `\n\n[Attached opaque media: ${item.name}; workspace path: ${item.path}; media type: ${mimeType}; ${stat.size} bytes. Binary bytes were not decoded or inserted as readable text.]`
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
  async respond(response: InteractionResponse, reviewedAutomatically = false): Promise<void> {
    if (!response || typeof response.requestId !== 'string' || typeof response.runtimeId !== 'string') throw new Error('Invalid response')
    const live = this.get(response.sessionId), state = this.database.structured.snapshot(response.sessionId)!
    if (!live.adapter || live.runtimeId !== response.runtimeId || state.runtimeId !== response.runtimeId || live.responses.has(response.requestId)) throw new Error('This request is stale or already submitted')
    const item = state.items.find(item => item.runtimeId === response.runtimeId && item.data.type === 'interaction' && item.data.interaction.id === response.requestId && item.data.interaction.status === 'pending')
    if (!item || item.data.type !== 'interaction') throw new Error('Request is no longer pending')
    const interaction = item.data.interaction
    if (interaction.kind === 'approval' && !interaction.choices.some(choice => choice.id === response.decision && (!choice.disabled || reviewedAutomatically && interaction.review))) throw new Error('Unsupported approval scope')
    if (interaction.kind === 'question') {
      if (!response.answers || Object.keys(response.answers).some(key => !interaction.questions?.some(question => question.id === key))) throw new Error('Invalid question answers')
      for (const question of interaction.questions ?? []) {
        const values = response.answers[question.id]
        const maximum = live.spec.provider === 'claude' ? 10_000 : 16_384
        if (!Array.isArray(values) || !values.length || !question.multiSelect && values.length !== 1 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > maximum)) throw new Error('Every question requires a valid answer within its supported format')
        if (question.allowCustom === false && values.some(value => !question.options.some(option => option.label === value))) throw new Error('Choose one of the answers offered by this question')
      }
    }
    const review = interaction.kind === 'approval' ? await this.approvalGate.reserve(response, reviewedAutomatically, Boolean(interaction.review || this.reviewRouting?.enabled(live.spec))) : undefined
    // The asynchronous target/authority recheck must not race another owner response or restart.
    if (live.runtimeId !== response.runtimeId || live.responses.has(response.requestId)) throw new Error('This request is stale or already submitted')
    if (reviewedAutomatically && !review) throw new Error('Automatic review response has no live action binding; response is blocked')
    live.responses.add(response.requestId)
    try {
      await live.adapter.respond(response)
      if (review) this.approvalGate.finish(review, true)
      const current = this.database.structured.snapshot(response.sessionId)?.items.find(entry => entry.runtimeId === response.runtimeId && entry.data.type === 'interaction' && entry.data.interaction.id === response.requestId)
      if (current?.data.type === 'interaction' && current.data.interaction.status === 'pending') this.emit(live, { requestId: response.requestId, itemId: item.nativeItemId, data: { type: 'interaction', interaction: { ...interaction, status: 'resolved', outcome: response.decision ?? 'answered' } } })
    } catch (error) {
      if (review) this.approvalGate.finish(review, false)
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
    live.expediteQueued = expediteSubmittedInput ? new Set((state.queuedPrompts ?? []).filter(input => input.id !== live.dispatchingPromptId).map(input => input.id)) : undefined
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
      this.cancelNativeAcceptances(live, 'The runtime stopped before native steering acceptance was confirmed. The pending input was retained; inspect the conversation before retrying.')
      live.adapter?.dispose(); live.adapter = undefined
      this.emit(live, { data: { type: 'session', phase: 'disconnected', message } })
    }, 2000)
  }

  /* --- Latest reported allowance ---------------------------------------- *
   * The newest account allowance each provider reported, per bucket, kept in
   * one settings row as usage events arrive, so `usage.limits` answers from it
   * without a turn and without reading the journal.
   * ---------------------------------------------------------------------- */

  private accountLimitRecord?: AccountLimitRecord
  private accountLimits(): AccountLimitRecord {
    if (!this.accountLimitRecord) {
      try { this.accountLimitRecord = JSON.parse(this.database.getSetting(ACCOUNT_LIMITS_KEY) ?? '{}') as AccountLimitRecord }
      catch { this.accountLimitRecord = {} }
    }
    return this.accountLimitRecord
  }
  private noteAccountLimits(live: LiveSession, limits: import('../shared/structured-agent').Json | undefined, observedAt: string): void {
    try {
      const next = recordAccountLimits(this.accountLimits(), live.spec.provider as StructuredProvider, limits, { observedAt, agentSessionId: live.spec.id, projectId: live.spec.projectId })
      if (!next) return
      this.accountLimitRecord = next
      this.database.setSetting(ACCOUNT_LIMITS_KEY, JSON.stringify(next))
    } catch { /* A usage record never breaks the event pipeline it observes. */ }
  }
  /** How many conversations are mid-turn right now: the scheduler's "Conductor is busy" signal
   *  (src/main/schedule-gate.ts). A conversation waiting on the owner is not counted. */
  turnsInFlight(): number {
    let count = 0
    for (const live of this.live.values()) if (!live.closed && live.activityPhase === 'working') count++
    return count
  }
  /** The newest reported allowance of each cloud provider, with what is not known said outright. */
  usageLimits(provider?: StructuredProvider): AccountLimitsReport[] {
    const record = this.accountLimits(), now = Date.now()
    return (['claude', 'codex', 'grok'] as const).filter(id => !provider || id === provider).map(id => describeAccountLimits(record, id, now))
  }

  /* --- Provider usage limits -------------------------------------------- *
   * A provider window that has closed is not a failure to recover from, it is
   * a wait with a known end. The reset time is persisted so the wait survives
   * a closed tab, a backend restart, or a quit; the timer that acts on it only
   * ever lives in this process, and is re-armed from SQLite by `ensure`.
   * ---------------------------------------------------------------------- */

  private noteSafeguardRefusal(live: LiveSession): void {
    const turn = live.currentTurn
    if (!turn || turn.fallbackAttempted || live.refusalFallback) return
    const state = this.database.structured.snapshot(live.spec.id)
    const currentModel = concreteModel(live.spec.provider, turn.settings.model, state?.capabilities)
    const fallback = fallbackAfterRefusal(live.spec.provider as StructuredProvider, currentModel)
    if (!fallback) return
    turn.fallbackAttempted = true
    live.refusalFallback = {
      text: turn.text,
      settings: { ...structuredClone(turn.settings), model: fallback.model },
      attachments: structuredClone(turn.attachments),
      ...(turn.origin ? { origin: structuredClone(turn.origin) } : {}),
      ...fallback
    }
  }

  private async runSafeguardFallback(live: LiveSession): Promise<void> {
    const retry = live.refusalFallback
    if (!retry || live.closed || this.live.get(live.spec.id) !== live) return
    live.refusalFallback = undefined
    this.emit(live, { data: { type: 'notice', message: retry.notice } })
    this.flush()
    try {
      await this.submit(live.spec.id, retry.text, retry.settings, retry.attachments, retry.origin, true)
    } catch (error) {
      this.emit(live, { data: { type: 'notice', message: `Refusal fallback could not be sent: ${error instanceof Error ? error.message : String(error)}` } })
      this.flush()
    }
  }

  /** Recognize the provider's own "you are out of quota until X" message and turn it into a
   *  durable wait. Read only from `error` events: a tool's output or a page the agent fetched
   *  can quote the same sentence without this conversation being limited at all. */
  private noteUsageLimit(live: LiveSession, message: string): void {
    if (live.limitResumeAt || live.closed) return
    const reset = parseUsageLimitReset(message)
    if (!reset) return
    live.limitResumeAt = reset.toISOString()
    this.database.saveContinuation(live.spec.id, live.spec.projectId, live.spec.sessionId, live.limitResumeAt)
    // Deliberately payload-free: a notice carrying a payload is classed as diagnostics and hidden
    // from the conversation, and this one exists precisely for the owner to read.
    this.emit(live, { data: {
      type: 'notice',
      message: live.spec.continueOnLimit
        ? `Usage limit reached. Conductor will send "continue" automatically at ${reset.toLocaleString()}.`
        : `Usage limit reached. The window reopens at ${reset.toLocaleString()}; turn on limit continuation for this workspace to resume automatically.`
    } })
    // Claude reports the limit mid-turn and settles immediately afterwards, and that settling
    // event carries the wait. An adapter that reports it after settling has no such event left,
    // so restate the phase it is already in rather than leaving the tab reading "failed".
    const phase = this.database.structured.snapshot(live.spec.id)?.phase
    if (phase && !active.has(phase)) this.emit(live, { data: { type: 'session', phase } })
    if (live.spec.continueOnLimit) this.scheduleContinuation(live, reset)
  }

  /** Re-arm a wait recorded before this process existed, or before this tab was reopened. */
  private armPersistedContinuation(live: LiveSession): void {
    const pending = this.database.getContinuation(live.spec.id)
    if (pending?.status !== 'pending') return
    const reset = new Date(pending.resumeAt)
    if (Number.isNaN(reset.getTime())) { this.database.clearContinuation(live.spec.id); return }
    live.limitResumeAt = reset.toISOString()
    if (live.spec.continueOnLimit) this.scheduleContinuation(live, reset)
  }

  private cancelContinuation(id: string): void {
    const timer = this.continuationTimers.get(id)
    if (timer) clearTimeout(timer)
    this.continuationTimers.delete(id)
  }

  private scheduleContinuation(live: LiveSession, resumeAt: Date): void {
    this.cancelContinuation(live.spec.id)
    const delay = Math.max(0, resumeAt.getTime() - Date.now())
    // A long wait is re-checked against the wall clock rather than trusted outright: a timer
    // armed for hours away is the one thing a suspended laptop is guaranteed to get wrong.
    const timer = setTimeout(() => {
      this.continuationTimers.delete(live.spec.id)
      if (this.live.get(live.spec.id) !== live || live.closed || !live.spec.continueOnLimit) return
      if (resumeAt.getTime() > Date.now() + 1000) { this.scheduleContinuation(live, resumeAt); return }
      void this.runContinuation(live)
    }, Math.min(delay, 2_147_000_000))
    this.continuationTimers.set(live.spec.id, timer)
  }

  /** The window has reopened: say "continue" the way the owner would have. */
  private async runContinuation(live: LiveSession): Promise<void> {
    const state = this.database.structured.snapshot(live.spec.id)
    if (!state || live.closed) return
    // Someone got there first — the owner typed into this conversation while it waited.
    if (active.has(state.phase)) { this.clearUsageLimit(live); return }
    this.clearUsageLimit(live)
    this.emit(live, { data: { type: 'notice', message: 'Usage window reopened; Conductor asked this conversation to continue.' } })
    this.flush()
    try {
      await this.submit(live.spec.id, 'continue', state.settings)
    } catch (error) {
      this.emit(live, { data: { type: 'notice', message: `Automatic continuation could not be sent: ${error instanceof Error ? error.message : String(error)}` } })
      this.flush()
    }
  }

  private clearUsageLimit(live: LiveSession): void {
    live.limitResumeAt = undefined
    this.cancelContinuation(live.spec.id)
    this.database.completeContinuation(live.spec.id)
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

  /** Whether this conversation still owns a subagent that has not reported back. A detached
   *  background task is defined to outlive the turn that launched it, so only the runtime that
   *  reported it can vouch for it: after a relaunch nothing claims work that died with its
   *  process. */
  private ownsActiveSubagent(live: LiveSession): boolean {
    if (!live.adapter || live.closed) return false
    const items = this.database.structured.snapshot(live.spec.id)?.items ?? []
    const latest = new Map<string, ActivityStatus>()
    for (const item of [...items].sort((a, b) => (a.updatedSequence ?? a.sequence) - (b.updatedSequence ?? b.sequence))) {
      if (item.data.type !== 'subagent' || item.runtimeId !== live.runtimeId) continue
      latest.set(item.data.nativeSessionId ?? item.nativeItemId ?? item.id, item.data.status)
    }
    return [...latest.values()].some(status => runningSubagent.has(status))
  }
  /** Whether the runtime still owns background work it will be woken by - a backgrounded shell
   *  process, an armed watcher. The tool call that started it returned immediately and the turn
   *  reported its result straight after, so only the live process' own inventory knows. */
  private ownsBackgroundWork(live: LiveSession): boolean {
    if (!live.adapter || live.closed) return false
    return (live.adapter.backgroundWork?.() ?? 0) > 0
  }
  /** A finished turn that still owns running subagent work is not finished: reporting 'complete'
   *  turns the tab's loader into a checkmark and rolls its project up green while output is still
   *  streaming in. Background work the runtime will wake this conversation for is the same lie
   *  told a turn later, and it also covers the quiet gap between wakes, where the conversation
   *  reports 'idle'. Every other phase speaks for itself. */
  private owningActivityPhase(live: LiveSession, reported: AgentActivityPhase): AgentActivityPhase {
    if (reported === 'complete' && this.ownsActiveSubagent(live)) return 'working'
    if ((reported === 'complete' || reported === 'idle') && this.ownsBackgroundWork(live)) return 'waiting_background'
    return reported
  }
  /** The one writer of the phase every project rolls up and every tab indicator follows. */
  private recordActivityPhase(live: LiveSession, phase: AgentActivityPhase): void {
    live.activityPhase = phase
    // AgentRecord.status is a coarser union than the phase, so the unhappy phases collapse
    // back onto its own vocabulary here rather than leaking new values into stored rows.
    const status = phase === 'working' || phase === 'idle' || phase === 'waiting_background' ? 'running' : phase === 'failed' || phase === 'disconnected' ? 'error' : phase === 'stopped' ? 'exited' : phase
    this.database.setAgentStatus(live.spec.id, status, phase)
    this.broadcast('agent:status', { id: live.spec.id, status, phase })
  }
  private emit(live: LiveSession, source: AdapterEvent, reviewProjection = false): void {
    const store = this.database.structured, state = store.snapshot(live.spec.id)
    if (!state || live.closed) return
    if (!reviewProjection) source = this.approvalGate.intercept(live.spec, live.runtimeId, source)
    if (source.data.type === 'input_delivery') { this.reconcileInput(live, source); return }
    // Host lifecycle hooks retain the exact tool identity; recover its recorded turn,
    // never associate output with a tool by its displayed name or position alone.
    if (source.itemId && !source.turnId) {
      const correlated = state.items.filter(item => item.runtimeId === live.runtimeId && item.nativeItemId === source.itemId).at(-1)
      if (correlated?.turnId) source = { ...source, turnId: correlated.turnId }
    }
    if (source.data.type === 'session' && source.turnId) live.turnId = source.turnId
    let data = source.data
    if (data.type === 'session' && data.settings) data = { ...data, settings: this.messageSettings(state, data.settings) }
    // Every lifecycle event restates the wait rather than relying on one event the renderer
    // might have missed, so a reconnecting or replaying view never shows a stale reset time.
    if (data.type === 'session' && data.limitResumeAt === undefined) data = { ...data, limitResumeAt: live.limitResumeAt ?? null }
    // Restated on every lifecycle event for the same reason: the renderer derives the tab's own
    // phase from the projection, so a conversation whose turn settled while a render runs on has
    // to carry that fact forward rather than depend on the one event that announced it.
    if (data.type === 'session' && data.backgroundTasks === undefined) data = { ...data, backgroundTasks: live.adapter?.backgroundWork?.() ?? 0 }
    if (data.type === 'changes') data = { ...data, changes: data.changes.map(change => this.artifacts.fromPatch(live.spec.id, change, live.spec.cwd)) }
    if (data.type === 'tool' && data.output && data.output.length > 32_000) {
      const output = data.output
      try { data = { ...data, outputArtifactId: store.putOutput(live.spec.id, output), output: output.slice(-32_000) } }
      catch { data = { ...data, output: '[Output artifact unavailable: storage allowance reached. Bounded tail follows.]\n' + output.slice(-32_000) } }
    }
    const event = store.append({ ...source, data, schemaVersion: 1, id: randomUUID(), sequence: state.sequence + 1, sessionId: live.spec.id, runtimeId: live.runtimeId, provider: live.spec.provider as StructuredProvider, projectId: live.spec.projectId, workspaceId: live.spec.sessionId, cwd: live.spec.cwd, timestamp: new Date().toISOString(), nativeSessionId: source.nativeSessionId ?? state.nativeSessionId })
    this.pending.push(event)
    this.observe?.(live.spec, event)
    if (data.type === 'usage' && data.source === 'provider' && carriesAccountLimits(data.limits)) this.noteAccountLimits(live, data.limits, event.timestamp)
    // Claude reports usage per stream delta, so evaluating a cap on every event would
    // rescan the whole timeline many times a second. A cap acting a moment late is
    // indistinguishable to the owner; rescanning per delta is not.
    if (data.type === 'usage' && !live.capTimer) live.capTimer = setTimeout(() => {
      live.capTimer = undefined
      if (live.closed) return
      try { this.enforceUsageCap(live) } catch { /* A cap never breaks the event pipeline it observes. */ }
    }, 250)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 32)
    // The provider announces a closed usage window as an ordinary turn failure. Read it here,
    // between appending the error and recording the phase it produces, so the phase below can
    // report the wait rather than a dead end. `noteUsageLimit` re-enters `emit` for its own
    // notice; `live.limitResumeAt` is set first, so that pass is inert.
    if (data.type === 'error') {
      this.noteUsageLimit(live, data.message)
      if (data.code === PROVIDER_SAFEGUARD_REFUSAL) this.noteSafeguardRefusal(live)
    }
    if (data.type === 'session') queueMicrotask(() => {
      if (data.phase === 'failed' && live.refusalFallback) void this.runSafeguardFallback(live)
      else void this.drainQueue(live)
    })
    if (data.type === 'session') {
      const reported = activityPhaseOf(data.phase)
      // A lost connection says nothing on its own about whether output was cut off, so only a
      // conversation that was still in flight reports as disconnected; one that had already
      // settled keeps the state it settled in rather than turning its project into a warning.
      const settled = live.activityPhase ?? 'idle'
      let phase: AgentActivityPhase = reported === 'disconnected' && !inFlight.has(settled) ? settled : reported
      // A turn that ended only because the quota ran out is waiting, not broken: say so, so the
      // tab and its project roll up as limited instead of raising a failure nobody can act on.
      if (live.limitResumeAt && (phase === 'failed' || phase === 'complete' || phase === 'idle')) phase = 'limited'
      live.backgroundTasks = data.backgroundTasks ?? 0
      this.recordActivityPhase(live, this.owningActivityPhase(live, phase))
      live.budget?.setPhase(data.phase)
      if (['disconnected', 'failed', 'interrupted', 'completed'].includes(data.phase)) this.artifacts.discardSession(live.spec.id)
      if (!active.has(data.phase)) { live.budget?.dispose(); live.budget = undefined }
    }
    // A conversation whose own turn reported 'completed' is still churning while a subagent it
    // launched runs on: Claude's turn result lands as soon as it hands work to detached children,
    // and their output keeps streaming into this same conversation for as long as they take.
    // Nothing else re-opens the phase, so the tab dropped its loader for a checkmark and the
    // project rolled up green. Every child lifecycle event re-decides it.
    if (data.type === 'subagent') {
      const phase = this.owningActivityPhase(live, activityPhaseOf(state.phase))
      if (phase !== live.activityPhase) this.recordActivityPhase(live, phase)
    }
    // The same trap one level out: the runtime's background inventory moves between turns - a
    // watcher re-arms, a backgrounded render finally reports - and none of those frames is a
    // lifecycle event, so nothing would re-decide the phase and the tab would keep whatever the
    // last turn said for hours. Restating it as a session event is what carries the change to
    // the renderer's own projection as well as to this phase.
    if (data.type === 'usage' && data.costUsd && process.env.CONDUCTOR_LIVE_TESTS === '1') {
      store.addLiveCost(process.env.CONDUCTOR_LIVE_SUITE_ID!, live.spec.provider as StructuredProvider, data.costUsd)
      for (const session of this.live.values()) if (store.liveCostExceeded(process.env.CONDUCTOR_LIVE_SUITE_ID!, session.spec.provider as StructuredProvider)) this.stopLive(session, 'Live suite observed cost threshold reached')
    }
    if (data.type !== 'session' && live.adapter && !live.closed) {
      const outstanding = live.adapter.backgroundWork?.() ?? 0
      if (outstanding !== (live.backgroundTasks ?? 0)) this.emit(live, { data: { type: 'session', phase: state.phase, backgroundTasks: outstanding } })
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
      if (this.wasCutOff(live)) this.emit(live, { data: { type: 'session', phase: 'disconnected', message: 'Backend stopped; native resume is an explicit action' } })
      this.cancelNativeAcceptances(live, 'The backend closed before native steering acceptance was confirmed. The pending input was retained; inspect the conversation before retrying.')
      // The pending continuation itself stays in SQLite: only this process's timer goes.
      // Reopening the conversation re-arms it, and a wait must not be lost to a backend restart.
      this.cancelContinuation(id)
      live.closed = true; live.budget?.dispose(); if (live.shutdownTimer) clearTimeout(live.shutdownTimer); if (live.capTimer) clearTimeout(live.capTimer); live.adapter?.dispose(); this.live.delete(id); this.mcp?.release(id)
    }
    this.flush()
  }
  /** Whether stopping this runtime now cuts off work: a turn in flight or background work still
   *  reporting into it. An idle or settled conversation keeps the phase it settled in and
   *  reconnects its same native conversation lazily on the next submit, steer or resume, so a
   *  restart or shutdown never turns it 'disconnected'. */
  private wasCutOff(live: LiveSession): boolean {
    if (!live.adapter) return false
    return active.has(this.database.structured.snapshot(live.spec.id)!.phase) || (live.backgroundTasks ?? 0) > 0
  }
  dispose(): void { this.killWhere(() => true); this.database.structured.flush() }
}
