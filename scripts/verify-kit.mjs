// Shared verify harness (.conductor/loops/verify.md v3, section 0; feature-list.md verify-kit).
//
// Every verify smoke imports this and adds only scenario logic. It exists because the 2026-09-24/25
// rounds (docs/verification/2026-09-25-verifier-retro.md) copied the same helpers into 70 scripts,
// lost 9-10 h to a bare `await app.close()` that never returned, and filed a REOPEN on a process
// query that matched its own command line. So here:
//   - launchParked({mode}) gives a temp CONDUCTOR_TEST_USER_DATA (the window parks off-screen) and
//     tracks every pid the instance ever had, relaunches included;
//   - call() throws on anything but a 200 result and never retries a mutation;
//   - safeClose() bounds app.close() to 20 s and then kills only processes from its own tree;
//   - watchdog(sec) turns a hang into a HUNG row, a screenshot and exit 2;
//   - processAlive(marker) excludes itself, its query and its own shell ancestry;
//   - loadCheck() records whether the machine was quiet enough for the numbers to count;
//   - record() appends to results.md at once, so a judge can read a run in progress.
//
// Usage (always under the lock, one smoke machine-wide):
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-<round>-<group>.mjs
// A smoke is: configure(), watchdog(), loadCheck(), launchParked(), scenarios with record(), finish().
// scripts/smoke-kit-v4-a-retry.mjs (playwright) and smoke-kit-v3-s12-restart.mjs (spawn) are the
// reference ports.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { cpus, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCK_DIR, parseHolderText } from './smoke-lock.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUILD = join(REPO, 'out', 'main', 'index.js')
/** app.close() gets this long before the tree is killed: V4 group B waited 7 h 35 min on one. */
export const CLOSE_BOUND_MS = 20_000
/** agent-control-ui.ts: the renderer did not answer a UI action (usually: workspace not mounted yet). */
export const ACK_TIMEOUT = /did not acknowledge/i
/** SessionPhase values (src/shared/structured-agent.ts) in which a tab is mid-turn. */
export const MID_TURN_PHASES = new Set(['starting', 'running', 'waiting_approval', 'interrupting'])
/** The v3 vocabulary: NOT RUN always names its reason (owner, harness, lock, load, time-box...). */
export const VERDICT = /^(PASS|FAIL|HUNG|INFO|LOAD|NOT RUN \([^)]+\))$/

// ---------------------------------------------------------------- pure helpers (verify-kit.test.mjs)

export const sleep = ms => new Promise(done => setTimeout(done, ms))

/** Races a promise against a wall-clock deadline. Never throws and never hangs:
 *  {ok:true,value} | {ok:false,error} | {ok:false,timedOut:true}. */
export async function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise(done => { timer = setTimeout(() => done({ ok: false, timedOut: true }), ms) })
  try {
    return await Promise.race([Promise.resolve(promise).then(value => ({ ok: true, value }), error => ({ ok: false, error })), deadline])
  } finally { clearTimeout(timer) }
}

