import type { DurableJobEventDraft } from './watchdog.ts'
import { redactData, redactSensitive } from './watchdog.ts'

/**
 * Keeps the one local llama.cpp server a durable job needs alive across a night: notices a dead,
 * restarted or re-purposed server, brings it back through the app's own start path with bounded
 * exponential backoff, records every step as a 'server' event, and gives up into a resumable
 * blocked state with a practical next action. It never spawns a server itself: `ensure` is the
 * existing admission-locked `startServer` (src/main/local-models/llama.ts), which reuses a healthy
 * server and refuses a second one, so a job can never compete with the owner's tabs for VRAM.
 *
 * Exported surface (Opus A wires it from ports.ts):
 *   interface ServerObservation { recordPresent; pid; pidAlive; port; listening; health: { ok; status; models?; detail? } | null; startedAt? }
 *   type ServerState = 'healthy' | 'wrong-model' | 'loading' | 'unresponsive' | 'dead'
 *   function classifyServer(observation, modelId): ServerState
 *   type EnsureResult = { ok: true; port; pid; message }
 *     | { ok: false; reason: 'other-model'; running: { model; ours; busy: string | null }; message }
 *     | { ok: false; reason: 'setup' | 'resources' | 'failed'; message }
 *   interface ServerLifecyclePorts {
 *     now(): number; sleep(ms): Promise<void>; probe(): Promise<ServerObservation>
 *     ensure(opts: { allowSwitch: boolean }): Promise<EnsureResult>; emit(event: DurableJobEventDraft): void
 *     secrets?: string[] }
 *   interface BackoffPolicy { attempts; initialDelayMs; factor; maxDelayMs }
 *   function backoffSchedule(policy): number[]
 *   interface ServerLifecycleOptions { backoff; differentModel: 'switch-when-idle' | 'wait'; interactiveQuietMs; waitForModelMs; loadingGraceMs; pollMs }
 *   type ServerReadiness = { ok: true; port; restarted: boolean; message }
 *     | { ok: false; blocked: { resumable: true; reason; nextAction; diagnostics } }
 *   class ServerSupervisor(modelId, ports, options?)
 *     check(): Promise<{ state: ServerState; restarted: boolean; observation }>   one probe, events on change
 *     ensureReady(signal?: AbortSignal): Promise<ServerReadiness>               probe, restart with backoff, or block
 *   function createLlamaServerPorts(modelId, deps?): Promise<ServerLifecyclePorts>  real wiring, lazy imports
 *
 * Different-model policy (docs/machine-profile.md: one server, 12 GB VRAM; interactive use first):
 * a server of another model is never stopped while anyone uses it. When it was started by this
 * Conductor and has been observed idle (no turn in flight here, no busy slot) for
 * `interactiveQuietMs` continuously, the job may let `startServer` switch it (default
 * 'switch-when-idle'), so a model the owner left loaded does not burn the night. With 'wait', or
 * for a server Conductor did not start, the job waits with backoff up to `waitForModelMs` and then
 * blocks, naming the running model. The quiet window is what stops a job and an owner who is
 * typing between turns from swapping the model back and forth.
 */

export interface ServerObservation {
  recordPresent: boolean
  pid: number | null
  pidAlive: boolean
  port: number
  listening: boolean
  health: { ok: boolean; status: number; models?: string[]; detail?: string } | null
  startedAt?: string
}

export type ServerState = 'healthy' | 'wrong-model' | 'loading' | 'unresponsive' | 'dead'

export function classifyServer(observation: ServerObservation, modelId: string): ServerState {
  const { health } = observation
  if (health?.ok) return !health.models?.length || health.models.includes(modelId) ? 'healthy' : 'wrong-model'
  // llama.cpp answers 503 while it loads weights; a live pid not yet listening is the same.
  if (observation.pidAlive && (!observation.listening || health?.status === 503)) return 'loading'
  if (observation.listening) return 'unresponsive'
  return 'dead'
}

export type EnsureResult =
  | { ok: true; port: number; pid: number | null; message: string }
  | { ok: false; reason: 'other-model'; running: { model: string; ours: boolean; busy: string | null }; message: string }
  | { ok: false; reason: 'setup' | 'resources' | 'failed'; message: string }

