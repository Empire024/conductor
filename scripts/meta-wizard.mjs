#!/usr/bin/env node
// The meta-wizard: the owner's supervisor above Conductor (docs/meta-wizard.md). It runs outside
// the app as a per-user scheduled task, keeps Conductor alive, resumes the tabs a restart cut,
// steers stalled waits and alerts the owner. It only restarts, resumes, steers and alerts: it never
// answers approval cards, never pushes or publishes, never touches another project's systems.
//
//   node scripts/meta-wizard.mjs install | uninstall | status [--json] | run | tick [--dry-run]
//   test knobs for run/tick: --user-data <dir> --interval-sec <n> --timings <json> --launch <json> --launch-env <json>
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { journalTail, readJsonFile } from './meta-wizard/journal.mjs'
import { checkoutOf, install, serviceDirFor, taskStatus, uninstall } from './meta-wizard/install.mjs'
import { installedUserData, pidAlive, readCredential, stateDir } from './meta-wizard/paths.mjs'
import { createService } from './meta-wizard/service.mjs'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = name => argv.includes(name)
const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined }
const json = (name, fallback) => { const raw = option(name); if (raw === undefined) return fallback; try { return JSON.parse(raw) } catch { throw new Error(`${name} is not valid JSON`) } }

const installed = installedUserData()
const userData = resolve(option('--user-data') ?? installed)
const testProfile = userData.toLowerCase() !== installed.toLowerCase()
const dir = stateDir(userData)
const self = fileURLToPath(import.meta.url)

function service() {
  const timings = { ...json('--timings', {}) }
  if (option('--interval-sec')) timings.tickMs = Number(option('--interval-sec')) * 1000
  return createService({ userData, timings, launch: json('--launch', null), launchEnv: json('--launch-env', {}), testProfile, echo: flag('--verbose') ? line => process.stdout.write(line + '\n') : undefined })
}

