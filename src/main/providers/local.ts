import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { AdapterOptions, ProviderAdapter } from './adapter'
import type { AdapterEvent, ContextAttachment, InteractionResponse, Json, ProviderCapabilities, SessionSettings } from '../../shared/structured-agent'
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS, LOCAL_MODEL_SETUP_ERROR_CODE, LOCAL_MODEL_SETUP_URL, localModelLabel } from '../../shared/local-models'
import { LocalAgentSession } from '../local-models/agent.ts'
import { normaliseContract } from '../local-models/completion.ts'
import { localStopPayload, localStopSummary, type LocalStopReport } from '../../shared/local-stop.ts'
import { endpointFor, loadConfig, modelFilePath, readApiKey } from '../local-models/config.ts'
import type { LocalModelConfig, LocalStackConfig } from '../local-models/config.ts'
import { inspectAdmission, startServer } from '../local-models/llama.ts'
import { AdmissionRefusal, type BlockingServer } from '../local-models/resource-guard.ts'
import { DockerSandbox } from '../local-models/sandbox.ts'
import { LOCAL_TOOLS, type LocalGrants } from '../local-models/tools.ts'

const readConfig = (): LocalStackConfig | null => {
  try { return loadConfig() } catch { return null }
}

/** StructuredSessions preserves this code for the renderer. The URL is public setup guidance;
 * no local path, key or config value is attached to the error. */
export class LocalSetupError extends Error {
  readonly code = LOCAL_MODEL_SETUP_ERROR_CODE
  readonly actionUrl = LOCAL_MODEL_SETUP_URL
  constructor(detail: string) {
    super(`${detail} Download or set up the local model: ${LOCAL_MODEL_SETUP_URL}`)
    this.name = 'LocalSetupError'
  }
}

/** One llama.cpp process per model, shared by every conversation that asked for it. Two tabs
 *  opening the same model at once must not race into two servers, so the in-flight start is
 *  kept here, process-wide, rather than per adapter. `startServer` itself also refuses to
 *  duplicate an already-healthy process, which covers a server this app did not start. */
const startingServers = new Map<string, Promise<void>>()

/** Conversations with a turn in flight, by model id. The release policy consults this before an
 *  idle server gives way to another model, so a switch never lands in the middle of a turn that
 *  this process is running. */
const turnsInFlight = new Map<string, Set<string>>()
function markTurn(modelId: string, runtimeId: string): () => void {
  const set = turnsInFlight.get(modelId) ?? new Set<string>()
  set.add(runtimeId)
  turnsInFlight.set(modelId, set)
  return () => { set.delete(runtimeId); if (!set.size && turnsInFlight.get(modelId) === set) turnsInFlight.delete(modelId) }
}

/** Whether the server on `port` is generating right now, from llama.cpp's own /slots. Another
 *  Conductor process or the CLI could be mid-request without this process knowing; the slot
 *  state is the one place that shows it. A server without /slots reports nothing. */