/** Polls `fn` until it returns a truthy value; throws naming `label` and the last value at the deadline. */
export async function poll(fn, { timeoutMs, intervalMs = 500, label = 'condition', wait = sleep, now = Date.now } = {}) {
  if (!(timeoutMs > 0)) throw new Error('poll needs a timeoutMs: every wait has a wall-clock deadline')
  const started = now()
  let last
  for (;;) {
    try { last = await fn() } catch (error) { last = error }
    if (last && !(last instanceof Error)) return last
    if (now() - started >= timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`.slice(0, 1500))
    await wait(intervalMs)
  }
}

/** Retries `fn` only on "did not acknowledge" - the renderer missing a UI action while a workspace
 *  mounts (V3 S7, RV1). Any other error, or the last attempt's, is thrown unchanged. */
export async function retryAck(fn, { attempts = 5, delayMs = 8000, wait = sleep, log = message => console.log(message) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(attempt) } catch (error) {
      if (attempt >= attempts || !ACK_TIMEOUT.test(String(error?.message ?? error))) throw error
      log(`[verify-kit] "did not acknowledge", retry ${attempt + 1}/${attempts} in ${delayMs / 1000} s`)
      await wait(delayMs)
    }
  }
}

/** Win32_Process rows from `ConvertTo-Json` (an object for one row, an array otherwise). */
export function parseProcessList(json) {
  const text = String(json ?? '').trim()
  if (!text) return []
  const rows = JSON.parse(text)
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), commandLine: row.CommandLine == null ? '' : String(row.CommandLine) }))
}

/** `pid`'s parent chain (not `pid` itself). Guards against cycles from reused pids. */
export function ancestorsOf(list, pid) {
  const byPid = new Map(list.map(entry => [entry.pid, entry]))
  const seen = new Set()
  let current = byPid.get(pid)
  while (current && current.ppid && !seen.has(current.ppid) && current.ppid !== pid) {
    seen.add(current.ppid)
    current = byPid.get(current.ppid)
  }
  return seen
}

/** Every listed process under any of `roots`, roots included when they are still listed. */
export function descendantsOf(list, roots) {
  const children = new Map()
  for (const entry of list) { if (!children.has(entry.ppid)) children.set(entry.ppid, []); children.get(entry.ppid).push(entry.pid) }
  const listed = new Set(list.map(entry => entry.pid))
  const found = new Set()
  const queue = [...roots].filter(pid => pid != null)
  for (const pid of queue) if (listed.has(pid)) found.add(pid)
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) if (!found.has(child)) { found.add(child); queue.push(child) }
  }
  return found
}

/** Processes whose command line holds `marker`, minus the observer: this process, its ancestors (the
 *  shell or agent command that launched the smoke can quote the marker too) and the query process
 *  with anything it spawned. RV1 A2's `CommandLine -like '*marker*'` matched itself; this cannot,
 *  since the marker never enters the query's own command line and the query is excluded anyway. */
export function matchProcesses(list, marker, { selfPid = process.pid, queryPid } = {}) {
  if (typeof marker !== 'string' || marker.length < 6) throw new Error(`processAlive needs a distinctive marker of 6+ characters, got ${JSON.stringify(marker)}`)
  const excluded = new Set([selfPid, ...ancestorsOf(list, selfPid)])
  if (queryPid != null) for (const pid of descendantsOf(list, [queryPid])) excluded.add(pid)
  if (queryPid != null) excluded.add(queryPid)
  return list.filter(entry => !excluded.has(entry.pid) && entry.commandLine.includes(marker))
}

/** The snapshot entries still running as the same process (pid, image and command line all equal),
 *  so a pid Windows reused for something else is never killed. */
export function sameProcesses(snapshot, list) {
  return list.filter(entry => snapshot.some(old => old.pid === entry.pid && old.name === entry.name && old.commandLine === entry.commandLine))
}

/** Port and API key from a llama-server command line (src/main/local-models/llama.ts llamaServerArgs). */
export function parseLlamaCommandLine(commandLine) {
  const port = /--port[= ]+"?(\d+)/.exec(commandLine ?? '')
  if (!port) return null
  const key = /--api-key[= ]+"?([^\s"]+)/.exec(commandLine)
  return { port: Number(port[1]), apiKey: key ? key[1] : null }
}

/** `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`: one percent per GPU. */
export function parseNvidiaSmi(text) {
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+(\.\d+)?$/.test(line)).map(Number)
}

/** Whole-machine CPU busy percent between two os.cpus() samples. */
export function cpuPercent(before, after) {
  let idle = 0, total = 0
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i].times, b = after[i].times
    const spent = Object.keys(b).reduce((sum, key) => sum + (b[key] - (a[key] ?? 0)), 0)
    total += spent
    idle += b.idle - a.idle
  }
  return total > 0 ? Math.round(((total - idle) / total) * 1000) / 10 : 0
}

/** The quiet-machine thresholds, read from src/main/schedule-gate.ts itself so the kit and the
 *  scheduler can never disagree about what "quiet" means. */
export function readGateThresholds(source) {
  const number = name => { const match = new RegExp(`\\b${name}:\\s*(\\d+(?:\\.\\d+)?)`).exec(source); if (!match) throw new Error(`schedule-gate.ts no longer defines ${name}`); return Number(match[1]) }
  return { machineCpuPercent: number('machineCpuPercent'), gpuPercent: number('gpuPercent') }
}

/** Quiet or not, with every reason. Perf numbers only count on a quiet record (verify.md section 3.4). */
export function judgeLoad(sample, thresholds, { selfTabs = 1 } = {}) {
  const reasons = []
  if (sample.lock?.held && !sample.lock.self) reasons.push(`smoke lock held by pid ${sample.lock.holder?.pid} (${String(sample.lock.holder?.command ?? '').slice(0, 80)})`)
  if (sample.cpuPercent == null) reasons.push('CPU load unknown')
  else if (sample.cpuPercent >= thresholds.machineCpuPercent) reasons.push(`CPU ${sample.cpuPercent}% >= ${thresholds.machineCpuPercent}%`)
  if (sample.gpuPercent == null) reasons.push('GPU load unknown')
  else if (sample.gpuPercent >= thresholds.gpuPercent) reasons.push(`GPU ${sample.gpuPercent}% >= ${thresholds.gpuPercent}%`)
  for (const server of sample.llama ?? []) {
    if (server.busy) reasons.push(`llama-server pid ${server.pid} on port ${server.port} is generating`)
    else if (server.busy == null) reasons.push(`llama-server pid ${server.pid} state unknown`)
  }
  if (sample.midTurn?.count == null) reasons.push(`mid-turn tabs unknown (${sample.midTurn?.note ?? 'no answer'})`)
  else if (sample.midTurn.count > selfTabs) reasons.push(`${sample.midTurn.count - selfTabs} mid-turn tab(s) besides the caller`)
  return { quiet: reasons.length === 0, reasons }
}

/** One results.md line. `numbers` is JSON so a judge can diff runs; evidence is paths or text. */
export function formatRecordLine({ at, id, verdict, numbers, evidence }) {
  const figures = numbers && Object.keys(numbers).length ? ` ${JSON.stringify(numbers)}` : ''
  const note = evidence ? ` - ${String(evidence).replace(/\r?\n/g, ' ')}` : ''
  return `- ${at} **${id}** ${verdict}${figures}${note}\n`
}

// ---------------------------------------------------------------- run state, results, watchdog

const state = { name: null, output: null, results: [], instances: [], current: null, lastStep: 'start', watchdog: null, headerWritten: false, finishing: false }
const scriptName = () => basename(process.argv[1] ?? 'verify', '.mjs').replace(/^smoke-/, '')
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'verify'

/** name: the run's label; output: where results.md, results.json and screenshots go (a round can
 *  point several smokes at one folder). Defaults: the script's name, artifacts/verify-kit/<name>. */
export function configure({ name, output } = {}) {
  if (name) state.name = name
  if (output) state.output = resolve(REPO, output)
}
export const outputDir = () => {
  state.output ??= join(REPO, 'artifacts', 'verify-kit', slug(state.name ?? scriptName()))
  mkdirSync(state.output, { recursive: true })
  return state.output
}
export const results = () => state.results.slice()
export const current = () => state.current

/** Names the step a watchdog or a failure will report. */
export function step(label) {
  state.lastStep = label
  console.log(`[step] ${label}`)
}

const gitHead = () => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() || '?' } catch { return '?' } }
const buildTime = () => { try { return statSync(BUILD).mtime.toISOString() } catch { return 'missing' } }

function writeResultsJson(extra = {}) {
  try { writeFileSync(join(outputDir(), 'results.json'), JSON.stringify({ name: state.name ?? scriptName(), lastStep: state.lastStep, results: state.results, ...extra }, null, 2)) } catch { /* evidence is best effort, the .md line is already written */ }
}

/** Appends one line to results.md now (and rewrites results.json), so a hang or a kill never loses
 *  what already ran. The first record of a run writes a header with HEAD and the build's time. */
export function record(id, verdict, numbers = {}, evidence = '') {
  if (!VERDICT.test(verdict)) throw new Error(`record(${id}): verdict must be PASS, FAIL, HUNG, INFO, LOAD or NOT RUN (reason), got ${JSON.stringify(verdict)}`)
  const entry = { at: new Date().toISOString(), id: String(id), verdict, numbers: numbers ?? {}, evidence: evidence == null ? '' : String(evidence) }
  const file = join(outputDir(), 'results.md')
  if (!state.headerWritten) {
    appendFileSync(file, `\n## ${state.name ?? scriptName()} - ${entry.at} - HEAD ${gitHead()} - build ${buildTime()}\n\n`)
    state.headerWritten = true
  }
  appendFileSync(file, formatRecordLine(entry))
  state.results.push(entry)
  writeResultsJson()
  console.log(`[record] ${entry.id} ${verdict}${Object.keys(entry.numbers).length ? ' ' + JSON.stringify(entry.numbers) : ''}${entry.evidence ? ' - ' + entry.evidence.slice(0, 300) : ''}`)
  return entry
}

/** The catch-all for a smoke's try block: a FAIL row naming the last step(), the error and a
 *  screenshot of the current window (bounded, so a dead window cannot hang the report). */
export async function failed(error, id = 'error') {
  const taken = state.current && !state.current.closed ? await withDeadline(shot(`${slug(id)}-failure`), 10_000) : { ok: false }
  return record(id, 'FAIL', {}, `at step "${state.lastStep}": ${String(error?.stack ?? error).slice(0, 1500)}${taken.ok ? '; screenshot ' + taken.value : ''}`)
}

/** Wall-clock bound for the whole smoke. On expiry: a HUNG row naming the last step(), a screenshot
 *  of every live window, results.json, every own instance killed, exit 2. Calling it again resets it. */
export function watchdog(sec) {
  clearTimeout(state.watchdog)
  state.watchdog = setTimeout(() => { void fireWatchdog(sec) }, sec * 1000)
  state.watchdog.unref?.()
  return { clear: () => clearTimeout(state.watchdog) }
}

async function fireWatchdog(sec) {
  const hard = setTimeout(() => process.exit(2), 60_000)
  const at = state.lastStep
  console.error(`[verify-kit] WATCHDOG: ${sec} s exceeded at step "${at}"`)
  const shots = []
  for (const inst of state.instances.filter(entry => !entry.closed)) {
    const taken = await withDeadline(shot(`watchdog-${state.instances.indexOf(inst)}`, inst), 10_000)
    if (taken.ok) shots.push(taken.value)
  }
  try { record('watchdog', 'HUNG', { seconds: sec }, `stopped at step "${at}"${shots.length ? '; screenshots ' + shots.join(', ') : ''}`) } catch { /* keep tearing down */ }
  writeResultsJson({ hung: { seconds: sec, step: at } })
  for (const inst of state.instances) await withDeadline(safeClose(inst, { boundMs: 5000 }), 20_000)
  clearTimeout(hard)
  process.exit(2)
}

/** Ends the smoke: clears the watchdog, safeClose()s every instance, writes results.json and exits
 *  (1 when any row is FAIL or HUNG, unless `code` says otherwise). Temp roots are removed on a clean
 *  run and kept for evidence otherwise, or always with --keep. */
export async function finish({ code } = {}) {
  if (state.finishing) return
  state.finishing = true
  clearTimeout(state.watchdog)
  const closes = []
  for (const inst of state.instances) closes.push(await safeClose(inst))
  const failed = state.results.some(entry => entry.verdict === 'FAIL' || entry.verdict === 'HUNG')
  writeResultsJson({ closes })
  const exitCode = code ?? (failed ? 1 : 0)
  if (!exitCode && !process.argv.includes('--keep')) {
    for (const inst of state.instances) await rm(inst.root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
  } else for (const inst of state.instances) console.log(`[verify-kit] kept ${inst.root}`)
  process.exit(exitCode)
}

// ---------------------------------------------------------------- processes

const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

/** Every process on the machine, plus the pid of the query that listed them (to exclude it). */
export async function listProcesses({ timeoutMs = 30_000 } = {}) {
  if (process.platform !== 'win32') throw new Error('verify-kit process queries are Windows-only (Win32_Process)')
  const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  query.stdout.on('data', chunk => chunks.push(chunk))
  const exited = new Promise((done, fail) => { query.on('error', fail); query.on('close', done) })
  const outcome = await withDeadline(exited, timeoutMs)
  if (!outcome.ok) { try { query.kill() } catch { /* gone */ } throw new Error(`process query ${outcome.timedOut ? `took over ${timeoutMs / 1000} s` : 'failed: ' + outcome.error?.message}`) }
  return { list: parseProcessList(Buffer.concat(chunks).toString('utf8')), queryPid: query.pid }
}

/** Processes (pid, name, commandLine) whose command line holds `marker`, never the observer itself. */
export async function findProcesses(marker) {
  const { list, queryPid } = await listProcesses()
  return matchProcesses(list, marker, { selfPid: process.pid, queryPid })
}

/** Whether anything besides this smoke, its shell ancestry and its own query carries `marker`. */
export async function processAlive(marker) {
  return (await findProcesses(marker)).length > 0
}

const taskkill = pid => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status

// ---------------------------------------------------------------- launch and control

const freePort = () => new Promise((done, fail) => { const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)) }) })
const electronPath = () => createRequire(import.meta.url)('electron')

