// Shared verify harness (.conductor/loops/verify.md v3, section 0; feature-list.md verify-kit).
//
// Every verify smoke imports this and adds only scenario logic. It exists because the 2026-09-24/25
// rounds (docs/verification/2026-09-25-verifier-retro.md) copied the same helpers into 70 scripts,
// lost 9-10 h to a bare `await app.close()` that never returned, and filed a REOPEN on a process
// query that matched its own command line. So here:
//   - launchParked({mode}) gives a temp CONDUCTOR_TEST_USER_DATA (the window parks off-screen) and
//     tracks every pid the instance ever had, relaunches included;
//   - call() throws on anything but a 200 result and never retries a mutation;
//   - safeClose() bounds app.close() to 20 s and then kills only processes proven by OS identity
//     (creation time + image) to descend from roots registered at launch/relaunch, each re-verified
//     on its own killing handle; an unprovable process is reported, never killed by pid;
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
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { cpus, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lowerPriority } from './lib/background-priority.mjs'
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

/** Win32_Process rows from `ConvertTo-Json` (an object for one row, an array otherwise). creationTime
 *  is the OS creation time normalized to microseconds since 1601 UTC (WMI's own precision) as a
 *  decimal string, and executable the image path; either is null where the OS would not say. A row
 *  without a usable ProcessId means the inventory itself is broken, and that throws. */
export function parseProcessList(json) {
  const text = String(json ?? '').trim()
  if (!text) return []
  const rows = JSON.parse(text)
  return (Array.isArray(rows) ? rows : [rows]).map(row => {
    const pid = Number(row.ProcessId)
    // Only field names and types go into the error: a raw row can carry an API-key command line.
    if (!Number.isSafeInteger(pid) || pid < 0) throw new Error(`process inventory row without a process id (fields: ${row && typeof row === 'object' ? Object.keys(row).map(key => `${key}:${row[key] === null ? 'null' : typeof row[key]}`).join(', ').slice(0, 200) : typeof row})`)
    return {
      pid, ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), commandLine: row.CommandLine == null ? '' : String(row.CommandLine),
      creationTime: /^\d{1,20}$/.test(String(row.CreationTime ?? '')) && !/^0+$/.test(String(row.CreationTime)) ? String(row.CreationTime) : null,
      executable: typeof row.ExecutablePath === 'string' && row.ExecutablePath ? row.ExecutablePath : null
    }
  })
}

/** {pid, creationTime, executable} when the entry carries all three, else null: an entry without its
 *  OS identity can be observed but never acted on. */
export function identityOf(entry) {
  if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !entry.creationTime || !/^\d{1,20}$/.test(entry.creationTime) || !entry.executable) return null
  return { pid: entry.pid, creationTime: entry.creationTime, executable: entry.executable }
}

/** Same process: pid, creation time and image. Name and command line are not identity. */
export const sameIdentity = (a, b) => Boolean(a && b) && a.pid === b.pid && a.creationTime === b.creationTime && String(a.executable).toLowerCase() === String(b.executable).toLowerCase()

/**
 * The processes owned through `roots` (identities registered at launch/relaunch) in ONE snapshot.
 * A root counts only while that snapshot shows the same identity; a child is admitted only under an
 * admitted parent, with its own identity, and never older than that parent (a pid whose parent slot
 * was reused shows up as a "child" created before its "parent"). Nothing is carried over from an
 * earlier snapshot by pid. Returns {members, unresolved}: members carry depth (0 for roots);
 * unresolved names every entry that looked related but could not be proven.
 */
export function ownedTree(list, roots) {
  const byPid = new Map()
  const duplicate = new Set()
  for (const entry of list) { if (byPid.has(entry.pid)) duplicate.add(entry.pid); byPid.set(entry.pid, entry) }
  const children = new Map()
  for (const entry of list) { if (!children.has(entry.ppid)) children.set(entry.ppid, []); children.get(entry.ppid).push(entry) }
  const members = new Map()
  const unresolved = []
  const queue = []
  for (const root of roots) {
    const entry = byPid.get(root.pid)
    if (duplicate.has(root.pid)) unresolved.push({ pid: root.pid, reason: 'inventory lists this pid twice' })
    else if (!entry) unresolved.push({ pid: root.pid, reason: 'registered root is no longer running; any orphaned descendants cannot be attributed' })
    else if (!identityOf(entry)) unresolved.push({ pid: root.pid, reason: 'registered root has no readable OS identity' })
    else if (!sameIdentity(identityOf(entry), root)) unresolved.push({ pid: root.pid, reason: 'registered root pid now belongs to another process' })
    else if (!members.has(entry.pid)) { members.set(entry.pid, { ...entry, depth: 0 }); queue.push(entry.pid) }
  }
  while (queue.length) {
    const parent = members.get(queue.shift())
    for (const child of children.get(parent.pid) ?? []) {
      if (members.has(child.pid)) continue // a cycle, or a root reached again
      if (duplicate.has(child.pid)) { unresolved.push({ pid: child.pid, reason: 'inventory lists this pid twice' }); continue }
      if (!identityOf(child)) { unresolved.push({ pid: child.pid, name: child.name, reason: `child of ${parent.pid} has no readable OS identity` }); continue }
      if (BigInt(child.creationTime) < BigInt(parent.creationTime)) { unresolved.push({ pid: child.pid, name: child.name, reason: `created before its listed parent ${parent.pid}: the parent pid was reused` }); continue }
      members.set(child.pid, { ...child, depth: parent.depth + 1 })
      queue.push(child.pid)
    }
  }
  // A root that is itself the child of another member (a tracked descendant) sits below it: depth
  // follows the verified parent chain inside this tree, so kills stay leaves first.
  const depth = (member, seen = new Set()) => {
    const parent = members.get(member.ppid)
    if (!parent || parent.pid === member.pid || seen.has(member.pid) || BigInt(member.creationTime) < BigInt(parent.creationTime)) return 0
    seen.add(member.pid)
    return depth(parent, seen) + 1
  }
  return { members: [...members.values()].map(member => ({ ...member, depth: depth(member) })), unresolved }
}

