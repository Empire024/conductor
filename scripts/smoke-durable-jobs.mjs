import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { acceptanceFailures, auditSoak } from './lib/durable-attempt-audit.mjs'
import { stopDurableSmokeServer } from './lib/stop-durable-smoke-server.mjs'
import { assertBuildHash, identityOf, listProcesses, newInstance, registerPlaywrightRoots, safeClose, sameIdentity, startTracking, terminateIdentity } from './verify-kit.mjs'

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
//   --kill-server   (real model) stop this parked app's llama-server mid-stage; expect recovery.
//   --restart-app   close the app mid-job and relaunch on the same profile; expect reconciliation.
//   --keep          leave the temp profile and project for inspection.
//   --fixture=crossref  six large modules to summarise and cross-reference over four stages, so the
//                   job must advance through several fresh contexts (use with --real-model).
//   --fixture=index 150 input files of ~2 KB each, one stage: append one line per file to
//                   INDEX.md, in order. A capable real model tends to solve this compactly (a
//                   script, not 150 individual reads) and stays well under the default
//                   contextRolloverFraction, so --soak forces the same lower fraction as crossref
//                   to make it roll over reliably; it is a single-stage counterpart to crossref's
//                   one-rollover-per-stage pattern (use with --real-model --soak).
//   --extras=none   stop after the main job's report (skip the cancel and approval jobs).
//   --loop-case, --stall-case  (stub) a job repeating one identical call, and one whose model never
//                   answers; both must end blocked within bounds.
//   --approval-gate (stub) only this: a job blocked on an approval must not keep local generation
//                   capacity — a second job runs to completion meanwhile — and after an app restart
//                   the first is still blocked with the same approval, resumes once the owner has
//                   done the step, and completes without a second approval.
//   --blocked-restart (stub) only this: a hard kill while a stage's run_command is running (Docker
//                   sleep) leaves the job for reconciliation, which blocks it on the unknown side
//                   effect with its stage still running; an owner pause in the seconds before that
//                   pass is refused. After a second restart the job is still blocked, nothing is
//                   rewritten, and one resume continues it once in a fresh conversation to completion.
//   --soak          (with --real-model --fixture=crossref or --fixture=index) only this: the
//                   fixture's job runs back to back, unattended, until the measured workload time
//                   reaches DURABLE_SOAK_WORKLOAD_MS (default 6h; iterations start only before
//                   that, the last one is bounded by the stage timeout, and the overall watchdog is
//                   workload + stage timeout + 10 minutes of cleanup - give smoke-lock at least that).
//                   Outputs are cleared before each iteration and a completed one is checked
//                   against the fixture's own truth. Both fixtures force a lower
//                   contextRolloverFraction so every iteration rolls over reliably. Asserts the
//                   measured workload, at least one rollover, two iterations and one content-
//                   verified completion; the stage-aware attempt audit
//                   (scripts/lib/durable-attempt-audit.mjs) over each job's full paged ledger must
//                   find no violation and no unprovable job, and a credited rollover that went on
//                   is reported EXERCISED or NOT EXERCISED. Per-stage ledgers are appended to
//                   artifacts/durable-jobs/soak-ledger.ndjson as each iteration settles.
//   --kill-server / --restart-app on the main job also require that same job to end completed with
//                   correct output: a report for blocked or cancelled work is not a recovery.
// Every observation is printed with its timestamp; the JSON summary is the evidence.
const argv = process.argv.slice(2)
const flag = name => argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
const value = (name, fallback) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const realModel = flag('real-model')
const model = value('real-model', value('model', 'local/qwen3.6-35b-a3b'))
if (flag('kill-server') && !realModel) throw new Error('--kill-server needs --real-model: there is no llama-server to kill in stub mode')
// --app=<abs path to out/main/index.js> --app-sha256=<hash>: launch exactly that build, hashed again
// right before each launch. Without --app, the checkout's out/main/index.js (unhashed, as before).
const appPath = resolve(value('app', 'out/main/index.js'))
const appSha256 = value('app-sha256', null)
if (flag('app') !== Boolean(appSha256)) throw new Error('--app and --app-sha256 go together: a named build is launched only with its hash')
// --acceptance: the uninterrupted control for a fault run; like --kill-server/--restart-app it
// requires the same job to complete with correct output.
const acceptanceRun = flag('acceptance') || flag('kill-server') || flag('restart-app')

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
// --fixture=crossref: six ~1,100-line modules that call into each other, so summarising and
// cross-referencing them cannot fit one 32,768-token context and the job has to advance through
// several fresh ones.
const fixture = value('fixture', 'append')
const MODULES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
if (fixture === 'crossref') {
  await mkdir(join(projectPath, 'modules'), { recursive: true })
  for (const [index, name] of MODULES.entries()) {
    const next = MODULES[(index + 1) % MODULES.length], other = MODULES[(index + 3) % MODULES.length]
    const lines = [`// Module ${name}: part of the durable-job cross-reference fixture.`, `import { ${next}Transform0, ${next}Check0 } from './${next}.js'`, `import { ${other}Transform1 } from './${other}.js'`, '']
    for (let fn = 0; fn < 60; fn++) {
      lines.push(`/** ${name}Transform${fn}: folds a record list into the ${name} ledger (variant ${fn}). */`, `export function ${name}Transform${fn}(records, options = {}) {`, `  const limit = options.limit ?? ${100 + fn}`, '  const out = []', '  for (const record of records.slice(0, limit)) {', `    if (!${name}Check${fn}(record)) continue`, `    out.push({ ...record, ledger: '${name}', weight: record.weight * ${fn + 1} })`, '  }', fn % 7 === 0 ? `  return ${next}Transform0(out)` : fn % 11 === 0 ? `  return ${other}Transform1(out)` : '  return out', '}', '', `export function ${name}Check${fn}(record) {`, `  return Boolean(record) && typeof record.weight === 'number' && record.weight > ${fn % 5}${fn % 13 === 0 ? ` && ${next}Check0(record)` : ''}`, '}', '', '')
    }
    await writeFile(join(projectPath, 'modules', `${name}.js`), lines.join('\n'))
  }
}
// --fixture=index: 150 input files of ~2 KB each, one line per file into INDEX.md, in order. One
// stage, at the DEFAULT contextRolloverFraction (unlike crossref's soak override): reading all 150
// files' unique tokens plus the growing INDEX.md needs at least 4 fresh contexts on its own, so a
// rollover with real file progress must not spend an attempt (docs/verification/2026-09-24-v1-local-models.md,
// "Durable jobs: judgement on the soak").
const INDEX_FILE_COUNT = 150
if (fixture === 'index') {
  await mkdir(join(projectPath, 'inputs'), { recursive: true })
  for (let i = 1; i <= INDEX_FILE_COUNT; i++) {
    const name = `file${String(i).padStart(3, '0')}.txt`
    const token = `TOKEN-${String(i).padStart(3, '0')}`
    const lines = [`Input file ${name} for the durable-job INDEX fixture.`, `Unique token: ${token}`]
    while (lines.join('\n').length < 2_000) lines.push(`filler ${lines.length} for ${name}: ${'x'.repeat(60)}`)
    await writeFile(join(projectPath, 'inputs', name), lines.join('\n') + '\n')
  }
}
/** What a correct run of the fixture leaves in the project, checked against the fixture's own
 *  construction (not against the model's claims). Returns the list of problems; empty is correct. */