export interface ServerLifecyclePorts {
  now(): number
  sleep(ms: number): Promise<void>
  probe(): Promise<ServerObservation>
  ensure(opts: { allowSwitch: boolean }): Promise<EnsureResult>
  emit(event: DurableJobEventDraft): void
  /** Known secrets (the local API key) scrubbed from every message this module emits. */
  secrets?: string[]
}

export interface BackoffPolicy { attempts: number; initialDelayMs: number; factor: number; maxDelayMs: number }

/** Delays before each restart attempt after the first: attempts-1 entries, capped. */
export function backoffSchedule(policy: BackoffPolicy): number[] {
  return Array.from({ length: Math.max(0, policy.attempts - 1) }, (_, i) => Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * policy.factor ** i)))
}

export interface ServerLifecycleOptions {
  backoff: BackoffPolicy
  differentModel: 'switch-when-idle' | 'wait'
  interactiveQuietMs: number
  waitForModelMs: number
  /** How long a loading server (pid alive, 503) is waited on before it counts as a failure. */
  loadingGraceMs: number
  pollMs: number
}

export const DEFAULT_SERVER_LIFECYCLE_OPTIONS: ServerLifecycleOptions = {
  backoff: { attempts: 5, initialDelayMs: 5_000, factor: 2, maxDelayMs: 120_000 },
  differentModel: 'switch-when-idle',
  interactiveQuietMs: 10 * 60_000,
  waitForModelMs: 2 * 60 * 60_000,
  loadingGraceMs: 6 * 60_000,
  pollMs: 30_000
}

export type ServerReadiness =
  | { ok: true; port: number; restarted: boolean; message: string }
  | { ok: false; blocked: { resumable: true; reason: string; nextAction: string; diagnostics: Record<string, unknown> } }

interface Identity { pid: number | null; port: number; startedAt?: string }

export class ServerSupervisor {
  private readonly modelId: string
  private readonly ports: ServerLifecyclePorts
  private readonly options: ServerLifecycleOptions
  private lastState: ServerState | null = null
  private identity: Identity | null = null

  constructor(modelId: string, ports: ServerLifecyclePorts, options: Partial<ServerLifecycleOptions> = {}) {
    this.modelId = modelId
    this.ports = ports
    this.options = { ...DEFAULT_SERVER_LIFECYCLE_OPTIONS, ...options, backoff: { ...DEFAULT_SERVER_LIFECYCLE_OPTIONS.backoff, ...options.backoff } }
  }

  private emit(message: string, data: Record<string, unknown>): void {
    const secrets = this.ports.secrets ?? []
    this.ports.emit({ kind: 'server', message: redactSensitive(message, secrets), data: redactData({ model: this.modelId, ...data }, secrets) })
  }

