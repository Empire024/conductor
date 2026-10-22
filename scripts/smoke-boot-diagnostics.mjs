import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { readBootVerdict } from './meta-wizard/boot.mjs'

// Startup diagnostics (docs/startup-diagnostics.md), for real on a parked app: a launch that dies at
// a known stage is reported with that stage, by the boot record and by the recovery watchdog.
//   1. structured-store:oom (V8 heap limited to 512 MB): died in stage structured-store, out of memory.
//   2. settings:exit: died in stage settings, exit code 70; the first launch is filed as the last
//      failure and in the history.
//   3. services:throw: the launch stays up, stalled in stage services after the exception.
//   4. no failure: ready, with readyMs, and app control answers.
//   5. that app is killed while the fail file says structured-store:oom: its recovery watchdog
//      relaunches twice, both die, and the report, the agent's error and the toast name the stage.
// Nothing touches the owner's installed app; toasts go to <profile>/recovery/toasts.jsonl.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-boot-diagnostics.mjs [--keep]   (after npm run build)

const HARD_TIMEOUT_MS = 8 * 60_000
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-boot-diagnostics-'))
const profile = join(root, 'profile'), failFile = join(root, 'boot-fail.txt'), diagnostics = join(profile, 'diagnostics'), recoveryDir = join(profile, 'recovery')
const electron = createRequire(import.meta.url)('electron')
const main = resolve('out/main/index.js')
const env = {
  ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_RUNTIME_HOST: '0', CONDUCTOR_TEST_PARENT_PID: String(process.pid), CONDUCTOR_TEST_BOOT_FAIL_FILE: failFile,
  CONDUCTOR_RECOVERY_WATCHDOG: '1',
  CONDUCTOR_RECOVERY_TIMINGS: JSON.stringify({ pollMs: 500, crashWaitMs: 3000, restartWaitMs: 5000, attemptWaitMs: 60_000, backoffMs: [500, 500], afterAgentWaitMs: 2000 })
}
for (const name of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_TEST_BOOT_FAIL', 'CONDUCTOR_RECOVERY_AGENT_COMMAND', 'CONDUCTOR_RECOVERY_REAL_AGENT', 'CONDUCTOR_RECOVERY_TEST_EXES', 'CONDUCTOR_LIVE_TESTS']) delete env[name]

const observations = []
const observe = (label, data = {}) => { const entry = { at: new Date().toISOString(), label, ...data }; observations.push(entry); process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`) }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' } }
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const until = async (what, check, timeoutMs, intervalMs = 500) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(intervalMs)
  }
}
const started = new Set()
const kill = pid => { if (!alive(pid)) return; try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* gone */ } }

/** One parked launch; resolves its pid, exit code (null while it runs) and log path. */
function launch(label, fail, extraArgs = []) {
  const log = join(root, `${label}.log`)
  const fd = openSync(log, 'a')
  const child = spawn(electron, [...extraArgs, main], { env, stdio: ['ignore', fd, fd], windowsHide: true })
  closeSync(fd)
  started.add(child.pid)
  const run = { pid: child.pid, log, exitCode: null, exited: new Promise(done => child.once('exit', code => { run.exitCode = code; done(code) })) }
  observe(`launched ${label}`, { pid: child.pid, fail })
  return run
}
const logText = async run => readFile(run.log, 'utf8').catch(() => '')
const exitWithin = async (run, ms) => Promise.race([run.exited, sleep(ms).then(() => { throw new Error(`pid ${run.pid} did not exit within ${ms} ms (log: ${run.log})`) })])

const summary = { root, profile, build: main, launches: {} }
const hard = setTimeout(() => { observe('hard timeout'); for (const pid of started) kill(pid); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let failed = null
try {
  assert.ok(existsSync(main), 'out/main/index.js is missing: run npm run build first')
  assert.ok(existsSync(resolve('out/main/recovery-watchdog.js')), 'out/main/recovery-watchdog.js is missing: run npm run build first')

  // 1. Out of memory in the conversation store, the failure of 2026-10-22.
  await writeFile(failFile, 'structured-store:oom')
  const oom = launch('oom', 'structured-store:oom', ['--js-flags=--max-old-space-size=512'])
  await exitWithin(oom, 90_000)
  const record1 = await readJson(join(diagnostics, 'boot.json'))
  assert.equal(record1.pid, oom.pid, 'boot.json is not the launch that died')
  assert.deepEqual(record1.stages.map(stage => stage.name), ['process-start', 'single-instance', 'app-ready', 'db-open', 'db-migrations', 'structured-store'])
  const verdict1 = await readBootVerdict(profile, { pid: oom.pid, alive: false, exitCode: oom.exitCode, log: await logText(oom) })
  observe('oom verdict', { exitCode: oom.exitCode, line: verdict1.line })
  assert.equal(verdict1.signature, 'died:structured-store:oom', verdict1.line)
  assert.match(verdict1.line, /^died in stage structured-store [\d.]+ s after start: V8 heap out of memory/)
  const sample = await readJson(join(diagnostics, 'boot-sample.json'))
  assert.equal(sample.pid, oom.pid, 'the sampler wrote nothing for the launch that died')
  observe('last sample before the abort', sample)
  // At a 512 MB heap the abort comes within a few hundred ms of the stage, often before the next
  // 500 ms sample; the sample proves the worker ran for this launch, the verdict proves the rest.
  assert.ok(sample.rssMb > 0 && sample.ms > 0, JSON.stringify(sample))
  summary.launches.oom = { pid: oom.pid, exitCode: oom.exitCode, verdict: verdict1.line }

  // 2. An exit in settings; the first launch is filed.
  await writeFile(failFile, 'settings:exit')
  const exit = launch('exit', 'settings:exit')
  assert.equal(await exitWithin(exit, 60_000), 70)
  const verdict2 = await readBootVerdict(profile, { pid: exit.pid, alive: false, exitCode: exit.exitCode, log: await logText(exit) })
  observe('exit verdict', { line: verdict2.line })
  assert.equal(verdict2.signature, 'died:settings:exit', verdict2.line)
  const filed = await readJson(join(diagnostics, 'boot-last-failure.json'))
  assert.equal(filed.pid, oom.pid)
  const history = (await readFile(join(diagnostics, 'boot-history.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(history.some(line => line.pid === oom.pid && line.outcome === 'died' && line.stage === 'structured-store'), `history: ${JSON.stringify(history)}`)
  // The filed record still answers for the first launch after a later one replaced boot.json.
  assert.equal((await readBootVerdict(profile, { pid: oom.pid, alive: false, log: await logText(oom) })).signature, 'died:structured-store:oom')
  summary.launches.exit = { pid: exit.pid, verdict: verdict2.line }

  // 3. An exception in services: the installed app keeps running after one, so the launch stalls.
  await writeFile(failFile, 'services:throw')
  const thrown = launch('throw', 'services:throw')
  const verdict3 = await until('a stalled verdict', async () => {
    const verdict = await readBootVerdict(profile, { pid: thrown.pid, alive: alive(thrown.pid) })
    return verdict.state === 'stalled' ? verdict : null
  }, 60_000, 1000)
  observe('throw verdict', { line: verdict3.line })
  assert.equal(verdict3.signature, 'stalled:services:exception')
  assert.match(verdict3.line, /\[test\] boot failure in stage services/)
  kill(thrown.pid)
  await exitWithin(thrown, 20_000)
  summary.launches.throw = { pid: thrown.pid, verdict: verdict3.line }

  // 4. A clean start is ready, and answers.
  await writeFile(failFile, '')
  const ok = launch('ready', 'none')
  const record4 = await until('outcome ready', async () => { const record = await readJson(join(diagnostics, 'boot.json')); return record.pid === ok.pid && record.outcome === 'ready' ? record : null }, 90_000)
  const verdict4 = await readBootVerdict(profile, { pid: ok.pid, alive: true })
  observe('ready verdict', { line: verdict4.line, stages: record4.stages.map(stage => `${stage.name}@${stage.ms}`) })
  assert.equal(verdict4.state, 'ready')
  assert.ok(record4.readyMs > 0)
  for (const stage of ['settings', 'services', 'control-api', 'control-ready', 'runtime-reattach', 'runtime-host', 'windows', 'ready']) assert.ok(record4.stages.some(entry => entry.name === stage), `stage ${stage} missing`)
  const owner = await readJson(join(profile, 'control-owner.json'))
  assert.equal(owner.pid, ok.pid)
  const answer = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tools.list', args: { brief: true } }) })
  assert.equal(answer.status, 200)
  summary.launches.ready = { pid: ok.pid, readyMs: record4.readyMs, peakHeapMb: record4.peak.heapMb }

  // 5. It crashes while every new launch would run out of memory: the watchdog relaunches twice and
  //    reports the stage, in the report, the agent's error and the toasts.
  const watchdog = await until('the recovery watchdog', async () => { const lock = await readJson(join(recoveryDir, 'watchdog.json')); return lock.appPid === ok.pid && alive(lock.pid) ? lock.pid : null }, 30_000)
  observe('watchdog armed', { watchdog })
  await writeFile(failFile, 'structured-store:oom')
  process.kill(ok.pid)
  const reportName = await until('a recovery report', async () => (await readdir(recoveryDir)).filter(name => /^recovery-.*\.json$/.test(name)).sort().at(-1) ?? null, 180_000, 1000)
  // The report is final once the watchdog exits.
  await until('the watchdog to finish', async () => !alive(watchdog), 120_000, 1000)
  const report = await readJson(join(recoveryDir, reportName))
  observe('recovery report', { outcome: report.outcome, error: report.error, attempts: report.attempts.map(attempt => ({ pid: attempt.pid, exitCode: attempt.exitCode, boot: attempt.boot })) })
  assert.equal(report.outcome, 'down')
  assert.equal(report.attempts.length, 2)
  for (const attempt of report.attempts) {
    started.add(attempt.pid)
    assert.match(attempt.boot ?? '', /^died in stage structured-store [\d.]+ s after start: V8 heap out of memory/, JSON.stringify(attempt))
  }
  const markdown = await readFile(join(recoveryDir, reportName.replace(/\.json$/, '.md')), 'utf8')
  assert.match(markdown, /died in stage structured-store/)
  const toasts = (await readFile(join(recoveryDir, 'toasts.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const down = toasts.find(toast => toast.title === 'Conductor is down')
  assert.ok(down && /died in stage structured-store/.test(down.body), `toasts: ${JSON.stringify(toasts)}`)
  summary.watchdog = { report: reportName, toast: down.body }
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAIL', { error: error?.stack ?? String(error) })
} finally {
  clearTimeout(hard)
  for (const pid of started) kill(pid)
  try { const lock = await readJson(join(recoveryDir, 'watchdog.json')); kill(lock.pid) } catch { /* none */ }
  await sleep(1000)
  if (!keep && !failed) await rm(root, { recursive: true, force: true }).catch(() => {})
  console.log(JSON.stringify({ ok: !failed, ...summary, observations }, null, 2))
  process.exitCode = failed ? 1 : 0
}
