import type { LocalModelConfig } from '../local-models/config.ts'
import { DOLPHIN_X1_8B, ORNITH_9B, QWEN_9B } from '../local-models/config.ts'
import type { LocalServerEntry } from '../local-models/servers.ts'
import { GENERATION_TIMEOUT_MS, MODEL_WAIT_BUDGET_MS, type LocalModelOutcome, type LocalModelRequest, type LocalModelRunner, type LocalModelRunnerPorts } from './contract.ts'

/**
 * The one local model a local-assist tool talks to. Every call is bounded: it queues behind the
 * previous assist call (one generation at a time on a one-slot server), waits for a loading
 * server or a busy slot only within the wait budget, and falls back with a reason instead of
 * throwing. It uses whatever server is already running (any model can summarise) and starts the
 * preferred one only when none is and no interactive local turn needs the GPU. A start outlives
 * the call that asked for it, so the next call finds the server up; a failed start is remembered
 * for FAILED_START_MEMORY_MS so a broken setup is not retried on every call.
 */

export const DEFAULT_PREFERRED_MODELS = [QWEN_9B, ORNITH_9B, DOLPHIN_X1_8B]
const POLL_MS = 500
const FAILED_START_MEMORY_MS = 5 * 60_000

export interface LocalModelRunnerOptions {
  preferred?: string[]
  /** Overrides GENERATION_TIMEOUT_MS (tests). */
  generationTimeoutMs?: number
}

class Fallback { constructor(readonly reason: string, readonly contextExceeded = false) {} }
/** How long a measured context or a located server is trusted before it is read again. */
const LOCATE_MEMORY_MS = 30_000

const seconds = (ms: number): number => Math.max(1, Math.round(ms / 1000))
/** Short, single-line, and never carrying the key. Server bodies never reach an error message
 *  here: chatCompletion's LocalRequestError keeps only the status and the machine-readable type. */
const safeDetail = (error: unknown, secrets: string[]): string => {
  let text = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 160 ? text.slice(0, 157) + '...' : text || 'unknown error'
}
const stripThinking = (text: string): string => text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim()
const estimate = (chars: number): number => Math.ceil(chars / 4)
/** llama.cpp's refusal of a prompt longer than the slot (LocalRequestError.contextExceeded). */
const contextExceeded = (error: unknown): boolean => Boolean(error && typeof error === 'object' && (error as { contextExceeded?: unknown }).contextExceeded === true)

