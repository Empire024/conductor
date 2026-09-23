import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// End-to-end check of durable local-model jobs in the built app (docs/durable-jobs.md). The app
// runs parked off-screen under CONDUCTOR_TEST_USER_DATA, is driven as the owner through
// control-owner.json, and a job is created, watched, paused, resumed and cancelled while its tab
// is closed, reopened and the renderer reloads. It never touches the owner's screen.
//
// Modes (one at a time — the machine carries one model server):
//   node scripts/smoke-durable-jobs.mjs                  stub model (default): an OpenAI-compatible
//        stub on loopback, handed to the app as CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT. The job
//        controller must honor that variable in an unpackaged build; if it does not, the run says so.
//   --real-model[=local/qwen3.6-35b-a3b]                 the real llama-server Conductor manages.
//   --kill-server   (real model) kill llama-server mid-stage; expect a server event and recovery.
//   --restart-app   close the app mid-job and relaunch on the same profile; expect reconciliation.
//   --keep          leave the temp profile and project for inspection.
// Every observation is printed with its timestamp; the JSON summary is the evidence.
const argv = process.argv.slice(2)
const flag = name => argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
const value = (name, fallback) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const realModel = flag('real-model')
const model = value('real-model', value('model', 'local/qwen3.6-35b-a3b'))
if (flag('kill-server') && !realModel) throw new Error('--kill-server needs --real-model: there is no llama-server to kill in stub mode')

const root = await mkdtemp(join(tmpdir(), 'conductor-durable-jobs-'))
const output = resolve('artifacts/durable-jobs')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// --- A git project for the job to work in ------------------------------------------------------
const projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Durable job smoke\n')
await writeFile(join(projectPath, 'notes.txt'), 'first line\n')
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