/** The ownedTree reason for a child whose OS identity could not be read in that snapshot. */
export const UNREADABLE_CHILD = /^child of \d+ has no readable OS identity$/

/**
 * Re-probes children ownedTree could not identify. Win32_Process lists a process caught mid-exit
 * without its creation time or image path (a short-lived nvidia-smi from the app's own GPU polling,
 * fault 1790593849520), so one unreadable row is not yet a stranger. Fresh inventories for up to
 * `windowMs`. Its possible descendants are every pid reached from it through ppid links across the
 * `observed` snapshots safeClose already took, so U -> C -> G with U and C gone still finds G. It has exited - resolved, never killed -
 * only once neither it nor any of those pids is listed as a pid or a ppid. One still listed (readable
 * or not), with a listed descendant, or any entry left when an inventory fails, stays unresolved:
 * nothing proves what it is. Never kills anything. Returns {exited, still, failure}.
 */
export async function reprobeUnreadable(entries, { listProcesses: list, now, sleep, observed = [], windowMs = 10_000, intervalMs = 1000 }) {
  const family = new Map(entries.map(entry => [entry.pid, possibleDescendants(entry.pid, observed)]))
  const pending = new Map(entries.map(entry => [entry.pid, entry]))
  const exited = []
  const deadline = now() + windowMs
  let failure = null
  while (pending.size) {
    let rows
    try { rows = (await list()).list } catch (error) { failure = String(error?.message ?? error).slice(0, 200); break }
    for (const [pid, entry] of pending) {
      const pids = family.get(pid)
      if (!rows.some(row => pids.has(row.pid) || pids.has(row.ppid))) { exited.push(entry); pending.delete(pid) }
    }
    if (!pending.size || now() >= deadline) break
    await sleep(intervalMs)
  }
  return { exited, still: [...pending.values()], failure }
}

/** `pid` and every pid reached from it through ppid links in any of `snapshots`. Every link is
 *  followed, even one a reused pid may have made: taking in too much only makes the close stricter,
 *  while skipping a link could hide a live descendant. */
export function possibleDescendants(pid, snapshots) {
  const found = new Set([pid])
  for (let grew = true; grew;) {
    grew = false
    for (const rows of snapshots) for (const row of rows) {
      if (found.has(row.pid) || !found.has(row.ppid)) continue
      found.add(row.pid); grew = true
    }
  }
  return found
}

/** Kill order: deepest first, so no member outlives its own children being orphaned mid-kill. */
export const leavesFirst = members => [...members].sort((a, b) => b.depth - a.depth || a.pid - b.pid)

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

/** The snapshot entries still running with equal pid, image name and command line. Observation
 *  only: the same program relaunched on a reused pid matches too, so nothing here kills by it -
 *  safeClose acts on sameIdentity() (creation time and image path) alone. */
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
  // Without a whole process inventory, llama-server and lock ancestry are unknown, not absent.
  if (sample.inventory?.ok !== true) reasons.push(`process inventory unavailable${sample.inventory?.error ? ` (${sample.inventory.error})` : ''}`)
  if (sample.lock?.unknown) reasons.push('smoke lock state unknown (holder file unreadable)')
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
  // A close that cannot account for its processes is not a clean run, whatever the scenarios said.
  const unclean = closes.filter(close => close && (close.leftovers.length || close.unresolved?.length))
  if (unclean.length) try { record('cleanup', 'FAIL', { leftovers: unclean.reduce((sum, close) => sum + close.leftovers.length, 0), unresolved: unclean.reduce((sum, close) => sum + (close.unresolved?.length ?? 0), 0) }, JSON.stringify(unclean.map(close => ({ leftovers: close.leftovers, unresolved: close.unresolved }))).slice(0, 1500)) } catch { /* exit code below still fails */ }
  const failed = unclean.length > 0 || state.results.some(entry => entry.verdict === 'FAIL' || entry.verdict === 'HUNG')
  writeResultsJson({ closes })
  const exitCode = code ?? (failed ? 1 : 0)
  if (!exitCode && !process.argv.includes('--keep')) {
    for (const inst of state.instances) await rm(inst.root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
  } else for (const inst of state.instances) console.log(`[verify-kit] kept ${inst.root}`)
  process.exit(exitCode)
}

// ---------------------------------------------------------------- processes

const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

const PROCESS_QUERY = "$r = [long]0; Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,@{n='CreationTime';e={ if ($_.CreationDate) { [string][Math]::DivRem([long]$_.CreationDate.ToFileTimeUtc(), [long]10, [ref]$r) } }} | ConvertTo-Json -Compress"

/** Every process on the machine with its OS identity, plus the pid of the query that listed them (to
 *  exclude it). A failed, timed-out or nonzero query throws: there is no partial answer to act on. */
export async function listProcesses({ timeoutMs = 30_000 } = {}) {
  if (process.platform !== 'win32') throw new Error('verify-kit process queries are Windows-only (Win32_Process)')
  const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  query.stdout.on('data', chunk => chunks.push(chunk))
  const exited = new Promise((done, fail) => { query.on('error', fail); query.on('close', done) })
  const outcome = await withDeadline(exited, timeoutMs)
  if (!outcome.ok) { try { query.kill() } catch { /* gone */ } throw new Error(`process query ${outcome.timedOut ? `took over ${timeoutMs / 1000} s` : 'failed: ' + outcome.error?.message}`) }
  if (outcome.value !== 0) throw new Error(`process query exited ${outcome.value}`)
  const list = parseProcessList(Buffer.concat(chunks).toString('utf8'))
  if (!list.length) throw new Error('process query listed no processes')
  return { list, queryPid: query.pid }
}

