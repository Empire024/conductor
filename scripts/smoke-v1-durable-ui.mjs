// V1 verify S17 (UI placement) and S18 (contention): durable jobs against the REAL running local
// model. Adapted from scripts/smoke-durable-jobs.mjs's control-plane helpers (jobs.*), with
// screenshots of the actual current UI: the launcher's local-model durable option (owner item
// 6031783 moved it there and removed the old sidebar "Durable jobs" utility panel), and the job's
// own tab (DurableJobPanel, src/renderer/src/components/DurableJobsPane.tsx) showing progress and
// Pause/Resume/Cancel.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-durable-ui.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-durable-ui-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'notes.txt'), 'first line\n')
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const observations = []
const observe = (label, data = {}) => { const e = { at: new Date().toISOString(), label, ...data }; observations.push(e); console.log(`[${e.at}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`) }

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page
const launch = async () => { app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 }); page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on('dialog', d => d.accept()); await page.waitForFunction(() => Boolean(window.conductor?.durableJobs)) }
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
let owner, projectId
const call = async (method, args = {}) => {
  const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result
}
const status = jobId => call('jobs.status', { jobId })
const waitFor = async (jobId, predicate, label, timeout) => {
  let last
  await expect.poll(async () => predicate(last = await status(jobId)), { timeout, intervals: [1500] }).toBe(true)
  observe(label, { jobId, status: last.status, stage: last.currentStage?.title })
  return last
}

