import { execFile } from 'node:child_process'
import type { AdapterOptions, ProviderAdapter } from './adapter'
import { JsonLineTransport, type TransportOptions } from './transport'
import type { ActivityStatus, AdapterEvent, ContextAttachment, FileChange, InteractionResponse, Json, PendingInteraction, ProviderCapabilities, SessionSettings } from '../../shared/structured-agent'
import type { ClientRequest } from './generated/codex/ClientRequest'
import type { InitializeResponse } from './generated/codex/InitializeResponse'
import type { ReasoningEffort } from './generated/codex/ReasoningEffort'
import type { ServerNotification } from './generated/codex/ServerNotification'
import type { ServerRequest } from './generated/codex/ServerRequest'
import type { Model } from './generated/codex/v2/Model'
import type { ModelListResponse } from './generated/codex/v2/ModelListResponse'
import type { ThreadItem } from './generated/codex/v2/ThreadItem'
import type { ThreadStartResponse } from './generated/codex/v2/ThreadStartResponse'
import type { TurnStartParams } from './generated/codex/v2/TurnStartParams'
import type { TurnStartResponse } from './generated/codex/v2/TurnStartResponse'
import type { FileUpdateChange } from './generated/codex/v2/FileUpdateChange'
import type { UserInput } from './generated/codex/v2/UserInput'
import type { ConfigReadResponse } from './generated/codex/v2/ConfigReadResponse'
import type { ConfigRequirementsReadResponse } from './generated/codex/v2/ConfigRequirementsReadResponse'
import type { GetAccountResponse } from './generated/codex/v2/GetAccountResponse'
import type { ThreadForkResponse } from './generated/codex/v2/ThreadForkResponse'
import type { ThreadGoalGetResponse } from './generated/codex/v2/ThreadGoalGetResponse'
import type { SkillsListResponse } from './generated/codex/v2/SkillsListResponse'