/** A parked Conductor on a fresh temp profile. mode 'playwright' drives the UI through
 *  _electron.launch; mode 'spawn' starts plain Electron (with a CDP port for the UI) and is the one
 *  to use for anything that restarts the app - Playwright loses a relaunched app (RV1 C10).
 *  env adds or overrides variables (undefined deletes one); fixtures {file: source} are written to
 *  a folder named by CONDUCTOR_TEST_FIXTURE_DIR. */
export async function launchParked({ mode = 'playwright', name, env: extraEnv = {}, fixtures, args = [], launchTimeoutMs = 60_000 } = {}) {
  if (mode !== 'playwright' && mode !== 'spawn') throw new Error(`launchParked mode must be 'playwright' or 'spawn', got ${JSON.stringify(mode)}`)
  if (!existsSync(BUILD)) throw new Error(`${BUILD} is missing: build first (npx electron-vite build)`)
  if (!process.env.CONDUCTOR_TEST_PARENT_PID) console.warn('[verify-kit] not under smoke-lock: run it as node scripts/smoke-lock.mjs -- node <smoke>')
  const label = name ?? state.name ?? scriptName()
  const root = await mkdtemp(join(tmpdir(), `conductor-${slug(label)}-`))
  const profile = join(root, 'profile')
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_LIVE_TESTS', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_UPDATE_DEV', 'CONDUCTOR_TEST_DIALOGS']) delete env[key]
  if (fixtures) {
    const dir = join(root, 'fixtures')
    await mkdir(dir, { recursive: true })
    for (const [file, source] of Object.entries(fixtures)) await writeFile(join(dir, file), source)
    env.CONDUCTOR_TEST_FIXTURE_DIR = dir
  }
  for (const [key, value] of Object.entries(extraEnv)) { if (value === undefined) delete env[key]; else env[key] = String(value) }
  const inst = { mode, name: label, root, profile, env, pids: new Set(), credential: null, projectId: null, workspaceId: null, app: null, page: null, child: null, cdpPort: null, browser: null, errors: [], closed: false }
  state.instances.push(inst)
  state.current = inst
  step(`launch ${mode} (${root})`)
  if (mode === 'playwright') {
    const { _electron } = await import('@playwright/test')
    inst.app = await _electron.launch({ args: [BUILD, ...args], env, timeout: 30_000 })
    const pid = inst.app.process().pid
    inst.pids.add(pid)
    const log = join(root, 'app.log')
    for (const stream of [inst.app.process().stdout, inst.app.process().stderr]) stream?.on('data', chunk => { try { appendFileSync(log, chunk) } catch { /* evidence only */ } })
    inst.page = await inst.app.firstWindow()
    inst.page.setDefaultTimeout(15_000)
    inst.page.on('pageerror', error => inst.errors.push(error.stack ?? error.message))
    await inst.page.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 })
    // Playwright's launcher pid is not always the main process's own; the credential names the latter.
    const mainPid = await inst.app.evaluate(() => process.pid)
    inst.pids.add(mainPid)
    await owner(inst, { pid: mainPid, timeoutMs: launchTimeoutMs })
  } else {
    inst.cdpPort = await freePort()
    const log = openSync(join(root, 'app.log'), 'a')
    inst.child = spawn(electronPath(), [`--remote-debugging-port=${inst.cdpPort}`, BUILD, ...args], { env, stdio: ['ignore', log, log], windowsHide: true })
    closeSync(log)
    inst.pids.add(inst.child.pid)
    await owner(inst, { pid: inst.child.pid, timeoutMs: launchTimeoutMs })
  }
  console.log(`[verify-kit] launched ${mode} pid ${inst.credential.pid}`)
  return inst
}