/** Opens one handle to `pid` (pinning it against reuse while the script runs), compares creation
 *  time at listProcesses' microsecond precision and the image through that handle, and only then
 *  kills and waits on the same handle. Inputs come through the environment, never the command. */
const TERMINATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
function Say($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress)); exit 0 }
$id = [int]$env:VERIFY_KIT_PID
try { $p = [System.Diagnostics.Process]::GetProcessById($id) } catch { if ($_.Exception.GetBaseException() -is [System.ArgumentException]) { Say @{ state = 'absent' } }; Say @{ state = 'unknown'; detail = 'lookup: ' + $_.Exception.GetBaseException().Message } }
try { $null = $p.Handle } catch { Say @{ state = 'unknown'; detail = 'open: ' + $_.Exception.GetBaseException().Message } }
try {
  if ($p.HasExited) { Say @{ state = 'absent' } }
  $r = [long]0
  $created = [string][Math]::DivRem([long]$p.StartTime.ToFileTimeUtc(), [long]10, [ref]$r)
  $exe = $p.MainModule.FileName
} catch { if ($p.HasExited) { Say @{ state = 'absent' } }; Say @{ state = 'unknown'; detail = 'identity: ' + $_.Exception.GetBaseException().Message } }
if ($created -ne $env:VERIFY_KIT_CREATION -or $exe.ToLowerInvariant() -ne $env:VERIFY_KIT_EXE.ToLowerInvariant()) { Say @{ state = 'mismatch'; creationTime = $created; executable = $exe } }
try { $p.Kill() } catch { if ($p.HasExited) { Say @{ state = 'exited' } }; Say @{ state = 'unknown'; detail = 'kill: ' + $_.Exception.GetBaseException().Message } }
if ($p.WaitForExit([int]$env:VERIFY_KIT_WAIT_MS)) { Say @{ state = 'exited' } }
Say @{ state = 'signalled' }
`

/** Kills exactly the process with `identity`, verified on the killing handle; {state} is exited,
 *  signalled, mismatch (a different process holds the pid: untouched), absent, or unknown. Bounded:
 *  on timeout only this helper is killed, never another inferred process. */
export async function terminateIdentity(identity, { budgetMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { state: 'unknown', detail: 'identity-bound termination is Windows-only' }
  if (!identityOf(identity)) return { state: 'unknown', detail: 'no OS identity to verify' }
  const env = { ...process.env, VERIFY_KIT_PID: String(identity.pid), VERIFY_KIT_CREATION: identity.creationTime, VERIFY_KIT_EXE: identity.executable, VERIFY_KIT_WAIT_MS: String(Math.max(0, Math.min(5000, budgetMs - 2500))) }
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(TERMINATE_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env })
  const chunks = []
  helper.stdout.on('data', chunk => chunks.push(chunk))
  const exited = new Promise((done, fail) => { helper.on('error', fail); helper.on('close', done) })
  const outcome = await withDeadline(exited, budgetMs)
  if (!outcome.ok) { try { helper.kill() } catch { /* gone */ } return { state: 'unknown', detail: outcome.timedOut ? 'kill helper timed out' : `kill helper failed to start: ${outcome.error?.message}` } }
  if (outcome.value !== 0) return { state: 'unknown', detail: `kill helper exited ${outcome.value}` }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8').trim()) } catch { return { state: 'unknown', detail: 'kill helper answered unreadably' } }
}

/** Adds every process `list` proves to descend from this instance's roots (ownedTree, one snapshot)
 *  as a tracked identity of the same generation, so it stays attributable after its parent exits.
 *  What is tracked is the immutable (pid, creation time, image) triple verified now - a later
 *  process on the same pid never matches it - and no later snapshot is searched from these pids
 *  except through ownedTree's own identity checks. Returns the newly tracked identities. */
export function trackDescendants(inst, list) {
  const tree = ownedTree(list, inst.roots.filter(root => root.generation === inst.generation))
  const added = []
  for (const member of tree.members) {
    const identity = identityOf(member)
    // Seen alive with its whole subtree in this snapshot: if it exits later, its children as of
    // now are tracked, so its exit alone does not hide them (safeClose, observedTree).
    const existing = inst.roots.find(root => sameIdentity(root, identity))
    if (existing) { existing.observedTree = true; continue }
    const root = { ...identity, name: member.name, generation: inst.generation, source: 'descendant', registeredAt: new Date().toISOString(), observedTree: true }
    inst.roots.push(root)
    added.push(root)
  }
  return added
}

/** Tracks descendants every `intervalMs` until stopTracking (safeClose stops it). One inventory at
 *  a time; a failed one is counted, never read as "no descendants". Read-only. */
export function startTracking(inst, { intervalMs = 15_000, list = () => listProcesses({ timeoutMs: 20_000 }), log = () => {} } = {}) {
  stopTracking(inst)
  let busy = false
  inst.trackFailures ??= 0
  const tick = async () => {
    if (busy) return
    busy = true
    try { trackDescendants(inst, (await list()).list) } catch (error) { inst.trackFailures++; log(`[verify-kit] descendant tracking failed: ${String(error?.message ?? error).slice(0, 200)}`) } finally { busy = false }
  }
  inst.tracker = setInterval(() => { void tick() }, intervalMs)
  inst.tracker.unref?.()
  void tick()
  return tick
}
export function stopTracking(inst) { if (inst?.tracker) { clearInterval(inst.tracker); inst.tracker = null } }

/** Registers a child this process spawned as a root. `list` is a snapshot taken after the spawn;
 *  it proves the child's identity only if the child was still running when that snapshot was taken
 *  - checked *after* the snapshot: while Node has not seen the child exit, its handle keeps the pid
 *  from being reused - and if the listed process was created inside the spawn window. A child that
 *  exited first (its pid possibly already reused by someone else) is refused: nothing registered,
 *  so nothing can ever be killed on its account. */
export async function registerOwnChild(inst, child, { source, list, spawnedAtMs, now = Date.now, toleranceMs = 2000 } = {}) {
  const snapshot = list ?? (await listProcesses()).list
  if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error(`cannot register pid ${child?.pid} (${source}): the child exited before its identity was read, so the listed process may not be it`)
  const identity = identityOf(snapshot.find(entry => entry.pid === child.pid))
  if (identity && Number.isFinite(spawnedAtMs)) {
    const created = creationMs(identity.creationTime)
    if (created < spawnedAtMs - toleranceMs || created > now() + toleranceMs) throw new Error(`cannot register pid ${child.pid} (${source}): the listed process was created outside the spawn window`)
  }
  return registerRoot(inst, child.pid, { source, list: snapshot })
}

/** Registers `pid` as a root this instance owns, by its OS identity read now. Only launch/relaunch
 *  paths call this, for a pid they spawned themselves (pinned by Node's own handle) or one proven
 *  from such a root: a marker, a name or a credential file is never enough on its own. */
export async function registerRoot(inst, pid, { source, list, under } = {}) {
  const snapshot = list ?? (await listProcesses()).list
  const entry = snapshot.find(candidate => candidate.pid === pid)
  const identity = identityOf(entry)
  if (!identity) throw new Error(`cannot register pid ${pid} (${source}): ${entry ? 'its OS identity is unreadable' : 'it is not running'}`)
  if (under && !ownedTree(snapshot, under).members.some(member => sameIdentity(identityOf(member), identity))) throw new Error(`cannot register pid ${pid} (${source}): not a verified descendant of this instance's launch`)
  const root = { ...identity, name: entry.name, generation: inst.generation, source, registeredAt: new Date().toISOString() }
  if (!inst.roots.some(existing => sameIdentity(existing, root))) inst.roots.push(root)
  inst.pids.add(pid)
  // The registering snapshot already shows the root alive: its subtree as of now is tracked.
  trackDescendants(inst, snapshot)
  return inst.roots.find(existing => sameIdentity(existing, root))
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