const outputProblems = async () => {
  const read = async path => { try { return await readFile(join(projectPath, path), 'utf8') } catch { return null } }
  const problems = []
  if (fixture === 'crossref') {
    for (const name of MODULES) if (!(await read(`notes/${name}.md`))?.trim()) problems.push(`notes/${name}.md missing or empty`)
    const table = (await read('CROSSREF.md')) ?? ''
    if (!table.trim()) problems.push('CROSSREF.md missing or empty')
    const lines = table.split(/\r?\n/).map(line => line.toLowerCase())
    for (const [index, name] of MODULES.entries()) {
      const next = MODULES[(index + 1) % MODULES.length], other = MODULES[(index + 3) % MODULES.length]
      for (const [from, fns] of [[next, [`${next}Transform0`, `${next}Check0`]], [other, [`${other}Transform1`]]])
        if (!lines.some(line => line.includes(name) && line.includes(from) && fns.every(fn => line.includes(fn.toLowerCase())))) problems.push(`CROSSREF.md has no row: ${name} imports ${fns.join(', ')} from ${from}`)
    }
  } else if (fixture === 'index') {
    const lines = ((await read('INDEX.md')) ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const expected = Array.from({ length: INDEX_FILE_COUNT }, (_, i) => `file${String(i + 1).padStart(3, '0')}.txt: TOKEN-${String(i + 1).padStart(3, '0')}`)
    if (lines.length !== expected.length) problems.push(`INDEX.md has ${lines.length} lines, expected ${expected.length}`)
    const wrong = expected.findIndex((line, i) => lines[i] !== line)
    if (wrong >= 0) problems.push(`INDEX.md line ${wrong + 1} is ${JSON.stringify(lines[wrong] ?? null)}, expected ${JSON.stringify(expected[wrong])}`)
  } else if (!/(^|\n)durable smoke\s*$/.test((await read('notes.txt')) ?? '')) problems.push('notes.txt does not end with the line durable smoke')
  return problems
}
/** Clears the fixture's outputs so each soak iteration's content is its own work. */
const clearOutputs = async () => {
  for (const path of fixture === 'crossref' ? ['notes', 'CROSSREF.md'] : fixture === 'index' ? ['INDEX.md'] : []) await rm(join(projectPath, path), { recursive: true, force: true })
}
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

/** Electron processes (main, GPU, renderer, utility) still running on this run's profile. */
const profileProcesses = () => {
  const list = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], { encoding: 'utf8', timeout: 10_000 })
  return list.split(/\r?\n/).filter(line => line.toLowerCase().includes(root.toLowerCase())).map(line => Number(line.split('\t')[0]))
}

