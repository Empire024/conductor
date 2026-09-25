import { describe, expect, it } from 'vitest'
import type { AgentRun, ArmRecord, RecoveryReport, StopKind } from './protocol'
import { DEFAULT_WATCHDOG_CONFIG, runWatchdog, type AgentRequest, type LaunchedProcess, type WatchdogConfig, type WatchdogDeps } from './watchdog'

const OLD = 100
const arm = (kind: StopKind, extra: Partial<ArmRecord> = {}): ArmRecord => ({
  appPid: OLD, kind, at: '2026-09-25T18:16:02.000Z', fromVersion: '0.1.53', toVersion: kind === 'update-install' ? '0.1.54' : undefined,
  foreground: true, launch: { exe: 'C:\\Programs\\Conductor.exe', args: [] }, checkout: 'C:\\Claude\\conductor', packaged: true, ...extra
})

interface FakeExe { error?: string; exitCode?: number | null; output?: string; becomesReadyAfterMs?: number; newPid?: number }

/** A fake machine: a clock that sleep advances, the old pid, a control-owner answer that appears
 *  at a set time, and exes/agents whose behaviour each test scripts. */
function machine(options: {
  armed: ArmRecord | null
  appDiesAtMs?: number
  readyAtMs?: number | null
  exes?: Record<string, FakeExe>
  agent?: (request: AgentRequest) => { readyAfterMs?: number; run?: Partial<AgentRun> }
  installerUntilMs?: number
  recentRecoveries?: number
}) {
  let now = 0
  let readyAt: number | null = options.readyAtMs ?? null
  let readyPid = 200
  const launches: Array<{ exe: string; args: string[] }> = []
  const notifications: string[] = []
  const agentCalls: AgentRequest[] = []
  const reports: RecoveryReport[] = []
  const announced: RecoveryReport[] = []
  let recorded = 0
  const deps: WatchdogDeps = {
    now: () => now,
    sleep: async ms => { now += ms },
    alive: pid => pid === OLD && now < (options.appDiesAtMs ?? 0),
    readArm: () => options.armed,
    ready: async previous => readyAt !== null && now >= readyAt && readyPid !== previous ? { pid: readyPid } : null,
    installerRunning: () => now < (options.installerUntilMs ?? 0),
    launch: async (exe, args) => {
      launches.push({ exe, args })
      const script = options.exes?.[exe] ?? {}
      if (script.becomesReadyAfterMs !== undefined) { readyAt = now + script.becomesReadyAfterMs; readyPid = script.newPid ?? 300 }
      const process: LaunchedProcess = {
        ...(script.error ? { error: script.error } : { pid: 4242 }),
        exitCode: () => script.exitCode ?? null,
        output: () => script.output ?? '',
        outputPath: `launch-${launches.length}.log`,
        release: () => {}
      }
      return process
    },
    runAgent: async request => {
      agentCalls.push(request)
      const behaviour = options.agent?.(request) ?? {}
      if (behaviour.readyAfterMs !== undefined) { readyAt = now + behaviour.readyAfterMs; readyPid = 500 }
      return { command: ['claude'], cwd: 'C:\\Claude\\conductor', exitCode: 0, timedOut: false, diagnosisPath: request.diagnosisPath, ...behaviour.run }
    },
    notify: async (title, body) => { notifications.push(`${title}: ${body}`) },
    logTails: async () => ({ 'host.log': 'attached fefb8e41' }),
    recentRecoveries: () => options.recentRecoveries ?? 0,
    recordRecovery: () => { recorded += 1 },
    reportPaths: () => ({ id: 'recovery-x', json: 'r/recovery-x.json', markdown: 'r/recovery-x.md' }),
    writeReport: report => { reports.push(report) },
    announce: report => { announced.push(JSON.parse(JSON.stringify(report)) as RecoveryReport) },
    log: () => {},
    parentGone: () => false
  }
  const config: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG, appPid: OLD }
  return { deps, config, launches, notifications, agentCalls, reports, announced, get recorded() { return recorded }, get now() { return now } }
}

