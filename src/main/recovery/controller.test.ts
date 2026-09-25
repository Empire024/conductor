import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { recoveryAgentArgs, recoveryAgentCommand, recoveryPrompt, RECOVERY_AGENT_DENIED_TOOLS } from './agent'
import { createRecovery, launchSpec, recoveryEnabled, type RecoveryOptions } from './controller'
import { ARM_FILE, PENDING_REPORT_FILE, parseArmRecord, recoveryNote, type RecoveryReport } from './protocol'
import { watchdogTimings } from './watchdog-support'

const options = (userData: string, extra: Partial<RecoveryOptions> = {}): RecoveryOptions => ({
  userData, packaged: true, platform: 'win32', env: {}, pid: 4321, execPath: 'C:\\Programs\\conductor-desktop\\Conductor.exe', argv: ['C:\\Programs\\conductor-desktop\\Conductor.exe', '--updated'], cwd: 'C:\\',
  watchdogScript: join(userData, 'bundle.js'), log: () => {}, copiedRuntime: async () => 'C:\\runtime\\conductor-runtime-host.exe', startDetached: vi.fn(), ...extra
})

const report = (extra: Partial<RecoveryReport> = {}): RecoveryReport => ({
  id: 'recovery-1', at: '2026-09-25T18:18:00.000Z', appPid: 100, kind: 'update-install', fromVersion: '0.1.53', toVersion: '0.1.54', outcome: 'relaunched',
  error: 'after the update install of 0.1.54 no new Conductor answered app control within 180 s of pid 100 exiting',
  attempts: [{ exe: 'C:\\x\\Conductor.exe', args: [], startedAt: '2026-09-25T18:17:00.000Z', ready: true }], reportPath: 'C:\\u\\recovery\\recovery-1.md', ...extra
})

describe('recovery controller', () => {
  it('is on for the installed Windows app only, unless the environment says otherwise', () => {
    expect(recoveryEnabled({ packaged: true, platform: 'win32', env: {} })).toBe(true)
    expect(recoveryEnabled({ packaged: false, platform: 'win32', env: {} })).toBe(false)
    expect(recoveryEnabled({ packaged: true, platform: 'darwin', env: {} })).toBe(false)
    expect(recoveryEnabled({ packaged: false, platform: 'win32', env: { CONDUCTOR_RECOVERY_WATCHDOG: '1' } })).toBe(true)
    expect(recoveryEnabled({ packaged: true, platform: 'win32', env: { CONDUCTOR_RECOVERY_WATCHDOG: '0' } })).toBe(false)
  })

  it('relaunches the installed exe alone, and a checkout with its argv', () => {
    expect(launchSpec({ packaged: true, execPath: 'C:\\P\\Conductor.exe', argv: ['C:\\P\\Conductor.exe', '--updated'], cwd: 'C:\\' })).toEqual({ exe: 'C:\\P\\Conductor.exe', args: [] })
    expect(launchSpec({ packaged: false, execPath: 'C:\\n\\electron.exe', argv: ['C:\\n\\electron.exe', '--remote-debugging-port=9', 'out/main/index.js'], cwd: 'C:\\repo' }))
      .toEqual({ exe: 'C:\\n\\electron.exe', args: ['--remote-debugging-port=9', 'out/main/index.js'], cwd: 'C:\\repo' })
  })

  it('arms a running record at start, starts the watchdog from the runtime copy, and rewrites the record on every stop', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'recovery-controller-'))
    writeFileSync(join(userData, 'bundle.js'), '// watchdog')
    const startDetached = vi.fn()
    const recovery = createRecovery(options(userData, { startDetached }))
    await recovery.start({ fromVersion: '0.1.54', checkout: 'C:\\Claude\\conductor' })
    const armPath = join(userData, 'recovery', ARM_FILE)
    expect(parseArmRecord(readFileSync(armPath, 'utf8'))).toMatchObject({ appPid: 4321, kind: 'running', fromVersion: '0.1.54', checkout: 'C:\\Claude\\conductor', launch: { exe: 'C:\\Programs\\conductor-desktop\\Conductor.exe', args: [] } })
    expect(startDetached).toHaveBeenCalledTimes(1)
    const [runtime, args, environment] = startDetached.mock.calls[0]!
    expect(runtime).toBe('C:\\runtime\\conductor-runtime-host.exe')
    // A packaged app runs a copy of the bundle, never the one inside app.asar.
    expect(args[0]).toMatch(/recovery[\\/]watchdog-[0-9a-f]{16}\.js$/)
    expect(existsSync(args[0])).toBe(true)
    expect(args.slice(1)).toEqual(['--user-data', userData, '--app-pid', '4321'])
    expect(environment).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', CONDUCTOR_RECOVERY_APP_PID: '4321' })
    recovery.arm('update-install', { fromVersion: '0.1.54', toVersion: '0.1.55', foreground: true })
    expect(parseArmRecord(readFileSync(armPath, 'utf8'))).toMatchObject({ kind: 'update-install', toVersion: '0.1.55', foreground: true, checkout: 'C:\\Claude\\conductor' })
    recovery.arm('quit', { fromVersion: '0.1.54', foreground: false })
    expect(parseArmRecord(readFileSync(armPath, 'utf8'))).toMatchObject({ kind: 'quit', foreground: false })
    // The next launch reads how this one stopped before arming its own.
    expect(createRecovery(options(userData, { pid: 9999 })).previousArm).toMatchObject({ appPid: 4321, kind: 'quit' })
  })

  it('does nothing when off', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'recovery-controller-'))
    const startDetached = vi.fn()
    const recovery = createRecovery(options(userData, { packaged: false, startDetached }))
    await recovery.start({ fromVersion: '1', checkout: null })
    recovery.arm('restart', { fromVersion: '1', foreground: true })
    expect(startDetached).not.toHaveBeenCalled()
    expect(existsSync(join(userData, 'recovery', ARM_FILE))).toBe(false)
  })

  it('hands the pending report to the next launch once', () => {
    const userData = mkdtempSync(join(tmpdir(), 'recovery-controller-'))
    mkdirSync(join(userData, 'recovery'), { recursive: true })
    writeFileSync(join(userData, 'recovery', PENDING_REPORT_FILE), JSON.stringify(report()))
    const recovery = createRecovery(options(userData))
    expect(recovery.takeReport()).toMatchObject({ id: 'recovery-1', outcome: 'relaunched' })
    expect(recovery.takeReport()).toBeNull()
  })
})