export function createLocalModelRunner(ports: LocalModelRunnerPorts, options: LocalModelRunnerOptions = {}): LocalModelRunner {
  const preferred = options.preferred ?? DEFAULT_PREFERRED_MODELS
  const generationTimeoutMs = options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS
  let held = false
  const waiters: Array<() => void> = []
  let starting: { model: string; settled: Promise<void>; result: { port: number } | null; error: string | null } | null = null
  let failedStart: { at: number; reason: string } | null = null

  const cancelled = (signal?: AbortSignal): void => { if (signal?.aborted) throw new Fallback('the call was cancelled') }
  /** Waits for `ready()` (checked after every wake) until the deadline; `wake` ends a poll early. */
  const until = async (deadline: number, ready: () => boolean, wake: Promise<unknown> | null, signal?: AbortSignal): Promise<boolean> => {
    while (!ready()) {
      cancelled(signal)
      if (ports.now() >= deadline) return false
      await (wake ? Promise.race([wake, ports.sleep(Math.min(POLL_MS, Math.max(1, deadline - ports.now())))]) : ports.sleep(POLL_MS))
    }
    return true
  }

  const acquire = async (deadline: number, signal?: AbortSignal): Promise<boolean> => {
    if (!held) { held = true; return true }
    let granted = false
    let grant!: () => void
    const handed = new Promise<void>(resolve => { grant = () => { granted = true; resolve() } })
    waiters.push(grant)
    try {
      if (await until(deadline, () => granted, handed, signal)) return true
    } catch (error) { if (!granted) waiters.splice(waiters.indexOf(grant), 1); else release(); throw error }
    // Timed out: leave the queue, or pass on a hand-off that arrived in the same tick.
    if (granted) release()
    else waiters.splice(waiters.indexOf(grant), 1)
    return false
  }
  const release = (): void => { const next = waiters.shift(); if (next) next(); else held = false }

  const configured = (): LocalModelConfig[] => { try { return ports.models() } catch { return [] } }
  const pick = (models: LocalModelConfig[]): LocalModelConfig | undefined => preferred.map(id => models.find(model => model.id === id)).find(Boolean) ?? models[0]

  const startModel = (model: LocalModelConfig): NonNullable<typeof starting> => {
    const entry: NonNullable<typeof starting> = { model: model.id, settled: Promise.resolve(), result: null, error: null }
    entry.settled = Promise.resolve().then(() => ports.start(model)).then(
      result => { entry.result = result },
      error => {
        entry.error = `could not start ${model.id}: ${safeDetail(error, [safeKey(ports)])}`
        failedStart = { at: ports.now(), reason: entry.error }
      }
    ).finally(() => { if (starting === entry) starting = null })
    return entry
  }

  /** A port with a healthy server: the running one, or one started for this call. */
  const ensureServer = async (started: number, deadline: number, signal?: AbortSignal): Promise<{ port: number; model: string }> => {
    let running: LocalServerEntry[] = []
    try { running = ports.servers() } catch { /* unreadable inventory: treated as none running */ }
    const models = configured()
    if (running.length) {
      const entry = running.find(candidate => candidate.port !== null) ?? running[0]!
      const port = entry.port ?? models.find(model => model.id === entry.model)?.port ?? null
      if (port === null) throw new Fallback(`${entry.model} is running but its port is unknown`)
      while (!(await ports.healthy(port).catch(() => false))) {
        cancelled(signal)
        if (ports.now() >= deadline) throw new Fallback(`${entry.model} was still loading after ${seconds(Math.min(ports.now(), deadline) - started)} s`)
        await ports.sleep(POLL_MS)
      }
      return { port, model: entry.model }
    }
    if (!starting) {
      if (failedStart && ports.now() - failedStart.at < FAILED_START_MEMORY_MS) throw new Fallback(failedStart.reason)
      const model = pick(models)
      if (!model) throw new Fallback('no local model is configured')
      if (ports.interactiveBusy()) throw new Fallback('another local turn needs the GPU')
      starting = startModel(model)
    }
    const start = starting
    let done = false
    void start.settled.then(() => { done = true })
    if (!(await until(deadline, () => done, start.settled, signal))) throw new Fallback(`${start.model} is still starting (it keeps loading in the background)`)
    if (start.error !== null || !start.result) throw new Fallback(start.error ?? `could not start ${start.model}`)
    return { port: start.result.port, model: start.model }
  }

  const generate = async (request: LocalModelRequest, endpoint: string, model: string, apiKey: string, started: number): Promise<LocalModelOutcome> => {
    const controller = new AbortController()
    let timedOut = false
    const timeoutMs = request.timeoutMs ?? generationTimeoutMs
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort)
    try {
      cancelled(request.signal)
      const result = await ports.complete({
        endpoint, apiKey, model,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
        maxTokens: request.maxTokens, temperature: 0.2, reasoningEffort: 'none', signal: controller.signal
      })
      if (timedOut) throw new Fallback(`the local model did not answer within ${seconds(timeoutMs)} s`)
      cancelled(request.signal)
      const text = stripThinking(result.content ?? '')
      if (!text) throw new Fallback('the local model returned an empty answer')
      return {
        ok: true,
        answer: {
          text, model,
          inputTokens: result.usage?.inputTokens ?? estimate(request.system.length + request.user.length),
          outputTokens: result.usage?.outputTokens ?? estimate((result.content ?? '').length + (result.reasoning ?? '').length),
          durationMs: ports.now() - started
        }
      }
    } catch (error) {
      if (error instanceof Fallback) throw error
      if (timedOut) throw new Fallback(`the local model did not answer within ${seconds(timeoutMs)} s`)
      if (request.signal?.aborted) throw new Fallback('the call was cancelled')
      if (contextExceeded(error)) throw new Fallback(`the request was longer than the local model's context (${safeDetail(error, [apiKey])})`, true)
      throw new Fallback(`the local model failed: ${safeDetail(error, [apiKey])}`)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** The endpoint a measurement goes to: the override, or the server ask() would use. No lock:
   *  reading /props or tokenizing never takes the generation slot. */
  let located: { at: number; endpoint: string; model: string; context?: number | null } | null = null
  const locate = async (signal?: AbortSignal): Promise<{ endpoint: string; model: string; context?: number | null } | null> => {
    if (located && ports.now() - located.at < LOCATE_MEMORY_MS) return located
    try {
      let override: string | null = null
      try { override = ports.endpointOverride() } catch { /* none */ }
      const started = ports.now()
      const found = override ? { endpoint: override, model: pick(configured())?.id ?? 'local' } : await ensureServer(started, started + MODEL_WAIT_BUDGET_MS, signal).then(({ port, model }) => ({ endpoint: `http://127.0.0.1:${port}`, model }))
      located = { at: ports.now(), ...found }
      return located
    } catch { return null }
  }

  return {
    async contextTokens(signal) {
      const server = await locate(signal)
      if (!server || !ports.context) return null
      if (server.context === undefined) {
        const context = await ports.context(server.endpoint, server.model).catch(() => null)
        server.context = typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? context : null
      }
      return server.context
    },
    async promptTokens(request, signal) {
      const server = await locate(signal)
      if (!server || !ports.measure) return null
      let apiKey = ''
      try { apiKey = ports.apiKey() } catch { return null }
      const tokens = await ports.measure({
        endpoint: server.endpoint, apiKey, model: server.model, measureTokens: true, reasoningEffort: 'none', signal,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }]
      }).catch(() => null)
      return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null
    },
    async ask(request) {
      const started = ports.now()
      const deadline = started + (request.waitBudgetMs ?? MODEL_WAIT_BUDGET_MS)
      let locked = false
      try {
        cancelled(request.signal)
        locked = await acquire(deadline, request.signal)
        if (!locked) throw new Fallback(`the local model was busy for ${seconds(Math.min(ports.now(), deadline) - started)} s`)
        let apiKey = ''
        try { apiKey = ports.apiKey() } catch { /* the server refuses; reported as a failure */ }
        let override: string | null = null
        try { override = ports.endpointOverride() } catch { /* none */ }
        if (override) {
          const models = configured()
          return await generate(request, override, pick(models)?.id ?? 'local', apiKey, started)
        }
        const { port, model } = await ensureServer(started, deadline, request.signal)
        let busy = true
        // Interactive use first: a local conversation between two generations keeps the slot.
        while ((busy = ports.interactiveBusy() || await ports.slotBusy(port).catch(() => false))) {
          cancelled(request.signal)
          if (ports.now() >= deadline) break
          await ports.sleep(POLL_MS)
        }
        if (busy) throw new Fallback(`the local model was busy for ${seconds(Math.min(ports.now(), deadline) - started)} s`)
        return await generate(request, `http://127.0.0.1:${port}`, model, apiKey, started)
      } catch (error) {
        if (error instanceof Fallback) return { ok: false, reason: error.reason, ...(error.contextExceeded ? { contextExceeded: true } : {}) }
        return { ok: false, reason: `the local model failed: ${safeDetail(error, [safeKey(ports)])}` }
      } finally {
        if (locked) release()
      }
    }
  }
}

