// Runs one command under a machine-wide lock so concurrent agents never run two Electron smokes
// (or a build and a smoke) at once: docs/machine-profile.md asks for smokes one at a time because
// parallel ones push each other past their timeouts.
//
// Usage: node scripts/smoke-lock.mjs [--timeout-min N] [--priority normal] -- <command> [args...]
//
// Exit codes: the command's own code, except 124 (the run hit its timeout), 130 (interrupted) and
// 3 = "the command passed, but cleanup is unaccounted": some process could not be proven gone or
// proven foreign, so nothing was killed for it. That includes a child that exited before its
// identity could be read, any run on a non-Windows host (the identity inventory is Windows-only),
// and possible orphans of the run. Treat 3 as not clean; the log says which processes.
//
// The run starts below normal priority, and so does everything it launches (Electron with its GPU
// and renderer processes, builds, test workers): the owner types into their own Conductor on this
// machine, and a smoke must never make that lag (scripts/lib/background-priority.mjs,
// docs/perf/typing-under-load.md). --priority normal keeps it at normal priority, for a
// measurement whose stand-in plays the owner's app.
//
// The lock is a directory under the OS temp folder (mkdir is atomic); holder.txt inside it records
// who holds it, when, and for how long. Waiters take it in arrival order through ticket files in
// conductor-smoke.queue next to it, and print their place in line. A holder whose pid is dead, or whose age exceeds 2x its
// recorded timeout, is stale and is broken with a logged reason.
//
// The run's own processes are stopped - the spawned child and every descendant proven by OS identity
// (tracked while the run lives, so grandchildren stay attributable after their parents exit) - on
// the run's own hard timeout, on normal exit, on SIGINT/SIGTERM, and when this process's own parent
// is gone. There is no numeric tree kill: a reused pid or an unprovable process is reported, and a
// cleanup that cannot account for everything makes a successful run exit 3. Cleanup is bounded, and
// the lock is always released. That keeps a smoke from outliving the run that asked for it
// (feature-list.md: smoke-instances-never-leak) without ever touching someone else's process.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lowerPriority } from './lib/background-priority.mjs'

export const LOCK_DIR = join(tmpdir(), 'conductor-smoke.lock')
export const DEFAULT_TIMEOUT_MIN = 20
export const WAITER_GIVE_UP_MIN = 60
const POLL_MS = 5000
const PARENT_POLL_MS = 5000

/** `--timeout-min` (or `=N`) is smoke-lock's own flag and must come before `--`; everything after
 *  `--` is the wrapped command, untouched. With no `--` at all the whole argv is the command, for
 *  the old two-arg call shape. */
export function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const own = separator >= 0 ? argv.slice(0, separator) : []
  const command = separator >= 0 ? argv.slice(separator + 1) : argv.slice(0)
  let timeoutMin = DEFAULT_TIMEOUT_MIN
  let priority = 'background'
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]
    if (arg === '--timeout-min') { timeoutMin = Number(own[++i]); continue }
    if (arg.startsWith('--timeout-min=')) timeoutMin = Number(arg.slice('--timeout-min='.length))
    if (arg === '--priority') { priority = own[++i] === 'normal' ? 'normal' : 'background'; continue }
    if (arg.startsWith('--priority=')) priority = arg.slice('--priority='.length) === 'normal' ? 'normal' : 'background'
  }
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) timeoutMin = DEFAULT_TIMEOUT_MIN
  return { command, timeoutMin, priority }
}

export function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

/** Whether a recorded lock holder should be treated as abandoned, and why - null when it is still
 *  good. Pure given `now`/`alive` so it is testable without real processes or the real clock. */