// --- Stub model: slow enough that a stage is observably running, scripted by prompt markers -----
const stubRequests = []
// --approval-gate: set once the "owner" has done the refused step; the approval case then finishes.
let approvalGranted = false
// --blocked-restart: set once the job has been reconciled and restarted; the fresh attempt then finishes.
let toolReleased = false
const stub = realModel ? null : createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
    const prompt = JSON.stringify(body.messages ?? '')
    stubRequests.push({ at: new Date().toISOString(), path: request.url, approvalCase: prompt.includes('APPROVAL-CASE'), blockedRestartCase: prompt.includes('BLOCKED-RESTART-CASE') })
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
    // STALL-CASE never answers; LOOP-CASE repeats one identical read forever.
    if (prompt.includes('STALL-CASE')) return
    const reply = prompt.includes('BLOCKED-RESTART-CASE') ? (toolReleased || afterTool ? { content: 'The slow step is settled; nothing is left to do.\nJOB STATUS: DONE' } : call('run_command', { command: 'sleep 120' }))
      : prompt.includes('APPROVAL-CASE') && approvalGranted ? { content: 'left-pad is installed; the owner ran the install.\nJOB STATUS: DONE' }
      : prompt.includes('APPROVAL-CASE') ? call('run_command', { command: 'npm install left-pad --save' })
      : prompt.includes('LOOP-CASE') ? call('read_file', { path: 'README.md' })
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

let app, page, owner, projectId, instance
const credential = async expectedPid => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(path, 'utf8')).pid } catch { return null }
  }, { timeout: 30_000 }).toBe(expectedPid)
  return JSON.parse(await readFile(path, 'utf8'))
}
const launch = async label => {
  // The granted build, re-hashed immediately before every launch (relaunches included), is the one
  // Electron gets: a shared out/ rebuilt between the grant and the launch is refused, not run.
  if (appSha256) assertBuildHash(appPath, appSha256)
  const spawnedAtMs = Date.now()
  app = await electron.launch({ args: [appPath], env, timeout: 60_000 })
  const launcherPid = app.process().pid
  // Cleanup authority is the launch's own OS identities (verify-kit roots), never a pid set.
  instance = newInstance({ name: 'durable-jobs', app, profile, root, build: appPath })
  const mainPid = await registerPlaywrightRoots(instance, app, { spawnedAtMs })
  startTracking(instance, { log: message => observe('tracking', { message }) })
  owner = await credential(mainPid)
  assert.equal(owner.pid, mainPid, 'parked owner credential does not name Electron main')
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') observe('page error', { message: error.message }) })
  await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
  observe(label, { launcherPid, mainPid })
}
const closeApp = async label => {
  if (!instance) return null
  const closed = await safeClose(instance)
  observe(label, { cleanup: closed })
  assert.deepEqual(closed.leftovers, [], `${label}: parked process tree survived cleanup`)
  assert.deepEqual(closed.unresolved, [], `${label}: cleanup could not account for every process`)
  await expect.poll(() => profileProcesses().length, { timeout: 10_000 }).toBe(0)
  instance = null
  return closed
}
const call = async (method, args = {}, { expectError = false } = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  if (expectError) { assert.notEqual(response.status, 200, `${method} should have been refused`); return body.error }
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const status = jobId => call('jobs.status', { jobId })
/** Every event of a job, paged to the end. `complete` only when the pages ran out on their own and
 *  the first event is the job's creation: a last-N slice is never proof of a whole ledger. */
const allEvents = async (jobId, maxPages = 500) => {
  const all = []
  for (let after, pages = 0; pages < maxPages; pages++) {
    const page = await call('jobs.events', { jobId, limit: 200, ...(after ? { afterId: after } : {}) })
    all.push(...page)
    if (page.length < 200) return { events: all, complete: all[0]?.kind === 'transition' && all[0]?.data?.to === 'queued' }
    after = page.at(-1).id
  }
  return { events: all, complete: false }
}
const waitFor = async (jobId, predicate, label, timeout) => {
  let last
  try { await expect.poll(async () => predicate(last = await status(jobId)), { timeout, intervals: [1000] }).toBe(true) }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    observe(`TIMEOUT waiting for ${label}`, { status: last?.status, statusReason: last?.statusReason, lastEvent: last?.lastEvent, error: reason })
    throw new Error(`Timed out waiting for ${label}; last status ${last?.status}${last?.statusReason ? ' (' + last.statusReason + ')' : ''}: ${reason}`)
  }
  observe(label, { jobId, status: last.status, stage: last.currentStage?.title, attempt: last.currentStage?.attempt, elapsedMs: last.elapsedMs, activeMs: last.activeMs })
  return last
}
const jobTabIn = async () => page.evaluate(async id => {
  const sessions = await window.conductor.sessions.list(id)
  const tabs = node => Array.isArray(node?.tabs) ? node.tabs : (node?.children ?? []).flatMap(tabs)
  return sessions.flatMap(session => tabs(session.layout.root)).filter(tab => tab.kind === 'job').map(tab => ({ id: tab.id, resourceId: tab.resourceId }))
}, projectId)

