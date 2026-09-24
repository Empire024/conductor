import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { AdapterOptions, ProviderAdapter, RuntimeDetachment } from './adapter'
import { captureAdapterState, restoreAdapterState, settled } from './adapter-state'
import { JsonLineTransport, type HostedRuntimeHandle, type TransportOptions } from './transport'
import { ownerOnlyEscalation } from './codex'
import type { ActivityStatus, AdapterEvent, ContextAttachment, FileChange, InteractionResponse, Json, PendingInteraction, ProviderCapabilities, SessionSettings } from '../../shared/structured-agent'
import { BROWSER_MCP_SERVER_NAME } from '../../shared/browser-mcp'
import { canonicalAction } from '../approval-review'

/** The Grok Build CLI this adapter was verified against over ACP (`grok agent stdio`). */
export const GROK_BASELINE = '1.0.41'
/** ACP protocol version Grok answered `initialize` with on the baseline. */
const ACP_PROTOCOL_VERSION = 1
type WireTransport = Pick<JsonLineTransport, 'start' | 'send' | 'close' | 'connected'> & Partial<Pick<JsonLineTransport, 'closeAndWait' | 'detach' | 'detachable'>>
/** Adapter fields that hold promises, timers or callbacks, and never travel in a detachment. */
const GROK_TRANSIENT = ['rpc', 'starting'] as const
/** Injectable only in backend contract tests; no renderer can supply a transport. */
export interface GrokAdapterDependencies {
  transport?: (options: TransportOptions) => WireTransport
  version?: () => Promise<string>
  requestTimeoutMs?: number
}
class GrokRpcError extends Error {
  constructor(readonly code: unknown, readonly data: unknown, message: string) {
    const detail = typeof data === 'string' ? data : data && typeof data === 'object' ? [(data as Record<string, unknown>).code, (data as Record<string, unknown>).detail].filter(part => typeof part === 'string').join(': ') : ''
    super(`Grok request failed (${String(code ?? 'unknown')}): ${message}${detail ? ` (${detail})` : ''}`)
  }
}
type PendingRpc = { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
type PermissionOption = { optionId: string; name: string; kind: string }
type PendingRequest = { rpcId: string | number; interaction: PendingInteraction; options: PermissionOption[]; toolCallId?: string }
type CachedTool = { name: string; description?: string; kind?: string; input?: Json; status: ActivityStatus; paths: string[] }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const isId = (id: unknown): id is string | number => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
const requestKey = (id: string | number): string => `${typeof id}:${id}`

/** Who answers a Grok permission request under a composer mode. Grok 1.0.41 accepts
 *  `session/set_mode` but ignores it (live-verified 2026-09-24: an edit still asked after
 *  `acceptEdits`), and its sandbox profiles do not apply on Windows, so Conductor enforces the modes
 *  itself on Grok's own `session/request_permission` escalations:
 *  - `owner` (Ask): every request is a card for the owner.
 *  - `edits` (Edit): a file edit, move or delete inside the workspace is allowed once; anything else
 *    is a card.
 *  - `auto` (Auto): the session runs Grok's own auto mode (`_meta.autoMode`, its safety check allows
 *    routine work) and Conductor allows what Grok still escalates once, unless it reaches an
 *    owner-only boundary, the way Codex Auto does.
 *  - `refuse` (Plan, a read-only controller's coworker, an isolated reviewer): every request is
 *    declined; only what Grok itself treats as read-only runs.
 *  Always-approve (`yoloMode`) is never used: it would skip the escalations the boundaries rely on.
 *  Grok offers no read-only mode it enforces, so Read only is not offered. */
export type GrokApprovalPolicy = 'owner' | 'edits' | 'auto' | 'refuse'
export const grokApprovalPolicy = (settings: SessionSettings, approvalReviewer = false): GrokApprovalPolicy =>
  approvalReviewer || settings.plan || settings.permission === 'read-only' || settings.sandbox === 'read-only' ? 'refuse'
    : settings.permission === 'auto' ? 'auto' : settings.permission === 'accept-edits' ? 'edits' : 'owner'
/** Prepended to a Plan-mode turn: Grok has no plan mode Conductor can switch on over ACP. */
const PLAN_PREFACE = '[Conductor plan mode: investigate and propose a plan only. Do not edit files or run commands that change anything; such tool calls are declined.]'
/** True when `path` is `root` or lies inside it (case-insensitive on Windows). */
const inside = (root: string, path: string): boolean => {
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const base = fold(resolve(root)), target = fold(resolve(root, path))
  const offset = relative(base, target)
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

/** Process-local arguments; never writes the owner's Grok configuration or changes authentication.
 *  `--no-leader` keeps one Grok process per Conductor conversation, so closing a tab never ends
 *  another client's shared leader and a turn cannot be steered from a TUI attached to it. */
export function grokLaunchArguments(): string[] {
  return ['agent', '--no-leader', 'stdio']
}

/** The ACP `mcpServers` entry for Conductor's project browser, read from the exact loopback
 *  configuration BrowserMcpServer mints. It goes into `session/new`, never onto the command line. */
export function grokBrowserMcpServers(configuration: string | undefined): Json[] {
  if (!configuration) return []
  const source = configuration.trim().startsWith('{') ? configuration : readFileSync(configuration, 'utf8')
  if (source.length > 64 * 1024) throw new Error('Grok browser MCP configuration is too large')
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error('Grok browser MCP configuration is malformed') }
  const servers = record(parsed) && record(parsed.mcpServers) ? parsed.mcpServers : undefined
  if (!servers || Object.keys(servers).length !== 1) throw new Error('Grok browser MCP configuration has an invalid server set')
  const browser = servers[BROWSER_MCP_SERVER_NAME]
  if (!record(browser) || typeof browser.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(browser.url) || !record(browser.headers) || typeof browser.headers.Authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(browser.headers.Authorization)) throw new Error('Grok browser MCP configuration is not a scoped loopback credential')
  return [{ type: 'http', name: BROWSER_MCP_SERVER_NAME, url: browser.url, headers: [{ name: 'Authorization', value: browser.headers.Authorization }] }]
}

/** ACP prompt content: the message, then each attachment as labelled text. Grok's baseline
 *  advertises no image input, so an image attachment is refused rather than silently dropped. */
export function grokPrompt(text: string, attachments: ContextAttachment[] = []): Json[] {
  const blocks: Json[] = [{ type: 'text', text }]
  for (const attachment of attachments) {
    if (attachment.kind === 'image') throw new Error('Grok does not accept image attachments')
    const range = attachment.startLine ? `:${attachment.startLine}${attachment.endLine ? `-${attachment.endLine}` : ''}` : ''
    const label = `${attachment.kind}: ${attachment.path ?? attachment.name}${range}`
    blocks.push({ type: 'text', text: `[Attached ${label}]${attachment.content === undefined ? '' : `\n${attachment.content}`}` })
  }
  return blocks
}

const toolStatus = (status: unknown, fallback: ActivityStatus = 'preparing'): ActivityStatus =>
  status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'in_progress' ? 'running' : status === 'pending' ? 'preparing' : fallback

/** A readable name for an ACP tool call: Grok's own tool id when it sends one, else the kind. */
const toolName = (update: Record<string, unknown>): string => {
  const meta = record(update._meta) ? update._meta : {}
  // Grok names each call in `_meta["x.ai/tool"]`: `label` is its display name ("Run Command"),
  // `name` its tool id (`run_terminal_command`).
  const tool = record(meta['x.ai/tool']) ? meta['x.ai/tool'] : {}
  const native = string(tool.label) ?? string(tool.name) ?? string(update.toolName)
  if (native) return native
  const kind = string(update.kind)
  return kind === 'execute' ? 'Command' : kind === 'edit' ? 'Edit' : kind === 'read' ? 'Read' : kind === 'search' ? 'Search' : kind === 'fetch' ? 'Fetch' : kind === 'delete' ? 'Delete' : kind === 'move' ? 'Move' : kind === 'think' ? 'Think' : string(update.title) ?? 'Tool'
}

/** Text carried by ACP tool-call content blocks (`content` entries wrapping a text block). */
const contentText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap(entry => {
    if (!record(entry)) return []
    if (entry.type === 'content' && record(entry.content) && typeof entry.content.text === 'string') return [entry.content.text]
    return []
  })
  return parts.length ? parts.join('\n') : undefined
}