export function staleReason(holder, now, alive = isProcessAlive) {
  if (!holder || typeof holder.pid !== 'number') return 'holder.txt is unreadable'
  if (!alive(holder.pid)) return `holder process ${holder.pid} is gone`
  const timeoutMin = holder.timeoutMin ?? DEFAULT_TIMEOUT_MIN
  const age = now - Date.parse(holder.startedAt ?? '')
  if (Number.isFinite(age) && age > timeoutMin * 60_000 * 2) {
    return `holder ${holder.pid} has run ${Math.round(age / 60000)} min, more than 2x its ${timeoutMin} min timeout`
  }
  return null
}

const LEGACY_HOLDER = /^(\d+)\s+(\S+)\s+([\s\S]*)$/

/** holder.txt was plain text (`pid iso command`) before this file learned to record a timeout, so
 *  a run of the previous smoke-lock.mjs mid-flight during a rollout still writes that shape. Parsed
 *  as a fallback so it reads as a normal live holder instead of "unreadable" - which would otherwise
 *  break its lock out from under it (this really happened once, live, while this file was in flight). */
export function parseHolderText(text) {
  try { return JSON.parse(text) } catch { /* fall through to the legacy format */ }
  const match = LEGACY_HOLDER.exec(text.trim())
  return match ? { pid: Number(match[1]), startedAt: match[2], command: match[3] } : null
}

/** Whether `pid` may remove the lock: only the run that currently holds it, per holder.txt - never
 *  "whatever process happens to be exiting". A missing/corrupt holder.txt has nothing to protect,
 *  so it counts as ownable. Without this, a run whose lock was broken as stale (or a waiter that
 *  never held it) still deletes the *next* holder's live lock on its own way out - this happened for
 *  real: waiters from one evening were still alive the next morning, having each stolen and then
 *  torn down each other's locks in turn. */
export function ownsLock(holder, pid) {
  return !holder || holder.pid === pid
}

/** Whether a waiter has been in the acquire loop long enough to give up rather than wait forever -
 *  a genuinely stuck lock (its stale check keeps failing for some reason not yet understood) must
 *  still let the waiter exit non-zero instead of hanging alongside it. */
export function waiterExpired(startedMs, now, limitMin = WAITER_GIVE_UP_MIN) {
  return now - startedMs > limitMin * 60_000
}

/** Numeric tree kill, kept ONLY for scripts/perf-input.mjs (out of this review's scope; its
 *  cleanup is unreviewed and the guard scenarios are refused by run-local-acceptance). smoke-lock
 *  itself never calls it: `/T` walks recorded parent pids, which can name reused, foreign
 *  processes. Bounded to 15 s so it can at least never hang its caller. */
export function killTree(pid, log = () => {}) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true })
    // 128: no such process - already gone, not a failure worth logging.
    if (result.status !== 0 && result.status !== 128) log(`[smoke-lock] taskkill for ${pid} exited ${result.status}`)
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch (error) { log(`[smoke-lock] group kill for ${pid} failed: ${error.message}`) }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --------------------------------------------------------------------- run cleanup
//
// The run's processes are owned by OS identity, never by a numeric tree: the direct child is
// registered by its (pid, creation time, image) while our own handle pins it, its descendants are
// tracked by identity as they appear (verify-kit trackDescendants), and cleanup is verify-kit
// safeClose - identity-verified on each killing handle, leaves first, bounded. A reused pid, a
// foreign process or anything unprovable is reported, never killed. `kit` is verify-kit (imported
// lazily by main(): verify-kit itself imports this file).

export const CLEANUP_DEADLINE_MS = 45_000
export const TRACK_INTERVAL_MS = 5000

/** Registers the spawned child as the run's root and starts tracking. Resolves to the tracker, or
 *  null when the child's identity could not be read (then only the child itself is stopped, through
 *  Node's own handle). */
