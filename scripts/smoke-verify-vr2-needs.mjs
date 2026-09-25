// VR2 group needs (feature-list.md phone-needs-you-only-when-blocked), measured where the owner meets
// it: the decrypted pushes a paired phone receives (scripts/verify-phone-kit.mjs push service), not
// only the attention log. Owner: "only notify me with that when the agent has stopped and is waiting
// for my input, not when it decides to go another route and doesn't care."
//   N1a  a refusal the agent routes around with another tool         -> no "Needs you"
//   N1b  a question answered on the desktop after 5 s                 -> no "Needs you"
//   N1c  a question nobody answers                                    -> exactly one, >= 20 s later
//   N1d  a refusal after which the turn ends with a statement, no ask -> no "Needs you"
//   N1e  control for d: a refusal after which the turn asks the owner -> one "Needs you" after the grace
//   N1f  control: a plain finished turn                              -> a Done push, no "Needs you"
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr2-needs.mjs
import { join, resolve } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'
import { pairPhone, phoneClient, pushService } from './verify-phone-kit.mjs'

configure({ name: 'vr2-needs', output: process.env.VR2_OUT ?? 'artifacts/verification/2026-09-25-vr2' })
watchdog(8 * 60)
const CERT_DIR = resolve(process.env.VR2_CERT_DIR ?? join(REPO, '.conductor-scratch', 'vr2'))
const GRACE_MS = 20_000
// The receipt the installed Claude CLI writes for an auto-mode refusal (as scripts/smoke-verify-fx19-attention.mjs).
const DENIAL = 'Permission for this action has been denied by the Claude Code auto mode classifier. Reason: [Git Push To Default Branch].'