const STAGE_TIMEOUT = 20 * 60_000
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ root, observations }, null, 2)); process.exit(1) }, 40 * 60_000)
let failed = null
try {
  await launch()
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'V1 durable UI' })).id
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  await page.locator('.project-row').filter({ hasText: 'V1 durable UI' }).first().click()

  // ---- S17a: no persistent "Durable jobs" sidebar entry ----
  await page.screenshot({ path: join(output, 's17-sidebar.png') })
  const sidebarHasDurable = await page.locator('text=Durable jobs').count()
  record('S17-sidebar', sidebarHasDurable === 0 ? 'PASS' : 'FAIL', `"Durable jobs" text count in the visible sidebar/rail: ${sidebarHasDurable} (code evidence: src/renderer/src/layout/PaneWorkspace.tsx only reaches DurableJobsPane/DurableJobPanel through an opened job-kind tab, not a rail icon)`)

  // ---- S17b: the launcher's local-model durable option ----
  // A fresh empty workspace already shows the launcher; no need to open a new tab for it (doing so
  // caused the pane to stay hidden -- there was nothing to duplicate a tab from yet).
  await page.locator('.launcher-grid').first().waitFor({ timeout: 20_000 }).catch(async () => { await page.keyboard.press('Control+KeyT'); await page.locator('.launcher-grid').first().waitFor({ timeout: 15_000 }) })
  await page.getByLabel('Local model for durable work', { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {})
  const hasOption = await page.locator('.launcher-durable-option').count()
  record('S17-launcher-option', hasOption > 0 ? 'PASS' : 'FAIL', `.launcher-durable-option present in the launcher: ${hasOption > 0}`)
  await page.screenshot({ path: join(output, 's17-launcher.png') })
  await page.keyboard.press('Escape')

  // ---- S17c: create the job through app-control (equivalent to filling the launcher form), open its tab ----
  const job = await call('jobs.create', { title: 'V1 durable UI smoke', model: MODEL, objective: 'Append the line "durable smoke" to notes.txt and commit it.', constraints: ['Only edit notes.txt'], stages: [{ title: 'Append', objective: 'Append the line "durable smoke" to notes.txt', completionCriteria: ['notes.txt ends with durable smoke'] }] })
  observe('job created', { jobId: job.id })
  const tab = await call('tabs.open', { kind: 'job', jobId: job.id })
  await page.locator(`.durable-job[data-job-id="${job.id}"]`).first().waitFor({ timeout: 30_000 })
  await waitFor(job.id, s => s.status === 'running' && Boolean(s.currentStage), 'job running a stage', STAGE_TIMEOUT)
  await page.screenshot({ path: join(output, 's17-job-progress.png') })
  record('S17-job-tab', 'PASS', `job tab shows progress for ${job.id} (DurableJobPanel), tabId=${tab.id}`)

  // ---- S17d: Pause, Resume, Cancel from the tab, screenshot + jobs.status after each ----
  await page.getByRole('button', { name: /^Pause$/ }).first().click()
  const paused = await waitFor(job.id, s => s.status === 'paused', 'paused from the tab', 60_000)
  await page.screenshot({ path: join(output, 's17-paused.png') })
  record('S17-pause', paused.status === 'paused' ? 'PASS' : 'FAIL', `status after clicking Pause: ${paused.status}`)

  await page.getByRole('button', { name: /^Resume$/ }).first().click()
  const resumed = await waitFor(job.id, s => s.status === 'running' || s.status === 'completed', 'resumed from the tab', 60_000)
  await page.screenshot({ path: join(output, 's17-resumed.png') })
  record('S17-resume', ['running', 'completed'].includes(resumed.status) ? 'PASS' : 'FAIL', `status after clicking Resume: ${resumed.status}`)

  await waitFor(job.id, s => ['completed', 'blocked', 'failed'].includes(s.status), 'job settled before cancel test', STAGE_TIMEOUT).catch(() => {})
  const secondJob = await call('jobs.create', { title: 'V1 durable UI smoke: cancel target', model: MODEL, objective: 'Wait.' })
  const secondTab = await call('tabs.open', { kind: 'job', jobId: secondJob.id })
  await page.locator(`.durable-job[data-job-id="${secondJob.id}"]`).first().waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /^Cancel$/ }).first().click()
  const cancelled = await waitFor(secondJob.id, s => s.status === 'cancelled', 'cancelled from the tab', 60_000)
  await page.screenshot({ path: join(output, 's17-cancelled.png') })
  record('S17-cancel', cancelled.status === 'cancelled' ? 'PASS' : 'FAIL', `status after clicking Cancel: ${cancelled.status}`)

  // ---- S18: contention -- a small durable job, then a >=5 min interactive local turn ----
  const contentionJob = await call('jobs.create', { title: 'V1 contention smoke', model: MODEL, objective: 'Append the line "contention smoke" to notes.txt.', stages: [{ title: 'Append', objective: 'Append the line "contention smoke" to notes.txt', completionCriteria: ['notes.txt ends with contention smoke'] }] })
  observe('contention job created', { jobId: contentionJob.id })
  // Driven through app-control directly (not the launcher UI) -- clicking through a new tab here
  // was flaky (Ctrl+T's target pane after a job tab stayed hidden); the interactive turn itself,
  // not how it was opened, is what S18 needs.
  const interactiveId = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S18 interactive' }).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: interactiveId, prompt: 'Write a detailed 4000-word essay about the history of clocks, covering mechanical, electronic and atomic clocks.' })
  const contentionEvents = []
  const start = Date.now()
  const poller = setInterval(async () => { try { const s = await status(contentionJob.id); contentionEvents.push({ atMs: Date.now() - start, status: s.status, statusReason: s.statusReason, lastEvent: s.lastEvent?.message?.slice(0, 150) }) } catch {} }, 5000)
  // Let the interactive turn run for >= 5 minutes while watching the job.
  await new Promise(r => setTimeout(r, 5 * 60_000 + 15_000))
  clearInterval(poller)
  const duringInteractive = await status(contentionJob.id)
  observe('contention job status while interactive turn ran >=5min', { status: duringInteractive.status, statusReason: duringInteractive.statusReason, sampleCount: contentionEvents.length })
  await writeFile(join(output, 's18-contention-events.json'), JSON.stringify(contentionEvents, null, 2))
  const waitedVisibly = contentionEvents.some(e => /wait|busy|slot|another|local model/i.test(e.statusReason ?? '') || e.status === 'blocked')
  const neverStuckSilently = !(duringInteractive.status === 'running' && !duringInteractive.currentStage && !waitedVisibly)
  const settledAfter = await waitFor(contentionJob.id, s => ['completed', 'blocked', 'failed'].includes(s.status), 'contention job settled after the interactive turn', STAGE_TIMEOUT).catch(e => { observe('contention job never settled', { message: e.message }); return null })
  record('S18', settledAfter?.status === 'completed' || (waitedVisibly && settledAfter) ? 'PASS' : 'FAIL', `during contention: status=${duringInteractive.status} reason=${duringInteractive.statusReason ?? '(none)'}; waitedVisibly=${waitedVisibly}; final=${settledAfter?.status ?? 'never settled'}`)
} catch (error) {
  failed = error
  record('durable-ui-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
  try { app?.process().kill() } catch {}
  await writeFile(join(output, 's17-s18-results.json'), JSON.stringify({ results, observations }, null, 2))
  console.log('\n=== S17/S18 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed) process.exit(1)
