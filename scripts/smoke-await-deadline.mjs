// A wait never stalls silently (feature-list `await-deadline-and-rejected-reply`,
// src/shared/awaiting-results.ts). Real case 2026-09-29/30: the Conductor wizard sat 8.5 h in
// agents.await on a Haftheme reply whose send_message was refused before it ran. Driven in a
// parked, spawned Electron window with a synthetic Claude CLI (no inference), with the sweep every
// second and a 3 s quiet grace (CONDUCTOR_TEST_AWAIT_SWEEP_MS / CONDUCTOR_TEST_AWAIT_QUIET_MS):
//   D1 a reviewer awaits a fixer with timeoutMinutes 0.1 while the fixer itself awaits the reviewer
//      (so neither is quiet): the deadline wakes the reviewer with "[Conductor] Deadline passed",
//      exactly one new turn, and its wait is gone;
//   D2 the fixer still awaits the reviewer, which has now gone quiet without messaging it: the fixer
//      is woken with that fact and the reviewer's last answer, and its wait is gone.
//   node scripts/smoke-lock.mjs --timeout-min 10 -- node scripts/smoke-await-deadline.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'await-deadline', output: 'artifacts/verification/2026-09-30-await-deadline' })
watchdog(600)

const capture = join(tmpdir(), `conductor-await-capture-${process.pid}.txt`)
// Answers every prompt at once and writes it to the capture file, whose app-control briefing
// carries the tab's own credential.
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
/** The tab's own credential, from the briefing the prompt submitted by `submit` carried. */
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}
const factsOf = (view, id) => view.evaluate(async id => (await window.conductor.workspaceClarity.facts([id]))[id], id)
const userTexts = async (view, id) => (await view.evaluate(id => window.conductor.structured.snapshot(id), id)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)

try {
  step('launch (spawn) and open the project')
  const inst = await launchParked({ mode: 'spawn', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_AWAIT_SWEEP_MS: 1000, CONDUCTOR_TEST_AWAIT_QUIET_MS: 3000 } })
  await openProject({ name: 'Await deadline', git: true })
  const view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)

  // ------------------------------------------------------------------ D1
  step('D1 the deadline wakes a reviewer whose fixer never answers')
  const fixer = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Fixer' })
  const reviewer = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Reviewer' })
  const fixerAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: fixer.resourceId, prompt: 'WAIT fix the bug' }))
  await settled(fixer.resourceId, 'fixer')
  const reviewerAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: reviewer.resourceId, prompt: 'WAIT review the fix' }))
  await settled(reviewer.resourceId, 'reviewer')
  // Each waits on the other, so neither is quiet: only a deadline can end the reviewer's wait.
  const fixerWait = await tabCall(fixerAuth, 'agents.await', { agents: [reviewer.resourceId], reason: 'the review verdict' })
  assert.ok(Date.parse(fixerWait.deadline) - Date.now() > 55 * 60_000, 'the default deadline is 60 min: ' + JSON.stringify(fixerWait))
  const before = (await userTexts(view, reviewer.resourceId)).length
  const declared = await tabCall(reviewerAuth, 'agents.await', { agents: [fixer.resourceId], reason: 'fix commits', timeoutMinutes: 0.1 })
  assert.match(declared.note, /wakes you at/, JSON.stringify(declared))
  const started = Date.now()
  const woken = await poll(async () => (await userTexts(view, reviewer.resourceId)).find(text => text.startsWith('[Conductor] Deadline passed')) ?? null, { timeoutMs: 30_000, label: 'the reviewer is woken at its deadline' })
  const wokeAfter = Date.now() - started
  assert.ok(wokeAfter >= 4_000, `woken only once the deadline passed (${wokeAfter} ms)`)
  assert.match(woken, /\(fix commits\)[\s\S]*"Fixer" \([^)]+\): completed/)
  await settled(reviewer.resourceId, 'reviewer after the deadline wake')
  assert.equal((await userTexts(view, reviewer.resourceId)).length, before + 1, 'exactly one wake turn')
  assert.equal((await factsOf(view, reviewer.resourceId)).awaiting, undefined, 'the wait ended with the wake')
  record('D1', 'PASS', { wokeAfterMs: wokeAfter }, `deadline wake after ${wokeAfter} ms: ${woken.split('\n', 1)[0].slice(0, 200)}; ${await shot('d1-deadline-wake')}`)

  // ------------------------------------------------------------------ D2
  step('D2 the fixer is told once the reviewer it awaits has gone quiet without messaging it')
  const fixerBefore = (await userTexts(view, fixer.resourceId)).length
  const quiet = await poll(async () => (await userTexts(view, fixer.resourceId)).find(text => text.startsWith('[Conductor] Everyone you were waiting for')) ?? null, { timeoutMs: 30_000, label: 'the fixer is woken once the reviewer is quiet' })
  assert.match(quiet, /\(the review verdict\)[\s\S]*"Reviewer" \([^)]+\): completed; last answer: "Done: \[Conductor\] Deadline passed/)
  await settled(fixer.resourceId, 'fixer after the quiet wake')
  assert.equal((await userTexts(view, fixer.resourceId)).length, fixerBefore + 1, 'exactly one wake turn')
  assert.equal((await factsOf(view, fixer.resourceId)).awaiting, undefined, 'the wait ended with the wake')
  // Nothing else wakes either tab afterwards.
  await new Promise(done => setTimeout(done, 5_000))
  assert.equal((await userTexts(view, fixer.resourceId)).length, fixerBefore + 1)
  assert.equal((await userTexts(view, reviewer.resourceId)).length, before + 1)
  record('D2', 'PASS', {}, `quiet wake: ${quiet.replace(/\s+/g, ' ').slice(0, 300)}; ${await shot('d2-quiet-wake')}`)

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