describe('recovery watchdog', () => {
  it('does nothing after a clean owner quit, even with an update installing on the way out', async () => {
    for (const kind of ['quit', 'update-on-quit'] as const) {
      const m = machine({ armed: arm(kind), appDiesAtMs: 5000 })
      expect(await runWatchdog(m.deps, m.config)).toEqual({ result: 'clean-quit', kind })
      expect(m.launches).toEqual([])
      expect(m.agentCalls).toEqual([])
      expect(m.notifications).toEqual([])
      expect(m.reports).toEqual([])
      expect(m.announced).toEqual([])
    }
  })

  it('leaves a Conductor that comes back in time alone', async () => {
    const m = machine({ armed: arm('update-install'), appDiesAtMs: 2000, readyAtMs: 20_000 })
    const result = await runWatchdog(m.deps, m.config)
    expect(result).toMatchObject({ result: 'returned', pid: 200 })
    expect(m.launches).toEqual([])
    expect(m.notifications).toEqual([])
    expect(m.reports).toEqual([])
  })

  it('waits past the normal window while the installer still runs', async () => {
    const m = machine({ armed: arm('update-install'), appDiesAtMs: 0, readyAtMs: 250_000, installerUntilMs: 240_000 })
    expect(await runWatchdog(m.deps, m.config)).toMatchObject({ result: 'returned' })
    expect(m.launches).toEqual([])
  })

  it('relaunches the installed exe when the restart did not come back, and tells the owner', async () => {
    const m = machine({ armed: arm('restart'), appDiesAtMs: 1000, exes: { 'C:\\Programs\\Conductor.exe': { becomesReadyAfterMs: 8000 } } })
    const result = await runWatchdog(m.deps, m.config)
    expect(result.result).toBe('relaunched')
    // The full restart window went by first.
    expect(m.now).toBeGreaterThanOrEqual(1000 + m.config.restartWaitMs)
    expect(m.launches).toEqual([{ exe: 'C:\\Programs\\Conductor.exe', args: [] }])
    expect(m.notifications).toEqual([expect.stringContaining('Conductor was brought back')])
    expect(m.reports).toHaveLength(1)
    const report = m.reports[0]!
    expect(report).toMatchObject({ outcome: 'relaunched', kind: 'restart', readyPid: 300, appPid: OLD })
    expect(report.error).toContain('no new Conductor answered app control')
    expect(report.attempts).toEqual([expect.objectContaining({ ready: true, pid: 4242 })])
    expect(m.agentCalls).toEqual([])
    // Announced before the launch: the relaunched app reads it at startup, before it answers.
    expect(m.announced.map(r => [r.outcome, r.attempts.length])).toEqual([['relaunched', 1]])
  })

  it('calls the agent with the exact error when both relaunches fail, and reports its recovery', async () => {
    const m = machine({
      armed: arm('update-install'), appDiesAtMs: 0,
      exes: { 'C:\\Programs\\Conductor.exe': { exitCode: -1073741515, output: 'The code execution cannot proceed because ffmpeg.dll was not found.' } },
      agent: () => ({ readyAfterMs: 5000 })
    })
    const result = await runWatchdog(m.deps, m.config)
    expect(result.result).toBe('agent-recovered')
    expect(m.launches).toHaveLength(2)
    expect(m.recorded).toBe(2)
    expect(m.agentCalls).toHaveLength(1)
    const request = m.agentCalls[0]!
    expect(request.error).toContain('after the update install of 0.1.54 no new Conductor answered app control')
    expect(request.error).toContain('#1 C:\\Programs\\Conductor.exe: exited with code -1073741515')
    expect(request.error).toContain('#2 C:\\Programs\\Conductor.exe: exited with code -1073741515')
    expect(request.attempts[0]!.output).toContain('ffmpeg.dll was not found')
    expect(request.logs).toEqual({ 'host.log': 'attached fefb8e41' })
    expect(request.diagnosisPath).toBe('r/recovery-x.md')
    expect(m.notifications[0]).toContain('Conductor is down')
    expect(m.notifications.at(-1)).toContain('The recovery agent brought it back')
    expect(m.announced.map(r => [r.outcome, r.attempts.length])).toEqual([['relaunched', 1], ['relaunched', 2], ['agent-recovered', 2]])
    expect(m.reports[0]).toMatchObject({ outcome: 'agent-recovered', readyPid: 500, agent: expect.objectContaining({ command: ['claude'] }) })
  })

  it('records a spawn failure as the attempt error and says it is still down when the agent fails too', async () => {
    const m = machine({ armed: arm('restart'), appDiesAtMs: 0, exes: { 'C:\\Programs\\Conductor.exe': { error: 'spawn C:\\Programs\\Conductor.exe ENOENT' } } })
    const result = await runWatchdog(m.deps, m.config)
    expect(result.result).toBe('down')
    expect(m.agentCalls[0]!.error).toContain('#1 C:\\Programs\\Conductor.exe: spawn C:\\Programs\\Conductor.exe ENOENT')
    expect(m.notifications.at(-1)).toContain('Conductor is still down')
    expect(m.reports[0]).toMatchObject({ outcome: 'down' })
    expect(m.reports[0]!.readyPid).toBeUndefined()
    // Still down: the next launch, by hand, is told.
    expect(m.announced.at(-1)).toMatchObject({ outcome: 'down' })
  })

  it('uses the test profile exes in order: a bogus one fails, the real one brings it back', async () => {
    const m = machine({ armed: arm('restart'), appDiesAtMs: 0, exes: { 'C:\\nope\\bogus.exe': { error: 'spawn C:\\nope\\bogus.exe ENOENT' }, 'C:\\Programs\\Conductor.exe': { becomesReadyAfterMs: 3000 } } })
    m.config.relaunchExes = ['C:\\nope\\bogus.exe', 'C:\\Programs\\Conductor.exe']
    const result = await runWatchdog(m.deps, m.config)
    expect(result.result).toBe('relaunched')
    expect(m.launches.map(launch => launch.exe)).toEqual(['C:\\nope\\bogus.exe', 'C:\\Programs\\Conductor.exe'])
    expect(m.reports[0]!.attempts.map(attempt => attempt.ready)).toEqual([false, true])
  })

  it('treats a pid that vanished without a record as a crash and brings it back', async () => {
    const m = machine({ armed: arm('running'), appDiesAtMs: 60_000, exes: { 'C:\\Programs\\Conductor.exe': { becomesReadyAfterMs: 4000 } } })
    const result = await runWatchdog(m.deps, m.config)
    expect(result.result).toBe('relaunched')
    expect(m.reports[0]!.kind).toBe('running')
    expect(m.reports[0]!.error).toContain('ended without quitting')
    // Only the short crash grace, not the restart window.
    expect(m.now).toBeLessThan(60_000 + m.config.restartWaitMs)
  })

  it('ignores an armed record written by a different process', async () => {
    const m = machine({ armed: arm('quit', { appPid: 999 }), appDiesAtMs: 0, exes: { 'C:\\Programs\\Conductor.exe': { becomesReadyAfterMs: 1000 } } })
    expect((await runWatchdog(m.deps, m.config)).result).toBe('down')
    // No launch record of its own: nothing to relaunch, so straight to the agent.
    expect(m.launches).toEqual([])
    expect(m.agentCalls[0]!.error).toContain('No relaunch could be tried')
  })

  it('stops relaunching in a crash loop and goes to the agent', async () => {
    const m = machine({ armed: arm('running'), appDiesAtMs: 0, recentRecoveries: 3, exes: { 'C:\\Programs\\Conductor.exe': { becomesReadyAfterMs: 1000 } } })
    expect((await runWatchdog(m.deps, m.config)).result).toBe('down')
    expect(m.launches).toEqual([])
    expect(m.agentCalls[0]!.error).toContain('Crash loop')
  })

  it('notices a Conductor that came back late on its own before relaunching', async () => {
    const m = machine({ armed: arm('restart'), appDiesAtMs: 0, readyAtMs: 61_000 })
    expect(await runWatchdog(m.deps, m.config)).toMatchObject({ result: 'returned' })
    expect(m.launches).toEqual([])
  })

  it('stops when the test launcher is gone', async () => {
    const m = machine({ armed: arm('running'), appDiesAtMs: 10_000_000 })
    m.deps.parentGone = () => true
    expect(await runWatchdog(m.deps, m.config)).toEqual({ result: 'stopped', reason: 'parent gone' })
  })
})
