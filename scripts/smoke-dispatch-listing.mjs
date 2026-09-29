// Clause 5 of feature item permission-approval-delivery-classifier (2026-09-28, Haftheme report):
// "agents.list from the controller does not list coworkers it dispatched with router.dispatch, and a
// finished router.dispatch coworker's tab disappears, so agents.steer to it returns 'outside this
// workspace or has no visible tab'". Driven in a parked Electron window with a synthetic Claude CLI
// (no inference), from the controller's own credential:
//   D1 router.dispatch into the controller's project: agents.list lists both coworkers with their tabs;
//   D2 a finished coworker closed by agents.finish stays listed (finished:true, tabId:null), and
//      agents.steer reopens it in the background and runs a turn (reopened:true, delivery "started");
//   D3 agents.steer into a coworker's running turn answers delivery "steered", not "queued";
//   D4 router.dispatch into another open project with no wizard: listed (crossProject, controlled);
//      finished and closed, it stays listed and agents.steer reopens it;
//   D5 router.dispatch into a project with a wizard hands the task to that wizard (deliveredTo, no
//      tab, nothing new to list), as ddbc6fb decided.
//   node scripts/smoke-lock.mjs --timeout-min 15 -- node scripts/smoke-dispatch-listing.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'dispatch-listing', output: 'artifacts/dispatch-listing' })
watchdog(900)

const capture = join(tmpdir(), `conductor-dispatch-listing-capture-${process.pid}.txt`)
// HOLD keeps the turn running (a steer into it is answered with text), anything else answers at
// once. Every prompt is written to the capture file, whose app-control briefing carries the tab's
// own credential.
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
  if (holding) { text('Steered in: ' + prompt.slice(0, 60)); return }
  emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' })
  if (prompt.includes('LISTING HOLD')) { holding = true; text('Working on it.'); return }
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
const phaseOf = async (id, projectId) => (await call('agents.status', { agentSessionId: id }, projectId ? { projectId } : {})).phase
const settledAs = (id, phase, label, projectId) => poll(async () => await phaseOf(id, projectId) === phase, { timeoutMs: 45_000, label: `${label} ${phase}` })
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}
const row = (rows, id) => rows.find(entry => entry.agentSessionId === id)
const worker = title => ({ title, prompt: `LISTING ${title}`, provider: 'claude', model: 'synthetic-claude' })

