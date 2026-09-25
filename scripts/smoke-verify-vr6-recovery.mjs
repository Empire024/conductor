// VR6 R2/R3 (docs/verification/2026-09-25-vr6.md). recovery-mode, owner: "Conductor nuked itself! I had to
// turn it on myself. Add recovery mode for when that happens - a script automatically tries turning
// it on, if it doesnt work, agent is called with error it received". Test profiles only.
//   --group crash  R2: a parked app with a wizard mid-turn is crash-killed (taskkill /F of its own
//                  pid); the watchdog relaunches it with no agent call. Control first: the same crash
//                  with CONDUCTOR_RECOVERY_WATCHDOG=0 brings nothing back.
//                  The crash kills the main process alone, as a real crash does.
//                  --host keeps the runtime host on: it survives the crash and stops the cut runtime
//                  itself (the relaunch sweeps any it left, log "Closed host runtime ..."), then the
//                  relaunch resumes the
//                  conversation natively.
//                  FX27: each crash leg (--repeat N, default 2) passes only when the wizard hears
//                  "[Conductor] Conductor restarted (crash, recovered by recovery mode, a -> b);
//                  <recovery report>; continue." within 45 s of the kill and its resumed native runtime is handed it; a last
//                  control leg quits cleanly with the turn finished, reopens, and nothing is resumed.
//   --group front  R3 (owner approved one VISIBLE run, 2026-09-25): app.restart with the app's own
//                  relaunch off, so only the detached watchdog (not a foreground process, like the
//                  installer's Explorer relaunch) starts it again. Control first: restarted while the
//                  test window is minimized (unwatched), the new window must not take the foreground;
//                  then restarted while it is the foreground, the new window must come to the front.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr6-recovery.mjs --group crash
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, descendantsOf, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, owner, page, poll, record, safeClose, sleep, step, watchdog } from './verify-kit.mjs'

const group = process.argv[process.argv.indexOf('--group') + 1]
// --host: the runtime host keeps a cut turn alive, as in the owner's installed app, so the relaunch
// reattaches the wizard's turn and briefs it (that is the path a crash report reaches a wizard by).
const host = process.argv.includes('--host')
const repeat = process.argv.includes('--repeat') ? Number(process.argv[process.argv.indexOf('--repeat') + 1]) : 2
if (!['crash', 'front'].includes(group)) throw new Error('--group crash|front')
const output = group === 'crash' ? `artifacts/verification/2026-09-25-fx27/crash${host ? '-host' : ''}` : 'artifacts/verification/2026-09-25-vr6/recovery'
configure({ name: `vr6-recovery-${group}${host ? '-host' : ''}`, output })
const evidenceDir = join(output, 'logs')
mkdirSync(evidenceDir, { recursive: true })
watchdog(group === 'crash' ? 300 + repeat * 180 : 360)
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

  // FX27 (resume-after-any-restart, VR6 follow-up): the crash also brings the cut wizard back and
  // tells it, with the recovery report, within 45 s of the kill. Twice per run.
  for (let run = 1; run <= repeat; run++) await crashLeg(side, run)
  await cleanQuitLeg(side)
  stopWatchdogs()
}

/** The owner's wand toggle in the wizard's pane, and the setting it saved. */
async function wandOn(inst, view, id) {
  await view.locator('.wizard-toggle:visible').first().click({ timeout: 20_000 })
  await poll(async () => (await snapshotOf(inst, id))?.settings?.wizard === true, { timeoutMs: 10_000, label: 'wizard mode on' })
}
/** The live restart record the app keeps in its database (read-only, beside the running app). */
function restartIntentOf(inst) {
  try {
    const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true })
    try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='restartIntent'").get()?.value || 'null') } finally { db.close() }
  } catch { return null }
}
/** Keeps the relaunched app's own log (the watchdog captured its stdout) as evidence. */
function keepLaunchLogs(inst, label) {
  const dir = join(inst.profile, 'recovery')
  let kept = []
  try { kept = readdirSync(dir).filter(name => /^launch-.*\.log$/.test(name)) } catch { /* none */ }
  for (const name of kept) copyFileSync(join(dir, name), join(evidenceDir, `${label}-${name}`))
  try { copyFileSync(join(inst.root, 'app.log'), join(evidenceDir, `${label}-first-app.log`)) } catch { /* evidence only */ }
  return kept.map(name => join(evidenceDir, `${label}-${name}`))
}
async function snapshotOf(inst, id) { return (await page(inst)).evaluate(target => window.conductor.structured.snapshot(target), id).catch(() => null) }
/** The first [Conductor] line in the conversation, and what followed it. */
function heardIn(snap) {
  const items = snap?.items ?? []
  const at = items.findIndex(item => JSON.stringify(item.data ?? {}).includes('[Conductor]'))
  if (at < 0) return null
  const data = items[at].data
  const text = typeof data.text === 'string' ? data.text : JSON.stringify(data)
  const after = items.slice(at + 1)
  return { text: text.slice(text.indexOf('[Conductor]')), phase: snap.phase, at: `${data.type}/${data.role ?? ''}`, after: after.slice(-6).map(item => `${item.data?.type}/${item.data?.role ?? item.data?.status ?? ''}`) }
}