const readCredential = inst => { try { return JSON.parse(readFileSync(join(inst.profile, 'control-owner.json'), 'utf8')) } catch { return null } }

/** The instance's owner credential (control-owner.json in its temp profile), waited for: `pid` asks
 *  for that exact process, `notPid` for any live one but that (a relaunch). */
export async function owner(inst = state.current, { pid, notPid, timeoutMs = 60_000 } = {}) {
  const credential = await poll(() => {
    const found = readCredential(inst)
    if (!found?.token || !isAlive(found.pid)) return null
    if (pid != null && found.pid !== pid) return null
    if (notPid != null && found.pid === notPid) return null
    return found
  }, { timeoutMs, intervalMs: 500, label: `control-owner.json${pid ? ' of pid ' + pid : ''}${notPid ? ' of a pid other than ' + notPid : ''}` })
  inst.credential = credential
  inst.pids.add(credential.pid)
  return credential
}

/** Waits for `oldPid` to exit and a new instance of the same profile to come up; seconds taken. */
export async function relaunched(inst = state.current, oldPid = inst.credential?.pid, { timeoutMs = 20_000 } = {}) {
  const started = Date.now()
  await poll(() => !isAlive(oldPid), { timeoutMs, intervalMs: 250, label: `pid ${oldPid} to exit` })
  await owner(inst, { notPid: oldPid, timeoutMs: 60_000 })
  if (inst.browser) { await withDeadline(inst.browser.close(), 5000); inst.browser = null; inst.page = null }
  return (Date.now() - started) / 1000
}

