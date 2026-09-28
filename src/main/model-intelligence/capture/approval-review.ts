/**
 * A settled approval review (approval-review.ts ReviewRecord) → ExecutionOutcome, category
 * `decision`, attributed to the reviewer model. Pure. Only a record a reviewer turn actually
 * decided counts: session-rule answers, durable-denial fences and wizard answers with no reviewer
 * turn say nothing about a model. A record still waiting (reviewing, or escalated to an owner who
 * has not answered) is not settled yet and maps to null.
 *   - reviewer allowed/denied, nobody overrode it: success;
 *   - reviewer escalated: success when the owner then denied (worth asking), partial when the
 *     owner allowed (an interruption that was not needed);
 *   - the owner or a wizard answered against the reviewer's own decision: failure, ownerCorrected;
 *   - the reviewer turn failed (paused with reviewer evidence): failure.
 */
import type { Json } from '../../../shared/structured-agent'
import type { ExecutionOutcome, ModelKey } from '../../../shared/model-routing'
import type { ReviewPhase, ReviewRecord } from '../../approval-review'
import { clip, outcome, TIMEOUT } from './common'

export interface SettledReview {
  record: ReviewRecord
  /** The reviewer tab's provider; inferred from reviewerModel when absent. */
  reviewerProvider?: string
  /** An override the journal does not carry (e.g. an owner reversal recorded elsewhere). */
  ownerDecision?: 'allow' | 'deny'
  decisionId?: string | null
}

type ReviewerDecision = 'allow' | 'deny' | 'escalate'
const DECIDED: ReadonlySet<ReviewPhase> = new Set(['approved', 'denied', 'owner', 'blocked'])
const NATIVE_BOUNDARY = 'The reviewer cannot approve this native owner boundary'

export function inferReviewerProvider(model: string): string | null {
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) return 'claude'
  if (/gpt|codex|astra|\bo\d/i.test(model)) return 'codex'
  if (/grok/i.test(model)) return 'grok'
  return null
}

const numberAt = (value: Json | undefined, ...keys: string[]): number | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  for (const key of keys) { const found = value[key]; if (typeof found === 'number' && Number.isFinite(found)) return found }
  return null
}

export function captureApprovalReview(settled: SettledReview): ExecutionOutcome | null {
  const { record } = settled
  if (!record.reviewerModel || record.coveredBy) return null
  const provider = settled.reviewerProvider ?? inferReviewerProvider(record.reviewerModel)
  if (!provider) return null
  const key: ModelKey = { provider, model: record.reviewerModel }
  // The reviewer's own transition is the first decided phase in the history that carries its rationale.
  const entry = record.history.find(item => DECIDED.has(item.phase))
  const failed = !entry && record.phase === 'paused'
  if (!entry && !failed) return null
  const decision: ReviewerDecision | null = !entry ? null : entry.phase === 'denied' ? 'deny' : entry.phase === 'owner' ? 'escalate' : entry.phase === 'blocked' && !entry.rationale.startsWith(NATIVE_BOUNDARY) ? null : 'allow'
  if (entry && !decision) return null
  const wizard = record.answeredBy ? /answered (allow|deny|approve|reject|decline|accept)\w*/i.exec(record.rationale)?.[1]?.toLowerCase() : undefined
  const owner = settled.ownerDecision ?? record.ownerAnswer ?? (wizard ? (/^(allow|approve|accept)/.test(wizard) ? 'allow' : 'deny') : undefined)
  if (decision === 'escalate' && !owner) return null
  const corrected = decision !== null && decision !== 'escalate' && owner !== undefined && owner !== decision
  const usage = record.reviewerUsage
  const input = numberAt(usage, 'inputTokens', 'input_tokens'), output = numberAt(usage, 'outputTokens', 'output_tokens')
  return outcome({
    key, source: 'approval-review', ref: record.id, category: 'decision', projectId: record.projectId, agentSessionId: record.reviewerId ?? null, decisionId: settled.decisionId ?? null,
    at: entry?.at ?? record.updatedAt,
    result: failed || corrected ? 'failure' : decision === 'escalate' ? (owner === 'deny' ? 'success' : 'partial') : 'success',
    durationMs: record.reviewerElapsedMs ?? null,
    tokens: numberAt(usage, 'totalTokens', 'total_tokens') ?? (input !== null && output !== null ? input + output : null), costUsd: numberAt(usage, 'costUsd', 'cost_usd'),
    timedOut: failed && TIMEOUT.test(record.rationale), invalidOutput: failed && !TIMEOUT.test(record.rationale),
    escalated: decision === 'escalate', ownerCorrected: corrected,
    ...(failed ? { detail: clip(record.rationale) } : corrected ? { detail: `Reviewer chose ${decision}; ${record.answeredBy ?? 'the owner'} answered ${owner}` } : {}),
  })
}