export async function trackRun(child, kit, { log = () => {}, intervalMs = TRACK_INTERVAL_MS, spawnedAtMs } = {}) {
  const tracker = kit.newInstance({ name: 'smoke-lock', generation: `smoke-lock-${process.pid}-${Date.now()}` })
  try {
    // The snapshot takes a moment; a child that exited meanwhile may have handed its pid to someone
    // else, so registerOwnChild refuses it (and anything created outside the spawn window).
    const { list } = await kit.listProcesses()
    await kit.registerOwnChild(tracker, child, { source: 'smoke-lock child', list, spawnedAtMs })
    kit.startTracking(tracker, { intervalMs, log, list: () => kit.listProcesses({ timeoutMs: 20_000 }) })
    return tracker
  } catch (error) {
    log(`[smoke-lock] could not register the run's identity (${String(error?.message ?? error).slice(0, 200)}); cleanup will stop only the direct child, through its own handle`)
    return null
  }
}

/** Cleans up one run with no numeric tree kill. Returns {clean, report}. */
export async function cleanupRun({ child, tracking, kit, log = () => {}, deps = {} }) {
  const tracker = await tracking
  if (!tracker) {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill() } catch { /* already gone */ } }
    return { clean: false, report: { unresolved: [{ pid: child.pid, reason: 'run identity never registered: descendants neither attributed nor killed' }] } }
  }
  const report = await kit.safeClose(tracker, {
    boundMs: 0, killWindowMs: 20_000,
    deps: { ...kit.closeDeps, ...deps, ledger: line => { if (line.event === 'terminate' || line.event === 'inventory-failed') log(`[smoke-lock] cleanup ${line.event} ${JSON.stringify({ pid: line.pid, name: line.name, result: line.result, label: line.label })}`) } }
  })
  const clean = Boolean(report) && !report.leftovers.length && !report.unresolved.length
  if (!clean) log(`[smoke-lock] cleanup could not account for every process: ${JSON.stringify({ leftovers: report?.leftovers, unresolved: report?.unresolved }).slice(0, 1500)}`)
  return { clean, report }
}

/** One finish for every ending - normal exit, timeout, signal, parent loss: timers cleared, cleanup
 *  bounded by `deadlineMs` (a hung cleanup is abandoned, never waited on), the lock released, and
 *  the process exited. A run whose own code was 0 but whose cleanup is unaccounted exits 3. */
export function createFinisher({ cleanup, release, exit, clearTimers = () => {}, deadlineMs = CLEANUP_DEADLINE_MS, log = () => {} }) {
  let finishing = null
  return code => {
    if (finishing) return finishing
    finishing = (async () => {
      clearTimers()
      let timer
      const outcome = await Promise.race([
        Promise.resolve().then(cleanup).then(value => ({ value }), error => ({ error })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), deadlineMs) })
      ])
      clearTimeout(timer)
      if (outcome.timedOut) log(`[smoke-lock] cleanup did not finish within ${deadlineMs / 1000} s; abandoned`)
      if (outcome.error) log(`[smoke-lock] cleanup failed: ${String(outcome.error?.message ?? outcome.error).slice(0, 300)}`)
      const clean = Boolean(outcome.value?.clean)
      try { release() } catch (error) { log(`[smoke-lock] lock release failed: ${error.message}`) }
      exit(code === 0 && !clean ? 3 : (code ?? 1))
    })()
    return finishing
  }
}

// --------------------------------------------------------------------- the waiting line
//
// Waiters queue in arrival order. Polling alone had no fairness: a verifier chaining smokes back to
// back re-took the lock the moment it let go, and another waiter starved (VR2 waited 11+ min behind
// three VR3 runs). Each waiter writes a ticket file into QUEUE_DIR - next to the lock, not inside it,
// since the lock directory only exists while someone holds it - named by arrival time, and only the
// oldest ticket whose waiter is still alive may take the lock. A dead waiter's ticket is removed as
// soon as anyone sees it. A waiter from a smoke-lock.mjs that predates the queue has no ticket and
// can still win a free lock by racing mkdir; that only lasts until every caller runs this file.

export const QUEUE_DIR = join(tmpdir(), 'conductor-smoke.queue')