/** The raw control answer {status, body}. Prefer call(); this is for scenarios that expect a refusal. */
export async function callRaw(method, args = {}, { inst = state.current, projectId = inst?.projectId, workspaceId, timeoutMs = 60_000 } = {}) {
  const credential = inst.credential && isAlive(inst.credential.pid) ? inst.credential : await owner(inst)
  const scope = projectId ? { projectId, ...(workspaceId ? { workspaceId } : {}) } : undefined
  const response = await fetch(credential.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { error: `not JSON: ${text.slice(0, 300)}` } }
  return { status: response.status, body }
}

/** An app-control call on the instance's owner credential, scoped to its project once one is open.
 *  Throws on a non-200 status or an error body; never retries (a mutation may have happened). */
export async function call(method, args = {}, options = {}) {
  const { status, body } = await callRaw(method, args, options)
  if (status !== 200 || body?.error) throw new Error(`${method} -> HTTP ${status}: ${JSON.stringify(body?.error ?? body).slice(0, 1500)}`)
  return body.result
}

/** The instance's renderer page: Playwright's window, or a CDP connection for a spawned app
 *  (reconnected after a relaunch). */
export async function page(inst = state.current) {
  if (inst.mode === 'playwright') return inst.page
  if (inst.browser?.isConnected() && inst.page && !inst.page.isClosed()) return inst.page
  const { chromium } = await import('@playwright/test')
  inst.browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${inst.cdpPort}`).catch(() => null), { timeoutMs: 30_000, label: `CDP on port ${inst.cdpPort}` })
  const pages = inst.browser.contexts().flatMap(context => context.pages())
  inst.page = pages.find(entry => entry.url().includes('index.html')) ?? pages[0]
  inst.page.setDefaultTimeout(15_000)
  await inst.page.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 })
  return inst.page
}

/** Registers a project folder through control (projects.open), then waits for its workspace to mount
 *  in the window: the sidebar row is active and the pane workspace is rendered. files {path: text}
 *  are written first; git:true makes it a one-commit repository. */
export async function openProject({ name, path, git = false, files = {} } = {}, inst = state.current) {
  if (!name) throw new Error('openProject needs a name')
  const dir = path ?? join(inst.root, 'src', slug(name))
  await mkdir(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(join(dir, file)), { recursive: true }); await writeFile(join(dir, file), text) }
  if (git) {
    if (!files['README.md'] && !existsSync(join(dir, 'README.md'))) await writeFile(join(dir, 'README.md'), `# ${name}\n`)
    const run = (...gitArgs) => { const result = spawnSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', ...gitArgs], { cwd: dir, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${result.stderr}`) }
    run('init', '-q', '-b', 'main'); run('add', '.'); run('commit', '-q', '-m', 'Initial')
  }
  step(`open project ${name}`)
  const project = await call('projects.open', { path: dir, name }, { inst, projectId: null })
  inst.projectId = project.id
  inst.workspaceId = project.workspaces?.[0]?.id ?? null
  inst.projectPath = dir
  const view = await page(inst)
  const row = view.locator('.project-row').filter({ hasText: name }).first()
  if (!await row.isVisible().catch(() => false)) {
    await withDeadline(row.waitFor({ timeout: 5000 }), 6000)
    if (!await row.isVisible().catch(() => false)) { await view.reload(); await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 }) }
  }
  await row.waitFor({ timeout: 30_000 })
  await row.click()
  await view.locator('.project-row.active').filter({ hasText: name }).first().waitFor({ timeout: 30_000 })
  await view.locator('.pane-workspace').first().waitFor({ timeout: 30_000 })
  return { ...project, path: dir }
}