  /** One probe. A healthy server whose pid or start time differs from the last healthy one seen
   *  is a restart: the job's in-flight call is gone and its prompt cache is cold. */
  async check(): Promise<{ state: ServerState; restarted: boolean; observation: ServerObservation }> {
    let observation: ServerObservation
    try { observation = await this.ports.probe() }
    catch (error) { observation = { recordPresent: false, pid: null, pidAlive: false, port: 0, listening: false, health: { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) } } }
    const state = classifyServer(observation, this.modelId)
    let restarted = false
    if (state === 'healthy') {
      const next: Identity = { pid: observation.pid, port: observation.port, startedAt: observation.startedAt }
      const previous = this.identity
      restarted = !!previous && (previous.port !== next.port || previous.startedAt !== next.startedAt || (previous.pid !== null && next.pid !== null && previous.pid !== next.pid))
      this.identity = next
      if (restarted) this.emit(`${this.modelId} server was restarted (pid ${previous?.pid ?? '?'} → ${next.pid ?? 'adopted'}, port ${previous?.port} → ${next.port}); in-flight work is reconciled and the prompt cache is cold.`, { previous, current: next })
    }
    if (state !== this.lastState) {
      if (this.lastState !== null || state !== 'healthy') this.emit(`${this.modelId} server is ${state}${this.lastState ? ` (was ${this.lastState})` : ''}.`, { state, previous: this.lastState, port: observation.port, pidAlive: observation.pidAlive, listening: observation.listening, status: observation.health?.status ?? null, servedModels: observation.health?.models ?? [], detail: observation.health?.detail ?? null })
      this.lastState = state
    }
    return { state, restarted, observation }
  }

  /** Returns once the job's model answers, or a resumable block. Never throws for server faults. */
  async ensureReady(signal?: AbortSignal): Promise<ServerReadiness> {
    const started = this.ports.now()
    const delays = backoffSchedule(this.options.backoff)
    let failures = 0
    let quietSince: number | null = null
    const cancelled = (): ServerReadiness => ({ ok: false, blocked: { resumable: true, reason: 'Server recovery was cancelled.', nextAction: 'Resume the job to retry the server.', diagnostics: { model: this.modelId } } })
    const block = (reason: string, nextAction: string, diagnostics: Record<string, unknown> = {}): ServerReadiness => {
      const secrets = this.ports.secrets ?? []
      this.emit(`Blocked: ${reason}`, { nextAction, ...diagnostics })
      return { ok: false, blocked: { resumable: true, reason: redactSensitive(reason, secrets), nextAction, diagnostics: redactData({ model: this.modelId, failures, ...diagnostics }, secrets) } }
    }
    while (true) {
      if (signal?.aborted) return cancelled()
      const { state, restarted, observation } = await this.check()
      if (state === 'healthy') return { ok: true, port: observation.port, restarted, message: `${this.modelId} healthy on 127.0.0.1:${observation.port}` }
      if (state === 'loading' && this.ports.now() - started < this.options.loadingGraceMs) { await this.ports.sleep(Math.min(this.options.pollMs, this.options.backoff.initialDelayMs)); continue }

      const allowSwitch = this.options.differentModel === 'switch-when-idle' && quietSince !== null && this.ports.now() - quietSince >= this.options.interactiveQuietMs
      const result = await this.ports.ensure({ allowSwitch })
      let failure: { reason: 'resources' | 'failed'; message: string } | null = null
      if (result.ok) {
        this.emit(`${this.modelId} server ensured: ${result.message}.`, { port: result.port, pid: result.pid, attempt: failures + 1, allowSwitch })
        // The start path's word is not enough: the probe must confirm it, or it counts as a failed attempt.
        const confirmed = await this.check()
        if (confirmed.state === 'healthy') return { ok: true, port: confirmed.observation.port, restarted: true, message: `${this.modelId} healthy on 127.0.0.1:${confirmed.observation.port} (${result.message})` }
        failure = { reason: 'failed', message: `start reported ${result.message} but the server probes ${confirmed.state}` }
      } else if (result.reason === 'setup') {
        return block(`${this.modelId} cannot be started: ${result.message}`, 'Fix the local model setup (model file, configuration or credentials) in Conductor\'s local models panel, then resume the job.', { reason: result.reason })
      } else if (result.reason === 'other-model') {
        const { running } = result
        if (running.busy === null && running.ours) quietSince ??= this.ports.now()
        else quietSince = null
        const waited = this.ports.now() - started
        if (waited >= this.options.waitForModelMs) {
          const nextAction = !running.ours
            ? `${running.model} was not started by Conductor, so the job leaves it alone. Stop it yourself when you are done with it, then resume the job.`
            : running.busy
              ? `${running.model} is in use (${running.busy}). Resume the job when that conversation is finished, or stop that model from the local models panel.`
              : `${running.model} is loaded and idle but the job is set to wait for it. Stop it from the local models panel or set the job to switch when idle, then resume.`
          return block(`${this.modelId} is waiting for the machine: ${running.model} holds the one local model server.`, nextAction, { running: running.model, ours: running.ours, busy: running.busy, waitedMs: waited })
        }
        this.emit(`Waiting: ${running.model} holds the local model server (${running.busy ?? (running.ours ? 'idle' : 'not started by Conductor')}); the job does not interrupt it.`, { running: running.model, ours: running.ours, busy: running.busy, quietForMs: quietSince === null ? 0 : this.ports.now() - quietSince })
        await this.ports.sleep(this.options.pollMs)
        continue
      } else failure = { reason: result.reason, message: result.message }
      failures++
      if (failures >= this.options.backoff.attempts) {
        return block(`${this.modelId} did not come back after ${failures} start attempts (${failure.reason}): ${failure.message}`, failure.reason === 'resources'
          ? 'Free RAM/VRAM (close other GPU work), then resume the job.'
          : 'Read the llama.cpp server log for this model (Conductor local models panel), fix what it names, then resume the job.', { reason: failure.reason, lastFailure: failure.message })
      }
      const delay = delays[failures - 1]!
      this.emit(`Server start attempt ${failures} failed (${failure.reason}); retrying in ${Math.round(delay / 1000)}s.`, { attempt: failures, delayMs: delay, reason: failure.reason, detail: failure.message })
      await this.ports.sleep(delay)
    }
  }
}