async function crashLeg(side, run) {
  const label = `R2-crash${host ? '-host' : ''}-${run}`
  step(`${label}: crash a parked app whose wizard is mid-turn`)
  const capture = join(side, `prompt-${label}.txt`)
  const inst = await launchParked({ mode: 'spawn', name: `fx27-${label}`, env: { ...recoveryEnv(side), CONDUCTOR_SMOKE_STEP_MS: 180_000, CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  const pid1 = inst.credential.pid
  await poll(() => { const lock = noteWatchdog(inst); return lock?.appPid === pid1 && alive(lock.pid) ? lock : null }, { timeoutMs: 30_000, label: 'watchdog for the first app' })
  await openProject({ name: `FX27 crash ${run}` }, inst)
  const view = await page(inst)
  const wizard = (await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'FX27 wizard' }, { inst })).resourceId
  await wandOn(inst, view, wizard)
  await view.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC WATCH LOOPS a long step that the crash cuts', state.settings, [])
  }, wizard)
  await poll(async () => (await call('agents.status', { agentSessionId: wizard }, { inst }))?.phase === 'running', { timeoutMs: 20_000, label: 'wizard mid-turn' })
  // The crash lands one second into the turn: the working set must already be on disk.
  await sleep(1000)
  const armedBefore = readJson(join(inst.profile, 'recovery', 'armed.json'))
  const intentBefore = restartIntentOf(inst)
  // A real crash ends the main process alone: its runtime host (host on) and provider CLIs outlive it.
  const listBefore = await listProcesses().then(({ list }) => list).catch(() => [])
  const treeBefore = [...descendantsOf(listBefore, [pid1])].map(pid => listBefore.find(entry => entry.pid === pid)).filter(Boolean)
  spawnSync('taskkill', ['/PID', String(pid1), '/F'], { stdio: 'ignore', windowsHide: true })
  const killedAt = Date.now()
  await poll(() => !alive(pid1), { timeoutMs: 20_000, label: 'crashed app gone' })
  const back = await cameBack(inst, pid1, 90_000)
  // Its new watchdog must be known, or it relaunches the app after the smoke closes it.
  await poll(() => { const lock = noteWatchdog(inst); return lock?.appPid === back.pid && alive(lock.pid) ? lock : null }, { timeoutMs: 30_000, label: 'watchdog re-armed for the relaunched app' })
  const heard = await poll(async () => heardIn(await snapshotOf(inst, wizard)), { timeoutMs: Math.max(1000, 45_000 - (Date.now() - killedAt)), label: 'a [Conductor] message in the wizard within 45 s of the kill' }).catch(() => null)
  const heardAfter = (Date.now() - killedAt) / 1000
  // It resumes: a new native runtime (claude --resume of the same conversation) is handed the message.
  const resumed = heard ? await poll(() => { try { const prompt = readFileSync(capture, 'utf8'); return prompt.includes('[Conductor] Conductor restarted (crash') ? prompt : null } catch { return null } }, { timeoutMs: 30_000, label: 'the resumed native conversation receives the message' }).catch(() => null) : null
  const logs = keepLaunchLogs(inst, label)
  const hostBefore = listBefore.find(entry => /runtime-host/.test(entry.commandLine) && entry.commandLine.includes(inst.root))
  const hostSurvived = Boolean(hostBefore && alive(hostBefore.pid))
  const relaunchLog = logs.map(path => { try { return readFileSync(path, 'utf8') } catch { return '' } }).join('\n')
  const orphanClosed = /Closed host runtime \S+ that a crashed Conductor left behind/.test(relaunchLog)
  // The host itself stops a runtime whose app left without detaching (the crash); the relaunch's
  // orphan sweep is the backstop for one it did not. Either way the cut turn is stopped, then resumed.
  const hostLogPath = join(inst.profile, 'runtime-host', 'host.log')
  let hostLog = ''
  try { hostLog = readFileSync(hostLogPath, 'utf8'); copyFileSync(hostLogPath, join(evidenceDir, `${label}-host.log`)) } catch { /* host off */ }
  const hostStoppedCut = /client left without detaching \S+; closing it/.test(hostLog)
  const hostResumed = (hostLog.match(/ spawned /g) ?? []).length >= 2
  const reports = readdirSync(join(inst.profile, 'recovery')).filter(name => /^recovery-.*\.json$/.test(name)).sort()
  const report = reports.length ? readJson(join(inst.profile, 'recovery', reports.at(-1))) : null
  const message = heard?.text ?? ''
  const numbers = {
    armedKind: armedBefore?.kind, backInSeconds: back.seconds, heardAfterSeconds: heard ? heardAfter : null, outcome: report?.outcome ?? null,
    namesCrash: /Conductor restarted \(crash, recovered by recovery mode, \S+ -> \S+\)/.test(message),
    reportBeforeContinue: /Recovery report: .*recovery-.*\.md; continue\./.test(message),
    resumedRuntimeGotIt: Boolean(resumed), host, heardAs: heard?.at, hostSurvived, hostStoppedCut, orphanClosed, hostResumed, recordedBeforeKill: intentBefore ? { kind: intentBefore.kind, wizard: intentBefore.wizards?.includes(wizard) ?? false } : null
  }
  const pass = Boolean(heard) && heardAfter <= 45 && numbers.namesCrash && numbers.reportBeforeContinue && numbers.resumedRuntimeGotIt && heard.at === 'text/user' && (!host || (hostSurvived && (hostStoppedCut || orphanClosed) && hostResumed)) && report?.outcome === 'relaunched'
  record(label, pass ? 'PASS' : 'FAIL', numbers, `wizard message: ${message.slice(0, 700)}; relaunched app log ${logs.join(', ') || 'none'}`)
  stopWatchdogs()
  await safeClose(inst)
  await sweep(inst, treeBefore.map(entry => entry.pid))
}

