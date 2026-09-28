// Workspace clarity (feature-list `workspace-clarity`, src/shared/workspace-clarity.ts): the owner's
// 2026-09-28 "local models" workspace in miniature - one live wizard, two running coworkers, twenty
// finished coworkers and a failed old wizard that still holds its links - driven in a parked
// Electron window with a synthetic Claude CLI (no inference):
//   S1 sidebar: the live wizard on top as the only MAIN, its two running coworkers nested under it,
//      everything finished in one collapsed "Done (N)" group; the failed predecessor reads "ended";
//   S2 tab strip: MAIN first, then the running coworkers; unseen finished tabs are out of the strip
//      (the strip's check button counts them); exactly one MAIN marker;
//   S3 "Close finished" in the sidebar closes the finished tabs after a confirm, history kept;
//   S4 the sweep: a finished, unseen tab older than the age closes itself; a pinned one, the one on
//      screen, the wizard and running tabs stay;
//   S5 a controller messaging its auto-closed coworker reopens it in the background and runs a turn;
//   S6 the owner and a wizard messaging a closed conversation of their workspace reopen it.
// Screenshots: artifacts/workspace-clarity/*.png. `--before` runs the setup against another build
// (CONDUCTOR_SMOKE_MAIN) and only takes the "before" screenshots.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-workspace-clarity.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const BEFORE = process.argv.includes('--before')
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'workspace-clarity', output: 'artifacts/workspace-clarity' })
watchdog(BEFORE ? 600 : 1200)

