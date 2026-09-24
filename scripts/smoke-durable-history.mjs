import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// Restart acceptance for durable jobs with more than 1,000 events (F1, commit cacfc74). The job
// controller, the loop guard and the report must read the newest matching events, not the oldest
// 1,000. The built app runs parked off-screen under CONDUCTOR_TEST_USER_DATA on a temp profile,
// driven as the owner through control-owner.json against a loopback stub model (the same hooks as
// scripts/smoke-durable-jobs.mjs). Three jobs are created, the app is killed while job A is mid-stage
// and B and C are queued, >1,000 events are written into the closed profile's conductor.db, and the
// app is relaunched on the same profile:
//   A  elapsed budget 1 h, startedAt 14 days ago, an old elapsedBudget:'restarted' note first and a
//      fresh one after 1,100 fillers. It must resume and complete (the newest note wins), and
//      jobs.report plus paged jobs.events must hold the early, middle and late records and the tail.
//   B  control: same budget and seeding, but no late note. It must block on the elapsed budget,
//      so A's completion is due to the late note and not to a budget that never binds.
//   C  loop case with one seeded replan (a loop-detected event after 1,100 fillers). The restored
//      guard must block on the next loop without a second replan: exactly one replan persists.
//
//   node scripts/smoke-durable-history.mjs [--keep] [--app=<out/main/index.js>] [--summary=<name>]
// The JSON summary is printed and written to artifacts/autopilot/f1-runtime-smoke-summary.json.

const FILLERS = 1100
const DAY = 24 * 60 * 60 * 1000
const EXPIRED_START_MS = 14 * DAY
const ELAPSED_BUDGET_MS = 60 * 60_000

// --- Seeding the closed profile's database ---------------------------------------------------

const norm = value => resolve(value).replace(/[\\/]+$/g, '').toLowerCase()
const inside = (parent, child) => {
  const root = norm(parent), path = norm(child)
  return path === root || path.startsWith(root + '\\') || path.startsWith(root + '/')
}

/**
 * The database of exactly this isolated profile. The profile must be the temp profile this run
 * created (strictly inside the temp dir), never under %APPDATA%\Conductor, and conductor.db must
 * resolve to <profile>\conductor.db itself (no junction or link leading anywhere else).
 */
export function isolatedDatabase(profile, expectedProfile) {
  if (typeof profile !== 'string' || !profile.trim()) throw new Error('profile path required')
  if (norm(profile) !== norm(expectedProfile)) throw new Error(`refusing ${profile}: not this run's profile ${expectedProfile}`)
  const real = realpathSync(resolve(profile))
  if (norm(real) !== norm(profile)) throw new Error(`refusing ${profile}: it resolves elsewhere (${real})`)
  const temp = realpathSync(tmpdir())
  const fromTemp = relative(temp, real)
  if (!fromTemp || fromTemp.startsWith('..') || isAbsolute(fromTemp)) throw new Error('profile must be a directory strictly inside the temp dir')
  const owner = process.env.APPDATA ? resolve(process.env.APPDATA, 'Conductor') : null
  if (owner && (inside(owner, real) || inside(real, owner))) throw new Error('profile must not be or contain %APPDATA%\\Conductor')
  const dbPath = join(real, 'conductor.db')
  if (!existsSync(dbPath)) throw new Error('isolated profile has no conductor.db')
  const realDb = realpathSync(dbPath)
  if (norm(realDb) !== norm(dbPath)) throw new Error(`refusing ${dbPath}: it resolves elsewhere (${realDb})`)
  return realDb
}

/** Store-shaped events: data holds the whole event JSON (store.ts insertEvent). */
const shape = (jobId, tag, index, at, kind, message, data) => ({ id: `jobevt_f1seed_${tag}_${String(index).padStart(4, '0')}`, jobId, at: new Date(at).toISOString(), kind, message, ...(data ? { data } : {}) })

/**
 * The seeded history of one job. `at` never lies in the future: the early records sit just after
 * the backdated start, the fillers are spread up to a minute ago, the late records are seconds old.
 */
