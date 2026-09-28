// Stage-aware audit of durable-job attempt accounting from the job's own event ledger
// (docs/verification/2026-09-28-local-safety-review.md, "Stage-aware credit assertion").
//
// The controller (src/main/durable-jobs/controller.ts) writes, per stage and attempt:
//   start      kind 'stage',  data {stageId, attempt}
//   notice     kind 'retry',  data {stageId}                 "Interrupting stage N: ..." (not an attempt)
//   outcome    kind 'retry',  data {stageId, attempt, error, attemptCredited?}
//   completion kind 'stage',  data {stageId, filesChanged, ...} (no attempt)
//   block      kind 'transition', data {to: 'blocked'} - it names no stage, so the blocked stage
//              comes from structured job state (jobs.status currentStage.id), never from a message.
//
// For a stage, A = distinct finished failed attempts and C = the credited subset; charged = A - C.
// A budget block with charged < budget is a candidate accounting violation; a block after that many
// genuinely charged failures is valid even when earlier attempts were credited. Anything the ledger
// cannot prove - an incomplete capture, a gap, conflicting outcomes, an unknown blocked stage, an
// owner resume that granted new attempts - is inconclusive (or excluded), never "no violation".

const BUDGET_BLOCK = /used all (\d+) attempts/

const eventKey = event => event?.id ?? (Number.isFinite(event?.seq) ? `seq:${event.seq}` : null)
const same = (a, b) => JSON.stringify({ kind: a.kind, message: a.message, data: a.data ?? null }) === JSON.stringify({ kind: b.kind, message: b.message, data: b.data ?? null })

/**
 * One job. `events`: the job's events as captured (any order, duplicates allowed); `complete`: the
 * caller proved the capture holds every event (paged to the end, starting at creation); `status`,
 * `statusReason` and `blockedStageId` come from structured job status at settlement.
 * Returns {verdict: 'ok'|'violation'|'inconclusive'|'excluded', reasons, stages, violations,
 * creditedTransitions, creditedFollowed}.
 */
export function auditJobAttempts({ events, complete, status, statusReason = '', blockedStageId = null, maxStageAttempts = 3 }) {
  const reasons = []
  const unique = new Map()
  let conflicts = 0
  for (const event of Array.isArray(events) ? events : []) {
    const key = eventKey(event)
    if (!key) { reasons.push('an event without id or sequence'); conflicts++; continue }
    const seen = unique.get(key)
    if (seen && !same(seen, event)) { reasons.push(`event ${key} captured twice with different content`); conflicts++ }
    else if (!seen) unique.set(key, event)
  }
  // Sequence numbers order the ledger when every event carries one; otherwise the capture order
  // (jobs.events pages oldest first) is kept, never re-sorted by millisecond timestamps.
  const captured = [...unique.values()]
  const ordered = captured.every(event => Number.isFinite(event.seq)) ? captured.sort((a, b) => a.seq - b.seq) : captured
  if (complete !== true) reasons.push('the event capture is not proven complete')
  if (!ordered.some(event => event.kind === 'transition' && event.data?.to === 'queued') && complete === true) reasons.push('the capture does not start at job creation')

  const stages = new Map()
  const stageOf = id => { if (!stages.has(id)) stages.set(id, { stageId: id, starts: new Map(), outcomes: new Map(), completed: false, conflicts: [], order: [] }); return stages.get(id) }
  let grants = 0
  for (const event of ordered) {
    const data = event.data ?? {}
    if (event.kind === 'transition' && data.to === 'running' && data.from === 'blocked') grants++
    if (typeof data.stageId !== 'string') continue
    const stage = stageOf(data.stageId)
    if (event.kind === 'stage' && Number.isInteger(data.attempt)) {
      if (stage.starts.has(data.attempt)) stage.conflicts.push(`attempt ${data.attempt} started twice`)
      else { stage.starts.set(data.attempt, event); stage.order.push({ type: 'start', attempt: data.attempt }) }
    } else if (event.kind === 'stage' && Array.isArray(data.filesChanged)) {
      stage.completed = true
      stage.order.push({ type: 'completed' })
    } else if (event.kind === 'retry' && Number.isInteger(data.attempt)) {
      if (stage.outcomes.has(data.attempt)) stage.conflicts.push(`attempt ${data.attempt} has two outcomes`)
      else { stage.outcomes.set(data.attempt, { credited: data.attemptCredited === true, event }); stage.order.push({ type: 'outcome', attempt: data.attempt, credited: data.attemptCredited === true }) }
    }
    // A retry event without an attempt is the "Interrupting stage" notice: not an attempt.
  }

  const ledger = []
  let creditedTransitions = 0, creditedFollowed = 0
  for (const stage of stages.values()) {
    const gaps = [...stage.conflicts]
    const attempts = [...stage.starts.keys()].sort((a, b) => a - b)
    attempts.forEach((attempt, index) => { if (attempt !== index + 1) gaps.push(`attempt numbers are not contiguous (${attempts.join(', ')})`) })
    for (const attempt of stage.outcomes.keys()) if (!stage.starts.has(attempt)) gaps.push(`attempt ${attempt} has an outcome but no start`)
    // Every attempt but the stage's last must have ended in an outcome; the last one may instead
    // have completed the stage or still be running when the job settled.
    for (const attempt of attempts.slice(0, -1)) if (!stage.outcomes.has(attempt)) gaps.push(`attempt ${attempt} has no outcome although a later attempt started`)
    const outcomes = [...stage.outcomes.values()]
    const finished = outcomes.length, credited = outcomes.filter(entry => entry.credited).length
    // A credit is exercised when the same stage went on afterwards: another start or completion.
    stage.order.forEach((step, index) => {
      if (step.type !== 'outcome' || !step.credited) return
      creditedTransitions++
      if (stage.order.slice(index + 1).some(next => next.type === 'start' || next.type === 'completed')) creditedFollowed++
    })
    ledger.push({ stageId: stage.stageId, starts: attempts.length, finishedFailed: finished, credited, charged: finished - credited, completed: stage.completed, gaps: [...new Set(gaps)] })
  }

  // A candidate violation is computed on its own, but only declared once the evidence behind it is
  // proven: every uncertainty below comes first and makes the job inconclusive, an owner grant of
  // new attempts makes it excluded, and only a complete, consistent, grant-free ledger can violate.
  const candidates = []
  const budgetMatch = status === 'blocked' ? BUDGET_BLOCK.exec(statusReason ?? '') : null
  if (budgetMatch) {
    const budget = Number(budgetMatch[1])
    if (budget !== maxStageAttempts) reasons.push(`blocked on a ${budget}-attempt budget, expected ${maxStageAttempts}`)
    const stage = ledger.find(entry => entry.stageId === blockedStageId)
    if (!blockedStageId || !stage) reasons.push('the blocked stage is not identified by structured state or has no ledger')
    else {
      if (stage.gaps.length) reasons.push(`blocked stage ledger is inconsistent: ${stage.gaps.join('; ')}`)
      // A budget block follows a failed attempt: its last start must have that failed outcome.
      if (stage.starts !== stage.finishedFailed) reasons.push(`blocked stage's last attempt (${stage.starts}) has no failed outcome recorded`)
      if (stage.charged < budget) candidates.push({ stageId: stage.stageId, charged: stage.charged, credited: stage.credited, finishedFailed: stage.finishedFailed, budget })
    }
  }
  for (const stage of ledger) if (stage.gaps.length && stage.stageId !== blockedStageId) reasons.push(`stage ${stage.stageId}: ${stage.gaps.join('; ')}`)
  if (conflicts) reasons.push(`${conflicts} conflicting event capture(s)`)

  const unproven = complete !== true || conflicts > 0 || reasons.length > 0
  const verdict = unproven ? 'inconclusive' : grants ? 'excluded' : candidates.length ? 'violation' : 'ok'
  if (grants) reasons.push(`${grants} owner resume(s) granted new attempts; budget accounting excluded`)
  return { verdict, reasons: [...new Set(reasons)], stages: ledger, violations: verdict === 'violation' ? candidates : [], unprovenCandidates: verdict === 'violation' ? [] : candidates, creditedTransitions, creditedFollowed }
}