/** tabs.open (kind 'agent' unless given), retried on "did not acknowledge", then waited until the
 *  agent answers agents.status. Returns the tabs.open result (resourceId is the agentSessionId). */
export async function openTab(args = {}, { inst = state.current, attempts = 5, delayMs = 8000, mountTimeoutMs = 30_000 } = {}) {
  const request = { kind: 'agent', ...args }
  const tab = await retryAck(() => call('tabs.open', request, { inst }), { attempts, delayMs })
  if (request.kind === 'agent' && tab?.resourceId) await poll(() => call('agents.status', { agentSessionId: tab.resourceId }, { inst }), { timeoutMs: mountTimeoutMs, label: `agents.status of ${tab.resourceId}` })
  return tab
}

/** A PNG of the instance's window in the output folder; returns its repo-relative path. */
export async function shot(name, inst = state.current) {
  const file = join(outputDir(), `${name}.png`)
  if (inst.app) {
    const data = await inst.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    await writeFile(file, Buffer.from(data, 'base64'))
  } else await (await page(inst)).screenshot({ path: file })
  return relative(REPO, file).replace(/\\/g, '/')
}

/** Closes one instance (default: the current one) and proves it gone. The dialog is stubbed,
 *  app.close() gets `boundMs` (20 s), then every process of the instance's tree - snapshotted
 *  before the close, relaunches included - that is still the same process is killed, and nothing
 *  else. Returns {graceful, ms, tree, killed, leftovers}; leftovers must be empty. Idempotent. */