/** Ticket names sort in arrival order: zero-padded milliseconds, then the pid as a tie-break. */
export function ticketName(pid, now) {
  return `${String(now).padStart(15, '0')}-${String(pid).padStart(10, '0')}.json`
}

export function takeTicket(queueDir, pid, now, command = '') {
  mkdirSync(queueDir, { recursive: true })
  const name = ticketName(pid, now)
  writeFileSync(join(queueDir, name), JSON.stringify({ pid, queuedAt: new Date(now).toISOString(), command }))
  return name
}

export function dropTicket(queueDir, name) {
  try { rmSync(join(queueDir, name), { force: true }) } catch { /* already gone */ }
}

const ticketPid = name => Number(/^\d+-(\d+)\.json$/.exec(name)?.[1] ?? NaN)

/** The live line in order, with dead waiters' tickets removed on the way (a waiter killed without
 *  its exit handler running must never hold up everyone behind it). */
export function liveQueue(queueDir, alive = isProcessAlive, log = () => {}) {
  let names = []
  try { names = readdirSync(queueDir).filter(name => name.endsWith('.json')).sort() } catch { return [] }
  return names.filter(name => {
    const pid = ticketPid(name)
    if (Number.isInteger(pid) && alive(pid)) return true
    log(`[smoke-lock] skipping a dead waiter's ticket (${Number.isInteger(pid) ? `pid ${pid}` : name})`)
    dropTicket(queueDir, name)
    return false
  })
}

/** 1 = next in line. 0 when the ticket is gone (it is then taken again, at the back). */
export function queuePosition(line, name) {
  return line.indexOf(name) + 1
}

/** Waits for the lock in arrival order. Everything it touches is injectable, so two waiters can be
 *  simulated in one process (smoke-lock.test.mjs). Breaking a stale holder, the waiter give-up and
 *  the holder record are unchanged from the unqueued version. */
export async function acquire(timeoutMin, command, options = {}) {
  const { lockDir = LOCK_DIR, queueDir = QUEUE_DIR, pid = process.pid, alive = isProcessAlive, now = Date.now, wait = sleep, log = console.error, pollMs = POLL_MS, giveUpMin = WAITER_GIVE_UP_MIN, onTicket = () => {}, signal } = options
  const started = now()
  let ticket = takeTicket(queueDir, pid, now(), command.join(' '))
  onTicket(ticket)
  let shown = -1, lastNote = started
  const holderOf = () => { try { return parseHolderText(readFileSync(join(lockDir, 'holder.txt'), 'utf8')) } catch { return null } }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const line = liveQueue(queueDir, alive, log)
      let position = queuePosition(line, ticket)
      if (!position) { ticket = takeTicket(queueDir, pid, now(), command.join(' ')); onTicket(ticket); continue }
      if (position === 1) {
        try {
          mkdirSync(lockDir)
          writeFileSync(join(lockDir, 'holder.txt'), JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), timeoutMin, command: command.join(' ') }))
          return
        } catch (error) { if (error.code !== 'EEXIST') throw error }
        const reason = staleReason(holderOf(), now(), alive)
        if (reason) {
          log(`[smoke-lock] breaking stale lock: ${reason}`)
          try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* someone else broke it first */ }
          continue
        }
      }
      if (waiterExpired(started, now(), giveUpMin)) throw new Error(`gave up waiting for ${lockDir} after ${giveUpMin} min`)
      if (position !== shown || now() - lastNote >= 60_000) {
        const holder = holderOf()
        log(`[smoke-lock] waiting for ${lockDir}: position ${position} of ${line.length} in line${holder?.pid ? `, held by ${holder.pid} (${holder.command ?? 'unknown command'})` : ''}, ${Math.round((now() - started) / 1000)} s so far`)
        shown = position; lastNote = now()
      }
      await wait(position === 1 ? Math.min(pollMs, 1000) : pollMs)
    }
  } finally { dropTicket(queueDir, ticket) }
}