export const CODEX_PROTOCOL_BASELINE = '0.153.4'
type WireTransport = Pick<JsonLineTransport, 'start' | 'send' | 'close' | 'connected'> & Partial<Pick<JsonLineTransport, 'closeAndWait'>>
/** Injectable only in backend contract tests; no renderer can supply a transport. */
export interface CodexAdapterDependencies {
  transport?: (options: TransportOptions) => WireTransport
  version?: () => Promise<string>
  requestTimeoutMs?: number
}
type PendingRpc = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type PendingRequest = { request: ServerRequest; interaction: PendingInteraction; blocking: boolean }
type Correlation = Pick<AdapterEvent, 'nativeSessionId' | 'turnId' | 'itemId' | 'parentId'>
type CachedItem = { name: string; status: ActivityStatus }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json
const requestKey = (id: string | number): string => `${typeof id}:${id}`
const textOutput = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const isId = (id: unknown): id is string | number => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
const statusFor = (status: string, complete: boolean): ActivityStatus => status === 'failed' ? 'failed' : status === 'declined' ? 'rejected' : status === 'interrupted' ? 'interrupted' : complete ? 'completed' : status === 'inProgress' ? 'running' : 'preparing'
const LIVE_DISABLED_FEATURES = ['hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'memories', 'unbounded_connection_retries'] as const

/** Process-local CLI overrides; never writes the user's configuration or changes authentication. */
export function codexLaunchArguments(environment: NodeJS.ProcessEnv): string[] {
  const args = ['app-server', '--listen', 'stdio://']
  if (environment.CONDUCTOR_LIVE_TESTS !== '1') return args
  if (!environment.CONDUCTOR_LIVE_MODEL_CODEX || !['cli', 'api'].includes(environment.CONDUCTOR_LIVE_AUTH_CODEX ?? '')) throw new Error('Codex live tests require an explicit approved model and authentication mode')
  const servers: unknown = JSON.parse(environment.CONDUCTOR_LIVE_OPTIONAL_MCP ?? '[]')
  if (!Array.isArray(servers) || servers.length > 128 || servers.some(server => typeof server !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(server))) throw new Error('Live optional MCP names must be an explicit bounded list of simple names without dots or quotes')
  for (const feature of LIVE_DISABLED_FEATURES) args.push('--disable', feature)
  args.push('-c', 'web_search="disabled"', '-c', 'notify=[]', '-c', 'memories.generate_memories=false', '-c', 'memories.use_memories=false')
  // Codex's dotted override-key parser is not a TOML key parser: quotes become literal name bytes.
  for (const server of servers) args.push('-c', `mcp_servers.${server}.enabled=false`)
  return args
}

export function validateCodexLiveConfiguration(config: ConfigReadResponse, requirements: ConfigRequirementsReadResponse): void {
  const effective = config.config
  const features = record(effective.features) ? effective.features : {}
  if (LIVE_DISABLED_FEATURES.some(feature => features[feature] !== false)) throw new Error('Codex live isolation could not verify disabled optional features')
  if (effective.web_search !== 'disabled' || !Array.isArray(effective.notify) || effective.notify.length) throw new Error('Codex live isolation could not verify web/notification restrictions')
  const memories = record(effective.memories) ? effective.memories : {}
  if (memories.generate_memories !== false || memories.use_memories !== false) throw new Error('Codex live isolation could not verify memory restrictions')
  const servers = record(effective.mcp_servers) ? effective.mcp_servers : {}
  if (Object.values(servers).some(server => !record(server) || server.enabled !== false)) throw new Error('Codex live isolation found an enabled MCP server; declare optional servers explicitly before testing')
  const required = requirements.requirements
  if (required?.hooks || required?.allowManagedHooksOnly || LIVE_DISABLED_FEATURES.some(feature => required?.featureRequirements?.[feature] === true) || required?.allowedWebSearchModes && !required.allowedWebSearchModes.includes('disabled')) throw new Error('Live isolation conflicts with required organizational policy; no thread was started')
  for (const layer of config.layers ?? []) {
    if (layer.disabledReason || !['mdm', 'system', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(layer.name.type) || !record(layer.config)) continue
    if (['hooks', 'plugins', 'mcp_servers', 'notify'].some(key => layer.config !== null && record(layer.config) && layer.config[key] !== undefined && JSON.stringify(layer.config[key]) !== '{}' && JSON.stringify(layer.config[key]) !== '[]')) throw new Error('Live isolation would suppress managed integrations; no thread was started')
    const managedFeatures = record(layer.config.features) ? layer.config.features : {}
    if (LIVE_DISABLED_FEATURES.some(feature => managedFeatures[feature] === true)) throw new Error('Live isolation would suppress a managed feature; no thread was started')
  }
}

/** Preserve administrator skills and existing enablement entries; disable only discovered optional paths. */
export function codexLiveSkillOverrides(discovered: SkillsListResponse, config: ConfigReadResponse): Json {
  if (!Array.isArray(discovered.data) || discovered.data.length === 0 || discovered.data.some(entry => !Array.isArray(entry.skills) || entry.errors.length > 0)) throw new Error('Live skill discovery was incomplete; optional context cannot be isolated safely')
  for (const layer of config.layers ?? []) {
    if (!layer.disabledReason && ['mdm', 'system', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(layer.name.type) && record(layer.config) && record(layer.config.skills) && Object.keys(layer.config.skills).length) throw new Error('Managed skill configuration requires preserving its policy; live isolation is blocked')
  }
  const skillConfig = record(config.config.skills) ? config.config.skills : {}
  const inherited = skillConfig.config ?? []
  if (!Array.isArray(inherited) || inherited.some(entry => !record(entry) || typeof entry.path !== 'string' || typeof entry.enabled !== 'boolean')) throw new Error('Unknown native skill enablement shape; live isolation cannot replace it safely')
  const overrides = new Map<string, { path: string; enabled: boolean }>()
  for (const entry of inherited) overrides.set((entry as { path: string }).path, entry as { path: string; enabled: boolean })
  for (const entry of discovered.data) for (const skill of entry.skills) {
    if (skill.scope === 'admin' || !skill.enabled) continue
    if (!['user', 'repo', 'system'].includes(skill.scope) || typeof skill.path !== 'string' || !skill.path || skill.path.length > 4096) throw new Error('Unknown skill scope or path; live isolation is blocked')
    overrides.set(skill.path, { path: skill.path, enabled: false })
  }
  if (overrides.size > 2048) throw new Error('Live skill inventory exceeded the bounded preflight limit')
  return { 'skills.config': [...overrides.values()] }
}

/** Counts only actual unified-diff hunk lines, never headers or prose. */
export function codexDiffCounts(patch: string): { additions: number; deletions: number } | undefined {
  let inHunk = false
  let additions = 0
  let deletions = 0
  let foundHunk = false
  for (const line of patch.split('\n')) {
    if (/^@@(?: |$)/.test(line)) { inHunk = true; foundHunk = true; continue }
    if (/^(diff --git |--- |\+\+\+ )/.test(line)) { inHunk = false; continue }
    if (!inHunk) continue
    if (line.startsWith('+')) additions++
    if (line.startsWith('-')) deletions++
  }
  return foundHunk ? { additions, deletions } : undefined
}

export function codexChanges(changes: FileUpdateChange[], status: FileChange['status']): FileChange[] {
  return changes.map(change => {
    const moved = change.kind.type === 'update' ? change.kind.move_path : null
    return {
      path: moved || change.path,
      ...(moved ? { oldPath: change.path } : {}),
      kind: moved ? 'rename' : change.kind.type,
      patch: change.diff,
      ...codexDiffCounts(change.diff),
      status,
      limitation: 'Provider patch supplied; full versions and undo require verified reconstruction by the artifact store.'
    }
  })
}

export function codexInput(text: string, attachments: ContextAttachment[] = []): UserInput[] {
  const input: UserInput[] = [{ type: 'text', text, text_elements: [] }]
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      if (!attachment.path) throw new Error('Codex image attachments require a validated local path')
      input.push({ type: 'localImage', path: attachment.path })
      continue
    }
    const range = attachment.startLine ? `:${attachment.startLine}${attachment.endLine ? `-${attachment.endLine}` : ''}` : ''
    const label = `${attachment.kind}: ${attachment.path ?? attachment.name}${range}`
    input.push({ type: 'text', text: `[Attached ${label}]${attachment.content === undefined ? '' : `\n${attachment.content}`}`, text_elements: [] })
  }
  return input
}

/** One App Server process per backend-owned session; views never construct this class. */
export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const
  readonly capabilities: ProviderCapabilities = {
    provider: 'codex', runtimeVersion: 'unknown', adapterVersion: 1, authentication: 'cli',
    textStreaming: true, toolInputStreaming: false, toolOutputStreaming: true,
    approvals: true, questions: true, resume: true, fork: true, plans: false, imageAttachments: true, effort: ['minimal', 'low', 'medium', 'high', 'xhigh'], models: [], permissions: ['default', 'read-only', 'accept-edits'],
    sandboxModes: ['inherit', 'read-only', 'workspace-write'], approvalPolicies: ['inherit', 'untrusted', 'on-request', 'never'],
    limitations: [
      'Command output combines stdout and stderr in the App Server item protocol.',
      'Before/after bytes are not exposed; undo is available only when the artifact store verifies complete immutable versions against the provider patch.',
      'App Server processes end when the Conductor backend exits. Resume is explicit and never resends a turn.',
      'Plan mode requires CONDUCTOR_CODEX_EXPERIMENTAL=1 and the tested runtime version.',
      'Cloud delegation, browser sessions, MCP elicitation forms, and plugin management have no native Conductor control yet.'
    ]
  }
  private transport?: WireTransport
  private starting?: Promise<void>
  private disposed = false
  private failed = false
  private requestId = 0
  private rpc = new Map<string, PendingRpc>()
  private pending = new Map<string, PendingRequest>()
  private items = new Map<string, CachedItem>()
  private childParents = new Map<string, string>()
  private threadId?: string
  private turnId?: string
  private dispatching = false
  private interrupted = false
  private liveRetryStopped = false
  private completedTurns = new Set<string>()
  private completedItems = new Set<string>()
  private defaults?: ThreadStartResponse
  private models: Model[] = []
  private experimental = false

  constructor(private options: AdapterOptions, private dependencies: CodexAdapterDependencies = {}) {}

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Codex adapter has been disposed'))
    return this.starting ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    this.emit({ data: { type: 'session', phase: 'starting' } })
    try {
      const version = await (this.dependencies.version?.() ?? new Promise<string>((resolve, reject) => {
        execFile(this.options.executable, ['--version'], { cwd: this.options.cwd, env: this.options.environment ?? process.env, windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
      }))
      this.capabilities.runtimeVersion = version.replace(/^codex-cli\s+/, '')
      if (!/^0\.153\./.test(this.capabilities.runtimeVersion)) throw new Error(`Codex ${this.capabilities.runtimeVersion} is outside the tested 0.153.x protocol baseline; regenerate and verify the adapter before connecting`)
      if (this.capabilities.runtimeVersion !== CODEX_PROTOCOL_BASELINE) this.capabilities.limitations.push(`Runtime ${this.capabilities.runtimeVersion} is not fixture-verified; baseline is ${CODEX_PROTOCOL_BASELINE}. Experimental features are disabled.`)
      this.experimental = (this.options.environment ?? process.env).CONDUCTOR_CODEX_EXPERIMENTAL === '1' && this.capabilities.runtimeVersion === CODEX_PROTOCOL_BASELINE
      this.capabilities.plans = this.experimental
      const factory = this.dependencies.transport ?? (options => new JsonLineTransport(options))
      this.transport = factory({
        executable: this.options.executable, args: codexLaunchArguments(this.options.environment ?? process.env),
        cwd: this.options.cwd, environment: this.options.environment,
        onMessage: message => this.receive(message),
        onStderr: output => this.emit({ data: { type: 'notice', message: 'Codex process diagnostic (stderr)', payload: output }, native: { method: 'process/stderr' } }),
        onError: error => this.disconnect(error.message),
        onExit: (code, signal) => this.disconnect(`Codex App Server exited (${signal ?? code ?? 'unknown'}). Any unfinished execution is uncertain.`)
      })
      this.transport.start()
      // No initialized notification, metadata request, or thread request may precede this response.
      const initialized = await this.request<InitializeResponse>('initialize', {
        clientInfo: { name: 'conductor', title: 'Conductor', version: '1' },
        capabilities: { experimentalApi: this.experimental, requestAttestation: false }
      })
      if (!record(initialized) || typeof initialized.userAgent !== 'string') throw new Error('Malformed Codex initialize response')
      this.transport.send({ method: 'initialized' })
      const liveEnvironment = this.options.environment ?? process.env
      let liveThreadConfig: Json | undefined
      if (liveEnvironment.CONDUCTOR_LIVE_TESTS === '1') {
        const requirements = await this.request<ConfigRequirementsReadResponse>('configRequirements/read')
        const config = await this.request<ConfigReadResponse>('config/read', { cwd: this.options.cwd, includeLayers: true })
        validateCodexLiveConfiguration(config, requirements)
        const discoveredSkills = await this.request<SkillsListResponse>('skills/list', { cwds: [this.options.cwd], forceReload: true })
        liveThreadConfig = codexLiveSkillOverrides(discoveredSkills, config)
        const account = await this.request<GetAccountResponse>('account/read', { refreshToken: false })
        const expectedType = liveEnvironment.CONDUCTOR_LIVE_AUTH_CODEX === 'api' ? 'apiKey' : 'chatgpt'
        if (account.account?.type !== expectedType || config.config.model_provider && config.config.model_provider !== 'openai') throw new Error('Configured Codex authentication/billing route does not match the approved live connection')
        const catalog = await this.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false })
        if (!catalog.data.some(model => model.model === liveEnvironment.CONDUCTOR_LIVE_MODEL_CODEX && model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === 'low'))) throw new Error('The approved Codex live model with low effort is unavailable; no substitution is allowed')
        this.emit({ data: { type: 'notice', message: 'Codex live fixture isolation verified before thread creation', payload: { authentication: expectedType, model: liveEnvironment.CONDUCTOR_LIVE_MODEL_CODEX!, disabledOptionalFeatures: [...LIVE_DISABLED_FEATURES] } } })
      }
      const method = this.options.nativeSessionId ? 'thread/resume' : 'thread/start'
      const params = this.options.nativeSessionId
        ? { threadId: this.options.nativeSessionId, cwd: this.options.cwd, excludeTurns: true, ...(liveThreadConfig ? { config: liveThreadConfig } : {}) }
        : { cwd: this.options.cwd, ...(liveThreadConfig ? { config: liveThreadConfig } : {}), ...(liveEnvironment.CONDUCTOR_LIVE_TESTS === '1' ? { model: liveEnvironment.CONDUCTOR_LIVE_MODEL_CODEX } : this.options.settings.model ? { model: this.options.settings.model } : {}) }
      const result = await this.request<ThreadStartResponse>(method, json(params))
      if (!record(result) || !record(result.thread) || typeof result.thread.id !== 'string') throw new Error('Malformed Codex thread response')
      this.threadId = result.thread.id
      this.defaults = result
      this.capabilities.effectiveSettings = json({ model: result.model, effort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox })
      // Historical hydration belongs to durable local replay. Never replay old items as new work.
      const active = result.thread.turns?.find(turn => turn.status === 'inProgress')
      if (active) this.turnId = active.id
      else if (record(result.thread.status) && result.thread.status.type === 'active') {
        throw new Error('The resumed Codex thread is active but its turn identity is unavailable. No prompt was sent; reconnect explicitly after it stops.')
      }
      this.emit({ data: { type: 'notice', message: 'Codex effective thread settings', payload: json({ model: result.model, reasoningEffort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, approvalsReviewer: result.approvalsReviewer, instructionSources: result.instructionSources }) }, native: { method, payload: json({ threadId: this.threadId, modelProvider: result.modelProvider }) } })
      try {
        const catalog = await this.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false })
        this.models = Array.isArray(catalog.data) ? catalog.data : []
        this.capabilities.models = this.models.map(model => ({ id: model.model, label: model.displayName }))
        this.capabilities.effort = [...new Set(this.models.flatMap(model => model.supportedReasoningEfforts.map(option => option.reasoningEffort)))]
      } catch { this.capabilities.limitations.push('Model discovery failed; model and effort availability are unknown until the runtime accepts a turn.') }
      this.emit({ data: { type: 'session', phase: this.turnId ? 'running' : 'idle', nativeSessionId: this.threadId, capabilities: this.capabilities } })
    } catch (error) {
      this.disconnect(error instanceof Error ? error.message : 'Codex connection failed')
      this.transport?.close()
      throw error
    }
  }

  async submit(text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void> {
    await this.start()
    if (this.disposed || this.failed || !this.threadId || !this.defaults || !this.transport?.connected) throw new Error('Codex session is disconnected; resume explicitly')
    if (this.turnId || this.dispatching || this.pending.size) throw new Error('A Codex turn or interaction is already active')
    if (settings.plan && !this.experimental) throw new Error('Codex plan mode requires the explicitly enabled experimental protocol')
    const model = settings.model || this.defaults.model
    const modelInfo = this.models.find(candidate => candidate.model === model)
    if (settings.effort && modelInfo && !modelInfo.supportedReasoningEfforts.some(option => option.reasoningEffort === settings.effort)) throw new Error(`Reasoning effort ${settings.effort} is not offered for ${model}`)
    if (settings.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(settings.effort)) throw new Error('Unsupported Codex reasoning effort')
    const sandbox = settings.sandbox ?? (settings.permission === 'default' ? 'inherit' : settings.permission === 'read-only' ? 'read-only' : 'workspace-write')
    const approvalPolicy = settings.approvalPolicy ?? (settings.permission === 'default' ? 'inherit' : settings.permission === 'read-only' ? 'untrusted' : 'on-request')
    if (!this.capabilities.sandboxModes!.includes(sandbox) || !this.capabilities.approvalPolicies!.includes(approvalPolicy)) throw new Error('Unsupported Codex sandbox or approval policy')
    const params: TurnStartParams = {
      threadId: this.threadId, input: codexInput(text, attachments), cwd: this.options.cwd, model,
      effort: (settings.effort as ReasoningEffort | undefined) ?? this.defaults.reasoningEffort,
      approvalPolicy: approvalPolicy === 'inherit' ? this.defaults.approvalPolicy : approvalPolicy,
      sandboxPolicy: sandbox === 'inherit' ? this.defaults.sandbox : sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [this.options.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    }
    // Native collaboration mode survives adapter reconstruction/resume. Always
    // apply the selected mode when this version-gated surface is enabled.
    if (this.experimental) params.collaborationMode = {
      mode: settings.plan ? 'plan' : 'default',
      settings: { model, reasoning_effort: params.effort ?? null, developer_instructions: null }
    }
    this.dispatching = true
    this.interrupted = false
    this.liveRetryStopped = false
    this.items.clear()
    this.completedItems.clear()
    try {
      const result = await this.request<TurnStartResponse>('turn/start', json(params))
      if (!result.turn || typeof result.turn.id !== 'string') throw new Error('Malformed Codex turn response; execution state is uncertain')
      if (!this.completedTurns.has(result.turn.id)) {
        this.turnId = result.turn.id
        this.capabilities.effectiveSettings = json({ model: params.model, effort: params.effort, approvalPolicy: params.approvalPolicy, sandbox: params.sandboxPolicy })
        this.emit({ data: { type: 'session', phase: 'running', capabilities: this.capabilities } })
      }
    } catch (error) {
      // A lost acknowledgement is not permission to retry or claim that nothing executed.
      this.disconnect(error instanceof Error ? error.message : 'Codex turn dispatch failed')
      throw error
    } finally { this.dispatching = false }
  }

  async respond(response: InteractionResponse): Promise<void> {
    if (response.runtimeId !== this.options.runtimeId || this.failed || this.disposed || !this.transport?.connected) throw new Error('This Codex interaction belongs to a stale runtime')
    const pending = this.pending.get(response.requestId)
    if (!pending) throw new Error('Codex interaction has expired or was already answered')
    const { request, interaction } = pending
    let result: Json
    if (request.method === 'item/tool/requestUserInput') {
      const answers = response.answers
      if (!answers || Object.keys(answers).some(key => !request.params.questions.some(question => question.id === key))) throw new Error('Question answers must match the pending Codex question IDs')
      for (const question of request.params.questions) {
        const values = answers[question.id]
        if (!values || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim() || values[0].length > 16_384) throw new Error('Every Codex question requires one non-empty answer')
        if (question.options?.length && !question.isOther && !question.options.some(option => option.label === values[0])) throw new Error('Select one of the options offered by Codex')
      }
      result = { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) }
    } else {
      if (!response.decision || !interaction.choices.some(choice => choice.id === response.decision)) throw new Error('That decision is not offered by this Codex request')
      if (request.method === 'item/permissions/requestApproval') {
        const granted = response.decision === 'accept' || response.decision === 'acceptForSession'
        result = { permissions: granted ? json(Object.fromEntries(Object.entries(request.params.permissions).filter(([, value]) => value !== null))) : {}, scope: response.decision === 'acceptForSession' ? 'session' : 'turn' }
      } else result = { decision: response.decision }
    }
    // Reserve the response synchronously; a second pane cannot submit the same request.
    this.pending.delete(response.requestId)
    try { this.transport.send({ id: request.id, result }) } catch (error) {
      this.emitInteraction(request, { ...interaction, status: 'expired', outcome: 'Delivery uncertain after disconnect' })
      this.disconnect('Codex interaction response delivery is uncertain')
      throw error
    }
    this.emitInteraction(request, { ...interaction, status: 'resolved', outcome: response.decision ?? 'answered' })
    this.emitPhase()
  }

  async interrupt(): Promise<void> {
    if (this.disposed || this.failed || !this.transport?.connected) throw new Error('Codex runtime is disconnected')
    if (!this.turnId) {
      if (this.dispatching) throw new Error('Codex turn acknowledgement is pending; interruption is not yet addressable')
      return
    }
    this.interrupted = true
    this.emit({ data: { type: 'session', phase: 'interrupting' } })
    // Success is only the later turn/completed event, never this acknowledgement.
    await this.request('turn/interrupt', { threadId: this.threadId!, turnId: this.turnId })
  }

  async fork(): Promise<string> {
    await this.start()
    if (this.failed || this.disposed || !this.threadId || this.turnId || this.dispatching || this.pending.size) throw new Error('Only a connected idle Codex conversation can be forked')
    const goal = await this.request<ThreadGoalGetResponse>('thread/goal/get', { threadId: this.threadId })
    if (goal.goal && goal.goal.status !== 'complete') throw new Error('Forking a native goal could start automatic work. Complete the goal before creating a history-only fork.')
    const response = await this.request<ThreadForkResponse>('thread/fork', { threadId: this.threadId, excludeTurns: true })
    if (!response.thread?.id || response.thread.id === this.threadId) throw new Error('Codex did not return a distinct fork identity')
    // The new backend session will explicitly resume this native conversation.
    await this.request('thread/unsubscribe', { threadId: response.thread.id })
    return response.thread.id
  }

  async rename(title: string): Promise<void> {
    await this.start()
    if (!this.threadId || this.failed || this.disposed) throw new Error('Codex runtime is disconnected')
    if (!title.trim() || title.length > 200) throw new Error('Codex conversation names must be 1-200 characters')
    await this.request('thread/name/set', { threadId: this.threadId, name: title.trim() })
  }

  async archive(archived: boolean): Promise<void> {
    await this.start()
    if (!this.threadId || this.failed || this.disposed || this.turnId || this.dispatching || this.pending.size) throw new Error('Only a connected idle Codex conversation can be archived')
    await this.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: this.threadId })
  }

  async discover(): Promise<Json> {
    await this.start()
    if (this.failed || this.disposed) throw new Error('Codex runtime is disconnected')
    if ((this.options.environment ?? process.env).CONDUCTOR_LIVE_TESTS === '1') throw new Error('Optional discovery is disabled during the capped live fixture suite')
    const requests = [
      { label: 'skills', method: 'skills/list' as const, params: { cwds: [this.options.cwd], forceReload: true } },
      { label: 'mcpServers', method: 'mcpServerStatus/list' as const, params: { threadId: this.threadId!, limit: 100, detail: 'toolsAndAuthOnly' } },
      { label: 'plugins', method: 'plugin/list' as const, params: { cwds: [this.options.cwd], marketplaceKinds: ['local'], forceRefetch: false } }
    ]
    const results = await Promise.allSettled(requests.map(request => this.request(request.method, json(request.params))))
    return json(Object.fromEntries(results.map((result, index) => [requests[index]!.label, result.status === 'fulfilled' ? { status: 'available', payload: result.value } : { status: 'unavailable', message: result.reason instanceof Error ? result.reason.message : 'Provider discovery failed' }])))
  }

  async history(): Promise<import('../native-history').NativeHistoryItem[]> {
    if (!this.threadId) return []
    const result = await this.request<import('./generated/codex/v2/ThreadReadResponse').ThreadReadResponse>('thread/read', { threadId: this.threadId, includeTurns: true })
    const items: import('../native-history').NativeHistoryItem[] = []
    for (const turn of result.thread.turns ?? []) for (const item of turn.items) {
      const base = { id: turn.id + ':' + item.id, turnId: turn.id }
      if (item.type === 'userMessage') items.push({ ...base, data: { type: 'text', role: 'user', mode: 'snapshot', text: item.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') } })
      else if (item.type === 'agentMessage') items.push({ ...base, data: { type: 'text', role: 'assistant', mode: 'snapshot', text: item.text } })
      else if (item.type === 'commandExecution') items.push({ ...base, data: { type: 'tool', name: 'Command', input: { command: item.command, cwd: item.cwd }, status: item.exitCode ? 'failed' : item.status === 'completed' ? 'completed' : 'interrupted', output: item.aggregatedOutput ?? undefined, exitCode: item.exitCode ?? undefined } })
      else if (item.type === 'fileChange') items.push({ ...base, data: { type: 'changes', changes: codexChanges(item.changes, item.status === 'completed' ? 'applied' : 'failed') } })
    }
    return items.slice(-2000)
  }
  async stop(): Promise<void> { this.dispose(); await this.transport?.closeAndWait?.() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnect('Conductor closed its owned Codex runtime. Historical events remain readable; unfinished execution may be uncertain.')
    this.transport?.close()
  }

  private request<T = Json>(method: ClientRequest['method'], params?: Json): Promise<T> {
    if (!this.transport?.connected) return Promise.reject(new Error('Codex transport is disconnected'))
    const id = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      const key = requestKey(id)
      const timer = setTimeout(() => {
        this.rpc.delete(key)
        reject(new Error(`Codex ${method} acknowledgement timed out; do not automatically retry`))
      }, this.dependencies.requestTimeoutMs ?? 20_000)
      this.rpc.set(key, { resolve: value => resolve(value as T), reject, timer })
      try { this.transport!.send({ id, method, ...(params === undefined ? {} : { params }) }) }
      catch (error) { clearTimeout(timer); this.rpc.delete(key); reject(error) }
    })
  }

  private receive(message: Json): void {
    if (!record(message) || this.disposed) return
    if (isId(message.id) && typeof message.method !== 'string') {
      const pending = this.rpc.get(requestKey(message.id))
      if (!pending) return this.unknown('rpc/unmatched', message)
      clearTimeout(pending.timer)
      this.rpc.delete(requestKey(message.id))
      if (record(message.error)) pending.reject(new Error(`Codex request failed (${String(message.error.code ?? 'unknown')}): ${String(message.error.message ?? 'Unknown provider error')}`))
      else if ('result' in message) pending.resolve(message.result)
      else pending.reject(new Error('Malformed Codex RPC response'))
      return
    }
    if (typeof message.method !== 'string' || !record(message.params)) return this.unknown('protocol/unknown', message)
    if (this.failed) return this.unknown(message.method, message.params, 'Late provider event after disconnect; retained without changing live state')
    try {
      if (isId(message.id)) this.serverRequest(message as unknown as ServerRequest)
      else this.notification(message as unknown as ServerNotification)
    } catch {
      this.unknown(message.method, message.params, 'Malformed or unsupported Codex event retained for inspection')
      if (isId(message.id)) this.transport?.send({ id: message.id, error: { code: -32602, message: 'Conductor cannot safely handle this request shape' } })
    }
  }

  private correlation(params: unknown): Correlation {
    const value = record(params) ? params : {}
    const nativeSessionId = typeof value.threadId === 'string' ? value.threadId : this.threadId
    return {
      nativeSessionId, turnId: typeof value.turnId === 'string' ? value.turnId : undefined,
      itemId: typeof value.itemId === 'string' ? value.itemId : undefined,
      ...(nativeSessionId && this.childParents.has(nativeSessionId) ? { parentId: this.childParents.get(nativeSessionId) } : {})
    }
  }

  private notification(message: ServerNotification): void {
    const { method, params } = message
    const context = this.correlation(params)
    const native = { method, payload: json(params) }
    const send = (data: AdapterEvent['data'], extra: Partial<AdapterEvent> = {}): void => this.emit({ ...context, data, native, ...extra })
    switch (method) {
      case 'thread/started':
        if (!this.threadId && !params.thread.parentThreadId) this.threadId = params.thread.id
        if (params.thread.parentThreadId) {
          const parent = this.childParents.get(params.thread.id)
          send({ type: 'subagent', name: params.thread.agentNickname ?? params.thread.agentRole ?? 'Codex agent', nativeSessionId: params.thread.id, status: 'running' }, { nativeSessionId: params.thread.id, itemId: `thread:${params.thread.id}`, parentId: parent })
        }
        return
      case 'turn/started':
        if (params.threadId === this.threadId) {
          this.turnId = params.turn.id
          send({ type: 'session', phase: 'running' }, { turnId: params.turn.id })
        }
        return
      case 'turn/completed': {
        this.completedTurns.add(params.turn.id)
        if (this.completedTurns.size > 128) this.completedTurns.delete(this.completedTurns.values().next().value!)
        // Completion contains authoritative item snapshots where available.
        for (const item of params.turn.items ?? []) this.item(item, { ...context, turnId: params.turn.id }, true, native)
        this.expireRequests('Turn completed', params.threadId, params.turn.id)
        if (params.threadId === this.threadId && (!this.turnId || this.turnId === params.turn.id)) {
          this.turnId = undefined
          if (params.turn.error) send({ type: 'error', message: params.turn.error.message })
          send({ type: 'session', phase: params.turn.status === 'failed' ? 'failed' : params.turn.status === 'interrupted' ? 'interrupted' : 'completed' }, { turnId: params.turn.id })
        }
        return
      }
      case 'item/started': case 'item/completed':
        this.item(params.item, context, method === 'item/completed', native)
        return
      case 'item/agentMessage/delta':
        if (typeof params.delta !== 'string') throw new Error('Invalid text delta')
        if (this.completedItems.has(this.itemKey(context))) return this.unknown(method, params, 'Late text after the authoritative item snapshot')
        send({ type: 'text', role: 'assistant', text: params.delta, mode: 'delta' })
        return
      case 'item/reasoning/summaryTextDelta':
        send({ type: 'text', role: 'status', text: params.delta, mode: 'delta' }, { itemId: `${params.itemId}:summary:${params.summaryIndex}` })
        return
      case 'item/reasoning/textDelta':
        // Raw reasoning is not requested or presented. Only provider-exposed readable summaries above.
        return
      case 'item/plan/delta':
        send({ type: 'text', role: 'status', text: params.delta, mode: 'delta' })
        return
      case 'item/commandExecution/outputDelta': case 'item/fileChange/outputDelta': {
        if (typeof params.delta !== 'string') throw new Error('Invalid output delta')
        if (this.completedItems.has(this.itemKey(context))) return this.unknown(method, params, 'Late output after the authoritative item snapshot')
        const item = this.items.get(this.itemKey(context))
        send({ type: 'tool', name: item?.name ?? (method.includes('fileChange') ? 'File change' : 'Command'), status: item?.status === 'completed' || item?.status === 'failed' ? item.status : 'running', output: params.delta, outputMode: 'delta' })
        return
      }
      case 'item/fileChange/patchUpdated':
        send({ type: 'changes', changes: codexChanges(params.changes, 'proposed') })
        return
      case 'turn/diff/updated':
        // Turn aggregates must not be added to per-tool totals or interpreted as a second file edit.
        send({ type: 'notice', message: 'Current turn diff (provider aggregate)', payload: params.diff }, { itemId: `turn-diff:${params.turnId}` })
        return
      case 'turn/plan/updated':
        send({ type: 'plan', steps: params.plan.map(step => ({ text: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })), ...(params.explanation ? { explanation: params.explanation } : {}) }, { itemId: `plan:${params.turnId}` })
        return
      case 'thread/tokenUsage/updated':
        send({ type: 'usage', inputTokens: params.tokenUsage.total.inputTokens, outputTokens: params.tokenUsage.total.outputTokens, cachedTokens: params.tokenUsage.total.cachedInputTokens, source: 'provider', limits: json({ modelContextWindow: params.tokenUsage.modelContextWindow }) }, { itemId: `usage:${params.threadId}` })
        return
      case 'thread/settings/updated':
        if (params.threadId === this.threadId) {
          const settings = params.threadSettings
          this.capabilities.effectiveSettings = json({ model: settings.model, effort: settings.effort, approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy })
          send({ type: 'notice', message: 'Native Codex settings updated', payload: this.capabilities.effectiveSettings })
          this.emitPhase(true)
        }
        return
      case 'account/rateLimits/updated':
        send({ type: 'usage', source: 'provider', limits: json(params) }, { itemId: 'account-rate-limits' })
        return
      case 'serverRequest/resolved': {
        const key = requestKey(params.requestId)
        const pending = this.pending.get(key)
        if (pending && 'threadId' in pending.request.params && pending.request.params.threadId === params.threadId) {
          this.pending.delete(key)
          this.emitInteraction(pending.request, { ...pending.interaction, status: 'expired', outcome: 'Resolved or cleared by Codex' })
          this.emitPhase()
        }
        return
      }
      case 'item/mcpToolCall/progress':
        send({ type: 'tool', name: this.items.get(this.itemKey(context))?.name ?? 'MCP tool', status: 'running', output: params.message, outputMode: 'delta' })
        return
      case 'error':
        send({ type: 'error', message: params.error.message })
        if (params.willRetry && (this.options.environment ?? process.env).CONDUCTOR_LIVE_TESTS === '1' && !this.liveRetryStopped) {
          this.liveRetryStopped = true
          this.interrupted = true
          send({ type: 'notice', message: 'Live retry stopped: requesting native interruption. An already in-flight retry may not be preventable.' })
          send({ type: 'session', phase: 'interrupting' })
          void this.request('turn/interrupt', { threadId: params.threadId, turnId: params.turnId }).catch(() => this.disconnect('Live retry interruption failed; execution is uncertain'))
        }
        if (!params.willRetry && params.threadId === this.threadId) send({ type: 'session', phase: 'failed' })
        return
      case 'thread/closed':
        if (params.threadId === this.threadId) this.disconnect('Codex closed the thread; resume explicitly')
        return
      default:
        this.unknown(method, params)
    }
  }

  private item(item: ThreadItem, context: Correlation, complete: boolean, native: AdapterEvent['native']): void {
    if (!record(item) || typeof item.id !== 'string' || typeof item.type !== 'string') throw new Error('Malformed Codex item')
    const correlation = { ...context, itemId: item.id }
    if (complete) {
      if (this.completedItems.size >= 2048) this.completedItems.delete(this.completedItems.values().next().value!)
      this.completedItems.add(this.itemKey(correlation))
    }
    const send = (data: AdapterEvent['data'], extra: Partial<AdapterEvent> = {}): void => this.emit({ ...correlation, data, native, ...extra })
    const tool = (name: string, data: Omit<Extract<AdapterEvent['data'], { type: 'tool' }>, 'type' | 'name'>): void => {
      if (this.items.size >= 2048) this.items.delete(this.items.keys().next().value!)
      this.items.set(this.itemKey(correlation), { name, status: data.status })
      send({ type: 'tool', name, ...data })
    }
    switch (item.type) {
      case 'userMessage': return // Host already persisted the exact submitted input once.
      case 'agentMessage':
        send({ type: 'text', role: 'assistant', text: item.text, mode: 'snapshot' })
        return
      case 'reasoning':
        item.summary.forEach((summary, index) => send({ type: 'text', role: 'status', text: summary, mode: 'snapshot' }, { itemId: `${item.id}:summary:${index}` }))
        return
      case 'plan':
        send({ type: 'text', role: 'status', text: item.text, mode: 'snapshot' })
        return
      case 'commandExecution': {
        const name = /(?:^|[\\/\s"'])(?:pwsh|powershell)(?:\.exe)?(?:[\s"']|$)/i.test(item.command) ? 'PowerShell' : /(?:^|[\\/\s"'])bash(?:\.exe)?(?:[\s"']|$)/i.test(item.command) ? 'Bash' : 'Command'
        const actions = item.commandActions ?? []
        const action = actions[0]
        const description = action?.type === 'read' ? `Read ${action.name}` : action?.type === 'search' ? `Search ${action.query ?? action.path ?? ''}` : `Run ${item.command.split(/\r?\n/, 1)[0]!.slice(0, 120)}`
        const status = item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0 ? 'failed' : !complete && item.status === 'inProgress' && !item.processId && !item.aggregatedOutput ? 'preparing' : statusFor(item.status, complete)
        tool(name, { description, input: json({ command: item.command, cwd: item.cwd, actions }), status, ...(item.aggregatedOutput !== null && item.aggregatedOutput !== undefined ? { output: item.aggregatedOutput, outputMode: 'snapshot' as const } : {}), ...(item.exitCode !== null && item.exitCode !== undefined ? { exitCode: item.exitCode } : {}), ...(item.durationMs !== null && item.durationMs !== undefined ? { durationMs: item.durationMs } : {}) })
        return
      }
      case 'fileChange':
        tool('File change', { description: item.changes.map(change => change.path).join(', '), status: statusFor(item.status, complete), input: json(item.changes.map(change => ({ path: change.path, kind: change.kind }))) })
        send({ type: 'changes', changes: codexChanges(item.changes, complete ? item.status === 'completed' ? 'applied' : item.status === 'declined' ? 'rejected' : 'failed' : 'proposed') })
        return
      case 'mcpToolCall':
        tool(`${item.server}/${item.tool}`, { input: json(item.arguments), status: statusFor(item.status, complete), ...(item.result ? { output: textOutput(item.result.structuredContent ?? item.result.content), outputMode: 'snapshot' as const } : {}), ...(item.error ? { output: item.error.message, outputMode: 'snapshot' as const } : {}), ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}) })
        return
      case 'dynamicToolCall':
        tool(item.namespace ? `${item.namespace}/${item.tool}` : item.tool, { input: json(item.arguments), status: item.success === false ? 'failed' : statusFor(item.status, complete), ...(item.contentItems ? { output: textOutput(item.contentItems), outputMode: 'snapshot' as const } : {}), ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}) })
        return
      case 'collabAgentToolCall':
        tool(item.tool, { input: json({ prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model, effort: item.reasoningEffort }), status: statusFor(item.status, complete) })
        for (const child of item.receiverThreadIds) {
          if (this.childParents.size >= 2048) this.childParents.delete(this.childParents.keys().next().value!)
          this.childParents.set(child, item.id)
          const state = item.agentsStates[child]
          send({ type: 'subagent', name: 'Codex agent', nativeSessionId: child, status: state?.status === 'completed' ? 'completed' : state?.status === 'errored' ? 'failed' : 'running' }, { itemId: `thread:${child}`, parentId: item.id })
        }
        return
      case 'subAgentActivity':
        send({ type: 'subagent', name: item.agentPath, nativeSessionId: item.agentThreadId, status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'interrupted' : 'running' }, { parentId: this.childParents.get(item.agentThreadId) })
        return
      default:
        // Future/bespoke items remain inspectable and never authorize host tool execution.
        send({ type: 'notice', message: `Codex ${item.type}`, payload: json(item) })
    }
  }

  private serverRequest(request: ServerRequest): void {
    const params = request.params
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval'].includes(request.method)
    if (!supported) {
      this.unknown(request.method, params, 'Codex requested an unsupported client action; no tool or credential action was executed')
      this.transport?.send({ id: request.id, error: { code: -32601, message: 'This Conductor client does not implement this method' } })
      return
    }
    if (!('threadId' in params) || !('turnId' in params) || typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || !('itemId' in params) || typeof params.itemId !== 'string') throw new Error('Missing request identity')
    if (params.threadId !== this.threadId && !this.childParents.has(params.threadId)) throw new Error('Request belongs to an unrelated thread')
    if (this.completedTurns.has(params.turnId)) {
      this.transport?.send({ id: request.id, error: { code: -32602, message: 'Turn is already complete' } })
      return
    }
    const id = requestKey(request.id)
    if (this.pending.has(id)) throw new Error('Duplicate provider request ID')
    if (this.pending.size >= 128) throw new Error('Too many pending provider requests')
    let choices = [{ id: 'accept', label: 'Allow once' }, { id: 'acceptForSession', label: 'Allow for this session' }, { id: 'decline', label: 'Deny' }, { id: 'cancel', label: 'Cancel turn' }]
    let title = 'Approve file changes'
    if (request.method === 'item/commandExecution/requestApproval') {
      title = request.params.networkApprovalContext ? `Allow network access: ${request.params.networkApprovalContext.host}` : request.params.reason ?? 'Approve command execution'
      if (request.params.availableDecisions) choices = choices.filter(choice => request.params.availableDecisions!.some(decision => decision === choice.id))
    } else if (request.method === 'item/permissions/requestApproval') {
      title = request.params.reason ?? 'Grant requested permissions'
      choices = [{ id: 'accept', label: 'Grant for this turn' }, { id: 'acceptForSession', label: 'Grant for this session' }, { id: 'decline', label: 'Deny' }]
    }
    const isQuestion = request.method === 'item/tool/requestUserInput'
    const interaction: PendingInteraction = {
      id, kind: isQuestion ? 'question' : 'approval', title: isQuestion ? 'Codex needs your input' : title,
      input: json(params), choices: isQuestion ? [] : choices, status: 'pending',
      ...(isQuestion ? { questions: request.params.questions.map(question => ({ id: question.id, header: question.header, question: question.question, options: question.options ?? [], isSecret: question.isSecret, allowCustom: question.isOther || !question.options?.length })) } : {})
    }
    this.pending.set(id, { request, interaction, blocking: !isQuestion || request.params.isBlocking !== false })
    this.emitInteraction(request, interaction)
    if (!isQuestion) this.emit({ ...this.correlation(params), data: { type: 'tool', name: this.items.get(this.itemKey(this.correlation(params)))?.name ?? (request.method.includes('fileChange') ? 'File change' : 'Command'), status: 'awaiting_approval' } })
    this.emitPhase()
  }

  private emitInteraction(request: ServerRequest, interaction: PendingInteraction): void {
    this.emit({ ...this.correlation(request.params), requestId: interaction.id, data: { type: 'interaction', interaction }, native: { method: request.method, payload: json(request.params) } })
  }

  private emitPhase(includeCapabilities = false): void {
    if (this.failed || this.disposed) return
    const requests = [...this.pending.values()].filter(request => request.blocking)
    const phase = this.interrupted ? 'interrupting' : requests.some(request => request.interaction.kind === 'approval') ? 'waiting_approval' : requests.length ? 'waiting_input' : this.turnId || this.dispatching ? 'running' : 'idle'
    this.emit({ data: { type: 'session', phase, ...(includeCapabilities ? { capabilities: this.capabilities } : {}) } })
  }

  private expireRequests(reason: string, threadId?: string, turnId?: string): void {
    for (const [id, pending] of this.pending) {
      const context = this.correlation(pending.request.params)
      if (threadId && context.nativeSessionId !== threadId || turnId && context.turnId !== turnId) continue
      this.pending.delete(id)
      this.emitInteraction(pending.request, { ...pending.interaction, status: 'expired', outcome: reason })
    }
  }

  private disconnect(message: string): void {
    if (this.failed) return
    this.failed = true
    for (const pending of this.rpc.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.rpc.clear()
    this.expireRequests('Runtime disconnected')
    this.emit({ data: { type: 'session', phase: 'disconnected', message } })
  }

  private itemKey(context: Correlation): string { return JSON.stringify([context.nativeSessionId, context.turnId, context.itemId]) }
  private emit(event: AdapterEvent): void { this.options.emit({ nativeSessionId: this.threadId, turnId: this.turnId, ...event }) }
  private unknown(method: string, payload: unknown, message = `Codex event: ${method}`): void {
    this.emit({ ...this.correlation(payload), data: { type: 'notice', message, payload: json(payload) }, native: { method, payload: json(payload) } })
  }
}
