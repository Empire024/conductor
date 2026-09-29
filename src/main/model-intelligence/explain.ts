import type { DecisionRecord, ModelKey, RouteDecision } from '../../shared/model-routing'

type RouteTarget = NonNullable<RouteDecision['fallback']>

/** The text block decisions.get and the Settings inspector show (docs/model-routing.md, explain.ts). */

const RATIONALE_MAX = 300
const via = (target: { key: ModelKey; effort: string | null }) => `${target.key.model} via ${target.key.provider}${target.effort ? ` (effort ${target.effort})` : ''}`
const target = (label: string, value: RouteTarget | null | undefined) => `${label}: ${value ? via(value) + (value.reason ? ` — ${value.reason}` : '') : 'none'}`
const short = (text: string) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > RATIONALE_MAX ? line.slice(0, RATIONALE_MAX - 3) + '...' : line }
/** Lead of the top probability over the runner-up. */
export function marginOf(probabilities: Record<string, number>): number {
  const [first = 0, second = 0] = Object.values(probabilities).sort((a, b) => b - a)
  return first - second
}

export function explainRoute(decision: RouteDecision): string {
  return [
    `Selected: ${via(decision.selected)}`,
    'Reasons:', ...decision.reasons.map(reason => `- ${reason}`),
    target('Fallback', decision.fallback),
    target('Escalation', decision.escalation),
    `Confidence ${decision.confidence.toFixed(2)} (margin ${marginOf(decision.probabilities).toFixed(2)}), decided by ${decision.decidedBy}${decision.escalated ? ' after escalation' : ''}`,
  ].join('\n')
}

export function explainDecision(record: DecisionRecord): string {
  const labelOf = (id: string) => record.options.find(option => option.id === id)?.label ?? id
  const spread = (probabilities: Record<string, number>) => Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, p]) => `${id} ${p.toFixed(2)}`).join(', ')
  return [
    `Decision (${record.kind}, asked by ${record.requester} at ${record.at}): ${record.question}`,
    record.choice === null ? 'Choice: none; the caller kept its previous behaviour' : `Choice: ${labelOf(record.choice)}${labelOf(record.choice) === record.choice ? '' : ` (${record.choice})`}`,
    `Confidence ${record.confidence.toFixed(2)} (margin ${record.margin.toFixed(2)}), decided by ${record.decidedBy}`,
    `Escalated: ${record.escalated ? record.escalationReason ?? 'yes' : record.escalationReason ? `no (${record.escalationReason})` : 'no'}`,
    ...(record.systemOne ? [`System-one: ${record.systemOne.decider} ${record.systemOne.choice === null ? `gave no choice (${short(record.systemOne.failed ?? 'failed')})` : `chose ${labelOf(record.systemOne.choice)} at ${record.systemOne.confidence.toFixed(2)}`}`] : []),
    ...(record.shadow ? [`Shadow (${record.shadow.decider}, journaled only): ${record.shadow.choice === null ? `no choice (${short(record.shadow.failed ?? 'failed')})` : `${labelOf(record.shadow.choice)} at ${record.shadow.confidence.toFixed(2)}${record.choice !== null ? record.shadow.choice === record.choice ? ', agrees' : ', disagrees' : ''}; ${record.shadow.elapsedMs} ms`}`] : []),
    ...(record.route ? [
      `Selected: ${via(record.route.selected)}`, target('Fallback', record.route.fallback), target('Escalation', record.route.escalation),
      'Reasons:', ...record.route.reasons.map(reason => `- ${reason}`),
      ...(record.route.closeCandidates?.length ? [`Close call between: ${record.route.closeCandidates.map(entry => `${entry.id} ${entry.probability.toFixed(2)} (rank ${entry.capabilityRank})`).join(', ')}`] : []),
      ...(record.route.attempts ?? []).map(attempt => `Attempt: ${attempt.key.model} via ${attempt.key.provider} ${attempt.ok ? 'opened' : `failed (${short(attempt.error ?? 'unknown')})`} at ${attempt.at}`),
    ] : []),
    'Verdicts:', ...record.verdicts.map(verdict => 'failed' in verdict ? `- ${verdict.decider}: failed (${short(verdict.failed)})`
      : `- ${verdict.decider}: ${spread(verdict.probabilities)}; ${verdict.elapsedMs} ms${verdict.tokens ? `, ${verdict.tokens} tokens` : ''}${verdict.rationale ? ` — ${short(verdict.rationale)}` : ''}`),
    `Rationale: ${short(record.rationale)}`,
    `Outcome: ${record.outcome ? `${record.outcome.result}${record.outcome.answer ? `, the owner answered ${record.outcome.answer}` : ''} at ${record.outcome.at}${record.outcome.detail ? ` (${short(record.outcome.detail)})` : ''}` : 'not recorded yet'}`,
  ].join('\n')
}
