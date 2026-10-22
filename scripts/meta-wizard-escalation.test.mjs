import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { chooseRung, ESCALATION_TIMINGS, incidentAnswered, incidentDown, nextStepText, openIncident, pickRestorePoint, recordFailure, recordRung, repairActive, repairGate, repairId, sameSignature, watchdogHold } from './meta-wizard/escalation.mjs'
import { repairAgentArgs, repairAgentCommand, repairDeniedTools, repairEnv, repairPrompt, rollbackCommand, rulePath } from './meta-wizard/repair.mjs'
import { createService, fallbackVerdict } from './meta-wizard/service.mjs'

// node --test scripts/meta-wizard-escalation.test.mjs — the repair ladder (docs/startup-diagnostics.md, part 2).

const T0 = Date.parse('2026-10-22T09:26:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const iso = offsetMs => new Date(T0 + offsetMs).toISOString()
const verdict = (extra = {}) => ({ state: 'died', stage: 'structured-store', cause: 'oom', signature: 'died:structured-store:oom', line: 'died in stage structured-store 4.1 s after start: V8 heap out of memory', version: '0.1.59-local.2', pid: 7, ...extra })
const fail = (incident, rung, extra = {}, at = T0) => recordFailure(incident, { verdict: verdict(extra), rung, now: at })
const point = (version, extra = {}) => ({ version, commit: null, createdAt: iso(-(extra.age ?? 0)), installer: `Conductor-Setup-${version}.exe`, blockmap: 'x.blockmap', pinned: false, knownGood: false, crashCount: 0, failedShipCount: 0, firstLaunchedAt: iso(-(extra.age ?? 0) + 1000), ...extra })
const catalog = { schemaVersion: 1, points: [point('0.1.59-local.2', { age: 1 * HOUR }), point('0.1.58-local.1', { age: 5 * HOUR, knownGood: true })] }

describe('incident', () => {
  it('opens on the first failure with the verdict, and records rungs', () => {
    const incident = fail(null, 'restart')
    assert.equal(incident.failures.length, 1)
    assert.deepEqual({ ...incident.failures[0] }, { at: T0, rung: 'restart', pid: 7, state: 'died', stage: 'structured-store', cause: 'oom', signature: 'died:structured-store:oom', version: '0.1.59-local.2', line: verdict().line })
    assert.equal(openIncident(incident, { now: T0 + 1 }), incident, 'an open incident stays the same one')
    assert.deepEqual(recordRung(incident, { rung: 'rollback', now: T0 + 5, detail: 'x' }).rungs, [{ at: T0 + 5, rung: 'rollback', detail: 'x' }])
  })

  it('closes after Conductor answered for 10 minutes, not while a repair is busy, and starts over when it goes down', () => {
    let incident = fail(null, 'restart')
    let answered = incidentAnswered(incident, { now: T0 + MIN })
    assert.equal(answered.close, false)
    incident = answered.incident
    assert.equal(incidentAnswered(incident, { now: T0 + MIN + ESCALATION_TIMINGS.incidentCloseMs - 1 }).close, false)
    assert.equal(incidentAnswered(incident, { now: T0 + MIN + ESCALATION_TIMINGS.incidentCloseMs }).close, true)
    assert.equal(incidentAnswered(incident, { now: T0 + 2 * HOUR, repairBusy: true }).close, false)
    incident = incidentDown(incident)
    assert.equal(incident.answeredSince, null)
    assert.equal(incidentAnswered(incident, { now: T0 + 2 * HOUR }).close, false, 'the quiet period starts over')
    assert.deepEqual(incidentAnswered(null, { now: T0 }), { incident: null, close: false })
  })

  it('a signature matches only an equal, known signature', () => {
    assert.equal(sameSignature(verdict(), verdict({ version: 'other' })), true, 'the version is not part of the signature')
    assert.equal(sameSignature(verdict(), verdict({ signature: 'died:settings:exception' })), false)
    assert.equal(sameSignature(verdict({ signature: null }), verdict({ signature: null })), false)
    assert.equal(sameSignature(verdict(), undefined), false)
  })
})

describe('restore point choice', () => {
  const exists = () => true
  it('never the failing version, only points that ran here and whose installer is still there', () => {
    const points = [point('0.1.59-local.2', { age: 0 }), point('0.1.58-local.3', { age: HOUR, firstLaunchedAt: undefined }), point('0.1.58-local.2', { age: 2 * HOUR }), point('0.1.58-local.1', { age: 3 * HOUR })]
    assert.equal(pickRestorePoint({ points }, { failingVersion: '0.1.59-local.2', installerExists: exists }).version, '0.1.58-local.2')
    assert.equal(pickRestorePoint({ points }, { failingVersion: '0.1.59-local.2', installerExists: name => !name.includes('0.1.58-local.2') }).version, '0.1.58-local.1')
    assert.equal(pickRestorePoint({ points }, { failingVersion: '0.1.59-local.2', installerExists: exists, exclude: ['0.1.58-local.2'] }).version, '0.1.58-local.1')
  })

  it('prefers pinned or known-good, then points without crashes, then the newest', () => {
    const points = [point('a', { age: HOUR }), point('b', { age: 2 * HOUR, knownGood: true }), point('c', { age: 3 * HOUR, pinned: true }), point('d', { age: 30 * MIN, crashCount: 1 })]
    assert.equal(pickRestorePoint({ points }, { failingVersion: 'z', installerExists: exists }).version, 'b')
    assert.equal(pickRestorePoint({ points: points.filter(p => !p.knownGood) }, { failingVersion: 'z', installerExists: exists }).version, 'c')
    assert.equal(pickRestorePoint({ points: [point('a', { age: HOUR }), point('d', { age: 30 * MIN, crashCount: 1 })] }, { failingVersion: 'z', installerExists: exists }).version, 'a', 'a crashed point comes last though newer')
    assert.equal(pickRestorePoint({ points: [point('k', { knownGood: true, crashCount: 2 }), point('m', { age: HOUR, knownGood: true })] }, { failingVersion: 'z', installerExists: exists }).version, 'm')
  })

  it('with no failing version known, the newest point that ran is presumed to be it; nothing qualifies is null', () => {
    assert.equal(pickRestorePoint(catalog, { installerExists: exists }).version, '0.1.58-local.1')
    assert.equal(pickRestorePoint(catalog.points, { failingVersion: '0.1.59-local.2', installerExists: exists }).version, '0.1.58-local.1', 'a bare array works too')
    assert.equal(pickRestorePoint({ points: [point('only')] }, { failingVersion: 'only', installerExists: exists }), null)
    assert.equal(pickRestorePoint(null, {}), null)
    assert.equal(pickRestorePoint({ points: [{ version: 'broken' }] }, { failingVersion: 'x' }), null)
  })
})

describe('repair gating', () => {
  it('one at a time, at most 2 per 24 hours', () => {
    assert.equal(repairGate({ active: true, history: [], now: T0 }).ok, false)
    assert.equal(repairGate({ history: [{ startedAt: T0 - HOUR }], now: T0 }).ok, true)
    const two = [{ startedAt: T0 - 3 * HOUR }, { startedAt: T0 - HOUR }]
    assert.match(repairGate({ history: two, now: T0 }).reason, /2 repairs in the last 24 hours/)
    assert.equal(repairGate({ history: two, now: T0 - 3 * HOUR + ESCALATION_TIMINGS.repairWindowMs }).ok, true, 'the older one ages out')
  })

  it('a runner is active while its pid lives, within its time limit plus slack', () => {
    const active = { pid: 9, id: 'x', startedAt: iso(0) }
    assert.equal(repairActive({ active, alive: true, now: T0 + HOUR }), true)
    assert.equal(repairActive({ active, alive: false, now: T0 + MIN }), false)
    assert.equal(repairActive({ active, alive: true, now: T0 + ESCALATION_TIMINGS.repairTimeoutMs + 16 * MIN }), false, 'a reused pid long after is not the runner')
    assert.equal(repairActive({ active: null, alive: true, now: T0 }), false)
  })

  it('ids are the UTC minute, with a suffix when taken', () => {
    assert.equal(repairId(T0), '2026-10-22-0926')
    assert.equal(repairId(T0, ['2026-10-22-0926']), '2026-10-22-0926-2')
    assert.equal(repairId(T0, ['2026-10-22-0926', '2026-10-22-0926-2']), '2026-10-22-0926-3')
  })
})

describe('the ladder', () => {
  const ladder = (incident, extra = {}) => chooseRung({ incident, catalog, installerExists: () => true, now: T0 + MIN, ...extra })

  it('restart, restart, roll back, repair: the 2026-10-22 outage', () => {
    assert.deepEqual(ladder(null), { rung: 'restart', attempt: 1, of: 2, reason: 'start Conductor' })
    let incident = fail(null, 'restart')
    assert.equal(ladder(incident).rung, 'restart')
    assert.equal(ladder(incident).attempt, 2)
    incident = fail(incident, 'restart')
    const back = ladder(incident)
    assert.equal(back.rung, 'rollback')
    assert.equal(back.point.version, '0.1.58-local.1')
    assert.match(back.reason, /2 starts failed the same way \(died:structured-store:oom\); rolling back to 0\.1\.58-local\.1/)
    incident = fail({ ...incident, rolledBack: '0.1.58-local.1' }, 'rollback', { version: '0.1.58-local.1' })
    const repair = ladder(incident)
    assert.equal(repair.rung, 'repair')
    assert.match(repair.reason, /the rolled-back build 0\.1\.58-local\.1 fails the same way \(died:structured-store:oom\): data or environment, not the build/)
  })

  it('a rolled-back build that fails differently also goes to the repair agent', () => {
    let incident = fail(fail(null, 'restart'), 'restart')
    incident = fail({ ...incident, rolledBack: 'v' }, 'rollback', { signature: 'died:settings:exception', line: 'died in stage settings' })
    assert.equal(ladder(incident).rung, 'repair')
    assert.match(ladder(incident).reason, /the rolled-back build fails too \(died in stage settings\)/)
  })

  it('counts restarts per signature and version: a new failure gets its own restarts', () => {
    let incident = fail(null, 'restart')
    incident = fail(incident, 'restart', { signature: 'died:settings:exception' })
    assert.deepEqual([ladder(incident).rung, ladder(incident).attempt], ['restart', 2], 'one of each signature so far')
    incident = fail(fail(null, 'restart'), 'restart', { version: '0.1.60-local.1' })
    assert.equal(ladder(incident).rung, 'restart', 'the same failure on a new version is a new failure')
    const unknown = fail(fail(null, 'restart', { signature: null }), 'restart', { signature: null })
    assert.equal(ladder(unknown).rung, 'rollback', 'two failures without diagnostics count as the same')
  })

  it('no restore point after the restarts goes straight to repair', () => {
    const incident = fail(fail(null, 'restart'), 'restart')
    const next = chooseRung({ incident, catalog: null, now: T0 })
    assert.equal(next.rung, 'repair')
    assert.match(next.reason, /no restore point to roll back to/)
    assert.equal(chooseRung({ incident, catalog, installerExists: () => false, now: T0 }).rung, 'repair', 'an installer that is gone is no restore point')
  })

  it('the crash-loop guard goes to repair; the cap and a running repair are respected', () => {
    assert.equal(ladder(null, { trigger: 'guard' }).rung, 'repair')
    assert.match(ladder(null, { trigger: 'guard' }).reason, /crash-loop guard tripped/)
    const capped = ladder(null, { trigger: 'guard', repair: { history: [{ startedAt: T0 - HOUR }, { startedAt: T0 - 2 * HOUR }] } })
    assert.equal(capped.rung, 'exhausted')
    assert.match(capped.reason, /no repair now: 2 repairs/)
    assert.equal(ladder(fail(null, 'restart'), { repair: { active: true } }).rung, 'wait-repair')
  })

  it('after a repair: one plain start, then repair again while the cap allows, then exhausted', () => {
    let incident = fail(fail(null, 'restart'), 'restart', {}, T0 + 1)
    incident = { ...incident, repairs: [{ id: 'r1', startedAt: T0 + 2, finishedAt: T0 + 10, outcome: 'failed' }] }
    assert.deepEqual(ladder(incident), { rung: 'restart', attempt: 1, of: 1, reason: 'start Conductor after repair r1' })
    incident = fail(incident, 'restart', {}, T0 + 20)
    assert.equal(ladder(incident, { repair: { history: [{ startedAt: T0 }] } }).rung, 'repair')
    assert.equal(ladder(incident, { repair: { history: [{ startedAt: T0 }, { startedAt: T0 - MIN }] } }).rung, 'exhausted')
  })

  it('tells the owner what comes next', () => {
    assert.equal(nextStepText({ rung: 'restart', attempt: 2, of: 2 }), 'Restarting (2 of 2)')
    assert.equal(nextStepText({ rung: 'rollback', point: { version: '0.1.58-local.1' } }), 'Rolling back to 0.1.58-local.1 next')
    assert.match(nextStepText({ rung: 'repair', reason: 'x' }), /^Starting a repair agent next: x/)
    assert.match(nextStepText({ rung: 'exhausted', reason: 'capped' }), /No rung left \(capped\)/)
  })
})

describe('the recovery watchdog alongside', () => {
  const lock = { pid: 50, appPid: 7, startedAt: iso(0) }
  it('waits for a live watchdog of the dead pid, at most 20 minutes', () => {
    const first = watchdogHold({ lock, lockAlive: true, deadPid: 7, now: T0 })
    assert.equal(first.hold, true)
    assert.deepEqual(first.waiting, { pid: 50, since: T0 })
    assert.equal(watchdogHold({ lock, lockAlive: true, deadPid: 7, waiting: first.waiting, now: T0 + 19 * MIN }).hold, true)
    const done = watchdogHold({ lock, lockAlive: true, deadPid: 7, waiting: first.waiting, now: T0 + 20 * MIN })
    assert.equal(done.hold, false)
    assert.match(done.reason, /has had 20 minutes/)
  })
  it('not for a dead watchdog, another pid, or none; a new watchdog gets its own wait', () => {
    assert.equal(watchdogHold({ lock, lockAlive: false, deadPid: 7, now: T0 }).hold, false)
    assert.equal(watchdogHold({ lock, lockAlive: true, deadPid: 8, now: T0 }).hold, false)
    assert.equal(watchdogHold({ lock: null, lockAlive: true, deadPid: 7, now: T0 }).hold, false)
    assert.equal(watchdogHold({ lock: { ...lock, pid: 51 }, lockAlive: true, deadPid: 7, waiting: { pid: 50, since: T0 - HOUR }, now: T0 }).hold, true)
  })
})

describe('the repair agent', () => {
  const userData = 'C:\\Users\\owner\\AppData\\Roaming\\Conductor'
  it('runs claude headless on opus at high effort, edits accepted, with the deny list', () => {
    const args = repairAgentArgs({ userData })
    assert.deepEqual(args.slice(0, 13), ['-p', '--model', 'opus', '--effort', 'high', '--output-format', 'text', '--max-turns', '300', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read'])
    assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')), ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'PowerShell'])
    const denied = args.slice(args.indexOf('--disallowedTools') + 1)
    for (const rule of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(npm run dev:*)', 'Bash(git reset:*)', 'Bash(git clean:*)', 'Bash(git checkout main:*)', 'Bash(git branch -D:*)', 'Bash(rm:*)', 'Bash(del:*)', 'Bash(rd:*)', 'Bash(Remove-Item:*)', 'PowerShell(git push:*)', 'PowerShell(Remove-Item:*)', 'PowerShell(gh:*)', 'Edit(//c/Users/owner/AppData/Roaming/Conductor/**)', 'Write(//c/Users/owner/AppData/Roaming/Conductor/**)']) assert.ok(denied.includes(rule), `deny list lacks ${rule}`)
    assert.deepEqual(repairDeniedTools().filter(rule => /^(Edit|Write)\(/.test(rule)), [], 'no path rules without a userData')
    assert.equal(rulePath('D:\\x\\y\\'), '//d/x/y')
  })

  it('a test profile runs only the command it was given; the installed profile runs claude and ignores the knob', () => {
    assert.deepEqual(repairAgentCommand({ env: {}, testProfile: true, userData, resolve: () => 'C:\\claude.exe' }).command, null)
    assert.match(repairAgentCommand({ env: {}, testProfile: true, userData, resolve: () => 'C:\\claude.exe' }).reason, /no repair agent command in this test profile/)
    assert.equal(repairAgentCommand({ env: { CONDUCTOR_REPAIR_AGENT_COMMAND: 'nope' }, testProfile: true, userData }).command, null)
    const fake = repairAgentCommand({ env: { CONDUCTOR_REPAIR_AGENT_COMMAND: JSON.stringify(['node', 'fake.mjs']) }, testProfile: true, userData })
    assert.deepEqual(fake.command.slice(0, 3), ['node', 'fake.mjs', '-p'])
    const real = repairAgentCommand({ env: { CONDUCTOR_REPAIR_AGENT_COMMAND: JSON.stringify(['node', 'fake.mjs']) }, testProfile: false, userData, resolve: () => 'C:\\claude.exe' })
    assert.deepEqual(real.command.slice(0, 2), ['C:\\claude.exe', '-p'])
    assert.equal(repairAgentCommand({ env: {}, testProfile: false, userData, resolve: () => null }).command, null)
  })

  it('the rollback runs the installer silently; the test knob only in a test profile', () => {
    assert.deepEqual(rollbackCommand({ env: {}, testProfile: false, installer: 'C:\\feed\\Setup.exe' }), ['C:\\feed\\Setup.exe', '/S'])
    assert.deepEqual(rollbackCommand({ env: { CONDUCTOR_META_ROLLBACK_COMMAND: '["node","rb.mjs"]' }, testProfile: false, installer: 'S.exe' }), ['S.exe', '/S'])
    assert.deepEqual(rollbackCommand({ env: { CONDUCTOR_META_ROLLBACK_COMMAND: '["node","rb.mjs"]' }, testProfile: true, installer: 'S.exe' }), ['node', 'rb.mjs', 'S.exe'])
    // A test profile never runs a real installer: without the knob there is no rollback command.
    assert.equal(rollbackCommand({ env: {}, testProfile: true, installer: 'S.exe' }), null)
  })

  it('the agent environment has no Electron-as-node, Node options, test knobs or control tokens', () => {
    const clean = repairEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', CONDUCTOR_TEST_USER_DATA: 'd', CONDUCTOR_TEST_BOOT_FAIL: 's', CONDUCTOR_CONTROL_TOKEN: 't', CONDUCTOR_AGENT_CONTROL_TOKEN: 't', CLAUDECODE: '1', CONDUCTOR_PROJECTS_ROOT: 'r' })
    assert.deepEqual(clean, { PATH: 'p', CONDUCTOR_PROJECTS_ROOT: 'r' })
  })

  it('the prompt holds the incident, the evidence, the paths, the steps and the rules, bounded', () => {
    let incident = fail(null, 'restart', {}, T0)
    incident = recordRung(incident, { rung: 'rollback', now: T0 + MIN, detail: '0.1.58-local.1: installed' })
    incident = fail(incident, 'rollback', { version: '0.1.58-local.1' }, T0 + 2 * MIN)
    const prompt = repairPrompt({
      incident, reason: 'the rolled-back build fails the same way',
      diagnostics: { boot: JSON.stringify({ stage: 'structured-store', pad: 'x'.repeat(50_000) }), lastFailure: null, sample: '{"heapMb":3905}' },
      launchLogs: [{ path: 'C:\\md\\launch-1.log', tail: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }],
      recovery: { path: 'C:\\ud\\recovery\\recovery-1.md', excerpt: '**Cause** OOM in StructuredAgentStore' },
      paths: { userData, checkout: 'C:\\Claude\\conductor', worktree: 'C:\\Claude\\conductor-repairs\\2026-10-22-0926', branch: 'repair/2026-10-22-0926', base: 'abc123', exe: 'C:\\Programs\\Conductor.exe', feed: `${userData}\\local-updates`, report: 'C:\\r\\report.md' },
      now: T0 + 3 * MIN, ownerScaleCheck: true
    })
    for (const text of [
      'the rolled-back build fails the same way', `${iso(0)} [restart] died in stage structured-store`, '[rollback] died in stage structured-store 4.1 s after start: V8 heap out of memory (version 0.1.58-local.1) signature died:structured-store:oom',
      `${iso(MIN)} rollback: 0.1.58-local.1: installed`, '### boot-last-failure.json\n(none)', '{"heapMb":3905}', 'JavaScript heap out of memory', 'C:\\ud\\recovery\\recovery-1.md', 'OOM in StructuredAgentStore',
      'C:\\Claude\\conductor-repairs\\2026-10-22-0926', 'repair/2026-10-22-0926 (based on abc123)', 'C:\\Programs\\Conductor.exe',
      'npx vitest run', 'npm run typecheck', 'node scripts/smoke-lock.mjs -- node scripts/smoke-owner-scale-startup.mjs', 'node scripts/build-local-update.mjs', '/S', 'status --json', 'restart-seen',
      'Never push, publish, tag, or touch main', 'Never delete or edit anything in userData', 'Never `npm run dev`', 'never install software',
      '**Cause**', '**Fix**', '**Verified**', '**Is Conductor up**', '**Next steps for the owner/wizard**'
    ]) assert.ok(prompt.includes(text), `prompt lacks: ${text}`)
    assert.ok(prompt.length < 20_000, `prompt is bounded (${prompt.length})`)
    assert.ok(!repairPrompt({ incident, reason: 'r', paths: { userData, checkout: 'c', worktree: 'w', branch: 'b', exe: 'e', feed: 'f', report: 'r' }, now: T0, ownerScaleCheck: false }).includes('smoke-owner-scale-startup'))
  })

  it('without boot diagnostics the verdict comes from the exit code and the log', () => {
    assert.equal(fallbackVerdict({ pid: 3, exitCode: 4294930435 }).cause, 'oom')
    assert.equal(fallbackVerdict({ exitCode: 1, log: 'FATAL ERROR: JavaScript heap out of memory' }).signature, 'unknown:-:oom')
    assert.equal(fallbackVerdict({ exitCode: 70 }).cause, 'exit')
    assert.equal(fallbackVerdict({ exitCode: null }).cause, 'crash')
    assert.match(fallbackVerdict({ exitCode: 70 }).line, /died before boot diagnostics could say where: exit code 70/)
  })
})

// ---- The service climbing the ladder, with every effect faked ----

const tab = (id, extra = {}) => ({ agentSessionId: id, tabId: `tab_${id}`, title: id, projectId: 'p1', project: 'Conductor', workspaceId: 'w1', provider: 'claude', phase: 'completed', backgroundTasks: 0, wizard: false, controller: null, awaiting: null, lastTool: null, lastAnswer: null, lastError: null, lastActivityAt: iso(0), limitResumeAt: null, pending: { owner: 0, reviewer: 0 }, ...extra })

async function harness({ timings = {}, points = catalog.points, checkout = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'meta-wizard-ladder-'))
  const h = { root, now: T0, live: new Set(), spawned: [], installs: [], repairs: [], toasts: [], calls: [], version: '0.1.59-local.2', appUp: null }
  await mkdir(join(root, 'recovery'), { recursive: true })
  await writeFile(join(root, 'recovery', 'armed.json'), JSON.stringify({ kind: 'running', appPid: 1, at: iso(-HOUR), fromVersion: '0.1.59-local.2', launch: { exe: 'C:\\Conductor.exe', args: [] } }))
  h.answer = async pid => { h.live.add(pid); h.appUp = pid; await writeFile(join(root, 'control-owner.json'), JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:5555/control', token: 'ab', pid, startedAt: new Date(h.now).toISOString() })) }
  const controlCall = async (credential, method, args, options) => {
    if (!h.live.has(credential.pid)) { const error = new Error('unreachable'); error.code = 'unreachable'; throw error }
    h.calls.push({ method, args, scope: options?.scope })
    if (method === 'tools.list') return {}
    if (method === 'supervisor.overview') return { observedAt: new Date(h.now).toISOString(), pid: credential.pid, tabs: [tab('wiz', { wizard: true }), tab('plain')] }
    if (method === 'agents.steer') return { delivery: 'started' }
    if (method === 'supervisor.alert') return { delivered: 'pushed to 1 phone' }
    throw new Error(method)
  }
  h.service = createService({
    userData: root, testProfile: true, checkout: checkout ? root : null,
    timings: { crashGraceMs: 1000, restartGraceMs: 1000, startWaitMs: 20_000, exitSettleMs: 2000, maxRestarts: 10, repairAnswerGraceMs: 60_000, ...timings },
    deps: {
      env: { CONDUCTOR_META_ROLLBACK_COMMAND: JSON.stringify(['fake-installer']) },
      now: () => h.now, controlCall, pidAlive: pid => h.live.has(pid), sleep: async () => { h.now += 2000 }, cpuSeconds: async () => null,
      toast: async (title, body) => { h.toasts.push({ title, body }); return 'ok' },
      spawn: exe => {
        const pid = 100 + h.spawned.length
        h.spawned.push(exe)
        return { pid, on(event, listener) { if (event === 'exit') listener(4294930435) }, unref() {} }
      },
      readBootVerdict: async (userData, { pid }) => verdict({ pid, version: h.version, line: `died in stage structured-store 4.1 s after start: V8 heap out of memory; Conductor ${h.version}, pid ${pid}` }),
      readCatalog: async () => ({ catalog: { schemaVersion: 1, points }, installerExists: () => true }),
      runInstaller: async argv => { h.installs.push(argv); h.version = '0.1.58-local.1'; return { ok: true, exitCode: 0, detail: 'installed' } },
      startRepair: async ({ stateDirectory, id, request, prompt }) => {
        const dir = join(stateDirectory, 'repair', id)
        await mkdir(dir, { recursive: true })
        await writeFile(join(stateDirectory, 'repair', 'active.json'), JSON.stringify({ pid: 99, id, startedAt: new Date(h.now).toISOString() }))
        h.live.add(99)
        h.repairs.push({ id, request, prompt, dir })
        return { pid: 99, dir }
      }
    }
  })
  /** Ticks until Conductor is wanted again, past the graces. */
  h.tick = async (advance = 5000) => { h.now += advance; return h.service.tick() }
  /** Ticks until the predicate holds (at most 12 ticks). */
  h.until = async (predicate, advance = 5000) => { for (let index = 0; index < 12 && !await predicate(); index += 1) await h.tick(advance); assert.ok(await predicate(), 'the ladder did not get there') }
  h.journal = async () => (await readFile(join(root, 'meta-wizard', 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  h.finishRepair = async (result = {}) => {
    const repair = h.repairs.at(-1)
    h.live.delete(99)
    await rm(join(root, 'meta-wizard', 'repair', 'active.json'), { force: true })
    await writeFile(join(repair.dir, 'result.json'), JSON.stringify({ id: repair.id, exitCode: 0, timedOut: false, error: null, branch: repair.request.branch, worktree: repair.request.worktree, commits: [{ sha: 'f'.repeat(40), subject: 'Load projections lazily' }], report: join(repair.dir, 'report.md'), ...result }))
  }
  h.done = () => rm(root, { recursive: true, force: true })
  return h
}

describe('service: the ladder end to end', () => {
  it('restarts twice, rolls back, starts a repair, holds while it runs, then reports and tells the wizards once', async () => {
    const h = await harness()
    try {
      await h.until(() => h.spawned.length === 1) // the crash is seen, the recovery watchdog's grace, start 1: dies
      assert.equal(h.toasts.at(-1).title, 'Conductor did not start')
      assert.match(h.toasts.at(-1).body, /^Conductor did not start: died in stage structured-store 4\.1 s after start: V8 heap out of memory; Conductor 0\.1\.59-local\.2, pid 100\. Restarting \(2 of 2\)\. Log: /)
      await h.until(() => h.spawned.length === 2) // start 2: dies
      assert.match(h.toasts.at(-1).body, /Rolling back to 0\.1\.58-local\.1 next/)
      await h.until(() => h.spawned.length === 3) // rollback: install, start 3: dies the same way
      assert.equal(h.installs.length, 1)
      assert.deepEqual(h.installs[0], ['fake-installer', join(h.root, 'local-updates', 'Conductor-Setup-0.1.58-local.1.exe')])
      assert.equal(h.spawned.length, 3)
      assert.ok(h.toasts.some(toast => toast.title === 'Conductor: rolling back' && /Rolling back to 0\.1\.58-local\.1/.test(toast.body)))
      assert.match(h.toasts.at(-1).body, /Conductor 0\.1\.58-local\.1.*Starting a repair agent next: the rolled-back build 0\.1\.58-local\.1 fails the same way \(died:structured-store:oom\): data or environment/)
      await h.until(() => h.repairs.length === 1)
      assert.equal(h.spawned.length, 3, 'the repair rung starts no Conductor')
      const repair = h.repairs[0]
      assert.equal(repair.request.branch, `repair/${repair.id}`)
      assert.equal(repair.request.checkout, h.root)
      assert.equal(repair.request.command, null, 'a test profile without a command runs no agent')
      assert.match(repair.request.noAgentReason, /no repair agent command/)
      assert.match(repair.prompt, /\[rollback\] died in stage structured-store .*0\.1\.58-local\.1/)
      assert.ok(h.toasts.some(toast => toast.title === 'Conductor: repair agent started' && /Repair agent started: /.test(toast.body)))
      // While it runs, nothing is started or killed, however long Conductor stays down.
      for (let index = 0; index < 5; index += 1) await h.tick(10 * MIN)
      assert.equal(h.spawned.length, 3)
      assert.ok((await h.journal()).some(entry => entry.event === 'repair-holds'))
      // The agent installed a fix and started Conductor; then it exits.
      await h.answer(5)
      await h.finishRepair()
      await h.tick()
      const repaired = h.toasts.find(toast => toast.title === 'Conductor repaired')
      assert.match(repaired.body, /^Repaired: Conductor answers again \(pid 5\)/)
      assert.ok(h.calls.some(call => call.method === 'supervisor.alert' && call.args.title === 'Conductor repaired'), 'a phone push too')
      const steers = h.calls.filter(call => call.method === 'agents.steer')
      assert.deepEqual(steers.map(call => call.args.agentSessionId), ['wiz'], 'only the wizard tab')
      assert.match(steers[0].args.prompt, /^\[Meta-wizard\] Conductor did not start/)
      assert.match(steers[0].args.prompt, /ship it to main with git\.ship/)
      assert.match(steers[0].args.prompt, /ffffffffff Load projections lazily/)
      assert.ok(steers[0].args.prompt.includes(join(repair.dir, 'report.md')))
      assert.deepEqual(steers[0].scope, { projectId: 'p1', workspaceId: 'w1' })
      const result = JSON.parse(await readFile(join(repair.dir, 'result.json'), 'utf8'))
      assert.equal(result.conductorAnswered, 5)
      await h.tick(); await h.tick(MIN)
      assert.equal(h.calls.filter(call => call.method === 'agents.steer').length, 1, 'told once')
      // Answering for 10 minutes closes the incident.
      await h.tick(11 * MIN)
      assert.equal(h.service.state().incident, null)
      const events = (await h.journal()).map(entry => entry.event)
      for (const event of ['incident-failure', 'rollback', 'repair-start', 'repair-finished', 'repair-outcome', 'repair-announced', 'incident-closed']) assert.ok(events.includes(event), `journal lacks ${event}`)
    } finally { await h.done() }
  })

  it('no restore point: straight from the restarts to the repair; a repair that does not bring it back is reported failed', async () => {
    const h = await harness({ points: [] })
    try {
      await h.until(() => h.spawned.length === 2)
      assert.match(h.toasts.at(-1).body, /Starting a repair agent next: 2 starts failed the same way \(died:structured-store:oom\) and there is no restore point/)
      await h.until(() => h.repairs.length === 1)
      assert.equal(h.spawned.length, 2)
      assert.equal(h.installs.length, 0)
      await h.finishRepair({ exitCode: 1, error: 'killed after 90 minutes', timedOut: true, commits: [] })
      await h.tick() // finished, inside the grace: still the agent's
      assert.equal(h.spawned.length, 2)
      await h.tick(2 * MIN)
      const failed = h.toasts.find(toast => toast.title === 'Conductor repair failed')
      assert.match(failed.body, /^Repair failed: .*killed after 90 minutes/)
      // Then one plain start after the repair.
      await h.until(() => h.spawned.length === 3)
      assert.match(h.toasts.at(-1).body, /Starting a repair agent next: Conductor still does not start after repair/, 'the cap allows a second repair')
    } finally { await h.done() }
  })

  it('the crash-loop guard starts a repair; at most two repairs a day, then the old stand-down', async () => {
    const h = await harness({ timings: { maxRestarts: 2 }, points: [] })
    try {
      h.service.state() ?? await h.service.load()
      const state = h.service.state()
      state.repairs = [{ id: 'old', startedAt: T0 - HOUR }]
      for (let index = 0; index < 6; index += 1) await h.tick()
      assert.equal(h.repairs.length, 1)
      assert.match(h.repairs[0].request.noAgentReason, /no repair agent command/)
      assert.ok((await h.journal()).some(entry => entry.event === 'repair-start' && /2 starts failed the same way|crash-loop guard/.test(entry.reason)))
      await h.finishRepair()
      await h.tick(); await h.tick(2 * MIN) // failed
      // The cap is reached: the guard now only stands down and alerts, as before.
      for (let index = 0; index < 8; index += 1) await h.tick(40 * MIN)
      assert.equal(h.repairs.length, 1)
      assert.ok(h.toasts.some(toast => toast.title === 'Conductor keeps crashing' && /no repair now: 2 repairs/.test(toast.body)) || h.toasts.some(toast => /No rung left/.test(toast.body)))
    } finally { await h.done() }
  })

  it('without a checkout the repair is not possible: one alert, and plain restarts go on', async () => {
    const h = await harness({ points: [], checkout: false })
    try {
      for (let index = 0; index < 8; index += 1) await h.tick()
      assert.equal(h.repairs.length, 0)
      assert.equal(h.toasts.filter(toast => toast.title === 'Conductor repair not possible').length, 1)
      assert.ok(h.spawned.length >= 3)
    } finally { await h.done() }
  })

  it('waits for a live recovery watchdog of the dead pid, at most 20 minutes', async () => {
    const h = await harness()
    try {
      h.live.add(50)
      await writeFile(join(h.root, 'recovery', 'watchdog.json'), JSON.stringify({ pid: 50, appPid: 1, startedAt: iso(0) }))
      await h.tick(); await h.tick(); await h.tick(10 * MIN)
      assert.equal(h.spawned.length, 0)
      assert.equal((await h.journal()).filter(entry => entry.event === 'watchdog-wait').length, 1)
      await h.tick(11 * MIN)
      assert.equal(h.spawned.length, 1)
    } finally { await h.done() }
  })
})
