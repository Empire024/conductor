// VR4 F1/F2 (docs/verification/2026-09-25-vr4.md), dispatch-no-focus-steal. Owner: "whenever you dispatch a
// tab, my focus goes there ... my focus should only go there if the agent wants that, by default not".
// The owner types in their own tab A while a controller in a background tab B opens tabs through each
// agent entry point. Measured: the active tab, where the caret is, the text typed, and every main-process
// call that can take OS focus (BrowserWindow focus/show/moveTop/restore/flashFrame, app.focus), wrapped.
//   F1  router.dispatch (2 coworkers) + tabs.open; control: tabs.open focus:true moves after the pause.
//   F2  agents.handoff and ideas.work from B; control: tabs.focus from B moves after the pause.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr4-focus.mjs
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr4-focus', output: 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4' })
watchdog(15 * 60)
await loadCheck()

const capture = join(tmpdir(), `vr4-focus-capture-${process.pid}.txt`)
const HANDOFF = `SYNTHETIC LONG 2 VR4 handoff.

Objective
- Continue the VR4 focus check in a fresh tab; nothing else.

Constraints
- Parked profile only; never take the owner's focus.

Owned files
- None.

Verified findings
- The owner is typing in tab A; this tab only opens a successor.

Remaining work
- Report to the owner when the owner asks.

Artifact references
- artifacts/verification/2026-09-25-vr4/results.md`

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable' } })
  await openProject({ name: 'VR4 focus', git: true })
  const view = await page(inst)
  await inst.app.evaluate(({ BrowserWindow, app }) => {
    globalThis.__vr4Focus = []
    for (const name of ['focus', 'show', 'moveTop', 'restore', 'flashFrame', 'setAlwaysOnTop']) {
      const original = BrowserWindow.prototype[name]
      if (typeof original !== 'function') continue
      BrowserWindow.prototype[name] = function (...args) { globalThis.__vr4Focus.push(name); return original.apply(this, args) }
    }
    const focus = app.focus.bind(app)
    app.focus = (...args) => { globalThis.__vr4Focus.push('app.focus'); return focus(...args) }
  })
  const focusCalls = async (reset = false) => inst.app.evaluate((_, clear) => { const calls = globalThis.__vr4Focus.slice(); if (clear) globalThis.__vr4Focus.length = 0; return calls }, reset)

  step('controller tab B and its credential')
  // agents.handoff reopens the caller's model, which must be one models.list offers (VR3 M1's setup).
  const tabB = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'VR4 controller B' })
  await call('agents.submit', { agentSessionId: tabB.resourceId, prompt: 'SYNTHETIC B the controller that dispatches coworkers' })
  const briefing = await poll(() => { try { const text = readFileSync(capture, 'utf8'); return text.includes('Conductor app control:') ? text : null } catch { return null } }, { timeoutMs: 60_000, label: 'controller briefing' })
  const controller = { endpoint: /POST (http:\/\/127\.0\.0\.1:\d+\/control)/.exec(briefing)[1], token: /Bearer ([a-f0-9]{64})/.exec(briefing)[1] }
  await poll(async () => ['completed', 'idle'].includes((await call('agents.status', { agentSessionId: tabB.resourceId })).phase), { timeoutMs: 60_000, label: 'B turn' })
  const asB = async (method, args = {}) => {
    const response = await fetch(controller.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${controller.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000) })
    const body = await response.json()
    if (response.status !== 200 || body.error) throw new Error(`${method} as B -> ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 400)}`)
    return body.result
  }

  step("the owner's own tab A")
  const tabA = await openTab({ provider: 'claude', title: 'VR4 owner tab A' })
  const activeTab = () => view.evaluate(() => document.querySelector('.pane-tab.active')?.getAttribute('data-control-tab-id') ?? null)
  await view.locator(`.pane-tab[data-control-tab-id="${tabA.id}"]`).click()
  await poll(async () => (await activeTab()) === tabA.id, { timeoutMs: 15_000, label: 'tab A active' })
  const composer = view.locator(`.structured-agent-pane[data-structured-session="${tabA.resourceId}"]`).getByRole('textbox').first()
  await composer.click()
  const caret = () => view.evaluate(() => { const element = document.activeElement; return { session: element?.closest('.structured-agent-pane')?.getAttribute('data-structured-session') ?? null, value: element && 'value' in element ? element.value : null } })

  /** The owner types `sentence` into A while `act` runs; samples the active tab and caret every 100 ms. */
  const whileTyping = async (sentence, act) => {
    await focusCalls(true)
    const typing = composer.pressSequentially(sentence, { delay: 45 })
    await sleep(300)
    let moved = 0, caretLeft = 0, done = false
    void typing.then(() => { done = true })
    const outcome = await act()
    while (!done) { if (await activeTab() !== tabA.id) moved++; if ((await caret()).session !== tabA.resourceId) caretLeft++; await sleep(100) }
    await sleep(1500)
    if (await activeTab() !== tabA.id) moved++
    return { outcome, moved, caretLeft, calls: await focusCalls(true), active: await activeTab() }
  }
  const typed = []

  // ---- F1
  try {
    step('F1 router.dispatch + tabs.open from B while the owner types in A')
    const sentence = 'The owner keeps typing while the controller dispatches.'
    typed.push(sentence)
    const result = await whileTyping(sentence, async () => {
      const dispatched = await asB('router.dispatch', { tasks: [{ title: 'VR4 coworker one', prompt: 'SYNTHETIC B coworker one', provider: 'claude' }, { title: 'VR4 coworker two', prompt: 'SYNTHETIC B coworker two', provider: 'claude' }] })
      const opened = await asB('tabs.open', { kind: 'agent', provider: 'claude', title: 'VR4 coworker three' })
      return { dispatched: dispatched.length, opened: opened.id }
    })
    const text = (await caret()).value
    const newMarks = await view.locator('.pane-tab-new-mark').count()
    await shot('F1-after-dispatch')
    // Control: focus:true is honoured once the owner stops typing.
    const wanted = await asB('tabs.open', { kind: 'agent', provider: 'claude', title: 'VR4 look here', focus: true })
    const movedTo = await poll(async () => (await activeTab()) === wanted.id ? wanted.id : null, { timeoutMs: 20_000, label: 'focus:true tab active' }).catch(() => null)
    const controlCalls = await focusCalls(true)
    const pass = result.moved === 0 && result.caretLeft === 0 && result.calls.length === 0 && text === typed.join('') && newMarks >= 1 && result.outcome.dispatched === 2
    record('F1', pass ? 'PASS' : 'FAIL', { moved: result.moved, caretLeft: result.caretLeft, osFocusCalls: result.calls, textKept: text === typed.join(''), newMarks, control: { focusTrueMoved: Boolean(movedTo), osFocusCalls: controlCalls } }, `2 dispatched + 1 tabs.open from background tab B; F1-after-dispatch.png`)
    if (!movedTo) record('F1 control', 'FAIL', {}, 'tabs.open focus:true never brought its tab into view: the harness cannot see a focus move')
    await view.locator(`.pane-tab[data-control-tab-id="${tabA.id}"]`).click()
    await poll(async () => (await activeTab()) === tabA.id, { timeoutMs: 15_000, label: 'back to tab A' })
    await composer.click()
  } catch (error) { await failed(error, 'F1') }

  // ---- F2
  try {
    step('F2 agents.handoff and ideas.work from B while the owner types in A')
    const idea = await call('ideas.capture', { text: 'VR4 focus dry-run idea\nA harmless note for the focus check.' })
    const sentence = ' Still typing through a handoff and an idea.'
    typed.push(sentence)
    const result = await whileTyping(sentence, async () => {
      const handoff = await asB('agents.handoff', { handoff: HANDOFF, title: 'VR4 successor' }).catch(error => ({ error: String(error.message) }))
      const work = await asB('ideas.work', { ideaId: idea.id ?? idea.ideaId, provider: 'claude' }).catch(error => ({ error: String(error.message) }))
      return { handoff: handoff.error ?? handoff.tabId ?? handoff.id ?? 'ok', work: work.error ?? work.tabId ?? work.id ?? 'ok' }
    })
    const text = (await caret()).value
    await shot('F2-after-handoff-and-work')
    // Control: tabs.focus from an agent brings a tab into view after the pause.
    const coworker = (await call('tabs.list', {})).find(tab => tab.title === 'VR4 coworker one')
    const focused = coworker ? await asB('tabs.focus', { tabId: coworker.id }).catch(error => ({ error: String(error.message) })) : { error: 'no coworker tab' }
    const movedTo = coworker ? await poll(async () => (await activeTab()) === coworker.id, { timeoutMs: 20_000, label: 'tabs.focus moved' }).catch(() => false) : false
    const opened = !String(result.outcome.handoff).startsWith('agents.handoff') && !String(result.outcome.work).startsWith('ideas.work')
    const pass = opened && result.moved === 0 && result.caretLeft === 0 && result.calls.length === 0 && text === typed.join('')
    record('F2', pass ? 'PASS' : 'FAIL', { outcome: result.outcome, moved: result.moved, caretLeft: result.caretLeft, osFocusCalls: result.calls, textKept: text === typed.join(''), control: { tabsFocusMoved: Boolean(movedTo), answer: focused.error ?? 'ok' } }, 'F2-after-handoff-and-work.png')
  } catch (error) { await failed(error, 'F2') }
} catch (error) { await failed(error, 'F-setup') }
await finish()