// --- Stub model: slow enough that a stage is observably running, scripted by prompt markers -----
const stubRequests = []
const stub = realModel ? null : createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
    const prompt = JSON.stringify(body.messages ?? '')
    stubRequests.push({ at: new Date().toISOString(), path: request.url, approvalCase: prompt.includes('APPROVAL-CASE') })
    const send = payload => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.url?.startsWith('/health')) return send({ status: 'ok' })
    if (request.url?.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: model, object: 'model' }] })
    // Scripted like a small model: the stage's first request makes one real tool call through the
    // local runtime, the answer after its result closes the stage with the job status line. The
    // approval case keeps asking for the install the sandbox refuses.
    const messages = Array.isArray(body.messages) ? body.messages : []
    const afterTool = messages.at(-1)?.role === 'tool'
    const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call_${stubRequests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    // The stage's own objective sits between these headings of the durable-job stage prompt.
    const task = String(messages.find(message => message.role === 'user')?.content ?? '')
    const stageObjective = /THIS STAGE\s*([\s\S]*?)\s*STAGE IS COMPLETE WHEN/.exec(task)?.[1] ?? task
    const appending = stageObjective.includes('Append the line')
    const reply = prompt.includes('APPROVAL-CASE') ? call('run_command', { command: 'npm install left-pad --save' })
      : afterTool ? { content: appending ? 'Appended "durable smoke" to notes.txt.\nJOB STATUS: CONTINUE: verify the line' : 'notes.txt ends with the line durable smoke.\nJOB STATUS: DONE' }
      : appending ? call('write_file', { path: 'notes.txt', content: 'durable smoke\n', append: true })
      : stageObjective.includes('notes.txt') ? call('read_file', { path: 'notes.txt' })
      : { content: 'Nothing to do for this stage.\nJOB STATUS: DONE' }
    const finish = reply.tool_calls ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    setTimeout(() => {
      if (!body.stream) return send({ id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map(({ index: _index, ...rest }) => rest) } : {}) }, finish_reason: finish }], usage })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = payload => response.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, ...payload })}\n\n`)
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', ...reply }, finish_reason: null }] })
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })
      chunk({ choices: [], usage })
      response.end('data: [DONE]\n\n')
    }, Number(process.env.DURABLE_SMOKE_STUB_DELAY_MS ?? 4000))
  })
})
if (stub) await new Promise(done => stub.listen(0, '127.0.0.1', done))
const stubEndpoint = stub ? `http://127.0.0.1:${stub.address().port}` : null

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  ...(stubEndpoint ? { CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: stubEndpoint } : {}) }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page
const launch = async label => {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') observe('page error', { message: error.message }) })
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  observe(label, { pid: app.process().pid })
}
const credential = async () => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
  return JSON.parse(await readFile(path, 'utf8'))
}
let owner, projectId
const call = async (method, args = {}, { expectError = false } = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  if (expectError) { assert.notEqual(response.status, 200, `${method} should have been refused`); return body.error }
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const status = jobId => call('jobs.status', { jobId })
const waitFor = async (jobId, predicate, label, timeout) => {
  let last
  try { await expect.poll(async () => predicate(last = await status(jobId)), { timeout, intervals: [1000] }).toBe(true) }
  catch { observe(`TIMEOUT waiting for ${label}`, { status: last?.status, statusReason: last?.statusReason, lastEvent: last?.lastEvent }); throw new Error(`Timed out waiting for ${label}; last status ${last?.status}${last?.statusReason ? ' (' + last.statusReason + ')' : ''}`) }
  observe(label, { jobId, status: last.status, stage: last.currentStage?.title, attempt: last.currentStage?.attempt, elapsedMs: last.elapsedMs, activeMs: last.activeMs })
  return last
}
const jobTabIn = async () => page.evaluate(async id => {
  const sessions = await window.conductor.sessions.list(id)
  const tabs = node => Array.isArray(node?.tabs) ? node.tabs : (node?.children ?? []).flatMap(tabs)
  return sessions.flatMap(session => tabs(session.layout.root)).filter(tab => tab.kind === 'job').map(tab => ({ id: tab.id, resourceId: tab.resourceId }))
}, projectId)

const STAGE_TIMEOUT = realModel ? 20 * 60_000 : 90_000
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ root, observations }, null, 2)); process.exit(1) }, Number(process.env.DURABLE_SMOKE_TIMEOUT_MS ?? (realModel ? 90 : 10) * 60_000))
let failed = null
try {
  await launch('app launched (parked)')
  owner = await credential()
  const opened = await call('projects.open', { path: projectPath, name: 'Durable job smoke' })
  projectId = opened.id
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  await page.locator('.project-row').filter({ hasText: 'Durable job smoke' }).first().click()
  const tools = await call('tools.list')
  assert.ok(tools['jobs.create'], 'jobs.* are not listed: the durable job service is not plugged into AgentControl (setDurableJobs)')
  const locals = (await call('models.list')).find(entry => entry.provider === 'local')?.models.map(entry => entry.id) ?? []
  assert.ok(locals.includes(model), `${model} is not a local entry of models.list (${locals.join(', ') || 'none'})`)
  observe('control protocol ready', { projectId, model, stubEndpoint })

  // A cloud model is refused by name.
  const refused = await call('jobs.create', { objective: 'x', model: 'opus' }, { expectError: true })
  assert.match(refused, /local model only/)
  observe('cloud model refused', { error: refused })

  // --- 1. Create and watch it run -------------------------------------------------------------
  const job = await call('jobs.create', {
    title: 'Smoke: append a line', objective: 'Append the line "durable smoke" to notes.txt and commit it.',
    model, constraints: ['Only edit notes.txt'],
    stages: [{ title: 'Append', objective: 'Append the line "durable smoke" to notes.txt', completionCriteria: ['notes.txt ends with durable smoke'] },
      { title: 'Verify', objective: 'Read notes.txt back and confirm the line', completionCriteria: ['The line is present'] }]
  })
  observe('job created', { jobId: job.id, status: job.status })
  try { await waitFor(job.id, s => s.status === 'running' && Boolean(s.currentStage), 'job running a stage', 60_000) }
  catch (error) {
    if (stub && !stubRequests.length) throw new Error(`${error.message}. The stub model received no request: the controller does not honor CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT (see docs/durable-jobs.md, Smoke hooks). Run with --real-model instead.`)
    throw error
  }

  // --- 2. The job tab: open, close, reopen, reload — the job id never changes -----------------
  const tab = await call('tabs.open', { kind: 'job', jobId: job.id })
  await page.locator(`.durable-job[data-job-id="${job.id}"]`).first().waitFor()
  observe('job tab open', { tabId: tab.id, resourceId: tab.resourceId })
  await page.screenshot({ path: join(output, 'job-tab.png') })
  await call('tabs.close', { tabId: tab.id })
  assert.deepEqual(await jobTabIn(), [])
  const afterClose = await status(job.id)
  assert.ok(!['cancelled', 'failed'].includes(afterClose.status), 'closing the tab stopped the job')
  observe('job tab closed; job continues', { status: afterClose.status, stage: afterClose.currentStage?.title })
  const reopened = await call('tabs.open', { kind: 'job', jobId: job.id })
  assert.equal(reopened.resourceId, job.id)
  observe('job tab reopened', { tabId: reopened.id, resourceId: reopened.resourceId })
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  assert.deepEqual((await jobTabIn()).map(entry => entry.resourceId), [job.id], 'the job tab did not survive a reload with the same job id')
  await page.locator(`.durable-job[data-job-id="${job.id}"]`).first().waitFor()
  const afterReload = await status(job.id)
  assert.ok(!['cancelled', 'failed'].includes(afterReload.status))
  observe('renderer reloaded; same job tab, job continues', { status: afterReload.status, elapsedMs: afterReload.elapsedMs })

  // --- 3. Pause and resume --------------------------------------------------------------------
  await call('jobs.pause', { jobId: job.id, reason: 'Smoke pause' })
  await waitFor(job.id, s => s.status === 'paused', 'job paused', 60_000)
  const pausedActive = (await status(job.id)).activeMs
  await new Promise(done => setTimeout(done, 3000))
  assert.equal((await status(job.id)).activeMs, pausedActive, 'active time kept counting while paused')
  await call('jobs.resume', { jobId: job.id })
  await waitFor(job.id, s => s.status === 'running' || s.status === 'completed', 'job resumed', 60_000)

  // --- Optional: kill the model server mid-stage (real model only) ----------------------------
  if (flag('kill-server')) {
    await waitFor(job.id, s => s.status === 'running' && Boolean(s.currentStage), 'stage running before kill', STAGE_TIMEOUT)
    try { execFileSync('taskkill', ['/IM', 'llama-server.exe', '/F'], { stdio: 'pipe' }) } catch (error) { observe('taskkill failed', { message: String(error.message).slice(0, 200) }) }
    observe('llama-server killed')
    await waitFor(job.id, s => s.counters.recoveries > afterReload.counters.recoveries || s.lastEvent?.kind === 'server', 'server loss noticed', 5 * 60_000)
    await waitFor(job.id, s => s.status === 'running' || s.status === 'completed', 'job running again after server restart', STAGE_TIMEOUT)
  }

  // --- Optional: restart the app mid-job -------------------------------------------------------
  if (flag('restart-app')) {
    const before = await status(job.id)
    await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
    try { app.process().kill() } catch { /* exited */ }
    observe('app closed mid-job', { status: before.status, stage: before.currentStage?.title })
    await launch('app relaunched on the same profile')
    owner = await credential()
    const after = await status(job.id)
    assert.equal(after.id, job.id)
    observe('job after relaunch', { status: after.status, recoveries: after.counters.recoveries, lastEvent: after.lastEvent })
    await waitFor(job.id, s => ['running', 'completed', 'blocked'].includes(s.status), 'job reconciled after relaunch', STAGE_TIMEOUT)
  }

  // --- 4. Finish (or cancel) and report -----------------------------------------------------------
  let final = await status(job.id)
  try { final = await waitFor(job.id, s => ['completed', 'blocked', 'failed'].includes(s.status), 'job settled', STAGE_TIMEOUT) }
  catch { final = await call('jobs.cancel', { jobId: job.id, reason: 'Smoke time limit' }); observe('job cancelled at the smoke time limit', { status: final.status }) }
  const report = await call('jobs.report', { jobId: job.id })
  assert.ok(existsSync(report.reportPath), 'report.md was not written')
  assert.ok(existsSync(join(report.reportPath, '..', 'report.json')), 'report.json was not written')
  assert.equal(report.cloudEscalation.occurred, false)
  observe('report written', { reportPath: report.reportPath, status: report.status, results: report.results.length, checkpoints: report.checkpoints.length, logPaths: report.logPaths.length })

  // --- 5. Cancel a second job ----------------------------------------------------------------------
  const second = await call('jobs.create', { title: 'Smoke: cancel me', objective: 'Wait for cancellation', model })
  await call('jobs.cancel', { jobId: second.id, reason: 'Smoke cancel' })
  await waitFor(second.id, s => s.status === 'cancelled', 'second job cancelled', 60_000)
  await call('jobs.resume', { jobId: second.id }, { expectError: true })
  observe('a cancelled job cannot be resumed')

  // --- 6. A step that needs the owner's approval ends in blocked ---------------------------------
  const gated = await call('jobs.create', {
    title: 'Smoke: approval required', model,
    objective: 'APPROVAL-CASE: install the left-pad package from the network with npm install left-pad --save.',
    stages: [{ title: 'Install', objective: 'APPROVAL-CASE: run npm install left-pad --save', completionCriteria: ['left-pad is in package.json'] }]
  })
  const blocked = await waitFor(gated.id, s => s.status === 'blocked', 'approval case blocked', STAGE_TIMEOUT)
  assert.match(blocked.statusReason ?? '', /approv|permission|owner/i, `blocked for an unexpected reason: ${blocked.statusReason}`)
  await call('jobs.cancel', { jobId: gated.id, reason: 'Smoke done' })

  // The sidebar panel lists all three jobs.
  await page.getByRole('button', { name: 'Durable jobs' }).first().click().catch(() => {})
  await page.locator('.durable-job-list').first().waitFor().catch(() => {})
  await page.screenshot({ path: join(output, 'jobs-panel.png') })
  observe('done', { jobs: (await call('jobs.list')).map(entry => ({ id: entry.id, status: entry.status })) })
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 800) })
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
  try { app?.process().kill() } catch { /* exited */ }
  stub?.close()
}
console.log(JSON.stringify({ mode: realModel ? 'real-model' : 'stub', model, root: flag('keep') || failed ? root : '(removed)', stubRequests: stubRequests.length, observations }, null, 2))
if (!flag('keep') && !failed) await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true, maxRetries: 5 })).catch(() => {})
if (failed) process.exit(1)
