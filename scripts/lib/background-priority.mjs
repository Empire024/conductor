// Test instances, smoke builds and test runs are background work: the owner is typing into their
// own Conductor on the same machine, and a smoke that launches Electron, or a vitest run that
// fans out a worker per core, at normal priority competes with that window for every core
// (feature-list.md typing-lag-under-test-load, docs/perf/typing-under-load.md). Below-normal
// priority lets them use every idle cycle but yield the moment the owner's app needs one.
//
// Children inherit it: a POSIX nice value always, and on Windows a process created by a
// BELOW_NORMAL process is BELOW_NORMAL too unless its creator asks otherwise. So lowering the
// process that launches the work covers the whole tree: Electron's GPU and renderer processes,
// esbuild's service, vitest's forks.
//
// CONDUCTOR_BACKGROUND_PRIORITY=0 keeps normal priority, for the owner stand-in of a measurement or
// someone who deliberately wants a run at full speed.
//
// As a wrapper: node scripts/lib/background-priority.mjs -- <command> [args...] lowers itself and
// then runs the command, so the command starts below normal instead of being lowered after it has
// already spawned its own children.
import { spawn } from 'node:child_process'
import { constants, getPriority, setPriority } from 'node:os'
import { pathToFileURL } from 'node:url'

export const BACKGROUND_PRIORITY = constants.priority.PRIORITY_BELOW_NORMAL
export const NORMAL_PRIORITY = constants.priority.PRIORITY_NORMAL

export function backgroundPriorityWanted(env = process.env) {
  return env.CONDUCTOR_BACKGROUND_PRIORITY !== '0'
}

/** Lowers `pid` (0: this process) to below normal. Never raises one that is already lower (idle),
 *  never throws: 'lowered' | 'already' | 'skipped' (opted out) | 'failed: <code>'. */
export function lowerPriority(pid = 0, { env = process.env, get = getPriority, set = setPriority } = {}) {
  if (!backgroundPriorityWanted(env)) return 'skipped'
  try {
    if (get(pid) >= BACKGROUND_PRIORITY) return 'already'
    set(pid, BACKGROUND_PRIORITY)
    return 'lowered'
  } catch (error) { return `failed: ${error.code ?? error.message}` }
}

/** Back to normal, for a measurement's owner stand-in started from a lowered tree. Raising needs no
 *  privilege on Windows; on POSIX lowering a nice value does, so this reports 'failed: EACCES' there
 *  and the caller runs under `smoke-lock --priority normal` instead. */
export function restoreNormalPriority(pid = 0, { get = getPriority, set = setPriority } = {}) {
  try {
    if (get(pid) <= NORMAL_PRIORITY) return 'already'
    set(pid, NORMAL_PRIORITY)
    return 'restored'
  } catch (error) { return `failed: ${error.code ?? error.message}` }
}

/** Human name of a priority value, for logs and evidence. */
export function priorityName(value) {
  const entry = Object.entries(constants.priority).find(([, number]) => number === value)
  return entry ? entry[0].replace(/^PRIORITY_/, '').toLowerCase() : String(value)
}

/** The wrapped command of `node background-priority.mjs -- <command...>`. */
export function wrappedCommand(argv) {
  const separator = argv.indexOf('--')
  return separator >= 0 ? argv.slice(separator + 1) : argv.slice(0)
}

async function main() {
  const command = wrappedCommand(process.argv.slice(2))
  if (!command.length) { console.error('usage: node scripts/lib/background-priority.mjs -- <command> [args...]'); process.exit(2) }
  const result = lowerPriority()
  if (result.startsWith('failed')) console.error(`[background-priority] could not lower priority (${result}); running at normal priority`)
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: /\.(?:cmd|bat)$/i.test(command[0]) || command[0] === 'npx' || command[0] === 'npm', windowsHide: true })
  const forward = signal => { try { child.kill(signal) } catch { /* already gone */ } }
  process.on('SIGINT', forward); process.on('SIGTERM', forward)
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  child.on('error', error => { console.error(`[background-priority] ${error.message}`); process.exit(1) })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
