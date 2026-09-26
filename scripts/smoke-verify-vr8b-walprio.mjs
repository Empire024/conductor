// VR8b A3 (docs/verification/2026-09-26-vr8b.md): FX33's WAL and priority parts.
//   node scripts/smoke-lock.mjs --priority normal --timeout-min 20 -- node scripts/smoke-verify-vr8b-walprio.mjs [--label fixed] [--wal-mb 600]
// A3a a parked profile whose conductor.db-wal was grown to ~600 MB (writer pinned, then killed) is
//     opened by the app and closed cleanly (WM_CLOSE): the -wal is <= 64 MiB afterwards, integrity_check
//     is ok, the ballast rows and the project are intact, and the next launch lists the project.
// A3b provider CLIs run below normal priority, spawned directly and by the runtime host, and so do the
//     tools they start, while the app itself stays at normal. The app is launched at normal
//     (CONDUCTOR_BACKGROUND_PRIORITY=0, driver raised to normal) so inheritance cannot fake a pass.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunchParked, step, watchdog } from './verify-kit.mjs'

process.env.CONDUCTOR_BACKGROUND_PRIORITY = '0'
try { setPriority(0, constants.priority.PRIORITY_NORMAL) } catch { /* recorded below */ }
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback }
const label = argument('--label', 'fixed'), walMb = Number(argument('--wal-mb', '600'))
configure({ name: `vr8b-walprio-${label}`, output: argument('--output', 'artifacts/verification/2026-09-26-vr8b') })
watchdog(18 * 60)
await loadCheck()

const FIXTURE = readFileSync(new URL('./fixtures/vr8b-claude.mjs', import.meta.url), 'utf8')
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const size = path => existsSync(path) ? statSync(path).size : null
const mb = bytes => bytes == null ? null : Math.round(bytes / 1048576 * 10) / 10
const sqlite = (db, script) => { const run = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(db)});${script}`], { encoding: 'utf8', timeout: 300_000 }); if (run.status !== 0 && !/KILLED/.test(run.stdout)) throw new Error(`sqlite helper: ${run.stderr.slice(0, 600)}`); return run.stdout.trim() }
const priorities = pids => { const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)=$($_.PriorityClass)" }`], { encoding: 'utf8', windowsHide: true }); return Object.fromEntries(run.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('=')).map(([pid, cls]) => [Number(pid), cls])) }
const gracefulQuit = async inst => {
  const pid = inst.credential.pid
  spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  const started = Date.now()
  await poll(() => !isAlive(pid), { timeoutMs: 90_000, intervalMs: 250, label: `pid ${pid} to quit on WM_CLOSE` })
  return Date.now() - started
}

try {
  const inst = await launchParked({ mode: 'spawn', name: `vr8b-walprio-${label}`, fixtures: { 'fake-claude.mjs': FIXTURE } })
  const fixtures = join(inst.root, 'fixtures'), db = join(inst.profile, 'conductor.db'), wal = `${db}-wal`
  await page(inst)
  const project = await openProject({ name: `VR8b wal ${label}`, git: true })

  step('A3b direct: a provider CLI and its tool started by the app itself')
  const probe = async (tabTitle, mode) => {
    const tab = (await openTab({ provider: 'claude', title: tabTitle })).resourceId
    await call('agents.submit', { agentSessionId: tab, prompt: `VR8B TOOL ${tabTitle} 25` })
    const tool = await poll(() => lines(join(fixtures, 'tools.jsonl')).find(entry => entry.name === tabTitle), { timeoutMs: 60_000, label: `the ${tabTitle} CLI to start its tool` })
    const found = priorities([inst.credential.pid, tool.pid, tool.toolPid])
    const main = found[inst.credential.pid], cli = found[tool.pid], child = found[tool.toolPid]
    record(`A3b-priority-${mode}`, main === 'Normal' && cli === 'BelowNormal' && child === 'BelowNormal' ? 'PASS' : 'FAIL', { main, cli, tool: child, driver: priorities([process.pid])[process.pid] }, JSON.stringify({ mainPid: inst.credential.pid, cliPid: tool.pid, toolPid: tool.toolPid }))
  }
  await probe('direct', 'direct')

  step('A3a grow the WAL of a closed profile')
  await gracefulQuit(inst)
  const grow = sqlite(db, `db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS vr8b_ballast(id INTEGER PRIMARY KEY, data BLOB)');const ins=db.prepare('INSERT INTO vr8b_ballast(data) VALUES (randomblob(1048576))');for(let i=0;i<${Math.ceil(walMb / 10)};i++){db.exec('BEGIN');for(let j=0;j<10;j++)ins.run();db.exec('COMMIT')}console.log('KILLED');process.kill(process.pid,'SIGKILL')`)
  const rows = Math.ceil(walMb / 10) * 10
  const walGrown = size(wal)

  step('A3a the app opens the grown log, then closes cleanly')
  const launchStarted = Date.now()
  await relaunchParked(inst, { env: { CONDUCTOR_RUNTIME_HOST: '1' } })
  const credentialMs = Date.now() - launchStarted
  await poll(() => call('projects.list', {}, { projectId: null }), { timeoutMs: 120_000, intervalMs: 1000, label: 'the app to answer after opening the grown log' })
  const answerMs = Date.now() - launchStarted
  await (await page(inst)).waitForTimeout(8000)
  const walRunning = size(wal)

  step('A3b hosted: a provider CLI and its tool started by the runtime host')
  await probe('hosted', 'hosted')
  await poll(async () => (await call('agents.list', {})).every(agent => !['running', 'starting'].includes(agent.phase)), { timeoutMs: 90_000, intervalMs: 2000, label: 'the probes to finish' })

  const quitMs = await gracefulQuit(inst)
  const walAfter = size(wal)
  const check = JSON.parse(sqlite(db, `console.log(JSON.stringify({integrity: db.prepare('PRAGMA integrity_check').all().map(r=>Object.values(r)[0]).join(','), ballast: db.prepare('SELECT count(*) AS n FROM vr8b_ballast').get().n, projects: db.prepare('SELECT count(*) AS n FROM projects').get().n}))`))
  await relaunchParked(inst)
  const listed = (await poll(() => call('projects.list', {}, { projectId: null }), { timeoutMs: 60_000, intervalMs: 1000, label: 'projects.list after the close' })).some(entry => entry.path === project.path || entry.name === `VR8b wal ${label}`)
  record('A3a-wal-small-after-clean-close', walGrown > walMb * 0.8 * 1048576 && walAfter !== null ? walAfter <= 64 * 1048576 && check.integrity === 'ok' && check.ballast === rows && check.projects >= 1 && listed ? 'PASS' : 'FAIL'
    : walAfter === null && check.integrity === 'ok' && check.ballast === rows && listed ? 'PASS' : 'FAIL',
    { walGrownMb: mb(walGrown), walRunningMb: mb(walRunning), walAfterCloseMb: mb(walAfter), quitMs, credentialMs, answerMs, integrity: check.integrity, ballastRows: check.ballast, expectedRows: rows, projectsRows: check.projects, relaunchListsProject: listed },
    `grow: ${grow}`)
} catch (error) { await failed(error, 'walprio') }
await finish()