// --- Generation gate: one job generation at a time, interactive use first -------------------

/**
 * The server runs one slot (`--parallel 1` in llamaServerArgs), so a job generation that is in
 * flight makes an interactive request queue behind it. The gate keeps the job to one generation
 * at a time process-wide and, before each one, waits while an interactive local turn is active;
 * a job therefore yields between calls and an interactive turn waits at most one bounded job call
 * (modelCallTimeoutMs). `yieldRequested()` lets a controller cut a long generation short at a
 * safe point when the host reports interactive demand.
 *
 *   interface GenerationGatePorts { now(); sleep(ms); interactiveActive(): Promise<string | null> }
 *   class LocalGenerationGate(ports, { pollMs, maxYieldMs })
 *     acquire(jobId, signal?): Promise<{ release(): void; waitedMs: number; yieldedTo: string | null }>
 *     noteInteractiveDemand(): void    host hook: an interactive local turn wants the server
 *     yieldRequested(): boolean        true while demand is pending and a job holds the gate
 *     holder(): string | null
 */
export interface GenerationGatePorts {
  now(): number
  sleep(ms: number): Promise<void>
  /** A reason when an interactive local conversation is mid-turn, otherwise null. */
  interactiveActive(): Promise<string | null>
}

export class LocalGenerationGate {
  private readonly ports: GenerationGatePorts
  private readonly pollMs: number
  private readonly maxYieldMs: number
  private current: string | null = null
  private queue: Array<() => void> = []
  private demand = false

  constructor(ports: GenerationGatePorts, options: { pollMs?: number; maxYieldMs?: number } = {}) {
    this.ports = ports
    this.pollMs = options.pollMs ?? 5_000
    // Interactive use first, but a tab left mid-turn forever must not freeze the job for good.
    this.maxYieldMs = options.maxYieldMs ?? 30 * 60_000
  }

  holder(): string | null { return this.current }
  noteInteractiveDemand(): void { this.demand = true }
  yieldRequested(): boolean { return this.demand && this.current !== null }

  async acquire(jobId: string, signal?: AbortSignal): Promise<{ release(): void; waitedMs: number; yieldedTo: string | null }> {
    const started = this.ports.now()
    if (this.current !== null) await new Promise<void>(resolve => this.queue.push(resolve))
    this.current = jobId
    let yieldedTo: string | null = null
    try {
      while (!signal?.aborted && this.ports.now() - started < this.maxYieldMs) {
        const busy = await this.ports.interactiveActive().catch(() => null)
        if (!busy) break
        yieldedTo = busy
        await this.ports.sleep(this.pollMs)
      }
      if (signal?.aborted) throw new Error('Generation cancelled while waiting for the local model')
    } catch (error) { this.handOff(); throw error }
    this.demand = false
    let released = false
    return { waitedMs: this.ports.now() - started, yieldedTo, release: () => { if (!released) { released = true; this.handOff() } } }
  }

  private handOff(): void {
    this.current = null
    this.queue.shift()?.()
  }
}

// --- Real wiring -----------------------------------------------------------------------------

export interface LlamaLifecycleDeps {
  readRunRecord: typeof import('../local-models/llama.ts').readRunRecord
  processAlive: typeof import('../local-models/llama.ts').processAlive
  portInUse: typeof import('../local-models/llama.ts').portInUse
  health: typeof import('../local-models/llama.ts').health
  startServer: typeof import('../local-models/llama.ts').startServer
  releaseVerdict: typeof import('../providers/local.ts').releaseVerdict
  loadConfig: typeof import('../local-models/config.ts').loadConfig
  readApiKey: typeof import('../local-models/config.ts').readApiKey
  now(): number
  sleep(ms: number): Promise<void>
}