const STAGE_TIMEOUT = Number(process.env.DURABLE_SMOKE_STAGE_TIMEOUT_MS ?? (realModel ? 20 * 60_000 : 90_000))
const SOAK_WORKLOAD_MS = Number(process.env.DURABLE_SOAK_WORKLOAD_MS ?? 6 * 3_600_000)
// A soak's watchdog covers the whole workload, its bounded last iteration and ten minutes of
// cleanup; a smaller DURABLE_SMOKE_TIMEOUT_MS cannot cut the workload short.
const WATCHDOG_MS = flag('soak') ? Math.max(Number(process.env.DURABLE_SMOKE_TIMEOUT_MS ?? 0), SOAK_WORKLOAD_MS + STAGE_TIMEOUT + 10 * 60_000) : Number(process.env.DURABLE_SMOKE_TIMEOUT_MS ?? (realModel ? 90 : 10) * 60_000)
const watchdog = setTimeout(() => { observe('watchdog: giving up'); process.stdout.write(JSON.stringify({ root, observations }, null, 2) + '\n', () => process.exit(1)) }, WATCHDOG_MS)
let failed = null
try {
  await launch('app launched (parked)')
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

  // --- Approval gate: a blocked job releases generation capacity and survives a restart --------
  if (flag('approval-gate')) {
    if (!stub) throw new Error('--approval-gate scripts the stub model; run it without --real-model')
    const approvals = async jobId => (await call('jobs.events', { jobId, limit: 500 })).filter(event => event.kind === 'approval')
    const gated = await call('jobs.create', {
      title: 'Smoke: approval gate', model,
      objective: 'APPROVAL-CASE: install the left-pad package from the network with npm install left-pad --save.',
      stages: [{ title: 'Install', objective: 'APPROVAL-CASE: run npm install left-pad --save', completionCriteria: ['left-pad is installed'] }]
    })
    const blocked = await waitFor(gated.id, s => s.status === 'blocked', 'approval job blocked', STAGE_TIMEOUT)
    assert.match(blocked.statusReason ?? '', /approv|permission|owner/i, `blocked for an unexpected reason: ${blocked.statusReason}`)
    const approvalsBefore = await approvals(gated.id)
    assert.equal(approvalsBefore.length, 1, 'one approval event for the block')
    observe('approval recorded', { statusReason: blocked.statusReason, approval: approvalsBefore[0].message.slice(0, 200) })

    // Before the fix a blocked job could keep the generation gate and this job showed running forever.
    const second = await call('jobs.create', { title: 'Smoke: runs while the other is blocked', model, objective: 'Report that nothing needs doing.', stages: [{ title: 'Report', objective: 'Report that nothing needs doing', completionCriteria: ['An answer'] }] })
    await waitFor(second.id, s => s.status === 'completed', 'second job completed while the first stays blocked', STAGE_TIMEOUT)
    assert.equal((await status(gated.id)).status, 'blocked', 'the blocked job moved while the second ran')

    await closeApp('approval restart cleanup')
    observe('app closed with the approval job blocked')
    await launch('app relaunched on the same profile')
    const relaunched = await status(gated.id)
    assert.equal(relaunched.status, 'blocked', 'the approval block did not survive the restart')
    assert.equal(relaunched.statusReason, blocked.statusReason, 'the approval reason changed across the restart')
    assert.deepEqual((await approvals(gated.id)).map(event => event.id), approvalsBefore.map(event => event.id), 'the approval events changed across the restart')
    observe('approval intact after restart', { status: relaunched.status, statusReason: relaunched.statusReason })

    approvalGranted = true
    const requestsBefore = stubRequests.length
    await call('jobs.resume', { jobId: gated.id })
    const resumed = await waitFor(gated.id, s => s.status === 'completed', 'approval job resumed after the restart and completed', STAGE_TIMEOUT)
    const approvalsAfter = await approvals(gated.id)
    assert.equal(approvalsAfter.length, 1, 'the resumed job raised the approval again')
    assert.ok(stubRequests.slice(requestsBefore).some(entry => entry.approvalCase), 'the resumed job never generated')
    observe('approval gate verified', { secondJob: second.id, firstJob: gated.id, attempts: resumed.currentStage?.attempt ?? null, counters: resumed.counters, approvals: approvalsAfter.length, requestsAfterResume: stubRequests.length - requestsBefore })
    throw Object.assign(new Error('approval gate only'), { skipped: true })
  }

  // --- Blocked restart: a job blocked with its stage still running continues once after restarts --
  if (flag('blocked-restart')) {
    if (!stub) throw new Error('--blocked-restart scripts the stub model; run it without --real-model')
    const events = async jobId => (await allEvents(jobId)).events
    // A hard stop of Electron main: the crash reconcile.ts exists for (a graceful quit with a job
    // running waits on a dialog). Only the registered main identity is killed, on its own handle;
    // its children go with it, and safeClose accounts for any that do not.
    const kill = async label => {
      const main = instance.roots.find(entry => entry.pid === owner.pid)
      assert.ok(main, `parked main pid ${owner.pid} is not a registered root`)
      const result = await terminateIdentity(main, { budgetMs: 15_000 })
      assert.ok(['exited', 'signalled', 'absent'].includes(result.state), `kill of parked main refused or failed: ${JSON.stringify(result)}`)
      // Observation only (never a kill grant): the next launch waits until nothing holds the profile.
      await expect.poll(() => profileProcesses().length, { timeout: 30_000 }).toBe(0)
      await closeApp(`${label} (cleanup)`)
      observe(label, { pid: main.pid, result: result.state })
    }
    const job = await call('jobs.create', { title: 'Smoke: blocked restart', model, objective: 'BLOCKED-RESTART-CASE: run the slow step.', stages: [{ title: 'Slow step', objective: 'BLOCKED-RESTART-CASE: run sleep 120 in the workspace', completionCriteria: ['The slow step ran'] }] })
    await expect.poll(() => stubRequests.filter(entry => entry.blockedRestartCase).length, { timeout: 60_000 }).toBeGreaterThan(0)
    // The stub answers after its delay with run_command; Docker then runs sleep 120 with the call pending.
    await new Promise(done => setTimeout(done, Number(process.env.DURABLE_SMOKE_STUB_DELAY_MS ?? 4000) + 8_000))
    const before = await status(job.id)
    assert.equal(before.status, 'running', `the job was not running inside its tool call: ${before.status} ${before.statusReason ?? ''}`)
    await kill('app killed while the stage ran run_command')

    await launch('app relaunched (1st restart)')
    // Reconciliation runs a few seconds after launch; an owner command in that window must not bypass it.
    const early = await call('jobs.pause', { jobId: job.id, reason: 'Smoke early pause' }, { expectError: true })
    observe('owner pause right after relaunch refused', { error: String(early).slice(0, 200) })
    const blocked = await waitFor(job.id, s => s.status === 'blocked', 'job reconciled to blocked on the unknown side effect', 60_000)
    assert.match(blocked.statusReason ?? '', /side effect/i, `blocked for an unexpected reason: ${blocked.statusReason}`)
    const reconciled = await events(job.id)
    assert.ok(reconciled.some(event => event.kind === 'recovery' && /run_command/.test(event.message) && /unknown/.test(event.message)), 'reconciliation did not record the cut-off run_command as unknown')
    assert.ok(!reconciled.some(event => event.kind === 'transition' && event.data?.to === 'paused'), 'the early pause went through and bypassed reconciliation')
    observe('unknown side effect recorded', { statusReason: blocked.statusReason, recoveries: blocked.counters.recoveries })

    await kill('app killed with the job blocked and its stage still running')
    await launch('app relaunched (2nd restart)')
    await new Promise(done => setTimeout(done, 8_000))
    const still = await status(job.id)
    assert.equal(still.status, 'blocked', 'the blocked job moved across the second restart')
    assert.equal(still.statusReason, blocked.statusReason, 'the block reason changed across the second restart')
    const afterSecond = await events(job.id)
    assert.deepEqual(afterSecond.map(event => event.id), reconciled.map(event => event.id), 'the second restart rewrote the blocked job')
    observe('still blocked after the 2nd restart, nothing rewritten', { events: afterSecond.length })

    toolReleased = true
    await call('jobs.resume', { jobId: job.id })
    const done = await waitFor(job.id, s => ['completed', 'blocked', 'failed'].includes(s.status), 'blocked job resumed after two restarts', STAGE_TIMEOUT)
    const after = (await events(job.id)).slice(afterSecond.length)
    const attempts = after.filter(event => event.kind === 'stage' && /attempt \d+ started/.test(event.message))
    const reblocks = after.filter(event => event.kind === 'transition' && event.data?.to === 'blocked')
    observe('after resume', { status: done.status, statusReason: done.statusReason, attemptsStarted: attempts.map(event => event.message), reblocks: reblocks.map(event => event.message), activeMs: done.activeMs, elapsedMs: done.elapsedMs, counters: done.counters })
    assert.equal(done.status, 'completed', `the resumed job ended ${done.status}: ${done.statusReason ?? ''}`)
    assert.equal(reblocks.length, 0, 'the resumed job blocked again')
    assert.equal(attempts.length, 1, 'the resumed job did not continue exactly once')
    throw Object.assign(new Error('blocked restart only'), { skipped: true })
  }

  // --- 1. Create and watch it run -------------------------------------------------------------
  const pair = (a, b) => ({ title: `Write notes for ${a} and ${b}`, objective: `Read modules/${a}.js and modules/${b}.js in line ranges (never whole) and write notes/${a}.md and notes/${b}.md: for each module, the exported function name families, how many functions it defines, and every import from another module with the functions it uses.`, completionCriteria: [`notes/${a}.md and notes/${b}.md exist and list the imports of each module`] })
  const crossrefJob = (title = 'Smoke: cross-reference six modules') => ({
    title, model,
    objective: 'Summarise the six modules in modules/ into notes/<module>.md, then write CROSSREF.md: a table of which module imports which functions from which other module, built from the notes.',
    constraints: ['Only write files under notes/ and CROSSREF.md', 'Read source files in ranges of at most 300 lines'],
    // A long soak wants several context rollovers, not just a job that happens to finish; the
    // fixture's own peaks (~15k-22k of 32,768) rarely cross the default 0.7 threshold on their
    // own, so a soak run forces a lower one to make every stage roll over reliably.
    ...(flag('soak') ? { budgets: { contextRolloverFraction: 0.4 } } : {}),
    stages: [pair('alpha', 'beta'), pair('gamma', 'delta'), pair('epsilon', 'zeta'),
      { title: 'Write the cross-reference', objective: 'Using notes/*.md (not the sources), write CROSSREF.md with one row per import: importing module, imported module, function names.', completionCriteria: ['CROSSREF.md has a row for every import listed in notes/'] }]
  })
  // One stage covering all 150 files: a single-stage counterpart to crossref's one-rollover-per-
  // stage pattern, so a soak run forces the same lower fraction crossref uses (a capable real
  // model tends to solve the naive per-file task compactly and stays under the default fraction
  // regardless of file count, confirmed empirically: 22/22 real-model iterations at the default
  // 0.7 completed in one context with zero rollovers).
  const indexJob = (title = 'Smoke: index 150 files') => ({
    title, model,
    objective: `Read every one of the ${INDEX_FILE_COUNT} files under inputs/ in filename order (file001.txt..file${INDEX_FILE_COUNT}.txt) and append one line per file to INDEX.md, in that same order: "<filename>: <unique token from the file>". Never skip, reorder or repeat a file; check INDEX.md's current lines first so you resume after the last one already written.`,
    constraints: ['Only write INDEX.md', 'Read each input file before writing its line'],
    ...(flag('soak') ? { budgets: { contextRolloverFraction: 0.4 } } : {}),
    stages: [{ title: 'Build the index', objective: `For each of the ${INDEX_FILE_COUNT} files under inputs/, in filename order, append one line to INDEX.md: "<filename>: <unique token>". Read INDEX.md first and continue after its last line; do not rewrite lines already written.`, completionCriteria: [`INDEX.md has exactly ${INDEX_FILE_COUNT} lines, one per input file, in filename order, each with that file's unique token`] }]
  })

  // --- Soak: the crossref or index job, back to back, for hours, unattended -----------------
  if (flag('soak')) {
    if (!realModel || (fixture !== 'crossref' && fixture !== 'index')) throw new Error('--soak is meant for --real-model --fixture=crossref or --fixture=index')
    const buildSoakJob = fixture === 'index' ? indexJob : crossrefJob
    // The workload is measured on a monotonic clock from the first job to the last settlement,
    // excluding setup and cleanup. Iterations start only while it is short of SOAK_WORKLOAD_MS; the
    // last one is bounded by STAGE_TIMEOUT like every other. Nothing is subtracted and still
    // called six hours: a short workload fails the assertion below.
    const ledgerFile = join(output, 'soak-ledger.ndjson')
    const workloadStarted = performance.now()
    const workloadElapsed = () => Math.round(performance.now() - workloadStarted)
    observe('soak workload started', { workloadMs: SOAK_WORKLOAD_MS, stageTimeoutMs: STAGE_TIMEOUT, ledgerFile })
    let iteration = 0, totalRollovers = 0, totalStages = 0, totalRetries = 0, totalRecoveries = 0, totalCompleted = 0, verifiedCompletions = 0
    const audited = []
    while (workloadElapsed() < SOAK_WORKLOAD_MS) {
      iteration++
      await clearOutputs()
      const soakJob = await call('jobs.create', buildSoakJob(`Smoke: soak iteration ${iteration}`))
      const settled = await waitFor(soakJob.id, s => ['completed', 'blocked', 'failed'].includes(s.status), `soak iteration ${iteration} settled`, STAGE_TIMEOUT)
      totalRollovers += settled.counters.contextRollovers
      totalStages += settled.counters.stagesCompleted
      totalRetries += settled.counters.retries
      totalRecoveries += settled.counters.recoveries
      if (settled.status === 'completed') totalCompleted++
      const problems = settled.status === 'completed' ? await outputProblems() : null
      if (problems && !problems.length) verifiedCompletions++
      // The whole ledger, paged, with the blocked stage taken from structured state: the audit
      // judges each stage's charged versus credited attempts, not any credit anywhere in the job.
      const { events, complete } = await allEvents(soakJob.id)
      const entry = { iteration, jobId: soakJob.id, events, complete, status: settled.status, statusReason: settled.statusReason ?? '', blockedStageId: settled.status === 'blocked' ? settled.currentStage?.id ?? null : null, maxStageAttempts: settled.budgets?.maxStageAttempts ?? 3 }
      audited.push(entry)
      const [judged] = auditSoak([entry]).perJob
      appendFileSync(ledgerFile, JSON.stringify({ at: new Date().toISOString(), workloadElapsedMs: workloadElapsed(), iteration, jobId: soakJob.id, status: settled.status, statusReason: settled.statusReason ?? null, counters: settled.counters, outputProblems: problems, audit: { verdict: judged.verdict, reasons: judged.reasons, violations: judged.violations, stages: judged.stages, creditedTransitions: judged.creditedTransitions, creditedFollowed: judged.creditedFollowed }, eventCount: events.length, complete }) + '\n')
      observe('soak iteration done', { iteration, status: settled.status, statusReason: settled.statusReason, counters: settled.counters, elapsedMs: settled.elapsedMs, activeMs: settled.activeMs, outputProblems: problems, audit: judged.verdict, workloadElapsedMs: workloadElapsed() })
      if (settled.status !== 'completed') await call('jobs.cancel', { jobId: soakJob.id, reason: 'Smoke soak: iteration did not complete cleanly' })
    }
    const measured = workloadElapsed()
    const audit = auditSoak(audited)
    observe('soak finished', { iterations: iteration, workloadMs: measured, requiredWorkloadMs: SOAK_WORKLOAD_MS, totalRollovers, totalStages, totalRetries, totalRecoveries, totalCompleted, verifiedCompletions, audit: { verdict: audit.verdict, credited: audit.credited, creditedTransitions: audit.creditedTransitions, creditedFollowed: audit.creditedFollowed, violations: audit.violations, unproven: audit.unproven } })
    assert.ok(measured >= SOAK_WORKLOAD_MS, `the measured workload was ${measured} ms, short of ${SOAK_WORKLOAD_MS} ms`)
    assert.ok(totalRollovers > 0, `the soak never triggered a context rollover across ${iteration} iteration(s)`)
    assert.ok(iteration >= 2, `the soak only completed ${iteration} iteration(s); not enough for an unattended-hours check`)
    assert.ok(verifiedCompletions > 0, `no soak iteration completed with correct output across ${iteration} iteration(s) (${totalCompleted} reported completed)`)
    assert.deepEqual(audit.violations, [], 'a stage blocked on its attempt budget with fewer charged failures than the budget')
    // NOT EXERCISED (no credited rollover went on) is UNVERIFIED too: the run fails rather than pass.
    observe(`credited rollover must-have: ${audit.credited}`, { creditedFollowed: audit.creditedFollowed, verdict: audit.verdict, reasons: audit.reasons })
    assert.equal(audit.verdict, 'PASS', `soak UNVERIFIED: ${audit.reasons.join('; ')} ${JSON.stringify(audit.unproven).slice(0, 600)}`)
    throw Object.assign(new Error('soak only'), { skipped: true })
  }

  const job = await call('jobs.create', fixture === 'crossref' ? crossrefJob() : {
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
    // The parked main's identity as registered at launch; ownership is re-proved from the OS inside.
    const appRoot = instance.roots.find(entry => entry.pid === owner.pid)
    assert.ok(appRoot, `parked main pid ${owner.pid} is not a registered root`)
    const snapshot = async () => (await listProcesses()).list
    const stopped = await stopDurableSmokeServer({ call, model, app: appRoot, snapshot })
    observe('llama-server stopped and its exit observed', { pid: stopped.pid, model: stopped.model, creationTime: stopped.identity.creationTime })
    await waitFor(job.id, s => s.counters.recoveries > afterReload.counters.recoveries || s.lastEvent?.kind === 'server', 'server loss noticed', 5 * 60_000)
    await waitFor(job.id, s => s.status === 'running' || s.status === 'completed', 'job running again after server restart', STAGE_TIMEOUT)
    // Exactly one replacement: one app-registered server for the model, a different OS process than
    // the one stopped, started by this parked app.
    const replacements = (await call('local.servers')).filter(entry => entry.model === model)
    const list = await snapshot()
    const replacement = replacements.length === 1 ? list.find(entry => entry.pid === replacements[0].pid) : null
    observe('replacement server', { servers: replacements.map(entry => ({ pid: entry.pid, startedByConductor: entry.startedByConductor })), parent: replacement?.ppid ?? null })
    assert.equal(replacements.length, 1, `expected exactly one ${model} server after recovery; found ${replacements.length}`)
    assert.ok(replacement && identityOf(replacement) && !sameIdentity(identityOf(replacement), stopped.identity) && replacement.ppid === appRoot.pid, 'the replacement server is not a new process started by the parked app')
  }

  // --- Optional: restart the app mid-job -------------------------------------------------------
  if (flag('restart-app')) {
    const before = await status(job.id)
    await closeApp('mid-job restart cleanup')
    observe('app closed mid-job', { status: before.status, stage: before.currentStage?.title })
    await launch('app relaunched on the same profile')
    const after = await status(job.id)
    assert.equal(after.id, job.id)
    observe('job after relaunch', { status: after.status, recoveries: after.counters.recoveries, lastEvent: after.lastEvent })
    await waitFor(job.id, s => ['running', 'completed', 'blocked'].includes(s.status), 'job reconciled after relaunch', STAGE_TIMEOUT)
  }

  // --- 4. Finish (or cancel) and report -----------------------------------------------------------
  let final = await status(job.id)
  try { final = await waitFor(job.id, s => ['completed', 'blocked', 'failed'].includes(s.status), 'job settled', STAGE_TIMEOUT) }
  catch { final = await call('jobs.cancel', { jobId: job.id, reason: 'Smoke time limit' }); observe('job cancelled at the smoke time limit', { status: final.status }) }
  // A recovery run is only accepted when that same job finished its work correctly: a report for
  // blocked or cancelled work, or a completion with wrong output, is not a recovery.
  if (acceptanceRun) {
    const problems = final.status === 'completed' ? await outputProblems() : null
    const failures = acceptanceFailures({ jobId: job.id, final, problems })
    observe(flag('acceptance') ? 'control run outcome' : 'fault run outcome', { jobId: job.id, status: final.status, statusReason: final.statusReason ?? null, outputProblems: problems, failures })
    assert.deepEqual(failures, [], `acceptance run did not prove a completed, correct job: ${failures.join('; ')}`)
  }
  const report = await call('jobs.report', { jobId: job.id })
  assert.ok(existsSync(report.reportPath), 'report.md was not written')
  assert.ok(existsSync(join(report.reportPath, '..', 'report.json')), 'report.json was not written')
  assert.equal(report.cloudEscalation.occurred, false)
  observe('report written', { reportPath: report.reportPath, status: report.status, results: report.results.length, checkpoints: report.checkpoints.length, logPaths: report.logPaths.length })
  // Evidence: every stage's context figures, retries, server and recovery events, in order.
  const events = await call('jobs.events', { jobId: job.id, limit: 200 })
  observe('job events', { counters: final.counters, events: events.filter(event => ['stage', 'retry', 'server', 'recovery', 'loop-detected', 'approval', 'escalation'].includes(event.kind) || event.data?.contextRollover || event.data?.test).map(event => ({ at: event.at, kind: event.kind, message: event.message.slice(0, 300), ...(event.data?.peakPromptTokens != null ? { peakPromptTokens: event.data.peakPromptTokens, promptTokens: event.data.promptTokens, windowTokens: event.data.windowTokens, rounds: event.data.rounds } : {}), ...(event.data?.stop ? { stop: event.data.stop, promptTokens: event.data.promptTokens } : {}) })) })
  if (value('extras', 'all') === 'none') throw Object.assign(new Error('extras skipped'), { skipped: true })

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
    // Against the real model (no stub marker matching): a model with file-write tools can satisfy
    // a check like "left-pad is in package.json" by writing the file directly, never attempting
    // the disallowed command and never getting refused. Naming that shortcut in a constraint (the
    // real model reliably honors it, same as the crossref fixture's write constraints) is what
    // makes this case provable against a real model rather than only the scripted stub.
    constraints: ['You must run npm install left-pad --save through the shell/run_command tool to install it; do not create or edit package.json or node_modules by hand to satisfy this'],
    stages: [{ title: 'Install', objective: 'APPROVAL-CASE: run npm install left-pad --save', completionCriteria: ['left-pad is in package.json'] }]
  })
  const blocked = await waitFor(gated.id, s => s.status === 'blocked', 'approval case blocked', STAGE_TIMEOUT)
  assert.match(blocked.statusReason ?? '', /approv|permission|owner/i, `blocked for an unexpected reason: ${blocked.statusReason}`)
  await call('jobs.cancel', { jobId: gated.id, reason: 'Smoke done' })

  // --- 7. Stub only: a loop and a stalled call end within bounds -----------------------------------
  if (stub && flag('loop-case')) {
    const looping = await call('jobs.create', { title: 'Smoke: loop', model, objective: 'LOOP-CASE: read README.md', stages: [{ title: 'Loop', objective: 'LOOP-CASE: read README.md until told otherwise', completionCriteria: ['never'] }] })
    const ended = await waitFor(looping.id, s => ['blocked', 'failed', 'completed'].includes(s.status), 'loop case ended', 20 * 60_000)
    observe('loop case outcome', { status: ended.status, statusReason: ended.statusReason, counters: ended.counters })
    assert.equal(ended.status, 'blocked')
    await call('jobs.cancel', { jobId: looping.id, reason: 'Smoke done' })
  }
  if (stub && flag('stall-case')) {
    const stalled = await call('jobs.create', { title: 'Smoke: stall', model, objective: 'STALL-CASE: wait', budgets: { maxStageAttempts: 1 }, stages: [{ title: 'Stall', objective: 'STALL-CASE: the model never answers', completionCriteria: ['never'] }] })
    const ended = await waitFor(stalled.id, s => ['blocked', 'failed', 'completed'].includes(s.status), 'stall case ended', 20 * 60_000)
    const events = await call('jobs.events', { jobId: stalled.id, limit: 200 })
    observe('stall case outcome', { status: ended.status, statusReason: ended.statusReason, elapsedMs: ended.elapsedMs, interrupts: events.filter(event => /interrupt|stalled|Watchdog/i.test(event.message)).map(event => event.message.slice(0, 200)) })
    assert.equal(ended.status, 'blocked')
    await call('jobs.cancel', { jobId: stalled.id, reason: 'Smoke done' })
  }

  // The sidebar panel lists all three jobs.
  await page.getByRole('button', { name: 'Durable jobs' }).first().click().catch(() => {})
  await page.locator('.durable-job-list').first().waitFor().catch(() => {})
  await page.screenshot({ path: join(output, 'jobs-panel.png') })
  observe('done', { jobs: (await call('jobs.list')).map(entry => ({ id: entry.id, status: entry.status })) })
} catch (error) {
  if (error?.skipped) observe(flag('approval-gate') ? 'approval gate scenario done; main job skipped' : flag('blocked-restart') ? 'blocked restart scenario done; main job skipped' : 'extras skipped (--extras=none)')
  else {
    failed = error
    observe('FAILED', { message: String(error?.message ?? error).slice(0, 800) })
  }
} finally {
  clearTimeout(watchdog)
  try { await closeApp('final cleanup') } catch (error) { failed ??= error; observe('FAILED cleanup', { message: String(error?.message ?? error).slice(0, 800) }) }
  stub?.close()
}
if (!flag('keep') && !failed) await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true, maxRetries: 5 })).catch(() => {})
await new Promise(done => process.stdout.write(JSON.stringify({ mode: realModel ? 'real-model' : 'stub', model, root: flag('keep') || failed ? root : '(removed)', stubRequests: stubRequests.length, observations }, null, 2) + '\n', done))
process.exit(failed ? 1 : 0)
