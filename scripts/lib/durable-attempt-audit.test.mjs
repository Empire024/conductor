import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceFailures, auditJobAttempts, auditSoak } from './durable-attempt-audit.mjs'

// Ledger builder in the controller's own event shapes (src/main/durable-jobs/controller.ts).
let seq = 0
const created = () => ({ seq: ++seq, id: `e${seq}`, kind: 'transition', message: 'Created as queued', data: { to: 'queued' } })
const start = (stageId, attempt) => ({ seq: ++seq, id: `e${seq}`, kind: 'stage', message: `attempt ${attempt} started`, data: { stageId, attempt } })
const notice = stageId => ({ seq: ++seq, id: `e${seq}`, kind: 'retry', message: 'Interrupting stage', data: { stageId } })
const outcome = (stageId, attempt, credited = false) => ({ seq: ++seq, id: `e${seq}`, kind: 'retry', message: `attempt ${attempt} did not finish`, data: { stageId, attempt, error: 'Watchdog: context rollover', ...(credited ? { attemptCredited: true } : {}) } })
const done = stageId => ({ seq: ++seq, id: `e${seq}`, kind: 'stage', message: 'completed', data: { stageId, filesChanged: ['notes/a.md'] } })
const blocked = () => ({ seq: ++seq, id: `e${seq}`, kind: 'transition', message: 'running -> blocked', data: { from: 'running', to: 'blocked' } })
const failedAttempt = (stageId, attempt, credited) => [start(stageId, attempt), notice(stageId), outcome(stageId, attempt, credited)]
const REASON = 'Stage 2 "Write notes for gamma and delta" used all 3 attempts. Last error: Watchdog: context rollover'
const blockedJob = (events, stageId) => ({ events, complete: true, status: 'blocked', statusReason: REASON, blockedStageId: stageId })
/** What smoke-durable-jobs.mjs asserted before this repair: any credited retry anywhere in a job
 *  that then blocked on its budget. Kept here only to show the retained shapes it misjudged. */
const legacyFlags = job => job.status === 'blocked' && /used all \d+ attempts/.test(job.statusReason) && job.events.some(event => event.kind === 'retry' && event.data?.attemptCredited)

// ---- Retained evidence, artifacts/verification/2026-09-27-acceptance-immediate/soak-1790537263682
// (controller-soak-db-judgment-evidence.json). Only the credited event and the block were retained
// for iterations 27/69/70: the ids and stage ids below are the real ones, verbatim.
const RETAINED = {
  27: { credit: { seq: 554, id: 'jobevt_mukbnqcc_2zskv23', kind: 'retry', message: 'Stage 1 attempt 3 did not finish: ... (context rollover with progress; attempt not spent)', data: { stageId: 'jobstage_mukbhtd3_e1793nf', attempt: 3, stop: 'interrupted', promptTokens: 13454, attemptCredited: true } }, block: { seq: 572, id: 'jobevt_mukbud59_uvfelg0', kind: 'transition', message: 'running -> blocked', data: { from: 'running', to: 'blocked' } } },
  69: { credit: { seq: 1419, id: 'jobevt_mukhdwth_4x6tygl', kind: 'retry', message: 'Stage 1 attempt 1 did not finish: ... (context rollover with progress; attempt not spent)', data: { stageId: 'jobstage_mukhbx8w_4on4pnj', attempt: 1, stop: 'interrupted', promptTokens: 15509, attemptCredited: true } }, block: { seq: 1436, id: 'jobevt_mukhjquk_9ovfy5j', kind: 'transition', message: 'running -> blocked', data: { from: 'running', to: 'blocked' } } },
  70: { credit: { seq: 1451, id: 'jobevt_mukhnqd7_83op9oq', kind: 'retry', message: 'Stage 1 attempt 2 did not finish: ... (context rollover with progress; attempt not spent)', data: { stageId: 'jobstage_mukhjs9p_4e00v5m', attempt: 2, stop: 'interrupted', promptTokens: 16106, attemptCredited: true } }, block: { seq: 1468, id: 'jobevt_mukhv1q8_7kuheeb', kind: 'transition', message: 'running -> blocked', data: { from: 'running', to: 'blocked' } } }
}