export async function safeClose(inst = state.current, { boundMs = CLOSE_BOUND_MS } = {}) {
  if (!inst) return null
  if (inst.closed) return inst.closeReport ?? null
  inst.closed = true
  const started = Date.now()
  const credential = readCredential(inst)
  if (credential?.pid) inst.pids.add(credential.pid)
  const before = await listProcesses().catch(() => null)
  const tree = before ? [...descendantsOf(before.list, [...inst.pids])].map(pid => before.list.find(entry => entry.pid === pid)) : []
  if (inst.browser) { await withDeadline(inst.browser.close(), 5000); inst.browser = null }
  let graceful = false
  if (inst.app) {
    await withDeadline(inst.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...dialogArgs) => { const buttons = dialogArgs.at(-1)?.buttons ?? []; const index = buttons.findIndex(label => label === "Don't Save" || label === 'Stop work and quit'); return { response: index >= 0 ? index : 0, checkboxChecked: false } }
    }), 5000)
    graceful = (await withDeadline(inst.app.close(), boundMs)).ok
  }
  const closeMs = Date.now() - started
  const killed = []
  if (before) {
    const after = await listProcesses().catch(() => null)
    for (const entry of after ? sameProcesses(tree, after.list) : tree.filter(entry => isAlive(entry.pid))) { taskkill(entry.pid); killed.push(entry.pid) }
  } else for (const pid of inst.pids) if (isAlive(pid)) { taskkill(pid); killed.push(pid) }
  let leftovers = []
  if (killed.length || !graceful) {
    leftovers = await poll(async () => {
      const now = await listProcesses().catch(() => null)
      const alive = now ? sameProcesses(tree, now.list) : [...inst.pids].filter(isAlive).map(pid => ({ pid }))
      return alive.length ? null : []
    }, { timeoutMs: 10_000, intervalMs: 1000, label: 'the killed tree to exit' }).catch(async () => {
      const now = await listProcesses().catch(() => null)
      return now ? sameProcesses(tree, now.list) : [...inst.pids].filter(isAlive).map(pid => ({ pid }))
    })
  }
  inst.closeReport = { graceful, closeMs, ms: Date.now() - started, tree: tree.length, killed, leftovers: leftovers.map(entry => ({ pid: entry.pid, name: entry.name })) }
  console.log(`[verify-kit] safeClose ${JSON.stringify(inst.closeReport)}`)
  return inst.closeReport
}

// ---------------------------------------------------------------- load