/** File changes an ACP tool call reports through `diff` content blocks. */
export function grokChanges(content: unknown, status: FileChange['status']): FileChange[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(entry => {
    if (!record(entry) || entry.type !== 'diff' || typeof entry.path !== 'string' || typeof entry.newText !== 'string') return []
    const before = typeof entry.oldText === 'string' ? entry.oldText : null
    const patch = createTwoFilesPatch(before === null ? '/dev/null' : entry.path, entry.path, before ?? '', entry.newText)
    let additions = 0, deletions = 0
    for (const line of patch.split('\n').slice(4)) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
    return [{ path: entry.path, kind: before === null ? 'add' as const : 'update' as const, patch, additions, deletions, status,
      limitation: 'Grok reported the before and after text of this edit; undo requires the artifact store to verify it against the file on disk.' }]
  })
}

/** Paths an ACP tool call names, for owner-only boundary checks and change tracking. */
const toolPaths = (update: Record<string, unknown>): string[] => {
  const paths = new Set<string>()
  if (Array.isArray(update.locations)) for (const location of update.locations) if (record(location) && typeof location.path === 'string') paths.add(location.path)
  if (Array.isArray(update.content)) for (const entry of update.content) if (record(entry) && entry.type === 'diff' && typeof entry.path === 'string') paths.add(entry.path)
  const input = record(update.rawInput) ? update.rawInput : {}
  for (const key of ['path', 'file_path', 'target_file', 'filePath', 'source', 'destination']) if (typeof input[key] === 'string') paths.add(input[key] as string)
  return [...paths]
}

/** The command an ACP execute tool call runs, when it names one. */
const toolCommand = (input: unknown): string | undefined => {
  if (!record(input)) return undefined
  const command = input.command ?? input.cmd
  return typeof command === 'string' ? command : Array.isArray(command) && command.every(part => typeof part === 'string') ? command.join(' ') : undefined
}

