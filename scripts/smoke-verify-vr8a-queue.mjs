// VR8a (verify loop v3): 959e61cb, queued messages go out as written. Owner: "'--- Queued message 1
// of 2 ---' wastes tokens. just litrally paste the messages with a break between (so theyre in new
// lines, maybe put a whole empty big one between them. no tokens wasted".
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8a-queue.mjs [--label prefix] [--keep]
// A synthetic Claude CLI holds a turn open until a release file appears and logs every user prompt
// it receives, so the check reads what the provider was actually sent. Messages are queued through
// window.conductor.structured.queue, the composer's path for a turn it does not steer into.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'C'
configure({ name: 'vr8a-queue-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8a' })
watchdog(8 * 60)
await loadCheck()

const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = 'vr8a-q-' + process.pid
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const text = content => { const id = randomUUID(); emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } }); emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } }); emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }); emit({ type: 'stream_event', event: { type: 'message_stop' } }); emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: content }] } }) }
const finish = () => emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'opus', displayName: 'Opus' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (typeof prompt !== 'string') return
  appendFileSync(process.env.VR8A_PROMPTS, JSON.stringify({ at: Date.now(), prompt }) + '\\n')
  emit({ type: 'system', subtype: 'init', model: 'opus', permissionMode: 'default' })
  if (prompt.startsWith('SYNTHETIC HOLD')) {
    text('Holding.')
    const started = Date.now()
    const timer = setInterval(() => {
      if (!existsSync(process.env.VR8A_RELEASE) && Date.now() - started < 90000) return
      clearInterval(timer); rmSync(process.env.VR8A_RELEASE, { force: true }); text('Released.'); finish()
    }, 100)
    return
  }
  text('Got it.'); finish()
})
`

const logs = await mkdtemp(join(tmpdir(), 'vr8a-queue-'))
const promptsFile = join(logs, 'prompts.jsonl'), release = join(logs, 'release')
const prompts = async () => (await readFile(promptsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line).prompt)

try {
  await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', VR8A_PROMPTS: promptsFile, VR8A_RELEASE: release } })
  await openProject({ name: 'VR8a queue' })
  const tab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Queue' })
  const id = tab.resourceId
  const view = await page()
  const snapshot = () => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  await view.evaluate(value => window.conductor.structured.connect(value), id)

  /** Holds a turn, queues `texts` behind it, releases it and returns the next prompt the CLI got. */
  const queueBehind = async texts => {
    const before = (await prompts()).length
    await view.evaluate(async value => { const state = await window.conductor.structured.snapshot(value); await window.conductor.structured.submit(value, 'SYNTHETIC HOLD', state.settings, []) }, id)
    await poll(async () => (await prompts()).length > before && (await snapshot()).phase === 'running', { timeoutMs: 30_000, label: 'held turn running' })
    for (const text of texts) await view.evaluate(async ({ id, text }) => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.queue(id, text, state.settings, []) }, { id, text })
    const queued = (await snapshot()).queuedPrompts?.length ?? 0
    await writeFile(release, '1')
    const sent = await poll(async () => { const all = await prompts(); return all.length >= before + 2 && all[before + 1] }, { timeoutMs: 30_000, label: 'the drained turn' })
    await poll(async () => /^(completed|idle)$/.test((await snapshot()).phase) && !(await snapshot()).queuedPrompts?.length, { timeoutMs: 30_000, label: 'drained turn settled' })
    return { sent, queued, extraTurns: (await prompts()).length - before - 2 }
  }

  step('C1: three queued messages, one of them multi-line')
  const t1 = 'Also rename the helper to parseRows.', t2 = 'Then run the tests.\nIf one fails, show me the output\n\nbefore you fix it.', t3 = 'Last: update the README.'
  const c1 = await queueBehind([t1, t2, t3])
  const expected = [t1, t2, t3].join('\n\n\n')
  await writeFile(join('C:/Claude/conductor/artifacts/verification/2026-09-26-vr8a', `${label}1-sent.txt`), c1.sent)
  record(label + '1', c1.sent === expected && !/Queued message/i.test(c1.sent) && c1.queued === 3 && c1.extraTurns === 0 ? 'PASS' : 'FAIL',
    { queued: c1.queued, sentChars: c1.sent.length, expectedChars: expected.length, exact: c1.sent === expected, header: /Queued message/i.test(c1.sent), extraTurns: c1.extraTurns, headerOverheadChars: c1.sent.length - [t1, t2, t3].join('').length },
    `sent ${JSON.stringify(c1.sent).slice(0, 400)}`)

  step('C3: the conversation view')
  const pane = view.locator(`.structured-agent-pane[data-structured-session="${id}"]`)
  const paneText = await pane.innerText()
  const positions = [t1, 'Then run the tests.', 'before you fix it.', t3].map(part => paneText.indexOf(part))
  const userItems = (await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)
  const screenshot = await shot(label + '3-conversation')
  record(label + '3', positions.every(position => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]) && !/Queued message/i.test(paneText) && userItems.includes(expected) ? 'PASS' : 'FAIL',
    { positions, header: /Queued message/i.test(paneText), userItemMatches: userItems.includes(expected), userItems: userItems.length }, screenshot)

  step('C2: one queued message goes out unchanged')
  const t4 = 'Only this one message.'
  const c2 = await queueBehind([t4])
  record(label + '2', c2.sent === t4 && c2.extraTurns === 0 ? 'PASS' : 'FAIL', { queued: c2.queued, exact: c2.sent === t4, extraTurns: c2.extraTurns }, `sent ${JSON.stringify(c2.sent)}`)
} catch (error) { await failed(error, label + '-error') }
await finish()
