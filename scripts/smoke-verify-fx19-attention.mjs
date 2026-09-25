// FX19 parked smoke: "needs you" goes out only when a turn is still blocked on the owner after the
// grace period (feature-list phone-needs-you-only-when-blocked, src/main/attention-log.ts).
//   A1  a question nobody answers: logged as sent once the 20 s grace has passed
//   A2  a question the owner answers on the desktop inside the grace: logged as answered, never sent
//   A3  an auto-mode refusal the agent routes around (another tool runs): logged only
//   A4  an auto-mode refusal the turn stops on: logged as sent after the grace
//   A5  Settings > Notifications lists them
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-fx19-attention.mjs
import { configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, call, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx19-attention', output: 'artifacts/verification/2026-09-25-fx19' })
watchdog(10 * 60)
const GRACE_MS = 20_000
const DENIAL = 'Permission for this action has been denied by the Claude Code auto mode classifier. Reason: [Git Push To Default Branch].'

const fixture = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'fx19-' + randomUUID()
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...m })
const text = (id, content) => emit({ type: 'assistant', message: { id, model: 'synthetic-claude', content: [{ type: 'text', text: content }] } })
const tool = (id, toolId, name, input) => emit({ type: 'assistant', message: { id, model: 'synthetic-claude', content: [{ type: 'tool_use', id: toolId, name, input }] } })
const toolResult = (toolId, content, isError) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, ...(isError ? { is_error: true } : {}) }] } })
const done = () => emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } })
let turn = 0, pending = null
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic Claude fixture' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type === 'control_response' && pending && message.response?.request_id === pending) {
    pending = null
    text('answered-' + turn, 'Thanks, carrying on.')
    return done()
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : String(blocks)
  turn++
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', session_id: session })
  if (prompt.startsWith('FX19 ASK')) {
    text('ask-' + turn, 'One question first.')
    pending = 'question-' + turn
    return send({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: pending, input: { questions: [{ header: 'Branch', question: 'Which branch should I push?', multiSelect: false, options: [{ label: 'main' }, { label: 'feature' }] }] } } })
  }
  if (prompt.startsWith('FX19 REFUSE ROUTE')) {
    tool('m1-' + turn, 'push-' + turn, 'Bash', { command: 'git push origin main' })
    toolResult('push-' + turn, ${JSON.stringify(DENIAL)}, true)
    await new Promise(r => setTimeout(r, 1500))
    tool('m2-' + turn, 'ship-' + turn, 'Bash', { command: 'git status' })
    toolResult('ship-' + turn, 'nothing to commit')
    text('m3-' + turn, 'Pushing is not allowed; I committed locally instead.')
    return done()
  }
  if (prompt.startsWith('FX19 REFUSE STOP')) {
    tool('m1-' + turn, 'push-' + turn, 'Bash', { command: 'git push origin main' })
    toolResult('push-' + turn, ${JSON.stringify(DENIAL)}, true)
    text('m2-' + turn, 'The push was refused. Can you allow it or push for me?')
    return done()
  }
  text('done-' + turn, 'Finished.')
  done()
})
`

try {
  await loadCheck()
  await launchParked({ mode: 'playwright', name: 'fx19-attention', fixtures: { 'fake-claude.mjs': fixture }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'FX19 attention', git: true })
  const view = await page()
  const snapshot = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const log = async () => (await view.evaluate(() => window.conductor.phone.state())).attentionLog ?? []
  const entryFor = async (id, kind) => (await log()).find(entry => entry.sessionId === id && entry.kind === kind)
  const start = async (title, prompt) => {
    const tab = await openTab({ provider: 'claude', title })
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt })
    return tab.resourceId
  }
  // Let the phone service learn the open tabs first: nothing is announced on first sight.
  step('open four conversations')
  const unanswered = await start('FX19 unanswered', 'FX19 DONE warm up')
  const answered = await start('FX19 answered', 'FX19 DONE warm up')
  const routed = await start('FX19 routed', 'FX19 DONE warm up')
  const stopped = await start('FX19 stopped', 'FX19 DONE warm up')
  for (const id of [unanswered, answered, routed, stopped]) await poll(async () => (await snapshot(id))?.phase === 'completed', { timeoutMs: 30_000, label: 'warm-up turn' })
  await sleep(1500)

  step('raise all four moments')
  const t0 = Date.now()
  await call('agents.submit', { agentSessionId: unanswered, prompt: 'FX19 ASK nobody answers' })
  await call('agents.submit', { agentSessionId: answered, prompt: 'FX19 ASK answered in time' })
  await call('agents.submit', { agentSessionId: routed, prompt: 'FX19 REFUSE ROUTE' })
  await call('agents.submit', { agentSessionId: stopped, prompt: 'FX19 REFUSE STOP' })
  const pendingOf = async id => (await snapshot(id))?.items.map(item => item.data).filter(data => data.type === 'interaction' && data.interaction.status === 'pending').at(-1)?.interaction
  const question = await poll(() => pendingOf(answered), { timeoutMs: 30_000, label: 'the question to answer' })
  await sleep(3000)
  const runtimeId = (await snapshot(answered)).runtimeId
  await view.evaluate(value => window.conductor.structured.respond(value), { sessionId: answered, runtimeId, requestId: question.id, answers: { [question.questions[0].id]: ['main'] } })
  const answeredAt = Math.round((Date.now() - t0) / 1000)

  step('A3 routed-around refusal is logged at once')
  const a3 = await poll(() => entryFor(routed, 'denial'), { timeoutMs: 15_000, label: 'the routed-around entry' }).catch(() => null)
  const a3Seconds = Math.round((Date.now() - t0) / 1000)
  record('A3', a3?.outcome === 'routed-around' && a3Seconds < GRACE_MS / 1000 ? 'PASS' : 'FAIL', { entry: a3, loggedAfterS: a3Seconds }, 'pass: logged as went-another-way before the grace ended, not sent')

  step('A2 answered inside the grace')
  const a2 = await poll(() => entryFor(answered, 'question'), { timeoutMs: 15_000, label: 'the answered entry' }).catch(() => null)
  record('A2', a2?.outcome === 'answered' && a2.waitedMs < GRACE_MS ? 'PASS' : 'FAIL', { entry: a2, answeredAfterS: answeredAt }, 'pass: answered on the desktop inside the grace, logged as answered, not sent')

  step('A1 / A4 still blocked after the grace')
  const early = { a1: await entryFor(unanswered, 'question'), a4: await entryFor(stopped, 'denial') }
  const a1 = await poll(() => entryFor(unanswered, 'question'), { timeoutMs: GRACE_MS + 20_000, label: 'the unanswered entry' }).catch(() => null)
  const a4 = await poll(() => entryFor(stopped, 'denial'), { timeoutMs: GRACE_MS + 20_000, label: 'the stopped-refusal entry' }).catch(() => null)
  record('A1', !early.a1 && a1?.outcome === 'notified' && a1.waitedMs >= GRACE_MS ? 'PASS' : 'FAIL', { entry: a1, beforeGrace: early.a1 ?? null }, 'pass: nothing before the grace, then sent because the question still holds the turn')
  record('A4', !early.a4 && a4?.outcome === 'notified' && a4.waitedMs >= GRACE_MS ? 'PASS' : 'FAIL', { entry: a4, beforeGrace: early.a4 ?? null }, 'pass: the turn stopped on the refusal, so it is sent after the grace')

  step('A5 Settings > Notifications')
  await view.locator('button[aria-label="Settings"]').first().click()
  await view.locator('.settings-nav button').filter({ hasText: /^Notifications$/ }).click()
  await view.locator('.attention-log-entry').first().waitFor({ timeout: 10_000 }).catch(() => {})
  const rows = await view.locator('.attention-log-entry').count().catch(() => 0)
  const texts = await view.locator('.attention-log-entry').allInnerTexts().catch(() => [])
  const a5Shot = await shot('fx19-A5-notifications-log')
  record('A5', rows >= 4 && texts.some(text => /Went another way/.test(text)) && texts.some(text => /Sent/.test(text)) && texts.some(text => /Answered in time/.test(text)) ? 'PASS' : 'FAIL', { rows, texts: texts.map(text => text.replace(/\s+/g, ' ').slice(0, 160)) }, a5Shot)
} catch (error) {
  await failed(error, 'fx19-attention')
}
await finish()
