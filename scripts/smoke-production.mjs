// Production agent end to end in the built app (docs/production-agent.md sections 8 and 11, M8).
// A parked Conductor (CONDUCTOR_TEST_USER_DATA, spawn mode so it can restart) audits a fixture
// project whose "deployment" is a local proxy in front of the fixture sites: broken
// (consent-tracker-before), a superficial fix (verify-superficial-fix) and the real fix
// (consent-good). Everything goes through the real production.* control methods, the real runner,
// checks and Playwright audit browser; the panel is read in the real renderer.
//
// Proves: designation, an owner question answered, dedup (a second trigger coalesces), restart
// mid-run resumes at the checkpoint without repeating a done step, the gate BLOCKED with the
// tracker finding and its auto-filed fix task, the report, a waiver and its revocation, stale
// detection after a new build, the independent verifier rejecting the superficial fix and then
// verifying the real one on a fresh build (task closed, finding fixed), a clean re-audit VERIFIED,
// a prompt-injection site audited without any effect, and not one mutating request to any site.
//
//   node scripts/smoke-lock.mjs --timeout-min 30 -- node scripts/smoke-production.mjs
//   CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { request as httpRequest, createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, page, poll, record, relaunched, shot, step, watchdog } from './verify-kit.mjs'
import { createFixtureServer } from '../src/main/production/fixtures/server.ts'

configure({ name: 'production' })
watchdog(1500)
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
const sites = await createFixtureServer({ sites: ['consent-tracker-before', 'verify-superficial-fix', 'consent-good', 'injection'], root: resolve('src/main/production/fixtures/sites') })

