import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm, appendFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// V3 verify S19/S20/S22/S23 (delivery + control concurrency), all sharing one clone project in one
// test instance per the plan ("in the clone project of S22").
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-ship.mjs --scenario=s22|s23|s19|s20|all [--keep]

const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const scenarioArg = arg('scenario') ?? 'all'
const scenarios = new Set(scenarioArg.split(','))
const runs = name => scenarioArg === 'all' || scenarios.has(name)
const keep = process.argv.includes('--keep')
const HARD_TIMEOUT_MS = 14 * 60_000
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-ship-'))
const output = resolve('artifacts/v3-verify')
const profile = join(root, 'profile')
const clonePath = join(root, 'clone')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

observe('cloning repo (git clone --local)')
execFileSync('git', ['clone', '--local', 'C:\\Claude\\conductor', clonePath], { stdio: 'pipe' })
// Junction node_modules to the real checkout's, per the plan (avoid reinstalling for the clone).
execSync(`cmd /c mklink /J "${join(clonePath, 'node_modules')}" "C:\\Claude\\conductor\\node_modules"`, { stdio: 'pipe' })
observe('clone ready', { clonePath })

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const request = async (method, args = {}, scopeOverride) => {
  const started = Date.now()
  const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, scope: scopeOverride ?? (projectId ? { projectId } : undefined) }) })
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body, latencyMs: Date.now() - started }
}
const call = async (method, args = {}) => { const r = await request(method, args); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

const summary = { scenario: scenarioArg, root, clonePath, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let firstPid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  projectId = (await call('projects.open', { path: clonePath, name: 'V3 ship clone' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 ship clone' }).first().click()
  await page.waitForTimeout(1000)
  observe('project selected')

  const pollShip = async (runId, waitSeconds = 100) => {
    let last
    for (let i = 0; i < 20; i++) {
      last = await call('git.ship.status', { runId, waitSeconds })
      if (last?.status && last.status !== 'running') return last
    }
    return last
  }

  if (runs('s22')) {
    // (a) routine ship: edit one non-core file.
    const targetFile = 'src/main/local-models/servers.ts'
    const original = readFileSync(join(clonePath, targetFile), 'utf8')
    await writeFile(join(clonePath, targetFile), original + `\n// v3-verify S22 timestamp ${Date.now()}\n`)
    const t0 = Date.now()
    const shipStart = await call('git.ship', { message: 'V3 verify S22: routine ship', paths: [targetFile], waitSeconds: 100 })
    const result = await pollShip(shipStart.runId)
    const totalMs = Date.now() - t0
    const logTail = s => { const log = s.log; if (typeof log === 'string') return log.split('\n').slice(-5); if (Array.isArray(log)) return log.slice(-5); return log }
    const stageDurations = (result?.stages ?? []).map(s => ({ name: s.name, ms: s.finishedAt && s.startedAt ? new Date(s.finishedAt) - new Date(s.startedAt) : null }))
    summary.s22_routine = { totalMs, stageDurations, rawResult: result, logTails: (result?.stages ?? []).map(s => ({ name: s.name, tail: logTail(s) })) }
    observe('S22 routine ship result (raw)', { totalMs, rawResult: result })
    assert.ok(result, 'no git.ship.status result')

    // (b) docs-only ship.
    const docsFile = 'docs/v3-s22-probe.md'
    await mkdir(join(clonePath, 'docs'), { recursive: true }).catch(() => {})
    await writeFile(join(clonePath, docsFile), `# V3 S22 docs probe\n${Date.now()}\n`)
    const t1 = Date.now()
    const docsShipStart = await call('git.ship', { message: 'V3 verify S22: docs-only ship', paths: [docsFile], waitSeconds: 100 })
    const docsResult = await pollShip(docsShipStart.runId)
    summary.s22_docsOnly = { totalMs: Date.now() - t1, rawResult: docsResult }
    observe('S22 docs-only ship result', summary.s22_docsOnly)

    // (c) scripts/ ship.
    const scriptFile = 'scripts/v3-s22-probe.mjs'
    await writeFile(join(clonePath, scriptFile), `// V3 S22 scripts probe ${Date.now()}\n`)
    const t2 = Date.now()
    const scriptsShipStart = await call('git.ship', { message: 'V3 verify S22: scripts ship', paths: [scriptFile], waitSeconds: 100 })
    const scriptsResult = await pollShip(scriptsShipStart.runId)
    summary.s22_scripts = { totalMs: Date.now() - t2, rawResult: scriptsResult }
    observe('S22 scripts ship result', summary.s22_scripts)
  }

  if (runs('s23')) {
    const probeFile = 'docs/v3-probe.md'
    await mkdir(join(clonePath, 'docs'), { recursive: true }).catch(() => {})
    await writeFile(join(clonePath, probeFile), 'A')
    const shipStart = await call('git.ship', { message: 'V3 verify S23: mid-delivery change', paths: [probeFile] })
    // As soon as the test/build stage is running, overwrite with "B".
    let overwritten = false
    for (let i = 0; i < 60 && !overwritten; i++) {
      const status = await call('git.ship.status', { runId: shipStart.runId, waitSeconds: 1 })
      const testStage = (status?.stages ?? []).find(s => /test|build/i.test(s.id))
      if (testStage?.startedAt && !testStage?.finishedAt) { await writeFile(join(clonePath, probeFile), 'B'); overwritten = true; observe('overwrote the file with B while test/build stage was running') }
      await new Promise(r => setTimeout(r, 500))
    }
    const result = await pollShip(shipStart.runId)
    const committedContent = execFileSync('git', ['show', `HEAD:${probeFile}`], { cwd: clonePath, encoding: 'utf8' })
    const workingTreeContent = readFileSync(join(clonePath, probeFile), 'utf8')
    const gitStatus = execSync('git status --porcelain', { cwd: clonePath, encoding: 'utf8' })
    summary.s23_overwrite = { overwritten, committedContent, workingTreeContent, dirty: gitStatus.trim().length > 0, rawResult: result }
    observe('S23 overwrite-during-delivery result', { overwritten, committedContent, workingTreeContent, dirty: summary.s23_overwrite.dirty })
    assert.equal(committedContent, 'A', 'the commit should contain the verified content "A", not the mid-delivery overwrite')

    // Second run: delete the file mid-delivery.
    await writeFile(join(clonePath, probeFile), 'A2')
    const shipStart2 = await call('git.ship', { message: 'V3 verify S23: mid-delivery delete', paths: [probeFile] })
    let deleted = false
    for (let i = 0; i < 60 && !deleted; i++) {
      const status = await call('git.ship.status', { runId: shipStart2.runId, waitSeconds: 1 })
      const testStage = (status?.stages ?? []).find(s => /test|build/i.test(s.id))
      if (testStage?.startedAt && !testStage?.finishedAt) { await unlink(join(clonePath, probeFile)).catch(() => {}); deleted = true; observe('deleted the file while test/build stage was running') }
      await new Promise(r => setTimeout(r, 500))
    }
    const result2 = await pollShip(shipStart2.runId)
    summary.s23_delete = { deleted, rawResult: result2 }
    observe('S23 delete-during-delivery result', summary.s23_delete)
  }

  if (runs('s19')) {
    // Exact controller spec: while a ship holds (waitSeconds so its own HTTP request stays
    // pending and occupies a slot), fire 10 simultaneous long-polling git.ship.status reads
    // (waitSeconds:30, so each genuinely holds a slot instead of returning in ~15ms) and expect
    // 7 accepted (8 total incl. the ship) + 3x429. Then with no ship running, fire 12 and expect
    // 8 accepted + 4x429.
    const probeFile2 = 'docs/v3-s19-probe.md'
    await writeFile(join(clonePath, probeFile2), `S19 probe ${Date.now()}\n`)
    const shipStart = Date.now()
    const shipPromise = request('git.ship', { message: 'V3 verify S19: concurrency probe', paths: [probeFile2], waitSeconds: 100 })
    let shipSettled = false
    shipPromise.then(() => { shipSettled = true })
    await new Promise(r => setTimeout(r, 2000)) // let the ship start holding
    const shipStatusBeforeBurst = await call('git.ship.status', { waitSeconds: 0 })
    observe('S19 ship status just before burst (must be running)', { state: shipStatusBeforeBurst?.state, shipSettled, elapsedMs: Date.now() - shipStart })

    const fireN = n => Promise.all(Array.from({ length: n }, () => request('git.ship.status', { waitSeconds: 30 })))
    const burst10 = await fireN(10)
    const accepted10 = burst10.filter(r => r.status === 200)
    const rejected10 = burst10.filter(r => r.status === 429)
    summary.s19_burstWithShip = { acceptedCount: accepted10.length, rejectedCount: rejected10.length, rejectedMessages: [...new Set(rejected10.map(r => JSON.stringify(r.body)))], acceptedLatenciesMs: accepted10.map(r => r.latencyMs), rejectedLatenciesMs: rejected10.map(r => r.latencyMs), shipStillRunningDuringBurst: !shipSettled }
    observe('S19 10-simultaneous-reads burst WHILE ship holds', summary.s19_burstWithShip)

    const shipResult = await shipPromise
    summary.s19_shipResult = { status: shipResult.status, latencyMs: shipResult.latencyMs }
    observe('S19 ship request settled', summary.s19_shipResult)

    // Now with no ship running: fire 12 simultaneous waiting reads, expect 8 accepted + 4x429.
    const burst12 = await fireN(12)
    const accepted12 = burst12.filter(r => r.status === 200)
    const rejected12 = burst12.filter(r => r.status === 429)
    summary.s19_burstNoShip = { acceptedCount: accepted12.length, rejectedCount: rejected12.length, rejectedMessages: [...new Set(rejected12.map(r => JSON.stringify(r.body)))], acceptedLatenciesMs: accepted12.map(r => r.latencyMs) }
    observe('S19 12-simultaneous-reads burst with NO ship running', summary.s19_burstNoShip)
  }

  if (runs('s20')) {
    const probeFile3 = 'docs/v3-s20-probe.md'
    await writeFile(join(clonePath, probeFile3), `S20 probe ${Date.now()}\n`)
    const shipPromise2 = request('git.ship', { message: 'V3 verify S20: two mutations', paths: [probeFile3], waitSeconds: 100 })
    await new Promise(r => setTimeout(r, 2000))
    const tabsOpenStart = Date.now()
    const tabsOpenResult = await request('tabs.open', { kind: 'agent', provider: 'claude', title: 'S20 concurrent open' })
    const tabsOpenLatencyMs = Date.now() - tabsOpenStart
    summary.s20_tabsOpenDuringShip = { status: tabsOpenResult.status, latencyMs: tabsOpenLatencyMs, underFiveSeconds: tabsOpenLatencyMs < 5000 }
    observe('S20 tabs.open latency while git.ship holds', summary.s20_tabsOpenDuringShip)
    if (tabsOpenLatencyMs >= 5000) observe('S20 FINDING: tabs.open waited on git.ship (different method family) — spec requires it not to', summary.s20_tabsOpenDuringShip)

    if (tabsOpenResult.status === 200) {
      const tabId = tabsOpenResult.body.result.id
      const [renameA, renameB] = await Promise.all([request('tabs.rename', { tabId, title: 'First' }), request('tabs.rename', { tabId, title: 'Second' })])
      const finalTabs = await call('app.state')
      const finalTitle = finalTabs.tabs?.find?.(t => t.id === tabId)?.title
      summary.s20_renameRace = { renameA: renameA.status, renameB: renameB.status, finalTitle }
      observe('S20 two simultaneous tabs.rename', summary.s20_renameRace)
    }
    await shipPromise2.catch(() => {})
  }

  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 2000) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  if (firstPid && alive(firstPid)) { try { execFileSync('taskkill.exe', ['/pid', String(firstPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /ship|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
const outDirName = scenarioArg === 'all' ? 'S22' : scenarioArg.split(',')[0].toUpperCase()
const outFileName = scenarioArg.split(',').join('-')
await mkdir(join(output, outDirName), { recursive: true })
await writeFile(join(output, outDirName, `${outFileName}-ship-summary.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