const gateThresholds = () => readGateThresholds(readFileSync(join(REPO, 'src', 'main', 'schedule-gate.ts'), 'utf8'))

async function slotsBusy(port, apiKey) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/slots`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const slots = await response.json()
    return Array.isArray(slots) ? slots.some(slot => slot?.is_processing === true) : null
  } catch { return null }
}

/** Mid-turn tabs in the owner's installed Conductor, read-only through its owner credential. */
async function midTurnTabs() {
  const file = join(process.env.APPDATA ?? '', 'Conductor', 'control-owner.json')
  let credential
  try { credential = JSON.parse(readFileSync(file, 'utf8')) } catch { return { count: 0, tabs: [], note: 'installed app has no control credential' } }
  if (!isAlive(credential.pid)) return { count: 0, tabs: [], note: 'installed app not running' }
  const ask = async (method, scope) => {
    const response = await fetch(credential.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: {}, ...(scope ? { scope } : {}) }), signal: AbortSignal.timeout(5000) })
    const body = await response.json()
    if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status}`)
    return body.result
  }
  try {
    const seen = new Map()
    for (const project of await ask('projects.list')) {
      for (const workspace of project.workspaces ?? []) {
        for (const agent of await ask('agents.list', { projectId: project.id, workspaceId: workspace.id })) {
          if (MID_TURN_PHASES.has(agent.phase)) seen.set(agent.agentSessionId, { agentSessionId: agent.agentSessionId, title: agent.title ?? null, phase: agent.phase })
        }
      }
    }
    return { count: seen.size, tabs: [...seen.values()] }
  } catch (error) { return { count: null, tabs: [], note: String(error.message ?? error) } }
}

/** Is the machine quiet enough for timings to count? Smoke-lock holder (the lock this smoke itself
 *  runs under is not load), whole-machine CPU over 1 s, GPU via nvidia-smi, llama-server /slots, and
 *  mid-turn tabs in the owner's app (selfTabs: how many of those are the caller's own, default 1).
 *  Thresholds are schedule-gate.ts's. Records a LOAD row unless record:false. Call it before
 *  launching, since the smoke's own app is load too. */
export async function loadCheck({ selfTabs = 1, record: write = true } = {}) {
  const thresholds = gateThresholds()
  const cpuBefore = cpus(), cpuStarted = Date.now()
  const processes = await listProcesses().catch(() => null)
  const lockHolder = (() => { try { return parseHolderText(readFileSync(join(LOCK_DIR, 'holder.txt'), 'utf8')) } catch { return null } })()
  const ancestry = processes ? ancestorsOf(processes.list, process.pid) : new Set()
  const lock = { held: Boolean(lockHolder), holder: lockHolder ? { pid: lockHolder.pid, command: lockHolder.command ?? '' } : null, self: Boolean(lockHolder) && (lockHolder.pid === Number(process.env.CONDUCTOR_TEST_PARENT_PID) || ancestry.has(lockHolder.pid)) }
  const gpuRun = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const gpus = gpuRun.status === 0 ? parseNvidiaSmi(gpuRun.stdout) : []
  const servers = (processes?.list ?? []).filter(entry => /^llama-server(\.exe)?$/i.test(entry.name))
  const llama = await Promise.all(servers.map(async entry => { const parsed = parseLlamaCommandLine(entry.commandLine); return { pid: entry.pid, port: parsed?.port ?? null, busy: parsed ? await slotsBusy(parsed.port, parsed.apiKey) : null } }))
  const midTurn = await midTurnTabs()
  await sleep(Math.max(0, 1000 - (Date.now() - cpuStarted)))
  const sample = { at: new Date().toISOString(), lock, cpuPercent: cpuPercent(cpuBefore, cpus()), gpuPercent: gpus.length ? Math.max(...gpus) : null, llama, midTurn }
  const verdict = judgeLoad(sample, thresholds, { selfTabs })
  const result = { ...sample, thresholds, selfTabs, ...verdict }
  if (write) record('load', 'LOAD', { quiet: verdict.quiet, cpu: sample.cpuPercent, gpu: sample.gpuPercent, lockHolder: lock.held ? (lock.self ? 'self' : lock.holder.pid) : null, llamaBusy: llama.filter(server => server.busy).length, midTurn: midTurn.count }, verdict.quiet ? 'quiet machine' : verdict.reasons.join('; '))
  return result
}