/** Whether a durable-job acceptance run (fault run or its matching uninterrupted control) proved
 *  what it set out to: the same job, completed, with output that matches the fixture's truth. A
 *  report for blocked or cancelled work is not acceptance. `problems`: the fixture check's list, or
 *  null when it could not run. Returns the failures; empty means accepted. */
export function acceptanceFailures({ jobId, final, problems }) {
  const failures = []
  if (!final || (final.id !== undefined && final.id !== jobId)) failures.push(`the run settled job ${final?.id ?? 'none'}, not ${jobId}`)
  if (final?.status !== 'completed') failures.push(`the job ended ${final?.status ?? 'unknown'}${final?.statusReason ? `: ${final.statusReason}` : ''}`)
  if (!Array.isArray(problems)) failures.push('the output was not checked against the fixture')
  else if (problems.length) failures.push(`wrong output: ${problems.join('; ')}`)
  return failures
}

/** A whole soak: per-job audits folded into one verdict. Any violation fails; any inconclusive or
 *  excluded job leaves the credit-accounting must-have UNVERIFIED; and zero credited rollovers that
 *  went on to another attempt or completion is NOT EXERCISED, which is also UNVERIFIED - never a
 *  PASS - whatever else held. `reasons` says which. */
export function auditSoak(jobs) {
  const perJob = jobs.map(job => ({ iteration: job.iteration, jobId: job.jobId, ...auditJobAttempts(job) }))
  const violations = perJob.filter(job => job.verdict === 'violation')
  const unproven = perJob.filter(job => job.verdict === 'inconclusive' || job.verdict === 'excluded')
  const creditedFollowed = perJob.reduce((sum, job) => sum + job.creditedFollowed, 0)
  const reasons = [
    ...(!perJob.length ? ['no audited jobs'] : []),
    ...(unproven.length ? [`${unproven.length} job(s) with unproven attempt accounting`] : []),
    ...(creditedFollowed === 0 ? ['credited rollover NOT EXERCISED: no credited attempt went on to another attempt or completion'] : [])
  ]
  return {
    verdict: violations.length ? 'FAIL' : reasons.length ? 'UNVERIFIED' : 'PASS',
    reasons,
    credited: creditedFollowed > 0 ? 'EXERCISED' : 'NOT EXERCISED',
    creditedTransitions: perJob.reduce((sum, job) => sum + job.creditedTransitions, 0),
    creditedFollowed,
    violations: violations.map(job => ({ iteration: job.iteration, jobId: job.jobId, violations: job.violations })),
    unproven: unproven.map(job => ({ iteration: job.iteration, jobId: job.jobId, verdict: job.verdict, reasons: job.reasons })),
    perJob
  }
}