try {
  step('launch; open a target project, then the controller\'s project')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  const target = await openProject({ name: 'conductor target', git: true })
  const wizardHome = await openProject({ name: 'wizard project', git: true })
  const home = await openProject({ name: 'haftheme', git: true })
  const view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)
  // The synthetic model is offered once a first CLI has initialized, so the controller opens on the Fable id (not a wizard).
  const controller = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Haftheme controller' })
  const auth = await credentialAfter(() => call('agents.submit', { agentSessionId: controller.resourceId, prompt: 'LISTING plan the fixes' }))
  await settledAs(controller.resourceId, 'completed', 'controller')

  // ------------------------------------------------------------------ D1
  step('D1 router.dispatch into the controller\'s own project, then agents.list')
  const [held, quick] = await tabCall(auth, 'router.dispatch', { tasks: [worker('HOLD fixer A'), worker('fixer B')] })
  assert.ok(held.accepted && quick.accepted && held.tabId && quick.tabId, JSON.stringify([held, quick]))
  await settledAs(held.agentSessionId, 'running', 'fixer A')
  await settledAs(quick.agentSessionId, 'completed', 'fixer B')
  let listed = await tabCall(auth, 'agents.list')
  for (const coworker of [held, quick]) {
    const entry = row(listed, coworker.agentSessionId)
    assert.ok(entry, `agents.list lists ${coworker.agentSessionId}: ${JSON.stringify(listed.map(item => item.agentSessionId))}`)
    assert.equal(entry.tabId, coworker.tabId)
  }
  assert.equal(row(listed, held.agentSessionId).phase, 'running')
  record('D1', 'PASS', { listed: listed.length }, `both router.dispatch coworkers listed with their tabs (${held.agentSessionId} running, ${quick.agentSessionId} completed)`)

  // ------------------------------------------------------------------ D2
  step('D2 a finished coworker closed by agents.finish stays listed and reachable')
  const closed = await tabCall(auth, 'agents.finish', { agentSessionId: quick.agentSessionId })
  await poll(async () => !(await call('tabs.list')).some(tab => tab.resourceId === quick.agentSessionId), { timeoutMs: 20_000, label: 'fixer B tab closed' })
  listed = await tabCall(auth, 'agents.list')
  const gone = row(listed, quick.agentSessionId)
  assert.ok(gone, 'the closed coworker is still listed: ' + JSON.stringify(listed.map(item => item.agentSessionId)))
  assert.equal(gone.finished, true); assert.equal(gone.tabId, null)
  const reply = await tabCall(auth, 'agents.steer', { agentSessionId: quick.agentSessionId, prompt: 'LISTING one more check' })
  assert.equal(reply.reopened, true, JSON.stringify(reply)); assert.equal(reply.delivery, 'started')
  await settledAs(quick.agentSessionId, 'completed', 'reopened fixer B')
  listed = await tabCall(auth, 'agents.list')
  assert.ok(row(listed, quick.agentSessionId)?.tabId, 'reopened: listed with a tab again')
  record('D2', 'PASS', {}, `agents.finish closed ${quick.agentSessionId} (${JSON.stringify(closed).slice(0, 120)}); listed finished:true tabId:null; agents.steer reopened it (reopened:true, delivery started) and it ran a turn`)

  // ------------------------------------------------------------------ D3
  step('D3 agents.steer into a running turn says "steered"')
  const steered = await tabCall(auth, 'agents.steer', { agentSessionId: held.agentSessionId, prompt: 'LISTING also look at the pool size' })
  assert.equal(steered.delivery, 'steered', JSON.stringify(steered))
  await poll(async () => (await call('agents.snapshot', { agentSessionId: held.agentSessionId })).items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && /Steered in/.test(item.data.text)), { timeoutMs: 20_000, label: 'the steer reached the running turn' })
  assert.equal(await phaseOf(held.agentSessionId), 'running')
  await tabCall(auth, 'agents.interrupt', { agentSessionId: held.agentSessionId })
  record('D3', 'PASS', {}, 'agents.steer into the running turn answered delivery "steered" and the running CLI received it in that turn')

  // ------------------------------------------------------------------ D4
  step('D4 router.dispatch into another open project with no wizard')
  const [away] = await tabCall(auth, 'router.dispatch', { tasks: [{ ...worker('cross-project fixer'), projectId: target.id }] })
  assert.ok(away.accepted && away.tabId && away.projectId === target.id, JSON.stringify(away))
  await settledAs(away.agentSessionId, 'completed', 'cross-project fixer', target.id)
  listed = await tabCall(auth, 'agents.list')
  const there = row(listed, away.agentSessionId)
  assert.ok(there, 'the cross-project coworker is listed: ' + JSON.stringify(listed.map(item => item.agentSessionId)))
  assert.equal(there.crossProject, true); assert.equal(there.controlled, true); assert.equal(there.tabId, away.tabId)
  await tabCall(auth, 'agents.finish', { agentSessionId: away.agentSessionId })
  await poll(async () => !(await call('tabs.list', {}, { projectId: target.id })).some(tab => tab.resourceId === away.agentSessionId), { timeoutMs: 20_000, label: 'cross-project tab closed' })
  listed = await tabCall(auth, 'agents.list')
  const closedThere = row(listed, away.agentSessionId)
  assert.ok(closedThere?.finished && closedThere.crossProject && closedThere.tabId === null, JSON.stringify(closedThere))
  const again = await tabCall(auth, 'agents.steer', { agentSessionId: away.agentSessionId, prompt: 'LISTING follow up across projects' })
  assert.equal(again.reopened, true, JSON.stringify(again)); assert.equal(again.delivery, 'started')
  await settledAs(away.agentSessionId, 'completed', 'reopened cross-project fixer', target.id)
  record('D4', 'PASS', {}, `cross-project coworker ${away.agentSessionId} listed (crossProject, controlled); after agents.finish listed finished:true crossProject; agents.steer reopened it in its project and it ran a turn`)

  // ------------------------------------------------------------------ D5
  step('D5 router.dispatch into a project with a wizard goes to the wizard')
  const wizard = await call('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Wizard project orchestrator' }, { projectId: wizardHome.id })
  await poll(() => call('agents.status', { agentSessionId: wizard.resourceId }, { projectId: wizardHome.id }), { timeoutMs: 30_000, label: 'wizard tab' })
  await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'claude-fable-5-1' }) }, wizard.resourceId)
  await poll(async () => (await call('projects.list')).some(project => project.id === wizardHome.id && project.wizards?.some(entry => entry.agentSessionId === wizard.resourceId)), { timeoutMs: 20_000, label: 'wizard listed' })
  const before = (await tabCall(auth, 'agents.list')).length
  const [handed] = await tabCall(auth, 'router.dispatch', { tasks: [{ ...worker('wizard-bound fix'), projectId: wizardHome.id }] })
  assert.equal(handed.deliveredTo?.agentSessionId, wizard.resourceId, JSON.stringify(handed))
  assert.ok(!handed.tabId, 'no tab is opened')
  await settledAs(wizard.resourceId, 'completed', 'wizard', wizardHome.id)
  assert.equal((await tabCall(auth, 'agents.list')).length, before, 'nothing new to list: the wizard is not a coworker')
  record('D5', 'PASS', {}, `handed to wizard ${wizard.resourceId} (delivery ${handed.delivery}); no tab opened, agents.list unchanged; the wizard answers with send_message`)

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
