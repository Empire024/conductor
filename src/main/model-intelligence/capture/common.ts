/** Shared by the capture mappers: deterministic outcome ids and a zeroed outcome to spread over. */
import { createHash } from 'node:crypto'
import { modelKeyId, type ExecutionOutcome, type ModelKey, type OutcomeSource } from '../../../shared/model-routing'

/** Hash of source + ref + key, so recording the same execution twice is idempotent. */
export const outcomeId = (source: OutcomeSource, ref: string, key: ModelKey): string =>
  'out_' + createHash('sha256').update(`${source}\n${ref}\n${modelKeyId(key)}`).digest('hex').slice(0, 32)

export type OutcomeInit = Pick<ExecutionOutcome, 'key' | 'source' | 'ref' | 'category' | 'at' | 'result'> & Partial<ExecutionOutcome>

export function outcome(init: OutcomeInit): ExecutionOutcome {
  return {
    effort: null, complexity: null, projectId: null, agentSessionId: null, decisionId: null, verifier: 'none',
    durationMs: null, tokens: null, costUsd: null, retries: 0, iterations: null, toolFailures: 0,
    contextFailure: false, looped: false, timedOut: false, overBudget: false, invalidOutput: false, falseCompletion: false,
    escalated: false, repairedBy: null, ownerCorrected: false,
    ...init,
    id: outcomeId(init.source, init.ref, init.key),
  }
}

/** Local model ids arrive both bare and as their models.list id; the registry form keeps `local/<id>` as the model. */
export const localKey = (model: string): ModelKey => ({ provider: 'local', model: model.startsWith('local/') ? model : `local/${model}` })
export const TIMEOUT = /\btim(ed|e)[ -]?out\b|\btimeout\b|deadline exceeded/i
export const CONTEXT_FAILURE = /context (window|length|limit)|prompt is too long|maximum context|too many tokens|exceeds? the (model'?s? )?context/i
export const clip = (text: string, max = 300): string => text.length > max ? text.slice(0, max - 1) + '…' : text
