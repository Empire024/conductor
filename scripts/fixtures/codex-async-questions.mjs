// Offline App Server fixture for smoke-codex-async-questions.mjs.
// It is copied as fake-codex.mjs into a parked profile; no Codex account/model is contacted.
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv.includes('--version')) { console.log('codex-cli 0.155.1'); process.exit(0) }
const threadId = 'synthetic-async-thread'
const capture = join(process.env.CONDUCTOR_TEST_FIXTURE_DIR ?? process.cwd(), 'async-receipts.jsonl')
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
const note = value => appendFileSync(capture, JSON.stringify(value) + '\n')
const questions = [
  { title: 'Choose delivery', options: ['Send now', 'Hold'] },
  { title: 'Choose delivery', options: ['Store', 'Return'] },
  { title: 'Explain your choice', options: null }
]
const questionItem = { type: 'agentMessage', id: 'async-question-1', phase: 'commentary', memoryCitation: null, delivery: null,
  text: 'Choose delivery\n- Send now\n- Hold\n\nChoose delivery\n- Store\n- Return\n\nExplain your choice', questions }
let turnNumber = 0, activeTurn = null, mode = null, pendingRpc = false
const item = (method, value) => notify(method, { threadId, turnId: activeTurn, item: value })
const message = (id, text) => ({ type: 'agentMessage', id, text, phase: 'commentary', memoryCitation: null, delivery: null, questions: null })
const complete = (status = 'completed') => {
  notify('turn/completed', { threadId, turn: { id: activeTurn, items: [], itemsView: 'summary', status, error: null } })
  activeTurn = null
}
const defaults = () => ({ thread: { id: threadId, status: { type: 'idle' }, turns: [], cwd: process.cwd() },
  model: 'synthetic-model', reasoningEffort: 'low', modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user',
  sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, instructionSources: [] })

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (!request.method) {
    if (!pendingRpc || request.id !== 701) return
    pendingRpc = false
    note({ kind: 'rpc-result', result: request.result })
    item('item/completed', message('rpc-result', 'Blocking RPC answered'))
    complete()
    return
  }
  if (request.method === 'initialize') { send({ id: request.id, result: { userAgent: 'codex/0.155.1 offline', codexHome: '/offline', platformFamily: 'windows', platformOs: 'windows' } }); return }
  if (request.method === 'initialized') return
  if (request.method === 'thread/start' || request.method === 'thread/resume') { send({ id: request.id, result: defaults() }); return }
  if (request.method === 'model/list') { send({ id: request.id, result: { data: [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Offline' }] }], nextCursor: null } }); return }
  if (request.method === 'thread/read') { send({ id: request.id, result: { thread: defaults().thread } }); return }
  if (request.method === 'turn/interrupt') { send({ id: request.id, result: {} }); if (activeTurn) complete('interrupted'); return }
  if (request.method === 'turn/steer') {
    const text = request.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')
    note({ kind: 'steer', text, clientId: request.params.clientUserMessageId, turnId: activeTurn })
    if (mode === 'hold') return // Native acknowledgement deliberately unknown; never authorize a resend.
    send({ id: request.id, result: { turnId: activeTurn } })
    item('item/completed', { type: 'userMessage', id: 'steered-answer', clientId: request.params.clientUserMessageId, content: request.params.input })
    item('item/completed', message('async-result', 'Async answer received'))
    complete()
    return
  }
  if (request.method !== 'turn/start') { send({ id: request.id, error: { code: -32601, message: 'Offline fixture method unsupported' } }); return }
  activeTurn = `synthetic-async-turn-${++turnNumber}`
  const prompt = request.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')
  note({ kind: 'turn-start', text: prompt, turnId: activeTurn })
  notify('turn/started', { threadId, turn: { id: activeTurn, status: 'inProgress', items: [], error: null } })
  send({ id: request.id, result: { turn: { id: activeTurn, status: 'inProgress', items: [], error: null } } })
  if (prompt.startsWith('synthetic:async-')) {
    mode = prompt.startsWith('synthetic:async-hold') ? 'hold' : prompt.startsWith('synthetic:async-settled') ? 'settled' : 'active'
    item('item/started', questionItem)
    item('item/completed', questionItem)
    setTimeout(() => {
      if (!activeTurn) return
      item('item/completed', message('progress-after-question', 'Work continued while the async question was waiting'))
      if (mode === 'settled') complete()
    }, 60)
    return
  }
  if (prompt.startsWith('synthetic:rpc-question')) {
    mode = 'rpc'; pendingRpc = true
    send({ id: 701, method: 'item/tool/requestUserInput', params: { threadId, turnId: activeTurn, itemId: 'rpc-question', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'rpc-choice', header: 'RPC', question: 'Choose blocking answer', isOther: false, isSecret: false, options: [{ label: 'Yes' }, { label: 'No' }] }] } })
    return
  }
  item('item/completed', message('later-answer', 'Later user message received'))
  complete()
})
