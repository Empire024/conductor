// VR6 H2 + M3 (docs/verification/2026-09-25-vr6.md). handoff-stops-background-tasks, owner: "Main 1 (old)
// still spins even though it's doing nothing anymore". A plain tab C and a wizard W each arm three
// SYNTHETIC WATCH LOOPS; W hands off (successor:true). W must settle with 0 background tasks and no
// spinner and stay so; the successor keeps its own three; C, which handed nothing off, keeps its
// three and its background indicator (the control: the stop is handoff-only and the harness can see a
// spinner). M3: the parked Windows window keeps its own chrome (no .mac, own window buttons).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr6-handoff.mjs
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr6-handoff', output: 'artifacts/verification/2026-09-25-vr6/handoff' })
watchdog(600)
await loadCheck()
const STEP_MS = 5000, HOLD_MS = 30_000
// The fixture writes each prompt and each stop_task here; the paths must exist before the launch.
const side = await mkdtemp(join(tmpdir(), 'conductor-vr6-handoff-side-'))
const capture = join(side, 'provider-input.txt'), stopLog = join(side, 'stop-task.log')
try {
  const inst = await launchParked({ env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_SMOKE_STEP_MS: STEP_MS, CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_STOP_TASK_LOG: stopLog } })
  await scenario(inst)
} catch (error) { await failed(error, 'H2') }
await finish()

