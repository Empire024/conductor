import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARM_FILE, PENDING_REPORT_FILE, parseArmRecord, parseRecoveryReport, recoveryDirectory, type ArmRecord, type LaunchSpec, type RecoveryReport, type StopKind } from './protocol'

export interface RecoveryOptions {
  userData: string
  packaged: boolean
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  pid: number
  execPath: string
  argv: string[]
  cwd: string
  /** The bundled watchdog (out/main/recovery-watchdog.js). */
  watchdogScript: string
  log(message: string): void
  /** The runtime copy outside the install directory (detached.ts watchdogRuntime). */
  copiedRuntime(userData: string): Promise<string>
  /** Starts a process with none of the app's handles (detached.ts startWatchdogProcess). */
  startDetached(executable: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string): void
}

export interface RecoveryController {
  readonly enabled: boolean
  /** How the previous Conductor armed its watchdog, read before this launch overwrites it. */
  readonly previousArm: ArmRecord | null
  /** Records this launch as running and starts its watchdog. */
  start(info: { fromVersion: string; checkout: string | null }): Promise<void>
  /** Records how this process is stopping, before it quits. An owner quit disarms the watchdog. */
  arm(kind: Exclude<StopKind, 'running'>, info: { fromVersion: string; toVersion?: string; foreground: boolean }): void
  /** The recovery report the watchdog left for this launch, consumed once. */
  takeReport(): RecoveryReport | null
}

/** On by default for the installed Windows app; CONDUCTOR_RECOVERY_WATCHDOG=1 turns it on for a
 *  checkout or a test profile (the parked smoke), =0 off anywhere. */
export function recoveryEnabled(options: { packaged: boolean; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): boolean {
  const flag = options.env.CONDUCTOR_RECOVERY_WATCHDOG
  if (flag === '0') return false
  if (flag === '1') return true
  return options.packaged && options.platform === 'win32'
}

/** How the watchdog starts Conductor again: the installed exe by itself, or a checkout's electron with its argv. */
export function launchSpec(options: Pick<RecoveryOptions, 'packaged' | 'execPath' | 'argv' | 'cwd'>): LaunchSpec {
  return options.packaged ? { exe: options.execPath, args: [] } : { exe: options.execPath, args: options.argv.slice(1), cwd: options.cwd }
}

/** The Conductor checkout among the owner's projects: the one that can build a Conductor update. */
export function findCheckout(projectPaths: string[]): string | null {
  return projectPaths.find(path => existsSync(join(path, 'scripts', 'build-local-update.mjs')) && existsSync(join(path, 'src', 'main', 'recovery'))) ??
    projectPaths.find(path => existsSync(join(path, 'scripts', 'build-local-update.mjs'))) ?? null
}

export function createRecovery(options: RecoveryOptions): RecoveryController {
  const directory = recoveryDirectory(options.userData)
  const armPath = join(directory, ARM_FILE)
  const enabled = recoveryEnabled(options)
  const read = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }
  const previousArm = parseArmRecord(read(armPath))
  let current: ArmRecord | null = null
  const write = (record: ArmRecord): void => {
    try {
      mkdirSync(directory, { recursive: true })
      const temporary = `${armPath}.${options.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      renameSync(temporary, armPath)
      current = record
    } catch (error) { options.log(`recovery: could not arm the watchdog: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return {
    enabled,
    previousArm,
    async start(info) {
      if (!enabled) return
      write({ appPid: options.pid, kind: 'running', at: new Date().toISOString(), fromVersion: info.fromVersion, foreground: false, launch: launchSpec(options), checkout: info.checkout, packaged: options.packaged })
      pruneLaunchLogs(directory)
      try {
        const runtime = options.packaged ? await options.copiedRuntime(options.userData) : options.execPath
        const script = options.packaged ? await copiedWatchdog(directory, options.watchdogScript) : options.watchdogScript
        const environment: NodeJS.ProcessEnv = { ...options.env, ELECTRON_RUN_AS_NODE: '1', CONDUCTOR_RECOVERY_APP_PID: String(options.pid) }
        delete environment.NODE_OPTIONS
        // A test profile's watchdog ends with the smoke that launched the app, never outliving it.
        if (options.env.CONDUCTOR_TEST_USER_DATA && options.env.CONDUCTOR_TEST_PARENT_PID) environment.CONDUCTOR_RECOVERY_PARENT_PID = options.env.CONDUCTOR_TEST_PARENT_PID
        options.startDetached(runtime, [script, '--user-data', options.userData, '--app-pid', String(options.pid)], environment, directory)
        options.log(`recovery: watchdog started for pid ${options.pid}`)
      } catch (error) { options.log(`recovery: the watchdog could not start: ${error instanceof Error ? error.message : String(error)}`) }
    },
    arm(kind, info) {
      if (!enabled || !current) return
      write({ ...current, kind, at: new Date().toISOString(), fromVersion: info.fromVersion || current.fromVersion, ...(info.toVersion ? { toVersion: info.toVersion } : {}), foreground: info.foreground })
    },
    takeReport() {
      const path = join(directory, PENDING_REPORT_FILE)
      const report = parseRecoveryReport(read(path))
      try { rmSync(path, { force: true }) } catch { /* read once is enough */ }
      return report
    }
  }
}

/** The watchdog bundle lives inside app.asar; one running from there would keep the archive open. */
async function copiedWatchdog(directory: string, script: string): Promise<string> {
  const content = await fs.readFile(script)
  const target = join(directory, `watchdog-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.js`)
  if (!existsSync(target)) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(`${target}.tmp`, content)
    await fs.rename(`${target}.tmp`, target)
  }
  // Earlier builds' copies: a running watchdog has already read its script, so they can go.
  for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
    if (/^watchdog-[0-9a-f]{16}\.js$/.test(name) && join(directory, name) !== target) await fs.rm(join(directory, name), { force: true }).catch(() => {})
  }
  return target
}

/** Each relaunch attempt's output file; the newest few are kept. */
function pruneLaunchLogs(directory: string, keep = 10): void {
  try {
    const logs = readdirSync(directory).filter(name => /^launch-.*\.log$/.test(name)).sort()
    for (const name of logs.slice(0, Math.max(0, logs.length - keep))) rmSync(join(directory, name), { force: true })
  } catch { /* nothing to prune */ }
}