async function defaultDeps(): Promise<LlamaLifecycleDeps> {
  const [llama, config, local] = await Promise.all([import('../local-models/llama.ts'), import('../local-models/config.ts'), import('../providers/local.ts')])
  return {
    readRunRecord: llama.readRunRecord, processAlive: llama.processAlive, portInUse: llama.portInUse, health: llama.health, startServer: llama.startServer,
    releaseVerdict: local.releaseVerdict, loadConfig: config.loadConfig, readApiKey: config.readApiKey,
    now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
  }
}

/** Ports over the app's real runtime. `ensure` is `startServer` under the machine-wide admission
 *  lock: it reuses a healthy server, refuses a second model, and with `allowSwitch` stops only an
 *  idle server this Conductor started (the same release rule an interactive tab uses). */
export async function createLlamaServerPorts(modelId: string, emit: (event: DurableJobEventDraft) => void, overrides: Partial<LlamaLifecycleDeps> = {}): Promise<ServerLifecyclePorts> {
  const deps = { ...(await defaultDeps()), ...overrides }
  const load = (): { stack: ReturnType<LlamaLifecycleDeps['loadConfig']>; model: ReturnType<LlamaLifecycleDeps['loadConfig']>['models'][string] } | null => {
    try { const stack = deps.loadConfig(); const model = stack.models[modelId]; return model ? { stack, model } : null } catch { return null }
  }
  let apiKey = ''
  try { apiKey = deps.readApiKey() } catch { /* ensure reports setup */ }
  return {
    now: deps.now,
    sleep: deps.sleep,
    emit,
    secrets: apiKey ? [apiKey] : [],
    async probe() {
      const loaded = load()
      if (!loaded) return { recordPresent: false, pid: null, pidAlive: false, port: 0, listening: false, health: null }
      const record = deps.readRunRecord(loaded.model)
      const port = record?.port ?? loaded.model.port
      const pidAlive = deps.processAlive(record?.pid ?? null)
      const listening = await deps.portInUse(port, 1500)
      const health = listening && apiKey ? await deps.health(port, apiKey, 4000) : null
      return { recordPresent: !!record, pid: record?.pid ?? null, pidAlive, port, listening, health, startedAt: record?.startedAt }
    },
    async ensure({ allowSwitch }) {
      const loaded = load()
      if (!loaded) return { ok: false, reason: 'setup', message: `${modelId} is not configured on this machine` }
      if (!apiKey) return { ok: false, reason: 'setup', message: 'local model credentials are missing' }
      const { AdmissionRefusal } = await import('../local-models/resource-guard.ts')
      try {
        const outcome = await deps.startServer(loaded.stack.llamaServer, loaded.model, apiKey, allowSwitch ? { release: running => deps.releaseVerdict(running, apiKey) } : {})
        return { ok: true, port: outcome.port, pid: outcome.pid || null, message: outcome.message }
      } catch (error) {
        const message = redactSensitive(error instanceof Error ? error.message : String(error), [apiKey])
        if (error instanceof AdmissionRefusal) {
          const busy = await deps.releaseVerdict(error.running, apiKey).catch(() => 'unknown')
          return { ok: false, reason: 'other-model', running: { model: error.running.model, ours: error.running.ours, busy: busy === 'idle' ? null : busy }, message }
        }
        // "busy" / "not started by this Conductor" refusals from makeRoom under allowSwitch.
        const other = /^Cannot start \S+: (\S+) (?:is busy \((.*)\)|is running on this machine but was not started)/.exec(message)
        if (other) return { ok: false, reason: 'other-model', running: { model: other[1]!, ours: !!other[2], busy: other[2] ?? null }, message }
        if (/Model file missing|not configured|malformed|credentials/i.test(message)) return { ok: false, reason: 'setup', message }
        if (/Not enough memory|headroom/i.test(message)) return { ok: false, reason: 'resources', message }
        return { ok: false, reason: 'failed', message }
      }
    }
  }
}