async function runLoop() {
  const lockPath = join(dir, 'service.json')
  const other = await readJsonFile(lockPath, null)
  if (other?.pid && other.pid !== process.pid && pidAlive(other.pid)) { console.log(`meta-wizard already running (pid ${other.pid})`); return 0 }
  await mkdir(dir, { recursive: true })
  const version = await readJsonFile(join(checkoutOf(self), 'VERSION.json'), null)
  const record = { pid: process.pid, startedAt: new Date().toISOString(), userData, script: self, commit: version?.commit ?? null, lastTickAt: null }
  await writeFile(lockPath, JSON.stringify(record, null, 2) + '\n')
  const supervisor = service()
  await supervisor.journal.write('service-start', { pid: process.pid, commit: record.commit, testProfile })
  let stopping = false
  const stop = async signal => {
    if (stopping) return
    stopping = true
    await supervisor.journal.write('service-stop', { pid: process.pid, signal })
    await supervisor.journal.flush()
    const current = await readJsonFile(lockPath, null)
    if (current?.pid === process.pid) await rm(lockPath, { force: true })
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
  while (!stopping) {
    let delay = supervisor.timings.tickMs
    try { delay = (await supervisor.tick()).delayMs ?? delay } catch (error) { await supervisor.journal.write('error', { during: 'tick', error: error?.stack ?? String(error) }) }
    record.lastTickAt = new Date().toISOString()
    await writeFile(lockPath, JSON.stringify(record, null, 2) + '\n').catch(() => {})
    await new Promise(done => setTimeout(done, delay))
  }
  return 0
}

async function status() {
  const lock = await readJsonFile(join(dir, 'service.json'), null)
  const state = await readJsonFile(join(dir, 'state.json'), {})
  const credential = await readCredential(userData)
  const report = {
    task: testProfile ? { note: 'test profile: no task' } : await taskStatus(),
    supervisor: lock ? { pid: lock.pid, running: pidAlive(lock.pid), startedAt: lock.startedAt, lastTickAt: lock.lastTickAt, commit: lock.commit } : { running: false },
    conductor: credential.ok ? { pid: credential.credential.pid, version: credential.credential.appVersion ?? null, answeredAt: state.lastTickAt ?? null } : { down: credential.reason },
    liveness: state.lastLiveness ?? null,
    working: (state.working ?? []).map(tab => `${tab.title} (${tab.agentSessionId}): ${tab.phase}`),
    pendingResume: state.pendingResume ? { pid: state.pendingResume.pid, dueAt: new Date(state.pendingResume.dueAt).toISOString(), tabs: state.pendingResume.snapshot.length } : null,
    openFindings: state.openFindings ?? [],
    journal: join(dir, 'journal.jsonl'),
    recent: await journalTail(dir, 15)
  }
  if (flag('--json')) { console.log(JSON.stringify(report, null, 2)); return 0 }
  const line = (label, value) => console.log(`${label.padEnd(14)} ${value}`)
  line('task', report.task.installed === false ? 'NOT INSTALLED (node scripts/meta-wizard.mjs install)' : report.task.note ?? `${report.task.status}; last run ${report.task.lastRun} (result ${report.task.lastResult}); next ${report.task.nextRun}`)
  line('supervisor', report.supervisor.running ? `running, pid ${report.supervisor.pid}, last tick ${report.supervisor.lastTickAt ?? 'none yet'}` : 'not running')
  line('conductor', credential.ok ? `pid ${report.conductor.pid} ${report.conductor.version ?? ''}` : `down: ${report.conductor.down}`)
  line('liveness', report.liveness ?? '-')
  line('working', report.working.length ? report.working.join('; ') : 'none')
  if (report.pendingResume) line('resume due', `${report.pendingResume.dueAt} (${report.pendingResume.tabs} tabs)`)
  line('findings', report.openFindings.length ? '' : 'none')
  for (const finding of report.openFindings) console.log(`  - ${finding.kind}: ${finding.target ?? ''}`)
  console.log(`journal        ${report.journal}`)
  for (const entry of report.recent) console.log(`  ${entry.at ?? ''} ${entry.event ?? ''} ${JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => !['at', 'event', 'prompt'].includes(key)))).slice(0, 220)}`)
  return 0
}

async function main() {
  if (command === 'run') return runLoop()
  if (command === 'tick') {
    const result = await service().tick({ dryRun: flag('--dry-run') })
    console.log(JSON.stringify({ decision: { action: result.decision.action, reason: result.decision.reason }, findings: (result.findings ?? []).map(f => ({ kind: f.kind, target: f.target?.title ?? null, fingerprint: f.fingerprint })), steers: (result.steers ?? []).map(s => ({ target: s.target.title, agentSessionId: s.target.agentSessionId, kind: s.kind, prompt: s.prompt })), alerts: result.alerts ?? [] }, null, 2))
    return 0
  }
  if (command === 'status') return status()
  if (command === 'install') {
    if (testProfile) throw new Error('install always serves the installed profile; drop --user-data')
    let commit = null
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutOf(self), encoding: 'utf8' }).trim() } catch { /* not a checkout */ }
    const result = await install({ checkout: checkoutOf(self), serviceDir: serviceDirFor(dir), userData, commit })
    console.log(`Installed and started scheduled task "${result.task}" for ${result.user}.\nService files: ${result.serviceDir}\nStatus: node scripts/meta-wizard.mjs status`)
    return 0
  }
  if (command === 'uninstall') { await uninstall(); console.log('Removed the scheduled task. The journal stays in ' + dir); return 0 }
  console.log('usage: node scripts/meta-wizard.mjs install | uninstall | status [--json] | run | tick [--dry-run]\n  test knobs: --user-data <dir> --interval-sec <n> --timings <json> --launch <json {exe,args,cwd}> --launch-env <json> --verbose')
  return command ? 2 : 0
}

// exitCode, not process.exit: exiting while fetch's sockets close trips a libuv assertion on Windows.
main().then(code => { process.exitCode = code }, error => { console.error(error?.stack ?? String(error)); process.exitCode = 1 })