// The "deployment": one stable origin whose content is whichever site is deployed.
let deployed = 'consent-tracker-before'
const proxyLog = []
const proxy = createServer((req, res) => {
  const target = new URL(sites.site(deployed).origin)
  proxyLog.push({ method: req.method, path: req.url, site: deployed })
  const upstream = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, answer => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res) })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(upstream)
})
await new Promise(done => proxy.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${proxy.address().port}`

/** The panel's own wording: everything except text the audit quoted from the site, a check or a
 *  person (`data-audit-text`, for example a percent-encoded tracker URL) and form fields. A score
 *  or percentage the panel itself rendered would show up here. */
const chromeText = locator => locator.evaluate(element => {
  const copy = element.cloneNode(true)
  for (const node of copy.querySelectorAll('[data-audit-text], input, textarea, select')) node.remove()
  return copy.textContent ?? ''
})
const TERMINAL = ['completed', 'failed', 'cancelled']
const summary = { origin, runs: {} }
const waitRun = async (runId, label, timeoutMs = 240_000) => poll(async () => {
  const run = await call('production.run', { runId })
  return TERMINAL.includes(run.status) ? run : null
}, { timeoutMs, intervalMs: 1500, label })
const idle = async label => poll(async () => { const status = await call('production.status', {}); return status.activeRun ? null : status }, { timeoutMs: 300_000, intervalMs: 2000, label })

let inst
try {
  inst = await launchParked({ mode: 'spawn', build })
  const project = await openProject({ name: 'Fixture shop', git: true, files: { 'deploy.txt': 'broken\n' } })
  const commit = message => {
    writeFileSync(join(project.path, 'deploy.txt'), `${message}\n`)
    for (const args of [['add', '.'], ['commit', '-q', '-m', message]]) {
      const result = spawnSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', ...args], { cwd: project.path, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    }
  }
  const deploy = (site, message) => { deployed = site; commit(message) }

  // ---- 1. profile, owner question, designation ----------------------------------------------
  step('profile and owner question')
  const tools = await call('tools.list', { prefix: 'production.' })
  assert.ok(JSON.stringify(tools).includes('production.review.answer'), 'tools.list lacks production.review.answer')
  const environment = { id: 'env-shop', kind: 'local', label: 'Fixture shop', baseUrl: `${origin}/`, allowedOrigins: [origin], accounts: [], capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null }
  const injectionEnv = { ...environment, id: 'env-injection', label: 'Injection page', baseUrl: `${sites.site('injection').origin}/`, allowedOrigins: [sites.site('injection').origin] }
  await call('production.profile.update', {
    environments: [environment, injectionEnv],
    // The smoke's subject is C03; the owner switches the other controls off for this fixture, with a reason.
    scope: { routes: [{ path: '/', source: 'owner', tags: ['home'], coverage: 'full' }], devices: ['desktop'], consentStates: ['clean'],
      disabledControls: ['C01', 'C02', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'].map(controlId => ({ controlId, reason: 'Not part of the consent fixture' })) },
    budget: { requestsPerSecondPerOrigin: 20 },
  })
  let status = await call('production.status', {})
  const analytics = status.questions.find(question => question.factKey === 'analytics')
  assert.ok(analytics, 'no owner question about analytics')
  const answered = await call('production.answer', { questionId: analytics.id, answer: 'yes' })
  assert.equal(answered.facts.analytics.value, true)
  assert.equal(answered.facts.analytics.status, 'evidenced')
  // The rest of the owner's facts, so no open question holds the gate.
  await call('production.profile.update', { facts: {
    legalEntity: 'Fixture Shop s.r.o.', targetCountries: ['SK', 'EU'], businessModel: 'b2c', products: ['physical goods'], accountFeatures: false, subscriptions: false,
    userUploads: false, aiRuntime: false, sessionReplay: false, emailMarketing: false, dataCategories: ['contact'], audience: 'general', ageRestrictedProducts: false,
    paymentProviders: ['card'], processors: ['hosting'], safeHarborReliance: false,
  } })
  status = await call('production.status', {})
  for (const question of status.questions) await call('production.answer', { questionId: question.id, dismiss: 'Answered in the profile facts by the smoke' })
  assert.deepEqual((await call('production.status', {})).questions, [])
  // A coworker-only rule is refused to nobody here (owner credential); a sovereign method from a
  // non-sovereign caller is covered by control.test.ts.
  record('question', 'PASS', { questionId: analytics.id }, 'analytics answered yes by the owner: evidenced fact')

  // ---- 2. designation starts the audit; a second trigger coalesces --------------------------
  step('designate')
  await call('production.designate', { productionReady: true, environmentId: 'env-shop', note: 'Fixture shop launch' })
  status = await call('production.status', {})
  assert.ok(status.activeRun, 'designation started no audit')
  const first = status.activeRun.id
  const again = await call('production.audit', { controls: ['C03'] })
  assert.equal(again.outcome, 'coalesced', `a trigger during a run was ${again.outcome}`)
  assert.equal(again.run.id, first)
  record('dedup', 'PASS', { runId: first }, 'the second trigger set rerunRequested on the active run')

  // ---- 3. restart mid-run: resume at the checkpoint -----------------------------------------
  step('restart mid-run')
  const midRun = await poll(async () => {
    const run = await call('production.run', { runId: first })
    if (TERMINAL.includes(run.status)) throw new Error(`run ${first} finished (${run.status}) before the restart could interrupt it`)
    return run.steps.some(entry => entry.status === 'done') && run.steps.some(entry => entry.controlId === 'C03' && entry.status === 'running') ? run : null
  }, { timeoutMs: 180_000, intervalMs: 250, label: 'the C03 step running after a done step' })
  const doneBefore = midRun.steps.filter(entry => entry.status === 'done').map(entry => entry.id)
  const pidBefore = inst.credential.pid
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, pidBefore)
  const resumed = await waitRun(first, 'the interrupted run to finish after the restart')
  assert.equal(resumed.status, 'completed', `the resumed run ended ${resumed.status}: ${resumed.statusReason}`)
  for (const id of doneBefore) assert.equal(resumed.steps.find(entry => entry.id === id)?.attempts, 1, `step ${id} ran again after the restart`)
  assert.ok(resumed.events.some(event => event.kind === 'recovery' || /resum|recover/i.test(event.message)), 'no recovery event in the run journal')
  summary.runs.first = { id: first, doneBefore: doneBefore.length, relaunchSeconds: seconds }
  record('restart-resume', 'PASS', { doneBefore: doneBefore.length, relaunchSeconds: seconds }, `run ${first} resumed after app.restart and completed; no done step repeated`)
  status = await idle('the coalesced follow-up run')
  assert.ok(status.runs.filter(run => run.kind === 'audit').length >= 2, 'the coalesced trigger did not run once more')

  // ---- 4. gate, finding, fix task, report ---------------------------------------------------
  step('gate, finding, task, report')
  assert.equal(status.gate.state, 'BLOCKED', `gate ${status.gate.state}: ${status.gate.reasons.join(' | ')}`)
  // The tracker site gives several C03 findings (the tracker host, its cookie, its storage key).
  const c03 = status.openFindings.filter(finding => finding.controlId === 'C03')
  const tracker = c03.find(finding => finding.severity === 'high')
  assert.ok(tracker, `no high C03 finding: ${JSON.stringify(status.openFindings)}`)
  const ids = c03.map(finding => finding.id)
  const board = await call('orchestration.snapshot', {})
  for (const finding of c03.filter(entry => entry.severity === 'critical' || entry.severity === 'high')) {
    assert.ok(finding.taskId, `the ${finding.severity} finding ${finding.title} has no auto-filed fix task`)
    assert.ok(/\[C03\]/.test(board.tasks.find(entry => entry.id === finding.taskId)?.title ?? ''), 'the fix task is not on the board')
  }
  const taskIds = c03.map(finding => finding.taskId).filter(Boolean)
  const report = await call('production.report', {})
  assert.match(report.text, /C03/)
  assert.doesNotMatch(report.text, /certif|guarantee/i)
  record('gate', 'PASS', { state: status.gate.state, finding: tracker.id, task: tracker.taskId }, status.gate.reasons.slice(0, 3).join(' | '))

  // ---- 5. human-review answer, if the audited controls raised items ------------------------
  const items = status.results.flatMap(result => result.humanReview)
  if (items.length) {
    const item = items[0]
    const saved = await call('production.review.answer', { itemId: item.id, answer: 'confirmed', note: 'checked by the smoke' })
    assert.equal(saved.answer, 'confirmed')
    const after = await call('production.status', {})
    assert.equal(after.results.flatMap(result => result.humanReview).find(entry => entry.id === item.id)?.answer, 'confirmed')
    record('review-answer', 'PASS', { itemId: item.id, items: items.length })
  } else record('review-answer', 'INFO', {}, 'the audited controls raised no human-review item; production.review.answer is covered by control.test.ts')

  // ---- 6. the panel shows the gate badge, the finding and the queue ------------------------
  step('panel')
  const view = await page(inst)
  await view.locator('.project-row').filter({ hasText: 'Fixture shop' }).first().click()
  await view.locator('.activity-rail').getByRole('button', { name: 'Production', exact: true }).click()
  const pane = view.locator('.production-pane').first()
  await pane.locator('.production-gate[data-state="BLOCKED"]').first().waitFor({ timeout: 20_000 })
  await pane.locator(`li[data-finding-id="${tracker.id}"]`).waitFor({ timeout: 10_000 })
  assert.ok(!(await chromeText(pane)).includes('%'), 'the panel shows a percentage')
  await shot('production-blocked')
  await pane.getByRole('button', { name: 'Queue', exact: true }).click()
  const queue = view.locator('table.production-queue')
  await queue.waitFor({ timeout: 10_000 })
  assert.ok((await queue.innerText()).includes('Fixture shop'), 'the queue lacks the project')
  await view.getByTitle('Close workspace view').click().catch(() => undefined)
  record('panel', 'PASS', {}, 'drawer gate badge BLOCKED with the finding; queue row present')

  // ---- 7. waive, then revoke ----------------------------------------------------------------
  step('waiver')
  const waivers = []
  for (const findingId of ids) waivers.push(await call('production.waive', { findingId, reason: 'Consent mode ships next sprint', scope: 'site', owner: 'Owner', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }))
  status = await call('production.status', {})
  assert.equal(status.gate.state, 'VERIFIED_WITH_WAIVERS', `waived gate ${status.gate.state}: ${status.gate.reasons.join(' | ')}`)
  const partly = await call('production.waivers.revoke', { waiverId: waivers[0].id, reason: 'The fix is being verified instead' })
  assert.ok(partly.revokedAt)
  assert.equal((await call('production.status', {})).gate.state, 'BLOCKED')
  for (const waiver of waivers.slice(1)) await call('production.waivers.revoke', { waiverId: waiver.id, reason: 'The fix is being verified instead' })
  record('waiver', 'PASS', { waivers: waivers.length }, 'every C03 finding waived → VERIFIED_WITH_WAIVERS; one revoked → BLOCKED; the findings stayed')

  // ---- 8. superficial fix: stale, then the verifier rejects it ------------------------------
  // A new commit is a change the file watcher turns into a change audit after 30 s; the drift check
  // (mark-stale) sees it at once, and the builder asks for verification before that audit starts.
  step('superficial fix')
  for (const id of taskIds) await call('orchestration.tasks.update', { id, status: 'done' })
  deploy('verify-superficial-fix', 'hide the banner text')
  const drift = await call('production.drift', { enabled: true, onChange: 'mark-stale', runNow: true })
  assert.equal(drift.check?.outcome, 'changed', `drift check: ${JSON.stringify(drift.check)}`)
  status = await call('production.status', {})
  assert.equal(status.gate.state, 'STALE', `gate after the new build ${status.gate.state}: ${status.gate.reasons.join(' | ')}`)
  assert.ok(status.gate.staleControls.includes('C03'))
  record('stale', 'PASS', { changes: drift.check.detail }, status.gate.reasons[0])
  const superficial = await call('production.verify', { findingIds: ids })
  assert.equal(superficial.outcome, 'created', `the verify request was ${superficial.outcome}`)
  const superficialRun = await waitRun(superficial.run.id, 'the verifier run on the superficial fix')
  assert.equal(superficialRun.kind, 'verify')
  let finding = (await call('production.findings', { findingId: tracker.id }))[0]
  assert.equal(finding.verification?.status, 'verified-open', `verification ${finding.verification?.status}: ${finding.verification?.disagreement}`)
  assert.match(finding.verification.disagreement ?? '', /claimed this fixed/)
  for (const id of ids) assert.notEqual((await call('production.findings', { findingId: id }))[0].status, 'fixed')
  record('verifier-rejects', 'PASS', { runId: superficialRun.id }, finding.verification.disagreement.slice(0, 200))

  // ---- 9. real fix on a fresh build: verified, task closed, re-audit VERIFIED ---------------
  step('real fix')
  // The watcher's change audit of the superficial build re-observes the defect; wait for it, then
  // ship the real fix and ask for verification at once.
  await idle('the change audit of the superficial build')
  deploy('consent-good', 'load analytics only after consent')
  const fixed = await call('production.verify', { findingIds: ids })
  assert.equal(fixed.outcome, 'created', `the verify request was ${fixed.outcome}`)
  await waitRun(fixed.run.id, 'the verifier run on the real fix')
  for (const id of ids) {
    finding = (await call('production.findings', { findingId: id }))[0]
    assert.equal(finding.verification?.status, 'verified-fixed', `${finding.title}: ${finding.verification?.status}: ${finding.verification?.disagreement}`)
    assert.equal(finding.status, 'fixed')
  }
  const tasksNow = (await call('orchestration.snapshot', {})).tasks
  for (const id of taskIds) assert.equal(tasksNow.find(entry => entry.id === id)?.status, 'done')
  await idle('the change audit of the fixed build')
  const audit = await call('production.audit', { full: true })
  assert.equal(audit.outcome, 'created')
  await waitRun(audit.run.id, 'the re-audit of the fixed build')
  status = await idle('the re-audit')
  assert.equal(status.gate.state, 'VERIFIED', `re-audited gate ${status.gate.state}: ${status.gate.reasons.join(' | ')}`)
  const view2 = await page(inst)
  const queueRow = view2.getByRole('button', { name: 'Open Production for Fixture shop' }).first()
  await view2.locator(`table.production-queue tr[data-project-id="${project.id}"][data-state="VERIFIED"]`).waitFor({ timeout: 20_000 })
  await queueRow.click()
  await view2.locator('.production-pane .production-gate[data-state="VERIFIED"]').first().waitFor({ timeout: 20_000 })
  await shot('production-verified')
  record('verified', 'PASS', { runId: audit.run.id }, 'verified-fixed on the fresh build; re-audit VERIFIED; panel badge VERIFIED')

  // ---- 10. prompt injection changes nothing -------------------------------------------------
  step('injection')
  const before = await call('production.profile.get', {})
  const injected = await call('production.audit', { environmentId: 'env-injection', controls: ['C03', 'C04'] })
  const injectedRun = await waitRun(injected.run.id, 'the audit of the injection page')
  const after = await call('production.profile.get', {})
  assert.deepEqual(after.environments, before.environments, 'the injection page changed the environments')
  assert.deepEqual(after.writeAuthorizations, [], 'a write authorization appeared')
  record('injection', 'PASS', { runId: injectedRun.id, status: injectedRun.status }, 'allowlist, write authorizations and scope unchanged')

  // ---- 11. no request mutated anything ------------------------------------------------------
  const mutations = sites.mutations()
  const proxied = proxyLog.filter(entry => !['GET', 'HEAD'].includes(entry.method))
  assert.deepEqual(mutations, [], `fixture sites saw mutations: ${JSON.stringify(mutations).slice(0, 500)}`)
  assert.deepEqual(proxied, [], `the deployment saw non-GET requests: ${JSON.stringify(proxied).slice(0, 500)}`)
  record('no-mutation', 'PASS', { requests: sites.requests().length + proxyLog.length }, 'zero POST/PUT/PATCH/DELETE and zero mutationPaths hits across every site')
  writeFileSync(join(inst.root, 'summary.json'), JSON.stringify(summary, null, 2))
  await finish()
} catch (error) {
  await failed(error)
  await finish({ code: 1 })
} finally {
  proxy.close()
  await sites.close()
}