for (const [iteration, { credit, block }] of Object.entries(RETAINED)) {
  test(`retained iteration ${iteration}: the stage-1 credit is not a stage-2 violation (fragment alone is inconclusive, never a violation)`, () => {
    const fragment = { events: [credit, block], complete: false, status: 'blocked', statusReason: REASON, blockedStageId: null }
    assert.equal(legacyFlags(fragment), true, 'the old assertion flagged this shape')
    const result = auditJobAttempts(fragment)
    assert.equal(result.verdict, 'inconclusive')
    assert.deepEqual(result.violations, [])
  })

  test(`retained iteration ${iteration}: its cross-stage shape, completed as a full ledger, is valid`, () => {
    const stage1 = credit.data.stageId, stage2 = `synthetic_stage2_${iteration}`
    const creditedAttempt = credit.data.attempt
    const events = [created()]
    for (let attempt = 1; attempt < creditedAttempt; attempt++) events.push(...failedAttempt(stage1, attempt, false))
    events.push(start(stage1, creditedAttempt), notice(stage1), { ...credit, seq: ++seq })
    events.push(start(stage1, creditedAttempt + 1), done(stage1))
    for (let attempt = 1; attempt <= 3; attempt++) events.push(...failedAttempt(stage2, attempt, false))
    events.push({ ...block, seq: ++seq })
    const job = blockedJob(events, stage2)
    assert.equal(legacyFlags(job), true)
    const result = auditJobAttempts(job)
    assert.equal(result.verdict, 'ok', result.reasons.join('; '))
    assert.deepEqual(result.violations, [])
    assert.equal(result.creditedFollowed, 1)
    assert.deepEqual(result.stages.find(stage => stage.stageId === stage2), { stageId: stage2, starts: 3, finishedFailed: 3, credited: 0, charged: 3, completed: false, gaps: [] })
  })
}

// Iteration 77 stage 3, controller-iteration77-stage3-events.json: real ids, seqs and data (errors shortened).
const S3 = 'jobstage_mukiujy0_q7ojf1y'
const ITERATION_77 = [
  { seq: 1604, id: 'jobevt_mukiujy0_99kn31i', kind: 'transition', message: 'Created as queued', data: { to: 'queued' } },
  { seq: 1608, id: 'jobevt_mukiujy4_l5922be', kind: 'transition', message: 'queued -> running', data: { from: 'queued', to: 'running' } },
  { seq: 1629, id: 'jobevt_mukj4sfa_taiyzc4', kind: 'stage', message: 'Stage 3 attempt 1 started', data: { stageId: S3, attempt: 1 } },
  { seq: 1630, id: 'jobevt_mukj63kp_qv515l2', kind: 'retry', message: 'Interrupting stage 3: Watchdog: context rollover', data: { stageId: S3 } },
  { seq: 1631, id: 'jobevt_mukj6442_fj1iktn', kind: 'note', message: 'Stage 3 filled its context', data: { stageId: S3, contextRollover: true, promptTokens: 15557 } },
  { seq: 1632, id: 'jobevt_mukj6444_cms69x0', kind: 'retry', message: 'Stage 3 attempt 1 did not finish', data: { stageId: S3, error: 'Watchdog: context rollover', attempt: 1, stop: 'interrupted', promptTokens: 15557 } },
  { seq: 1633, id: 'jobevt_mukj6467_y1u7k3s', kind: 'stage', message: 'Stage 3 attempt 2 started', data: { stageId: S3, attempt: 2 } },
  { seq: 1634, id: 'jobevt_mukjaybh_zv8aa0d', kind: 'retry', message: 'Interrupting stage 3: Watchdog: context rollover', data: { stageId: S3 } },
  { seq: 1635, id: 'jobevt_mukjaz1z_xkijnej', kind: 'note', message: 'Stage 3 filled its context', data: { stageId: S3, contextRollover: true, promptTokens: 16099 } },
  { seq: 1636, id: 'jobevt_mukjaz22_pe4xjrj', kind: 'retry', message: 'Stage 3 attempt 2 did not finish (context rollover with progress; attempt not spent)', data: { stageId: S3, error: 'Watchdog: context rollover', attempt: 2, stop: 'interrupted', promptTokens: 16099, attemptCredited: true } },
  { seq: 1638, id: 'jobevt_mukjaz84_2x9tsgu', kind: 'stage', message: 'Stage 3 attempt 3 started', data: { stageId: S3, attempt: 3 } },
  { seq: 1639, id: 'jobevt_mukjca60_jjel64z', kind: 'retry', message: 'Interrupting stage 3: Watchdog: context rollover', data: { stageId: S3 } },
  { seq: 1640, id: 'jobevt_mukjcbo2_z8kmm6z', kind: 'note', message: 'Stage 3 filled its context', data: { stageId: S3, contextRollover: true, promptTokens: 13734 } },
  { seq: 1641, id: 'jobevt_mukjcbo5_hajy0h3', kind: 'retry', message: 'Stage 3 attempt 3 did not finish', data: { stageId: S3, error: 'Watchdog: context rollover', attempt: 3, stop: 'interrupted', promptTokens: 13734 } },
  { seq: 1642, id: 'e1642', kind: 'stage', message: 'Stage 3 attempt 4 started', data: { stageId: S3, attempt: 4 } },
  { seq: 1643, id: 'e1643', kind: 'loop-detected', message: 'Loop detected', data: { stageId: S3, replan: 1 } },
  { seq: 1644, id: 'e1644', kind: 'retry', message: 'Interrupting stage 3: Watchdog: loop guard replan', data: { stageId: S3 } },
  { seq: 1645, id: 'e1645', kind: 'retry', message: 'Stage 3 attempt 4 did not finish: Watchdog: loop guard replan', data: { stageId: S3, error: 'Watchdog: loop guard replan', attempt: 4 } },
  { seq: 1646, id: 'jobevt_mukjdcps_ubnao5s', kind: 'transition', message: 'running -> blocked', data: { from: 'running', to: 'blocked', nextAction: 'Resume the unfinished stage' } }
]
const REASON_77 = 'Stage 3 "Write notes for epsilon and zeta" used all 3 attempts. Last error: Watchdog: loop guard replan'

