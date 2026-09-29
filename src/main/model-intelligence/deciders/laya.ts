import type { Decider, DeciderOutcome, DecisionKind, DecisionRequest } from '../../../shared/model-routing'

/**
 * Laya typed-decisions as the system-one decider (docs/model-routing.md, "CPU decider"): one typed
 * `choice` question per decision, answered in a single forward pass by the CPU sidecar
 * (local-models/decider-server.ts) with a probability per option. It generates no text, so the
 * rationale says what it saw instead of why. Every kind is journaled in shadow: its verdict is
 * recorded beside the decision the app actually made and never acts on its own.
 */

export const LAYA_DECIDER_ID = 'laya'
export const LAYA_KINDS: DecisionKind[] = ['route', 'approval', 'retry', 'escalate', 'completion', 'fallback', 'classify']
/** A decision waits at most this long for a verdict (a cold start is up to three minutes; this bounds the answer). */
export const LAYA_TIMEOUT_MS = 20_000
const DESCRIPTION_MAX = 240
const STATE_VALUE_MAX = 1_200

/** What the decider needs from the sidecar. */
export interface LayaPort {
  predict(state: Record<string, unknown>, questions: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number }; inferenceMs?: number }>
}

const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max - 1) + '…' : text
/** Option ids Laya reads as they are; anything else (model keys with slashes and brackets) gets a neutral key. */
const plainKey = (id: string): boolean => /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(id)

function describe(option: DecisionRequest['options'][number]): string {
  const facts = option.facts ? Object.entries(option.facts).filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key} ${typeof value === 'number' ? Math.round(value * 1000) / 1000 : String(value)}`) : []
  return clip([option.label, ...facts].join('; '), DESCRIPTION_MAX)
}

/** The typed question and state Laya is asked: one choice over the options, keys mapped back after. */
export function layaQuestion(request: DecisionRequest): { state: Record<string, unknown>; questions: Record<string, unknown>; keys: Map<string, string> } {
  const keys = new Map<string, string>()
  const criteria: Record<string, string> = {}
  request.options.forEach((option, index) => {
    const key = plainKey(option.id) && !keys.has(option.id) ? option.id : `option_${index + 1}`
    keys.set(key, option.id)
    criteria[key] = describe(option)
  })
  const state: Record<string, unknown> = { kind: request.kind, impact: request.impact }
  for (const [key, value] of Object.entries(request.state ?? {})) {
    let text: string
    try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { continue }
    if (text !== undefined) state[key] = clip(text, STATE_VALUE_MAX)
  }
  return { state, questions: { decision: { type: 'choice', instructions: clip(request.question, 400), criteria } }, keys }
}

export function createLayaDecider(port: LayaPort, options: { id?: string; kinds?: DecisionKind[]; timeoutMs?: number; now?(): number } = {}): Decider {
  const id = options.id ?? LAYA_DECIDER_ID, kinds = options.kinds ?? LAYA_KINDS, now = options.now ?? Date.now
  return {
    id, tier: 'system-one',
    supports: kind => kinds.includes(kind),
    async decide(request, signal): Promise<DeciderOutcome> {
      const started = now(), asked = layaQuestion(request)
      let result
      try { result = await port.predict(asked.state, asked.questions, { ...(signal ? { signal } : {}), timeoutMs: options.timeoutMs ?? LAYA_TIMEOUT_MS }) }
      catch (error) { return { ok: false, decider: id, reason: error instanceof Error ? error.message : String(error) } }
      const answer = result.answers?.decision as { choice?: unknown; probabilities?: unknown; confidence?: unknown } | undefined
      if (!answer || !answer.probabilities || typeof answer.probabilities !== 'object') return { ok: false, decider: id, reason: 'The decider answered no probabilities' }
      const probabilities: Record<string, number> = {}
      for (const [key, value] of Object.entries(answer.probabilities as Record<string, unknown>)) {
        const option = asked.keys.get(key)
        if (option && typeof value === 'number' && Number.isFinite(value)) probabilities[option] = value
      }
      if (!Object.keys(probabilities).length) return { ok: false, decider: id, reason: 'The decider answered probabilities for no offered option' }
      const choice = typeof answer.choice === 'string' ? asked.keys.get(answer.choice) ?? answer.choice : '?'
      const confidence = typeof answer.confidence === 'number' ? ` (calibrated confidence ${answer.confidence.toFixed(2)})` : ''
      return { ok: true, verdict: {
        decider: `${id}:typed-decisions`, probabilities,
        rationale: `Laya typed-decisions chose ${choice} in one forward pass on CPU${confidence}; it gives probabilities, not reasons.`,
        tokens: typeof result.usage?.input_tokens === 'number' ? result.usage.input_tokens : null,
        elapsedMs: typeof result.inferenceMs === 'number' ? Math.round(result.inferenceMs) : now() - started
      } }
    }
  }
}
