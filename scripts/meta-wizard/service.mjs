import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createToaster } from './alert.mjs'
import { controlCall } from './client.mjs'
import { detect, plan, resumeTargets, TIMINGS, workingSnapshot } from './detect.mjs'
import { createJournal, readJsonFile, writeJsonAtomic } from './journal.mjs'
import { decideLiveness } from './liveness.mjs'
import { defaultExe, pidAlive, readArmed, readCredential, stateDir } from './paths.mjs'

// The meta-wizard's effects (docs/meta-wizard.md): probe, start, kill, steer, alert, journal. Every
// decision is made in liveness.mjs and detect.mjs; everything that touches the world is injectable.

const run = promisify(execFile)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const KEEP_LAUNCH_LOGS = 10

/** Kills a Conductor process tree, only when the pid still names Conductor.exe or electron.exe. */
async function killConductor(pid) {
  if (process.platform !== 'win32') { process.kill(pid, 'SIGKILL'); return 'killed' }
  const { stdout } = await run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
  const image = /^"([^"]+)"/.exec(stdout.trim())?.[1] ?? ''
  if (!/^(conductor|electron)\.exe$/i.test(image)) return `not killed: pid ${pid} is ${image || 'gone'}`
  await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(error => { throw new Error(`taskkill ${pid}: ${error.stderr || error.message}`) })
  return `killed ${image} ${pid}`
}