export function historyFor(jobId, tag, plan, now) {
  const start = now - EXPIRED_START_MS
  const fillerStart = start + 10 * 60_000, fillerEnd = now - 60_000
  const events = []
  const push = (at, kind, message, data) => events.push(shape(jobId, tag, events.length, at, kind, message, data))
  if (plan.earlyNote) push(start + 60_000, 'note', 'F1 seed: early elapsed-budget restart', { elapsedBudget: 'restarted', f1: 'early-note' })
  if (plan.markers) push(start + 120_000, 'recovery', 'F1 seed: early recovery', { f1: 'early', test: { command: 'f1-early-marker', outcome: 'pass', detail: 'seeded before 1,100 fillers' } })
  const filler = i => push(fillerStart + Math.floor((fillerEnd - fillerStart) * i / FILLERS), 'note', `F1 seed filler ${i}`, { f1: 'filler' })
  for (let i = 0; i < FILLERS / 2; i++) filler(i)
  if (plan.markers) push(fillerStart + Math.floor((fillerEnd - fillerStart) / 2), 'note', 'F1 seed: middle marker', { f1: 'middle', test: { command: 'f1-middle-marker', outcome: 'pass', detail: 'seeded between the filler halves' } })
  for (let i = FILLERS / 2; i < FILLERS; i++) filler(i)
  if (plan.lateNote) push(now - 3_000, 'note', 'F1 seed: late elapsed-budget restart', { elapsedBudget: 'restarted', f1: 'late-note' })
  if (plan.markers) {
    push(now - 2_000, 'recovery', 'F1 seed: late recovery', { f1: 'late', test: { command: 'f1-late-marker', outcome: 'pass', detail: 'seeded after 1,100 fillers' } })
    push(now - 1_000, 'escalation', 'F1 seed: late escalation', { f1: 'escalation', occurred: true })
  }
  if (plan.replanStageId) push(now - 1_000, 'loop-detected', `Loop detected in stage ${plan.replanStageId}: F1 seed replan. Replanning once with a fresh worker context.`,
    { stageId: plan.replanStageId, replan: 1, f1: 'replan', evidence: { pattern: 'identical-calls', tool: 'read_file', target: 'README.md', count: 4, sample: ['seeded'], sinceProgressMs: 0, roundsWithoutProgress: 4 } })
  return events
}

/** One IMMEDIATE transaction over the closed profile: backdate startedAt where asked, insert events. */
export function seedHistory(profile, expectedProfile, seeds, now = Date.now()) {
  const db = new DatabaseSync(isolatedDatabase(profile, expectedProfile))
  db.exec('PRAGMA busy_timeout = 3000')
  const written = {}
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const insert = db.prepare('INSERT INTO durable_job_events (id, job_id, at, kind, data) VALUES (?, ?, ?, ?, ?)')
      for (const { jobId, tag, plan } of seeds) {
        const row = db.prepare('SELECT data FROM durable_jobs WHERE id = ?').get(jobId)
        if (!row?.data) throw new Error(`Durable job not found: ${jobId}`)
        if (plan.backdate) {
          const job = JSON.parse(String(row.data))
          db.prepare('UPDATE durable_jobs SET data = ? WHERE id = ?').run(JSON.stringify({ ...job, startedAt: new Date(now - EXPIRED_START_MS).toISOString() }), jobId)
        }
        const events = historyFor(jobId, tag, plan, now)
        for (const event of events) insert.run(event.id, jobId, event.at, event.kind, JSON.stringify(event))
        written[tag] = { jobId, events: events.length, ids: Object.fromEntries(events.filter(event => event.data?.f1 && event.data.f1 !== 'filler').map(event => [event.data.f1, event.id])) }
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return written
  } finally { db.close() }
}

export function stageIds(profile, expectedProfile, jobId) {
  const db = new DatabaseSync(isolatedDatabase(profile, expectedProfile), { readOnly: true })
  try { return db.prepare('SELECT id FROM durable_job_stages WHERE job_id = ? ORDER BY stage_index').all(jobId).map(row => String(row.id)) }
  finally { db.close() }
}

