// PARKED E2E PLAN ONLY. Do not execute until the controller grants an exact numeric smoke slot
// and the shared smoke-lock/verify-kit cleanup paths pass their independent safety review.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { configure, watchdog, loadCheck, launchParked, openProject, openTab, call, page, shot, poll, record, failed, finish, step } from './verify-kit.mjs'

configure({ name: 'codex-async-questions', output: 'artifacts/verification/2026-09-28-codex-async-questions' })
watchdog(240)
const fixture = await readFile(resolve('scripts/fixtures/codex-async-questions.mjs'), 'utf8')
let inst
const receipts = async () => {
  try { return (await readFile(join(inst.root, 'fixtures', 'async-receipts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch { return [] }
}
const snapshot = async id => (await page(inst)).evaluate(sessionId => window.conductor.structured.snapshot(sessionId), id)
const question = state => state.items.find(item => item.data.type === 'interaction' && item.data.interaction.input?.protocol === 'codex-async-question')
const waitQuestion = id => poll(async () => question(await snapshot(id)), { timeoutMs: 20_000, label: 'async question interaction' })
const openCodex = async title => {
  const tab = await openTab({ provider: 'codex', title, focus: true }, { inst })
  const tabId = tab.id ?? tab.tabId
  assert.ok(tab.resourceId && tabId, 'tabs.open returned a Codex agent and tab identity')
  await call('tabs.focus', { tabId }, { inst })
  await (await page(inst)).locator('.structured-agent-pane').waitFor()
  return tab.resourceId
}
const start = (id, prompt) => call('agents.submit', { agentSessionId: id, prompt }, { inst })
const answerForm = async () => {
  const view = await page(inst)
  await view.getByRole('radio', { name: 'Send now' }).check()
  await view.getByRole('button', { name: 'Next question' }).click()
  await view.getByRole('radio', { name: 'Other' }).check()
  await view.getByRole('textbox', { name: 'Your answer' }).fill('custom second answer')
  await view.getByRole('button', { name: 'Next question' }).click()
  await view.getByRole('textbox', { name: 'Your answer' }).fill('custom explanation')
  await view.getByRole('button', { name: 'Submit answers' }).click()
}

try {
  step('admission; no Electron until exact serial slot and safe cleanup review')
  // Controller and this exact executor are the only allowed mid-turn tabs; the controller
  // must name and verify them when granting the numeric slot.
  const load = await loadCheck({ selfTabs: 2 })
  assert.equal(load.quiet, true, `quiet admission failed: ${load.reasons?.join('; ')}`)
  inst = await launchParked({ name: 'codex-async-questions', mode: 'playwright', fixtures: { 'fake-codex.mjs': fixture } })
  await openProject({ name: 'Async question fixture', files: { 'README.md': '# Offline question fixture\n' } }, inst)
  const view = await page(inst)
  view.setDefaultTimeout(15_000)

  step('Q1/Q2 native agentMessage.questions, output while pending, selected/custom GUI answers')
  const active = await openCodex('Async question active')
  await start(active, 'synthetic:async-active')
  const asked = await waitQuestion(active)
  assert.equal(asked.data.interaction.questions.length, 3)
  assert.deepEqual(asked.data.interaction.questions.map(entry => entry.id), ['async-question-1:0', 'async-question-1:1', 'async-question-1:2'])
  assert.equal(asked.data.interaction.questions[0].question, asked.data.interaction.questions[1].question, 'duplicate titles deliberately exercise ID-based storage')
  await poll(async () => (await snapshot(active)).items.some(item => item.data.type === 'text' && item.data.text?.includes('Work continued while')), { timeoutMs: 15_000, label: 'later ordinary output' })
  assert.equal(question(await snapshot(active)).data.interaction.status, 'pending')
  const cardShot = await shot('q1-multiple-choices-pending', inst)
  record('Q2', 'PASS', { questions: 3, laterOutput: true, stillPending: true }, `Native agentMessage question card remains open after later output; ${cardShot}`)
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.structured))
  await view.locator('.sa-interaction').filter({ hasText: 'Choose delivery' }).first().waitFor()
  assert.equal(question(await snapshot(active)).data.interaction.status, 'pending')
  await answerForm()
  await poll(async () => question(await snapshot(active))?.data.interaction.status === 'resolved' && question(await snapshot(active))?.data.interaction.outcome === 'answered', { timeoutMs: 20_000, label: 'async answer resolved' })
  const answered = question(await snapshot(active)).data.interaction
  assert.deepEqual(answered.answers, { 'async-question-1:0': ['Send now'], 'async-question-1:1': ['custom second answer'], 'async-question-1:2': ['custom explanation'] })
  const sent = (await receipts()).filter(entry => entry.kind === 'steer')
  assert.equal(sent.length, 1, 'one ordinary user message, no question RPC response')
  assert.match(sent[0].text, /Choose delivery\nAnswer: Send now/)
  assert.match(sent[0].text, /Choose delivery\nAnswer: custom second answer/)
  assert.match(sent[0].text, /Explain your choice\nAnswer: custom explanation/)
  const answerShot = await shot('q1-answered-by-id', inst)
  record('Q1', 'PASS', { questions: 3, userMessages: sent.length, duplicateTitleAnswers: 2 }, `GUI selection/custom answers survived reload and reached ordinary steer once; ${answerShot}`)
  const duplicate = await view.evaluate(async ({ id, runtimeId, requestId }) => {
    try { await window.conductor.structured.respond({ sessionId: id, runtimeId, requestId, answers: { 'async-question-1:0': ['Send now'], 'async-question-1:1': ['custom second answer'], 'async-question-1:2': ['custom explanation'] } }); return 'accepted' }
    catch (error) { return String(error?.message ?? error) }
  }, { id: active, runtimeId: asked.runtimeId, requestId: asked.data.interaction.id })
  assert.notEqual(duplicate, 'accepted')

  step('Q3 completed turn, renderer reload, later answer and nonretryable unconfirmed claim')
  const settled = await openCodex('Async question settled')
  await start(settled, 'synthetic:async-settled')
  await waitQuestion(settled)
  await poll(async () => (await snapshot(settled)).phase === 'completed', { timeoutMs: 15_000, label: 'settled async turn' })
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.structured))
  assert.equal(question(await snapshot(settled)).data.interaction.status, 'pending')
  await answerForm()
  await poll(async () => question(await snapshot(settled))?.data.interaction.outcome === 'answered', { timeoutMs: 20_000, label: 'later turn answer' })
  const laterStarts = (await receipts()).filter(entry => entry.kind === 'turn-start' && entry.text.includes('custom second answer'))
  assert.equal(laterStarts.length, 1, 'settled async answer starts exactly one later user turn')

  const held = await openCodex('Async question unconfirmed')
  await start(held, 'synthetic:async-hold')
  const heldQuestion = await waitQuestion(held)
  await answerForm()
  await poll(async () => question(await snapshot(held))?.data.interaction.outcome === 'Delivery unconfirmed', { timeoutMs: 10_000, label: 'durable pre-send claim' })
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.structured))
  assert.notEqual(question(await snapshot(held)).data.interaction.status, 'pending')
  const heldDuplicate = await view.evaluate(async ({ id, runtimeId, requestId }) => {
    try { await window.conductor.structured.respond({ sessionId: id, runtimeId, requestId, answers: { 'async-question-1:0': ['Send now'], 'async-question-1:1': ['custom second answer'], 'async-question-1:2': ['custom explanation'] } }); return 'accepted' }
    catch (error) { return String(error?.message ?? error) }
  }, { id: held, runtimeId: heldQuestion.runtimeId, requestId: heldQuestion.data.interaction.id })
  assert.notEqual(heldDuplicate, 'accepted')
  assert.equal((await receipts()).filter(entry => entry.kind === 'steer' && entry.text.includes('custom second answer')).length, 2, 'active answer plus held answer; no duplicate held send')
  record('Q3', 'PASS', { duplicateRejected: true, settledLaterTurn: 1, unconfirmedNonretryable: true }, 'Renderer reload retained both pending and claimed states; duplicate submissions did not resend')

  step('ordinary blocking requestUserInput RPC control')
  const rpc = await openCodex('Blocking RPC control')
  await start(rpc, 'synthetic:rpc-question')
  await poll(async () => (await snapshot(rpc)).items.some(item => item.data.type === 'interaction' && item.data.interaction.kind === 'question' && item.data.interaction.input?.itemId === 'rpc-question'), { timeoutMs: 15_000, label: 'blocking RPC card' })
  await view.getByRole('radio', { name: 'Yes' }).check()
  await view.getByRole('button', { name: 'Submit answers' }).click()
  await poll(async () => (await receipts()).some(entry => entry.kind === 'rpc-result'), { timeoutMs: 15_000, label: 'RPC response' })
  assert.deepEqual((await receipts()).find(entry => entry.kind === 'rpc-result').result, { answers: { 'rpc-choice': { answers: ['Yes'] } } })
  record('control', 'PASS', { rpcReplies: 1 }, 'Blocking item/tool/requestUserInput still responds on its native RPC path')
} catch (error) { await failed(error, 'codex-async-questions') }
finally { await finish() }
