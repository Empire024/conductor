import { join } from 'node:path'

/* Recovery mode (docs/recovery-mode.md): a watchdog process that outlives Conductor brings it back
 * when a restart, an update install or a crash leaves it down. This file is shared by the app and
 * the watchdog bundle, so it only imports node: modules. */

export const RECOVERY_DIRECTORY = 'recovery'
/** How the watched app is stopping; written by the app, read by its watchdog when the pid is gone. */
export const ARM_FILE = 'armed.json'
/** The watchdog watching the current app: `{pid, appPid, startedAt}`. */
export const WATCHDOG_LOCK_FILE = 'watchdog.json'
/** A finished recovery the next launch has not reported yet. */
export const PENDING_REPORT_FILE = 'pending-report.json'
export const WATCHDOG_LOG_FILE = 'watchdog.log'
/** One line per recovery launch, for the crash-loop guard. */
export const HISTORY_FILE = 'history.jsonl'
/** Test profiles only: toasts are recorded here instead of shown over the owner's desktop. */
export const TEST_TOAST_FILE = 'toasts.jsonl'

export const recoveryDirectory = (userData: string): string => join(userData, RECOVERY_DIRECTORY)

/** Same words as restart-resume.ts's RestartKind: `running` is the live record, so a pid that is
 *  gone while it still says `running` crashed or was killed. */
export type StopKind = 'running' | 'quit' | 'update-on-quit' | 'update-install' | 'restart'

/** How to start Conductor again: the installed exe, or a checkout's electron plus its argv. */
export interface LaunchSpec { exe: string; args: string[]; cwd?: string }

export interface ArmRecord {
  appPid: number
  kind: StopKind
  at: string
  fromVersion: string
  toVersion?: string
  /** A Conductor window had focus when the app armed for this stop: the relaunch may come to the front. */
  foreground: boolean
  launch: LaunchSpec
  /** The Conductor checkout the recovery agent works in, when the app knows one. */
  checkout: string | null
  packaged: boolean
}

export interface WatchdogLock { pid: number; appPid: number; startedAt: string }

export interface RelaunchAttempt {
  exe: string
  args: string[]
  startedAt: string
  pid?: number
  /** Spawn failed outright (ENOENT, EACCES...). */
  error?: string
  /** The process exited while the watchdog waited for it; null while it still ran. */
  exitCode?: number | null
  /** Tail of what it wrote to stdout/stderr. */
  output?: string
  outputPath?: string
  ready: boolean
}

export interface AgentRun {
  command: string[]
  cwd: string
  exitCode: number | null
  timedOut: boolean
  error?: string
  /** The markdown diagnosis written for the owner. */
  diagnosisPath: string
}

export type RecoveryOutcome = 'relaunched' | 'agent-recovered' | 'down'

export interface RecoveryReport {
  id: string
  at: string
  appPid: number
  kind: StopKind
  fromVersion: string
  toVersion?: string
  outcome: RecoveryOutcome
  /** Why it was needed: what the watchdog saw when it gave up waiting. */
  error: string
  attempts: RelaunchAttempt[]
  agent?: AgentRun
  readyPid?: number
  reportPath: string
}

export const isStopKind = (value: unknown): value is StopKind =>
  value === 'running' || value === 'quit' || value === 'update-on-quit' || value === 'update-install' || value === 'restart'

export function parseArmRecord(raw: string | null | undefined): ArmRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ArmRecord> | null
    if (!value || typeof value !== 'object' || !Number.isInteger(value.appPid) || !isStopKind(value.kind) || typeof value.at !== 'string') return null
    const launch = value.launch
    if (!launch || typeof launch.exe !== 'string' || !launch.exe || !Array.isArray(launch.args) || !launch.args.every(arg => typeof arg === 'string')) return null
    return {
      appPid: value.appPid!, kind: value.kind, at: value.at, fromVersion: typeof value.fromVersion === 'string' ? value.fromVersion : '',
      ...(typeof value.toVersion === 'string' && value.toVersion ? { toVersion: value.toVersion } : {}),
      foreground: value.foreground === true,
      launch: { exe: launch.exe, args: [...launch.args], ...(typeof launch.cwd === 'string' && launch.cwd ? { cwd: launch.cwd } : {}) },
      checkout: typeof value.checkout === 'string' && value.checkout ? value.checkout : null,
      packaged: value.packaged === true
    }
  } catch { return null }
}

export function parseRecoveryReport(raw: string | null | undefined): RecoveryReport | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<RecoveryReport> | null
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.at !== 'string' || typeof value.reportPath !== 'string') return null
    if (value.outcome !== 'relaunched' && value.outcome !== 'agent-recovered' && value.outcome !== 'down') return null
    return value as RecoveryReport
  } catch { return null }
}

/** The sentence a brought-back wizard reads after FX25's restart line. */
export function recoveryNote(report: RecoveryReport | null): string {
  if (!report) return ''
  const tried = report.attempts.length
  const how = report.outcome === 'relaunched'
    ? `recovery mode relaunched it (attempt ${tried})`
    : report.outcome === 'agent-recovered'
      ? `recovery mode's relaunch failed ${tried} time${tried === 1 ? '' : 's'} and the recovery agent brought it back`
      : 'recovery mode could not bring it back; it was started by hand'
  return ` Conductor did not come back by itself after this stop (${report.error}); ${how}. Recovery report: ${report.reportPath}.`
}
