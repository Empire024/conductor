// "Needs attention" under the projects (feature-list eb5faab5, src/shared/needs-attention.ts),
// driven in a parked Electron window with a synthetic Claude CLI (no inference):
//   N1 two projects: a failed run in each and a pending permission card are listed, with their
//      project; a running tab, a tab waiting for another's results and a completed tab are not;
//   N2 nothing is republished while nothing changes (no renderer churn, so no typing lag);
//   N3 clicking the other project's row shows that project and tab; having looked, it leaves the list;
//   N4 the owner answering the permission card, and a failed tab running again, clear their rows.
// Screenshots: artifacts/verification/2026-09-29-needs-attention/*.png. CONDUCTOR_SMOKE_MAIN runs another build.
//   node scripts/smoke-lock.mjs --timeout-min 15 -- node scripts/smoke-needs-attention.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'needs-attention', output: 'artifacts/verification/2026-09-29-needs-attention' })
watchdog(900)

const capture = join(tmpdir(), `conductor-attention-capture-${process.pid}.txt`)
// HOLD keeps the turn running, FAIL ends it as failed, anything else answers at once.
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
    const response = kind === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }] } : {}
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
  if (prompt.includes('ATTN HOLD')) { holding = true; text('Working on it.'); return }
  if (prompt.includes('ATTN FAIL')) { text('This went wrong.'); emit({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }); return }
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
/** The tab's own credential, from the briefing its first prompt carried (it names the tab's agent id). */
const credentialAfter = async (id, submit) => {
  await rm(capture, { force: true })
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') && text.includes(id) ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing of ' + id })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}
/** The sidebar list as the owner sees it: [reason, tabId, project] per row, and the count. */
const listed = view => view.evaluate(() => {
  const section = document.querySelector('.needs-attention')
  if (!section) return { count: 0, rows: [] }
  return { count: Number(section.getAttribute('data-attention-count')), rows: [...section.querySelectorAll('li button')].map(button => ({ reason: button.getAttribute('data-attention-reason'), tabId: button.getAttribute('data-attention-tab'), project: button.querySelector('small')?.textContent ?? '' })) }
})
const until = (view, predicate, label) => poll(async () => { const now = await listed(view); return predicate(now) ? now : null }, { timeoutMs: 40_000, label })

try {
  step('launch and open two projects')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  const beta = await openProject({ name: 'Beta shop' })
  const view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)
  const betaFail = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Beta build' })
  await call('agents.submit', { agentSessionId: betaFail.resourceId, prompt: 'ATTN FAIL the beta build broke' })
  await settledAs(betaFail.resourceId, 'failed', 'beta build')
  const alpha = await openProject({ name: 'Alpha app' })

  // ------------------------------------------------------------------ N1
  step('N1 failures in both projects and a permission card are listed; running, waiting and done tabs are not')
  const alphaFail = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Alpha failing test' })
  const asker = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Alpha release' })
  const runner = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Alpha long run' })
  const waiter = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Alpha reviewer' })
  const plain = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Alpha plain' })
  await call('agents.submit', { agentSessionId: alphaFail.resourceId, prompt: 'ATTN FAIL a test failed' })
  const askerAuth = await credentialAfter(asker.resourceId, () => call('agents.submit', { agentSessionId: asker.resourceId, prompt: 'ATTN prepare the release' }))
  await settledAs(asker.resourceId, 'completed', 'asker')
  const asked = await tabCall(askerAuth, 'permissions.request', { command: 'npm publish', reason: 'publish the release', rollback: 'npm unpublish within 72 h' })
  const waiterAuth = await credentialAfter(waiter.resourceId, () => call('agents.submit', { agentSessionId: waiter.resourceId, prompt: 'ATTN review it' }))
  await settledAs(waiter.resourceId, 'completed', 'reviewer')
  await call('agents.submit', { agentSessionId: runner.resourceId, prompt: 'ATTN HOLD a long run' })
  await tabCall(waiterAuth, 'agents.await', { agents: [runner.resourceId], reason: 'the long run' })
  await call('agents.submit', { agentSessionId: plain.resourceId, prompt: 'ATTN a plain task' })
  await settledAs(alphaFail.resourceId, 'failed', 'alpha failing test')
  await settledAs(plain.resourceId, 'completed', 'plain')
  await settledAs(runner.resourceId, 'running', 'runner')
  const first = await until(view, now => now.count === 3, 'three rows')
  const byTab = Object.fromEntries(first.rows.map(row => [row.tabId, row]))
  assert.equal(byTab[asker.id]?.reason, 'permission', JSON.stringify(first))
  assert.equal(byTab[alphaFail.id]?.reason, 'failed', JSON.stringify(first))
  assert.equal(byTab[betaFail.id]?.reason, 'failed', JSON.stringify(first))
  assert.equal(byTab[betaFail.id]?.project, 'Beta shop')
  for (const tab of [runner, waiter, plain]) assert.ok(!byTab[tab.id], `${tab.title} is not listed`)
  assert.equal(first.rows[0].reason, 'permission', 'a blocking ask comes first')
  record('N1', 'PASS', { rows: first.count }, `${JSON.stringify(first.rows)}; ${await shot('n1-needs-attention')}`)

  // ------------------------------------------------------------------ N2
  step('N2 no republish while nothing changes')
  await view.evaluate(() => { window.__attentionChanges = 0; window.__offAttention = window.conductor.needsAttention.onChanged(() => { window.__attentionChanges++ }) })
  await view.waitForTimeout(20_000) // longer than the 15 s refresh tick
  const churn = await view.evaluate(() => window.__attentionChanges)
  assert.equal(churn, 0, 'an unchanged list is never republished')
  record('N2', 'PASS', { republishedIn20s: churn }, 'the main process recomputed on its tick and published nothing, so the sidebar did not re-render')

  // ------------------------------------------------------------------ N3
  step("N3 a click shows the other project's tab; having looked, it leaves the list")
  await view.locator(`.needs-attention [data-attention-tab="${betaFail.id}"]`).click()
  await view.locator('.project-row.active').filter({ hasText: 'Beta shop' }).first().waitFor({ timeout: 20_000 })
  await poll(async () => await view.locator('.pane-tab.active').first().getAttribute('data-control-tab-id') === betaFail.id, { timeoutMs: 20_000, label: 'the beta tab in front' })
  const afterLook = await until(view, now => !now.rows.some(row => row.tabId === betaFail.id), 'the looked-at failure leaves the list')
  record('N3', 'PASS', { rows: afterLook.count }, `Beta shop and its failed tab came to the front; the list now ${JSON.stringify(afterLook.rows)}; ${await shot('n3-after-click')}`)

  // ------------------------------------------------------------------ N4
  step('N4 answering the card and a successful run clear their rows')
  await call('permissions.decide', { agentSessionId: asker.resourceId, requestId: asked.requestId, decision: 'deny' }, { projectId: alpha.id })
  await call('agents.submit', { agentSessionId: alphaFail.resourceId, prompt: 'ATTN try again' }, { projectId: alpha.id })
  await settledAs(alphaFail.resourceId, 'completed', 'alpha retry', alpha.id)
  const cleared = await until(view, now => now.count === 0, 'the list empties')
  assert.equal(await view.locator('.needs-attention').count(), 0, 'an empty list takes no room')
  record('N4', 'PASS', {}, `denied card and retried run cleared; ${JSON.stringify(cleared)}; ${await shot('n4-cleared')}`)
  void beta

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
