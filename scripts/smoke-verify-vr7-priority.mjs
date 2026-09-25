// VR7 T2 (typing-lag-under-test-load, FX28 de10b49 + 3329115). Owner: "actual typing still lags heavily ...
// i think it's when you're doing testing with conductor". The perf guard itself runs overnight; this checks
// the mechanism: a parked instance started from a NORMAL-priority parent lowers its whole tree itself
// (main, GPU, renderer, utility, runtime host, provider CLI), read from Win32_Process.Priority (6 below
// normal, 8 normal, 10 above normal).
// Control: the same launch with CONDUCTOR_BACKGROUND_PRIORITY=0 (the pre-fix state) must read main 8 and a
// gpu-process above 6, or the query cannot tell the two apart.
//   node scripts/smoke-lock.mjs --priority normal --timeout-min 20 -- node scripts/smoke-verify-vr7-priority.mjs
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { getPriority } from 'node:os'
import { join } from 'node:path'
import { call, configure, outputDir, descendantsOf, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, safeClose, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'vr7-priority', output: process.env.VR7_OUT ?? 'artifacts/verification/2026-09-26-vr7' })
watchdog(600)
// The driver stays at normal priority (the kit's lowerPriority() honours this), so nothing below
// normal is inherited: whatever the instance runs at, it chose itself.
process.env.CONDUCTOR_BACKGROUND_PRIORITY = '0'
await loadCheck()

/** Win32_Process rows with Priority, minus this query. */
async function processes() {
  const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,Priority | ConvertTo-Json -Compress'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const chunks = []
  query.stdout.on('data', chunk => chunks.push(chunk))
  const done = await withDeadline(new Promise(resolve => query.on('close', resolve)), 30_000)
  if (!done.ok) throw new Error('process query timed out')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')).map(row => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), commandLine: String(row.CommandLine ?? ''), priority: Number(row.Priority) })).filter(row => row.pid !== query.pid)
}
const role = entry => {
  const type = /--type=([\w-]+)/.exec(entry.commandLine)?.[1]
  if (type === 'gpu-process' || type === 'renderer' || type === 'utility' || type === 'crashpad-handler') return type
  if (/runtime-host/.test(entry.commandLine)) return 'runtime-host'
  // The fixture CLI runs as electron.exe-as-node under the host, so it is told apart by its script.
  if (/fake-claude|claude(\.exe|\.cmd)?\b/i.test(entry.commandLine) && !/--type=|index\.js/.test(entry.commandLine)) return 'provider-cli'
  if (/electron\.exe/i.test(entry.name) && !type) return 'main'
  return entry.name
}

async function leg(label, env) {
  step(`${label}: launch from a normal-priority driver (driver priority ${getPriority(0)})`)
  const inst = await launchParked({ mode: 'spawn', name: `vr7-priority-${label}`, env: { CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_SMOKE_STEP_MS: 120_000, CONDUCTOR_TEST_EMPTY_HISTORY: '1', ...env } })
  await openProject({ name: `VR7 priority ${label}` }, inst)
  const tab = (await openTab({ provider: 'claude', model: 'sonnet', title: 'priority probe' }, { inst })).resourceId
  const view = await page(inst)
  await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SYNTHETIC WATCH LOOPS a long step', state.settings, []) }, tab)
  await poll(async () => (await call('agents.status', { agentSessionId: tab }, { inst }))?.phase === 'running', { timeoutMs: 30_000, label: 'turn running' })
  // Past the first 30 s sweep, so a late utility process has been swept too.
  await sleep(35_000)
  const list = await processes()
  // The runtime host is detached (it outlives a crash), so it and its CLIs are found by the temp root too.
  const tree = [...descendantsOf(list, [...inst.pids, ...list.filter(entry => entry.commandLine.includes(inst.root)).map(entry => entry.pid)])].map(pid => list.find(entry => entry.pid === pid)).filter(Boolean)
  const rows = tree.map(entry => ({ pid: entry.pid, ppid: entry.ppid, role: role(entry), priority: entry.priority, command: entry.commandLine.slice(0, 160) }))
  const driver = list.find(entry => entry.pid === process.pid)?.priority
  writeFileSync(join(outputDir(), `vr7-priority-${label}.json`), JSON.stringify(rows, null, 2))
  await safeClose(inst)
  return { rows, driver }
}

try {
  const fixed = await leg('default', { CONDUCTOR_BACKGROUND_PRIORITY: undefined })
  const control = await leg('control', { CONDUCTOR_BACKGROUND_PRIORITY: '0' })
  const summary = rows => Object.fromEntries([...new Set(rows.map(row => row.role))].map(name => [name, [...new Set(rows.filter(row => row.role === name).map(row => row.priority))].join('/')]))
  const byRole = (rows, name) => rows.filter(row => row.role === name)
  const controlDiscriminates = control.driver === 8 && byRole(control.rows, 'main').every(row => row.priority === 8) && byRole(control.rows, 'gpu-process').some(row => row.priority > 6)
  record('T2-control-priority-0', controlDiscriminates ? 'PASS' : 'FAIL', { driver: control.driver, ...summary(control.rows) }, 'CONDUCTOR_BACKGROUND_PRIORITY=0 from a normal driver: main normal (8), gpu-process above 6 = the pre-fix state')
  const needed = ['main', 'gpu-process', 'renderer', 'runtime-host', 'provider-cli']
  const missing = needed.filter(name => !byRole(fixed.rows, name).length)
  const notLowered = fixed.rows.filter(row => row.priority > 6)
  record('T2-parked-tree-below-normal', fixed.driver === 8 && !missing.length && !notLowered.length && controlDiscriminates ? 'PASS' : 'FAIL', { driver: fixed.driver, ...summary(fixed.rows), processes: fixed.rows.length, missingRoles: missing, notLowered }, `every process of a parked instance started from a normal-priority driver, runtime host on and a provider turn running, read 35 s after the turn started: ${JSON.stringify(fixed.rows.map(({ command, ...row }) => row))}`)
} catch (error) { await failed(error, 'T2') }
await finish()