/** Only removes a lock this process still holds - see ownsLock(). A run whose lock was broken as
 *  stale while it ran, or a waiter that never acquired one, must not delete whoever holds it now. */
export const release = (lockDir = LOCK_DIR, pid = process.pid) => {
  let holder = null
  try { holder = parseHolderText(readFileSync(join(lockDir, 'holder.txt'), 'utf8')) } catch { /* no holder */ }
  if (!ownsLock(holder, pid)) return
  try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* already gone */ }
}

async function main() {
  const { command, timeoutMin, priority } = parseArgs(process.argv.slice(2))
  if (!command.length) { console.error('usage: node scripts/smoke-lock.mjs [--timeout-min N] [--priority normal] -- <command> [args...]'); process.exit(2) }
  // A waiter stopped by Ctrl+C or a plain kill leaves the line at once; one that dies without
  // running this is skipped by the next waiter that sees its ticket (liveQueue).
  let ticket = null
  const leaveLine = () => { if (ticket) dropTicket(QUEUE_DIR, ticket) }
  process.on('exit', leaveLine)
  const stopWaiting = () => { leaveLine(); process.exit(130) }
  process.on('SIGINT', stopWaiting); process.on('SIGTERM', stopWaiting)
  try { await acquire(timeoutMin, command, { onTicket: name => { ticket = name } }) }
  catch (error) { console.error(`[smoke-lock] ${error.message}`); process.exit(1) }
  ticket = null
  process.off('SIGINT', stopWaiting); process.off('SIGTERM', stopWaiting)
  // Lowered here, before the spawn, so the whole run inherits it (a waiter in line costs nothing).
  if (priority !== 'normal') {
    const lowered = lowerPriority()
    if (lowered.startsWith('failed')) console.error(`[smoke-lock] could not lower the run's priority (${lowered})`)
  }

  // Direct spawn keeps arguments intact; only a .cmd/.bat launcher (npm.cmd) needs the shell. The
  // child gets its own process group off Windows so a POSIX kill(-pid) can reach its descendants.
  // CONDUCTOR_TEST_PARENT_PID names *this* process - not the smoke script's own, closer parent -
  // as the one every Electron instance the smoke launches should watch, so an abrupt forced kill of
  // this process alone (the smoke script itself left running) still tears the app down.
  // Loaded before the spawn, so no exit event can fire before its handler is attached.
  const kit = await import('./verify-kit.mjs')
  const spawnedAtMs = Date.now()
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: /\.(?:cmd|bat)$/i.test(command[0]),
    detached: process.platform !== 'win32',
    env: { ...process.env, CONDUCTOR_TEST_PARENT_PID: String(process.pid) }
  })

  // Identity ownership of the run, then one bounded finish for every way it can end.
  const tracking = trackRun(child, kit, { log: message => console.error(message), spawnedAtMs })
  const finish = createFinisher({
    cleanup: () => cleanupRun({ child, tracking, kit, log: message => console.error(message) }),
    release: () => release(),
    exit: code => process.exit(code),
    clearTimers: () => { clearTimeout(timeoutTimer); clearInterval(parentTimer) },
    log: message => console.error(message)
  })

  const timeoutTimer = setTimeout(() => {
    console.error(`[smoke-lock] run exceeded ${timeoutMin} min, stopping the run's own processes`)
    finish(124)
  }, timeoutMin * 60_000)

  // Captured once: after the real parent exits, ppid is unreliable (reparented on POSIX, stale on
  // Windows), so only the pid seen at startup is meaningful to keep polling.
  const initialParentPid = process.ppid
  const parentTimer = setInterval(() => {
    if (!isProcessAlive(initialParentPid)) {
      console.error(`[smoke-lock] parent ${initialParentPid} is gone, stopping the run's own processes`)
      finish(1)
    }
  }, PARENT_POLL_MS)

  child.on('exit', code => finish(code))
  child.on('error', error => { console.error(`[smoke-lock] ${error.message}`); finish(1) })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(130))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