export function createService({
  userData, timings: override = {}, launch = null, launchEnv = {}, testProfile = false, echo,
  deps = {}
}) {
  const timings = { ...TIMINGS, ...override }
  const dir = stateDir(userData)
  const now = deps.now ?? (() => Date.now())
  const journal = createJournal(dir, { now: () => new Date(now()), echo })
  const call = deps.controlCall ?? controlCall
  const toast = deps.toast ?? createToaster({ dir, testProfile })
  const kill = deps.kill ?? killConductor
  const spawnApp = deps.spawn ?? spawn
  const alive = deps.pidAlive ?? pidAlive
  const bootAt = deps.bootAt ?? (Date.now() - uptime() * 1000)
  const statePath = join(dir, 'state.json')
  let state = null

  async function load() { state ??= await readJsonFile(statePath, { version: 1 }); return state }
  async function save() { await mkdir(dir, { recursive: true }); await writeJsonAtomic(statePath, state) }

  async function probe(credential) {
    try { await call(credential, 'tools.list', { brief: true }, { timeoutMs: timings.probeTimeoutMs }); return 'ok' } catch (error) { return error?.code ?? 'error' }
  }

  async function alert(title, body, credential) {
    const toasted = await toast(title, body).catch(error => `toast failed: ${error.message}`)
    let phone = 'app not answering'
    if (credential) { try { phone = (await call(credential, 'supervisor.alert', { title, body }, { timeoutMs: 20_000 }))?.delivered ?? 'sent' } catch (error) { phone = `phone alert failed: ${error.message}` } }
    await journal.write('alert', { title, body, toast: toasted, phone })
  }

  /** Starts Conductor and waits for a new pid that answers app control. */
  async function start(reason, oldPid) {
    const armed = await readArmed(userData)
    const spec = launch ?? armed?.launch ?? { exe: defaultExe(), args: [] }
    await mkdir(dir, { recursive: true })
    const logs = (await readdir(dir)).filter(name => /^launch-.*\.log$/.test(name)).sort()
    for (const name of logs.slice(0, Math.max(0, logs.length - KEEP_LAUNCH_LOGS + 1))) await rm(join(dir, name), { force: true })
    const logPath = join(dir, `launch-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.log`)
    const env = { ...process.env, ...launchEnv }
    delete env.ELECTRON_RUN_AS_NODE
    let child, exited = null
    const fd = openSync(logPath, 'a')
    try {
      child = spawnApp(spec.exe, spec.args ?? [], { cwd: spec.cwd, env, detached: true, stdio: ['ignore', fd, fd] })
      child.on?.('error', error => { exited = `spawn failed: ${error.message}` })
      child.on?.('exit', code => { exited ??= `exited with code ${code}` })
      child.unref?.()
    } catch (error) { exited = `spawn failed: ${error.message}` } finally { closeSync(fd) }
    await journal.write('start', { reason, exe: spec.exe, args: spec.args ?? [], pid: child?.pid ?? null, log: logPath })
    const deadline = now() + timings.startWaitMs
    while (now() < deadline) {
      await (deps.sleep ?? sleep)(2000)
      const credential = await readCredential(userData, { isAlive: alive })
      if (credential.ok && credential.credential.pid !== oldPid && await probe(credential.credential) === 'ok') {
        await journal.write('started', { pid: credential.credential.pid, reason })
        return { ok: true, credential: credential.credential }
      }
      // A second Conductor exits at once when another one holds the single-instance lock; keep
      // waiting for the credential anyway, since that other one may be the one coming up.
    }
    return { ok: false, detail: exited ?? `no Conductor answered app control within ${Math.round(timings.startWaitMs / 1000)} s`, log: logPath }
  }

  /** The overview; an app older than supervisor.overview gets a thinner one from agents.list. */
  async function overview(credential) {
    try { return await call(credential, 'supervisor.overview', {}, { timeoutMs: 30_000 }) } catch (error) {
      if (error?.code !== 'method' || !/supervisor\.overview|unknown method|not a method/i.test(error.message)) throw error
    }
    const [rows, app] = await Promise.all([call(credential, 'agents.list', { load: true }, { timeoutMs: 30_000 }), call(credential, 'app.state', {}, { timeoutMs: 30_000 }).catch(() => null)])
    return {
      partial: true, observedAt: new Date(now()).toISOString(), pid: credential.pid, updates: app?.updates ?? null, localBuild: null,
      tabs: (Array.isArray(rows) ? rows : rows?.agents ?? []).map(row => ({ agentSessionId: row.agentSessionId, tabId: row.tabId, title: row.title, projectId: row.projectId, project: '', workspaceId: row.workspaceId, provider: row.provider ?? null, phase: row.phase, backgroundTasks: row.backgroundTasks ?? 0, wizard: false, controller: null, awaiting: null, lastTool: null, lastAnswer: null, lastError: null, lastActivityAt: null, limitResumeAt: null, pending: { owner: 0, reviewer: 0 } }))
    }
  }

  async function supervise(credential, { dryRun }) {
    const at = now()
    if (state.lastPid && state.lastPid !== credential.pid) {
      const reason = state.pendingStartReason ?? 'restarted outside the meta-wizard (an update, the owner or the recovery watchdog)'
      const startedAt = credential.startedAt ?? new Date(at).toISOString()
      // A snapshot older than a day is history, not work to resume.
      const snapshot = at - (state.workingAt ?? 0) < 86_400_000 ? state.working ?? [] : []
      state.pendingResume = { pid: credential.pid, startedAt, reason, dueAt: Math.max(at, Date.parse(startedAt) || at) + timings.resumeDelayMs, snapshot }
      await journal.write('restart-seen', { from: state.lastPid, to: credential.pid, reason, cut: snapshot.map(tab => tab.agentSessionId) })
    }
    state.pendingStartReason = null
    state.lastPid = credential.pid
    const view = await overview(credential)
    const found = []
    if (state.pendingResume && at >= state.pendingResume.dueAt) {
      found.push(...resumeTargets(state.pendingResume.snapshot, view, state.pendingResume))
      if (!dryRun) state.pendingResume = null
    }
    const judged = detect(view, state.detectMemory ?? {}, at, timings)
    found.push(...judged.findings)
    const planned = plan(found, state.ledger ?? {}, at, timings)
    for (const steer of planned.steers) {
      const target = steer.target
      const entry = { agentSessionId: target.agentSessionId, title: target.title, project: target.project, kind: steer.kind, fingerprints: steer.fingerprints, prompt: steer.prompt }
      if (dryRun) { await journal.write('planned-steer', entry); continue }
      try {
        const result = await call(credential, 'agents.steer', { agentSessionId: target.agentSessionId, prompt: steer.prompt }, { scope: { projectId: target.projectId, workspaceId: target.workspaceId }, timeoutMs: 60_000 })
        await journal.write('steer', { ...entry, delivery: result?.delivery ?? null })
      } catch (error) { await journal.write('steer-failed', { ...entry, error: error.message }) }
    }
    for (const item of planned.alerts) dryRun ? await journal.write('planned-alert', item) : await alert(item.title, item.body, credential)
    const open = judged.findings.map(finding => ({ kind: finding.kind, fingerprint: finding.fingerprint, target: finding.target ? `${finding.target.title} (${finding.target.agentSessionId})` : null }))
    const signature = open.map(finding => finding.fingerprint).sort().join('\n')
    if (signature !== (state.openSignature ?? '')) await journal.write('findings', { open, partial: Boolean(view.partial) })
    if (!dryRun) {
      state.detectMemory = judged.memory
      state.ledger = planned.ledger
      state.openFindings = open
      state.openSignature = signature
      if (!state.pendingResume) { state.working = workingSnapshot(view); state.workingAt = at }
      state.workInProgress = (state.working?.length ?? 0) > 0 || view.tabs.some(tab => tab.awaiting)
      state.app = { pid: credential.pid, version: view.version ?? credential.appVersion ?? null, observedAt: view.observedAt, tabs: view.tabs.length, partial: Boolean(view.partial) }
    }
    return { steers: planned.steers, alerts: planned.alerts, findings: judged.findings }
  }

  /** One pass. Returns how long to wait before the next one. */
  async function tick({ dryRun = false } = {}) {
    await load()
    const credential = await readCredential(userData, { isAlive: alive })
    const probed = credential.ok ? await probe(credential.credential) : null
    const armed = await readArmed(userData)
    const decision = decideLiveness({ now: now(), credential, probe: probed, armed, armedAppAlive: Boolean(armed?.appPid && alive(armed.appPid)), bootAt, memory: { ...(state.liveness ?? {}), workInProgress: state.workInProgress }, timings })
    if (!dryRun) state.liveness = decision.memory
    const said = `${decision.action}: ${decision.reason}`
    if (decision.action !== 'ok' && said !== state.lastLiveness) await journal.write('liveness', { action: decision.action, reason: decision.reason })
    if (decision.action === 'ok' && state.lastLiveness && !state.lastLiveness.startsWith('ok')) await journal.write('liveness', { action: 'ok', reason: decision.reason })
    if (!dryRun) state.lastLiveness = said
    let result = { decision, delayMs: timings.tickMs }
    try {
      if (decision.action === 'ok') result = { ...result, ...await supervise(credential.credential, { dryRun }) }
      else if (decision.action === 'recheck') result.delayMs = timings.recheckMs
      else if (decision.action === 'wait') result.delayMs = Math.min(timings.tickMs, decision.soon ? timings.recheckMs : 30_000)
      else if (decision.action === 'stand-down') { if (decision.alert && !dryRun) await alert('Conductor keeps crashing', `The meta-wizard started Conductor ${decision.memory.restarts.length} times in ${Math.round(timings.restartWindowMs / 60_000)} minutes and is standing down for ${Math.round(timings.standDownMs / 60_000)}. ${decision.reason}`, null) }
      else if (decision.action === 'start' || decision.action === 'kill-and-start') {
        if (dryRun) await journal.write('planned-start', { action: decision.action, reason: decision.reason })
        else {
          const oldPid = credential.credential?.pid ?? armed?.appPid ?? null
          if (decision.action === 'kill-and-start' && oldPid) await journal.write('kill', { pid: oldPid, result: await kill(oldPid).catch(error => error.message) })
          state.liveness.restarts = [...state.liveness.restarts, now()]
          state.pendingStartReason = decision.reason
          state.lastPid = oldPid ?? -1
          await save()
          const started = await start(decision.reason, oldPid)
          if (started.ok) await alert('Conductor was brought back', `${decision.reason}. The meta-wizard started it again (pid ${started.credential.pid}) and resumes the tabs it cut.`, started.credential)
          else await alert('Conductor is down', `${decision.reason}. The meta-wizard could not bring it back: ${started.detail}. Log: ${started.log}`, null)
          result.delayMs = timings.recheckMs
        }
      }
    } catch (error) {
      await journal.write('error', { during: decision.action, error: error?.message ?? String(error) })
      result.delayMs = timings.recheckMs
    }
    if (!dryRun) { state.lastTickAt = new Date(now()).toISOString(); await save() }
    await journal.flush()
    return result
  }

  return { tick, journal, dir, timings, load: () => load(), state: () => state }
}
