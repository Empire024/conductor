// V3 S10 (10 idle tabs survive an owner app.restart), ported onto scripts/verify-kit.mjs as the
// spawn-mode proof for FX13 verify-kit. The original, scripts/smoke-v3-idle-restart.mjs, is kept.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-kit-v3-idle-restart.mjs [--keep]
// Pass rule: every idle tab is still `completed` after the relaunch, 3 of them take a new turn, and
// safeClose leaves no process of either app instance behind.
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, poll, record, relaunched, safeClose, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'kit-v3-idle-restart' })
watchdog(9 * 60)
await loadCheck()

// fake-claude: a short turn that completes at once, like the installed CLI's stream-json shape.
const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'kit-idle-smoke', parent_tool_use_id: null, ...message })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'Short done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const phase = async id => (await call('agents.status', { agentSessionId: id })).phase
const completed = (id, label) => poll(async () => (await phase(id)) === 'completed', { timeoutMs: 30_000, intervalMs: 250, label })

try {
  const inst = await launchParked({ mode: 'spawn', fixtures: { 'fake-claude.mjs': fakeClaude } })
  await openProject({ name: 'Kit idle restart', git: true })

  step('10 idle tabs, one short turn each')
  const idle = []
  for (let i = 0; i < 10; i++) {
    const tab = await openTab({ provider: 'claude', title: `Idle ${i}` })
    idle.push(tab.resourceId)
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt: `short turn ${i}` })
  }
  for (const id of idle) await completed(id, `${id} completed`)
  await shot('S10-before-restart')

  step('owner app.restart {force:true}')
  const firstPid = inst.credential.pid
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, firstPid, { timeoutMs: 30_000 })
  const after = {}
  for (const id of idle) { try { after[id] = await phase(id) } catch (error) { after[id] = `ERROR ${error.message}` } }
  const broke = idle.filter(id => after[id] !== 'completed')
  record('S10-idle-survive', broke.length ? 'FAIL' : 'PASS', { tabs: idle.length, broke: broke.length, relaunchSeconds: seconds, pids: [firstPid, inst.credential.pid] }, broke.length ? JSON.stringify(broke.map(id => ({ id, phase: after[id] }))) : 'all 10 idle tabs still completed after the relaunch')

  step('3 idle tabs reconnect lazily')
  const again = idle.slice(0, 3)
  for (const id of again) await call('agents.submit', { agentSessionId: id, prompt: 'reconnect check' })
  for (const id of again) await completed(id, `${id} completed after reconnect`)
  record('S10-reconnect', 'PASS', { tabs: again.length }, await shot('S10-after-reconnect'))

  step('safeClose after a relaunch')
  const close = await safeClose(inst)
  record('kit-close-spawn', close.leftovers.length === 0 && close.tree > 1 ? 'PASS' : 'FAIL', { tree: close.tree, killed: close.killed.length, leftovers: close.leftovers.length, ms: close.ms }, `tracked pids ${JSON.stringify([...inst.pids])}`)
} catch (error) {
  await failed(error)
}
await finish()