// ---------------------------------------------------------------- launch and control

const freePort = () => new Promise((done, fail) => { const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)) }) })
const electronPath = () => createRequire(import.meta.url)('electron')

/** A parked Conductor on a fresh temp profile. mode 'playwright' drives the UI through
 *  _electron.launch; mode 'spawn' starts plain Electron (with a CDP port for the UI) and is the one
 *  to use for anything that restarts the app - Playwright loses a relaunched app (RV1 C10).
 *  env adds or overrides variables (undefined deletes one); fixtures {file: source} are written to
 *  a folder named by CONDUCTOR_TEST_FIXTURE_DIR. build: another out/main/index.js (a worktree's build
 *  of an older commit, for an upgrade run); relaunchParked keeps it unless given a new one. */
export async function launchParked({ mode = 'playwright', name, env: extraEnv = {}, fixtures, args = [], launchTimeoutMs = 60_000, build = BUILD } = {}) {
  if (mode !== 'playwright' && mode !== 'spawn') throw new Error(`launchParked mode must be 'playwright' or 'spawn', got ${JSON.stringify(mode)}`)
  if (!existsSync(build)) throw new Error(`${build} is missing: build first (npx electron-vite build)`)
  if (!process.env.CONDUCTOR_TEST_PARENT_PID) console.warn('[verify-kit] not under smoke-lock: run it as node scripts/smoke-lock.mjs -- node <smoke>')
  // Background work even without smoke-lock: the driver below normal, and the instance lowers its own
  // tree (src/main/background-priority.ts), so the owner's typing never waits on a verifier.
  lowerPriority()
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
  const inst = newInstance({ mode, build, name: label, root, profile, env })
  state.instances.push(inst)
  state.current = inst
  step(`launch ${mode} (${root})`)
  if (mode === 'playwright') {
    const { _electron } = await import('@playwright/test')
    const spawnedAtMs = Date.now()
    inst.app = await _electron.launch({ args: [build, ...args], env, timeout: 30_000 })
    const log = join(root, 'app.log')
    for (const stream of [inst.app.process().stdout, inst.app.process().stderr]) stream?.on('data', chunk => { try { appendFileSync(log, chunk) } catch { /* evidence only */ } })
    inst.page = await inst.app.firstWindow()
    inst.page.setDefaultTimeout(15_000)
    inst.page.on('pageerror', error => inst.errors.push(error.stack ?? error.message))
    await inst.page.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 })
    const mainPid = await registerPlaywrightRoots(inst, inst.app, { spawnedAtMs })
    await owner(inst, { pid: mainPid, timeoutMs: launchTimeoutMs })
  } else {
    inst.cdpPort = await freePort()
    const log = openSync(join(root, 'app.log'), 'a')
    const spawnedAtMs = Date.now()
    inst.child = spawn(electronPath(), [`--remote-debugging-port=${inst.cdpPort}`, build, ...args], { env, stdio: ['ignore', log, log], windowsHide: true })
    closeSync(log)
    await registerSpawnedRoot(inst, 'launch', spawnedAtMs)
    await owner(inst, { pid: inst.child.pid, timeoutMs: launchTimeoutMs })
  }
  // Descendants are tracked by identity while the app runs, so a later exit cannot hide them.
  startTracking(inst, { log: message => console.warn(message) })
  console.log(`[verify-kit] launched ${mode} pid ${inst.credential.pid}`)
  return inst
}

/** Instance state. `roots` is the only cleanup authority: identities registered at launch and at
 *  each explicit relaunch, all of this instance's `generation`. `pids` is kept for scripts that
 *  observe it; nothing is ever killed because a pid is in it. */
export function newInstance(fields = {}) {
  return { mode: 'playwright', build: BUILD, name: 'verify', root: null, profile: null, env: {}, pids: new Set(), roots: [], generation: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, credential: null, projectId: null, workspaceId: null, app: null, page: null, child: null, cdpPort: null, browser: null, errors: [], closed: false, ...fields }
}

