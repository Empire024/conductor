// VR2 group host (feature-list.md runtime-host-hook-endpoint, runtime-host-handle-inheritance).
//   H1  "the orchestrator lost every tool" after an install: the app was away 45 s, then slow. A
//       streaming Claude turn is kept by the runtime host through a quit ("keep running in
//       background"), the app stays away GAP_S (60 s), and meanwhile the kept CLI makes a tool call
//       (its PreToolUse hook) and calls every Conductor MCP server; then the app is launched again.
//       pass: the gap hook and MCP calls are answered, a later tool call too, the turn completes.
//       control: the gap hook was held longer than the pre-fix 15 s hook timeout (heldMs > 15000),
//       so the old registration would have failed it; run with --build of the pre-fix commit to see it.
//   I1  "a relaunched app can bind its ports again": the host is started by an app that already
//       listens on a fixed phone port and a debugging port; after app.restart the new app answers
//       on both. control: the same port answered from the first app before the restart.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr2-host.mjs [--only=H1|I1]
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, owner, page, poll, record, relaunched, safeClose, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'
import { phoneClient } from './verify-phone-kit.mjs'

configure({ name: 'vr2-host', output: process.env.VR2_OUT ?? 'artifacts/verification/2026-09-25-vr2' })
watchdog(16 * 60)
const only = (process.argv.find(arg => arg.startsWith('--only=')) ?? '').slice(7)
const GAP_S = Number(process.env.VR2_GAP_S ?? 60)
const tag = process.env.VR2_TAG ? `-${process.env.VR2_TAG}` : ''

// The fx16 stand-in (scripts/smoke-fx16-restart-tools.mjs): honours the hook timeout registered at
// initialize and calls the MCP servers of its --mcp-config; waits for the app that started the turn
// to be gone, then makes a tool call and MCP calls while no app runs.
const FIXTURE = String.raw`
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'vr2-host', parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const evidence = { pid: process.pid, hookTimeout: null, hooks: [] }
const save = () => writeFileSync(join(process.env.CONDUCTOR_TEST_FIXTURE_DIR, 'vr2-evidence.json'), JSON.stringify(evidence, null, 2))
const configs = []
for (let i = process.argv.indexOf('--mcp-config') + 1; i > 0 && i < process.argv.length && !process.argv[i].startsWith('--'); i++) configs.push(process.argv[i])
const servers = configs.flatMap(config => Object.entries(JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8')).mcpServers ?? {}).map(([name, server]) => ({ name, url: server.url, authorization: server.headers?.Authorization })))
evidence.servers = servers.map(server => ({ name: server.name, url: server.url }))
const text = content => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: content }] } })
const pending = new Map()
let hookTimeout = 15
const hook = (callback, tool, input) => new Promise(resolve => {
  const id = 'vr2-' + randomUUID(), started = Date.now()
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
  evidence.hooks.push({ tool: id, at: new Date().toISOString(), ...before })
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: before.ok ? 'ran' : before.error, is_error: !before.ok }] } })
  if (before.ok) evidence.hooks.push({ tool: id, ...(await hook('conductor_after', id, input)) })
}
let busy = false
const queued = []
const turn = async prompt => {
  busy = true
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (prompt.startsWith('VR2 KEEP')) {
    evidence.mcpBefore = await Promise.all(servers.map(mcp))
    const owner = JSON.parse(readFileSync(join(process.env.CONDUCTOR_TEST_USER_DATA, 'control-owner.json'), 'utf8')).pid
    text('vr2-streaming ')
    save()
    const deadline = Date.now() + 120_000
    while (alive(owner) && Date.now() < deadline) await wait(100)
    evidence.appGone = !alive(owner)
    evidence.appGoneAt = new Date().toISOString()
    save()
    await wait(2000)
    await Promise.all([
      tool('vr2-tool-gap', { command: 'echo gap', description: 'tool call while Conductor is away' }),
      Promise.all(servers.map(mcp)).then(results => { evidence.mcpDuring = results })
    ])
    await tool('vr2-tool-after', { command: 'echo after', description: 'tool call after the reattach' })
    evidence.mcpAfter = await Promise.all(servers.map(mcp))
    save()
    text('vr2-done')
  } else text('Briefing noted.')
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  busy = false
  if (queued.length) void turn(queued.shift())
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') { hookTimeout = message.request.hooks?.PreToolUse?.[0]?.timeout ?? 15; evidence.hookTimeout = hookTimeout }
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } })
  }
  if (message.type === 'control_response') { const settle = pending.get(message.response.request_id); pending.delete(message.response.request_id); settle?.(message.response); return }
  if (message.type !== 'user') return
  const content = message.message.content
  const prompt = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : String(content)
  if (busy) queued.push(prompt); else void turn(prompt)
})
`

