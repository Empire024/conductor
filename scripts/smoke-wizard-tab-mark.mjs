// Parked check: wand on the live wizard tab, one-line sender in the agent message card.
// node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-wizard-tab-mark.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const BEFORE = process.argv.includes('--before')
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'wizard-tab-mark', output: 'artifacts/wizard-tab-mark' })
watchdog(BEFORE ? 600 : 1200)

const capture = join(tmpdir(), `conductor-clarity-capture-${process.pid}.txt`)
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
  const wand = view.locator('.pane-tabs .pane-tab .pane-tab-wizard')
  await poll(async () => await wand.count() === 1, { timeoutMs: 20000, label: 'one wand in the strip' })
  assert.equal(await view.locator('.pane-tabs .pane-tab[data-live-wizard="true"]').first().getAttribute('data-control-tab-id'), wizard.id)
  record('wand', 'PASS', {}, 'exactly one live-wizard wand, on the live wizard')
  await shot('after-wizard-strip')
  const card = await view.evaluate(() => {
    const host = document.querySelector('.sa-conversation, .structured-agent-pane, main') || document.body
    const box = document.createElement('div'); box.id = 'smoke-card'; box.style.cssText = 'position:fixed;left:40px;bottom:60px;width:360px;z-index:99999;background:#0d1117'
    box.innerHTML = '<details class="sa-agent-message sa-agent-message-received sa-incoming-card sa-incoming-card-agent" open><summary><span class="sa-agent-message-head"><span class="sa-sender-badge sa-sender-agent">Agent message</span><span class="sa-incoming-from">from</span> <button class="sa-role-coordinated sa-conversation-link" title="x"><svg width=11 height=11></svg><span class="sa-conversation-link-label">Objective Lead the HAF Ops Metrc compliance rollout for the whole quarter</span></button></span></summary><div class="sa-agent-message-body">docs-deploy-59 committed on branch docs-deploy-59 and a long body line follows here</div></details>'
    host.appendChild(box)
    const l = box.querySelector('.sa-conversation-link').getBoundingClientRect(), b = box.querySelector('.sa-agent-message-body').getBoundingClientRect()
    return { linkHeight: l.height, linkBottom: l.bottom, bodyTop: b.top }
  })
  assert.ok(card.linkHeight < 32 && card.linkBottom <= card.bodyTop, JSON.stringify(card))
  record('card', 'PASS', card, 'long sender stays one line above the body')
  await shot('after-agent-card')
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
