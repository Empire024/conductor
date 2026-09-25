// VR1 group leak (feature-list.md smoke-instances-never-leak): smoke and verify instances must never
// outlive their run, and a parked instance must never put a dialog on the owner's screen.
//   L1  a hung smoke under smoke-lock --timeout-min 1: the whole tree is gone after the timeout
//   L2  the shell that ran smoke-lock dies (a), or smoke-lock itself is killed without /T (b)
//   L3  an uncaught main-process error and a quit with a running turn show no native dialog
// The inner smoke-lock gets its own TEMP, so its lock is not the machine-wide one this smoke holds.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr1-leak.mjs [--soak N]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, call, configure, descendantsOf, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, poll, record, safeClose, sameProcesses, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'vr1-leak', output: 'artifacts/verification/2026-09-25-vr1' })
const soak = Number(process.argv[process.argv.indexOf('--soak') + 1]) || 0
watchdog(soak ? 60 * 60 : 18 * 60)
const hangScript = join(REPO, 'scripts', 'smoke-leak-proof-hang.mjs')
const lockScript = join(REPO, 'scripts', 'smoke-lock.mjs')
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const isApp = entry => /^electron(\.exe)?$/i.test(entry.name) || /fake-claude|runtime-host/i.test(entry.commandLine)

/** Visible top-level windows of `pids`: class and title. #32770 is a native dialog box. */
const windowScript = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class VrWin {
  public delegate bool Cb(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> List() { var rows = new List<string>(); EnumWindows((h, p) => { if (!IsWindowVisible(h)) return true; uint pid; GetWindowThreadProcessId(h, out pid); var c = new StringBuilder(256); GetClassName(h, c, 256); var t = new StringBuilder(512); GetWindowText(h, t, 512); rows.Add(pid + "\\t" + c + "\\t" + t); return true; }, IntPtr.Zero); return rows; }
}
"@
[VrWin]::List()
`
let windowScriptFile
async function windowsOf(pids) {
  windowScriptFile ??= join(await mkdtemp(join(tmpdir(), 'vr1-leak-win-')), 'windows.ps1')
  if (!existsSync(windowScriptFile)) await writeFile(windowScriptFile, windowScript)
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowScriptFile], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  return run.stdout.split(/\r?\n/).filter(Boolean).map(line => { const [pid, cls, title] = line.split('\t'); return { pid: Number(pid), cls, title } }).filter(row => pids.has(row.pid))
}

/** One inner run of the hang fixture. how: 'timeout' | 'wrapper' | 'lock'. */
async function innerRun(id, how) {
  const root = await mkdtemp(join(tmpdir(), 'vr1-leak-run-'))
  await mkdir(join(root, 'tmp'), { recursive: true })
  const env = { ...process.env, TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), CONDUCTOR_LEAK_PROOF_ROOT: root }
  for (const key of ['CONDUCTOR_TEST_PARENT_PID', 'ELECTRON_RUN_AS_NODE']) delete env[key]
  const lockArgs = [lockScript, '--timeout-min', how === 'timeout' ? '1' : '5', '--', process.execPath, hangScript]
  // For 'wrapper' a plain node process owns smoke-lock, standing in for the verifier's shell.
  const child = how === 'wrapper'
    ? spawn(process.execPath, ['-e', `const c=require('node:child_process').spawn(process.execPath, ${JSON.stringify(lockArgs)}, {stdio:'ignore', cwd: ${JSON.stringify(REPO)}}); console.log(c.pid); setInterval(()=>{}, 1e9)`], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    : spawn(process.execPath, lockArgs, { cwd: REPO, env, stdio: 'ignore', windowsHide: true })
  const started = Date.now()
  let exitCode = null
  child.on('exit', code => { exitCode = code })
  step(`${id}: wait for the hang fixture to be ready`)
  await poll(() => existsSync(join(root, 'ready.txt')), { timeoutMs: 90_000, label: `${root}\\ready.txt` })
  await sleep(2000)
  const before = await listProcesses()
  const tree = [...descendantsOf(before.list, [child.pid])].map(pid => before.list.find(entry => entry.pid === pid))
  const appTree = tree.filter(isApp)
  const lockPid = how === 'wrapper' ? tree.find(entry => entry.commandLine.includes('smoke-lock.mjs'))?.pid : child.pid
  const control = appTree.length >= 3
  let killedAt = null
  if (how === 'wrapper') { spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' }); killedAt = Date.now() }
  if (how === 'lock') { spawnSync('taskkill', ['/PID', String(lockPid), '/F'], { stdio: 'ignore' }); killedAt = Date.now() }
  if (how === 'timeout') {
    step(`${id}: wait for the 1 min smoke-lock timeout`)
    await poll(() => exitCode !== null, { timeoutMs: 120_000, label: 'the inner smoke-lock to time out' })
    killedAt = Date.now()
  }
  step(`${id}: wait up to 30 s for the app tree to go`)
  const gone = await poll(async () => { const now = await listProcesses(); return sameProcesses(appTree, now.list).length === 0 ? now : null }, { timeoutMs: 30_000, intervalMs: 1000, label: 'the app tree to exit' }).catch(() => null)
  const after = gone ?? await listProcesses()
  const leftApp = sameProcesses(appTree, after.list)
  const leftOther = sameProcesses(tree.filter(entry => !isApp(entry)), after.list)
  const lockLeft = existsSync(join(root, 'tmp', 'conductor-smoke.lock'))
  const numbers = { how, appTree: appTree.length, tree: tree.length, lockExit: exitCode, runSeconds: Math.round((killedAt - started) / 1000), goneSeconds: gone ? Math.round((Date.now() - killedAt) / 1000) : null, leftApp: leftApp.map(entry => `${entry.name}:${entry.pid}`), leftOther: leftOther.map(entry => `${entry.name}:${entry.pid}`), innerLockLeft: lockLeft }
  // Tidy only what this run started: anything left (reported above) is killed by pid.
  for (const entry of [...leftApp, ...leftOther]) spawnSync('taskkill', ['/PID', String(entry.pid), '/F'], { stdio: 'ignore' })
  if (alive(child.pid)) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  const pass = control && leftApp.length === 0 && (how !== 'timeout' || (exitCode === 124 && !lockLeft))
  return { pass, control, numbers, root }
}

try {
  await loadCheck()
  const runs = soak || 2
  for (const [id, how] of [['L1', 'timeout'], ['L2a', 'wrapper'], ['L2b', 'lock']]) {
    let passed = 0
    const all = []
    for (let index = 0; index < runs; index++) {
      const result = await innerRun(`${id} run ${index + 1}`, how)
      all.push(result.numbers)
      if (result.pass) passed++
      if (!result.control) record(`${id}-control`, 'FAIL', result.numbers, `the detector found only ${result.numbers.appTree} app processes before the kill; ${result.root}`)
    }
    record(id, passed === runs ? 'PASS' : 'FAIL', { reproductions: `${passed}/${runs}`, runs: all }, 'control: >=3 app processes seen before each kill/timeout')
  }

  // L3: dialogs. A parked instance with a streaming turn.
  const inst = await launchParked({ mode: 'playwright', name: 'vr1-leak-l3', env: { CONDUCTOR_TEST_FIXTURE_DIR: join(REPO, 'scripts', 'fixtures'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'VR1 leak L3', git: true })
  const tab = await openTab({ provider: 'claude', title: 'Streaming turn' })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'SYNTHETIC STREAM 10 300' })
  await poll(async () => ['running', 'starting'].includes((await call('agents.status', { agentSessionId: tab.resourceId })).phase), { timeoutMs: 30_000, label: 'the turn to run' })
  const treeNow = async () => { const now = await listProcesses(); return new Set(descendantsOf(now.list, [...inst.pids])) }
  const dialogs = [], seen = new Set()
  let watching = true
  const watcher = (async () => { while (watching) { const pids = await treeNow().catch(() => new Set()); for (const row of await windowsOf(pids)) { seen.add(row.cls); if (row.cls === '#32770') dialogs.push(row) } await sleep(700) } })()
  step('L3a: uncaught main-process error')
  await inst.app.evaluate(() => { setTimeout(() => { throw new Error('VR1-L3 uncaught probe') }, 10) })
  await sleep(4000)
  const log = () => { try { return readFileSync(join(inst.profile, 'main-errors.log'), 'utf8') } catch { return '' } }
  const uncaughtLogged = log().includes('VR1-L3 uncaught probe')
  const aliveAfterError = alive(inst.credential.pid)
  step('L3b: quit with the turn running (the owner-screen dialog path)')
  const mainPid = inst.credential.pid
  const phaseAtQuit = (await call('agents.status', { agentSessionId: tab.resourceId })).phase
  await withDeadline(inst.app.evaluate(({ app }) => { app.quit() }), 5000)
  const exited = await poll(() => !alive(mainPid), { timeoutMs: 30_000, label: 'the app to exit after quit' }).then(() => true, () => false)
  await sleep(1500)
  watching = false
  await withDeadline(watcher, 35_000)
  const guarded = log().split('\n').filter(line => line.includes('[dialog] guarded'))
  const numbers = { dialogs: dialogs.length, windowClassesSeen: [...seen], uncaughtLogged, aliveAfterError, phaseAtQuit, exitedAfterQuit: exited, guarded }
  const control = seen.has('Chrome_WidgetWin_1')
  record('L3', dialogs.length === 0 && control && uncaughtLogged && aliveAfterError && exited && guarded.some(line => /Work is still running/.test(line)) ? 'PASS' : 'FAIL', numbers, `control: enumerator saw the parked window (${control}); log ${join(inst.root, 'profile', 'main-errors.log')}`)
  await safeClose(inst)
} catch (error) {
  await failed(error, 'vr1-leak')
}
await finish()