/** Kills what outlived the leg: processes under its temp root, and the crashed app's survivors. */
async function sweep(inst, pids = []) {
  const { list } = await listProcesses().catch(() => ({ list: [] }))
  const left = list.filter(entry => entry.pid !== process.pid && (entry.commandLine.includes(inst.root) || pids.includes(entry.pid)))
  for (const entry of left) kill(entry.pid)
  if (left.length) console.log(`[fx27] swept ${left.length} leftover process(es): ${left.map(entry => entry.pid).join(', ')}`)
}

/** Control: a clean quit with the wizard's turn finished resumes nobody when Conductor is reopened. */
async function cleanQuitLeg(side) {
  const label = `R2-clean-quit${host ? '-host' : ''}`
  step(`${label}: a clean quit resumes nobody`)
  const inst = await launchParked({ mode: 'spawn', name: `fx27-${label}`, env: recoveryEnv(side) })
  const pid1 = inst.credential.pid
  await openProject({ name: 'FX27 clean quit' }, inst)
  const view = await page(inst)
  const wizard = (await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'FX27 idle wizard' }, { inst })).resourceId
  await wandOn(inst, view, wizard)
  await view.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B a short turn that finishes', state.settings, [])
  }, wizard)
  await poll(async () => { const snap = await snapshotOf(inst, wizard); return snap && !['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(snap.phase) && snap.items.some(item => item.data?.type === 'text' && item.data.role === 'assistant') }, { timeoutMs: 30_000, label: 'the wizard turn finished' })
  if (inst.browser) { await inst.browser.close().catch(() => {}); inst.browser = null; inst.page = null }
  // WM_CLOSE: the ordinary quit path, no dialog because nothing runs.
  spawnSync('taskkill', ['/PID', String(pid1)], { stdio: 'ignore', windowsHide: true })
  await poll(() => !alive(pid1), { timeoutMs: 60_000, label: 'clean quit' })
  const armed = readJson(join(inst.profile, 'recovery', 'armed.json'))
  // The owner opens Conductor again.
  const log = openSync(join(inst.root, 'reopened.log'), 'a')
  const child = spawn(armed.launch.exe, armed.launch.args, { cwd: armed.launch.cwd, env: inst.env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  inst.pids.add(child.pid)
  const reopenedPid = (await cameBack(inst, pid1, 60_000)).pid
  await poll(() => { const lock = noteWatchdog(inst); return lock?.appPid === reopenedPid && alive(lock.pid) ? lock : null }, { timeoutMs: 30_000, label: 'watchdog armed for the reopened app' })
  const heard = await poll(async () => heardIn(await snapshotOf(inst, wizard)), { timeoutMs: 20_000, label: 'any [Conductor] message' }).catch(() => null)
  let reopened = ''
  try { reopened = readFileSync(join(inst.root, 'reopened.log'), 'utf8'); copyFileSync(join(inst.root, 'reopened.log'), join(evidenceDir, `${label}-reopened.log`)) } catch { /* evidence only */ }
  const planned = /Restart plan:/.test(reopened)
  const numbers = { armedKind: armed?.kind, heard: Boolean(heard), restartPlanLogged: planned }
  record(label, armed?.kind === 'quit' && !heard && !planned ? 'PASS' : 'FAIL', numbers, `clean quit then reopen: ${heard ? `unexpected message ${heard.text.slice(0, 300)}` : 'no [Conductor] message in 20 s'}; log ${join(evidenceDir, `${label}-reopened.log`)}`)
  stopWatchdogs()
  await safeClose(inst)
  await sweep(inst)
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