export async function slotsProcessing(port: number, apiKey: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/slots`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json() as unknown
    return Array.isArray(body) && body.some(slot => slot && typeof slot === 'object' && (slot as { is_processing?: unknown }).is_processing === true)
  } catch { return false }
  finally { clearTimeout(timer) }
}

/** Whether the running server may give way: 'idle' when no conversation here is mid-turn on it
 *  and its slots are quiet, otherwise the reason it is busy, worded for the refusal. */
export async function releaseVerdict(running: BlockingServer, apiKey: string, probes: { inFlight: Map<string, Set<string>>; slots: typeof slotsProcessing } = { inFlight: turnsInFlight, slots: slotsProcessing }): Promise<'idle' | string> {
  const users = probes.inFlight.get(running.model)
  if (users?.size) return `${users.size} conversation${users.size === 1 ? ' is' : 's are'} mid-turn on it in this Conductor`
  if (running.port !== undefined && await probes.slots(running.port, apiKey)) return 'it is generating for another client right now'
  return 'idle'
}

/** Whether a conversation on this model could start its server now, for callers that open tabs
 *  and dispatch work: a refusal is given before a tab exists, with the reason, rather than as the
 *  first turn's failure inside a tab that then sits there. A snapshot only; the start itself
 *  decides again under the admission lock. */
export async function localModelAvailability(modelId: string): Promise<{ available: true; note?: string } | { available: false; reason: string }> {
  const stack = readConfig()
  const model = stack?.models[modelId]
  if (!model) return { available: false, reason: `${localModelLabel(modelId)} is not configured on this machine` }
  let apiKey: string
  try { apiKey = readApiKey() } catch { return { available: false, reason: 'Local model credentials are missing; run scripts/local-models/setup.ps1 to regenerate them' } }
  try {
    const running = await inspectAdmission(model, apiKey)
    return running ? { available: true, note: `${localModelLabel(modelId)} is already running` } : { available: true }
  } catch (error) {
    if (!(error instanceof AdmissionRefusal)) return { available: false, reason: error instanceof Error ? error.message : String(error) }
    const running = error.running
    const rule = 'This machine runs one llama.cpp server at a time.'
    if (!running.ours) return { available: false, reason: `${localModelLabel(running.model)} (${running.model}) is running on this machine but was not started by this Conductor, so it is left alone. ${rule} Use ${running.model} for this task, or stop that server yourself before switching.` }
    const verdict = await releaseVerdict(running, apiKey)
    if (verdict === 'idle') return { available: true, note: `${localModelLabel(running.model)} is idle and will be stopped to make room for ${localModelLabel(modelId)}` }
    return { available: false, reason: `${localModelLabel(running.model)} (${running.model}) is busy: ${verdict}. ${rule} Wait for that work to finish and try again, or use ${running.model} for this task instead.` }
  }
}

/** Bring one model's server up if it is not already answering. A tab closing never takes a server
 *  another tab is still using, and the stack's own `stop` command stays the way servers are shut
 *  down by hand; the one thing a start may stop is an idle server of another model that this
 *  Conductor started, because the machine holds one model at a time. */
async function ensureServer(stack: LocalStackConfig, model: LocalModelConfig, apiKey: string, onStart: () => void): Promise<void> {
  // Reuse must pass the same model identity and anonymous-key-refusal checks as startup.
  // Only startServer may allocate; it repeats admission under the cross-process lock.
  if (!startingServers.has(model.id)) {
    try { if (await inspectAdmission(model, apiKey)) return }
    catch { /* A concurrent process may still be loading. Locked startup waits/rechecks and
               reports the definitive refusal; this optimistic probe never permits a spawn. */ }
  }
  let pending = startingServers.get(model.id)
  const first = !pending
  if (!pending) {
    pending = startServer(stack.llamaServer, model, apiKey, { release: running => releaseVerdict(running, apiKey) }).then(() => undefined)
    startingServers.set(model.id, pending)
    void pending.catch(() => { /* Reported to whoever awaited it. */ }).finally(() => { if (startingServers.get(model.id) === pending) startingServers.delete(model.id) })
  }
  onStart()
  try { await pending }
  catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown reason'
    if (/Model file missing:/i.test(detail)) throw new LocalSetupError(`${localModelLabel(model.id)} is not installed.`)
    throw new Error(first ? `Local model failed to start: ${detail}` : `Local model failed to start in another conversation: ${detail}`)
  }
}

/** Conductor's own local runtime: llama.cpp serves tokens on loopback and this adapter owns the
 *  entire agent loop, so a local model never inherits Conductor's host-side tools. Its complete
 *  capability set is the allowlist in local-models/tools.ts: contained workspace file access,
 *  commands in a network-less Docker container, and narrowly scoped memory/research brokers.
 *  Restrictions are enforced by dispatch and trusted session scope, not by prompt text.
 *
 *  One adapter is one conversation. The model server is shared; conversation history, the tool
 *  loop, the sandbox container and the cancellation token all live on this instance, so two
 *  tabs on the same model cannot see or interrupt each other. */
/** Which phase a stop reason lands in. An answer cut at the output limit still stands as one
 *  when there is text; every other stop that is not the model's own final answer is a failure,
 *  so a controller polling the phase does not read a fabricated or truncated run as done. */
export function phaseFor(outcome: { stopReason: LocalStopReport['reason']; text: string }): 'completed' | 'failed' | 'interrupted' {
  if (outcome.stopReason === 'interrupted') return 'interrupted'
  if (outcome.stopReason === 'completed') return 'completed'
  if (outcome.stopReason === 'output_limit' && outcome.text.trim()) return 'completed'
  return 'failed'
}

export class LocalAdapter implements ProviderAdapter {
  readonly provider = 'local' as const
  private readonly options: AdapterOptions
  private readonly stack: LocalStackConfig | null
  private settings: SessionSettings
  private session?: LocalAgentSession
  private sessionModel?: string
  private sandbox: DockerSandbox | null = null
  private controller?: AbortController
  /** The turn in flight, so stopping the session can wait for it to unwind. */
  private turn?: Promise<void>
  private disposed = false
  private readonly providerCapabilities: ProviderCapabilities

  constructor(options: AdapterOptions) {
    this.options = options
    this.settings = options.settings
    this.stack = readConfig()
    const configured = this.stack?.models ?? {}
    // Named in the order this build presents them, with anything the owner added to their own
    // config listed after. The id is the contract; the label is only what a person reads.
    const ids = [...LOCAL_MODELS.map(model => model.id).filter(id => configured[id]), ...Object.keys(configured).filter(id => !LOCAL_MODELS.some(model => model.id === id))]
    this.providerCapabilities = {
      provider: 'local', runtimeVersion: this.stack?.llamaVersion?.slice(0, 60) ?? 'llama.cpp', adapterVersion: 1, authentication: 'api',
      textStreaming: true, steering: false, toolInputStreaming: false, toolOutputStreaming: false,
      approvals: false, questions: false, resume: false, fork: false, plans: false,
      // Edit first: it is both the ordinary way to work and, being first, the mode a new
      // local conversation opens in. Nothing here ever asks for approval, so there is no
      // middle ground between these two to offer.
      permissions: ['accept-edits', 'read-only'],
      effort: [],
      models: ids.map(id => ({ id, label: localModelLabel(id), isDefault: id === (configured[DEFAULT_LOCAL_MODEL] ? DEFAULT_LOCAL_MODEL : ids[0]) })),
      limitations: [
        'Inference runs on this machine through llama.cpp on 127.0.0.1. Public web research sends only the requested URL, without cookies or credentials.',
        `Tools are limited in code to ${LOCAL_TOOLS.join(', ')}; the Conductor bridge exposes project memory and task listing only, with no arbitrary MCP or host shell.`,
        'Commands run in a non-root Docker container with no network access; when the sandbox is unavailable, execution is refused rather than run on Windows.',
        'Nothing asks for approval: choose Read only for a turn that must not write files or run commands.',
        'Repository writes and web search are off unless the owner turns them on for the conversation. The container has no network even when granted: it commits locally, and a plain push of the checked-out branch to an existing remote is run on the host for it.',
        'Conversations are not resumable: history lives with the running adapter, not in a native session store.',
        'Approvals, questions, plan mode and effort levels are not part of this runtime.',
        'The active prompt is managed: tool results are shaped before they enter it, old rounds are folded into a durable task state as the window fills, tool rounds are paced to a hard cap, repetition is noticed, and a task contract (allowedPaths, acceptance command) is enforced by the runtime rather than the prompt.'
      ]
    }
  }

  get capabilities(): ProviderCapabilities { return this.providerCapabilities }

  private model(): LocalModelConfig {
    const stack = this.stack
    if (!stack) throw new LocalSetupError('Local models are not configured.')
    const requested = this.settings.model && stack.models[this.settings.model] ? this.settings.model : stack.models[DEFAULT_LOCAL_MODEL] ? DEFAULT_LOCAL_MODEL : Object.keys(stack.models)[0]
    const model = requested ? stack.models[requested] : undefined
    if (!model) throw new LocalSetupError('No local model is configured.')
    return model
  }

  private key(): string {
    try { return readApiKey() }
    catch { throw new Error('Local model credentials are missing; run scripts/local-models/setup.ps1 to regenerate them') }
  }

  private emit(event: AdapterEvent): void { if (!this.disposed) this.options.emit(event) }

  /** Health-check the model this conversation is set to, starting its server when it is down.
   *  Runs before the first connection and before every turn, so a server that was stopped or
   *  crashed between messages is brought back rather than failing the turn. */
  private async ready(turnId?: string): Promise<LocalModelConfig> {
    const model = this.model()
    if (!existsSync(modelFilePath(model))) throw new LocalSetupError(`${localModelLabel(model.id)} is not installed.`)
    let announced = false
    await ensureServer(this.stack!, model, this.key(), () => {
      announced = true
      this.emit({ turnId, data: { type: 'notice', message: `Starting ${localModelLabel(model.id)} locally; the first start loads the model into memory and can take a few minutes.` } })
    })
    if (announced) this.emit({ turnId, data: { type: 'notice', message: `${localModelLabel(model.id)} is ready.` } })
    return model
  }

  async start(): Promise<void> {
    // Connecting a tab validates setup but does not load model weights. The first actual dispatch
    // calls ready(), so an unused local conversation consumes no GPU, RAM or server process.
    const model = this.model()
    this.key()
    if (!existsSync(modelFilePath(model))) throw new LocalSetupError(`${localModelLabel(model.id)} is not installed.`)
    this.emit({ data: { type: 'session', phase: 'idle', capabilities: this.providerCapabilities } })
  }

  private ensureSession(model: LocalModelConfig): LocalAgentSession {
    const stack = this.stack!
    const readOnly = this.settings.permission === 'read-only' || this.settings.sandbox === 'read-only' || this.settings.plan
    const grants: LocalGrants = { git: Boolean(this.settings.localGit), research: Boolean(this.settings.localResearch) }
    const contract = normaliseContract(this.settings.localContract ?? undefined)
    // A container is only built for a turn that may actually run something, and once built
    // it is reused: a conversation that toggles back to Read only keeps it for later.
    if (!this.sandbox && !readOnly) this.sandbox = new DockerSandbox(this.options.runtimeId, this.options.cwd, stack.sandbox)
    // The mount is decided when the container starts, so the grant is applied before the turn
    // rather than read out of the settings at exec time.
    this.sandbox?.setGitAccess(grants.git)
    const sandbox = readOnly ? null : this.sandbox
    if (!this.session) {
      this.session = new LocalAgentSession({
        endpoint: endpointFor(model), apiKey: this.key(), model: model.id, workspace: this.options.cwd,
        sandbox, readOnly, grants, contract, timeoutSec: stack.sandbox.timeoutSec, contextTokens: model.contextTokens,
        control: this.options.localControl,
        beforeTool: paths => this.options.beforeTool?.(this.toolItemId, paths) ?? Promise.resolve(),
        afterTool: (paths, success) => this.options.afterTool?.(this.toolItemId, paths, success) ?? Promise.resolve()
      })
    } else {
      // Both of these can change between turns of one conversation. The mode change is
      // already visible in the composer; a model change is not, so only that is announced.
      this.session.retarget({ model: model.id, endpoint: endpointFor(model), contextTokens: model.contextTokens, readOnly, grants, contract, sandbox })
      if (this.sessionModel !== model.id) this.emit({ data: { type: 'notice', message: `This conversation now uses ${localModelLabel(model.id)}.` } })
    }
    this.sessionModel = model.id
    return this.session
  }

  private toolItemId = 'local-tool'

  /** Dispatch only. The turn itself runs on after this resolves and reports itself through
   *  events, exactly as the CLI adapters do: the composer clears the sent draft when the
   *  submit call returns, so holding it open for the whole generation would leave the
   *  message sitting in the box and the Stop control out of reach. */
  async submit(text: string, settings: SessionSettings, attachments: ContextAttachment[] = []): Promise<void> {
    if (this.controller) throw new Error('Local model already has a running turn')
    this.settings = settings
    this.turn = this.runTurn(text, attachments)
    await Promise.resolve()
  }

  private async runTurn(text: string, attachments: ContextAttachment[]): Promise<void> {
    const turnId = randomUUID()
    this.emit({ turnId, data: { type: 'session', phase: 'running' } })
    const controller = new AbortController()
    this.controller = controller
    // Each tool round gets its own text and reasoning items so thinking, answer text and tool
    // calls stay in the order they happened instead of collapsing into one block.
    let round = 0
    const textItem = (): string => `${turnId}:text:${round}`
    const reasoningItem = (): string => `${turnId}:reasoning:${round}`
    let releaseTurn = (): void => {}
    try {
      // Claimed before the server is even checked, so a switch decided in another conversation
      // between this check and the first request cannot take the server out from under it.
      releaseTurn = markTurn(this.model().id, this.options.runtimeId)
      const model = await this.ready(turnId)
      controller.signal.throwIfAborted()
      const session = this.ensureSession(model)
      const prompt = attachments.filter(item => item.content).map(item => `[Attached ${item.kind}: ${item.name}]\n${item.content}`).concat(text).join('\n\n')
      const outcome = await session.run(prompt, {
        text: delta => this.emit({ turnId, itemId: textItem(), data: { type: 'text', role: 'assistant', text: delta, mode: 'delta' } }),
        // Qwen's thinking is presented the way Codex's reasoning summaries are: a status item
        // in the timeline, never raw protocol dumped into the answer.
        reasoning: delta => this.emit({ turnId, itemId: reasoningItem(), data: { type: 'text', role: 'status', text: delta, mode: 'delta' } }),
        toolStart: call => {
          this.toolItemId = call.id
          let input: Json = call.input
          try { input = JSON.parse(call.input) as Json } catch { /* Malformed tool arguments are shown verbatim. */ }
          this.emit({ turnId, itemId: call.id, data: { type: 'tool', name: call.name, input, status: 'running' } })
        },
        toolEnd: call => {
          this.emit({ turnId, itemId: call.id, data: { type: 'tool', name: call.name, status: call.failed ? 'failed' : 'completed', output: call.output, outputMode: 'snapshot', durationMs: call.durationMs } })
          round++
        },
        // The context figures give the composer ring and "Model context window" the same data the
        // CLIs report: the window, and the room left once this round's answer reserve is held
        // back. Used is what the server counted for the request just made plus what it wrote,
        // which is what the next request will carry before its own shaping.
        usage: (usage, context) => this.emit({ turnId, data: { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, totalTokens: usage.totalTokens, scope: 'turn', source: 'provider',
          limits: { contextUsedTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), contextCapacityTokens: model.contextTokens - context.reserveTokens, contextReserveTokens: context.reserveTokens, modelContextWindow: model.contextTokens, contextRound: context.round, contextMeasurement: 'llama.cpp usage, exact for the last request' } }, ...(usage.timings ? { native: { method: 'llama.cpp/timings', payload: { ...usage.timings } } } : {}) }),
        notice: message => this.emit({ turnId, data: { type: 'notice', message } }),
        // Structured, debug-level: a payload keeps these out of the conversation and in the
        // event log, where a usage timeline can be built from them later.
        telemetry: entry => { if (entry.kind !== 'usage' && entry.kind !== 'request' && entry.kind !== 'tool' && entry.kind !== 'stop') this.emit({ turnId, data: { type: 'notice', message: `Local run telemetry: ${entry.kind}`, payload: { localTelemetry: entry as unknown as Json } } }) }
      }, controller.signal)
      if (outcome.stopReason === 'provider_error' || outcome.stopReason === 'context_limit') this.emit({ turnId, data: { type: 'error', message: outcome.report.detail } })
      this.emit({ turnId, itemId: `${turnId}:stop`, data: { type: 'notice', message: localStopSummary(outcome.report), payload: localStopPayload(outcome.report) } })
      this.emit({ turnId, data: { type: 'session', phase: phaseFor(outcome) } })
    } catch (error) {
      if (controller.signal.aborted) { this.emit({ turnId, data: { type: 'session', phase: 'interrupted' } }); return }
      this.emit({ turnId, data: { type: 'error', message: error instanceof Error ? error.message : 'Local model request failed' } })
      this.emit({ turnId, data: { type: 'session', phase: 'failed' } })
    } finally {
      releaseTurn()
      if (this.controller === controller) this.controller = undefined
    }
  }

  async compactContext(): Promise<Json | null> {
    if (this.controller) throw new Error('Wait for the current turn to finish before compacting')
    const result = this.session?.compactNow()
    if (!result) return null
    const recovered = result.beforeTokens - result.afterTokens
    this.emit({ data: { type: 'notice', message: `Context compacted on request: about ${recovered.toLocaleString()} tokens of earlier rounds folded into the task state; ${result.droppedMessages} messages left the active prompt.`, payload: { contextReset: true } } })
    return { recoveredTokens: recovered, droppedMessages: result.droppedMessages, mode: result.mode, promptTokensAfter: result.afterTokens }
  }

  runStatus(): Json | null {
    const state = this.session?.state()
    return state ? state as unknown as Json : null
  }

  async respond(_response: InteractionResponse): Promise<void> {
    throw new Error('Local models do not raise approvals or questions')
  }

  async interrupt(): Promise<void> {
    this.controller?.abort()
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    await this.turn?.catch(() => { /* A turn cut short by shutdown has nowhere left to report. */ })
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller?.abort()
    // Only this conversation's own container goes away. The llama.cpp servers are shared and
    // outlive every tab; they are stopped by the local stack's own command.
    const sandbox = this.sandbox
    this.sandbox = null
    this.session = undefined
    if (sandbox) void sandbox.stop().catch(() => { /* The container is removed on the next start as well. */ })
  }
}
