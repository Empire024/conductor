import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { detect, plan, resumeTargets, TIMINGS, workingSnapshot } from './meta-wizard/detect.mjs'
import { hiddenVbs, taskXml } from './meta-wizard/install.mjs'
import { decideLiveness } from './meta-wizard/liveness.mjs'
import { createService } from './meta-wizard/service.mjs'

// node --test scripts/meta-wizard.test.mjs — the meta-wizard's rules without Electron (docs/meta-wizard.md).

const T0 = Date.parse('2026-09-30T00:00:00.000Z')
const iso = offsetMs => new Date(T0 + offsetMs).toISOString()
const MIN = 60_000
const tab = (id, extra = {}) => ({ agentSessionId: id, tabId: `tab_${id}`, title: id, projectId: 'p1', project: 'Conductor', workspaceId: 'w1', provider: 'claude', phase: 'completed', backgroundTasks: 0, wizard: false, controller: null, awaiting: null, lastTool: null, lastAnswer: null, lastError: null, lastActivityAt: iso(0), limitResumeAt: null, pending: { owner: 0, reviewer: 0 }, ...extra })
const kinds = result => result.findings.map(finding => `${finding.kind}->${finding.target?.agentSessionId ?? 'owner'}`)

describe('detect: the night of 2026-09-29', () => {
  // The Conductor wizard waits on the Haftheme wizard, whose reply was refused by a durable denial.
  const refusal = 'PreToolUse:mcp__conductor__send_message hook error: A durable approval denial protects this project target.'
  const overview = {
    tabs: [
      tab('conductor_wizard', { wizard: true, awaiting: { agents: ['haftheme_wizard'], since: iso(-45 * MIN), deadline: null, reason: 'wait for "safe"' }, lastActivityAt: iso(-45 * MIN) }),
      tab('haftheme_wizard', { wizard: true, projectId: 'p2', project: 'Haftheme', lastAnswer: 'W5 is done, 3 orders to cancel', lastActivityAt: iso(-40 * MIN), lastTool: { name: 'mcp__conductor__send_message', status: 'rejected', at: iso(-41 * MIN), output: refusal, target: 'conductor_wizard' } })
    ]
  }

  it('steers the waiter with the refusal and the last answer, and alerts the owner about the fence', () => {
    const first = detect(overview, {}, T0)
    assert.deepEqual(kinds(first), ['message-refused->conductor_wizard', 'denial-fence->owner'])
    // Everyone awaited is quiet: after awaitQuietMs the quiet rule fires too.
    const later = detect(overview, first.memory, T0 + TIMINGS.awaitQuietMs)
    assert.deepEqual(kinds(later), ['await-quiet->conductor_wizard', 'message-refused->conductor_wizard', 'denial-fence->owner'])
    const quiet = later.findings[0].facts
    assert.match(quiet, /gone quiet without messaging you/)
    assert.match(quiet, /REFUSED: "PreToolUse.*durable approval denial/)
    assert.match(quiet, /last answer: "W5 is done, 3 orders to cancel"/)
    const planned = plan(later.findings, {}, T0 + TIMINGS.awaitQuietMs)
    assert.equal(planned.steers.length, 1, 'two facts about one waiter go in one message')
    assert.equal(planned.steers[0].target.agentSessionId, 'conductor_wizard')
    assert.match(planned.steers[0].prompt, /^\[Meta-wizard\] You are waiting/)
    assert.match(planned.steers[0].prompt, /tried to send a message to you .* REFUSED/)
    assert.deepEqual(planned.alerts.map(alert => alert.key), ['denial-fence:p2'])
  })

  it('a wait with no deadline is overdue after 90 minutes even when its target still runs', () => {
    const running = { tabs: [overview.tabs[0], { ...overview.tabs[1], phase: 'running', lastTool: null }] }
    assert.deepEqual(kinds(detect(running, {}, T0)), [])
    assert.deepEqual(kinds(detect(running, {}, T0 + 46 * MIN)), ['await-overdue->conductor_wizard'])
  })
})

describe('detect: other stalls', () => {
  it('a passed deadline the app did not act on, after the grace', () => {
    const waiting = { tabs: [tab('w', { awaiting: { agents: ['c'], since: iso(-70 * MIN), deadline: iso(-2 * MIN), reason: null } }), tab('c', { phase: 'running' })] }
    assert.deepEqual(kinds(detect(waiting, {}, T0)), [])
    assert.deepEqual(kinds(detect(waiting, {}, T0 + 2 * MIN)), ['await-deadline->w'])
  })

  it('a tab that handed itself off is left to its successor, and an awaited tab that did is described through its successor', () => {
    // The Coordinator of 2026-10-12: it declared a wait, continued in a successor, and its stale
    // record was steered about (forwarded to the successor) twice, then reported stuck hourly.
    const retired = tab('coord', { successor: 'coord2', awaiting: { agents: ['g'], since: iso(-70 * MIN), deadline: iso(-30 * MIN), reason: 'worker G' }, lastActivityAt: iso(-60 * MIN) })
    assert.deepEqual(kinds(detect({ tabs: [retired, tab('coord2', { phase: 'running' })] }, {}, T0)), [])
    assert.deepEqual(kinds(detect({ tabs: [tab('old', { successor: 'new', limitResumeAt: iso(-6 * MIN) }), tab('new')] }, {}, T0)), [], 'nor is a retired tab told its limit reset')
    // The successor's own wait, on a worker that handed itself off, is judged and described on the live tabs.
    const waiter = tab('coord2', { awaiting: { agents: ['g'], since: iso(-70 * MIN), deadline: iso(-5 * MIN), reason: null } })
    const result = detect({ tabs: [retired, waiter, tab('g', { successor: 'g2' }), tab('g2', { lastAnswer: 'Milestone B rendered' })] }, {}, T0)
    assert.deepEqual(kinds(result), ['await-deadline->coord2'])
    assert.match(result.findings[0].facts, /"g2" \(g2\) \(continuing g, which handed itself off\).*last answer: "Milestone B rendered"/)
  })

  it('does not call a wait quiet while an awaited tab works, waits itself or runs background tasks, and restarts the clock when it moves', () => {
    const base = tab('w', { awaiting: { agents: ['a', 'b'], since: iso(-5 * MIN), deadline: iso(55 * MIN), reason: null } })
    for (const b of [tab('b', { phase: 'running' }), tab('b', { backgroundTasks: 1, phase: 'viewing' }), tab('b', { awaiting: { agents: ['x'], since: iso(0), deadline: null, reason: null } })]) {
      const first = detect({ tabs: [base, tab('a'), b] }, {}, T0)
      assert.deepEqual(kinds(detect({ tabs: [base, tab('a'), b] }, first.memory, T0 + 10 * MIN)).filter(kind => kind.endsWith('->w')), [])
    }
    const first = detect({ tabs: [base, tab('a'), tab('b')] }, {}, T0)
    const moved = detect({ tabs: [base, tab('a'), tab('b', { lastActivityAt: iso(3 * MIN) })] }, first.memory, T0 + 3 * MIN)
    assert.deepEqual(kinds(detect({ tabs: [base, tab('a'), tab('b', { lastActivityAt: iso(3 * MIN) })] }, moved.memory, T0 + 6 * MIN)), [])
    assert.deepEqual(kinds(detect({ tabs: [base, tab('a'), tab('b', { lastActivityAt: iso(3 * MIN) })] }, moved.memory, T0 + 3 * MIN + TIMINGS.awaitQuietMs)), ['await-quiet->w'])
  })

  it('a closed awaited tab counts as quiet and is named as closed', () => {
    const waiting = { tabs: [tab('w', { awaiting: { agents: ['gone'], since: iso(0), deadline: null, reason: null } })] }
    const later = detect(waiting, detect(waiting, {}, T0).memory, T0 + TIMINGS.awaitQuietMs)
    assert.match(later.findings[0].facts, /- gone: tab closed/)
  })

  it('a refused report reaches the controller', () => {
    const tabs = [tab('ctl', { phase: 'running' }), tab('cw', { controller: 'ctl', lastTool: { name: 'mcp__conductor__report', status: 'rejected', at: iso(0), output: 'hook error' } })]
    assert.deepEqual(kinds(detect({ tabs }, {}, T0)), ['message-refused->ctl'])
  })

  it('a coworker that stopped while its controller has not acted since', () => {
    const tabs = [tab('ctl', { lastActivityAt: iso(-20 * MIN) }), tab('cw', { controller: 'ctl', lastActivityAt: iso(-15 * MIN), lastAnswer: 'done: tests pass' })]
    assert.deepEqual(kinds(detect({ tabs }, {}, T0)), ['coworker-idle->ctl'])
    // The controller acted after (a report woke it): nothing to say.
    assert.deepEqual(kinds(detect({ tabs: [{ ...tabs[0], lastActivityAt: iso(-14 * MIN) }, tabs[1]] }, {}, T0)), [])
    // Too recent.
    assert.deepEqual(kinds(detect({ tabs: [tabs[0], { ...tabs[1], lastActivityAt: iso(-5 * MIN) }] }, {}, T0)), [])
  })

  it('an update downloaded and verified but held for 20 minutes goes to its builder, else the wizards', () => {
    const view = { updates: { phase: 'ready', availableVersion: '0.1.56-local.1', source: 'local', installBlockers: [{ id: 'x', title: 'Busy tab' }] }, localBuild: { verified: true, builder: 'builder', commit: 'abcdef1234567890' }, tabs: [tab('builder'), tab('wiz', { wizard: true })] }
    const first = detect(view, {}, T0)
    assert.deepEqual(kinds(first), [])
    const held = detect(view, first.memory, T0 + 20 * MIN)
    assert.deepEqual(kinds(held), ['update-held->builder'])
    assert.match(held.findings[0].facts, /0\.1\.56-local\.1 \(commit abcdef123456\) is downloaded and verified .* waits for: Busy tab/)
    assert.deepEqual(kinds(detect({ ...view, localBuild: { verified: true, builder: 'closed' } }, first.memory, T0 + 20 * MIN)), ['update-held->wiz'])
    assert.deepEqual(kinds(detect({ ...view, localBuild: { verified: false, builder: 'builder' } }, first.memory, T0 + 30 * MIN)), [], 'an unverified local build is not held, it is refused')
    assert.equal(detect({ ...view, updates: { phase: 'idle' } }, held.memory, T0 + 30 * MIN).memory.updateSeen, null)
  })

  it('a usage limit that reset five minutes ago', () => {
    const tabs = [tab('lim', { phase: 'idle', limitResumeAt: iso(-6 * MIN) }), tab('soon', { phase: 'idle', limitResumeAt: iso(-1 * MIN) }), tab('card', { phase: 'idle', limitResumeAt: iso(-9 * MIN), pending: { owner: 1, reviewer: 0 } })]
    const result = detect({ tabs }, {}, T0)
    assert.deepEqual(kinds(result), ['limit-reset->lim'])
    assert.match(result.findings[0].prompt, /usage limit reset .* Continue where you left off/)
  })
})

describe('plan', () => {
  const finding = (id, fingerprint = `f:${id}`) => ({ kind: 'await-quiet', fingerprint, target: tab(id), facts: `facts about ${id}` })

  it('steers a fact once, repeats it once after steerRepeatMs, then alerts the owner once, naming the tab', () => {
    let ledger = {}
    const at = [T0, T0 + 5 * MIN, T0 + 16 * MIN, T0 + 32 * MIN, T0 + 34 * MIN, T0 + 95 * MIN, T0 + 12 * 60 * MIN, T0 + 32 * MIN + TIMINGS.alertRepeatMs]
    const results = at.map(now => { const result = plan([finding('a')], ledger, now); ledger = result.ledger; return result })
    assert.deepEqual(results.map(r => r.steers.length), [1, 0, 1, 0, 0, 0, 0, 0])
    // The owner's phone got fifteen hourly pushes about one stuck tab on 2026-10-12: an unchanged
    // condition is told once, and again after a day.
    assert.deepEqual(results.map(r => r.alerts.map(alert => alert.key)), [[], [], [], ['stuck:f:a'], [], [], [], ['stuck:f:a']])
    assert.equal(results[3].alerts[0].agentSessionId, 'a', 'the alert names the tab, so a tap on the phone opens it')
  })

  it('a tab that acted after the steer is neither steered again nor reported stuck', () => {
    const first = plan([finding('a')], {}, T0)
    const acted = { ...finding('a'), target: tab('a', { lastActivityAt: iso(MIN) }) }
    assert.deepEqual([16, 32, 48].map(minutes => plan([acted], first.ledger, T0 + minutes * MIN)).map(r => [r.steers.length, r.alerts.length]), [[0, 0], [0, 0], [0, 0]])
  })

  it('one steer per tab per cooldown; other tabs are not held up', () => {
    const first = plan([finding('a')], {}, T0)
    const second = plan([finding('a', 'f:a2'), finding('b')], first.ledger, T0 + MIN)
    assert.deepEqual(second.steers.map(steer => steer.target.agentSessionId), ['b'])
    assert.deepEqual(plan([finding('a', 'f:a2')], second.ledger, T0 + 11 * MIN).steers.map(steer => steer.fingerprints), [['f:a2']])
  })

  it('caps steers per hour and says so once', () => {
    const findings = Array.from({ length: 25 }, (_, n) => finding(`t${n}`))
    const result = plan(findings, {}, T0)
    assert.equal(result.steers.length, TIMINGS.maxSteersPerHour)
    assert.deepEqual(result.alerts.map(alert => alert.key), ['steer-cap'])
  })

  it('an alert whose condition stays is told once a day; one whose condition went away and came back is new', () => {
    const fence = { kind: 'denial-fence', fingerprint: 'x', target: null, alert: { key: 'k', title: 't', body: 'b', agentSessionId: 'fenced' } }
    const first = plan([fence], {}, T0)
    assert.deepEqual(first.alerts.map(alert => [alert.key, alert.agentSessionId]), [['k', 'fenced']])
    assert.equal(plan([{ ...fence, fingerprint: 'y' }], first.ledger, T0 + 61 * MIN).alerts.length, 0, 'the same condition an hour later')
    assert.equal(plan([{ ...fence, fingerprint: 'y' }], first.ledger, T0 + TIMINGS.alertRepeatMs).alerts.length, 1, 'still there a day later')
    const lifted = plan([], first.ledger, T0 + 30 * MIN)
    assert.deepEqual(lifted.ledger.alerted, {}, 'a condition that is gone is forgotten')
    assert.equal(plan([fence], lifted.ledger, T0 + 40 * MIN).alerts.length, 1, 'fenced again: a new alert')
  })
})

describe('resume after a restart', () => {
  it('brings back every tab that was at work and has not moved since the new Conductor started; leaves cards and moving tabs alone', () => {
    const before = workingSnapshot({ tabs: [tab('owner_tab', { phase: 'running' }), tab('coworker', { phase: 'waiting_approval' }), tab('resumed', { phase: 'running' }), tab('card', { phase: 'running' }), tab('done', { phase: 'completed' }), tab('bg', { phase: 'viewing', backgroundTasks: 1 })] })
    assert.deepEqual(before.map(entry => entry.agentSessionId), ['owner_tab', 'coworker', 'resumed', 'card', 'bg'])
    const restart = { pid: 2, startedAt: iso(0), reason: 'Conductor (pid 1) crashed' }
    const after = { tabs: [tab('owner_tab', { phase: 'interrupted', lastActivityAt: iso(-MIN) }), tab('coworker', { phase: 'idle', lastActivityAt: null }), tab('resumed', { phase: 'running' }), tab('card', { phase: 'idle', pending: { owner: 1, reviewer: 0 } }), tab('bg', { phase: 'completed', lastActivityAt: iso(5000) })] }
    const targets = resumeTargets(before, after, restart)
    assert.deepEqual(targets.map(target => target.target.agentSessionId), ['owner_tab', 'coworker'])
    assert.match(targets[0].prompt, /^\[Meta-wizard\] Conductor restarted at 2026-09-30T00:00:00.000Z \(Conductor \(pid 1\) crashed\) and your turn was cut while it was running/)
  })
})

describe('liveness', () => {
  const ok = { ok: true, credential: { pid: 10, endpoint: 'http://127.0.0.1:1/control', token: 'aa' } }
  const decide = input => decideLiveness({ now: T0, bootAt: T0 - 3_600_000, ...input })

  it('answers: ok; silent three times: kill and start, unless it is on its way out of an install', () => {
    assert.equal(decide({ credential: ok, probe: 'ok' }).action, 'ok')
    let memory = {}
    const actions = [1, 2, 3].map(() => { const result = decide({ credential: ok, probe: 'timeout', memory }); memory = result.memory; return result.action })
    assert.deepEqual(actions, ['recheck', 'recheck', 'kill-and-start'])
    assert.equal(decide({ credential: ok, probe: 'timeout', memory: { strikes: 2 }, armed: { kind: 'update-install', appPid: 10, at: iso(-MIN) } }).action, 'wait')
  })

  // 2026-10-21: twice killed with taskkill /T /F after ~60 s of silence while main was busy in a
  // launch prune. A main process whose CPU time keeps rising is busy: it gets busyMaxMs.
  it('a silent process whose CPU time keeps rising is busy, not hung, until busyMaxMs', () => {
    let memory = {}
    let at = T0
    const step = cpu => { const result = decideLiveness({ now: at, bootAt: T0 - 3_600_000, credential: ok, probe: 'timeout', cpu, memory }); memory = result.memory; at += TIMINGS.recheckMs; return result }
    const actions = []
    let cpu = 100
    while (at - T0 < TIMINGS.busyMaxMs + 3 * TIMINGS.recheckMs) { const result = step(cpu += 15); actions.push(result.action); if (result.action === 'kill-and-start') { assert.match(result.reason, /busy past 240 s/); break } }
    assert.equal(actions.at(-1), 'kill-and-start')
    // Killed only after busyMaxMs of silence, never at the third strike.
    assert.ok(actions.length * TIMINGS.recheckMs > TIMINGS.busyMaxMs, `killed after ${actions.length} probes`)
  })

  it('a silent process whose CPU time is flat is hung after three strikes', () => {
    let memory = {}
    const actions = [1, 2, 3].map(index => { const result = decideLiveness({ now: T0 + index * TIMINGS.recheckMs, credential: ok, probe: 'timeout', cpu: 100, memory }); memory = result.memory; return result })
    assert.deepEqual(actions.map(result => result.action), ['recheck', 'recheck', 'kill-and-start'])
    assert.match(actions[2].reason, /hung: its CPU time is not rising/)
  })

  it('a starting process past its grace waits while its CPU time rises', () => {
    const armed = { kind: 'running', appPid: 11, at: iso(-4 * MIN) }
    const first = decide({ credential: { ok: false }, armed, armedAppAlive: true, cpu: 50 })
    assert.equal(first.action, 'kill-and-start', 'no earlier sample: nothing proves it busy')
    const busy = decide({ credential: { ok: false }, armed, armedAppAlive: true, cpu: 58, memory: { cpu: { pid: 11, seconds: 50 } } })
    assert.equal(busy.action, 'wait')
    assert.equal(decide({ credential: { ok: false }, armed: { ...armed, at: iso(-8 * MIN) }, armedAppAlive: true, cpu: 58, memory: { cpu: { pid: 11, seconds: 50 } } }).action, 'kill-and-start')
  })

  it('a crash: waits for the recovery watchdog, then starts', () => {
    const armed = { kind: 'running', appPid: 10, at: iso(-3_600_000) }
    const first = decide({ credential: { ok: false, stale: true }, armed })
    assert.equal(first.action, 'wait')
    assert.equal(decideLiveness({ now: T0 + TIMINGS.crashGraceMs, credential: { ok: false }, armed, memory: first.memory }).action, 'start')
  })

  it('a restart or update the recovery watchdog is still handling is left to it', () => {
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'restart', at: iso(-MIN) } }).action, 'wait')
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'restart', at: iso(-4 * MIN) } }).action, 'start')
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'update-install', at: iso(-4 * MIN) } }).action, 'wait')
  })

  it('an owner quit is respected; a Windows restart with work in progress brings it back', () => {
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'quit', at: iso(-MIN) }, memory: { workInProgress: true } }).action, 'idle')
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'quit', at: iso(-2 * 3_600_000) }, memory: { workInProgress: true } }).action, 'start')
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'quit', at: iso(-2 * 3_600_000) }, memory: { workInProgress: false } }).action, 'idle')
    assert.equal(decide({ credential: { ok: false }, armed: null, memory: { workInProgress: false } }).action, 'idle')
  })

  it('started but no control endpoint: waits, then kills and starts', () => {
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'running', appPid: 11, at: iso(-MIN) }, armedAppAlive: true }).action, 'wait')
    assert.equal(decide({ credential: { ok: false }, armed: { kind: 'running', appPid: 11, at: iso(-4 * MIN) }, armedAppAlive: true }).action, 'kill-and-start')
  })

  it('crash-loop guard: three starts in 30 minutes, then stand down with one alert', () => {
    const memory = { restarts: [T0 - 20 * MIN, T0 - 10 * MIN, T0 - MIN], downSince: T0 - 2 * MIN }
    const guarded = decide({ credential: { ok: false }, armed: { kind: 'running', appPid: 10, at: iso(-MIN) }, memory })
    assert.equal(guarded.action, 'stand-down')
    assert.equal(guarded.alert, true)
    const again = decideLiveness({ now: T0 + MIN, credential: { ok: false }, armed: { kind: 'running', appPid: 10 }, memory: guarded.memory })
    assert.equal(again.action, 'stand-down')
    assert.equal(again.alert, undefined)
  })
})

