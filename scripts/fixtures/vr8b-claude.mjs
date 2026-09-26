// VR8b Claude stand-in (scripts/smoke-verify-vr8b-*.mjs), written as the fixture dir's
// fake-claude.mjs so the app spawns it on the real transport / runtime host path.
//   "VR8B LONG <name> <sec>"  streams for <sec> s and calls app control once a second meanwhile
//   "VR8B ACK <tag> <name>"   answers ack:<tag>:<name> pid <pid> at once
//   "VR8B CALL <name>"        one app-control call now with the endpoint and token it holds
//   "VR8B TOOL <name> <sec>"  starts a child process (a "tool") that lives <sec> s, logs its pid
// The endpoint and token are taken from every message received (briefing or steer), when it holds them.
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.CONDUCTOR_TEST_FIXTURE_DIR
const log = (file, entry) => appendFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
// Like the real CLI, a resumed conversation keeps its id (--resume / --session-id <id>).
const idArg = process.argv.findIndex(arg => arg === '--resume' || arg === '--session-id')
const sessionId = idArg >= 0 ? process.argv[idArg + 1] : 'vr8b-native-' + process.pid
const emit = message => send({ uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let control = null, name = '?', busy = false
const queued = []
const callOnce = async () => {
  const started = Date.now(), port = control ? new URL(control.endpoint).port : null
  try {
    const response = await fetch(control.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'agents.list', args: {} }), signal: AbortSignal.timeout(150000) })
    const entry = { name, status: response.status, ms: Date.now() - started, port }
    log('calls.jsonl', entry)
    return entry
  } catch (error) {
    const entry = { name, status: 0, ms: Date.now() - started, port, error: String(error.cause?.code ?? error.message) }
    log('calls.jsonl', entry)
    return entry
  }
}
const calls = async until => { while (Date.now() < until) { if (control) await callOnce(); await wait(1000) } }
const stream = async (words, delay) => {
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const word of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } }); await wait(delay) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
}
const turn = async prompt => {
  busy = true
  log('prompts.jsonl', { name, prompt: prompt.slice(0, 4000) })
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const long = /VR8B LONG (\S+) (\d+)/.exec(prompt), ack = /VR8B ACK (\S+) (\S+)/.exec(prompt), one = /VR8B CALL (\S+)/.exec(prompt), tool = /VR8B TOOL (\S+) (\d+)/.exec(prompt)
  if (long) {
    name = long[1]
    const count = Math.max(1, Math.round(Number(long[2]) * 2))
    const words = Array.from({ length: count }, (_, i) => 'w' + i + ' ')
    await Promise.all([stream([...words, 'long-done:' + name], 500), calls(Date.now() + count * 500)])
  } else if (ack) await stream([`ack:${ack[1]}:${ack[2]} pid ${process.pid}`], 10)
  else if (one) { name = one[1]; const entry = control ? await callOnce() : { status: 'no-endpoint' }; await stream([`call:${one[1]}:${entry.status}:${entry.port ?? '-'}`], 10) }
  else if (tool) {
    name = tool[1]
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(tool[2]) * 1000}) // vr8b-tool-${tool[1]}`], { stdio: 'ignore' })
    log('tools.jsonl', { name, toolPid: child.pid })
    await stream(['tool-started:' + tool[1] + ' ', 'tool-pid:' + child.pid], Number(tool[2]) * 1000)
  } else await stream(['noted'], 10)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  busy = false
  if (queued.length) void turn(queued.shift())
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const content = message.message.content
  const prompt = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : String(content)
  const endpoint = /POST (http:\/\/127\.0\.0\.1:\d+\/control)/.exec(prompt)?.[1], token = /Bearer ([a-f0-9]{64})/.exec(prompt)?.[1]
  if (endpoint && token) control = { endpoint, token }
  log('inbox.jsonl', { name, busy, text: prompt.slice(0, 4000) })
  if (busy) queued.push(prompt); else void turn(prompt)
})
