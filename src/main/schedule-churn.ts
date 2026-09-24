import type { CompletionRequest } from './local-models/client'

/**
 * The "churn" tier of a scheduled task: summarizing and diffing changed script output on the
 * local model, so frontier models only ever see a short, bounded brief (docs/schedules.md).
 *
 * docs/machine-profile.md allows one llama.cpp server at a time. So: a server that is already
 * loaded is used as it is, whatever model it holds, and never switched; only when none is
 * running is the task's churn model (or the first configured one) started, through the same
 * admission-locked start path every local tab uses, and stopped again afterwards if this call
 * started it and nobody else began using it meanwhile. Generation takes the process-wide local
 * generation gate, so it queues behind a durable job's turn and yields to an interactive one.
 * Nothing is ever downloaded: a model that is not set up is reported, not fetched.
 */

export interface ChurnRequest {
  /** The task's churn model; null picks the first configured local model. */
  model: string | null
  system: string
  input: string
  maxTokens: number
  signal: AbortSignal
  /** Who holds the generation gate while this runs (shown to durable jobs waiting on it). */
  holder: string
}

export type ChurnResult =
  | { ok: true; model: string; text: string; note?: string }
  | { ok: false; model: string | null; note: string }

export interface LocalChurn { summarize(request: ChurnRequest): Promise<ChurnResult> }

export interface LocalChurnModel { id: string; label: string; contextTokens: number }

export interface LocalChurnDeps {
  /** Configured local models in preference order, or null when the local stack is not set up. */
  models(): LocalChurnModel[] | null
  apiKey(): string | null
  /** Local servers that are alive right now. */
  running(): Array<{ model: string; port: number }>
  healthy(port: number): Promise<boolean>
  /** Starts the model's server unless another model is resident (never switches one). */
  ensure(modelId: string): Promise<{ ok: true; port: number } | { ok: false; message: string }>
  stop(modelId: string): Promise<void>
  /** Whether a server this call started may be stopped now (no interactive local turn, no job). */
  mayStop(): boolean
  acquire(holder: string, signal: AbortSignal): Promise<{ release(): void }>
  complete(request: CompletionRequest): Promise<{ content: string }>
}

const CHARS_PER_TOKEN = 3
const MAX_INPUT_CHARS = 60_000

/** Keeps the head and the tail of an over-long input: a diff's first lines say what moved, its
 *  last lines usually hold the summary a script printed at the end. */
export function fitInput(input: string, limit: number): string {
  if (input.length <= limit) return input
  const head = Math.floor(limit * 0.7), marker = '\n[… middle omitted to fit the local model …]\n'
  return input.slice(0, head) + marker + input.slice(-(limit - head - marker.length))
}

export function createLocalChurn(deps: LocalChurnDeps): LocalChurn {
  return {
    async summarize(request) {
      const models = deps.models()
      if (!models?.length) return { ok: false, model: null, note: 'No local model is set up on this machine, so the change is reported as a plain diff.' }
      const apiKey = deps.apiKey()
      if (!apiKey) return { ok: false, model: null, note: 'The local model credentials are missing, so the change is reported as a plain diff.' }
      const wanted = (request.model && models.find(model => model.id === request.model)) || models[0]!
      let model = wanted, port: number | null = null, started = false, note: string | undefined
      for (const server of deps.running()) {
        const loaded = models.find(candidate => candidate.id === server.model)
        if (loaded && await deps.healthy(server.port)) {
          model = loaded; port = server.port
          if (loaded.id !== wanted.id) note = `${loaded.label} was already loaded, so it summarized instead of ${wanted.label}; a loaded model is never switched.`
          break
        }
      }
      if (port === null) {
        const ensured = await deps.ensure(wanted.id)
        if (!ensured.ok) return { ok: false, model: wanted.id, note: `The local model could not run (${ensured.message}), so the change is reported as a plain diff.` }
        port = ensured.port; started = true
      }
      let lease: { release(): void } | null = null
      try {
        lease = await deps.acquire(request.holder, request.signal)
        const room = Math.max(2_000, (model.contextTokens - request.maxTokens - 1_000) * CHARS_PER_TOKEN)
        const result = await deps.complete({
          endpoint: `http://127.0.0.1:${port}`, apiKey, model: model.id,
          messages: [{ role: 'system', content: request.system }, { role: 'user', content: fitInput(request.input, Math.min(MAX_INPUT_CHARS, room)) }],
          maxTokens: request.maxTokens, temperature: 0.2, reasoningEffort: 'low', contextTokens: model.contextTokens, signal: request.signal
        })
        const text = result.content.trim()
        if (!text) return { ok: false, model: model.id, note: 'The local model returned an empty summary, so the change is reported as a plain diff.' }
        return { ok: true, model: model.id, text: text.slice(0, 8_000), ...(note ? { note } : {}) }
      } catch (error) {
        if (request.signal.aborted) throw error
        return { ok: false, model: model.id, note: `The local summary failed (${error instanceof Error ? error.message : String(error)}), so the change is reported as a plain diff.` }
      } finally {
        lease?.release()
        if (started && deps.mayStop()) await deps.stop(model.id).catch(() => undefined)
      }
    }
  }
}