describe('the scheduled task', () => {
  it('runs hidden at logon and every 5 minutes, one instance, no time limit, restarts on failure', () => {
    const xml = taskXml({ user: 'MAIN\\owner', wscript: 'C:\\Windows\\System32\\wscript.exe', vbs: 'C:\\x\\run-hidden.vbs', workingDirectory: 'C:\\x', start: '2026-09-30T10:00:00' })
    for (const part of ['<LogonTrigger>', '<Interval>PT5M</Interval>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<LogonType>InteractiveToken</LogonType>', '<RunLevel>LeastPrivilege</RunLevel>', '<Count>999</Count>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<Arguments>//B //NoLogo "C:\\x\\run-hidden.vbs"</Arguments>', '<UserId>MAIN\\owner</UserId>']) assert.ok(xml.includes(part), part)
    const vbs = hiddenVbs({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\x\\scripts\\meta-wizard.mjs', userData: 'C:\\Users\\o\\AppData\\Roaming\\Conductor' })
    assert.ok(vbs.includes('WScript.Quit shell.Run("""C:\\Program Files\\nodejs\\node.exe"" ""C:\\x\\scripts\\meta-wizard.mjs"" run --user-data ""C:\\Users\\o\\AppData\\Roaming\\Conductor""", 0, True)'), vbs)
  })
})

describe('service tick', () => {
  it('starts a dead Conductor, then resumes the tab the crash cut once the new one answers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meta-wizard-test-'))
    try {
      let now = T0
      let appPid = null
      const live = new Set([1])
      const calls = []
      const writeCredential = pid => writeFile(join(root, 'control-owner.json'), JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:5555/control', token: 'ab', pid, startedAt: new Date(now).toISOString() }))
      await mkdir(join(root, 'recovery'), { recursive: true })
      await writeFile(join(root, 'recovery', 'armed.json'), JSON.stringify({ kind: 'running', appPid: 1, at: iso(-3_600_000), launch: { exe: 'C:\\Conductor.exe', args: [] } }))
      await writeCredential(1); appPid = 1
      let phase = 'running', activity = iso(0)
      const controlCall = async (credential, method, args, options) => {
        if (!live.has(credential.pid)) { const error = new Error('unreachable'); error.code = 'unreachable'; throw error }
        calls.push({ method, args, scope: options?.scope, pid: credential.pid })
        if (method === 'tools.list') return {}
        if (method === 'supervisor.overview') return { observedAt: new Date(now).toISOString(), pid: credential.pid, updates: null, localBuild: null, tabs: [tab('cut', { phase, lastActivityAt: activity })] }
        if (method === 'agents.steer') return { delivery: 'started' }
        if (method === 'supervisor.alert') return { delivered: 'pushed to 1 phone' }
        throw new Error(method)
      }
      const toasts = []
      const spawned = []
      const service = createService({
        userData: root, timings: { crashGraceMs: 30_000, startWaitMs: 10_000 }, testProfile: true,
        deps: {
          now: () => now, controlCall, pidAlive: pid => live.has(pid), toast: async (title, body) => { toasts.push({ title, body }); return 'ok' },
          sleep: async () => { now += 2000 },
          spawn: (exe, args) => { spawned.push(exe); live.add(2); appPid = 2; void writeCredential(2); return { pid: 2, on() {}, unref() {} } }
        }
      })
      assert.equal((await service.tick()).decision.action, 'ok')
      assert.deepEqual(service.state().working.map(entry => entry.agentSessionId), ['cut'])
      // Killed.
      live.delete(1); phase = 'interrupted'; now += 60_000
      assert.equal((await service.tick()).decision.action, 'wait')
      now += 31_000
      const started = await service.tick()
      assert.equal(started.decision.action, 'start')
      assert.deepEqual(spawned, ['C:\\Conductor.exe'])
      assert.equal(appPid, 2)
      assert.deepEqual(toasts.map(toast => toast.title), ['Conductor was brought back'])
      // Seen, resume not yet due.
      await service.tick()
      assert.equal(calls.filter(call => call.method === 'agents.steer').length, 0)
      assert.ok(service.state().pendingResume)
      now += TIMINGS.resumeDelayMs
      await service.tick()
      const steers = calls.filter(call => call.method === 'agents.steer')
      assert.equal(steers.length, 1)
      assert.equal(steers[0].args.agentSessionId, 'cut')
      assert.deepEqual(steers[0].scope, { projectId: 'p1', workspaceId: 'w1' })
      assert.match(steers[0].args.prompt, /Conductor restarted .* crashed or was killed and did not come back/)
      const journal = (await readFile(join(root, 'meta-wizard', 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).event)
      for (const event of ['liveness', 'start', 'started', 'alert', 'restart-seen', 'steer']) assert.ok(journal.includes(event), `journal lacks ${event}: ${journal}`)
      assert.ok(!(await readFile(join(root, 'meta-wizard', 'journal.jsonl'), 'utf8')).includes('"token"'), 'the journal never holds the credential')
      // Steered once: the next tick says nothing more.
      await service.tick()
      assert.equal(calls.filter(call => call.method === 'agents.steer').length, 1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records its kill and relaunch in armed.json, so the recovery watchdog does not relaunch next to it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meta-wizard-armed-'))
    try {
      await writeFile(join(root, 'control-owner.json'), JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:5555/control', token: 'ab', pid: 1, startedAt: iso(-3_600_000) }))
      await mkdir(join(root, 'recovery'), { recursive: true })
      await writeFile(join(root, 'recovery', 'armed.json'), JSON.stringify({ kind: 'running', appPid: 1, at: iso(-3_600_000), fromVersion: '0.1.90', foreground: true, launch: { exe: 'C:\\Conductor.exe', args: [] }, checkout: null, packaged: true }))
      const order = []
      let now = T0
      const controlCall = async () => { const error = new Error('timeout'); error.code = 'timeout'; throw error }
      const service = createService({
        userData: root, timings: { startWaitMs: 4000 }, testProfile: true,
        deps: {
          now: () => now, controlCall, pidAlive: () => true, toast: async () => 'ok', sleep: async () => { now += 2000 }, cpuSeconds: async () => 100,
          kill: async pid => { order.push(['kill', pid, JSON.parse(await readFile(join(root, 'recovery', 'armed.json'), 'utf8')).kind]); return 'killed' },
          spawn: exe => { order.push(['spawn', exe]); return { pid: 2, on() {}, unref() {} } }
        }
      })
      for (let index = 0; index < 3; index += 1) { await service.tick(); now += TIMINGS.recheckMs }
      assert.deepEqual(order, [['kill', 1, 'restart'], ['spawn', 'C:\\Conductor.exe']])
      const armed = JSON.parse(await readFile(join(root, 'recovery', 'armed.json'), 'utf8'))
      assert.equal(armed.appPid, 1)
      assert.equal(armed.kind, 'restart')
      assert.equal(armed.by, 'meta-wizard')
      assert.equal(armed.foreground, false)
      assert.equal(armed.launch.exe, 'C:\\Conductor.exe')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('a phone alert names the tab it is about, and goes without it to a Conductor that refuses the argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meta-wizard-alert-'))
    try {
      const calls = []
      await writeFile(join(root, 'control-owner.json'), JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:5555/control', token: 'ab', pid: 1, startedAt: iso(-3_600_000) }))
      await mkdir(join(root, 'recovery'), { recursive: true })
      await writeFile(join(root, 'recovery', 'armed.json'), JSON.stringify({ kind: 'running', appPid: 1, at: iso(-3_600_000), launch: { exe: 'C:\\Conductor.exe', args: [] } }))
      // Steered twice already about this wait: this tick escalates to the owner.
      const fingerprint = `await-deadline:w:${iso(-70 * MIN)}`
      await mkdir(join(root, 'meta-wizard'), { recursive: true })
      await writeFile(join(root, 'meta-wizard', 'state.json'), JSON.stringify({ version: 1, lastPid: 1, ledger: { steered: { [fingerprint]: { at: T0 - 20 * MIN, count: 2 } } } }))
      const waiter = tab('w', { awaiting: { agents: ['c'], since: iso(-70 * MIN), deadline: iso(-10 * MIN), reason: null }, lastActivityAt: iso(-60 * MIN) })
      const controlCall = async (credential, method, args) => {
        calls.push({ method, args })
        if (method === 'tools.list') return {}
        if (method === 'supervisor.overview') return { observedAt: iso(0), pid: 1, updates: null, localBuild: null, tabs: [waiter, tab('c')] }
        if (method === 'supervisor.alert') {
          if (args.agentSessionId) throw new Error('supervisor.alert accepts only title, body; agentSessionId is not an argument.')
          return { delivered: 'pushed to 2 phones' }
        }
        throw new Error(method)
      }
      const service = createService({ userData: root, testProfile: true, deps: { now: () => T0, controlCall, pidAlive: () => true, toast: async () => 'ok', sleep: async () => {} } })
      await service.tick()
      const pushes = calls.filter(call => call.method === 'supervisor.alert').map(call => call.args)
      assert.deepEqual(pushes.map(args => [args.title, args.agentSessionId ?? null]), [['Conductor: w is stuck', 'w'], ['Conductor: w is stuck', null]], 'tried with the tab, then without for the older app')
      const journal = (await readFile(join(root, 'meta-wizard', 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.deepEqual(journal.filter(entry => entry.event === 'alert').map(entry => [entry.agentSessionId, entry.phone]), [['w', 'pushed to 2 phones']])
      // Told once: the next tick says nothing more.
      await service.tick()
      assert.equal(calls.filter(call => call.method === 'supervisor.alert').length, 2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