test('retained iteration 77: four starts, one credit, three charges is a valid block', () => {
  const job = { events: ITERATION_77, complete: true, status: 'blocked', statusReason: REASON_77, blockedStageId: S3 }
  assert.equal(legacyFlags(job), true)
  const result = auditJobAttempts(job)
  assert.equal(result.verdict, 'ok', result.reasons.join('; '))
  assert.deepEqual(result.stages, [{ stageId: S3, starts: 4, finishedFailed: 4, credited: 1, charged: 3, completed: false, gaps: [] }])
  assert.equal(result.creditedFollowed, 1)
})

test('retained iteration 77 with its stage-2 credit but no stage-2 ledger stays inconclusive, not zero violations', () => {
  const stage2Credit = { seq: 1619, id: 'jobevt_mukj0kh5_5zf51wu', kind: 'retry', message: 'Stage 2 attempt 1 did not finish (context rollover with progress; attempt not spent)', data: { stageId: 'jobstage_mukiujy0_a0th83w', attempt: 1, attemptCredited: true } }
  const result = auditJobAttempts({ events: [...ITERATION_77, stage2Credit], complete: true, status: 'blocked', statusReason: REASON_77, blockedStageId: S3 })
  assert.equal(result.verdict, 'inconclusive')
  assert.deepEqual(result.violations, [])
  assert.match(result.reasons.join(' '), /outcome but no start/)
})

test('all-uncredited exhaustion is a valid block', () => {
  const events = [created(), ...failedAttempt('s', 1), ...failedAttempt('s', 2), ...failedAttempt('s', 3), blocked()]
  assert.equal(auditJobAttempts(blockedJob(events, 's')).verdict, 'ok')
})

test('a premature same-stage block after a credit is a violation', () => {
  const events = [created(), ...failedAttempt('s', 1), ...failedAttempt('s', 2, true), ...failedAttempt('s', 3), blocked()]
  const result = auditJobAttempts(blockedJob(events, 's'))
  assert.equal(result.verdict, 'violation')
  assert.deepEqual(result.violations, [{ stageId: 's', charged: 2, credited: 1, finishedFailed: 3, budget: 3 }])
})

test('a block right after a credited attempt, with no further attempt, is a violation', () => {
  const events = [created(), ...failedAttempt('s', 1), ...failedAttempt('s', 2, true), blocked()]
  assert.equal(auditJobAttempts(blockedJob(events, 's')).verdict, 'violation')
})

test('a credited rollover followed by the next attempt and completion is accepted and exercised', () => {
  const events = [created(), ...failedAttempt('s', 1, true), start('s', 2), done('s')]
  const result = auditJobAttempts({ events, complete: true, status: 'completed' })
  assert.equal(result.verdict, 'ok')
  assert.equal(result.creditedFollowed, 1)
  assert.deepEqual(result.stages[0], { stageId: 's', starts: 2, finishedFailed: 1, credited: 1, charged: 0, completed: true, gaps: [] })
})

