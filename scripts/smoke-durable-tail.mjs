import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// Restart acceptance for F4: the durable-job detail view shows the newest events of a job whose
// history is longer than 20,000 events. The built app runs parked off-screen under
// CONDUCTOR_TEST_USER_DATA on a temp profile, driven as the owner through control-owner.json
// against a loopback stub model (the hooks of scripts/smoke-durable-jobs.mjs). A one-stage job
// completes, the app closes, 20,500 notes plus an early and a late `retry` marker are written into
// the closed profile's conductor.db, and the app is relaunched on the same profile. The detail IPC
// must return exactly the newest 200 events in order, ending with the late marker, and the job tab
// must list the late marker (a problem kind) and not the early one.
//
//   node scripts/smoke-durable-tail.mjs [--keep]
// The JSON summary is printed and written to artifacts/f4/smoke-summary.json.

const FILLERS = 20_500
const keep = process.argv.includes('--keep')
const model = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-durable-tail-'))
const output = resolve('artifacts/f4')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

/** conductor.db of exactly this run's temp profile; never %APPDATA%\Conductor or a link elsewhere. */
function isolatedDatabase() {
  const real = realpathSync(profile)
  const fromTemp = relative(realpathSync(tmpdir()), real)
  if (!fromTemp || fromTemp.startsWith('..') || isAbsolute(fromTemp)) throw new Error('profile must be strictly inside the temp dir')
  const owner = process.env.APPDATA ? resolve(process.env.APPDATA, 'Conductor').toLowerCase() : null
  if (owner && (real.toLowerCase().startsWith(owner) || owner.startsWith(real.toLowerCase()))) throw new Error('profile must not be or contain %APPDATA%\\Conductor')
  const dbPath = join(real, 'conductor.db')
  if (!existsSync(dbPath) || realpathSync(dbPath).toLowerCase() !== dbPath.toLowerCase()) throw new Error(`refusing ${dbPath}`)
  return dbPath
}

/** One IMMEDIATE transaction of store-shaped events (store.ts insertEvent) into the closed profile. */
function seed(jobId) {
  const db = new DatabaseSync(isolatedDatabase())
  db.exec('PRAGMA busy_timeout = 3000')
  const now = Date.now(), start = now - 6 * 60 * 60_000
  const insert = db.prepare('INSERT INTO durable_job_events (id, job_id, at, kind, data) VALUES (?, ?, ?, ?, ?)')
  let n = 0
  const push = (at, kind, message, data) => {
    const event = { id: `jobevt_f4seed_${String(n++).padStart(5, '0')}`, jobId, at: new Date(at).toISOString(), kind, message, data }
    insert.run(event.id, jobId, event.at, kind, JSON.stringify(event))
    return event
  }
  try {
    db.exec('BEGIN IMMEDIATE')
    const early = push(start, 'retry', 'F4 early marker: seeded before 20,500 fillers', { f4: 'early' })
    for (let i = 0; i < FILLERS; i++) push(start + 60_000 + Math.floor((now - 120_000 - start) * i / FILLERS), 'note', `F4 filler ${i}`, { f4: 'filler' })
    const late = push(now - 1_000, 'retry', 'F4 late marker: seeded after 20,500 fillers', { f4: 'late' })
    db.exec('COMMIT')
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM durable_job_events WHERE job_id = ?').get(jobId).n)
    return { early, late, total }
  } catch (error) { db.exec('ROLLBACK'); throw error }
  finally { db.close() }
}

const projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Durable tail smoke\n')
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

