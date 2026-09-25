// FX16 (feature-list.md runtime-host-hook-endpoint, runtime-host-handle-inheritance): after an
// app restart with the runtime host on, a turn that kept running can still use its tools, and
// the relaunched app answers on its --remote-debugging-port.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx16-restart-tools.mjs
//
// The Claude stand-in behaves like the installed CLI where it matters: it honours the hook
// timeout Conductor registers at initialize, and it calls the MCP servers named in its
// --mcp-config over HTTP. It streams, waits until the app process that started it is gone, and
// then - while no app is listening - sends a PreToolUse hook and calls every MCP server. The
// relaunched app must answer the hook and the MCP calls must reach the new app's servers.
//
// R1 hook-after-restart   the hook sent while no app ran is answered (not timed out), and so is a
//                         second tool call's hook after the reattach.
// R2 mcp-after-restart    every Conductor MCP server answers tools/list, both the calls made while
//                         no app ran and the ones after.
// R3 cdp-after-restart    the relaunched app's debugging port answers (the runtime host no longer
//                         holds the old app's listening socket).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, safeClose, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx16-restart-tools' })
watchdog(9 * 60)
await loadCheck()

const FIXTURE = String.raw`
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'fx16-native', parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const evidence = { pid: process.pid, hookTimeout: null, hooks: [] }
const save = () => writeFileSync(join(process.env.CONDUCTOR_TEST_FIXTURE_DIR, 'fx16-evidence.json'), JSON.stringify(evidence, null, 2))
const configs = []
for (let i = process.argv.indexOf('--mcp-config') + 1; i > 0 && i < process.argv.length && !process.argv[i].startsWith('--'); i++) configs.push(process.argv[i])
const servers = configs.flatMap(config => Object.entries(JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8')).mcpServers ?? {}).map(([name, server]) => ({ name, url: server.url, authorization: server.headers?.Authorization })))
evidence.servers = servers.map(server => ({ name: server.name, url: server.url }))
const text = content => {
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: content }] } })
}
const pending = new Map()
let hookTimeout = 15
// Like the CLI: a hook nobody answers within its registered timeout fails the tool call.
const hook = (callback, tool, input) => new Promise(resolve => {
  const id = 'fx16-' + randomUUID(), started = Date.now()
  const timer = setTimeout(() => { pending.delete(id); resolve({ callback, ok: false, error: 'PreToolUse hook did not respond before its timeout (' + hookTimeout + ' s)', ms: Date.now() - started }) }, hookTimeout * 1000)
  pending.set(id, response => { clearTimeout(timer); resolve({ callback, ok: response.subtype === 'success', error: response.error, ms: Date.now() - started }) })
  send({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: callback, tool_use_id: tool, input: { tool_use_id: tool, tool_name: 'Bash', tool_input: input } } })
})
const mcp = async server => {
  const started = Date.now()
  try {
    const response = await fetch(server.url, { method: 'POST', headers: { Authorization: server.authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(300_000) })
    const body = await response.json().catch(() => null)
    return { name: server.name, status: response.status, tools: body?.result?.tools?.length ?? 0, ms: Date.now() - started }
  } catch (error) { return { name: server.name, status: 0, error: String(error.cause?.code ?? error.message ?? error), ms: Date.now() - started } }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const tool = async (id, input) => {
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id, name: 'Bash', input }] } })
  const before = await hook('conductor_before', id, input)
  evidence.hooks.push({ tool: id, ...before })
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: before.ok ? 'ran' : before.error, is_error: !before.ok }] } })
  if (before.ok) evidence.hooks.push({ tool: id, ...(await hook('conductor_after', id, input)) })
}
let busy = false
const queued = []
const turn = async prompt => {
  busy = true
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (prompt.startsWith('FX16 RESTART')) {
    evidence.mcpBefore = await Promise.all(servers.map(mcp))
    const owner = JSON.parse(readFileSync(join(process.env.CONDUCTOR_TEST_USER_DATA, 'control-owner.json'), 'utf8')).pid
    text('fx16-streaming ')
    save()
    // The smoke restarts the app now. Wait until the process that started this turn is gone.
    const deadline = Date.now() + 90_000
    while (alive(owner) && Date.now() < deadline) await wait(100)
    evidence.appGone = !alive(owner)
    evidence.appGoneAt = new Date().toISOString()
    // No app is listening: a tool call's hook and MCP calls go out now.
    const [during] = await Promise.all([
      tool('fx16-tool-1', { command: 'echo fx16', description: 'tool call while Conductor restarts' }),
      Promise.all(servers.map(mcp)).then(results => { evidence.mcpDuring = results })
    ])
    // A later tool call, after the reattach.
    await tool('fx16-tool-2', { command: 'echo fx16-again', description: 'tool call after the reattach' })
    evidence.mcpAfter = await Promise.all(servers.map(mcp))
    save()
    text('fx16-done')
  } else text('Briefing noted.')
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  busy = false
  if (queued.length) void turn(queued.shift())
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') {
      hookTimeout = message.request.hooks?.PreToolUse?.[0]?.timeout ?? 15
      evidence.hookTimeout = hookTimeout
    }
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type === 'control_response') { const settle = pending.get(message.response.request_id); pending.delete(message.response.request_id); settle?.(message.response); return }
  if (message.type !== 'user') return
  const content = message.message.content
  const prompt = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : String(content)
  if (busy) queued.push(prompt); else void turn(prompt)
})
`

