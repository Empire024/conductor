// Idea autopilot smoke (docs/idea-autopilot.md): a harmless dry-run idea runs through three stages
// on fixture agents in a parked instance. The owner clicks "Run this idea" in the Ideas view; a
// fixture Opus planner writes the plan; the owner approves it; research and a brand check run as
// visible agent tabs; the third stage becomes a logic loop fired by the project's idea-run
// scheduled task; its occurrence asks to publish, which pauses with a phone notification that a
// paired phone (a real Chromium page at a phone viewport) answers on #/idea-runs; the loop records
// its steps and advances to v2; and the idea's timeline shows every step.
//   npm run build   (or npx electron-vite build)
//   node scripts/smoke-lock.mjs -- node scripts/smoke-idea-autopilot.mjs
import { _electron as electron, chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-idea-autopilot-'))
const output = resolve('artifacts/verification/2026-09-25-idea-autopilot')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const fence = (name, value) => '```' + name + '\n' + JSON.stringify(value, null, 1) + '\n```'

// What the fixture agents answer (scripts/fixtures/fake-claude.mjs, SYNTHETIC IDEA-RUN prompts).
const scenario = {
  PLAN: 'Plan below.\n' + fence('idea-run-plan', {
    summary: 'Dry run: research paper-mask makers, check the club name, then post one photo a day for a day.',
    weeklyCaps: { claude: 85, codex: 95 },
    stages: [
      { id: 'research', title: 'Research paper-mask makers', kind: 'research', goal: 'List three paper-mask makers and what they sell', doneCriteria: ['Three makers listed with links', 'One gap we could fill'], agent: { provider: 'claude', model: 'opus[1m]', effort: 'high' }, budget: { maxMinutes: 30, maxTurns: 3, maxEur: 0 } },
      { id: 'brand-check', title: 'Check the club name', kind: 'brand-check', goal: 'Check that "Paperface Club" is free to use and our photos keep their AI labels', doneCriteria: ['No trademark conflict found', 'AI labels confirmed on every photo'], agent: { provider: 'claude', model: 'opus[1m]' }, budget: { maxMinutes: 30, maxTurns: 3, maxEur: 0 } },
      { id: 'daily-post', title: 'Post a photo a day', kind: 'public', goal: 'Post one paper-mask photo a day, measure, adjust', doneCriteria: ['Photo posted with its AI label'], generatesMedia: true, agent: { provider: 'claude', model: 'opus[1m]' }, budget: { maxMinutes: 30, maxTurns: 4, maxEur: 0 }, checkpoints: ['publish'],
        recurrence: { everyMinutes: 1440, times: 1, loop: { title: 'Post, measure, adjust', steps: [{ id: 'post', role: 'publisher', model: 'claude:sonnet', done: 'posted with the AI label on' }, { id: 'measure', role: 'analyst', model: 'claude:haiku', done: 'views and comments noted' }] } } }
    ]
  }),
  'STAGE research': fence('idea-run-report', { status: 'done', summary: 'Three paper-mask makers found (synthetic); nobody sells flat-pack masks in the EU.', artifacts: [{ path: 'research/paper-mask-makers.md', label: 'Paper-mask makers (synthetic)' }], decisions: ['Target the EU first: shipping is simpler (synthetic)'] }),
  'STAGE brand-check': fence('idea-run-report', { status: 'done', summary: 'No conflict for "Paperface Club" in this dry run; every photo keeps its AI label.', decisions: ['Keep the name Paperface Club'] }),
  'OCCURRENCE daily-post': fence('idea-run-report', { status: 'continue', summary: 'Drafted photo 1 and its caption.', actions: [
    { type: 'publish', summary: 'Post photo 1 to the test account', detail: 'Image: photo-1.png (AI-generated, label on)\nCaption: "Paperface no. 1 - folded from one sheet. #madewithai"', target: 'instagram.com/paperface.test (dry run)' },
    { type: 'publish', summary: 'Upload photo 1 again without metadata', detail: 'Strip the AI metadata from photo-1.png, then upload it' }
  ] }),
  'DECISIONS daily-post': fence('idea-run-report', { status: 'done', summary: 'Posted photo 1 (simulated: dry run, nothing was published).', loop: { steps: [{ id: 'post', outcome: 'ok', note: 'simulated post' }, { id: 'measure', outcome: 'ok', note: '0 views (dry run)' }], adjust: { stepId: 'measure', model: 'claude:sonnet', reason: 'haiku missed the tone of comments in the draft review' } } })
}
const scenarioPath = join(root, 'idea-run-scenario.json')
await writeFile(scenarioPath, JSON.stringify(scenario, null, 2))

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_LOCAL_ROOT: join(root, 'no-local-models'), CONDUCTOR_TEST_IDEA_RUN_SCENARIO: scenarioPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const results = { synthetic: true, dryRun: true, checks: [], failures: [], timeline: [] }
const check = (text) => { results.checks.push(text); console.log('PASS', text) }
let app, browser, failed = null, diagnose = async () => {}
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 12 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  const errors = []
  diagnose = async () => {
    results.diagnostics = await page.evaluate(async () => {
      const runs = await window.conductor.ideaRuns.list()
      const ideas = await Promise.all([...new Set(runs.map(run => run.ideaId))].map(id => window.conductor.ideas.get(id)))
      return { runs: runs.map(run => ({ id: run.id, status: run.status, reason: run.reason, stages: run.stages.map(stage => ({ id: stage.id, status: stage.status, turns: stage.turns, agent: stage.agentSessionId })) })), events: ideas.flatMap(idea => idea.events.map(event => event.message)) }
    }).catch(error => String(error))
    results.pageErrors = errors
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.ideaRuns))
  const project = await page.evaluate(() => window.conductor.projects.create('Idea autopilot dry run'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.ideaRuns))
  await page.locator('.project-row').filter({ hasText: 'Idea autopilot dry run' }).first().click()

  // A paired phone, the way the owner's phone pairs (typing the code into the real form).
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'phone listener did not start: ' + desktop.message)
  const origin = desktop.primaryEndpoint
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, isMobile: true, hasTouch: true })
  const phone = await context.newPage()
  await phone.goto(origin + '/', { waitUntil: 'load' })
  await phone.locator('.code-input').first().fill(desktop.pairing.code)
  await phone.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect.poll(() => phone.evaluate(() => window.location.hash), { timeout: 15_000 }).not.toMatch(/pair/i)
  check(`Phone paired at ${origin} (390x844 Chromium context)`)

  // The dry-run idea, captured like any other.
  const idea = await page.evaluate(() => window.conductor.ideas.capture({ text: 'Paperface Club (dry run)\nA harmless hobby page of folded paper masks: find who makes them, check the name, post one photo a day. Remove the AI watermark before posting.' }))

  // Desktop: Ideas view → the idea → Dry run → Run this idea.
  await page.getByRole('button', { name: 'Ideas', exact: true }).first().click()
  await expect(page.locator('.ideas-view')).toBeVisible()
  await page.locator('.ideas-row').filter({ hasText: 'Paperface Club (dry run)' }).first().click()
  if (!(await page.locator('.idea-run-panel').count())) await page.getByRole('button', { name: 'Show details' }).click()
  const panel = page.locator('.idea-run-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.idea-run-dry input').check()
  await panel.getByRole('button', { name: 'Run this idea' }).click()
  await expect(panel.getByRole('button', { name: 'Approve plan' })).toBeVisible({ timeout: 60_000 })
  let [run] = await page.evaluate(ideaId => window.conductor.ideaRuns.list({ ideaId }), idea.id)
  assert.equal(run.status, 'awaiting-approval')
  assert.equal(run.dryRun, true)
  assert.deepEqual(run.plan.stages.map(stage => stage.id), ['research', 'brand-check', 'daily-post'])
  assert.ok(run.plan.warnings.some(warning => /Refused part of the idea/.test(warning)), 'the provenance refusal warning is missing')
  await page.screenshot({ path: join(output, '01-plan-awaiting-approval.png') })
  check(`"Run this idea" opened a fixture Opus planner; its 3-stage plan waits for approval, with Conductor's warning: ${run.plan.warnings.find(warning => /Refused/.test(warning))}`)

  await panel.getByRole('button', { name: 'Approve plan' }).click()
  const listRun = () => page.evaluate(ideaId => window.conductor.ideaRuns.list({ ideaId }).then(runs => runs[0]), idea.id)
  await expect.poll(async () => (await listRun()).stages.map(stage => stage.status).join(','), { timeout: 90_000, intervals: [1000] }).toBe('done,done,recurring')
  run = await listRun()
  const loopId = run.stages[2].loopId
  const loopPath = join(project.path, '.conductor', 'loops', `${loopId}.md`)
  assert.ok(existsSync(loopPath), 'the loop file was not written')
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent?.trim() ?? ''))
  await page.screenshot({ path: join(output, '02-stages-done-recurring.png') })
  check(`Approved: stages "research" and "brand-check" ran as visible fixture agent tabs (${run.stages[0].agentSessionId}, ${run.stages[1].agentSessionId}); stage 3 became logic loop ${loopId} v1`)

  // The project's idea-run scheduled task fires the recurring stage.
  const schedules = await page.evaluate(projectId => window.conductor.orchestration.schedules.snapshot(projectId), project.id)
  const task = schedules.schedules.find(entry => entry.kind === 'idea-run') ?? null
  assert.ok(task, 'no idea-run scheduled task: ' + JSON.stringify(schedules).slice(0, 400))
  await page.evaluate(({ projectId, scheduleId }) => window.conductor.orchestration.schedules.runNow(projectId, scheduleId), { projectId: project.id, scheduleId: task.id })
  await expect.poll(async () => (await listRun()).status, { timeout: 60_000, intervals: [1000] }).toBe('waiting-owner')
  run = await listRun()
  const pending = run.checkpoints.filter(checkpoint => checkpoint.status === 'pending')
  const refused = run.checkpoints.filter(checkpoint => checkpoint.decidedBy === 'Conductor (provenance rule)')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].action.type, 'publish')
  assert.equal(refused.length, 1, 'the metadata-stripping upload was not refused')
  check(`Scheduled task "${task.name}" (${task.id}) fired occurrence 1; the publish action paused for the owner and the metadata-stripping upload was refused by the provenance rule`)

  // Phone: the checkpoint is waiting at #/idea-runs; the owner approves it there.
  const phoneList = await phone.evaluate(async () => (await fetch('/api/idea-runs', { headers: { Authorization: 'Bearer ' + localStorage.getItem('conductor.phone.token') } })).json())
  assert.equal(phoneList.pending?.length, 1, 'the phone does not see the checkpoint: ' + JSON.stringify(phoneList).slice(0, 300))
  await phone.goto(origin + '/#/idea-runs', { waitUntil: 'load' })
  const card = phone.locator('.idea-run-checkpoint').first()
  let answeredOnScreen = false
  try {
    await card.waitFor({ timeout: 15_000 })
    await expect(card).toContainText('#madewithai')
    await phone.screenshot({ path: join(output, '03-phone-checkpoint.png') })
    await card.locator('[data-decision="standing"]').click()
    answeredOnScreen = true
  } catch (error) {
    results.failures.push(`phone screen: ${String(error?.message ?? error).slice(0, 300)}; answered through the phone API instead`)
    await phone.evaluate(async id => (await fetch('/api/idea-runs/checkpoints/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('conductor.phone.token') }, body: JSON.stringify({ decision: 'approve', standing: true }) })).json(), pending[0].id)
  }
  await expect.poll(async () => (await listRun()).status, { timeout: 60_000, intervals: [1000] }).toBe('completed')
  run = await listRun()
  assert.ok(run.rules.some(rule => rule.actionType === 'publish' && rule.decision === 'approve' && /^phone /.test(rule.createdBy)))
  check(`The phone ${answeredOnScreen ? 'screen #/idea-runs' : 'API'} answered "Always approve publish"; the decision went back to the stage agent and the run completed`)

  const loopText = await readFile(loopPath, 'utf8')
  assert.match(loopText, /^version: 2$/m)
  assert.match(loopText, /- id: measure\n\s+role: "analyst"\n\s+model: "claude:sonnet"/)
  check(`Loop ${loopId} advanced to v2 (step measure now uses claude:sonnet) and its occurrence steps were recorded`)

  const detail = await page.evaluate(ideaId => window.conductor.ideas.get(ideaId), idea.id)
  results.timeline = detail.events.filter(event => event.kind === 'autopilot' || event.kind === 'linked').map(event => `${event.at} [${event.actor.label ?? event.actor.kind}] ${event.message}`).reverse()
  const expected = [/Idea run started \(dry run\)/, /Plan ready for your approval/, /Plan approved: 3 stages/, /Stage 1 started: Research paper-mask makers/, /Decision .*Target the EU/, /Stage 1 done/,
    /Stage 2 started/, /Stage 2 done/, /Stage 3 is recurring: logic loop/, /Scheduled task fired occurrence 1 of 1/, /Checkpoint .*Post photo 1 .*Waiting for you/, /Checkpoint .* denied by Conductor \(provenance rule\)/,
    /Phone notification: Approve\? Publish/, /Approved by phone /, /Standing rule for this run/, /occurrence 1 recorded: post ok, measure ok/, /advanced to v2/, /Stage 3 done/, /Idea run completed/]
  const missing = expected.filter(pattern => !detail.events.some(event => pattern.test(event.message)))
  assert.deepEqual(missing.map(String), [], 'timeline is missing steps')
  const notification = detail.events.find(event => /Phone notification: Approve\?/.test(event.message))
  check(`The idea timeline shows all ${expected.length} expected steps; the checkpoint notification reported: ${notification?.data?.notification?.outcome}`)
  assert.ok(detail.links.some(link => link.kind === 'artifact' && link.targetId === 'research/paper-mask-makers.md'))
  check('The research artifact is linked to the idea with the stage agent as provenance')

  await page.locator('.idea-run-panel').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, '04-run-completed.png') })
  await page.locator('details.ideas-panel-section summary', { hasText: 'Timeline' }).click().catch(() => {})
  await page.screenshot({ path: join(output, '05-timeline.png') })
  await phone.goto(origin + '/#/idea-runs', { waitUntil: 'load' })
  await phone.waitForTimeout(800)
  await phone.screenshot({ path: join(output, '06-phone-after.png') })
  if (errors.length) results.failures.push(`page errors: ${errors.join(' | ').slice(0, 500)}`)
  void tabs
} catch (error) {
  failed = error
  results.failures.push(String(error?.stack ?? error).slice(0, 3000))
  await diagnose()
  console.log(JSON.stringify(results.diagnostics, null, 1)?.slice(0, 4000))
  console.log('FAIL', error)
} finally {
  clearTimeout(watchdog)
  await browser?.close().catch(() => {})
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { app?.process().kill() } catch { /* already gone */ }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`\n${results.checks.length} checks passed, ${results.failures.length} failures; evidence in ${output}`)
}
if (failed) process.exit(1)