/** Playwright's launcher is our own child (pinned by our handle); Electron main is it or a verified
 *  descendant of it in the same snapshot. Both become roots. Returns the main pid. A launch that
 *  cannot be identified is closed through Playwright's own handle rather than left untracked. */
export async function registerPlaywrightRoots(inst, app = inst.app, { spawnedAtMs } = {}) {
  const launcherPid = app.process().pid
  try {
    const mainPid = await app.evaluate(() => process.pid)
    const { list } = await listProcesses()
    const launcher = await registerOwnChild(inst, app.process(), { source: 'playwright launcher', list, spawnedAtMs })
    if (mainPid !== launcherPid) await registerRoot(inst, mainPid, { source: 'electron main', list, under: [launcher] })
    return mainPid
  } catch (error) {
    try { app.process().kill() } catch { /* already gone */ }
    throw error
  }
}

/** A spawn-mode child is pinned by our own handle until it exits; one we cannot identify is killed
 *  through that handle (never by pid) and the launch fails. */
async function registerSpawnedRoot(inst, source, spawnedAtMs) {
  try { await registerOwnChild(inst, inst.child, { source, spawnedAtMs }) } catch (error) {
    try { inst.child.kill() } catch { /* already gone */ }
    throw error
  }
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
  const credential = await owner(inst, { notPid: oldPid, timeoutMs: 60_000 })
  await registerRelaunch(inst, credential.pid)
  if (inst.browser) { await withDeadline(inst.browser.close(), 5000); inst.browser = null; inst.page = null }
  return (Date.now() - started) / 1000
}

/** listProcesses' creation time (microseconds since 1601 UTC) as milliseconds since 1970. */
export const creationMs = creationTime => Number(BigInt(creationTime) / 1000n) - 11_644_473_600_000