const capture = join(tmpdir(), `conductor-clarity-capture-${process.pid}.txt`)
// A frontier model id (wizard mode needs one) and three behaviours: HOLD keeps the turn running,
// FAIL ends it as failed, anything else answers at once. Every prompt is written to the capture
// file, whose app-control briefing carries the tab's own credential.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const text = value => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: value }] } })
let holding = false
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    const response = kind === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    if (kind === 'interrupt' && holding) { holding = false; emit({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }) }
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  if (holding) return
  emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' })
  if (prompt.includes('CLARITY HOLD')) { holding = true; text('Working on it.'); return }
  if (prompt.includes('CLARITY FAIL')) { text('This went wrong.'); emit({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }); return }
  text('Done: ' + prompt.split('\\n', 1)[0].slice(0, 60))
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const tabCall = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 800)}`)
  return body.result
}
const phaseOf = async id => (await call('agents.status', { agentSessionId: id })).phase
const settledAs = (id, phase, label) => poll(async () => await phaseOf(id) === phase, { timeoutMs: 45_000, label: `${label} ${phase}` })
const openTabIds = async () => (await call('tabs.list')).filter(tab => tab.kind === 'agent').map(tab => tab.resourceId)

/** The tab's own credential, from the briefing its first prompt carried. */
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}
const becomeWizard = async (view, id) => view.evaluate(async id => {
  const state = await window.conductor.structured.snapshot(id)
  await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'claude-fable-5-1' })
}, id)

let view
try {
  step('launch and open the project')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FINISHED_TAB_SWEEP_MS: 10_000 } })
  await openProject({ name: 'local models', git: true })
  view = await page(inst)
  if (!BEFORE) {
    assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
    assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)
  }

  step('the old wizard dispatches twenty coworkers, which finish, then fails')
  const old = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Conductor orchestrator' })
  await becomeWizard(view, old.resourceId)
  const oldAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: old.resourceId, prompt: 'CLARITY plan the local models work' }))
  await settledAs(old.resourceId, 'completed', 'old wizard')
  const topics = ['llama slots', 'qwen context', 'dolphin grammar', 'ornith speed', 'swarm caps', 'web extraction', 'energy card', 'local stop', 'model routing', 'fx44 compare', 'server admission', 'research grant', 'git grant', 'rollover', 'tool budget', 'grammar repair', 'vram check', 'port reuse', 'anon mode', 'checkpoint']
  const finished = []
  for (const topic of topics) {
    const tab = await tabCall(oldAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'Conductor coworker: ' + topic })
    await tabCall(oldAuth, 'agents.submit', { agentSessionId: tab.resourceId, prompt: 'CLARITY ' + topic })
    finished.push(tab)
  }
  for (const tab of finished) await settledAs(tab.resourceId, 'completed', tab.title)
  await call('agents.submit', { agentSessionId: old.resourceId, prompt: 'CLARITY FAIL the old wizard stops here' })
  await settledAs(old.resourceId, 'failed', 'old wizard')

  step('the live wizard dispatches two coworkers that keep running')
  const wizard = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Conductor orchestrator (continued)' })
  await becomeWizard(view, wizard.resourceId)
  const wizardAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: wizard.resourceId, prompt: 'CLARITY take over from the old wizard' }))
  await settledAs(wizard.resourceId, 'completed', 'live wizard')
  const running = []
  for (const title of ['Coworker: sidebar grouping', 'Coworker: strip overflow']) {
    const tab = await tabCall(wizardAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title })
    await tabCall(wizardAuth, 'agents.submit', { agentSessionId: tab.resourceId, prompt: 'CLARITY HOLD ' + title })
    running.push(tab)
  }
  for (const tab of running) await settledAs(tab.resourceId, 'running', tab.title)
  await call('tabs.focus', { tabId: wizard.id })
  await view.waitForTimeout(6500) // facts poll every 5 s
  record('setup', 'INFO', { finished: finished.length, running: running.length }, `old wizard ${old.resourceId} failed; live wizard ${wizard.resourceId}`)
  const before = await shot(BEFORE ? 'before-workspace' : 'after-workspace')
  record('screenshot', 'INFO', {}, before)

  if (BEFORE) {
    const chips = await view.locator('.pane-tabs .pane-tab').count()
    const mains = await view.locator('.agent-control-marker').filter({ hasText: /^MAIN/ }).count()
    const rows = await view.locator('.session-tree .workspace-tab-row').count()
    record('before', 'INFO', { chips, mainMarkers: mains, sidebarRows: rows }, 'the build before workspace clarity')
    await finish({ code: 0 })
  }

  // ------------------------------------------------------------------ S1 sidebar
  step('S1 sidebar: live work first, one MAIN, finished in Done')
  const tree = view.locator('.session-tree .workspace-tab-tree').first()
  const rows = tree.locator(':scope > .workspace-tab-row')
  await poll(async () => await rows.first().getAttribute('data-clarity-row') === wizard.id, { timeoutMs: 20_000, label: 'the wizard on top of the sidebar' })
  assert.equal(await tree.locator('.workspace-tab-role.main').count(), 1, 'exactly one Main badge')
  assert.equal(await rows.first().locator('.workspace-tab-role.main').count(), 1, 'the Main badge is on the live wizard')
  const nested = await rows.evaluateAll(nodes => nodes.slice(1, 3).map(node => ({ id: node.getAttribute('data-clarity-row'), child: node.classList.contains('coworker-child'), status: node.getAttribute('data-clarity-status') })))
  assert.deepEqual(new Set(nested.map(entry => entry.id)), new Set(running.map(tab => tab.id)))
  assert.ok(nested.every(entry => entry.child && entry.status === 'running'), JSON.stringify(nested))
  const doneToggle = tree.locator('.workspace-done-toggle')
  await poll(async () => (await doneToggle.textContent())?.includes(`Done (${finished.length + 1})`), { timeoutMs: 20_000, label: 'Done group count' })
  assert.equal(await doneToggle.getAttribute('aria-expanded'), 'false', 'Done is collapsed by default')
  await doneToggle.click()
  const oldRow = tree.locator(`.workspace-done-group [data-clarity-row="${old.id}"]`)
  assert.equal((await oldRow.locator('.workspace-tab-status').textContent())?.trim(), 'ended')
  assert.equal(await oldRow.locator('.workspace-tab-role').count(), 0, 'the failed predecessor wears no MAIN')
  const doneOrder = await tree.locator('.workspace-done-group .workspace-tab-row').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-clarity-row')))
  assert.equal(doneOrder[0], old.id, 'newest first: the old wizard failed last')
  await shot('after-sidebar-done-open')
  await doneToggle.click()
  record('S1', 'PASS', { liveRows: 3, done: finished.length + 1 }, 'wizard on top with the only Main badge; two running coworkers nested; Done (21) collapsed, newest first; old wizard reads "ended"')

  // ------------------------------------------------------------------ S2 strip
  step('S2 tab strip: MAIN first, finished out of the way')
  const chips = view.locator('.pane-tabs .pane-tab')
  const order = await chips.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-control-tab-id')))
  assert.equal(order[0], wizard.id, 'the MAIN leads the strip: ' + JSON.stringify(order))
  assert.deepEqual(new Set(order.slice(1, 3)), new Set(running.map(tab => tab.id)), 'running coworkers next: ' + JSON.stringify(order))
  for (const tab of [old, ...finished]) assert.ok(!order.includes(tab.id), `${tab.title} is out of the strip`)
  const overflow = view.locator('.pane-overflow-button')
  assert.match(await overflow.textContent() ?? '', new RegExp(String(finished.length + 1)))
  const markers = await view.locator('.agent-control-marker b').allTextContents()
  assert.equal(markers.filter(label => label === 'MAIN').length, 1, 'one MAIN marker: ' + JSON.stringify(markers))
  const labels = await chips.locator('.pane-tab-title').allTextContents()
  await overflow.click()
  assert.equal(await view.locator('.pane-overflow-menu button').count(), finished.length + 1)
  await shot('after-strip-overflow-menu')
  await view.keyboard.press('Escape')
  record('S2', 'PASS', { chips: order.length, hidden: finished.length + 1, markers: markers.length }, `strip ${JSON.stringify(labels)}; markers ${JSON.stringify(markers)}`)

  // ------------------------------------------------------------------ S3 Close finished
  step('S3 Close finished, with a confirm')
  await tree.locator('.workspace-done-close').click()
  const confirm = tree.locator('.workspace-done-confirm')
  assert.match(await confirm.textContent() ?? '', new RegExp(`Close ${finished.length + 1} finished tabs`))
  await confirm.getByRole('button', { name: `Close ${finished.length + 1}` }).click()
  await poll(async () => { const open = await openTabIds(); return [old, ...finished].every(tab => !open.includes(tab.resourceId)) }, { timeoutMs: 60_000, label: 'finished tabs closed' })
  const stillOpen = await openTabIds()
  for (const tab of [wizard, ...running]) assert.ok(stillOpen.includes(tab.resourceId), `${tab.title} stays open`)
  const snapshot = await view.evaluate(id => window.conductor.structured.snapshot(id), finished[0].resourceId)
  assert.ok(snapshot.items.length > 0, 'history is kept')
  assert.equal(await tree.locator('.workspace-done-group').count(), 0)
  await shot('after-close-finished')
  record('S3', 'PASS', { closed: finished.length + 1, open: stillOpen.length }, 'the confirmed Close finished closed the old wizard and its 20 coworkers; the wizard and running coworkers stayed; history kept')

  // ------------------------------------------------------------------ S4 sweep
  step('S4 the sweep: aged, unseen finished tabs close; pinned, on-screen, wizard and running stay')
  const lead = await openTab({ provider: 'claude', model: 'synthetic-claude', title: 'Lead (not a wizard)' })
  const leadAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: lead.resourceId, prompt: 'CLARITY lead a small batch' }))
  await settledAs(lead.resourceId, 'completed', 'lead')
  const swept = await tabCall(leadAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'Coworker: swept away' })
  await tabCall(leadAuth, 'agents.submit', { agentSessionId: swept.resourceId, prompt: 'CLARITY finish and be swept' })
  const pinned = await tabCall(wizardAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'Coworker: pinned result' })
  await tabCall(wizardAuth, 'agents.submit', { agentSessionId: pinned.resourceId, prompt: 'CLARITY finish and stay pinned' })
  await settledAs(swept.resourceId, 'completed', 'swept coworker')
  await settledAs(pinned.resourceId, 'completed', 'pinned coworker')
  await call('tabs.focus', { tabId: lead.id })
  await view.waitForTimeout(6500)
  await tree.locator('.workspace-done-toggle').click()
  await tree.locator(`[data-clarity-row="${pinned.id}"]`).click({ button: 'right' })
  await view.getByRole('menuitem', { name: 'Pin tab' }).click()
  await poll(async () => (await call('tabs.list')).find(tab => tab.id === pinned.id)?.state?.pinned === true || await view.locator(`[data-clarity-row="${pinned.id}"] .workspace-tab-pin`).count() > 0, { timeoutMs: 10_000, label: 'pinned' })
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(24)), 24)
  await poll(async () => !(await openTabIds()).includes(swept.resourceId), { timeoutMs: 90_000, label: 'the sweep closes the aged coworker' })
  const afterSweep = await openTabIds()
  for (const tab of [pinned, lead, wizard, ...running]) assert.ok(afterSweep.includes(tab.resourceId), `${tab.title} survives the sweep`)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  record('S4', 'PASS', { age: '10 s (test override)' }, 'the aged, unseen coworker closed itself; the pinned one, the lead on screen, the wizard and both running coworkers stayed')

  // ------------------------------------------------------------------ S5 controller reopens
  step('S5 the controller messages its auto-closed coworker')
  const reply = await tabCall(leadAuth, 'agents.steer', { agentSessionId: swept.resourceId, prompt: 'CLARITY one more thing' })
  assert.equal(reply.reopened, true, JSON.stringify(reply))
  assert.equal(reply.delivery, 'started')
  await poll(async () => (await openTabIds()).includes(swept.resourceId), { timeoutMs: 20_000, label: 'reopened tab' })
  await settledAs(swept.resourceId, 'completed', 'reopened coworker')
  const activeAfter = await view.locator('.pane-tab.active').getAttribute('data-control-tab-id')
  assert.equal(activeAfter, lead.id, 'reopened in the background: the owner stays on the tab they were looking at')
  record('S5', 'PASS', {}, `agents.steer from the lead reopened ${swept.resourceId} in the background (reopened:true, delivery started) and it ran a turn`)

  // ------------------------------------------------------------------ S6 owner and wizard reopen
  step('S6 the owner and the wizard message closed conversations of their workspace')
  const byOwner = await call('agents.steer', { agentSessionId: finished[2].resourceId, prompt: 'CLARITY the owner asks again' })
  assert.equal(byOwner.reopened, true, JSON.stringify(byOwner))
  await settledAs(finished[2].resourceId, 'completed', 'owner-reopened coworker')
  const byWizard = await tabCall(wizardAuth, 'agents.steer', { agentSessionId: finished[3].resourceId, prompt: 'CLARITY the wizard follows up' })
  assert.equal(byWizard.reopened, true, JSON.stringify(byWizard))
  await settledAs(finished[3].resourceId, 'completed', 'wizard-reopened coworker')
  const open = await openTabIds()
  assert.ok(open.includes(finished[2].resourceId) && open.includes(finished[3].resourceId))
  await view.waitForTimeout(6500)
  await shot('after-final')
  record('S6', 'PASS', {}, 'owner agents.steer and wizard agents.steer each reopened a conversation closed by Close finished (reopened:true) and it ran a turn')

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
