// Runs one command under a machine-wide lock so concurrent agents never run two Electron smokes
// (or a build and a smoke) at once: docs/machine-profile.md asks for smokes one at a time because
// parallel ones push each other past their timeouts.
//
// Usage: node scripts/smoke-lock.mjs [--timeout-min N] -- <command> [args...]
//
// The lock is a directory under the OS temp folder (mkdir is atomic); holder.txt inside it records
// who holds it, when, and for how long. Waiters take it in arrival order through ticket files in
// conductor-smoke.queue next to it, and print their place in line. A holder whose pid is dead, or whose age exceeds 2x its
// recorded timeout, is stale and is broken with a logged reason.
//
// The run is killed - the whole process tree, not just the spawned pid, since Electron and its
// fixture CLIs leave grandchildren behind - on the run's own hard timeout, on normal exit, on
// SIGINT/SIGTERM, and when this process's own parent (whatever invoked it) is gone. That is what
// keeps a smoke from outliving the run that asked for it (feature-list.md: smoke-instances-never-leak).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]
    if (arg === '--timeout-min') { timeoutMin = Number(own[++i]); continue }
    if (arg.startsWith('--timeout-min=')) timeoutMin = Number(arg.slice('--timeout-min='.length))
  }
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) timeoutMin = DEFAULT_TIMEOUT_MIN
  return { command, timeoutMin }
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

/** Kills a process and everything it spawned. Windows has no process-group signal, so `/T` walks
 *  the tree by recorded parent pid, which Windows keeps even after the parent itself has exited. */
export function killTree(pid, log = () => {}) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    // 128: no such process - already gone, not a failure worth logging.
    if (result.status !== 0 && result.status !== 128) log(`[smoke-lock] taskkill for ${pid} exited ${result.status}`)
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch (error) { log(`[smoke-lock] group kill for ${pid} failed: ${error.message}`) }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  const { command, timeoutMin } = parseArgs(process.argv.slice(2))
  if (!command.length) { console.error('usage: node scripts/smoke-lock.mjs [--timeout-min N] -- <command> [args...]'); process.exit(2) }
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

  // Direct spawn keeps arguments intact; only a .cmd/.bat launcher (npm.cmd) needs the shell. The
  // child gets its own process group off Windows so a POSIX kill(-pid) can reach its descendants.
  // CONDUCTOR_TEST_PARENT_PID names *this* process - not the smoke script's own, closer parent -
  // as the one every Electron instance the smoke launches should watch, so an abrupt kill of this
  // process (taskkill /F, no /T - the smoke script itself is left running) still tears the app down.
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: /\.(?:cmd|bat)$/i.test(command[0]),
    detached: process.platform !== 'win32',
    env: { ...process.env, CONDUCTOR_TEST_PARENT_PID: String(process.pid) }
  })

  let finished = false
  const finish = code => {
    if (finished) return
    finished = true
    clearTimeout(timeoutTimer)
    clearInterval(parentTimer)
    killTree(child.pid, console.error)
    release()
    process.exit(code ?? 1)
  }

  const timeoutTimer = setTimeout(() => {
    console.error(`[smoke-lock] run exceeded ${timeoutMin} min, killing the process tree`)
    finish(124)
  }, timeoutMin * 60_000)

  // Captured once: after the real parent exits, ppid is unreliable (reparented on POSIX, stale on
  // Windows), so only the pid seen at startup is meaningful to keep polling.
  const initialParentPid = process.ppid
  const parentTimer = setInterval(() => {
    if (!isProcessAlive(initialParentPid)) {
      console.error(`[smoke-lock] parent ${initialParentPid} is gone, killing the process tree`)
      finish(1)
    }
  }, PARENT_POLL_MS)

  child.on('exit', code => finish(code))
  child.on('error', error => { console.error(`[smoke-lock] ${error.message}`); finish(1) })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => finish(130))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
