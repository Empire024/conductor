/**
 * A structured turn settled (completed / failed / interrupted) → ExecutionOutcome. Pure: the
 * caller (module E, beside StructuredSessions' session-phase handling) passes the conversation's
 * timeline items, and this reads the turn's own items the way usage-accounting already does.
 * Only turns with a category signal count: a routed or dispatched task (features, category or a
 * decision id), or a prompt categorize() can label as something other than general.
 */
import type { TaskCategory, TaskFeatures, ExecutionOutcome } from '../../../shared/model-routing'
import { PROVIDER_SAFEGUARD_REFUSAL, type SessionPhase, type TimelineItem } from '../../../shared/structured-agent'
import { processedTokens, summarizeUsage, summarizeUsageRun } from '../../../shared/usage-accounting'
import { categorize } from '../categorize'
import { clip, CONTEXT_FAILURE, outcome, TIMEOUT } from './common'

export interface SettledTurn {
  agentSessionId: string
  projectId?: string | null
  turnId: string
  /** Limits the turn to one provider process when turn ids could repeat across resumes. */
  runtimeId?: string
  phase: SessionPhase
  /** The conversation's timeline (SessionProjection.items); the turn's items are selected here. */
  items: TimelineItem[]
  /** Overrides for what the session items report (capabilities.effectiveSettings, settings). */
  provider?: string
  model?: string
  effort?: string | null
  prompt?: string
  features?: TaskFeatures
  category?: TaskCategory
  decisionId?: string | null
  /** Set when the turn ended only because a provider usage window closed (live.limitResumeAt). */
  limited?: boolean
  /** A check of the turn's work (a test run, a grader, the owner): without one a completed turn is completed-unverified. */
  verifier?: 'pass' | 'fail'
  /** Overrides the retries read from the turn's own error items. */
  retries?: number
  at?: string
}

const SETTLED: ReadonlySet<SessionPhase> = new Set(['completed', 'failed', 'interrupted'])
const USAGE_LIMIT = /usage limit|rate limit|quota|limit (reached|resets)|hit your limit/i

export function captureTurn(turn: SettledTurn): ExecutionOutcome | null {
  if (!SETTLED.has(turn.phase)) return null
  const own = turn.items.filter(item => item.turnId === turn.turnId && (!turn.runtimeId || item.runtimeId === turn.runtimeId))
  const root = own.filter(item => !item.parentId)
  const run = summarizeUsageRun(turn.items, turn.runtimeId)
  const provider = turn.provider ?? run.provider, model = turn.model ?? run.model
  if (!provider || !model) return null
  const first = Math.min(...own.map(item => item.sequence))
  const userText = (item: TimelineItem) => item.data.type === 'text' && item.data.role === 'user' ? item.data : undefined
  const user = root.map(userText).find(Boolean) ?? turn.items.filter(item => !item.parentId && item.sequence < first).map(userText).filter(Boolean).at(-1)
  const prompt = turn.prompt ?? user?.text ?? ''
  const tools = root.flatMap(item => item.data.type === 'tool' ? [item.data.name] : [])
  const labelled = turn.features ?? (turn.category ? { ...categorize({ prompt, tools }), category: turn.category } : undefined)
  const features = labelled ?? categorize({ prompt, tools, attachments: user?.attachments })
  if (!labelled && !turn.decisionId && features.category === 'general') return null
  const errors = root.flatMap(item => item.data.type === 'error' ? [item.data] : [])
  const messages = errors.map(error => error.message).join('\n')
  const limited = turn.limited || (turn.phase === 'failed' && USAGE_LIMIT.test(messages))
  const usage = summarizeUsage(own)
  const stamps = own.map(item => Date.parse(item.timestamp)).filter(Number.isFinite)
  const refusal = errors.some(error => error.code === PROVIDER_SAFEGUARD_REFUSAL)
  return outcome({
    key: { provider, model }, effort: turn.effort ?? run.effort ?? null, source: 'turn', ref: `${turn.agentSessionId}:${turn.turnId}`,
    category: features.category, complexity: features.complexity, projectId: turn.projectId ?? null, agentSessionId: turn.agentSessionId, decisionId: turn.decisionId ?? null,
    at: turn.at ?? own.at(-1)?.timestamp ?? new Date().toISOString(),
    // A closed usage window says nothing about the model's work; neither does the owner's stop.
    result: turn.phase === 'completed' ? turn.verifier === 'pass' ? 'success' : turn.verifier === 'fail' ? 'failure' : 'completed-unverified' : turn.phase === 'interrupted' || limited ? 'cancelled' : 'failure',
    verifier: turn.verifier ?? 'none',
    durationMs: stamps.length ? Math.max(...stamps) - Math.min(...stamps) : null,
    tokens: processedTokens(usage.tokens) ?? usage.tokens?.totalTokens ?? null, costUsd: usage.costUsd ?? null,
    // A provider error inside a turn that went on was retried (Codex reports willRetry errors this way); a failed turn's last error ended it.
    retries: turn.retries ?? Math.max(0, errors.length - (turn.phase === 'completed' ? 0 : 1)),
    toolFailures: root.filter(item => item.data.type === 'tool' && item.data.status === 'failed').length,
    contextFailure: CONTEXT_FAILURE.test(messages), timedOut: TIMEOUT.test(messages), overBudget: limited,
    ...(errors.length ? { detail: clip(refusal ? `Provider safeguard refusal: ${messages}` : messages) } : {}),
  })
}