/** Whether `arg` is one whole argument of `commandLine` (quoted or bare), not a prefix of one. */
export function commandHasArg(commandLine, arg) {
  const norm = value => String(value).replace(/\//g, '\\').toLowerCase()
  const tokens = [...String(commandLine ?? '').matchAll(/"([^"]*)"|(\S+)/g)].map(match => norm(match[1] ?? match[2]))
  return tokens.includes(norm(arg))
}

/** What this instance's own temp profile says about the running app: control-owner.json's pid and
 *  when the file was last written. The profile is unique to this instance (mkdtemp). */
export function readCredentialProof(inst) {
  const path = join(inst.profile, 'control-owner.json')
  try { return { path, pid: JSON.parse(readFileSync(path, 'utf8')).pid, mtimeMs: statSync(path).mtimeMs } } catch { return null }
}

/**
 * The explicit registration of an app-initiated relaunch (app.restart). Proof that pid P is this
 * instance's relaunched app, all required:
 *  - this instance's own profile credential (unique temp profile) names P;
 *  - the process now on P was created no later than that credential was written: it was alive and
 *    holding P when the app on this profile wrote "I am P", so it is that app. A foreign process
 *    that reused P after our app died was created after the write, and is refused;
 *  - it runs the image of a root registered under this generation, created after that root;
 *  - this instance's build is one whole argument of its command line (no prefix lookalikes).
 * Anything less stays unregistered, is reported by the thrown error, and is never killed.
 */
export async function registerRelaunch(inst, pid, { list, credential } = {}) {
  const proof = credential ?? readCredentialProof(inst)
  const snapshot = list ?? (await listProcesses()).list
  const entry = snapshot.find(candidate => candidate.pid === pid)
  const identity = identityOf(entry)
  const expectedPath = inst.profile ? join(inst.profile, 'control-owner.json').toLowerCase() : null
  const problems = []
  if (!proof || !expectedPath || String(proof.path ?? '').toLowerCase() !== expectedPath) problems.push('no credential from this instance\'s own profile')
  else if (proof.pid !== pid) problems.push(`the profile credential names pid ${proof.pid}`)
  if (!identity) problems.push('its OS identity is unreadable')
  const predecessor = identity && inst.roots.find(root => root.generation === inst.generation && root.executable.toLowerCase() === identity.executable.toLowerCase() && BigInt(root.creationTime) < BigInt(identity.creationTime))
  if (identity && !predecessor) problems.push('no earlier root of this generation runs its image')
  if (identity && proof && !(creationMs(identity.creationTime) <= proof.mtimeMs + 2)) problems.push('it was created after the profile credential was written (a reused pid)')
  if (entry && !commandHasArg(entry.commandLine, inst.build ?? BUILD)) problems.push('this instance\'s build is not one of its arguments')
  if (problems.length) throw new Error(`relaunched pid ${pid} is not provably this instance's app: ${problems.join('; ')}; it is left unregistered`)
  return registerRoot(inst, pid, { source: 'relaunch', list: snapshot })
}

/** Starts a spawn-mode instance again on its own profile after the scenario quit or killed it (an
 *  app.restart relaunches by itself: use relaunched() for that). `env` changes this launch and the
 *  ones after it; undefined deletes a variable. Returns the new main pid. */
export async function relaunchParked(inst = state.current, { env: extraEnv = {}, args = [], launchTimeoutMs = 60_000, build } = {}) {
  if (inst.mode !== 'spawn') throw new Error('relaunchParked is for spawn-mode instances')
  const oldPid = inst.credential?.pid
  if (oldPid != null) await poll(() => !isAlive(oldPid), { timeoutMs: 30_000, intervalMs: 250, label: `pid ${oldPid} to exit before the relaunch` })
  for (const [key, value] of Object.entries(extraEnv)) { if (value === undefined) delete inst.env[key]; else inst.env[key] = String(value) }
  if (inst.browser) { await withDeadline(inst.browser.close(), 5000); inst.browser = null; inst.page = null }
  inst.cdpPort = await freePort()
  if (build) { if (!existsSync(build)) throw new Error(`${build} is missing`); inst.build = build }
  step(`relaunch spawn (${inst.root}${inst.build !== BUILD ? ', ' + inst.build : ''})`)
  const log = openSync(join(inst.root, 'app.log'), 'a')
  const spawnedAtMs = Date.now()
  inst.child = spawn(electronPath(), [`--remote-debugging-port=${inst.cdpPort}`, inst.build ?? BUILD, ...args], { env: inst.env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  await registerSpawnedRoot(inst, 'relaunchParked', spawnedAtMs)
  inst.closed = false
  await owner(inst, { pid: inst.child.pid, timeoutMs: launchTimeoutMs })
  return inst.child.pid
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

export const fileSha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The build about to be launched is byte-for-byte the granted one: its sha256 is re-read now,
 *  immediately before the launch, and must equal `expected`. Returns the hash; throws otherwise. */
export function assertBuildHash(path, expected, { digest = fileSha256 } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(expected ?? ''))) throw new Error('a granted build needs its full sha256')
  let actual
  try { actual = digest(path) } catch (error) { throw new Error(`build ${path} cannot be read: ${error?.code ?? error?.message ?? error}`) }
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`build ${path} has sha256 ${actual}, not the granted ${String(expected).toLowerCase()}`)
  return actual
}

/** Real process access for safeClose; tests replace any of it. */
export const closeDeps = { listProcesses: () => listProcesses(), terminate: (identity, budgetMs) => terminateIdentity(identity, { budgetMs }), now: () => Date.now(), sleep, ledger: null }

/** Closes one instance (default: the current one) and accounts for every process it owns. The dialog
 *  is stubbed and app.close() gets `boundMs` (20 s). Ownership is the registered root identities of
 *  this generation and their verified descendants (ownedTree) in the snapshot before the close;
 *  after it, a fresh snapshot re-proves each member by identity and admits children of proven
 *  members only. Survivors are killed leaves first, each re-verified on its own killing handle.
 *  Any failed inventory, missing identity or stale root means no kill at all for what it covers:
 *  it is reported in `unresolved`, and the run cannot count as cleanly closed. Returns
 *  {graceful, closeMs, ms, tree, killed, attempts, leftovers, unresolved}; leftovers and unresolved
 *  must both be empty. Every attempt is written to the ledger as it happens. Idempotent. */
export async function safeClose(inst = state.current, { boundMs = CLOSE_BOUND_MS, deps = closeDeps, killWindowMs = 20_000 } = {}) {
  if (!inst) return null
  if (inst.closed) return inst.closeReport ?? null
  inst.closed = true
  const d = { ...closeDeps, ...deps }
  const started = d.now()
  const ledger = entry => {
    const line = { at: new Date().toISOString(), instance: inst.name, generation: inst.generation, ...entry }
    try { (d.ledger ?? (value => appendFileSync(join(outputDir(), 'cleanup-ledger.ndjson'), JSON.stringify(value) + '\n')))(line) } catch { /* the report below still carries it */ }
  }
  const unresolved = []
  const roots = (inst.roots ?? []).filter(root => {
    if (root.generation === inst.generation && identityOf(root)) return true
    unresolved.push({ pid: root.pid, reason: root.generation !== inst.generation ? 'root registered under another generation' : 'root without OS identity' })
    return false
  })
  if (!roots.length) unresolved.push({ pid: null, reason: 'no registered root identity for this instance: nothing can be attributed or killed' })
  // Every inventory of this close, for reprobeUnreadable's descendant search.
  const observed = []
  const snapshot = async label => { try { const list = (await d.listProcesses()).list; observed.push(list); return list } catch (error) { unresolved.push({ pid: null, reason: `process inventory failed ${label}: ${String(error?.message ?? error).slice(0, 200)}` }); ledger({ event: 'inventory-failed', label }); return null } }
  const before = roots.length ? await snapshot('before the close') : null
  const treeBefore = before ? ownedTree(before, roots) : { members: [], unresolved: [] }
  ledger({ event: 'tree', label: 'before close', members: treeBefore.members.map(member => ({ pid: member.pid, name: member.name, depth: member.depth })), unresolved: treeBefore.unresolved })
  if (inst.browser) { await withDeadline(inst.browser.close(), 5000); inst.browser = null }
  let graceful = false
  if (inst.app) {
    await withDeadline(inst.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...dialogArgs) => { const buttons = dialogArgs.at(-1)?.buttons ?? []; const index = buttons.findIndex(label => label === "Don't Save" || label === 'Stop work and quit'); return { response: index >= 0 ? index : 0, checkboxChecked: false } }
    }), 5000)
    graceful = (await withDeadline(inst.app.close(), boundMs)).ok
  }
  const closeMs = d.now() - started
  const killed = []
  const attempts = []
  let tracked = treeBefore.members
  let survivors = []
  if (before) {
    const after = await snapshot('after the close')
    if (after) {
      // Members proven before the close are the roots now: children orphaned by the close stay
      // attributable by their own identity, and anything new must hang off a proven member.
      const treeAfter = ownedTree(after, treeBefore.members.map(identityOf))
      // Re-rooting flattens depth; keep each member's depth from before the close (members come in
      // breadth-first order, so a new child's parent is already placed) for a leaves-first kill.
      const depthOf = new Map()
      for (const member of treeAfter.members) {
        const earlier = treeBefore.members.find(old => sameIdentity(identityOf(old), identityOf(member)))
        depthOf.set(member.pid, earlier ? earlier.depth : (depthOf.get(member.ppid) ?? 0) + 1)
      }
      survivors = treeAfter.members.map(member => ({ ...member, depth: depthOf.get(member.pid) }))
      tracked = [...treeBefore.members, ...treeAfter.members.filter(member => !treeBefore.members.some(old => sameIdentity(identityOf(old), identityOf(member))))]
      // A member gone, or whose pid now names a different process, has exited: that is the goal.
      unresolved.push(...treeAfter.unresolved.filter(entry => !/no longer running|belongs to another process/.test(entry.reason)))
      const killDeadline = d.now() + killWindowMs
      for (const member of leavesFirst(survivors)) {
        const left = killDeadline - d.now()
        if (left <= 0) { unresolved.push({ pid: member.pid, name: member.name, reason: 'kill window ran out' }); continue }
        const outcome = await withDeadline(d.terminate(identityOf(member), Math.min(8000, left)), Math.min(8000, left) + 1000)
        const result = outcome.ok ? outcome.value : { state: 'unknown', detail: outcome.timedOut ? 'kill helper did not return' : String(outcome.error?.message ?? outcome.error) }
        const attempt = { pid: member.pid, name: member.name, depth: member.depth, result }
        attempts.push(attempt)
        ledger({ event: 'terminate', ...attempt })
        if (result.state === 'exited' || result.state === 'signalled') killed.push(member.pid)
      }
    }
  }
  // A root that exited before the close (a relaunch's predecessor, a killed app) is only a note when
  // its subtree was observed while it lived (observedTree: its children then are tracked roots) and
  // nothing listed now could be an untracked orphan of it (parent pid = its pid, created after it).
  // Otherwise its descendants are unknown, and an exited root cannot prove a clean close by itself.
  const notes = []
  for (const entry of treeBefore.unresolved) {
    // Gone, or its pid already reused by another process: either way the root has exited.
    if (!/no longer running|belongs to another process/.test(entry.reason)) { unresolved.push(entry); continue }
    const root = roots.find(candidate => candidate.pid === entry.pid)
    const orphans = (before ?? []).filter(row => row.ppid === entry.pid && !treeBefore.members.some(member => member.pid === row.pid) && (!row.creationTime || !root || BigInt(row.creationTime) >= BigInt(root.creationTime)))
    if (!root?.observedTree) unresolved.push({ pid: entry.pid, reason: 'root exited before cleanup and its descendants were never observed: untracked orphans cannot be ruled out' })
    else if (orphans.length) for (const orphan of orphans) unresolved.push({ pid: orphan.pid, name: orphan.name, reason: `possible untracked orphan of exited root ${entry.pid}: not attributed, not killed` })
    else notes.push(entry)
  }
  // Exit is proven per member only by an absent pid or a valid, different identity on it. The same
  // pid with an unreadable identity is unknown: it keeps the wait going and ends unresolved.
  let leftovers = [], unknown = []
  if (before && (survivors.length || !graceful)) {
    const deadline = d.now() + 10_000
    for (;;) {
      const now = await snapshot('while confirming exit')
      if (!now) break
      leftovers = []; unknown = []
      for (const member of tracked) {
        const row = now.find(entry => entry.pid === member.pid)
        if (!row) continue
        const identity = identityOf(row)
        if (!identity) unknown.push(member)
        else if (sameIdentity(identity, identityOf(member))) leftovers.push(member)
      }
      if ((!leftovers.length && !unknown.length) || d.now() >= deadline) break
      await d.sleep(1000)
    }
  }
  for (const member of unknown) unresolved.push({ pid: member.pid, name: member.name, reason: 'still listed with an unreadable OS identity: exit not proven' })
  // A child that was unreadable in one snapshot is re-probed (reprobeUnreadable): gone for good is a
  // note, anything else keeps its unresolved entry.
  const unreadable = unresolved.filter(entry => Number.isSafeInteger(entry.pid) && UNREADABLE_CHILD.test(entry.reason))
  if (unreadable.length) {
    const probe = await reprobeUnreadable(unreadable, { listProcesses: d.listProcesses, now: d.now, sleep: d.sleep, observed })
    ledger({ event: 'reprobe', exited: probe.exited.map(entry => entry.pid), still: probe.still.map(entry => entry.pid), failure: probe.failure })
    const gone = new Set(probe.exited.map(entry => entry.pid))
    for (let i = unresolved.length - 1; i >= 0; i--) if (gone.has(unresolved[i].pid) && UNREADABLE_CHILD.test(unresolved[i].reason)) unresolved.splice(i, 1)
    for (const pid of gone) {
      const entry = unreadable.find(candidate => candidate.pid === pid)
      notes.push({ pid, name: entry.name, reason: `${entry.reason}; no longer listed on re-probe: exited, never killed` })
    }
    if (probe.failure) unresolved.push({ pid: null, reason: `process inventory failed while re-probing unreadable children: ${probe.failure}` })
  }
  stopTracking(inst)
  inst.closeReport = { graceful, closeMs, ms: d.now() - started, tree: treeBefore.members.length, killed, attempts, leftovers: leftovers.map(entry => ({ pid: entry.pid, name: entry.name })), unresolved, notes }
  ledger({ event: 'closed', report: inst.closeReport })
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

