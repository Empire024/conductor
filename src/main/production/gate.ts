import {
  CONTROL_RESULT_SEVERITY,
  type ApplicabilityDecision, type AuditRun, type CheckOutcome, type ControlDefinition, type ControlResult, type ControlResultStatus,
  type Finding, type GateState, type HumanReviewItem, type OwnerQuestion, type ReviewAnswerRecord, type TargetFingerprint, type Waiver,
} from '../../shared/production'
import { classifyChange } from './fingerprint'
import { controlsInvalidatedBy } from './registry'

/**
 * The release gate (docs/production-agent.md section 7): pure functions, recomputed from runs,
 * results, findings, waivers and the current fingerprint every time; never stored as truth.
 *
 * Precedence: AUDITING (a run in flight) > NOT_AUDITED (no completed run) > BLOCKED (the newest run
 * ended failed or is blocked for the owner) > STALE (the target moved since the last completed run)
 * > BLOCKED (the last completed run found an unwaived FAIL, even on the first run) > NEEDS_REVIEW
 * > VERIFIED_WITH_WAIVERS > VERIFIED. NOT_AUDITED means no run completed; its reasons name a run
 * that could not complete. `reasons` names every blocker; there is no
 * percentage, and VERIFIED means "passed the configured audit scope at this fingerprint", never a
 * certification.
 */

/** Run statuses that mean "an audit is under way" (a blocked run waits for the owner and is BLOCKED instead). */
export const IN_FLIGHT: readonly AuditRun['status'][] = ['queued', 'running', 'paused', 'recovering']
const UNWAIVED_OPEN: readonly Finding['status'][] = ['open', 'reopened', 'disputed']

const worst = (statuses: readonly ControlResultStatus[]): ControlResultStatus =>
  [...statuses].sort((a, b) => CONTROL_RESULT_SEVERITY[b] - CONTROL_RESULT_SEVERITY[a])[0] ?? 'UNVERIFIED'

/**
 * One control's status from its checks (section 7): worst-of by CONTROL_RESULT_SEVERITY; a
 * not-applicable decision gives NOT_APPLICABLE and an unknown one UNVERIFIED; no checks at all is
 * UNVERIFIED; an exhausted budget is UNVERIFIED, never PASS; `humanReviewAlways` controls cap at
 * NEEDS_HUMAN_REVIEW (a PASS or WARN becomes NEEDS_HUMAN_REVIEW; FAIL and UNVERIFIED stay).
 */
export function controlStatus(definition: Pick<ControlDefinition, 'humanReviewAlways'>, decision: Pick<ApplicabilityDecision, 'status'>, outcomes: readonly Pick<CheckOutcome, 'status'>[], options: { budgetExhausted?: boolean } = {}): ControlResultStatus {
  if (decision.status === 'not-applicable') return 'NOT_APPLICABLE'
  if (decision.status === 'unknown') return 'UNVERIFIED'
  if (!outcomes.length) return 'UNVERIFIED'
  let status = worst(outcomes.map(outcome => outcome.status === 'NOT_APPLICABLE' ? 'PASS' : outcome.status))
  if (outcomes.every(outcome => outcome.status === 'NOT_APPLICABLE')) return 'NOT_APPLICABLE'
  if (options.budgetExhausted && status === 'PASS') status = 'UNVERIFIED'
  if (definition.humanReviewAlways && CONTROL_RESULT_SEVERITY[status] < CONTROL_RESULT_SEVERITY.NEEDS_HUMAN_REVIEW) status = 'NEEDS_HUMAN_REVIEW'
  return status
}

/**
 * The owner's answers laid over a run's results (production.review.answer). An answer counts for
 * the item it answered, and for a later run's item with the same id unless a change between the
 * target it answered and this run's target invalidates the control. Once every item of a control
 * is answered, its NEEDS_HUMAN_REVIEW cap lifts to the worst of its checks (a check's own
 * human-review floor counts as PASS); any `rejected` answer makes the control FAIL instead.
 */
