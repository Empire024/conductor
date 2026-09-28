import type { Decider, DeciderOutcome, DecisionKind, DecisionRequest } from '../../../shared/model-routing'

/**
 * The frontier decider: whatever strong model the app can ask, behind a port. Module E adapts the
 * approval gate's reviewer (ApprovalReviewRouting.run) with approvalReviewFrontier, and may bind a
 * one-shot structured reviewer call for other kinds through createFrontierDecider.
 */

export const FRONTIER_DECIDER_ID = 'frontier'

/** What the port answers: a choice (one-hot) or probabilities, and why. */
export type FrontierAnswer = ({ choice: string; probabilities?: undefined } | { probabilities: Record<string, number>; choice?: undefined }) & { rationale: string; model?: string; tokens?: number | null }
export interface FrontierPort { ask(request: DecisionRequest, signal?: AbortSignal): Promise<FrontierAnswer> }
export interface FrontierDeciderOptions { id?: string; kinds?: DecisionKind[]; now?(): number }

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createFrontierDecider(port: FrontierPort, options: FrontierDeciderOptions = {}): Decider {
  const id = options.id ?? FRONTIER_DECIDER_ID, now = options.now ?? Date.now
  return {
    id, tier: 'frontier',
    supports: kind => !options.kinds || options.kinds.includes(kind),
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderOutcome> {
      const started = now(), ids = request.options.map(option => option.id)
      let answer: FrontierAnswer
      try { answer = await port.ask(request, signal) } catch (error) { return { ok: false, decider: id, reason: message(error) } }
      if (!answer || typeof answer.rationale !== 'string') return { ok: false, decider: id, reason: 'The frontier answer has no rationale' }
      let probabilities: Record<string, number>
      if (answer.choice !== undefined) {
        if (!ids.includes(answer.choice)) return { ok: false, decider: id, reason: `The frontier chose '${answer.choice}', which is not an option` }
        probabilities = Object.fromEntries(ids.map(option => [option, option === answer.choice ? 1 : 0]))
      } else if (answer.probabilities && typeof answer.probabilities === 'object') probabilities = answer.probabilities
      else return { ok: false, decider: id, reason: 'The frontier answer has neither a choice nor probabilities' }
      return { ok: true, verdict: { decider: answer.model ? `${id}:${answer.model}` : id, probabilities, rationale: answer.rationale, tokens: answer.tokens ?? null, elapsedMs: now() - started } }
    },
  }
}

/** The shape of ApprovalReviewRouting.run's result (approval-review.ts ReviewResult) this adapter reads. */
export interface ApprovalReviewAnswer { decision: 'allow' | 'deny' | 'escalate'; rationale: string; model: string; digest?: string; usage?: unknown }
export type ApprovalReviewRun<Action> = (action: Action, digest: string) => Promise<ApprovalReviewAnswer>

/** Total tokens of a reviewer turn's usage report, when it carries one. */
export function reviewTokens(usage: unknown): number | null {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const report = object(usage), tokens = object(object(report.run).tokens ?? object(report.conversation).tokens)
  const value = (key: string) => typeof tokens[key] === 'number' ? tokens[key] as number : 0
  const total = typeof tokens.totalTokens === 'number' ? tokens.totalTokens : value('inputTokens') + value('outputTokens') + value('cacheCreationTokens') + value('cachedTokens')
  return total > 0 ? total : null
}

/**
 * The approval reviewer as the frontier decider for kind `approval`. `subject` finds the exact
 * action and digest the request stands for (the gate binds them per request); the reviewer's
 * answer must echo that digest when it reports one, as the gate itself requires.
 */
export function approvalReviewFrontier<Action>(run: ApprovalReviewRun<Action>, subject: (request: DecisionRequest) => { action: Action; digest: string } | null | undefined,
  options: Omit<FrontierDeciderOptions, 'kinds'> = {}): Decider {
  return createFrontierDecider({
    async ask(request) {
      const bound = subject(request)
      if (!bound) throw new Error('No reviewable action is bound to this approval decision')
      const result = await run(bound.action, bound.digest)
      if (result.digest !== undefined && result.digest !== bound.digest) throw new Error('The review answered a different action digest')
      if (!['allow', 'deny', 'escalate'].includes(result.decision)) throw new Error(`Unknown review decision ${String(result.decision)}`)
      return { choice: result.decision, rationale: result.rationale, model: result.model, tokens: reviewTokens(result.usage) }
    },
  }, { id: options.id ?? 'approval-reviewer', kinds: ['approval'], ...(options.now ? { now: options.now } : {}) })
}