/** The caller's own app-control credential, supplied in its environment (its briefing credential):
 *  CONDUCTOR_CONTROL_ENDPOINT (loopback only), CONDUCTOR_CONTROL_TOKEN, and optionally
 *  CONDUCTOR_CONTROL_PROJECT_ID / CONDUCTOR_CONTROL_WORKSPACE_ID as the call scope. The installed
 *  app's owner credential (control-owner.json) is never read for admission. null when incomplete. */
export function suppliedControl(env = process.env) {
  const endpoint = env.CONDUCTOR_CONTROL_ENDPOINT, token = env.CONDUCTOR_CONTROL_TOKEN
  if (typeof endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/\S*$/.test(endpoint) || typeof token !== 'string' || token.length < 16) return null
  const projectId = env.CONDUCTOR_CONTROL_PROJECT_ID || undefined, workspaceId = env.CONDUCTOR_CONTROL_WORKSPACE_ID || undefined
  if (workspaceId && !projectId) return null
  return { endpoint, token, ...(projectId ? { projectId } : {}), ...(workspaceId ? { workspaceId } : {}) }
}

/** Mid-turn tabs across every project and workspace the app lists, read-only through the caller's
 *  own supplied credential. Anything short of a complete listing - no credential, a refused or
 *  malformed call, a project without a workspace list - is count null (unknown, so not quiet),
 *  never zero. Error notes carry the method and status only, never the token. */
