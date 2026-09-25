import { spawnSync } from 'node:child_process'
import { app } from 'electron'

/** In test mode (CONDUCTOR_TEST_USER_DATA set) a smoke's Electron instance must never outlive the
 *  node process that launched it - overnight verifiers left Electron and fixture CLIs running for
 *  hours after their smoke script was gone (feature-list.md: smoke-instances-never-leak). This
 *  polls the launching process and force-exits, tree and all, the moment it disappears. */

export const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** CONDUCTOR_TEST_PARENT_PID lets a smoke name the process to watch explicitly (its own launcher,
 *  when the immediate OS parent is not it - e.g. spawned through smoke-lock); otherwise this
 *  process's real parent pid, captured once since it goes stale after that parent exits. */
export const resolveWatchedPid = (env: NodeJS.ProcessEnv, ppid: number): number => {
  const override = Number(env.CONDUCTOR_TEST_PARENT_PID)
  return Number.isInteger(override) && override > 0 ? override : ppid
}

/** Kills this process and everything it spawned in one shot - fixture CLIs, terminals, anything
 *  Electron detached - so an orphaned test instance never leaves children behind. `taskkill /T`
 *  reaches descendants by their recorded parent pid, which Windows keeps even once this process
 *  is on its way out; off Windows this falls back to a plain `app.exit`. */
export const killOwnProcessTree = (pid: number = process.pid): void => {
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ } }
  app.exit(1)
}

export interface TestModeWatchdog { stop(): void }

export function startTestModeWatchdog(options: { env?: NodeJS.ProcessEnv; ppid?: number; intervalMs?: number; alive?: (pid: number) => boolean; onOrphaned?: (pid: number) => void } = {}): TestModeWatchdog {
  const env = options.env ?? process.env
  const alive = options.alive ?? isProcessAlive
  const watchedPid = resolveWatchedPid(env, options.ppid ?? process.ppid)
  const onOrphaned = options.onOrphaned ?? killOwnProcessTree
  const timer = setInterval(() => { if (!alive(watchedPid)) { clearInterval(timer); onOrphaned(watchedPid) } }, options.intervalMs ?? 5000)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