export function applyReviewAnswers(results: readonly ControlResult[], answers: readonly ReviewAnswerRecord[], runFingerprint: TargetFingerprint | null): ControlResult[] {
  if (!answers.length) return [...results]
  const byItem = new Map(answers.map(answer => [answer.itemId, answer]))
  return results.map(result => {
    if (!result.humanReview.length) return result
    const holds = (answer: ReviewAnswerRecord): boolean => answer.runId === result.runId || !runFingerprint
      || !controlsInvalidatedBy(classifyChange(answer.fingerprint, runFingerprint)).includes(result.controlId)
    const items: HumanReviewItem[] = result.humanReview.map(item => {
      const answer = byItem.get(item.id)
      return answer && answer.controlId === result.controlId && holds(answer) ? { ...item, answer: answer.answer, note: answer.note, answeredBy: answer.answeredBy, answeredAt: answer.answeredAt } : item
    })
    const decorated = { ...result, humanReview: items }
    if (items.some(item => !item.answer) || result.status === 'NOT_APPLICABLE' || result.status === 'UNVERIFIED') return decorated
    const rejected = items.filter(item => item.answer === 'rejected')
    if (rejected.length) {
      return { ...decorated, status: 'FAIL' as const, rationale: `${result.rationale}\nRejected on human review: ${rejected.map(item => `${item.question}${item.note ? ` (${item.note})` : ''}`).join('; ')}`.slice(0, 8_000) }
    }
    if (result.status !== 'NEEDS_HUMAN_REVIEW') return decorated
    const lifted = worst(result.checks.map(check => check.status === 'NEEDS_HUMAN_REVIEW' || check.status === 'NOT_APPLICABLE' ? 'PASS' : check.status).concat(['PASS']))
    return { ...decorated, status: lifted, rationale: `${result.rationale}\nEvery human-review item was confirmed (${[...new Set(items.map(item => item.answeredBy))].join(', ')}).`.slice(0, 8_000) }
  })
}

export interface GateInput {
  projectId: string
  environmentId: string | null
  /** Newest runs of the environment, newest first (a handful is enough). */
  runs: readonly AuditRun[]
  /** Results of the last completed run. */
  results: readonly ControlResult[]
  /** Findings of the environment (open ones at least). */
  findings: readonly Finding[]
  /** Waivers of the project (active and expired; revoked ones are ignored). */
  waivers: readonly Waiver[]
  questions: readonly OwnerQuestion[]
  /** The target as it is now (drift/change detection or a cheap recompute); null when unknown. */
  currentFingerprint: TargetFingerprint | null
  now: Date
}

