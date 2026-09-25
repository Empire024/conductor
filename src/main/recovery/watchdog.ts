import type { AgentRun, ArmRecord, RecoveryOutcome, RecoveryReport, RelaunchAttempt, StopKind } from './protocol'

/** A process the watchdog started, observed while it waits for readiness. */
export interface LaunchedProcess {
  pid?: number
  /** Spawn failed outright. */
  error?: string
  /** Null while the process runs. */
  exitCode(): number | null | undefined
  /** Tail of its output so far. */
  output(): string
  outputPath?: string
  /** Stop observing it (it keeps running). */
  release(): void
}

export interface AgentRequest {
  error: string
  arm: ArmRecord | null
  attempts: RelaunchAttempt[]
  logs: Record<string, string>
  diagnosisPath: string
}

export interface WatchdogDeps {
  now(): number
  sleep(ms: number): Promise<void>
  alive(pid: number): boolean
  readArm(): ArmRecord | null
  /** A Conductor other than `previousPid` holds control-owner.json, is alive and answers app control. */
  ready(previousPid: number): Promise<{ pid: number } | null>
  /** The NSIS installer electron-updater started is still running. */
  installerRunning(): boolean
  launch(exe: string, args: string[], cwd: string | undefined): Promise<LaunchedProcess>
  runAgent(request: AgentRequest): Promise<AgentRun>
  notify(title: string, body: string): Promise<void>
  logTails(): Promise<Record<string, string>>
  /** Recovery launches recorded in the last `windowMs`. */
  recentRecoveries(windowMs: number): number
  recordRecovery(): void
  /** A fresh report id and the paths it is written to. */
  reportPaths(): { id: string; json: string; markdown: string }
  /** Writes the report JSON and the markdown summary (appended to a diagnosis the agent already wrote there). */
  writeReport(report: RecoveryReport): void
  /** The report the next launch reads. Written before each launch and before the agent runs: the
   *  launched app reads it at startup, before it answers app control. */
  announce(report: RecoveryReport): void
  log(message: string): void
  /** Test profiles: the smoke that launched the app is gone, so nothing is left to watch for. */
  parentGone(): boolean
}

export interface WatchdogConfig {
  appPid: number
  pollMs: number
  /** After a restart (app.restart, Restart to update without an update) the old pid exits and a new one should answer within this. */
  restartWaitMs: number
  /** After an update install: the NSIS installer runs first. */
  installWaitMs: number
  /** Hard ceiling while the installer is still seen running. */
  installMaxMs: number
  /** After a crash: time for anything else (the owner, a login item) to start it first. */
  crashWaitMs: number
  /** How long each relaunch attempt has to answer. */
  attemptWaitMs: number
  /** Wait before attempt n (index 0 is the first attempt). */
  backoffMs: number[]
  /** After the agent finishes: how long its relaunch has to answer. */
  afterAgentWaitMs: number
  /** More recoveries than this in `recoveryWindowMs` is a crash loop: no more relaunches, straight to the agent. */
  maxRecoveries: number
  recoveryWindowMs: number
  /** Test profiles only: the executables the attempts use, in order, instead of the armed one. */
  relaunchExes?: string[]
}

export const DEFAULT_WATCHDOG_CONFIG: Omit<WatchdogConfig, 'appPid'> = {
  pollMs: 1000,
  restartWaitMs: 60_000,
  installWaitMs: 180_000,
  installMaxMs: 10 * 60_000,
  crashWaitMs: 10_000,
  attemptWaitMs: 60_000,
  backoffMs: [2000, 15_000],
  afterAgentWaitMs: 60_000,
  maxRecoveries: 3,
  recoveryWindowMs: 15 * 60_000
}

export type WatchdogResult =
  | { result: 'clean-quit'; kind: StopKind }
  | { result: 'returned'; pid: number; waitedMs: number }
  | { result: 'stopped'; reason: string }
  | { result: RecoveryOutcome; report: RecoveryReport }

const tail = (text: string, max = 2000): string => text.length > max ? `…${text.slice(-max)}` : text

/**
 * The watchdog's whole decision, with every effect injected (tests drive it with fakes).
 * 1. Watch the app's pid. 2. When it is gone, read how it meant to stop: an owner quit ends the
 * watch. 3. Otherwise wait, bounded, for a new Conductor to answer app control. 4. If none does,
 * start the armed exe, up to two attempts with backoff. 5. If still down, hand the exact error to
 * the recovery agent. The owner hears about every recovery; a report goes to the next launch.
 */
