// VR6 R2/R3 (docs/verification/2026-09-25-vr6.md). recovery-mode, owner: "Conductor nuked itself! I had to
// turn it on myself. Add recovery mode for when that happens - a script automatically tries turning
// it on, if it doesnt work, agent is called with error it received". Test profiles only.
//   --group crash  R2: a parked app with a wizard mid-turn is crash-killed (taskkill /F of its own
//                  pid); the watchdog relaunches it with no agent call. Control first: the same crash
//                  with CONDUCTOR_RECOVERY_WATCHDOG=0 brings nothing back.
//                  --host keeps the runtime host on, so the cut wizard turn is reattached and briefed.
//   --group front  R3 (owner approved one VISIBLE run, 2026-09-25): app.restart with the app's own
//                  relaunch off, so only the detached watchdog (not a foreground process, like the
//                  installer's Explorer relaunch) starts it again. Control first: restarted while the
//                  test window is minimized (unwatched), the new window must not take the foreground;
//                  then restarted while it is the foreground, the new window must come to the front.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr6-recovery.mjs --group crash
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, owner, page, poll, record, safeClose, sleep, step, watchdog } from './verify-kit.mjs'

const group = process.argv[process.argv.indexOf('--group') + 1]
// --host: the runtime host keeps a cut turn alive, as in the owner's installed app, so the relaunch
// reattaches the wizard's turn and briefs it (that is the path a crash report reaches a wizard by).
const host = process.argv.includes('--host')
if (!['crash', 'front'].includes(group)) throw new Error('--group crash|front')
configure({ name: `vr6-recovery-${group}${host ? '-host' : ''}`, output: 'artifacts/verification/2026-09-25-vr6/recovery' })
watchdog(group === 'crash' ? 480 : 360)
await loadCheck()

