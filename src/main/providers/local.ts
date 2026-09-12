import { randomUUID } from 'node:crypto'
import type { AdapterOptions, ProviderAdapter } from './adapter'
import type { AdapterEvent, ContextAttachment, InteractionResponse, Json, ProviderCapabilities, SessionSettings } from '../../shared/structured-agent'
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS, localModelLabel } from '../../shared/local-models'
import { LocalAgentSession } from '../local-models/agent.ts'
import { endpointFor, loadConfig, readApiKey } from '../local-models/config.ts'
import type { LocalModelConfig, LocalStackConfig } from '../local-models/config.ts'
import { health, startServer } from '../local-models/llama.ts'
import { DockerSandbox } from '../local-models/sandbox.ts'
import { LOCAL_TOOLS, type LocalGrants } from '../local-models/tools.ts'

const readConfig = (): LocalStackConfig | null => {
  try { return loadConfig() } catch { return null }
}

/** One llama.cpp process per model, shared by every conversation that asked for it. Two tabs
 *  opening the same model at once must not race into two servers, so the in-flight start is
 *  kept here, process-wide, rather than per adapter. `startServer` itself also refuses to
 *  duplicate an already-healthy process, which covers a server this app did not start. */
const startingServers = new Map<string, Promise<void>>()

/** Bring one model's server up if it is not already answering. Never stops anything: a tab
 *  closing must not take a server another tab is still using, and the stack's own `stop`
 *  command stays the way servers are shut down. */
async function ensureServer(stack: LocalStackConfig, model: LocalModelConfig, apiKey: string, onStart: () => void): Promise<void> {
  if ((await health(model.port, apiKey)).ok) return
  let pending = startingServers.get(model.id)
  const first = !pending
  if (!pending) {
    pending = startServer(stack.llamaServer, model, apiKey).then(() => undefined)
    startingServers.set(model.id, pending)
    void pending.catch(() => { /* Reported to whoever awaited it. */ }).finally(() => { if (startingServers.get(model.id) === pending) startingServers.delete(model.id) })
  }
  onStart()
  try { await pending }
  catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown reason'
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
        'Repository writes and web search are off unless the owner turns them on for the conversation; even granted, the container has no network, so git can commit locally but never push.',
        'Conversations are not resumable: history lives with the running adapter, not in a native session store.',
        'Approvals, questions, plan mode and effort levels are not part of this runtime.'
      ]
    }
  }

  get capabilities(): ProviderCapabilities { return this.providerCapabilities }

  private model(): LocalModelConfig {
    const stack = this.stack
    if (!stack) throw new Error('Local model stack is not set up; run scripts/local-models/setup.ps1')
    const requested = this.settings.model && stack.models[this.settings.model] ? this.settings.model : stack.models[DEFAULT_LOCAL_MODEL] ? DEFAULT_LOCAL_MODEL : Object.keys(stack.models)[0]
    const model = requested ? stack.models[requested] : undefined
    if (!model) throw new Error('No local model is configured')
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
    let announced = false
    await ensureServer(this.stack!, model, this.key(), () => {
      announced = true
      this.emit({ turnId, data: { type: 'notice', message: `Starting ${localModelLabel(model.id)} locally; the first start loads the model into memory and can take a few minutes.` } })
    })
    if (announced) this.emit({ turnId, data: { type: 'notice', message: `${localModelLabel(model.id)} is ready.` } })
    return model
  }

  async start(): Promise<void> {
    await this.ready()
    this.emit({ data: { type: 'session', phase: 'idle', capabilities: this.providerCapabilities } })
  }

  private ensureSession(model: LocalModelConfig): LocalAgentSession {
    const stack = this.stack!
    const readOnly = this.settings.permission === 'read-only' || this.settings.sandbox === 'read-only' || this.settings.plan
    const grants: LocalGrants = { git: Boolean(this.settings.localGit), research: Boolean(this.settings.localResearch) }
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
        sandbox, readOnly, grants, timeoutSec: stack.sandbox.timeoutSec, contextTokens: model.contextTokens,
        control: this.options.localControl,
        beforeTool: paths => this.options.beforeTool?.(this.toolItemId, paths) ?? Promise.resolve(),
        afterTool: (paths, success) => this.options.afterTool?.(this.toolItemId, paths, success) ?? Promise.resolve()
      })
    } else {
      // Both of these can change between turns of one conversation. The mode change is
      // already visible in the composer; a model change is not, so only that is announced.
      this.session.retarget({ model: model.id, endpoint: endpointFor(model), contextTokens: model.contextTokens, readOnly, grants, sandbox })
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
    try {
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
        usage: usage => this.emit({ turnId, data: { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, scope: 'turn', source: 'provider' } }),
        notice: message => this.emit({ turnId, data: { type: 'notice', message } })
      }, controller.signal)
      this.emit({ turnId, data: { type: 'session', phase: outcome.stopReason === 'interrupted' ? 'interrupted' : outcome.stopReason === 'iteration_limit' ? 'failed' : 'completed' } })
    } catch (error) {
      if (controller.signal.aborted) { this.emit({ turnId, data: { type: 'session', phase: 'interrupted' } }); return }
      this.emit({ turnId, data: { type: 'error', message: error instanceof Error ? error.message : 'Local model request failed' } })
      this.emit({ turnId, data: { type: 'session', phase: 'failed' } })
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
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