// --- The smoke -------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const keep = argv.includes('--keep')
  // --app=<out/main/index.js of another build> (e.g. the pre-fix revision, expected to FAIL);
  // --summary=<name> writes artifacts/autopilot/<name>.json instead of f1-runtime-smoke-summary.json.
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const appEntry = resolve(option('app') ?? 'out/main/index.js')
  const summaryName = option('summary') ?? 'f1-runtime-smoke-summary'
  const model = 'local/qwen3.6-35b-a3b'
  const root = await mkdtemp(join(tmpdir(), 'conductor-durable-history-'))
  const output = resolve('artifacts/autopilot')
  await mkdir(output, { recursive: true })
  const profile = join(root, 'profile')
  const observations = []
  const observe = (label, data = {}) => {
    const entry = { at: new Date().toISOString(), label, ...data }
    observations.push(entry)
    process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
  }

  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'README.md'), '# Durable history smoke\n')
  await writeFile(join(projectPath, 'notes.txt'), 'first line\n')
  const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

  // Stub model scripted by prompt markers, as in smoke-durable-jobs.mjs. While `holdA` is set,
  // job A's request never answers, so A is mid-stage when the app closes.
  let holdA = true, launchNo = 0
  const stubRequests = []
  const stub = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
      const prompt = JSON.stringify(body.messages ?? '')
      const job = prompt.includes('HISTORY-A') ? 'A' : prompt.includes('HISTORY-B') ? 'B' : prompt.includes('LOOP-CASE') ? 'C' : null
      const send = payload => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
      if (request.url?.startsWith('/health')) return send({ status: 'ok' })
      if (request.url?.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: model, object: 'model' }] })
      stubRequests.push({ at: new Date().toISOString(), launch: launchNo, job, held: job === 'A' && holdA })
      if (job === 'A' && holdA) return
      const messages = Array.isArray(body.messages) ? body.messages : []
      const afterTool = messages.at(-1)?.role === 'tool'
      const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call_${stubRequests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      const task = String(messages.find(message => message.role === 'user')?.content ?? '')
      const stageObjective = /THIS STAGE\s*([\s\S]*?)\s*STAGE IS COMPLETE WHEN/.exec(task)?.[1] ?? task
      const appending = stageObjective.includes('Append the line')
      const reply = job === 'C' ? call('read_file', { path: 'README.md' })
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
      }, 500)
    })
  })
  await new Promise(done => stub.listen(0, '127.0.0.1', done))
  const stubEndpoint = `http://127.0.0.1:${stub.address().port}`

  const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: stubEndpoint }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

  let app, page, owner, projectId
  const launch = async label => {
    launchNo++
    app = await electron.launch({ args: [appEntry], env, timeout: 60_000 })
    page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on('pageerror', error => { if (error.message !== 'Canceled') observe('page error', { message: error.message }) })
    await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
    observe(label, { pid: app.process().pid })
  }
  /** Electron processes (main, GPU, renderer, utility) still running on this run's profile. */
  const profileProcesses = () => {
    const list = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], { encoding: 'utf8' })
    return list.split(/\r?\n/).filter(line => line.toLowerCase().includes(root.toLowerCase())).map(line => Number(line.split('\t')[0]))
  }
  // A graceful quit with a job running waits on the "Work is still running" dialog (index.ts
  // confirmApplicationStop), so the restart is a hard stop of the whole process tree: the crash or
  // power loss reconcile.ts exists for. Seeding waits until nothing holds the profile any more.
  const close = async label => {
    const pid = app.process().pid
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }) } catch { /* already gone */ }
    await expect.poll(() => profileProcesses().length, { timeout: 30_000 }).toBe(0)
    observe(label, { pid, remainingProfileProcesses: 0 })
  }
  const credential = async () => {
    const path = join(profile, 'control-owner.json')
    await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
    return JSON.parse(await readFile(path, 'utf8'))
  }
  const call = async (method, args = {}) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await response.json()
    assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
    return body.result
  }
  const status = jobId => call('jobs.status', { jobId })
  const waitFor = async (jobId, predicate, label, timeout) => {
    let last
    try { await expect.poll(async () => predicate(last = await status(jobId)), { timeout, intervals: [1000] }).toBe(true) }
    catch { observe(`TIMEOUT waiting for ${label}`, { status: last?.status, statusReason: last?.statusReason, lastEvent: last?.lastEvent }); throw new Error(`Timed out waiting for ${label}; last status ${last?.status}${last?.statusReason ? ' (' + last.statusReason + ')' : ''}`) }
    observe(label, { jobId, status: last.status, statusReason: last.statusReason, stage: last.currentStage?.title, attempt: last.currentStage?.attempt })
    return last
  }
  /** Every event, paged forward with afterId at the protocol's 200-per-call cap. */
  const allEvents = async jobId => {
    const events = []
    let pages = 0
    for (;;) {
      const page = await call('jobs.events', { jobId, limit: 200, ...(events.length ? { afterId: events.at(-1).id } : {}) })
      pages++
      events.push(...page)
      if (page.length < 200) return { events, pages }
    }
  }

  const summary = { root, profile, stubEndpoint, build: appEntry }
  const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 12 * 60_000)
  let failed = null
  try {
    // --- 1. First launch: three jobs; A mid-stage, B and C queued --------------------------------
    await launch('app launched (parked)')
    owner = await credential()
    projectId = (await call('projects.open', { path: projectPath, name: 'Durable history smoke' })).id
    await page.reload()
    await page.waitForFunction(() => Boolean(window.conductor?.durableJobs))
    await page.locator('.project-row').filter({ hasText: 'Durable history smoke' }).first().click()
    const locals = (await call('models.list')).find(entry => entry.provider === 'local')?.models.map(entry => entry.id) ?? []
    assert.ok(locals.includes(model), `${model} is not a local entry of models.list (${locals.join(', ') || 'none'})`)

    const jobA = await call('jobs.create', {
      title: 'F1 history A: late elapsed reset', model, objective: 'HISTORY-A: Append the line "durable smoke" to notes.txt and commit it.',
      constraints: ['Only edit notes.txt'], budgets: { maxElapsedMs: ELAPSED_BUDGET_MS },
      stages: [{ title: 'Append', objective: 'Append the line "durable smoke" to notes.txt', completionCriteria: ['notes.txt ends with durable smoke'] },
        { title: 'Verify', objective: 'Read notes.txt back and confirm the line', completionCriteria: ['The line is present'] }]
    })
    await waitFor(jobA.id, s => s.status === 'running' && Boolean(s.currentStage), 'A running a stage', 60_000)
    await expect.poll(() => stubRequests.some(entry => entry.job === 'A' && entry.held), { timeout: 60_000 }).toBe(true)
    const jobB = await call('jobs.create', {
      title: 'F1 history B: control without late reset', model, objective: 'HISTORY-B: nothing to do.', budgets: { maxElapsedMs: ELAPSED_BUDGET_MS },
      stages: [{ title: 'Noop', objective: 'HISTORY-B: nothing to do', completionCriteria: ['nothing'] }]
    })
    const jobC = await call('jobs.create', {
      title: 'F1 history C: one replan', model, objective: 'LOOP-CASE: read README.md',
      stages: [{ title: 'Loop', objective: 'LOOP-CASE: read README.md until told otherwise', completionCriteria: ['never'] }]
    })
    const before = { A: await status(jobA.id), B: await status(jobB.id), C: await status(jobC.id) }
    assert.equal(before.A.status, 'running')
    assert.equal(before.B.status, 'queued')
    assert.equal(before.C.status, 'queued')
    observe('jobs before restart', Object.fromEntries(Object.entries(before).map(([key, s]) => [key, { id: s.id, status: s.status, stage: s.currentStage?.title, attempt: s.currentStage?.attempt }])))

    // --- 2. Stop mid-job and seed >1,000 events into the closed profile ---------------------------
    await close('app stopped (process tree killed) with A mid-stage')
    const [cStage] = stageIds(profile, profile, jobC.id)
    const seeded = seedHistory(profile, profile, [
      { jobId: jobA.id, tag: 'A', plan: { backdate: true, earlyNote: true, markers: true, lateNote: true } },
      { jobId: jobB.id, tag: 'B', plan: { backdate: true, earlyNote: true } },
      { jobId: jobC.id, tag: 'C', plan: { replanStageId: cStage } }
    ])
    summary.seeded = seeded
    observe('history seeded', Object.fromEntries(Object.entries(seeded).map(([key, value]) => [key, value.events])))

    // --- 3. Relaunch on the same profile ----------------------------------------------------------
    holdA = false
    await launch('app relaunched on the same profile')
    owner = await credential()
    const afterA = await status(jobA.id)
    observe('A after relaunch', { status: afterA.status, recoveries: afterA.counters.recoveries, lastEvent: afterA.lastEvent })

    // All three settle (one at a time: maxConcurrent 1) and are recorded before anything is
    // asserted, so a failing run still shows every job's outcome.
    const settled = s => ['completed', 'blocked', 'failed', 'cancelled'].includes(s.status)
    const finalA = await waitFor(jobA.id, settled, 'A settled', 3 * 60_000)
    const finalB = await waitFor(jobB.id, settled, 'B settled', 2 * 60_000)
    const finalC = await waitFor(jobC.id, settled, 'C settled', 5 * 60_000)
    const { events: eventsC } = await allEvents(jobC.id)
    const loops = eventsC.filter(event => event.kind === 'loop-detected')
    const replans = loops.filter(event => typeof event.data?.replan === 'number')
    const blocks = loops.filter(event => event.data?.blocked === true)
    summary.B = { status: finalB.status, statusReason: finalB.statusReason, stubRequests: stubRequests.filter(entry => entry.job === 'B').length }
    summary.C = { status: finalC.status, statusReason: finalC.statusReason, events: eventsC.length, stubRequests: stubRequests.filter(entry => entry.job === 'C').length, loops: loops.map(event => ({ id: event.id, at: event.at, message: event.message.slice(0, 200), replan: event.data?.replan, replans: event.data?.replans, blocked: event.data?.blocked })) }
    observe('outcomes', { A: finalA.status, B: finalB.status, C: finalC.status, replanEvents: replans.length })

    // A: resumes and completes under the newest elapsed reset.
    assert.equal(finalA.status, 'completed', `A must complete under the late elapsed reset, got ${finalA.status}: ${finalA.statusReason}`)
    assert.ok(finalA.counters.recoveries >= 1, 'A was not reconciled after the restart')
    assert.ok(stubRequests.some(entry => entry.launch === 2 && entry.job === 'A'), 'no fresh stub request for A after the relaunch')

    // B: the same history without the late note blocks on the elapsed budget, before any stage.
    assert.equal(finalB.status, 'blocked')
    assert.match(finalB.statusReason ?? '', /elapsed-time budget/)
    assert.ok(!stubRequests.some(entry => entry.job === 'B'), 'B reached the model although its elapsed budget was spent')

    // C: the restored replan count blocks the next loop without a second replan.
    assert.equal(finalC.status, 'blocked')
    assert.ok(eventsC.length > 1000, `C has only ${eventsC.length} events`)
    assert.deepEqual(replans.map(event => event.id), [seeded.C.ids.replan], 'exactly the seeded replan must exist after the restart')
    assert.ok(blocks.length >= 1 && blocks.every(event => event.data.replans === 1), 'the loop after the restart must block with the restored replan count')
    assert.ok(stubRequests.some(entry => entry.launch === 2 && entry.job === 'C'), 'C never ran after the relaunch')

    // --- 4. A's paged events and report -----------------------------------------------------------
    const { events: eventsA, pages } = await allEvents(jobA.id)
    const index = id => eventsA.findIndex(event => event.id === id)
    const ids = seeded.A.ids
    const at = Object.fromEntries(['early-note', 'early', 'middle', 'late-note', 'late', 'escalation'].map(key => [key, index(ids[key])]))
    summary.A = { status: finalA.status, recoveries: finalA.counters.recoveries, events: eventsA.length, pages, positions: at, tail: eventsA.slice(-6).map(event => ({ at: event.at, kind: event.kind, message: event.message.slice(0, 160) })) }
    assert.equal(new Set(eventsA.map(event => event.id)).size, eventsA.length, 'paging repeated an event')
    assert.ok(eventsA.length > 1100 && pages >= 6, `A has only ${eventsA.length} events over ${pages} pages`)
    for (const [key, position] of Object.entries(at)) assert.ok(position >= 0, `seeded ${key} record missing from paged events`)
    assert.ok(at['early-note'] < at.early && at.early < at.middle && at.middle < at['late-note'] && at['late-note'] < at.late && at.late < at.escalation, 'seeded records out of order')
    assert.ok(at.escalation > 1000, 'the late records must sit past the first 1,000 events')
    const tail = eventsA.slice(at.escalation + 1)
    assert.ok(tail.some(event => event.kind === 'recovery' && /Reconciling after restart/.test(event.message)), 'no reconciliation after the seeded tail')
    assert.ok(tail.some(event => event.kind === 'stage'), 'no stage work after the seeded tail')
    assert.ok(!tail.some(event => event.kind === 'transition' && event.data?.to === 'blocked'), 'A blocked after the restart')
    const last = eventsA.at(-1)
    const completedAt = eventsA.findLastIndex(event => event.kind === 'transition' && event.data?.to === 'completed')
    assert.ok(completedAt > at.escalation, 'the completed transition is not in the newest tail')
    assert.equal((await status(jobA.id)).lastEvent?.message, last.message, 'jobs.status lastEvent is not the last paged event')

    const report = await call('jobs.report', { jobId: jobA.id })
    const reportJson = JSON.parse(await readFile(join(report.reportPath, '..', 'report.json'), 'utf8'))
    const reportMd = await readFile(report.reportPath, 'utf8')
    summary.report = { reportPath: report.reportPath, status: report.status, tests: report.tests, recoveries: report.recoveries.map(entry => entry.message), cloudEscalation: report.cloudEscalation }
    for (const candidate of [report, reportJson]) {
      assert.equal(candidate.status, 'completed')
      for (const marker of ['f1-early-marker', 'f1-middle-marker', 'f1-late-marker']) assert.ok(candidate.tests.some(test => test.command === marker && test.outcome === 'pass'), `report lacks ${marker}`)
      const messages = candidate.recoveries.map(entry => entry.message)
      assert.ok(messages.includes('F1 seed: early recovery') && messages.includes('F1 seed: late recovery'), 'report recoveries lack the early or late seeded record')
      assert.ok(messages.findLastIndex(message => /Reconciling after restart/.test(message)) > messages.indexOf('F1 seed: late recovery'), 'report recoveries lack the post-restart tail')
      assert.equal(candidate.cloudEscalation.occurred, true)
      assert.match(candidate.cloudEscalation.detail, /F1 seed: late escalation/)
    }
    for (const marker of ['f1-early-marker', 'f1-middle-marker', 'f1-late-marker', 'F1 seed: late escalation']) assert.ok(reportMd.includes(marker), `report.md lacks ${marker}`)
    observe('A report verified', { reportPath: report.reportPath, tests: report.tests.length, recoveries: report.recoveries.length })
    await page.screenshot({ path: join(output, 'f1-runtime-jobs.png') }).catch(() => {})
    observe('PASS')
  } catch (error) {
    failed = error
    observe('FAILED', { message: String(error?.message ?? error).slice(0, 1200) })
  } finally {
    clearTimeout(watchdog)
    if (app) {
      await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'pipe' }) } catch { /* exited */ }
      for (const pid of profileProcesses()) try { process.kill(pid) } catch { /* exited */ }
    }
    stub.close()
  }
  const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', stubRequests: stubRequests.map(({ at, launch, job, held }) => ({ at, launch, job, held })).filter((entry, i, all) => entry.job !== 'C' || all.filter(other => other.job === 'C').indexOf(entry) < 6), observations }
  await writeFile(join(output, `${summaryName}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (!keep && !failed) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  if (failed) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
