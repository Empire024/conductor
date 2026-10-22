import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createToaster } from './alert.mjs'
import { controlCall } from './client.mjs'
import { detect, plan, resumeTargets, TIMINGS, workingSnapshot } from './detect.mjs'
import { chooseRung, ESCALATION_TIMINGS, incidentAnswered, incidentDown, nextStepText, openIncident, recordFailure, recordRung, repairActive, repairId, watchdogHold } from './escalation.mjs'
import { createJournal, readJsonFile, writeJsonAtomic } from './journal.mjs'
import { decideLiveness } from './liveness.mjs'
import { defaultExe, pidAlive, readArmed, readCredential, stateDir } from './paths.mjs'
import { feedDirectory, gatherEvidence, hasOwnerScaleCheck, headOf, readActive, readCatalog, readResult, repairAgentCommand, repairPrompt, repairRoot, reportExcerpt, rollbackCommand, runInstaller, startRepairRunner, takenIds } from './repair.mjs'

// The meta-wizard's effects (docs/meta-wizard.md): probe, start, kill, steer, alert, journal, and the
// repair ladder's restart, rollback and repair (docs/startup-diagnostics.md). Every decision is made
// in liveness.mjs, detect.mjs and escalation.mjs; everything that touches the world is injectable.

const run = promisify(execFile)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const KEEP_LAUNCH_LOGS = 10
// Exit codes a V8 fatal (out of memory) ends the process with on Windows.
const V8_FATAL_EXIT = new Set([3758096392, 4294930435, -2147483645, 134])

