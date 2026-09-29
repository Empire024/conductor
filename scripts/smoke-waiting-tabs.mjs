// Waiting-for-results tabs stay active (feature-list `waiting-tabs-stay-active`,
// src/shared/awaiting-results.ts). Real case 2026-09-29: an independent reviewer tab ended its turn
// waiting for fix commits from coworkers and was filed under Done. Driven in a parked, spawned
// Electron window with a synthetic Claude CLI (no inference):
//   W1 a reviewer that declares agents.await on a fixer is a live sidebar row labelled "waiting for
//      Fixer"; a plain completed tab and a waiting tab that was superseded are in Done;
//   W2 the owner's app.restart (spawn mode): the reviewer is still waiting, the others still Done;
//   W3 the finished-tab sweep (test age) closes the unseen Done tabs and keeps the waiting reviewer;
//   W4 the fixer's message wakes the reviewer (a turn it did not poll for); it waits again, so it
//      stays active; the fixer's second message ends the review and the reviewer moves to Done.
// Screenshots: artifacts/verification/2026-09-29-waiting-tabs/*.png. CONDUCTOR_SMOKE_MAIN runs another build.
//   node scripts/smoke-lock.mjs --timeout-min 15 -- node scripts/smoke-waiting-tabs.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, relaunched, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'waiting-tabs', output: 'artifacts/verification/2026-09-29-waiting-tabs' })
watchdog(900)

const capture = join(tmpdir(), `conductor-waiting-capture-${process.pid}.txt`)
// Answers every prompt at once and writes it to the capture file, whose app-control briefing
// carries the tab's own credential; counts turns per native session for W4.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Done: ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
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
const settled = (id, label) => poll(async () => await phaseOf(id) === 'completed', { timeoutMs: 45_000, label: `${label} completed` })
const openTabIds = async () => (await call('tabs.list')).filter(tab => tab.kind === 'agent').map(tab => tab.resourceId)
/** The tab's own credential, from the briefing the prompt submitted by `submit` carried. */
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  const result = await submit()
  return { ...await capturedCredential(), result }
}
/** The credential in the briefing the capture file holds now (a new process restates it). */
const capturedCredential = async () => {
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  assert.match(briefing, /awaitReply:true/, 'the briefing tells the tab how to declare a wait')
  return { endpoint, token }
}
/** The sidebar row of a tab: where it is listed (live or done), its status and its label. */
const rowOf = (view, tabId) => view.evaluate(tabId => {
  const row = document.querySelector(`.session-tree .workspace-tab-tree [data-clarity-row="${tabId}"]`)
  if (!row) return null
  return { group: row.closest('.workspace-done-group') ? 'done' : 'live', status: row.getAttribute('data-clarity-status'), label: row.querySelector('.workspace-tab-status')?.textContent?.trim() ?? '', tooltip: row.querySelector('.workspace-tab-status')?.getAttribute('title') ?? '' }
}, tabId)
const openDone = async view => {
  const toggle = view.locator('.session-tree .workspace-done-toggle').first()
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
}
const rowIs = async (view, tabId, expected, label) => poll(async () => {
  await openDone(view)
  const row = await rowOf(view, tabId)
  return row && Object.entries(expected).every(([key, value]) => value instanceof RegExp ? value.test(row[key]) : row[key] === value) ? row : null
}, { timeoutMs: 30_000, label })
/** The tab strip chip: an hourglass (AwaitingMark) instead of the completed-turn ring while it waits. */
const chipOf = (view, tabId) => view.evaluate(tabId => {
  const chip = document.querySelector(`.pane-tab[data-control-tab-id="${tabId}"]`)
  return chip ? { status: chip.getAttribute('data-clarity-status'), hourglass: Boolean(chip.querySelector('.tab-awaiting')), ring: Boolean(chip.querySelector('.tab-activity')), title: chip.querySelector('.tab-awaiting')?.getAttribute('title') ?? '' } : null
}, tabId)
const factsOf = (view, id) => view.evaluate(async id => (await window.conductor.workspaceClarity.facts([id]))[id], id)