test('duplicate captures of the same interrupt and outcome count once', () => {
  const events = [created(), ...failedAttempt('s', 1), ...failedAttempt('s', 2, true), ...failedAttempt('s', 3), ...failedAttempt('s', 4), blocked()]
  const doubled = [...events, ...events.filter(event => event.kind === 'retry').map(event => ({ ...event }))]
  const result = auditJobAttempts(blockedJob(doubled, 's'))
  assert.equal(result.verdict, 'ok')
  assert.equal(result.stages[0].finishedFailed, 4)
  assert.equal(result.stages[0].charged, 3)
})

test('truncated, missing, conflicting or unmapped evidence is inconclusive', () => {
  const base = [created(), ...failedAttempt('s', 1), ...failedAttempt('s', 2, true), ...failedAttempt('s', 3), ...failedAttempt('s', 4), blocked()]
  assert.equal(auditJobAttempts({ ...blockedJob(base, 's'), complete: false }).verdict, 'inconclusive')
  assert.equal(auditJobAttempts(blockedJob(base.slice(1), 's')).verdict, 'inconclusive', 'capture not starting at creation')
  const gap = base.filter(event => !(event.kind === 'stage' && event.data.attempt === 2))
  assert.equal(auditJobAttempts(blockedJob(gap, 's')).verdict, 'inconclusive')
  const middleOutcomeMissing = base.filter(event => !(event.kind === 'retry' && event.data.attempt === 3))
  assert.equal(auditJobAttempts(blockedJob(middleOutcomeMissing, 's')).verdict, 'inconclusive')
  const creditEvent = base.find(event => event.data?.attemptCredited)
  const conflicting = [...base, { ...creditEvent, data: { ...creditEvent.data, attemptCredited: false } }]
  assert.equal(auditJobAttempts(blockedJob(conflicting, 's')).verdict, 'inconclusive')
  const twoOutcomes = [...base, { ...outcome('s', 2, false) }]
  assert.equal(auditJobAttempts(blockedJob(twoOutcomes, 's')).verdict, 'inconclusive')
  assert.equal(auditJobAttempts({ ...blockedJob(base, 's'), blockedStageId: null }).verdict, 'inconclusive')
  assert.equal(auditJobAttempts({ ...blockedJob(base, 's'), blockedStageId: 'another-stage' }).verdict, 'inconclusive')
  assert.equal(auditJobAttempts({ events: [{ kind: 'retry', data: {} }], complete: true, status: 'completed' }).verdict, 'inconclusive')
})

test('an owner resume that granted new attempts is excluded from budget accounting', () => {
  const events = [created(), ...failedAttempt('s', 1), ...failedAttempt('s', 2), ...failedAttempt('s', 3), blocked(), { seq: ++seq, id: `e${seq}`, kind: 'transition', message: 'blocked -> running', data: { from: 'blocked', to: 'running' } }, start('s', 4), done('s')]
  const result = auditJobAttempts({ events, complete: true, status: 'completed' })
  assert.equal(result.verdict, 'excluded')
})

test('auditSoak: PASS needs every job proven and a credited rollover exercised; any violation fails', () => {
  const clean = { iteration: 1, jobId: 'a', events: [created(), ...failedAttempt('s', 1), start('s', 2), done('s')], complete: true, status: 'completed' }
  const credited = { iteration: 2, jobId: 'b', events: [created(), ...failedAttempt('t', 1, true), start('t', 2), done('t')], complete: true, status: 'completed' }
  const premature = { iteration: 3, jobId: 'c', ...blockedJob([created(), ...failedAttempt('u', 1, true), ...failedAttempt('u', 2), blocked()], 'u') }
  const truncated = { ...credited, iteration: 4, jobId: 'd', complete: false }
  const notExercised = auditSoak([clean])
  assert.deepEqual((({ verdict, credited: c }) => ({ verdict, c }))(notExercised), { verdict: 'UNVERIFIED', c: 'NOT EXERCISED' })
  assert.match(notExercised.reasons.join(' '), /NOT EXERCISED/)
  assert.deepEqual((({ verdict, credited: c, reasons }) => ({ verdict, c, reasons }))(auditSoak([clean, credited])), { verdict: 'PASS', c: 'EXERCISED', reasons: [] })
  assert.equal(auditSoak([clean, credited, premature]).verdict, 'FAIL')
  assert.equal(auditSoak([clean, credited, truncated]).verdict, 'UNVERIFIED')
  assert.equal(auditSoak([]).verdict, 'UNVERIFIED')
})