/** CPU seconds the process has used, or null. Busy-versus-hung is read from it rising. */
async function cpuSeconds(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalSeconds`], { windowsHide: true, timeout: 15_000 })
    const value = Number(String(stdout).trim().replace(',', '.'))
    return Number.isFinite(value) ? value : null
  } catch { return null }
}

/** Kills a Conductor process tree, only when the pid still names Conductor.exe or electron.exe. */
async function killConductor(pid) {
  if (process.platform !== 'win32') { process.kill(pid, 'SIGKILL'); return 'killed' }
  const { stdout } = await run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
  const image = /^"([^"]+)"/.exec(stdout.trim())?.[1] ?? ''
  if (!/^(conductor|electron)\.exe$/i.test(image)) return `not killed: pid ${pid} is ${image || 'gone'}`
  await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(error => { throw new Error(`taskkill ${pid}: ${error.stderr || error.message}`) })
  return `killed ${image} ${pid}`
}

/** When boot.mjs cannot say: the exit code and the launch log are all there is. */
export function fallbackVerdict({ pid = null, exitCode = null, log = '' } = {}, why = '') {
  const oom = V8_FATAL_EXIT.has(exitCode) || /heap out of memory|OOM error in V8/i.test(log ?? '')
  const cause = oom ? 'oom' : exitCode === null || exitCode === undefined ? 'crash' : 'exit'
  const detail = oom ? `V8 heap out of memory${exitCode !== null && exitCode !== undefined ? ` (exit code ${exitCode})` : ''}` : exitCode === null || exitCode === undefined ? 'no exit code' : `exit code ${exitCode}`
  return { state: 'unknown', stage: null, cause, signature: `unknown:-:${cause}`, line: `died before boot diagnostics could say where: ${detail}${why ? ` (${why})` : ''}`, version: null, pid }
}

/** readBootVerdict from boot.mjs (part 1), loaded lazily so the supervisor runs without it. */
async function readVerdict(userData, options) {
  let module
  try { module = await import('./boot.mjs') } catch { return fallbackVerdict(options, 'boot.mjs is missing') }
  try { return await module.readBootVerdict(userData, options) } catch (error) { return fallbackVerdict(options, `boot verdict failed: ${error?.message ?? error}`) }
}

async function logTail(path, max = 6000) {
  try { const text = await readFile(path, 'utf8'); return text.slice(-max) } catch { return '' }
}

export function createService({
  userData, timings: override = {}, launch = null, launchEnv = {}, testProfile = false, echo, checkout = null,
  deps = {}
}) {
  const timings = { ...TIMINGS, ...ESCALATION_TIMINGS, ...override }
  const dir = stateDir(userData)
  const now = deps.now ?? (() => Date.now())
  const journal = createJournal(dir, { now: () => new Date(now()), echo })
  const call = deps.controlCall ?? controlCall
  const toast = deps.toast ?? createToaster({ dir, testProfile })
  const kill = deps.kill ?? killConductor
  const spawnApp = deps.spawn ?? spawn
  const alive = deps.pidAlive ?? pidAlive
  const cpuOf = deps.cpuSeconds ?? cpuSeconds
  const env = deps.env ?? process.env
  const bootVerdict = deps.readBootVerdict ?? readVerdict
  const catalogOf = deps.readCatalog ?? readCatalog
  const installer = deps.runInstaller ?? runInstaller
  const startRunner = deps.startRepair ?? startRepairRunner
  const bootAt = deps.bootAt ?? (Date.now() - uptime() * 1000)
  const statePath = join(dir, 'state.json')
  let state = null

  async function load() { state ??= await readJsonFile(statePath, { version: 1 }); return state }
  async function save() { await mkdir(dir, { recursive: true }); await writeJsonAtomic(statePath, state) }

  async function probe(credential) {
    try { await call(credential, 'tools.list', { brief: true }, { timeoutMs: timings.probeTimeoutMs }); return 'ok' } catch (error) { return error?.code ?? 'error' }
  }

  /** An owner alert: a toast, and a phone push that opens `agentSessionId` (the conversation it
   *  is about) when tapped. A Conductor older than that argument refuses the key, and then the
   *  push goes without it rather than not at all. */
  async function alert(title, body, credential, agentSessionId = null) {
    const toasted = await toast(title, body).catch(error => `toast failed: ${error.message}`)
    let phone = 'app not answering'
    if (credential) {
      const push = args => call(credential, 'supervisor.alert', args, { timeoutMs: 20_000 })
      try {
        let result
        try { result = await push({ title, body, ...(agentSessionId ? { agentSessionId } : {}) }) }
        catch (error) {
          if (!agentSessionId || !/agentSessionId/.test(error?.message ?? '')) throw error
          result = await push({ title, body })
        }
        phone = result?.delivered ?? 'sent'
      } catch (error) { phone = `phone alert failed: ${error.message}` }
    }
    await journal.write('alert', { title, body, ...(agentSessionId ? { agentSessionId } : {}), toast: toasted, phone })
  }

  /** Starts Conductor and waits for a new pid that answers app control. */
  async function start(reason, oldPid) {
    const armed = await readArmed(userData)
    const spec = launch ?? armed?.launch ?? { exe: defaultExe(), args: [] }
    await mkdir(dir, { recursive: true })
    const logs = (await readdir(dir)).filter(name => /^launch-.*\.log$/.test(name)).sort()
    for (const name of logs.slice(0, Math.max(0, logs.length - KEEP_LAUNCH_LOGS + 1))) await rm(join(dir, name), { force: true })
    const logPath = join(dir, `launch-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.log`)
    const childEnv = { ...process.env, ...launchEnv }
    delete childEnv.ELECTRON_RUN_AS_NODE
    let child, exited = null, exitCode = null, exitedAt = null
    const fd = openSync(logPath, 'a')
    try {
      child = spawnApp(spec.exe, spec.args ?? [], { cwd: spec.cwd, env: childEnv, detached: true, stdio: ['ignore', fd, fd] })
      child.on?.('error', error => { exited = `spawn failed: ${error.message}`; exitedAt ??= now() })
      child.on?.('exit', code => { exited ??= `exited with code ${code}`; exitCode = code; exitedAt ??= now() })
      child.unref?.()
    } catch (error) { exited = `spawn failed: ${error.message}`; exitedAt = now() } finally { closeSync(fd) }
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
      // waiting for the credential a while anyway, since that other one may be the one coming up.
      // A launch that died with nothing else coming up is given up on after exitSettleMs.
      if (exitedAt !== null && now() - exitedAt >= timings.exitSettleMs && !credential.ok) break
    }
    return { ok: false, detail: exited ?? `no Conductor answered app control within ${Math.round(timings.startWaitMs / 1000)} s`, log: logPath, pid: child?.pid ?? null, exitCode }
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

  /** After a repair, once Conductor answers: the wizard tabs are told once what was done. */
  async function announceRepair(credential, view) {
    const repair = state.repair
    if (!repair || repair.phase !== 'settled' || repair.announced || now() - (repair.finishedAt ?? 0) > timings.repairWindowMs) return
    const result = repair.result ?? {}
    const commits = (result.commits ?? []).map(commit => `- ${commit.sha.slice(0, 10)} ${commit.subject}`).join('\n')
    const lastFailure = (state.incident?.failures ?? []).at(-1)?.line ?? repair.reason
    const prompt = [
      `[Meta-wizard] Conductor did not start (${lastFailure}) and the meta-wizard ran repair agent ${repair.id}: ${repair.outcome === 'repaired' ? 'Conductor answers again' : 'it did not bring Conductor back by itself'}${result.error ? ` (${result.error})` : ''}.`,
      `Report: ${result.report ?? join(repair.dir, 'report.md')}`,
      `Branch ${repair.branch} in ${repair.worktree}${commits ? `, commits:\n${commits}` : ', no commits'}`,
      'Review the fix and ship it to main with git.ship (or discard the branch), then tell the owner what happened.'
    ].join('\n')
    const wizards = view.tabs.filter(tab => tab.wizard && !tab.successor)
    const steered = []
    for (const tab of wizards) {
      try {
        const sent = await call(credential, 'agents.steer', { agentSessionId: tab.agentSessionId, prompt }, { scope: { projectId: tab.projectId, workspaceId: tab.workspaceId }, timeoutMs: 60_000 })
        steered.push({ agentSessionId: tab.agentSessionId, delivery: sent?.delivery ?? null })
      } catch (error) { steered.push({ agentSessionId: tab.agentSessionId, error: error.message }) }
    }
    repair.announced = { at: now(), wizards: steered.map(entry => entry.agentSessionId) }
    await journal.write('repair-announced', { id: repair.id, outcome: repair.outcome, steered, prompt })
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
    if (!dryRun) await announceRepair(credential, view).catch(error => journal.write('error', { during: 'repair-announce', error: error?.message ?? String(error) }))
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
    for (const item of planned.alerts) dryRun ? await journal.write('planned-alert', item) : await alert(item.title, item.body, credential, item.agentSessionId ?? null)
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

  /** Rewrites the arm record of the Conductor being replaced as a restart by the meta-wizard. */
  async function recordRestart(armed, oldPid, decision) {
    if (!armed?.launch || !oldPid || armed.appPid !== oldPid) return
    const record = { ...armed, kind: 'restart', at: new Date(now()).toISOString(), foreground: false, by: 'meta-wizard', action: decision.action, reason: decision.reason }
    try {
      await writeJsonAtomic(join(userData, 'recovery', 'armed.json'), record)
      await journal.write('armed', { pid: oldPid, kind: 'restart', action: decision.action })
    } catch (error) { await journal.write('error', { during: 'arm', error: error?.message ?? String(error) }) }
  }

  // ---- The repair ladder (docs/startup-diagnostics.md, part 2) ----

  /** Where a repair worktree may be made: --checkout, else (installed profile only) the checkout the app recorded. */
  function checkoutFor(armed) {
    const candidate = checkout ?? (testProfile ? null : armed?.checkout ?? null)
    return candidate && existsSync(candidate) ? candidate : null
  }

  /** The repair's progress: settles a finished one (alert, incident) and says whether it still owns the app. */
  async function repairTick(answering, credential) {
    const active = await readActive(dir).catch(() => null)
    const activeNow = repairActive({ active, alive: Boolean(active?.pid && alive(active.pid)), now: now(), timings })
    const repair = state.repair
    if (!repair || repair.phase === 'settled') return { busy: activeNow }
    if (repair.phase === 'running') {
      if (activeNow) return { busy: true }
      repair.phase = 'finished'
      repair.finishedAt = now()
      repair.result = await readResult(repair.dir)
      await journal.write('repair-finished', { id: repair.id, exitCode: repair.result?.exitCode ?? null, timedOut: repair.result?.timedOut ?? null, error: repair.result?.error ?? (repair.result ? null : 'no result.json'), commits: (repair.result?.commits ?? []).length, report: repair.result?.report ?? null })
    }
    if (!answering && now() - repair.finishedAt < timings.repairAnswerGraceMs) return { busy: true }
    repair.phase = 'settled'
    repair.outcome = answering ? 'repaired' : 'failed'
    repair.answeredPid = answering ? credential.pid : null
    if (repair.result) await writeJsonAtomic(join(repair.dir, 'result.json'), { ...repair.result, conductorAnswered: repair.answeredPid }).catch(() => {})
    if (state.incident) state.incident = { ...state.incident, repairs: [...(state.incident.repairs ?? []), { id: repair.id, startedAt: repair.startedAt, finishedAt: repair.finishedAt, outcome: repair.outcome }] }
    const result = repair.result ?? {}
    const report = result.report ?? join(repair.dir, 'report.md')
    const branchLine = `Branch ${repair.branch} (${(result.commits ?? []).length} commits) in ${repair.worktree}. Report: ${report}`
    await journal.write('repair-outcome', { id: repair.id, outcome: repair.outcome, pid: repair.answeredPid })
    if (answering) await alert('Conductor repaired', `Repaired: Conductor answers again (pid ${credential.pid}) after repair ${repair.id}. ${branchLine}. The wizard tabs are asked to review and ship it.`, credential)
    else await alert('Conductor repair failed', `Repair failed: Conductor did not answer within ${Math.round(timings.repairAnswerGraceMs / 1000)} s after repair ${repair.id} ended${result.error ? ` (${result.error})` : ''}. ${branchLine}. ${reportExcerpt(report, 300)}`, null)
    return { busy: false }
  }

  /** The ladder's next rung, with the restore points and the repair history read fresh. */
  async function ladder(trigger, armed) {
    let catalog = null, installerExists = () => false
    try { ({ catalog, installerExists } = await catalogOf(userData)) } catch (error) { await journal.write('error', { during: 'restore-points', error: error?.message ?? String(error) }) }
    const failingVersion = (state.incident?.failures ?? []).at(-1)?.version ?? state.app?.version ?? armed?.fromVersion ?? null
    return chooseRung({ incident: state.incident, trigger, catalog, failingVersion, installerExists, repair: { active: false, history: state.repairs ?? [] }, now: now(), timings })
  }

  /** Starts the repair runner. Returns false when it cannot (no checkout, or the runner failed to start). */
  async function beginRepair(reason, armed) {
    const at = now()
    state.incident = openIncident(state.incident, { now: at })
    const repo = checkoutFor(armed)
    if (!repo) {
      state.incident = recordRung(state.incident, { rung: 'repair', now: at, detail: 'not started: no Conductor checkout known' })
      if (!state.incident.repairBlockedAlerted) {
        state.incident.repairBlockedAlerted = true
        await alert('Conductor repair not possible', `${reason}. The meta-wizard would start a repair agent, but it knows no Conductor checkout to repair in; restarting under the crash-loop guard instead.`, null)
      }
      return false
    }
    try {
      const id = repairId(at, await takenIds(dir, repo))
      const branch = `repair/${id}`
      const worktree = resolve(repo, '..', 'conductor-repairs', id)
      const agent = repairAgentCommand({ env, testProfile, userData })
      const evidence = await gatherEvidence({ userData, stateDirectory: dir })
      const exe = (launch ?? armed?.launch)?.exe ?? defaultExe()
      const base = await headOf(repo)
      const repairDir = join(repairRoot(dir), id)
      const prompt = repairPrompt({ incident: state.incident, reason, ...evidence, paths: { userData, checkout: repo, worktree, branch, base, exe, feed: feedDirectory(userData), report: join(repairDir, 'report.md') }, now: at, timeoutMinutes: Math.round(timings.repairTimeoutMs / 60_000), ownerScaleCheck: hasOwnerScaleCheck(repo) })
      const started = await startRunner({ stateDirectory: dir, id, prompt, now: at, request: { userData, checkout: repo, worktree, branch, command: agent.command, noAgentReason: agent.reason, timeoutMs: timings.repairTimeoutMs } })
      state.repair = { id, phase: 'running', startedAt: at, dir: started.dir ?? repairDir, pid: started.pid, branch, worktree, reason }
      state.repairs = [...(state.repairs ?? []), { id, startedAt: at }].slice(-10)
      state.incident = recordRung(state.incident, { rung: 'repair', now: at, detail: `${id}: ${reason}` })
      await journal.write('repair-start', { id, pid: started.pid, branch, worktree, agent: agent.command?.[0] ?? null, noAgent: agent.command ? null : agent.reason, reason })
      await alert('Conductor: repair agent started', `${reason}. Repair agent started: ${id} works in ${worktree} (branch ${branch}); log ${join(started.dir ?? repairDir, 'runner.log')}. The meta-wizard starts and kills nothing until it finishes (at most ${Math.round(timings.repairTimeoutMs / 60_000)} minutes).${agent.command ? '' : ` No agent runs: ${agent.reason}.`}`, null)
      return true
    } catch (error) {
      await journal.write('error', { during: 'repair-start', error: error?.message ?? String(error) })
      state.incident = recordRung(state.incident, { rung: 'repair', now: at, detail: `failed to start: ${error?.message ?? error}` })
      return false
    }
  }

  /** Runs a restore point's installer silently. The ladder moves on whether it worked or not. */
  async function rollback(point, reason) {
    const feed = feedDirectory(userData)
    const argv = rollbackCommand({ env, testProfile, installer: join(feed, point.installer) })
    state.incident = { ...openIncident(state.incident, { now: now() }), rolledBack: point.version }
    await alert('Conductor: rolling back', `${reason}. Rolling back to ${point.version}${point.commit ? ` (${String(point.commit).slice(0, 10)})` : ''}: installing ${point.installer} silently, then starting Conductor.`, null)
    const installed = argv ? await installer(argv, { timeoutMs: timings.rollbackTimeoutMs, env }) : { ok: false, exitCode: null, detail: 'no rollback command in this test profile (CONDUCTOR_META_ROLLBACK_COMMAND, a JSON argv array)' }
    state.incident = recordRung(state.incident, { rung: 'rollback', now: now(), detail: `${point.version}: ${installed.detail}` })
    await journal.write('rollback', { version: point.version, installer: point.installer, command: argv?.[0] ?? null, ok: installed.ok, exitCode: installed.exitCode, detail: installed.detail })
    return installed
  }

  /** A start of ours that answered and then died inside the incident counts as that rung failing. */
  async function noteCrashOfOurStart(oldPid) {
    const incident = state.incident
    if (!incident?.lastStartedPid || incident.lastStartedPid !== oldPid) return
    const verdict = await bootVerdict(userData, { pid: oldPid, alive: false, exitCode: null, log: '', now: now() })
    state.incident = recordFailure({ ...incident, lastStartedPid: null }, { verdict, rung: incident.lastStartedRung ?? 'restart', now: now(), pid: oldPid })
    await journal.write('incident-failure', { pid: oldPid, line: verdict.line, signature: verdict.signature, after: 'answered, then died' })
  }

  /** Liveness wants Conductor started: the ladder picks restart, rollback or repair. */
  async function climb(decision, credential, armed, result) {
    const oldPid = credential.credential?.pid ?? armed?.appPid ?? null
    await noteCrashOfOurStart(oldPid)
    const rung = await ladder('start', armed)
    if (rung.rung === 'repair') {
      if (decision.action === 'kill-and-start' && oldPid) await journal.write('kill', { pid: oldPid, result: await kill(oldPid).catch(error => error.message) })
      if (await beginRepair(rung.reason, armed)) { result.delayMs = Math.min(timings.tickMs, 30_000); return }
    }
    // Told to the recovery watchdog first (armed.json, docs/recovery-mode.md): the pid it
    // watches is going away as a restart, not a crash, so it waits for the Conductor started
    // here instead of relaunching its own next to it.
    await recordRestart(armed, oldPid, decision)
    if (decision.action === 'kill-and-start' && oldPid && rung.rung !== 'repair') await journal.write('kill', { pid: oldPid, result: await kill(oldPid).catch(error => error.message) })
    state.liveness.restarts = [...state.liveness.restarts, now()]
    state.pendingStartReason = decision.reason
    state.lastPid = oldPid ?? -1
    await save()
    const taken = rung.rung === 'rollback' ? 'rollback' : 'restart'
    if (rung.rung === 'rollback') await rollback(rung.point, rung.reason)
    else if (state.incident) state.incident = recordRung(state.incident, { rung: 'restart', now: now(), detail: rung.rung === 'restart' ? `${rung.attempt} of ${rung.of}` : rung.reason })
    const started = await start(decision.reason, oldPid)
    if (started.ok) {
      if (state.incident) state.incident = { ...state.incident, lastStartedPid: started.credential.pid, lastStartedRung: taken }
      await alert('Conductor was brought back', `${decision.reason}. The meta-wizard started it again (pid ${started.credential.pid}${state.incident ? `, ${taken === 'rollback' ? `rolled back to ${state.incident.rolledBack}` : 'restart'}` : ''}) and resumes the tabs it cut.`, started.credential)
    } else {
      const verdict = await bootVerdict(userData, { pid: started.pid, alive: false, exitCode: started.exitCode ?? null, log: await logTail(started.log), now: now() })
      state.incident = recordFailure(state.incident, { verdict, rung: taken, now: now(), pid: started.pid })
      await journal.write('incident-failure', { pid: started.pid, rung: taken, line: verdict.line, signature: verdict.signature, version: verdict.version ?? null, detail: started.detail })
      const next = await ladder('start', armed)
      await alert('Conductor did not start', `Conductor did not start: ${verdict.line}. ${nextStepText(next)}. Log: ${started.log}`, null)
    }
    result.delayMs = timings.recheckMs
  }

  /** One pass. Returns how long to wait before the next one. */
  async function tick({ dryRun = false } = {}) {
    await load()
    const credential = await readCredential(userData, { isAlive: alive })
    const probed = credential.ok ? await probe(credential.credential) : null
    const armed = await readArmed(userData)
    const armedAppAlive = Boolean(armed?.appPid && alive(armed.appPid))
    // Only sampled when something is silent: a busy main process is told apart from a hung one.
    const silentPid = credential.ok && probed !== 'ok' ? credential.credential.pid : !credential.ok && armed?.kind === 'running' && armedAppAlive ? armed.appPid : null
    const cpu = silentPid ? await cpuOf(silentPid).catch(() => null) : null
    const decision = decideLiveness({ now: now(), credential, probe: probed, armed, armedAppAlive, cpu, bootAt, memory: { ...(state.liveness ?? {}), workInProgress: state.workInProgress }, timings })
    if (!dryRun) state.liveness = decision.memory
    const said = `${decision.action}: ${decision.reason}`
    if (decision.action !== 'ok' && said !== state.lastLiveness) await journal.write('liveness', { action: decision.action, reason: decision.reason })
    if (decision.action === 'ok' && state.lastLiveness && !state.lastLiveness.startsWith('ok')) await journal.write('liveness', { action: 'ok', reason: decision.reason })
    if (!dryRun) state.lastLiveness = said
    let result = { decision, delayMs: timings.tickMs }
    try {
      const answering = decision.action === 'ok'
      const repair = dryRun ? { busy: false } : await repairTick(answering, credential.credential).catch(async error => { await journal.write('error', { during: 'repair', error: error?.message ?? String(error) }); return { busy: false } })
      if (!dryRun && answering && state.incident) {
        const answered = incidentAnswered(state.incident, { now: now(), timings, repairBusy: repair.busy })
        state.incident = answered.incident
        if (answered.close) {
          await journal.write('incident-closed', { id: state.incident.id, failures: state.incident.failures.length, rungs: state.incident.rungs.map(rung => rung.rung) })
          state.lastIncident = { id: state.incident.id, openedAt: state.incident.openedAt, closedAt: now(), failures: state.incident.failures.length }
          state.incident = null
        }
      } else if (!dryRun && decision.action !== 'recheck') state.incident = incidentDown(state.incident)
      const wantsStart = ['start', 'kill-and-start'].includes(decision.action) || (decision.action === 'stand-down' && decision.alert)
      if (answering) result = { ...result, ...await supervise(credential.credential, { dryRun }) }
      else if (repair.busy && (wantsStart || decision.action === 'stand-down')) {
        // The repair agent owns the app: it may be building, installing or starting Conductor.
        if (state.repairHold !== state.repair?.id) { state.repairHold = state.repair?.id ?? 'unknown'; await journal.write('repair-holds', { id: state.repair?.id ?? null, action: decision.action }) }
        result.delayMs = Math.min(timings.tickMs, 30_000)
      }
      else if (decision.action === 'recheck') result.delayMs = timings.recheckMs
      else if (decision.action === 'wait') result.delayMs = Math.min(timings.tickMs, decision.soon ? timings.recheckMs : 30_000)
      else if (decision.action === 'stand-down') {
        if (decision.alert && !dryRun) {
          const rung = await ladder('guard', armed)
          const repaired = rung.rung === 'repair' && await beginRepair(`${rung.reason}: ${decision.reason}`, armed)
          if (!repaired) await alert('Conductor keeps crashing', `The meta-wizard started Conductor ${decision.memory.restarts.length} times in ${Math.round(timings.restartWindowMs / 60_000)} minutes and is standing down for ${Math.round(timings.standDownMs / 60_000)}. ${decision.reason}${rung.rung === 'exhausted' ? ` (${rung.reason})` : ''}`, null)
        }
      }
      else if (decision.action === 'start' || decision.action === 'kill-and-start') {
        const deadPid = armed?.appPid ?? credential.credential?.pid ?? null
        const lock = decision.action === 'start' ? await readJsonFile(join(userData, 'recovery', 'watchdog.json'), null) : null
        const held = watchdogHold({ lock, lockAlive: Boolean(lock?.pid && alive(lock.pid)), deadPid, waiting: state.watchdogWaiting ?? null, now: now(), timings })
        if (!dryRun) state.watchdogWaiting = held.waiting
        if (held.hold) {
          if (!held.waiting || held.waiting.since === now()) await journal.write('watchdog-wait', { watchdog: lock.pid, appPid: deadPid, reason: held.reason })
          result.delayMs = Math.min(timings.tickMs, 30_000)
        } else if (dryRun) {
          const rung = await ladder('start', armed)
          await journal.write('planned-start', { action: decision.action, reason: decision.reason, rung: rung.rung, rungReason: rung.reason })
        } else await climb(decision, credential, armed, result)
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