const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const kill = pid => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
const lines = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }
const recoveryEnv = side => ({
  CONDUCTOR_RECOVERY_WATCHDOG: '1', CONDUCTOR_RUNTIME_HOST: host ? '1' : '0', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_RECOVERY_TIMINGS: JSON.stringify({ pollMs: 500, restartWaitMs: 8000, crashWaitMs: 4000, attemptWaitMs: 45_000, backoffMs: [500, 1000], afterAgentWaitMs: 20_000 }),
  // Must not be reached in these legs; if it is, the call is logged and nothing is started.
  CONDUCTOR_RECOVERY_AGENT_COMMAND: JSON.stringify([process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(join(side, 'agent-calls.log'))}, 'called\\n')`])
})
// Every watchdog this run's instances started, so none outlives the smoke and relaunches after it.
const watchdogs = new Set()
const noteWatchdog = inst => { const lock = readJson(join(inst.profile, 'recovery', 'watchdog.json')); if (lock?.pid) watchdogs.add(lock.pid); return lock }
const stopWatchdogs = () => { for (const pid of watchdogs) if (alive(pid)) kill(pid) }
/** The recovered app: a new live pid in control-owner.json that answers tools.list. */
const cameBack = async (inst, oldPid, timeoutMs) => {
  const started = Date.now()
  const credential = await owner(inst, { notPid: oldPid, timeoutMs })
  await poll(async () => (await call('tools.list', {}, { inst, projectId: null }).then(() => true, () => false)), { timeoutMs: 30_000, label: 'the relaunched app answers app control' })
  if (inst.browser) { await inst.browser.close().catch(() => {}); inst.browser = null; inst.page = null }
  return { pid: credential.pid, seconds: (Date.now() - started) / 1000 }
}

try {
  if (group === 'crash') await crash()
  else await front()
} catch (error) { await failed(error, group === 'crash' ? 'R2' : 'R3') }
stopWatchdogs()
await finish()

async function crash() {
  const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await import('node:os')
  const side = await mkdtemp(join(tmpdir(), 'conductor-vr6-recovery-side-'))

  step('R2 control: crash with the watchdog off')
  const control = await launchParked({ mode: 'spawn', name: 'vr6-r2-control', env: { ...recoveryEnv(side), CONDUCTOR_RECOVERY_WATCHDOG: '0' } })
  const controlPid = control.credential.pid
  await sleep(5000)
  const controlWatchdog = existsSync(join(control.profile, 'recovery', 'watchdog.json'))
  kill(controlPid)
  await poll(() => !alive(controlPid), { timeoutMs: 20_000, label: 'control app gone' })
  await sleep(30_000)
  const after = readJson(join(control.profile, 'control-owner.json'))
  const controlBack = Boolean(after && after.pid !== controlPid && alive(after.pid))
  record('R2-control-no-watchdog', !controlBack && !controlWatchdog ? 'PASS' : 'FAIL', { watchdogStarted: controlWatchdog, cameBackIn30s: controlBack }, 'CONDUCTOR_RECOVERY_WATCHDOG=0: a crash-killed parked app stays down (the pre-fix behaviour this item was filed for)')
  await safeClose(control)

  step('R2: crash a parked app whose wizard is mid-turn')
  const inst = await launchParked({ mode: 'spawn', name: 'vr6-r2-crash', env: { ...recoveryEnv(side), CONDUCTOR_SMOKE_STEP_MS: 180_000 } })
  const pid1 = inst.credential.pid
  const lock1 = await poll(() => { const lock = noteWatchdog(inst); return lock?.appPid === pid1 && alive(lock.pid) ? lock : null }, { timeoutMs: 30_000, label: 'watchdog for the first app' })
  await openProject({ name: 'VR6 recovery' })
  const view = await page(inst)
  const wizard = (await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'VR6 wizard' })).resourceId
  await view.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC WATCH LOOPS a long step that the crash cuts', settings, [])
  }, wizard)
  await poll(async () => (await call('agents.status', { agentSessionId: wizard }))?.phase === 'running', { timeoutMs: 20_000, label: 'wizard mid-turn' })
  await sleep(2000)
  const armedBefore = readJson(join(inst.profile, 'recovery', 'armed.json'))
  kill(pid1)
  const killedAt = Date.now()
  await poll(() => !alive(pid1), { timeoutMs: 20_000, label: 'crashed app gone' })
  const back = await cameBack(inst, pid1, 90_000)
  const secondsFromKill = (Date.now() - killedAt) / 1000
  await poll(() => { const lock = noteWatchdog(inst); return lock?.appPid === back.pid && alive(lock.pid) ? lock : null }, { timeoutMs: 30_000, label: 'watchdog re-armed for the relaunched app' })
  const recoveryDir = join(inst.profile, 'recovery')
  const reports = (await import('node:fs')).readdirSync(recoveryDir).filter(name => /^recovery-.*\.json$/.test(name)).sort()
  const report = reports.length ? readJson(join(recoveryDir, reports.at(-1))) : null
  const toasts = lines(join(recoveryDir, 'toasts.jsonl')).map(toast => toast.title)
  const agentCalled = existsSync(join(side, 'agent-calls.log'))
  const log = (() => { try { return readFileSync(join(recoveryDir, 'watchdog.log'), 'utf8') } catch { return '' } })()
  const numbers = { armedKind: armedBefore?.kind, secondsFromKill, outcome: report?.outcome ?? null, attempts: report?.attempts?.map(a => ({ ready: a.ready, exit: a.exitCode ?? null })) ?? null, toasts, agentCalled, watchdogLogCrash: /ended without quitting|recorded nothing|crash/.test(log) }
  writeFileSync(join(side, 'watchdog.log.copy'), log)
  const pass = back.pid !== pid1 && report?.outcome === 'relaunched' && !agentCalled && toasts.includes('Conductor was brought back')
  record('R2-crash-recovered', pass ? 'PASS' : 'FAIL', numbers, `report ${reports.at(-1) ?? 'none'}; watchdog log ${join(side, 'watchdog.log.copy')}`)

  step('R2: what the wizard hears after the crash')
  const heard = await poll(async () => {
    const snap = await (await page(inst)).evaluate(id => window.conductor.structured.snapshot(id), wizard).catch(() => null)
    const text = JSON.stringify(snap?.items ?? [])
    const at = text.indexOf('[Conductor]')
    return at >= 0 ? text.slice(at, at + 700) : null
  }, { timeoutMs: 45_000, label: 'a [Conductor] message in the wizard' }).catch(error => `none: ${error.message.slice(0, 200)}`)
  const mentionsRecovery = /recovery mode relaunched it|Recovery report/.test(heard)
  record('R2-wizard-report', mentionsRecovery ? 'PASS' : 'INFO', { mentionsRecovery }, `wizard message: ${heard.replace(/\\n/g, ' ').slice(0, 600)}`)
  stopWatchdogs()
}

async function front() {
  const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await import('node:os')
  const side = await mkdtemp(join(tmpdir(), 'conductor-vr6-front-side-'))
  // The foreground window's pid, and whether a window of `pid` sits above it in the z-order.
  const screen = pid => {
    const script = ['Add-Type @"', 'using System; using System.Runtime.InteropServices;', 'public class VrZ { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }', '"@', `$fg = [VrZ]::GetForegroundWindow(); $fp = 0; [void][VrZ]::GetWindowThreadProcessId($fg, [ref]$fp); $first = 'none'; $h = [VrZ]::GetTopWindow([IntPtr]::Zero); while ($h -ne [IntPtr]::Zero) { if ($h -eq $fg) { $first = 'foreground'; break }; if ([VrZ]::IsWindowVisible($h) -and -not [VrZ]::IsIconic($h)) { $p = 0; [void][VrZ]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ${pid}) { $first = 'test'; break } }; $h = [VrZ]::GetWindow($h, 2) }; "$fp $first"`].join('\n')
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    const [fg, first] = run.stdout.trim().split(' ')
    return { foregroundPid: Number(fg) || null, testAboveForeground: first === 'test', first: first ?? run.stderr.slice(0, 200) }
  }
  const armedFile = inst => join(inst.profile, 'recovery', 'armed.json')
  const restart = async (inst, { watched }) => {
    const pid = inst.credential.pid
    await call('app.restart', {}, { inst, projectId: null }).catch(error => console.log(`[R3] app.restart transport: ${error.message.slice(0, 200)}`))
    await poll(() => !alive(pid), { timeoutMs: 60_000, label: `pid ${pid} exits` })
    const armed = readJson(armedFile(inst))
    // Watched: the quitting window had the focus. The smoke cannot take the foreground from the
    // owner's app, so the quitting instance's own arm record is marked watched in the 8 s before the
    // detached watchdog relaunches it - the relaunch then meets the 2026-09-25 condition exactly:
    // another app holds the foreground and a non-foreground process starts Conductor.
    if (watched) writeFileSync(armedFile(inst), JSON.stringify({ ...armed, foreground: true }))
    const back = await cameBack(inst, pid, 90_000)
    await poll(() => { const lock = noteWatchdog(inst); return lock?.appPid === back.pid && alive(lock.pid) ? lock : null }, { timeoutMs: 30_000, label: 'watchdog re-armed for the relaunched app' })
    await sleep(4000)
    return { oldPid: pid, newPid: back.pid, seconds: back.seconds, armedKind: armed?.kind, armedForeground: armed?.foreground, ...screen(back.pid) }
  }

  step('R3: visible test window (CONDUCTOR_BACKGROUND_WINDOWS=0), relaunch only by the watchdog')
  const inst = await launchParked({ mode: 'spawn', name: 'vr6-r3-front', env: { ...recoveryEnv(side), CONDUCTOR_BACKGROUND_WINDOWS: '0', CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH: '1' } })
  noteWatchdog(inst)
  await sleep(4000)

  step('R3 control: restart nobody was watching')
  const unwatched = await restart(inst, { watched: false })
  const controlPass = unwatched.foregroundPid !== unwatched.newPid && !unwatched.testAboveForeground
  record('R3-control-unwatched', controlPass ? 'PASS' : 'FAIL', unwatched, 'an unwatched restart comes back behind the foreground app (the measurement tells the two apart)')

  step('R3: restart the owner was watching')
  const watched = await restart(inst, { watched: true })
  const { shot } = await import('./verify-kit.mjs')
  const evidence = await shot('r3-watched-front', inst).catch(() => '')
  const inFront = watched.foregroundPid === watched.newPid || watched.testAboveForeground
  record('R3-watched-front', inFront && controlPass ? 'PASS' : 'FAIL', watched, `watched restart relaunched by the detached watchdog: the new window is the foreground window or above it; ${evidence}`)
}