// ---- S-B4: every uncertainty added to an otherwise premature block wins over the violation.
const premature = () => [created(), ...failedAttempt('p', 1), ...failedAttempt('p', 2, true), ...failedAttempt('p', 3), blocked()]

test('the complete same-stage premature block is still a violation (control)', () => {
  const result = auditJobAttempts(blockedJob(premature(), 'p'))
  assert.equal(result.verdict, 'violation')
  assert.deepEqual(result.unprovenCandidates, [])
})

for (const [name, job, verdict] of [
  ['an incomplete capture', () => ({ ...blockedJob(premature(), 'p'), complete: false }), 'inconclusive'],
  ['an incomplete capture of 1 uncredited, 2 credited, then a budget block (the reviewer\'s case)', () => ({ ...blockedJob([created(), ...failedAttempt('p', 1), ...failedAttempt('p', 2, true), blocked()], 'p'), complete: false }), 'inconclusive'],
  ['a conflicting duplicate capture', () => { const events = premature(); const credit = events.find(event => event.data?.attemptCredited); return blockedJob([...events, { ...credit, data: { ...credit.data, attemptCredited: false } }], 'p') }, 'inconclusive'],
  ['a budget that differs from the job\'s', () => ({ ...blockedJob(premature(), 'p'), maxStageAttempts: 4 }), 'inconclusive'],
  ['an unidentified blocked stage', () => ({ ...blockedJob(premature(), 'p'), blockedStageId: null }), 'inconclusive'],
  ['a gap in the blocked stage', () => blockedJob(premature().filter(event => !(event.kind === 'stage' && event.data?.attempt === 2)), 'p'), 'inconclusive'],
  ['a last attempt without its failed outcome', () => blockedJob([created(), ...failedAttempt('p', 1), ...failedAttempt('p', 2, true), start('p', 3), blocked()], 'p'), 'inconclusive'],
  ['an owner resume that granted attempts', () => blockedJob([created(), ...failedAttempt('p', 1), blocked(), { seq: ++seq, id: `e${seq}`, kind: 'transition', message: 'blocked -> running', data: { from: 'blocked', to: 'running' } }, ...failedAttempt('p', 2, true), ...failedAttempt('p', 3), blocked()], 'p'), 'excluded']
]) {
  test(`premature block plus ${name} is ${verdict}, never a violation`, () => {
    const result = auditJobAttempts(job())
    assert.equal(result.verdict, verdict, result.reasons.join('; '))
    assert.deepEqual(result.violations, [])
    // An unidentified blocked stage has no ledger to hold a candidate at all.
    assert.equal(result.unprovenCandidates.length, /unidentified/.test(name) ? 0 : 1)
  })
}

test('iteration 77 is still accepted after the evidence-first ordering', () => {
  assert.equal(auditJobAttempts({ events: ITERATION_77, complete: true, status: 'blocked', statusReason: REASON_77, blockedStageId: S3 }).verdict, 'ok')
})

// ---- S-B5: fault runs and their matching control both need the same job completed with correct output.

test('acceptanceFailures: only a completed same job with checked, correct output is accepted', () => {
  assert.deepEqual(acceptanceFailures({ jobId: 'j1', final: { id: 'j1', status: 'completed' }, problems: [] }), [])
  for (const [name, input, message] of [
    ['blocked control', { jobId: 'j1', final: { id: 'j1', status: 'blocked', statusReason: 'used all 3 attempts' }, problems: null }, /ended blocked/],
    ['cancelled control', { jobId: 'j1', final: { id: 'j1', status: 'cancelled' }, problems: null }, /ended cancelled/],
    ['wrong output', { jobId: 'j1', final: { id: 'j1', status: 'completed' }, problems: ['CROSSREF.md has no row'] }, /wrong output/],
    ['unchecked output', { jobId: 'j1', final: { id: 'j1', status: 'completed' }, problems: null }, /not checked/],
    ['another job', { jobId: 'j1', final: { id: 'j2', status: 'completed' }, problems: [] }, /settled job j2/],
    ['no final status', { jobId: 'j1', final: null, problems: [] }, /ended unknown/]
  ]) assert.match(acceptanceFailures(input).join('; '), message, name)
})