// Stub model: every stage is done at once, so the job completes and its history is quiet.
let stubRequests = 0
const stub = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
    const send = payload => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.url?.startsWith('/health')) return send({ status: 'ok' })
    if (request.url?.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: model, object: 'model' }] })
    stubRequests++
    const content = 'Nothing to do for this stage.\nJOB STATUS: DONE'
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    if (!body.stream) return send({ id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = payload => response.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, ...payload })}\n\n`)
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    chunk({ choices: [], usage })
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => stub.listen(0, '127.0.0.1', done))
const stubEndpoint = `http://127.0.0.1:${stub.address().port}`

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: stubEndpoint }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page, owner, projectId
const launch = async label => {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') observe('page error', { message: error.message }) })
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  observe(label, { pid: app.process().pid })
}
const close = async label => {
  const pid = app.process().pid
  await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
  try { app.process().kill() } catch { /* exited */ }
  await expect.poll(() => { try { process.kill(pid, 0); return false } catch { return true } }, { timeout: 30_000 }).toBe(true)
  observe(label, { pid })
}
const call = async (method, args = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const credential = async () => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
  return JSON.parse(await readFile(path, 'utf8'))
}
/** The owner window's own detail IPC (the job view's data source), timed in the renderer. */
const detail = jobId => page.evaluate(async ({ projectId, jobId }) => {
  const started = performance.now()
  const result = await window.conductor.durableJobs.detail(projectId, jobId)
  return { ms: Math.round(performance.now() - started), events: result.events.map(event => ({ id: event.id, kind: event.kind, message: event.message, at: event.at })) }
}, { projectId, jobId })

const summary = { root, profile, stubEndpoint, build: resolve('out/main/index.js'), fillers: FILLERS }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 8 * 60_000)
let failed = null
try {
  await launch('app launched (parked)')
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'Durable tail smoke' })).id
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  await page.locator('.project-row').filter({ hasText: 'Durable tail smoke' }).first().click()
  const job = await call('jobs.create', {
    title: 'F4 tail', model, objective: 'Confirm the README exists.',
    stages: [{ title: 'Check', objective: 'Confirm README.md exists', completionCriteria: ['README.md exists'] }]
  })
  summary.jobId = job.id
  await expect.poll(async () => (await call('jobs.status', { jobId: job.id })).status, { timeout: 90_000, intervals: [1000] }).toBe('completed')
  const before = await detail(job.id)
  observe('job completed before restart', { events: before.events.length, last: before.events.at(-1)?.message })
  await close('app closed')

  const seeded = seed(job.id)
  summary.seeded = { total: seeded.total, early: seeded.early.id, late: seeded.late.id }
  observe('history seeded in the closed profile', summary.seeded)
  assert.ok(seeded.total > 20_000)

  await launch('app relaunched on the same profile')
  // The relaunched app serves control on a new endpoint; wait until the credential file names it.
  await expect.poll(async () => { try { owner = await credential(); await call('tools.list'); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  await page.locator('.project-row').filter({ hasText: 'Durable tail smoke' }).filter({ hasNotText: '· job' }).first().click()
  const after = await detail(job.id)
  const again = await detail(job.id)
  summary.detail = { count: after.events.length, first: after.events[0]?.message, last: after.events.at(-1)?.message, ms: [after.ms, again.ms] }
  observe('detail after relaunch', summary.detail)
  assert.equal(after.events.length, 200)
  assert.equal(after.events.at(-1).id, seeded.late.id, 'the newest event of the detail is not the late marker')
  assert.deepEqual(after.events.map(event => event.message), [...Array.from({ length: 199 }, (_, i) => `F4 filler ${FILLERS - 199 + i}`), seeded.late.message])
  assert.ok(after.events.every((event, i, all) => i === 0 || all[i - 1].at <= event.at), 'detail events are not chronological')
  assert.ok(!after.events.some(event => event.id === seeded.early.id))
  const status = await call('jobs.status', { jobId: job.id })
  assert.equal(status.lastEvent?.message, seeded.late.message)

  const tab = await call('tabs.open', { kind: 'job', jobId: job.id })
  observe('job tab opened', { tabId: tab?.id, resourceId: tab?.resourceId })
  const view = page.locator(`.durable-job[data-job-id="${job.id}"]`).first()
  await view.waitFor()
  await expect(view).toContainText('F4 late marker', { timeout: 20_000 })
  assert.equal(await view.getByText('F4 early marker').count(), 0, 'the job view lists the early marker')
  await page.screenshot({ path: join(output, 'job-tab-after-restart.png') }).catch(() => {})
  observe('job tab shows the late marker after restart')
  observe('PASS')
} catch (error) {
  failed = error
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1200) })
} finally {
  clearTimeout(watchdog)
  if (app) { await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))]); try { app.process().kill() } catch { /* exited */ } }
  stub.close()
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', stubRequests, observations }
await writeFile(join(output, 'smoke-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
if (failed) process.exit(1)