describe('recovery note and agent', () => {
  it('extends the restart line with what recovery mode did', () => {
    expect(recoveryNote(null)).toBe('')
    expect(recoveryNote(report())).toBe(' Conductor did not come back by itself after this stop (after the update install of 0.1.54 no new Conductor answered app control within 180 s of pid 100 exiting); recovery mode relaunched it (attempt 1). Recovery report: C:\\u\\recovery\\recovery-1.md.')
    expect(recoveryNote(report({ outcome: 'agent-recovered', attempts: [report().attempts[0]!, report().attempts[0]!] }))).toContain("recovery mode's relaunch failed 2 times and the recovery agent brought it back")
  })

  it('names a crash as a crash', () => {
    expect(recoveryNote(report({ kind: 'running', error: 'Conductor pid 100 ended without quitting (crash or kill) and no Conductor answered app control within 4 s' })))
      .toBe(' The previous Conductor crashed or was killed (Conductor pid 100 ended without quitting (crash or kill) and no Conductor answered app control within 4 s); recovery mode relaunched it (attempt 1). Recovery report: C:\\u\\recovery\\recovery-1.md.')
  })

  it('never reaches the real CLI from a test profile unless told to, and denies commits, pushes and deletes', () => {
    const resolveClaude = (): string => 'C:\\Users\\o\\.local\\bin\\claude.exe'
    expect(recoveryAgentCommand({ env: {}, testProfile: false, resolveClaude })).toEqual(['C:\\Users\\o\\.local\\bin\\claude.exe'])
    expect(recoveryAgentCommand({ env: {}, testProfile: true, resolveClaude })).toBeNull()
    expect(recoveryAgentCommand({ env: { CONDUCTOR_RECOVERY_AGENT_COMMAND: '["node","fake-agent.mjs"]' }, testProfile: true, resolveClaude })).toEqual(['node', 'fake-agent.mjs'])
    // The override means nothing to the installed app.
    expect(recoveryAgentCommand({ env: { CONDUCTOR_RECOVERY_AGENT_COMMAND: '["node","x.mjs"]' }, testProfile: false, resolveClaude })).toEqual(['C:\\Users\\o\\.local\\bin\\claude.exe'])
    expect(recoveryAgentCommand({ env: { CONDUCTOR_RECOVERY_AGENT_COMMAND: 'not json' }, testProfile: true, resolveClaude })).toBeNull()
    const args = recoveryAgentArgs()
    expect(args.slice(0, 1)).toEqual(['-p'])
    for (const denied of ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(rm:*)', 'PowerShell(Remove-Item:*)', 'Edit', 'Write']) expect(RECOVERY_AGENT_DENIED_TOOLS).toContain(denied)
    expect(args).toContain('--max-turns')
  })

  it('gives the agent the exact error, the attempts, the logs and the launch command', () => {
    const prompt = recoveryPrompt({
      error: 'no new Conductor answered. Relaunch attempts: #1 C:\\x\\Conductor.exe: exited with code 3',
      arm: { appPid: 100, kind: 'restart', at: '2026-09-25T18:16:02.000Z', fromVersion: '0.1.54', foreground: true, launch: { exe: 'C:\\x\\Conductor.exe', args: [] }, checkout: null, packaged: true },
      attempts: [{ exe: 'C:\\x\\Conductor.exe', args: [], startedAt: 't', exitCode: 3, output: 'boom', ready: false }],
      logs: { 'C:\\u\\runtime-host\\host.log': 'attached' }, diagnosisPath: 'C:\\u\\recovery\\r.md'
    }, { userData: 'C:\\u', now: 'now' })
    expect(prompt).toContain('#1 C:\\x\\Conductor.exe: exited with code 3')
    expect(prompt).toContain('exited with code 3')
    expect(prompt).toContain('boom')
    expect(prompt).toContain('C:\\u\\runtime-host\\host.log')
    expect(prompt).toContain('`C:\\x\\Conductor.exe`')
    expect(prompt).toContain('Never: git commit, push')
    expect(prompt).toContain('C:\\u\\recovery\\r.md')
  })

  it('honours test timings and exes in a test profile only', () => {
    const env = { CONDUCTOR_RECOVERY_TIMINGS: '{"restartWaitMs":5000,"backoffMs":[100,200]}', CONDUCTOR_RECOVERY_TEST_EXES: '["C:\\\\nope.exe"]' }
    expect(watchdogTimings(env, true)).toEqual({ restartWaitMs: 5000, backoffMs: [100, 200], relaunchExes: ['C:\\nope.exe'] })
    expect(watchdogTimings(env, false)).toEqual({})
  })
})