export function computeGate(input: GateInput): GateState {
  const at = input.now.toISOString()
  const base = (state: GateState['state'], reasons: string[], extra: Partial<GateState> = {}): GateState => ({
    projectId: input.projectId, environmentId: input.environmentId, state, reasons, runId: null, fingerprint: null, staleControls: [],
    openCriticalOrHigh: 0, unverifiedControls: [], humanReviewPending: 0, openQuestions: input.questions.filter(question => question.status === 'open').length,
    activeWaivers: 0, results: [], computedAt: at, ...extra,
  })
  if (!input.environmentId) return base('NOT_AUDITED', ['No environment is designated for production audits.'])

  const active = input.runs.find(run => IN_FLIGHT.includes(run.status))
  if (active) return base('AUDITING', [`Run ${active.id} (${active.kind}) is ${active.status}.`], { runId: active.id, fingerprint: active.fingerprint })

  const completed = input.runs.find(run => run.status === 'completed')
  const newest = input.runs.find(run => run.status !== 'cancelled')
  const failedLast = newest && (newest.status === 'failed' || newest.status === 'blocked') ? newest : null
  if (!completed) {
    const reasons = ['No audit of this environment has completed yet.']
    if (failedLast) reasons.push(`The last run ${failedLast.id} ${failedLast.status === 'blocked' ? 'is blocked' : 'failed'}: ${failedLast.statusReason ?? 'no reason recorded'}`)
    return base('NOT_AUDITED', reasons, failedLast ? { runId: failedLast.id } : {})
  }
  if (failedLast && failedLast.createdAt > completed.createdAt) {
    return base('BLOCKED', [`Run ${failedLast.id} ${failedLast.status === 'blocked' ? 'is blocked' : 'failed'}: ${failedLast.statusReason ?? 'no reason recorded'}`], { runId: failedLast.id, fingerprint: completed.fingerprint })
  }

  // Everything below reads the last completed run.
  const liveWaiver = (finding: Finding): Waiver | undefined => input.waivers.find(waiver => waiver.findingId === finding.id && !waiver.revokedAt && Date.parse(waiver.expiresAt) > input.now.getTime())
  const expiredWaiver = (finding: Finding): Waiver | undefined => finding.status === 'waived'
    ? input.waivers.find(waiver => waiver.id === finding.waiverId && !waiver.revokedAt && Date.parse(waiver.expiresAt) <= input.now.getTime())
    : undefined
  const results = input.results.map(result => ({ controlId: result.controlId, status: result.status }))
  const openBlocking = input.findings.filter(finding => (UNWAIVED_OPEN.includes(finding.status) || (finding.status === 'waived' && !liveWaiver(finding))))
  const openCriticalOrHigh = openBlocking.filter(finding => finding.severity === 'critical' || finding.severity === 'high').length
  const unverifiedControls = input.results.filter(result => result.status === 'UNVERIFIED').map(result => result.controlId)
  const humanReviewPending = input.results.reduce((sum, result) => sum + (result.status === 'NOT_APPLICABLE' ? 0 : result.humanReview.filter(item => !item.answer).length), 0)
  const activeWaivers = input.waivers.filter(waiver => !waiver.revokedAt && Date.parse(waiver.expiresAt) > input.now.getTime()).length
  const common: Partial<GateState> = { runId: completed.id, fingerprint: completed.fingerprint, openCriticalOrHigh, unverifiedControls, humanReviewPending, activeWaivers, results }

  if (input.currentFingerprint) {
    const changes = classifyChange(completed.fingerprint, input.currentFingerprint)
    if (changes.length) {
      const invalidated = new Set(controlsInvalidatedBy(changes))
      const audited = input.results.length ? input.results.map(result => result.controlId) : completed.controls
      const staleControls = audited.filter(controlId => invalidated.has(controlId))
      return base('STALE', [`The target changed since run ${completed.id} (${changes.join(', ')}); ${staleControls.length ? `results of ${staleControls.join(', ')} no longer hold` : 'no audited control is affected, but the fingerprint moved'}.`], { ...common, staleControls: staleControls.length ? staleControls : [...audited] })
    }
  }

  const reasons: string[] = []
  const confirmed = openBlocking.filter(finding => (finding.severity === 'critical' || finding.severity === 'high') && finding.confidence === 'confirmed')
  if (confirmed.length) reasons.push(`${confirmed.length} open confirmed critical/high finding(s): ${confirmed.slice(0, 5).map(finding => `${finding.controlId} ${finding.title}`).join('; ')}${confirmed.length > 5 ? '; …' : ''}`)
  for (const result of input.results) {
    if (result.status === 'UNVERIFIED') reasons.push(`${result.controlId} could not be verified: ${firstLine(result.rationale)}`)
    else if (result.status === 'NEEDS_HUMAN_REVIEW') {
      const open = result.humanReview.filter(item => !item.answer).length
      reasons.push(`${result.controlId} needs human review (${open === result.humanReview.length ? `${open} item(s)` : `${open} of ${result.humanReview.length} item(s) unanswered`}).`)
    }
  }
  const blockingQuestions = input.questions.filter(question => question.status === 'open' && question.blocksControls.length)
  for (const question of blockingQuestions) reasons.push(`Owner question open (blocks ${question.blocksControls.join(', ')}): ${question.question}`)
  const expired = input.findings.filter(finding => expiredWaiver(finding))
  for (const finding of expired) reasons.push(`The waiver of ${finding.controlId} "${finding.title}" expired.`)
  // A FAIL or WARN control passes only when every one of its findings is covered by a live waiver.
  // A completed run that found an unwaived FAIL blocks the gate, even on the first run.
  let failing = 0
  for (const result of input.results) {
    if (result.status !== 'FAIL' && result.status !== 'WARN') continue
    const mine = input.findings.filter(finding => finding.controlId === result.controlId && finding.status !== 'fixed')
    const unwaived = mine.filter(finding => !(finding.status === 'waived' && liveWaiver(finding)))
    if (unwaived.length) reasons.push(`${result.controlId} is ${result.status} with ${unwaived.length} unwaived finding(s): ${unwaived.slice(0, 3).map(finding => finding.title).join('; ')}`)
    else if (!mine.length) reasons.push(`${result.controlId} is ${result.status}: ${firstLine(result.rationale)}`)
    if (result.status === 'FAIL' && (unwaived.length || !mine.length)) failing++
  }
  if (failing) return base('BLOCKED', reasons, common)
  if (reasons.length) return base('NEEDS_REVIEW', reasons, common)
  const waivedControls = input.results.filter(result => result.status === 'FAIL' || result.status === 'WARN')
  if (waivedControls.length) return base('VERIFIED_WITH_WAIVERS', waivedControls.map(result => `${result.controlId} is ${result.status}; every finding is covered by a live waiver.`), common)
  return base('VERIFIED', [], common)
}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 300)

/** The one-line wording the panel and the report use for a gate; never a percentage or a certification. */
export function gateSummary(gate: Pick<GateState, 'state' | 'fingerprint'>): string {
  const at = gate.fingerprint ? `${gate.fingerprint.commit ? `commit ${gate.fingerprint.commit.slice(0, 12)}` : 'the recorded target'}${gate.fingerprint.build ? `, build ${gate.fingerprint.build}` : ''}` : 'no recorded target'
  switch (gate.state) {
    case 'VERIFIED': return `Passed the configured audit scope at ${at}.`
    case 'VERIFIED_WITH_WAIVERS': return `Passed the configured audit scope at ${at}, with waivers.`
    case 'NEEDS_REVIEW': return `Needs review at ${at}.`
    case 'STALE': return `Results are stale: the target changed after ${at}.`
    case 'BLOCKED': return `Blocked at ${at}: a failure was found or the last audit could not finish.`
    case 'AUDITING': return 'An audit is running.'
    case 'NOT_AUDITED': return 'Not audited yet.'
  }
}