const fixture = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const session = 'vr2-needs-' + randomUUID()
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...m })
const text = (id, content) => emit({ type: 'assistant', message: { id, model: 'synthetic-claude', content: [{ type: 'text', text: content }] } })
const tool = (id, toolId, name, input) => emit({ type: 'assistant', message: { id, model: 'synthetic-claude', content: [{ type: 'tool_use', id: toolId, name, input }] } })
const toolResult = (toolId, content, isError) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, ...(isError ? { is_error: true } : {}) }] } })
const done = () => emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } })
const refuse = turn => { tool('m1-' + turn, 'push-' + turn, 'Bash', { command: 'git push origin main' }); toolResult('push-' + turn, ${JSON.stringify(DENIAL)}, true) }
let turn = 0, pending = null
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic Claude fixture' }] } : {} } })
  if (message.type === 'control_response' && pending && message.response?.request_id === pending) { pending = null; text('answered-' + turn, 'Thanks, carrying on.'); return done() }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : String(blocks)
  turn++
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', session_id: session })
  if (prompt.startsWith('VR2 ASK ')) {
    text('ask-' + turn, 'One question first.')
    pending = 'question-' + turn
    return send({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: pending, input: { questions: [{ header: 'Branch', question: 'Which branch should I push?', multiSelect: false, options: [{ label: 'main' }, { label: 'feature' }] }] } } })
  }
  if (prompt.startsWith('VR2 ROUTE')) { refuse(turn); await new Promise(r => setTimeout(r, 1500)); tool('m2-' + turn, 'st-' + turn, 'Bash', { command: 'git status' }); toolResult('st-' + turn, 'nothing to commit'); text('m3-' + turn, 'Committed locally instead.'); return done() }
  if (prompt.startsWith('VR2 STATEMENT')) { refuse(turn); await new Promise(r => setTimeout(r, 1500)); text('m2-' + turn, 'Pushing is blocked in this mode, so the commit stays local; the controller publishes the batch. Done.'); return done() }
  if (prompt.startsWith('VR2 ASKS OWNER')) { refuse(turn); await new Promise(r => setTimeout(r, 1500)); text('m2-' + turn, 'The push was refused. Can you allow it or push for me?'); return done() }
  if (prompt.startsWith('VR2 FINISH')) await new Promise(r => setTimeout(r, 4000))
  text('done-' + turn, 'Finished.')
  done()
})
`

try {
  await loadCheck()
  const push = await pushService(CERT_DIR)
  await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fixture }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', NODE_EXTRA_CA_CERTS: join(CERT_DIR, 'push-cert.pem'), NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
  const view = await page()
  await openProject({ name: 'VR2 needs you', git: true })

  step('a paired phone with notifications on (no code: full content)')
  const enabled = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  if (!enabled.listening) throw new Error('phone listener did not start: ' + enabled.message)
  const client = phoneClient(`https://127.0.0.1:${new URL(enabled.primaryEndpoint).port}`)
  const token = await pairPhone(view, client, 'VR2 owner phone')
  const subscribed = await client.req('/api/push/subscribe', { method: 'POST', token, body: { subscription: push.subscription('owner') } })
  if (subscribed.status !== 200) throw new Error('subscribe: ' + subscribed.text)
  const tested = await client.req('/api/push/test', { method: 'POST', token, body: {} })
  await poll(() => push.pushes.some(entry => entry.payload?.kind === 'test'), { timeoutMs: 15_000, label: `the test push to arrive (the app said ${JSON.stringify(tested.json ?? tested.text)})` })

  step('six conversations, warmed up')
  const cases = { a: ['VR2 routed', 'VR2 ROUTE'], b: ['VR2 answered', 'VR2 ASK answered'], c: ['VR2 unanswered', 'VR2 ASK open'], d: ['VR2 statement', 'VR2 STATEMENT'], e: ['VR2 asks owner', 'VR2 ASKS OWNER'], f: ['VR2 finished', 'VR2 FINISH'] }
  const ids = {}
  for (const [key, [title]] of Object.entries(cases)) {
    const tab = await openTab({ provider: 'claude', title })
    ids[key] = tab.resourceId
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'warm up' })
  }
  for (const id of Object.values(ids)) await poll(async () => (await call('agents.status', { agentSessionId: id })).phase === 'completed', { timeoutMs: 30_000, label: `${id} warm-up` })
  await sleep(2000)
  const mark = push.pushes.length

  step('raise every moment')
  const t0 = Date.now()
  for (const [key, [, prompt]] of Object.entries(cases)) await call('agents.submit', { agentSessionId: ids[key], prompt })
  const snapshot = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const pendingOf = async id => (await snapshot(id))?.items.map(item => item.data).filter(data => data.type === 'interaction' && data.interaction.status === 'pending').at(-1)?.interaction
  const question = await poll(() => pendingOf(ids.b), { timeoutMs: 30_000, label: 'the question to answer' })
  await sleep(Math.max(0, 5000 - (Date.now() - t0)))
  const { runtimeId } = await snapshot(ids.b)
  await view.evaluate(value => window.conductor.structured.respond(value), { sessionId: ids.b, runtimeId, requestId: question.id, answers: { [question.questions[0].id]: ['main'] } })
  const answeredAfterS = Math.round((Date.now() - t0) / 1000)

  step('watch the phone for 50 s')
  await sleep(Math.max(0, GRACE_MS + 30_000 - (Date.now() - t0)))
  const seen = push.pushes.slice(mark)
  const titleOf = key => cases[key][0]
  const of = (key, kind) => seen.filter(entry => entry.payload?.kind === kind && (entry.payload?.sessionId === ids[key] || String(entry.payload?.title ?? '').endsWith(': ' + titleOf(key))))
  const needs = key => of(key, 'attention')
  const after = entry => Math.round((entry.at - t0) / 1000)
  const log = (await view.evaluate(() => window.conductor.phone.state())).attentionLog ?? []
  const logOf = key => log.filter(entry => entry.sessionId === ids[key]).map(entry => `${entry.kind}:${entry.outcome}`)
  const numbers = key => ({ needsYou: needs(key).length, needsAfterS: needs(key).map(after), done: of(key, 'done').length, log: logOf(key) })
  const decryptErrors = seen.filter(entry => entry.error).length
  record('N1a-routed-around', needs('a').length === 0 && logOf('a').includes('denial:routed-around') ? 'PASS' : 'FAIL', numbers('a'), 'pass: no "Needs you" push; logged as routed around')
  record('N1b-answered-in-grace', needs('b').length === 0 && logOf('b').includes('question:answered') ? 'PASS' : 'FAIL', { ...numbers('b'), answeredAfterS }, 'pass: answered on the desktop after 5 s, nothing pushed')
  record('N1c-unanswered', needs('c').length === 1 && after(needs('c')[0]) >= GRACE_MS / 1000 ? 'PASS' : 'FAIL', numbers('c'), `pass: exactly one "Needs you", >= 20 s after the question; body ${JSON.stringify(needs('c')[0]?.payload?.body ?? null)}`)
  record('N1e-refusal-then-asks (control)', needs('e').length === 1 && after(needs('e')[0]) >= GRACE_MS / 1000 ? 'PASS' : 'FAIL', numbers('e'), 'control for N1d: the turn stopped and asked the owner, so one "Needs you" after the grace')
  record('N1d-refusal-then-statement', needs('d').length === 0 ? 'PASS' : 'FAIL', numbers('d'), `owner: "not when it decides to go another route and doesn't care"; the turn ended with a statement, no question to the owner. ${needs('d').length ? 'Pushed: ' + JSON.stringify(needs('d')[0].payload) : ''}`)
  record('N1f-finished (control)', needs('f').length === 0 && of('f', 'done').length === 1 ? 'PASS' : 'FAIL', numbers('f'), 'control: a plain finished turn gets its Done push and no "Needs you"')
  record('N1-push-channel', decryptErrors === 0 && tested.status === 200 ? 'INFO' : 'FAIL', { pushes: seen.length, decryptErrors, kinds: [...new Set(seen.map(entry => entry.payload?.kind))] }, await shot('vr2-N1-end'))
  await push.close()
} catch (error) {
  await failed(error, 'vr2-needs')
}
await finish()