export async function runWatchdog(deps: WatchdogDeps, config: WatchdogConfig): Promise<WatchdogResult> {
  const { appPid } = config
  deps.log(`watching Conductor pid ${appPid}`)
  while (deps.alive(appPid)) {
    if (deps.parentGone()) { deps.log('the test launcher is gone; stopping'); return { result: 'stopped', reason: 'parent gone' } }
    await deps.sleep(config.pollMs)
  }
  const exitedAt = deps.now()
  const armed = deps.readArm()
  const arm = armed && armed.appPid === appPid ? armed : null
  const kind: StopKind = arm?.kind ?? 'running'
  deps.log(`Conductor pid ${appPid} is gone; it recorded ${arm ? `"${kind}" at ${arm.at}` : 'nothing (crash)'}`)
  if (kind === 'quit' || kind === 'update-on-quit') return { result: 'clean-quit', kind }

  // 3. The expected return.
  const waitMs = kind === 'update-install' ? config.installWaitMs : kind === 'restart' ? config.restartWaitMs : config.crashWaitMs
  const back = await waitReady(deps, config, appPid, waitMs, kind === 'update-install' ? config.installMaxMs : waitMs)
  if (back) { deps.log(`Conductor is back as pid ${back.pid} after ${deps.now() - exitedAt} ms`); return { result: 'returned', pid: back.pid, waitedMs: deps.now() - exitedAt } }
  const waited = Math.round((deps.now() - exitedAt) / 1000)
  const reason = kind === 'running'
    ? `Conductor pid ${appPid} ended without quitting (crash or kill) and no Conductor answered app control within ${waited} s`
    : `after ${kind === 'update-install' ? `the update install${arm?.toVersion ? ` of ${arm.toVersion}` : ''}` : 'app.restart'} no new Conductor answered app control within ${waited} s of pid ${appPid} exiting`
  deps.log(reason)

  const paths = deps.reportPaths()
  const attempts: RelaunchAttempt[] = []
  const build = (outcome: RecoveryOutcome, readyPid: number | undefined, agent: AgentRun | undefined): RecoveryReport => ({
    id: paths.id, at: new Date(deps.now()).toISOString(), appPid, kind, fromVersion: arm?.fromVersion ?? '',
    ...(arm?.toVersion ? { toVersion: arm.toVersion } : {}), outcome, error: reason, attempts,
    ...(agent ? { agent } : {}), ...(readyPid ? { readyPid } : {}), reportPath: paths.markdown
  })
  const finish = async (outcome: RecoveryOutcome, readyPid: number | undefined, agent: AgentRun | undefined): Promise<WatchdogResult> => {
    const report = build(outcome, readyPid, agent)
    deps.writeReport(report)
    // Still down: whoever starts Conductor next is told; a recovered app already read its announcement.
    if (outcome === 'down') deps.announce(report)
    deps.log(`recovery ${outcome}${readyPid ? `: Conductor is back as pid ${readyPid}` : ''}; report ${paths.markdown}`)
    return { result: outcome, report }
  }

  // 4. Relaunch the installed exe ourselves.
  const launch = arm?.launch
  const looping = deps.recentRecoveries(config.recoveryWindowMs) >= config.maxRecoveries
  if (looping) deps.log(`${config.maxRecoveries} recoveries in the last ${Math.round(config.recoveryWindowMs / 60_000)} min: not relaunching again (crash loop)`)
  else if (!launch) deps.log('no launch record: this app never armed its watchdog with an exe')
  else {
    const exes = config.relaunchExes?.length ? config.relaunchExes : [launch.exe, launch.exe]
    for (let index = 0; index < 2; index += 1) {
      await deps.sleep(config.backoffMs[index] ?? config.backoffMs.at(-1) ?? 0)
      const already = await deps.ready(appPid)
      if (already && !attempts.length) { deps.log(`Conductor came back by itself as pid ${already.pid}, late`); return { result: 'returned', pid: already.pid, waitedMs: deps.now() - exitedAt } }
      if (already) { attempts.at(-1)!.ready = true; return finish('relaunched', already.pid, undefined) }
      const exe = exes[index] ?? launch.exe
      deps.recordRecovery()
      const attempt: RelaunchAttempt = { exe, args: launch.args, startedAt: new Date(deps.now()).toISOString(), ready: false }
      attempts.push(attempt)
      deps.announce(build('relaunched', undefined, undefined))
      deps.log(`relaunch attempt ${index + 1}: ${exe} ${launch.args.join(' ')}`)
      const child = await deps.launch(exe, launch.args, launch.cwd)
      if (child.pid) attempt.pid = child.pid
      if (child.outputPath) attempt.outputPath = child.outputPath
      if (child.error) { attempt.error = child.error; deps.log(`attempt ${index + 1} could not start: ${child.error}`); continue }
      const deadline = deps.now() + config.attemptWaitMs
      let readyPid: number | null = null
      while (deps.now() < deadline) {
        const ready = await deps.ready(appPid)
        if (ready) { readyPid = ready.pid; break }
        const code = child.exitCode()
        if (code !== null && code !== undefined) {
          // A second Conductor exits at once when another holds the single-instance lock; one more look.
          const late = await deps.ready(appPid)
          if (late) readyPid = late.pid
          break
        }
        await deps.sleep(config.pollMs)
      }
      const code = child.exitCode()
      attempt.exitCode = code === undefined ? null : code
      attempt.output = tail(child.output())
      child.release()
      if (readyPid) {
        attempt.ready = true
        await deps.notify('Conductor was brought back', `It did not come back by itself; recovery mode relaunched it (attempt ${index + 1}).`)
        return finish('relaunched', readyPid, undefined)
      }
      deps.log(`attempt ${index + 1} did not answer: ${attempt.exitCode === null ? 'still running, not answering' : `exited with ${attempt.exitCode}`}`)
    }
  }

  // 5. The agent, with the exact error.
  const error = attempts.length
    ? `${reason}. Relaunch attempts: ${attempts.map((attempt, index) => `#${index + 1} ${attempt.exe}: ${attempt.error ?? (attempt.exitCode === null || attempt.exitCode === undefined ? 'running but never answered app control' : `exited with code ${attempt.exitCode}`)}`).join('; ')}`
    : looping ? `${reason}. Crash loop: ${config.maxRecoveries} recoveries in ${Math.round(config.recoveryWindowMs / 60_000)} min, so no relaunch was tried` : `${reason}. No relaunch could be tried: the app left no launch record`
  await deps.notify('Conductor is down', 'Recovery mode could not relaunch it; a recovery agent is looking into it.')
  let agent: AgentRun | undefined
  deps.announce(build('agent-recovered', undefined, undefined))
  try {
    agent = await deps.runAgent({ error, arm, attempts, logs: await deps.logTails(), diagnosisPath: paths.markdown })
    deps.log(`recovery agent finished: exit ${agent.exitCode}${agent.timedOut ? ' (timed out)' : ''}${agent.error ? `, ${agent.error}` : ''}`)
  } catch (failure) {
    deps.log(`recovery agent could not run: ${failure instanceof Error ? failure.message : String(failure)}`)
  }
  const after = await waitReady(deps, config, appPid, config.afterAgentWaitMs, config.afterAgentWaitMs)
  if (after) {
    await deps.notify('Conductor was brought back', 'The recovery agent brought it back. Its diagnosis is in the recovery report.')
    return finish('agent-recovered', after.pid, agent)
  }
  await deps.notify('Conductor is still down', `Start it by hand. Diagnosis: ${paths.markdown}`)
  return finish('down', undefined, agent)
}

async function waitReady(deps: WatchdogDeps, config: WatchdogConfig, appPid: number, waitMs: number, maxMs: number): Promise<{ pid: number } | null> {
  const started = deps.now()
  let installerSeenAt = Number.NEGATIVE_INFINITY
  for (;;) {
    const ready = await deps.ready(appPid)
    if (ready) return ready
    const elapsed = deps.now() - started
    if (elapsed >= maxMs) return null
    // An update install may run past the normal wait while its installer is still working; once it
    // is gone, the app it starts gets the restart window to answer.
    if (elapsed >= waitMs) {
      if (maxMs > waitMs && deps.installerRunning()) installerSeenAt = deps.now()
      else if (deps.now() - installerSeenAt >= config.restartWaitMs) return null
    }
    await deps.sleep(config.pollMs)
  }
}