async function scenario(inst) {
  const view = await page(inst)
  // M3: Windows chrome unchanged by MACRT.
  step('M3 window chrome')
  await view.locator('.titlebar').first().waitFor({ timeout: 30_000 })
  const chrome = await view.evaluate(() => ({ titlebar: document.querySelector('.titlebar')?.className ?? null, controls: document.querySelectorAll('.window-controls button').length, platform: window.conductor?.platform ?? navigator.platform }))
  record('M3-windows-chrome', chrome.titlebar === 'titlebar' && chrome.controls >= 3 ? 'PASS' : 'FAIL', chrome, 'parked Windows window: .titlebar without .mac and own window buttons')

  await openProject({ name: 'VR6 handoff' })
  const snap = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const submit = (id, prompt, wizard) => view.evaluate(async ([value, text, wand]) => {
    await window.conductor.structured.connect(value)
    const state = await window.conductor.structured.snapshot(value)
    const settings = { ...state.settings, wizard: wand, model: 'claude-fable-5-1', effort: 'high' }
    await window.conductor.structured.saveSettings(value, settings)
    await window.conductor.structured.submit(value, text, settings, [])
  }, [id, prompt, wizard])
  // Rows show short labels ("…W (continued)") and a finished tab sits under a collapsed Done, so rows
  // are found by tab id (data-clarity-row), with Done opened when the row is not among the live ones.
  const tabRow = async tabId => {
    const row = view.locator(`[data-clarity-row="${tabId}"]`)
    if (!await row.count()) await view.locator('.workspace-done-toggle[aria-expanded="false"]').first().click().catch(() => {})
    return row.first()
  }
  /** A row's activity indicator class; '' when the row shows none (a Done row never does). */
  const activity = async tabId => { const indicator = (await tabRow(tabId)).locator('.tab-activity'); return (await indicator.count() ? await indicator.first().getAttribute('class') : null) ?? '' }
  const stops = async () => (await readFile(stopLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))

  step('control tab C arms three loops without a handoff')
  const cTab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'VR6 control C' }), c = cTab.resourceId
  await submit(c, 'SYNTHETIC WATCH LOOPS control tab, no handoff', false)
  await poll(async () => (await snap(c))?.phase === 'completed' && (await snap(c)).backgroundTasks === 3, { timeoutMs: STEP_MS + 20_000, label: 'C completed with 3 background tasks' })

  step('wizard W arms three loops')
  const wTab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'VR6 wizard W' }), w = wTab.resourceId
  await rm(capture, { force: true })
  await submit(w, 'SYNTHETIC WATCH LOOPS arm the watchers, then hand off', true)
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 20_000, label: "W's control briefing" })
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  const asW = async (method, args = {}) => {
    const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const body = await response.json()
    if (response.status !== 200 || body.error) throw new Error(`${method} as W -> ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 500)}`)
    return body.result
  }
  await poll(async () => (await snap(w))?.backgroundTasks === 3, { timeoutMs: 15_000, label: 'W has 3 background tasks' })
  await poll(async () => (await asW('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: 'W is the wizard' })

  step('W hands off')
  const handoff = 'SYNTHETIC WATCH LOOPS successor: continue the swarm.\n\n' + [['Objective', 'Continue as the wizard.'], ['Constraints', 'Local commits only.'], ['Owned files', 'None.'], ['Verified findings', 'Three loops armed by the predecessor.'], ['Remaining work', 'Re-arm your own watchers.'], ['Artifact references', 'artifacts/verification/2026-09-25-vr6/handoff']].map(([h, l]) => h + '\n- ' + l).join('\n\n')
  const result = await asW('agents.handoff', { handoff, successor: true })
  const handedAt = Date.now()
  await poll(async () => (await snap(w))?.phase === 'completed', { timeoutMs: STEP_MS + 15_000, label: 'W step settles' })
  const settledMs = Date.now() - handedAt
  await poll(async () => ((await snap(w))?.backgroundTasks ?? 0) === 0, { timeoutMs: 10_000, intervalMs: 100, label: 'W background tasks 0' })
  const drainedMs = Date.now() - handedAt
  await poll(async () => (await snap(result.agentSessionId))?.phase === 'completed' && (await snap(result.agentSessionId)).backgroundTasks === 3, { timeoutMs: STEP_MS + 20_000, label: 'successor completed with its own 3' })

  step(`hold ${HOLD_MS / 1000} s, then read every tab`)
  await sleep(HOLD_MS)
  const wSnap = await snap(w), sSnap = await snap(result.agentSessionId), cSnap = await snap(c)
  const list = await call('agents.list')
  const wAgent = list.find(agent => agent.agentSessionId === w), cAgent = list.find(agent => agent.agentSessionId === c)
  const numbers = {
    settledMs, drainedMs,
    w: { phase: wSnap.phase, bg: wSnap.backgroundTasks, listPhase: wAgent?.phase, supersededBy: wAgent?.superseded?.by ?? null, activity: await activity(wTab.id) },
    successor: { phase: sSnap.phase, bg: sSnap.backgroundTasks, wizard: sSnap.settings?.wizard, activity: await activity(result.tabId) },
    c: { phase: cSnap.phase, bg: cSnap.backgroundTasks, listPhase: cAgent?.phase, activity: await activity(cTab.id) },
    stops: (await stops()).length
  }
  await call('tabs.focus', { tabId: wTab.id }).catch(() => {})
  await sleep(700)
  const evidence = await shot('h2-handed-off-tab')
  const wSettled = numbers.w.phase === 'completed' && numbers.w.bg === 0 && numbers.w.supersededBy === result.agentSessionId && !/working|waiting_background/.test(numbers.w.activity)
  const successorKept = numbers.successor.bg === 3 && numbers.successor.wizard === true && /waiting_background/.test(numbers.successor.activity)
  const controlKept = numbers.c.bg === 3 && /waiting_background/.test(numbers.c.activity)
  record('H2-control-no-handoff', controlKept ? 'PASS' : 'FAIL', numbers.c, 'a tab that did not hand off keeps its 3 loops and its background indicator after the same wait')
  record('H2-handoff-settles', wSettled && successorKept && numbers.stops === 3 ? 'PASS' : 'FAIL', numbers, `W 0 bg + no spinner ${HOLD_MS / 1000} s after settle; successor keeps 3 + wizard; exactly 3 stop_task; ${evidence}`)
}