/** One `grok agent stdio` process per backend-owned session; views never construct this class. */
export class GrokAdapter implements ProviderAdapter {
  readonly provider = 'grok' as const
  private readonly providerCapabilities: ProviderCapabilities = {
    provider: 'grok', runtimeVersion: 'unknown', adapterVersion: 1, authentication: 'cli',
    // ACP has no mid-turn input; queued messages are delivered when the turn settles.
    steering: false, textStreaming: true, toolInputStreaming: false, toolOutputStreaming: false,
    approvals: true, questions: false, resume: true, fork: false, plans: true, imageAttachments: false,
    // Pre-discovery catalog: what a signed-in Grok 1.0.41 advertised on 2026-09-24; `initialize`
    // and `_x.ai/models/update` replace it with the account's own list.
    effort: ['low', 'medium', 'high', 'xhigh'],
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7', effort: ['xhigh', 'high', 'medium', 'low'], defaultEffort: 'high', isDefault: true },
      { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Fast', effort: ['xhigh', 'high', 'medium', 'low'], defaultEffort: 'high' },
      { id: 'grok-4.6', label: 'Grok 4.6', effort: ['xhigh', 'high', 'medium', 'low'], defaultEffort: 'high' },
      { id: 'grok-4.5', label: 'Grok 4.5', effort: ['high', 'medium', 'low'], defaultEffort: 'high' }
    ],
    permissions: ['default', 'accept-edits', 'auto'],
    limitations: [
      'Grok speaks ACP: messages sent while a turn runs are queued and delivered when it settles.',
      'Image attachments are not accepted by the Grok runtime.',
      'Grok runs its own read-only tools and commands without asking in every mode; Conductor answers only what Grok escalates. Tool calls Grok\'s own auto mode allows run without a Conductor approval card.',
      'Plan mode is Conductor-enforced: Grok is told to plan only and every escalated tool call is declined.',
      'Grok processes end when the Conductor backend exits. Resume is explicit and never resends a turn.'
    ]
  }
  private transport?: WireTransport
  private starting?: Promise<void>
  private disposed = false
  private failed = false
  private requestId = 0
  private rpc = new Map<string, PendingRpc>()
  private pending = new Map<string, PendingRequest>()
  private tools = new Map<string, CachedTool>()
  private sessionId?: string
  private turnId?: string
  private dispatching = false
  private interrupted = false
  /** Set while `session/load` replays history: replayed updates are durable already. */
  private replaying = false
  private messageItem = 0
  private lastUpdateKind?: string
  private currentModel?: string
  private currentEffort?: string
  private policy: GrokApprovalPolicy = 'owner'
  /** Whether the native session was opened (or last re-attached) with Grok's own auto mode. */
  private sessionAutoMode = false
  private mcpServers: Json[] = []
  /** Context window per model id, from the catalog's `totalContextTokens`. */
  private contextWindows = new Map<string, number>()
  private autoAnswered = new Map<string, string>()

  constructor(private options: AdapterOptions, private dependencies: GrokAdapterDependencies = {}) {}

