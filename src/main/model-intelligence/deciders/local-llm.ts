import type { LocalModelRunner } from '../../local-assist/contract.ts'
import type { Decider, DeciderOutcome, DecisionKind, DecisionRequest } from '../../../shared/model-routing'

/**
 * The small local model as a system-one decider for bounded decisions. It goes through the
 * local-assist runner, so it never starts a server during an interactive local turn and never
 * waits longer than the runner's budgets; anything but a clean JSON verdict is `ok: false`.
 */

export const LOCAL_LLM_DECIDER_ID = 'local-llm'
const LOCAL_KINDS: DecisionKind[] = ['approval', 'retry', 'escalate', 'completion', 'classify']
const RATIONALE_MAX = 600

export interface LocalLlmDeciderOptions {
  id?: string
  kinds?: DecisionKind[]
  /** Room for a reasoning model's <think> block plus the JSON. */
  maxTokens?: number
  waitBudgetMs?: number
  timeoutMs?: number
}

const SYSTEM = [
  'You are a decision function inside a developer tool. You choose between the given options for the given question and state.',
  'Answer with exactly one JSON object and nothing else, in this shape:',
  '{"probabilities":{"<option id>":<number 0..1>,...},"rationale":"<one or two sentences>"}',
  'Use only the option ids given. Give every option a probability; they must sum to 1. Put more weight on an option only when the state supports it.',
].join('\n')

export function localDecisionPrompt(request: DecisionRequest): { system: string; user: string } {
  const payload = { kind: request.kind, question: request.question, impact: request.impact, options: request.options.map(option => ({ id: option.id, label: option.label, ...(option.facts ? { facts: option.facts } : {}) })), state: request.state }
  return { system: SYSTEM, user: JSON.stringify(payload) }
}

/** Strips reasoning and fences and reads the verdict; a string names what was wrong. */
export function parseLocalVerdict(text: string, optionIds: string[]): { probabilities: Record<string, number>; rationale: string } | string {
  let body = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // Some chat templates open the think block in the prompt, so only its end appears.
  const close = body.toLowerCase().lastIndexOf('</think>')
  if (close >= 0) body = body.slice(close + '</think>'.length)
  if (/<think>/i.test(body)) return 'Reasoning never finished'
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fenced) body = fenced[1]!
  body = body.trim()
  const start = body.indexOf('{'), end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return 'No JSON object in the answer'
  let parsed: unknown
  try { parsed = JSON.parse(body.slice(start, end + 1)) } catch { return 'The answer is not valid JSON' }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'The answer is not a JSON object'
  const { probabilities, rationale } = parsed as Record<string, unknown>
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return 'No probabilities object'
  if (typeof rationale !== 'string') return 'No rationale'
  const entries = Object.entries(probabilities as Record<string, unknown>)
  const unknown = entries.filter(([id]) => !optionIds.includes(id)).map(([id]) => id)
  if (unknown.length) return `Unknown option id${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 3).join(', ')}`
  if (entries.some(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return 'Probabilities must be numbers between 0 and 1'
  const values = Object.fromEntries(optionIds.map(id => [id, ((probabilities as Record<string, number>)[id]) ?? 0]))
  const total = Object.values(values).reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return 'Probabilities sum to zero'
  if (Math.abs(total - 1) > 0.05) return `Probabilities sum to ${total.toFixed(2)}, not 1`
  return { probabilities: values, rationale: rationale.trim().slice(0, RATIONALE_MAX) }
}

export function createLocalLlmDecider(runner: LocalModelRunner, options: LocalLlmDeciderOptions = {}): Decider {
  const id = options.id ?? LOCAL_LLM_DECIDER_ID, kinds = options.kinds ?? LOCAL_KINDS
  return {
    id, tier: 'system-one',
    supports: kind => kinds.includes(kind),
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderOutcome> {
      const started = Date.now(), prompt = localDecisionPrompt(request)
      let outcome
      try {
        outcome = await runner.ask({ ...prompt, maxTokens: options.maxTokens ?? 1024, ...(options.waitBudgetMs !== undefined ? { waitBudgetMs: options.waitBudgetMs } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(signal ? { signal } : {}) })
      } catch (error) { return { ok: false, decider: id, reason: error instanceof Error ? error.message : String(error) } }
      if (!outcome.ok) return { ok: false, decider: id, reason: outcome.reason }
      const parsed = parseLocalVerdict(outcome.answer.text, request.options.map(option => option.id))
      if (typeof parsed === 'string') return { ok: false, decider: id, reason: parsed }
      return { ok: true, verdict: { decider: `${id}:${outcome.answer.model}`, ...parsed, tokens: outcome.answer.inputTokens + outcome.answer.outputTokens, elapsedMs: outcome.answer.durationMs || Date.now() - started } }
    },
  }
}