const safeKey = (ports: LocalModelRunnerPorts): string => { try { return ports.apiKey() } catch { return '' } }

/** Ports over the app's real local-models runtime; imported lazily so the MCP server and tests
 *  that only need the runner do not load the whole local stack. */
export async function realRunnerPorts(): Promise<LocalModelRunnerPorts> {
  const [llama, config, local, servers, guard, client] = await Promise.all([
    import('../local-models/llama.ts'), import('../local-models/config.ts'), import('../providers/local.ts'),
    import('../local-models/servers.ts'), import('../local-models/resource-guard.ts'), import('../local-models/client.ts')
  ])
  const models = (): LocalModelConfig[] => { try { return Object.values(config.loadConfig().models) } catch { return [] } }
  const apiKey = (): string => { try { return config.readApiKey() } catch { return '' } }
  // Only servers this Conductor started (run records): the machine-wide process list is a
  // synchronous PowerShell query that would stall the main process. A foreign server is still
  // found by startServer's admission check, which refuses and becomes the fallback note.
  const noInventory = (): ReturnType<typeof guard.runningLlamaProcesses> => []
  return {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    servers: () => servers.listLocalServers({ models, record: llama.readRunRecord, alive: llama.processAlive, inventory: noInventory }),
    models,
    apiKey,
    endpointOverride: local.localEndpointOverride,
    healthy: async port => (await llama.health(port, apiKey(), 4000)).ok,
    slotBusy: port => local.slotsProcessing(port, apiKey()),
    interactiveBusy: () => local.localTurnsInFlight() > 0,
    async start(model) {
      const key = apiKey()
      if (!key) throw new Error('local model credentials are missing')
      const outcome = await llama.startServer(config.loadConfig().llamaServer, model, key)
      return { port: outcome.port }
    },
    complete: request => client.chatCompletion(request),
    context: async (endpoint, model) => (await local.probeLocalContext(endpoint, apiKey(), model, Number.MAX_SAFE_INTEGER)).serverTokens ?? null,
    measure: async request => (await client.runtimePromptTokens(request)) ?? null
  }
}