const listeners = port => spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "pid=$($_.OwningProcess)" }`], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s+/).filter(Boolean)
const history = async id => JSON.stringify(await call('agents.history', { agentSessionId: id }))

try {
  const inst = await launchParked({ mode: 'spawn', env: { CONDUCTOR_RUNTIME_HOST: '1' }, fixtures: { 'fake-claude.mjs': FIXTURE } })
  const evidencePath = join(inst.root, 'fixtures', 'fx16-evidence.json')
  const hostLock = () => { try { return JSON.parse(readFileSync(join(inst.profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
  await page(inst)
  const hostBefore = await poll(() => hostLock(), { timeoutMs: 30_000, label: 'runtime host lock' })
  await openProject({ name: 'FX16 restart', git: true })
  const tab = await openTab({ provider: 'claude', title: 'FX16' })
  const id = tab.resourceId

  step('a turn streams, then the app restarts under it')
  await call('agents.submit', { agentSessionId: id, prompt: 'FX16 RESTART' })
  await poll(async () => (await history(id)).includes('fx16-streaming'), { timeoutMs: 30_000, intervalMs: 250, label: 'the turn to stream' })
  const firstPid = inst.credential.pid
  const listenBefore = listeners(inst.cdpPort)
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, firstPid, { timeoutMs: 60_000 })
  const listenAfter = listeners(inst.cdpPort)

  step('R3 the relaunched app answers on its debugging port')
  let cdp = 'answered'
  try { await page(inst) } catch (error) { cdp = String(error.message ?? error).slice(0, 300) }
  const hostAfter = hostLock()
  record('R3-cdp-after-restart', cdp === 'answered' ? 'PASS' : 'FAIL', { relaunchSeconds: seconds, hostPid: hostAfter?.pid, sameHost: hostAfter?.pid === hostBefore.pid }, `port ${inst.cdpPort} listeners before ${JSON.stringify(listenBefore)} (app ${firstPid}), after ${JSON.stringify(listenAfter)} (app ${inst.credential.pid}); CDP: ${cdp}`)
  if (cdp === 'answered') await shot('R3-after-restart')

  step('the kept turn finishes with its tools')
  await poll(async () => (await call('agents.status', { agentSessionId: id })).phase === 'completed' && existsSync(evidencePath) && JSON.parse(readFileSync(evidencePath, 'utf8')).mcpAfter, { timeoutMs: 180_000, intervalMs: 1000, label: 'the kept turn to complete' })
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  const text = await history(id)
  const hooksOk = evidence.hooks.length === 4 && evidence.hooks.every(entry => entry.ok)
  record('R1-hook-after-restart', evidence.appGone && hooksOk && evidence.hookTimeout >= 600 ? 'PASS' : 'FAIL',
    { hookTimeout: evidence.hookTimeout, heldMs: evidence.hooks[0]?.ms, hooks: evidence.hooks.length, kept: /kept running/.test(text) },
    JSON.stringify({ appGone: evidence.appGone, hooks: evidence.hooks }))
  const answered = list => Array.isArray(list) && list.length >= 2 && list.every(entry => entry.status === 200 && entry.tools > 0)
  record('R2-mcp-after-restart', answered(evidence.mcpDuring) && answered(evidence.mcpAfter) ? 'PASS' : 'FAIL',
    { servers: evidence.servers.length, duringMs: Math.max(...(evidence.mcpDuring ?? []).map(entry => entry.ms)) },
    JSON.stringify({ servers: evidence.servers, before: evidence.mcpBefore, during: evidence.mcpDuring, after: evidence.mcpAfter }))

  step('safeClose after a relaunch')
  const close = await safeClose(inst)
  record('fx16-close', close.leftovers.length === 0 ? 'PASS' : 'FAIL', { tree: close.tree, killed: close.killed.length, leftovers: close.leftovers.length })
} catch (error) {
  await failed(error)
}
await finish()