const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const freePort = () => new Promise((done, fail) => { const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)) }) })
const listeners = port => spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s+/).filter(Boolean).map(Number)
/** Starts the same profile again as a fresh process (what the owner's next launch is), tracked by the instance. */
function launchAgain(inst, env = inst.env) {
  const log = openSync(join(inst.root, 'app.log'), 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${inst.cdpPort}`, BUILD], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  inst.pids.add(child.pid)
  return child
}
/** Quits the app the way the owner's window close does; the stop question answers itself in a test profile. */
async function quitApp(inst) {
  const pid = inst.credential.pid
  const view = await page(inst)
  await withDeadline(view.evaluate(() => { window.close(); return true }), 5000)
  const gone = await poll(() => !isAlive(pid), { timeoutMs: 30_000, intervalMs: 250, label: `pid ${pid} to exit after window.close()` }).then(() => 'window.close', () => null)
  if (gone) return gone
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], { windowsHide: true })
  await poll(() => !isAlive(pid), { timeoutMs: 30_000, intervalMs: 250, label: `pid ${pid} to exit after CloseMainWindow` })
  return 'CloseMainWindow'
}
const hostLock = inst => { try { return JSON.parse(readFileSync(join(inst.profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
/** safeClose, then this run's own runtime host: since FX16 it is started detached (Start-Process), so
 *  it is outside the app's process tree and would hold the temp profile until its 5-minute idle exit. */
async function closeWithHost(inst) {
  const host = hostLock(inst)
  const close = await safeClose(inst)
  if (host?.pid && isAlive(host.pid)) { spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); close.hostKilled = host.pid }
  return close
}

try {
  await loadCheck()
  if (!only || only === 'H1') {
    const inst = await launchParked({ mode: 'spawn', name: 'vr2-host-h1', env: { CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_TEST_STOP_DECISION: 'background', CONDUCTOR_TEST_EMPTY_HISTORY: '1' }, fixtures: { 'fake-claude.mjs': FIXTURE } })
    const evidencePath = join(inst.root, 'fixtures', 'vr2-evidence.json')
    await page(inst)
    await poll(() => hostLock(inst), { timeoutMs: 30_000, label: 'runtime host lock' })
    await openProject({ name: 'VR2 kept turn', git: true })
    const { resourceId: id } = await openTab({ provider: 'claude', title: 'VR2 orchestrator' })
    const history = async () => JSON.stringify(await call('agents.history', { agentSessionId: id }))

    step('H1 a streaming turn, then the owner quits with "keep running"')
    await call('agents.submit', { agentSessionId: id, prompt: 'VR2 KEEP running through the install' })
    await poll(async () => (await history()).includes('vr2-streaming'), { timeoutMs: 30_000, intervalMs: 250, label: 'the turn to stream' })
    const firstPid = inst.credential.pid
    const how = await quitApp(inst)
    const goneAt = Date.now()
    step(`H1 the app stays away ${GAP_S} s`)
    await sleep(GAP_S * 1000)
    const keptMeanwhile = JSON.parse(readFileSync(evidencePath, 'utf8'))
    launchAgain(inst)
    const seconds = await relaunched(inst, firstPid, { timeoutMs: 120_000 })
    step('H1 the kept turn finishes with its tools')
    const settled = await poll(async () => { const status = await call('agents.status', { agentSessionId: id }).catch(() => null); const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null; return evidence?.mcpAfter && status?.phase === 'completed' ? { status, evidence } : null }, { timeoutMs: 240_000, intervalMs: 1000, label: 'the kept turn to complete' }).catch(error => ({ error: String(error.message).slice(0, 600) }))
    const evidence = settled.evidence ?? JSON.parse(readFileSync(evidencePath, 'utf8'))
    const text = await history().catch(() => '')
    const gapHook = evidence.hooks.find(entry => entry.tool === 'vr2-tool-gap' && entry.callback === 'conductor_before')
    const answered = list => Array.isArray(list) && list.length >= 2 && list.every(entry => entry.status === 200 && entry.tools > 0)
    const hooksOk = evidence.hooks.length === 4 && evidence.hooks.every(entry => entry.ok)
    record(`H1-kept-turn-tools${tag}`, !settled.error && evidence.appGone && hooksOk && answered(evidence.mcpDuring) && answered(evidence.mcpAfter) && text.includes('vr2-done') && gapHook?.ms > 15_000 ? 'PASS' : 'FAIL',
      { gapS: GAP_S, quitBy: how, relaunchSeconds: Math.round(seconds), hookTimeout: evidence.hookTimeout, gapHookHeldMs: gapHook?.ms, hooks: evidence.hooks.map(entry => `${entry.tool}/${entry.callback}:${entry.ok ? 'ok' : 'FAILED'}`), mcpDuring: (evidence.mcpDuring ?? []).map(entry => `${entry.name}:${entry.status}/${entry.tools}/${entry.ms}ms`), mcpAfter: (evidence.mcpAfter ?? []).map(entry => `${entry.name}:${entry.status}`), phase: settled.status?.phase ?? null, stillRunningDuringGap: !keptMeanwhile.mcpDuring },
      `${settled.error ?? ''} control: the gap hook was held ${gapHook?.ms} ms, longer than the pre-fix 15 s hook timeout; app away ${Math.round((Date.now() - goneAt) / 1000 - seconds)} s+; hook errors ${JSON.stringify(evidence.hooks.filter(entry => !entry.ok).map(entry => entry.error))}`)
    if (!settled.error) await shot(`H1-after${tag}`)
    await closeWithHost(inst)
  }

  if (!only || only === 'I1') {
    const phonePort = await freePort()
    const inst = await launchParked({ mode: 'spawn', name: 'vr2-host-i1', env: { CONDUCTOR_RUNTIME_HOST: '0', CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
    step(`I1 phone access on the fixed port ${phonePort}, then quit`)
    const view = await page(inst)
    const set = await view.evaluate(port => window.conductor.phone.setSettings({ enabled: true, port }), phonePort)
    if (!set.listening) throw new Error('phone listener did not start: ' + set.message)
    const health = () => phoneClient(`https://127.0.0.1:${phonePort}`).req('/api/health', { timeoutMs: 3000 }).then(answer => answer.status, () => 0)
    const firstPid = inst.credential.pid
    await quitApp(inst)

    step('I1 a launch with the runtime host: the phone port listens before the host starts')
    const started = Date.now()
    launchAgain(inst, { ...inst.env, CONDUCTOR_RUNTIME_HOST: '1' })
    const phoneUpAt = await poll(async () => (await health()) === 200 ? Date.now() : null, { timeoutMs: 60_000, intervalMs: 100, label: 'the phone port on the second launch' })
    const host = await poll(() => hostLock(inst), { timeoutMs: 60_000, intervalMs: 100, label: 'runtime host lock' })
    const hostAt = statSync(join(inst.profile, 'runtime-host', 'host.json')).mtimeMs
    await owner(inst, { notPid: firstPid, timeoutMs: 60_000 })
    const secondPid = inst.credential.pid
    const before = { health: await health(), listeners: listeners(phonePort), cdp: listeners(inst.cdpPort) }
    await page(inst)

    step('I1 app.restart; the new app binds both ports')
    await call('app.restart', { force: true })
    const seconds = await relaunched(inst, secondPid, { timeoutMs: 60_000 })
    const phoneBack = await poll(async () => (await health()) === 200, { timeoutMs: 30_000, intervalMs: 250, label: 'the phone port after the restart' }).then(() => true, () => false)
    let cdp = 'answered'
    try { await page(inst) } catch (error) { cdp = String(error.message ?? error).slice(0, 200) }
    const after = { listeners: listeners(phonePort), cdp: listeners(inst.cdpPort) }
    const phoneOwnedByNew = after.listeners.includes(inst.credential.pid)
    record(`I1-ports-after-restart${tag}`, before.health === 200 && phoneBack && phoneOwnedByNew && cdp === 'answered' ? 'PASS' : 'FAIL',
      { phonePort, relaunchSeconds: Math.round(seconds * 10) / 10, hostPid: host.pid, phoneUpBeforeHostMs: Math.round(hostAt - phoneUpAt), phoneBack, cdp: cdp === 'answered' ? 'answered' : 'no answer' },
      `control: before the restart port ${phonePort} answered ${before.health} from app ${secondPid} (listeners ${JSON.stringify(before.listeners)}); after: listeners ${JSON.stringify(after.listeners)} (app ${inst.credential.pid}), cdp listeners ${JSON.stringify(after.cdp)}; phone up ${phoneUpAt - started} ms after launch, host lock ${Math.round(hostAt - started)} ms`)
    await closeWithHost(inst)
  }
} catch (error) {
  await failed(error, `vr2-host${tag}`)
}
await finish()