  get capabilities(): ProviderCapabilities { return this.providerCapabilities }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Grok adapter has been disposed'))
    return this.starting ??= this.options.attach ? this.attachRunning(this.options.attach) : this.initialize()
  }

  private createTransport(environment: NodeJS.ProcessEnv, attach?: HostedRuntimeHandle): WireTransport {
    const factory = this.dependencies.transport ?? (options => new JsonLineTransport(options))
    return factory({
      executable: this.options.executable, args: grokLaunchArguments(), cwd: this.options.cwd, environment, ...(attach ? { attach } : {}),
      onMessage: message => this.receive(message),
      onStderr: output => this.emit({ data: { type: 'notice', message: 'Grok process diagnostic (stderr)', payload: output }, native: { method: 'process/stderr' } }),
      onError: error => this.disconnect(error.message),
      onExit: (code, signal) => this.disconnect(`Grok exited (${signal ?? code ?? 'unknown'}). Any unfinished execution is uncertain.`)
    })
  }

  /** Lets the runtime host keep this Grok process running for the next app process (docs/runtime-host.md). */
  async detach(): Promise<RuntimeDetachment | null> {
    const transport = this.transport
    if (this.disposed || this.failed || !this.sessionId || !transport?.detachable || !transport.detach) return null
    if (!await settled(() => this.rpc.size === 0 && !this.dispatching && !this.replaying) || this.disposed || this.failed || !transport.detachable) return null
    // Detaching stops delivery synchronously, so the state below is exactly what the next process
    // continues from: the first frame it handles is the first one this process did not.
    const handle = transport.detach()
    const state = captureAdapterState(this, GROK_TRANSIENT)
    this.disposed = true
    const detached = await handle
    return detached ? { state, transport: detached } : null
  }

  private async attachRunning(detachment: RuntimeDetachment): Promise<void> {
    restoreAdapterState(this, detachment.state)
    this.disposed = false
    this.transport = this.createTransport({ ...(this.options.environment ?? process.env), GROK_DISABLE_AUTOUPDATER: '1' }, detachment.transport)
    this.transport.start()
    // The store closed this conversation's open work when it loaded (an app that stopped is
    // assumed to have ended its turn), so the adapter restates what is still live.
    for (const [itemId, tool] of this.tools) {
      if (tool.status === 'preparing' || tool.status === 'running' || tool.status === 'awaiting_approval') this.emit({ itemId, data: { type: 'tool', name: tool.name, status: tool.status, ...(tool.input !== undefined ? { input: tool.input } : {}) } })
    }
    for (const pending of this.pending.values()) this.emitInteraction(pending, pending.interaction)
    this.emitPhase(true)
  }

  private async initialize(): Promise<void> {
    this.emit({ data: { type: 'session', phase: 'starting' } })
    this.policy = grokApprovalPolicy(this.options.settings, this.options.approvalReviewer)
    try {
      const environment = { ...(this.options.environment ?? process.env), GROK_DISABLE_AUTOUPDATER: '1' }
      const version = await (this.dependencies.version?.() ?? new Promise<string>((resolve, reject) => {
        execFile(this.options.executable, ['--version'], { cwd: this.options.cwd, env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
      }))
      this.capabilities.runtimeVersion = /(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? version
      if (!/^1\./.test(this.capabilities.runtimeVersion)) throw new Error(`Grok ${this.capabilities.runtimeVersion} is outside the tested 1.x ACP baseline; verify the adapter before connecting`)
      if (this.capabilities.runtimeVersion !== GROK_BASELINE) this.capabilities.limitations.push(`Runtime ${this.capabilities.runtimeVersion} is not fixture-verified; baseline is ${GROK_BASELINE}.`)
      this.transport = this.createTransport(environment)
      this.transport.start()
      const initialized = await this.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'conductor', title: 'Conductor', version: '1' }
      })
      if (!record(initialized) || initialized.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error('Grok answered initialize with an unsupported ACP protocol version')
      this.adoptModels(record(initialized._meta) ? initialized._meta.modelState : undefined)
      const agentCapabilities = record(initialized.agentCapabilities) ? initialized.agentCapabilities : {}
      const sessionCapabilities = record(agentCapabilities.sessionCapabilities) ? agentCapabilities.sessionCapabilities : {}
      const mcpServers = this.mcpServers = grokBrowserMcpServers(this.options.mcpConfig)
      this.sessionAutoMode = this.policy === 'auto'
      const meta: Record<string, Json> = this.sessionAutoMode ? { autoMode: true } : {}
      let session: unknown
      if (this.options.nativeSessionId) {
        try {
          // `session/resume` reattaches without replaying; `session/load` replays history, which is
          // durable in Conductor already and is dropped while it streams.
          if (record(sessionCapabilities.resume)) session = await this.request('session/resume', { sessionId: this.options.nativeSessionId, cwd: this.options.cwd, mcpServers, _meta: meta })
          else {
            this.replaying = true
            try { session = await this.request('session/load', { sessionId: this.options.nativeSessionId, cwd: this.options.cwd, mcpServers, _meta: meta }, 120_000) } finally { this.replaying = false }
          }
          this.sessionId = this.options.nativeSessionId
        } catch (error) {
          // A missing session answers `Path not found. (FS_NOT_FOUND: …)` on 1.0.41.
          if (!(error instanceof GrokRpcError) || !/not found|no such session|unknown session|does not exist|FS_NOT_FOUND/i.test(error.message)) throw error
          this.emit({ data: { type: 'notice', message: 'Grok had no saved history for this conversation, so a new native conversation was started in its place.', payload: { sessionId: this.options.nativeSessionId } } })
        }
      }
      if (!this.sessionId) {
        session = await this.request('session/new', { cwd: this.options.cwd, mcpServers, _meta: meta }, 120_000)
        if (!record(session) || typeof session.sessionId !== 'string') throw new Error('Malformed Grok session response')
        this.sessionId = session.sessionId
      }
      this.adoptSession(session)
      // A choice Grok refuses must not cost the conversation its session: it stays on the settings
      // Grok confirmed, and the next turn asks for the choice again and fails on its own.
      try { await this.applySettings(this.options.settings) } catch (error) {
        if (!(error instanceof GrokRpcError) && !/does not offer the model|is not offered for/.test(error instanceof Error ? error.message : '')) throw error
        this.capabilities.effectiveSettings = this.effective()
        this.emit({ data: { type: 'notice', message: `Grok kept model ${this.currentModel ?? 'default'} with ${this.currentEffort ?? 'default'} effort: ${error instanceof Error ? error.message : 'the requested settings were refused'}` } })
      }
      this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: this.sessionId, capabilities: this.capabilities } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Grok connection failed'
      this.disconnect(/authentication required/i.test(message) ? 'Grok is not signed in. Run `grok login` in a terminal (or set XAI_API_KEY), then reconnect this conversation.' : message)
      this.transport?.close()
      throw error
    }
  }

  /** Model and effort choices from Grok's `modelState` (initialize `_meta`). */
  private adoptModels(state: unknown): void {
    if (!record(state) || !Array.isArray(state.availableModels)) return
    const models = state.availableModels.flatMap(model => {
      if (!record(model) || typeof model.modelId !== 'string') return []
      const meta = record(model._meta) ? model._meta : {}
      const efforts = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.filter(record) : []
      const effort = efforts.map(option => string(option.value) ?? string(option.id)).filter((value): value is string => Boolean(value))
      const defaultEffort = string(efforts.find(option => option.default === true)?.value) ?? string(meta.reasoningEffort)
      if (typeof meta.totalContextTokens === 'number') this.contextWindows.set(model.modelId, meta.totalContextTokens)
      return [{ id: model.modelId, label: string(model.name) ?? model.modelId, ...(effort.length ? { effort } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(model.modelId === state.currentModelId ? { isDefault: true } : {}) }]
    })
    if (!models.length) return
    this.capabilities.models = models
    this.capabilities.effort = [...new Set(models.flatMap(model => model.effort ?? []))]
    this.currentModel = string(state.currentModelId)
  }

  /** Current model and effort from a `session/new`/`resume`/`load` response. */
  private adoptSession(session: unknown): void {
    if (!record(session)) return
    if (record(session.models)) this.adoptModels(session.models)
    this.adoptConfigOptions(session.configOptions)
  }

  private effective(): Json {
    return json({ model: this.currentModel ?? null, effort: this.currentEffort ?? null, approvals: this.policy, grokAutoMode: this.sessionAutoMode })
  }

  private adoptConfigOptions(options: unknown): void {
    if (!Array.isArray(options)) return
    for (const option of options) {
      if (!record(option)) continue
      const value = string(option.currentValue) ?? (record(option.currentValue) ? string(option.currentValue.value) : undefined)
      if (option.id === 'model' && value) this.currentModel = value
      if (option.id === 'reasoning_effort' && value) this.currentEffort = value
    }
    this.capabilities.effectiveSettings = this.effective()
  }

  /** Set one session config option. Grok 1.0.41 takes the value id as a plain string; `{ value }`
   *  fails with -32602 "untagged enum SessionConfigOptionValue" (zero-turn probe, 2026-09-24).
   *  The configOptions Grok answers with are the confirmed settings. */
  private async setConfigOption(configId: 'model' | 'reasoning_effort', value: string): Promise<void> {
    const result = await this.request('session/set_config_option', { sessionId: this.sessionId!, configId, value })
    if (configId === 'model') this.currentModel = value
    else this.currentEffort = value
    this.adoptConfigOptions(record(result) ? result.configOptions : undefined)
  }

  /** Bring the live Grok session to the composer's model, effort and permission mode. */
  private async applySettings(settings: SessionSettings): Promise<void> {
    if (!this.sessionId) return
    if (settings.model && settings.model !== this.currentModel) {
      if (this.capabilities.models.length && !this.capabilities.models.some(model => model.id === settings.model)) throw new Error(`Grok does not offer the model ${settings.model}`)
      await this.setConfigOption('model', settings.model)
    }
    if (settings.effort && settings.effort !== this.currentEffort) {
      const model = this.capabilities.models.find(candidate => candidate.id === (settings.model || this.currentModel))
      if (model?.effort && !model.effort.includes(settings.effort)) throw new Error(`Reasoning effort ${settings.effort} is not offered for ${model.id}`)
      await this.setConfigOption('reasoning_effort', settings.effort)
    }
    this.policy = grokApprovalPolicy(settings, this.options.approvalReviewer)
    // Grok's auto mode is chosen when a session is attached; re-attaching the live session is how a
    // mode change reaches it. If Grok refuses, Conductor's own answers still carry the mode.
    const autoMode = this.policy === 'auto'
    if (autoMode !== this.sessionAutoMode) {
      try {
        this.adoptSession(await this.request('session/resume', { sessionId: this.sessionId, cwd: this.options.cwd, mcpServers: this.mcpServers, _meta: autoMode ? { autoMode: true } : {} }))
        this.sessionAutoMode = autoMode
      } catch (error) {
        this.emit({ data: { type: 'notice', message: `Grok did not switch its own auto mode ${autoMode ? 'on' : 'off'} (${error instanceof Error ? error.message : 'unknown error'}); Conductor still answers its approvals for this mode.` } })
      }
    }
    this.capabilities.effectiveSettings = this.effective()
  }

  async submit(text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void> {
    await this.start()
    if (this.disposed || this.failed || !this.sessionId || !this.transport?.connected) throw new Error('Grok session is disconnected; resume explicitly')
    if (this.turnId || this.dispatching || this.pending.size) throw new Error('A Grok turn or interaction is already active')
    const prompt = grokPrompt(settings.plan ? `${PLAN_PREFACE}\n\n${text}` : text, attachments)
    this.dispatching = true
    try { await this.applySettings(settings) } catch (error) { this.dispatching = false; throw error }
    const turnId = randomUUID()
    this.turnId = turnId
    this.dispatching = false
    this.interrupted = false
    this.messageItem++
    this.lastUpdateKind = undefined
    this.emit({ data: { type: 'session', phase: 'running', capabilities: this.capabilities } })
    // The prompt request resolves when the whole turn ends; it has no acknowledgement timeout.
    this.request('session/prompt', { sessionId: this.sessionId, prompt }, 0).then(result => {
      if (this.turnId !== turnId) return
      const stopReason = record(result) ? string(result.stopReason) : undefined
      this.usage(record(result) && record(result._meta) ? result._meta : undefined)
      this.finishTurn(stopReason === 'cancelled' ? 'interrupted' : stopReason === 'refusal' ? 'failed' : 'completed', stopReason && !['end_turn', 'cancelled'].includes(stopReason) ? `Grok stopped: ${stopReason.replace(/_/g, ' ')}` : undefined)
    }, error => {
      if (this.turnId !== turnId || this.failed) return
      this.finishTurn(this.interrupted ? 'interrupted' : 'failed', error instanceof Error ? error.message.replace(/^Grok request failed \([^)]*\): /, '') : 'Grok turn failed')
    })
  }

  private finishTurn(phase: 'completed' | 'failed' | 'interrupted', message?: string): void {
    const turnId = this.turnId
    this.expireRequests(phase === 'interrupted' ? 'Turn interrupted' : 'Turn completed')
    for (const [id, tool] of this.tools) if (tool.status === 'running' || tool.status === 'preparing' || tool.status === 'awaiting_approval') this.emit({ turnId, itemId: id, data: { type: 'tool', name: tool.name, status: phase === 'completed' ? 'completed' : 'interrupted' } })
    this.tools.clear()
    this.autoAnswered.clear()
    this.turnId = undefined
    this.interrupted = false
    if (message) this.emit({ turnId, data: phase === 'completed' ? { type: 'notice', message } : { type: 'error', message } })
    this.emit({ turnId, data: { type: 'session', phase } })
  }

  async respond(response: InteractionResponse): Promise<void> {
    if (response.runtimeId !== this.options.runtimeId || this.failed || this.disposed || !this.transport?.connected) throw new Error('This Grok interaction belongs to a stale runtime')
    const pending = this.pending.get(response.requestId)
    if (!pending) throw new Error('Grok interaction has expired or was already answered')
    if (!response.decision || !pending.interaction.choices.some(choice => choice.id === response.decision)) throw new Error('That decision is not offered by this Grok request')
    this.pending.delete(response.requestId)
    const outcome: Json = response.decision === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: response.decision }
    try { this.transport.send({ jsonrpc: '2.0', id: pending.rpcId, result: { outcome } }) } catch (error) {
      this.emitInteraction(pending, { ...pending.interaction, status: 'expired', outcome: 'Delivery uncertain after disconnect' })
      this.disconnect('Grok interaction response delivery is uncertain')
      throw error
    }
    this.emitInteraction(pending, { ...pending.interaction, status: 'resolved', outcome: response.decision })
    if (response.decision === 'cancel') void this.interrupt().catch(() => undefined)
    this.emitPhase()
  }

  async interrupt(): Promise<void> {
    if (this.disposed || this.failed || !this.transport?.connected) throw new Error('Grok runtime is disconnected')
    if (!this.turnId || !this.sessionId) return
    this.interrupted = true
    this.emit({ data: { type: 'session', phase: 'interrupting' } })
    // ACP: a cancelled turn's pending permission requests are answered `cancelled` by the client,
    // and the turn itself ends with the prompt's `cancelled` stop reason.
    for (const [key, pending] of this.pending) {
      this.pending.delete(key)
      try { this.transport.send({ jsonrpc: '2.0', id: pending.rpcId, result: { outcome: { outcome: 'cancelled' } } }) } catch { /* disconnect handles it */ }
      this.emitInteraction(pending, { ...pending.interaction, status: 'expired', outcome: 'Turn interrupted' })
    }
    this.transport.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } })
  }

  async stop(): Promise<void> { this.dispose(); await this.transport?.closeAndWait?.() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnect('Conductor closed its owned Grok runtime. Historical events remain readable; unfinished execution may be uncertain.')
    this.transport?.close()
  }

  /** `timeoutMs` 0 waits for as long as the request takes (a prompt turn). */
  private request<T = unknown>(method: string, params?: Json, timeoutMs = this.dependencies.requestTimeoutMs ?? 30_000): Promise<T> {
    if (!this.transport?.connected) return Promise.reject(new Error('Grok transport is disconnected'))
    const id = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      const key = requestKey(id)
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.rpc.delete(key)
        reject(new Error(`Grok ${method} acknowledgement timed out; do not automatically retry`))
      }, timeoutMs) : undefined
      this.rpc.set(key, { resolve: value => resolve(value as T), reject, timer })
      try { this.transport!.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) }
      catch (error) { clearTimeout(timer); this.rpc.delete(key); reject(error) }
    })
  }

  private receive(message: Json): void {
    if (!record(message) || this.disposed) return
    if (isId(message.id) && typeof message.method !== 'string') {
      const pending = this.rpc.get(requestKey(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.rpc.delete(requestKey(message.id))
      if (record(message.error)) pending.reject(new GrokRpcError(message.error.code, message.error.data, String(message.error.message ?? 'Unknown provider error')))
      else if ('result' in message) pending.resolve(message.result)
      else pending.reject(new Error('Malformed Grok RPC response'))
      return
    }
    if (typeof message.method !== 'string') return
    if (this.failed) return
    try {
      if (isId(message.id)) this.serverRequest(message.id, message.method, message.params)
      else this.notification(message.method, message.params)
    } catch {
      this.unknown(message.method, message.params, 'Malformed or unsupported Grok event retained for inspection')
      if (isId(message.id)) this.transport?.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Conductor cannot safely handle this request shape' } })
    }
  }

  private notification(method: string, params: unknown): void {
    if (method === '_x.ai/models/update') {
      // A signed-in account's catalog arrives after initialize (1.0.41 announced grok-4.7 this way).
      this.adoptModels(params)
      if (!this.failed && this.sessionId) this.emitPhase(true)
      return
    }
    if (method === '_x.ai/session_notification') return this.sessionNotification(params)
    if (method !== 'session/update') {
      // Grok's other `_x.ai/*` notifications (setup phases, MCP inventory, file index, settings,
      // announcements) describe the process, not the conversation; they are not surfaced.
      if (!method.startsWith('_x.ai/') && !method.startsWith('x.ai/')) this.unknown(method, params)
      return
    }
    if (!record(params) || !record(params.update)) throw new Error('Malformed Grok session update')
    if (params.sessionId !== this.sessionId || this.replaying) return
    const update = params.update
    const kind = string(update.sessionUpdate)
    const native = { method: `session/update:${kind ?? 'unknown'}`, payload: json(update) }
    const turnId = this.turnId
    switch (kind) {
      case 'agent_message_chunk': case 'agent_thought_chunk': {
        const content = record(update.content) ? update.content : {}
        if (content.type !== 'text' || typeof content.text !== 'string') return
        if (this.lastUpdateKind !== kind) this.messageItem++
        this.lastUpdateKind = kind
        this.emit({ turnId, itemId: `${kind === 'agent_message_chunk' ? 'message' : 'thought'}:${turnId ?? 'idle'}:${this.messageItem}`, data: { type: 'text', role: kind === 'agent_message_chunk' ? 'assistant' : 'status', text: content.text, mode: 'delta' }, native })
        return
      }
      case 'user_message_chunk':
        return // The host records its own captured input.
      case 'tool_call': case 'tool_call_update':
        this.lastUpdateKind = kind
        this.toolUpdate(update, kind === 'tool_call', native)
        return
      case 'plan':
        this.emit({ turnId, itemId: `plan:${turnId ?? 'idle'}`, data: { type: 'plan', steps: (Array.isArray(update.entries) ? update.entries : []).filter(record).map(entry => ({ text: string(entry.content) ?? '', status: entry.status === 'completed' ? 'completed' as const : entry.status === 'in_progress' ? 'in_progress' as const : 'pending' as const })) }, native })
        return
      case 'current_mode_update':
        return
      case 'config_option_update':
        this.adoptConfigOptions(update.configOptions)
        return
      case 'usage_update':
        this.contextUsage(update, native)
        return
      case 'available_commands_update': case 'session_info_update':
        return
      default:
        this.unknown(native.method, update)
    }
  }

  private toolUpdate(update: Record<string, unknown>, created: boolean, native: AdapterEvent['native']): void {
    const id = string(update.toolCallId)
    if (!id) throw new Error('Grok tool call without an identity')
    const previous = this.tools.get(id)
    const status = toolStatus(update.status, previous?.status ?? 'preparing')
    const input = 'rawInput' in update ? json(update.rawInput) : previous?.input
    const tool: CachedTool = {
      name: created || !previous ? toolName(update) : previous.name,
      description: string(update.title) ?? previous?.description,
      kind: string(update.kind) ?? previous?.kind,
      input, status, paths: [...new Set([...(previous?.paths ?? []), ...toolPaths(update)])]
    }
    if (this.tools.size >= 2048 && !previous) this.tools.delete(this.tools.keys().next().value!)
    this.tools.set(id, tool)
    const output = contentText(update.content) ?? ('rawOutput' in update && update.rawOutput !== null && update.rawOutput !== undefined ? (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2)) : undefined)
    const exit = record(update.rawOutput) && typeof update.rawOutput.exit_code === 'number' ? update.rawOutput.exit_code : record(update.rawOutput) && typeof update.rawOutput.exitCode === 'number' ? update.rawOutput.exitCode : undefined
    this.emit({ turnId: this.turnId, itemId: id, data: { type: 'tool', name: tool.name, ...(tool.description ? { description: tool.description } : {}), ...(input !== undefined ? { input } : {}), status, ...(output !== undefined ? { output, outputMode: 'snapshot' as const } : {}), ...(exit !== undefined ? { exitCode: exit } : {}) }, native })
    const changes = grokChanges(update.content, status === 'completed' ? 'applied' : status === 'failed' ? 'failed' : 'proposed')
    if (changes.length) this.emit({ turnId: this.turnId, itemId: id, data: { type: 'changes', changes }, native })
  }

  private serverRequest(rpcId: string | number, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      this.unknown(method, params, 'Grok requested an unsupported client action; no tool or credential action was executed')
      this.transport?.send({ jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'This Conductor client does not implement this method' } })
      return
    }
    if (!record(params) || params.sessionId !== this.sessionId || !Array.isArray(params.options)) throw new Error('Malformed Grok permission request')
    const options = params.options.filter((option): option is PermissionOption => record(option) && typeof option.optionId === 'string' && typeof option.name === 'string' && typeof option.kind === 'string')
    if (!options.length) throw new Error('Grok permission request offered no options')
    const toolCall = record(params.toolCall) ? params.toolCall : {}
    const toolCallId = string(toolCall.toolCallId)
    if (toolCallId) this.toolUpdate({ ...toolCall, status: 'pending' }, !this.tools.has(toolCallId), { method, payload: json(params) })
    const tool = toolCallId ? this.tools.get(toolCallId) : undefined
    const title = string(toolCall.title) ?? tool?.description ?? `Allow ${tool?.name ?? 'this Grok tool call'}?`
    const key = requestKey(rpcId)
    if (this.pending.has(key)) return
    if (this.pending.size >= 128) throw new Error('Too many pending provider requests')
    const allowOnce = options.find(option => option.kind === 'allow_once')
    const rejectOnce = options.find(option => option.kind === 'reject_once') ?? options.find(option => option.kind === 'reject_always')
    const answer = (option: PermissionOption, message: string): void => {
      const action = canonicalAction(json(params))
      if (this.autoAnswered.get(key) === action) return
      if (this.autoAnswered.size >= 128) this.autoAnswered.delete(this.autoAnswered.keys().next().value!)
      this.autoAnswered.set(key, action)
      this.transport?.send({ jsonrpc: '2.0', id: rpcId, result: { outcome: { outcome: 'selected', optionId: option.optionId } } })
      this.emit({ turnId: this.turnId, itemId: toolCallId ? `${toolCallId}:answer` : undefined, data: { type: 'notice', message }, native: { method, payload: json(params) } })
    }
    if (this.policy === 'refuse') {
      if (rejectOnce) return answer(rejectOnce, `${this.options.approvalReviewer ? 'The reviewer never executes' : 'Plan mode'}: Conductor declined “${title}”.`)
      this.transport?.send({ jsonrpc: '2.0', id: rpcId, result: { outcome: { outcome: 'cancelled' } } })
      return
    }
    const held = this.policy === 'auto' || this.policy === 'edits' ? this.ownerOnlyBoundary(tool) : undefined
    const edit = tool && ['edit', 'delete', 'move'].includes(tool.kind ?? '') && tool.paths.length > 0 && tool.paths.every(path => inside(this.options.cwd, path)) && !toolCommand(tool.input)
    if (allowOnce && !held && (this.policy === 'auto' || this.policy === 'edits' && edit)) return answer(allowOnce, `${this.policy === 'auto' ? 'Auto' : 'Edit mode'} allowed “${title}” without asking.`)
    if (held) this.emit({ turnId: this.turnId, itemId: toolCallId, data: { type: 'notice', message: `${this.policy === 'auto' ? 'Auto' : 'Edit mode'} left “${title}” to you: ${held}. The native request is pending; review it and choose an offered action.` } })
    // A request Auto held for the owner is one exact action, never a lasting grant.
    const offered = this.policy === 'auto' ? options.filter(option => option.kind !== 'allow_always') : options
    const interaction: PendingInteraction = {
      id: key, kind: 'approval', title, input: json({ toolCall, options }), status: 'pending',
      choices: [...offered.map(option => ({ id: option.optionId, label: option.name, ...(option.kind === 'allow_always' ? { description: 'Grok remembers this grant for the project and stops asking for matching calls.' } : {}) })), { id: 'cancel', label: 'Cancel turn' }]
    }
    const request: PendingRequest = { rpcId, interaction, options, toolCallId }
    this.pending.set(key, request)
    this.emitInteraction(request, interaction)
    if (toolCallId && tool) this.emit({ turnId: this.turnId, itemId: toolCallId, data: { type: 'tool', name: tool.name, status: 'awaiting_approval' } })
    this.emitPhase()
  }

  /** Why Auto leaves a Grok escalation to the owner, or undefined when it may allow it once:
   *  the call must name what it reaches, and none of it may be an owner-only boundary. */
  private ownerOnlyBoundary(tool: CachedTool | undefined): string | undefined {
    if (!tool) return 'it names no tool Auto can check'
    const command = toolCommand(tool.input)
    const reach = [command ?? '', ...tool.paths].filter(Boolean).join('\n')
    if (!reach) return tool.kind === 'fetch' || tool.kind === 'search' || tool.kind === 'read' || tool.kind === 'think' || tool.name.includes('__') || tool.name.includes('/') ? undefined : 'it names no command or path Auto can check'
    const boundary = ownerOnlyEscalation(reach)
    return boundary ? `it reaches ${boundary}` : undefined
  }

  /** Grok's `_x.ai/session_notification` stream: a compaction resets what the model remembers of
   *  Conductor's briefing, so the host restates it; everything else is already covered. */
  private sessionNotification(params: unknown): void {
    if (!record(params) || params.sessionId !== this.sessionId || this.replaying || !record(params.update)) return
    const kind = string(params.update.sessionUpdate) ?? ''
    if (/compact/i.test(kind) && /(complete|finish|done|end)/i.test(kind)) this.emit({ itemId: `compacted:${randomUUID()}`, data: { type: 'notice', message: 'Grok compacted this conversation; Conductor restates its briefing with the next message.', payload: { contextReset: true } }, native: { method: '_x.ai/session_notification', payload: json(params.update) } })
  }

  private contextUsage(update: Record<string, unknown>, native: AdapterEvent['native']): void {
    const used = typeof update.used === 'number' ? update.used : undefined
    const size = typeof update.size === 'number' ? update.size : undefined
    const cost = record(update.cost) && typeof update.cost.amount === 'number' ? update.cost.amount : undefined
    this.emit({ turnId: undefined, itemId: `usage:${this.sessionId}`, data: { type: 'usage', scope: 'session', source: 'provider', ...(cost !== undefined ? { costUsd: cost } : {}), limits: json({ contextCapacityTokens: size ?? null, modelContextWindow: size ?? null, contextUsedTokens: used ?? null }) }, native })
  }

  /** Token spend Grok reports on a finished prompt: `_meta.usage` sums the turn's model calls
   *  (full prompt input; cost in 1e-10 USD ticks), `_meta.totalTokens` is the context now held. */
  private usage(meta: unknown): void {
    if (!record(meta)) return
    const held = typeof meta.totalTokens === 'number' ? meta.totalTokens : undefined
    const model = string(meta.modelId) ?? this.currentModel
    const window = model ? this.contextWindows.get(model) : undefined
    if (held !== undefined) this.emit({ turnId: undefined, itemId: `usage:${this.sessionId}`, data: { type: 'usage', scope: 'session', source: 'provider', limits: json({ contextCapacityTokens: window ?? null, modelContextWindow: window ?? null, contextUsedTokens: held }) } })
    const value = meta.usage
    if (!record(value)) return
    const number = (key: string): number | undefined => typeof value[key] === 'number' ? value[key] as number : undefined
    const inputTokens = number('inputTokens') ?? number('input_tokens')
    const outputTokens = number('outputTokens') ?? number('output_tokens')
    if (inputTokens === undefined && outputTokens === undefined) return
    const cachedTokens = number('cachedReadTokens') ?? number('cacheReadInputTokens') ?? number('cache_read_input_tokens')
    const reasoningTokens = number('thoughtTokens') ?? number('reasoningTokens') ?? number('reasoning_tokens')
    const totalTokens = number('totalTokens') ?? number('total_tokens')
    const ticks = number('costUsdTicks')
    this.emit({ itemId: `usage:${this.turnId ?? 'turn'}`, data: { type: 'usage', scope: 'turn', source: 'provider', ...(ticks !== undefined ? { costUsd: ticks / 1e10 } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(cachedTokens !== undefined ? { cachedTokens } : {}), ...(reasoningTokens !== undefined ? { reasoningTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) } })
  }

  private emitInteraction(request: PendingRequest, interaction: PendingInteraction): void {
    this.emit({ turnId: this.turnId, itemId: request.toolCallId, requestId: interaction.id, data: { type: 'interaction', interaction }, native: { method: 'session/request_permission', payload: interaction.input } })
  }

  private emitPhase(includeCapabilities = false): void {
    if (this.failed || this.disposed) return
    const phase = this.interrupted ? 'interrupting' : this.pending.size ? 'waiting_approval' : this.turnId || this.dispatching ? 'running' : 'idle'
    this.emit({ data: { type: 'session', phase, ...(includeCapabilities ? { capabilities: this.capabilities } : {}) } })
  }

  private expireRequests(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      this.emitInteraction(pending, { ...pending.interaction, status: 'expired', outcome: reason })
    }
  }

  private disconnect(message: string): void {
    if (this.failed) return
    this.failed = true
    for (const pending of this.rpc.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.rpc.clear()
    this.expireRequests('Runtime disconnected')
    this.turnId = undefined
    this.emit({ data: { type: 'session', phase: 'disconnected', message } })
  }

  private emit(event: AdapterEvent): void { this.options.emit({ nativeSessionId: this.sessionId, turnId: this.turnId, ...event, data: event.data.type === 'session' ? { ...event.data, capabilities: { ...this.capabilities } } : event.data }) }
  private unknown(method: string, payload: unknown, message = `Grok event: ${method}`): void {
    this.emit({ data: { type: 'notice', message, payload: json(payload) }, native: { method, payload: json(payload) } })
  }
}