try {
  step('launch (spawn) and open the project')
  const inst = await launchParked({ mode: 'spawn', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FINISHED_TAB_SWEEP_MS: 8000 } })
  await openProject({ name: 'Waiting tabs', git: true })
  let view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)

  // ------------------------------------------------------------------ W1
  step('W1 a reviewer waits on a fixer; a plain tab and a superseded one finish')
  const fixer = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Fixer' })
  const reviewer = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Independent reviewer' })
  const plain = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Plain task' })
  const old = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Superseded reviewer' })
  let fixerAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: fixer.resourceId, prompt: 'WAIT fix the bug' }))
  await settled(fixer.resourceId, 'fixer')
  const reviewerAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: reviewer.resourceId, prompt: 'WAIT review the fix' }))
  await settled(reviewer.resourceId, 'reviewer')
  const oldAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: old.resourceId, prompt: 'WAIT an earlier review' }))
  await settled(old.resourceId, 'old reviewer')
  await call('agents.submit', { agentSessionId: plain.resourceId, prompt: 'WAIT a plain task' })
  await settled(plain.resourceId, 'plain')
  // The reviewer ends its turn waiting on the fixer, as its model would with agents.await.
  const declared = await tabCall(reviewerAuth, 'agents.await', { agents: [fixer.resourceId], reason: 'fix commits and evidence' })
  assert.deepEqual(declared.awaiting.agents.map(agent => agent.agentSessionId), [fixer.resourceId], JSON.stringify(declared))
  await tabCall(oldAuth, 'agents.await', { agents: [fixer.resourceId] })
  const superseded = await call('agents.supersede', { agentSessionId: old.resourceId, by: reviewer.resourceId, reason: 'the independent reviewer took this review over' })
  assert.ok(superseded.superseded, JSON.stringify(superseded))
  await call('tabs.focus', { tabId: fixer.id })
  const waiting = await rowIs(view, reviewer.id, { group: 'live', status: 'awaiting', label: 'waiting for Fixer' }, 'reviewer live, waiting for Fixer')
  const plainRow = await rowIs(view, plain.id, { group: 'done' }, 'plain task in Done')
  const oldRow = await rowIs(view, old.id, { group: 'done' }, 'superseded reviewer in Done')
  assert.match(waiting.tooltip, /Waiting for results from Fixer .*fix commits and evidence/)
  const chip = await poll(async () => { const found = await chipOf(view, reviewer.id); return found?.hourglass ? found : null }, { timeoutMs: 20_000, label: 'the strip chip shows the hourglass' })
  assert.equal(chip.ring, false, 'no completed-turn ring on a waiting tab: ' + JSON.stringify(chip))
  assert.match(chip.title, /Waiting for results from Fixer/)
  record('W1', 'PASS', {}, `reviewer ${JSON.stringify(waiting)}; strip chip ${JSON.stringify(chip)}; plain ${JSON.stringify(plainRow)}; superseded ${JSON.stringify(oldRow)}; ${await shot('w1-waiting-before-restart')}`)

  // ------------------------------------------------------------------ W2
  step("W2 the owner's app.restart keeps the wait")
  const firstPid = inst.credential.pid
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, firstPid, { timeoutMs: 90_000 })
  view = await page(inst)
  await view.locator('.project-row').filter({ hasText: 'Waiting tabs' }).first().click()
  await view.locator('.pane-workspace').first().waitFor({ timeout: 30_000 })
  const afterRestart = await rowIs(view, reviewer.id, { group: 'live', status: 'awaiting', label: 'waiting for Fixer' }, 'reviewer still waiting after the restart')
  await rowIs(view, plain.id, { group: 'done' }, 'plain task still Done')
  await rowIs(view, old.id, { group: 'done' }, 'superseded reviewer still Done')
  const facts = await factsOf(view, reviewer.resourceId)
  assert.equal(facts.awaiting?.agents?.[0]?.agentSessionId, fixer.resourceId, JSON.stringify(facts))
  record('W2', 'PASS', { restartSeconds: seconds }, `after app.restart: reviewer ${JSON.stringify(afterRestart)}; facts.awaiting ${JSON.stringify(facts.awaiting)}; ${await shot('w2-waiting-after-restart')}`)

  // ------------------------------------------------------------------ W3
  step('W3 the finished-tab sweep closes Done tabs and keeps the waiting reviewer')
  await call('tabs.focus', { tabId: fixer.id })
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(24)), 24)
  await poll(async () => { const open = await openTabIds(); return !open.includes(plain.resourceId) && !open.includes(old.resourceId) }, { timeoutMs: 90_000, label: 'the sweep closes the plain and superseded tabs' })
  await new Promise(done => setTimeout(done, 12_000)) // one more sweep period past the age
  assert.ok((await openTabIds()).includes(reviewer.resourceId), 'the waiting reviewer survives the sweep')
  const kept = await view.evaluate(async ({ projectId, workspaceId, tabId }) => window.conductor.workspaceClarity.closeFinished(projectId, workspaceId, [tabId]), { projectId: inst.projectId, workspaceId: inst.workspaceId, tabId: reviewer.id })
  assert.equal(kept.closed, 0, JSON.stringify(kept))
  assert.match(kept.kept[0]?.reason ?? '', /waiting for results from Fixer/, JSON.stringify(kept))
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  record('W3', 'PASS', {}, `sweep closed the plain and superseded tabs, kept the reviewer; Close finished refused it: ${kept.kept[0].reason}`)

  // ------------------------------------------------------------------ W4
  step("W4 the fixer's message wakes the reviewer; it waits again, then finishes")
  const turns = async () => (await view.evaluate(id => window.conductor.structured.snapshot(id), reviewer.resourceId)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').length
  const before = await turns()
  // Tab credentials are kept across a restart; the control endpoint moves with the new process.
  fixerAuth = { endpoint: inst.credential.endpoint, token: fixerAuth.token }
  const reviewerNow = { endpoint: inst.credential.endpoint, token: reviewerAuth.token }
  const first = await tabCall(fixerAuth, 'agents.steer', { agentSessionId: reviewer.resourceId, prompt: 'FIX 1 at abc123: tests pass' })
  assert.equal(first.delivery, 'started', JSON.stringify(first))
  await settled(reviewer.resourceId, 'reviewer woken by the fix')
  assert.equal(await turns(), before + 1, 'exactly one new turn, started by the message')
  // Its model asks for more and ends that turn waiting again.
  await tabCall(reviewerNow, 'agents.await', { agents: [fixer.resourceId], reason: 'the regression test' })
  await rowIs(view, reviewer.id, { group: 'live', status: 'awaiting' }, 'reviewer waiting again')
  const second = await tabCall(fixerAuth, 'agents.steer', { agentSessionId: reviewer.resourceId, prompt: 'FIX 2: regression test added' })
  assert.equal(second.delivery, 'started', JSON.stringify(second))
  await settled(reviewer.resourceId, 'reviewer finishing the review')
  const done = await rowIs(view, reviewer.id, { group: 'done', status: 'done' }, 'reviewer in Done after its review completes')
  const doneChip = await chipOf(view, reviewer.id)
  assert.ok(!doneChip || !doneChip.hourglass, 'no hourglass once the review completed: ' + JSON.stringify(doneChip))
  assert.equal((await factsOf(view, reviewer.resourceId)).awaiting, undefined)
  record('W4', 'PASS', { turnsBefore: before, turnsAfter: await turns() }, `first fix started a reviewer turn (delivery started), it waited again, the second fix completed it: ${JSON.stringify(done)}; ${await shot('w4-reviewer-done')}`)

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