export async function midTurnTabs({ control = suppliedControl(), fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!control) return { count: null, tabs: [], note: 'no supplied control credential (CONDUCTOR_CONTROL_ENDPOINT / CONDUCTOR_CONTROL_TOKEN); the owner credential is never used' }
  const baseScope = control.projectId ? { projectId: control.projectId, ...(control.workspaceId ? { workspaceId: control.workspaceId } : {}) } : undefined
  const ask = async (method, scope = baseScope) => {
    const response = await fetchImpl(control.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: {}, ...(scope ? { scope } : {}) }), signal: AbortSignal.timeout(timeoutMs) })
    let body
    try { body = await response.json() } catch { throw new Error(`${method} -> ${response.status} (unreadable body)`) }
    if (response.status !== 200 || body?.error) throw new Error(`${method} -> ${response.status}`)
    return body.result
  }
  try {
    const projects = await ask('projects.list')
    if (!Array.isArray(projects) || !projects.length) throw new Error('projects.list returned no project list')
    const seen = new Map()
    for (const project of projects) {
      if (typeof project?.id !== 'string' || !Array.isArray(project.workspaces)) throw new Error(`project ${project?.id ?? '?'} has no workspace list`)
      for (const workspace of project.workspaces) {
        if (typeof workspace?.id !== 'string') throw new Error(`project ${project.id} lists a workspace without an id`)
        const agents = await ask('agents.list', { projectId: project.id, workspaceId: workspace.id })
        if (!Array.isArray(agents)) throw new Error(`agents.list for ${project.id}/${workspace.id} returned no list`)
        for (const agent of agents) {
          if (typeof agent?.agentSessionId !== 'string' || typeof agent.phase !== 'string') throw new Error(`agents.list for ${project.id}/${workspace.id} has an entry without id or phase`)
          if (MID_TURN_PHASES.has(agent.phase)) seen.set(agent.agentSessionId, { agentSessionId: agent.agentSessionId, title: agent.title ?? null, phase: agent.phase })
        }
      }
    }
    return { count: seen.size, tabs: [...seen.values()], projects: projects.length }
  } catch (error) { return { count: null, tabs: [], note: String(error?.message ?? error).split(control.token).join('[redacted]').slice(0, 300) } }
}

/** Is the machine quiet enough for timings to count? Smoke-lock holder (the lock this smoke itself
 *  runs under is not load), whole-machine CPU over 1 s, GPU via nvidia-smi, llama-server /slots, and
 *  mid-turn tabs in the owner's app (selfTabs: how many of those are the caller's own, default 1).
 *  Thresholds are schedule-gate.ts's. Records a LOAD row unless record:false. Call it before
 *  launching, since the smoke's own app is load too. */
export async function loadCheck({ selfTabs = 1, record: write = true, control = suppliedControl() } = {}) {
  const thresholds = gateThresholds()
  const cpuBefore = cpus(), cpuStarted = Date.now()
  let inventoryError = null
  const processes = await listProcesses().catch(error => { inventoryError = String(error?.message ?? error).slice(0, 200); return null })
  const inventory = processes ? { ok: true, processes: processes.list.length } : { ok: false, error: inventoryError }
  // No holder file means no lock; a holder file that cannot be read or parsed is unknown, not free.
  const holderFile = join(LOCK_DIR, 'holder.txt')
  let lockHolder = null, lockUnknown = false
  if (existsSync(holderFile)) {
    try { lockHolder = parseHolderText(readFileSync(holderFile, 'utf8')) } catch { lockHolder = null }
    lockUnknown = !lockHolder || !Number.isSafeInteger(lockHolder.pid)
  }
  const ancestry = processes ? ancestorsOf(processes.list, process.pid) : new Set()
  const lock = { held: Boolean(lockHolder), unknown: lockUnknown, holder: lockHolder ? { pid: lockHolder.pid, command: lockHolder.command ?? '' } : null, self: Boolean(lockHolder) && (lockHolder.pid === Number(process.env.CONDUCTOR_TEST_PARENT_PID) || ancestry.has(lockHolder.pid)) }
  const gpuRun = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const gpus = gpuRun.status === 0 ? parseNvidiaSmi(gpuRun.stdout) : []
  const servers = (processes?.list ?? []).filter(entry => /^llama-server(\.exe)?$/i.test(entry.name))
  const llama = await Promise.all(servers.map(async entry => { const parsed = parseLlamaCommandLine(entry.commandLine); return { pid: entry.pid, port: parsed?.port ?? null, busy: parsed ? await slotsBusy(parsed.port, parsed.apiKey) : null } }))
  const midTurn = await midTurnTabs({ control })
  await sleep(Math.max(0, 1000 - (Date.now() - cpuStarted)))
  const sample = { at: new Date().toISOString(), inventory, lock, cpuPercent: cpuPercent(cpuBefore, cpus()), gpuPercent: gpus.length ? Math.max(...gpus) : null, llama, midTurn }
  const verdict = judgeLoad(sample, thresholds, { selfTabs })
  const result = { ...sample, thresholds, selfTabs, ...verdict }
  if (write) record('load', 'LOAD', { quiet: verdict.quiet, cpu: sample.cpuPercent, gpu: sample.gpuPercent, lockHolder: lock.held ? (lock.self ? 'self' : lock.holder.pid) : null, llamaBusy: llama.filter(server => server.busy).length, midTurn: midTurn.count }, verdict.quiet ? 'quiet machine' : verdict.reasons.join('; '))
  return result
}
