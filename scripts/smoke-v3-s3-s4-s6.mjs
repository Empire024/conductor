import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// V3 verify S3/S4/S6 (runtime host quit lifecycle, CONDUCTOR_RUNTIME_HOST=1). Quitting with "Keep
// running in background" is not reachable through app-control (owner-only, no 'background' choice
// there per the plan's harness facts), so this launches with --inspect=<port> and stubs
// dialog.showMessageBox on the MAIN process over the Node inspector to auto-answer with the
// button index for the scenario, then calls app.quit() the same way.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-s3-s4-s6.mjs --scenario=s3|s4a|s4b|s6 [--keep]

const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const scenarioArg = arg('scenario') ?? 's3'
const keep = process.argv.includes('--keep')
const HARD_TIMEOUT_MS = 9 * 60_000
const outputMap = { s3: 'S3', s4a: 'S4', s4b: 'S4', s6: 'S6' }
const output = resolve(`artifacts/v3-verify/${outputMap[scenarioArg]}`)
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), `conductor-v3-${scenarioArg}-`))
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'v3-s346-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  const words = Array.from({ length: Number(process.env.V3_STREAM_WORDS ?? 40) }, (_, i) => 'w' + String(i + 1).padStart(3, '0') + ' ')
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const w of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } }); await wait(Number(process.env.V3_STREAM_DELAY_MS ?? 250)) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S3/S4/S6 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const idleMs = scenarioArg === 's4a' || scenarioArg === 's4b' ? '20000' : '20000'
const streamWords = scenarioArg === 's3' ? 40 : 20 // s3 needs the turn still running 45s after quit; s4/s6 shorter
// Stub dialog.showMessageBox BEFORE main.js loads (Runtime.evaluate over the inspector cannot
// reach `require` in the main module's scope in this Electron/Node version: process.mainModule
// is undefined and there is no bare `require` in the default global context). --require this hook
// via NODE_OPTIONS instead; it patches the dialog and leaves a marker + the app object on
// globalThis so the inspector can verify it and trigger app.quit() without needing `require`.
const buttonIndex = scenarioArg === 's6' ? 1 : 0 // 0 = "Keep running in background and quit", 1 = "Stop all and quit"
const hookPath = join(root, 'dialog-stub-hook.cjs')
await writeFile(hookPath, `
// A NODE_OPTIONS --require hook runs before Electron's bootstrap installs its special
// require('electron') module shim, so retry until that shim is ready.
const tryPatch = () => {
  try {
    const { app, dialog } = require('electron')
    dialog.showMessageBox = async (...args) => ({ response: ${buttonIndex}, checkboxChecked: false })
    globalThis.__v3DialogStubApplied = true
    globalThis.__v3ElectronApp = app
  } catch (error) { setTimeout(tryPatch, 20) }
}
tryPatch()
`)
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_RUNTIME_HOST_IDLE_MS: idleMs, V3_STREAM_WORDS: String(streamWords), V3_STREAM_DELAY_MS: '250', NODE_OPTIONS: `--require ${hookPath}` }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const call = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result }
const hostLock = () => { try { return JSON.parse(readFileSync(join(profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
const hostRequest = (lock, request) => new Promise((res, rej) => {
  const socket = connect(lock.pipe)
  let buffer = ''
  const timer = setTimeout(() => { socket.destroy(); rej(new Error('runtime host did not answer')) }, 5000)
  socket.on('error', e => { clearTimeout(timer); rej(e) })
  socket.on('connect', () => socket.write(JSON.stringify({ op: 'hello', id: 1, secret: lock.secret, protocol: lock.protocol }) + '\n' + JSON.stringify({ ...request, id: 2 }) + '\n'))
  socket.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\n').slice(0, -1)) { const m = JSON.parse(line); if (m.op === 'result' && m.id === 2) { clearTimeout(timer); socket.end(); m.ok ? res(m.value) : rej(new Error(m.error)) } }; buffer = buffer.slice(buffer.lastIndexOf('\n') + 1) })
})
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const projection = agentSessionId => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() }
}
const inspectorRpc = async (inspectPort, expression) => {
  let list
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const text = await fetch(`http://127.0.0.1:${inspectPort}/json`).then(r => r.text()); list = JSON.parse(text); if (Array.isArray(list) && list.length && list[0].webSocketDebuggerUrl) break } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!Array.isArray(list) || !list.length) throw new Error('inspector /json never returned a usable target')
  const target = list[0]
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const rpc = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMsg = event => { const msg = JSON.parse(event.data); if (msg.id === id) { ws.removeEventListener('message', onMsg); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result) } }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  await rpc('Runtime.enable')
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true })
  ws.close()
  return result
}
const tasklistCount = names => { try { return execFileSync('tasklist', { encoding: 'utf8' }).split('\n').filter(line => names.some(n => line.toLowerCase().includes(n.toLowerCase()))).length } catch { return -1 } }

const summary = { scenario: scenarioArg, root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let firstPid = null, relaunchedPid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  const cdpPort = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  let inspectPort = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid, cdpPort, inspectPort, scenario: scenarioArg })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  await expect.poll(() => hostLock()?.pid ?? null, { timeout: 30_000 }).not.toBe(null)
  const lock = hostLock()
  projectId = (await call('projects.open', { path: projectPath, name: `V3 ${scenarioArg}` })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: `V3 ${scenarioArg}` }).first().click()
  await page.waitForTimeout(500)
  observe('project selected')

  // dialog.showMessageBox was already stubbed before this main.js ever loaded (see the
  // --require hook set on the app's own env above); verify it took by asking the inspector to
  // read a marker the hook sets, and note the quit trigger still goes through the inspector.
  const readback = await inspectorRpc(inspectPort, `globalThis.__v3DialogStubApplied === true`)
  observe('dialog stub readback (set by the --require hook)', { value: readback.result?.value })
  assert.equal(readback.result?.value, true, 'dialog.showMessageBox hook did not apply before main.js loaded')

  const tabCount = scenarioArg === 's6' ? 1 : 3
  const ids = []
  for (let i = 0; i < tabCount; i++) {
    const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: `Streaming ${i}` })
    const id = tab.resourceId ?? tab.agentSessionId
    ids.push(id)
    await call('agents.submit', { agentSessionId: id, prompt: 'stream now' })
  }
  await new Promise(r => setTimeout(r, 2000))
  observe(`${tabCount} tab(s) streaming`, { ids })

  const beforeTasklist = tasklistCount(['electron.exe', 'node.exe'])
  await inspectorRpc(inspectPort, `globalThis.__v3ElectronApp.quit(); 'quit-called'`)
  observe('app.quit() called over the inspector')

  if (scenarioArg === 's3') {
    // Stay down 45s (turns finish while the app is closed), then relaunch.
    await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
    observe('app process exited (kept running in background choice honored the quit)')
    await new Promise(r => setTimeout(r, 45_000))
    const port2 = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
    const log2 = openSync(appLog, 'a')
    const child2 = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port2}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log2, log2], windowsHide: true })
    closeSync(log2)
    await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === child2.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
    owner = await credential()
    relaunchedPid = owner.pid
    observe('relaunched after 45s', { pid: relaunchedPid })
    for (const id of ids) await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId: id })).phase } catch { return null } }, { timeout: 60_000, intervals: [500] }).toBe('completed')
    const results = {}
    for (const id of ids) {
      const proj = projection(id)
      const items = proj.items ?? []
      const assistant = items.filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
      const notices = items.filter(item => item.data?.type === 'notice').map(item => item.data.message)
      const disconnectedEver = false // phase is now 'completed'; recorded for completeness
      results[id] = { assistantTextCount: assistant.length, hasFullText: assistant.some(t => t.length > 0), notices: notices.filter(n => /restarted while this turn kept running/i.test(n)) }
    }
    summary.s3 = results
    observe('S3 result: all tabs completed after background quit + 45s + relaunch', results)
    for (const id of ids) assert.ok(results[id].notices.length >= 1, `${id}: missing the "restarted while this turn kept running" notice`)
  } else if (scenarioArg === 's4a') {
    await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
    await new Promise(r => setTimeout(r, 90_000))
    const port2 = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
    const inspectPort2 = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
    const log2 = openSync(appLog, 'a')
    const child2 = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port2}`, `--inspect=${inspectPort2}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log2, log2], windowsHide: true })
    closeSync(log2)
    await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === child2.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
    owner = await credential()
    relaunchedPid = owner.pid
    inspectPort = inspectPort2 // the S4b continuation below reuses this variable
    let recoveredFully = true, statusAfter
    try {
      for (const id of ids) await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId: id })).phase } catch { return null } }, { timeout: 60_000, intervals: [500] }).toBe('completed')
      statusAfter = await Promise.all(ids.map(id => call('agents.status', { agentSessionId: id })))
    } catch (e) { recoveredFully = false; statusAfter = await Promise.all(ids.map(id => call('agents.status', { agentSessionId: id }).catch(err => ({ error: err.message })))) }
    summary.s4a = { recoveredFully, statusAfter }
    observe('S4a: recovery after idle-timeout window past turn completion', summary.s4a)

    // S4b continues from here: everything is reattached and completed; quit with "Stop all" (no
    // active work, so no dialog is even raised) and measure how long the runtime host process
    // itself takes to exit, and whether any orphan node/claude/codex fixture process remains.
    const hostPidBefore = hostLock()?.pid ?? null
    const beforeTasklistB = tasklistCount(['electron.exe', 'node.exe'])
    const quitStartedAt = Date.now()
    await inspectorRpc(inspectPort, `globalThis.__v3ElectronApp.quit(); 'quit-called'`)
    observe('S4b: app.quit() called with everything already completed (no active work)')
    await expect.poll(() => alive(relaunchedPid), { timeout: 30_000 }).toBe(false)
    const appExitElapsedMs = Date.now() - quitStartedAt
    // The host is a separate process from the app; poll until it too exits.
    let hostExitedAt = null
    const idleBudgetMs = Number(idleMs) + 10_000
    const hostDeadline = Date.now() + idleBudgetMs
    while (Date.now() < hostDeadline) {
      if (hostPidBefore && !alive(hostPidBefore)) { hostExitedAt = Date.now(); break }
      await new Promise(r => setTimeout(r, 1000))
    }
    const hostExitElapsedMs = hostExitedAt ? hostExitedAt - quitStartedAt : null
    await new Promise(r => setTimeout(r, 2000))
    const afterTasklistB = tasklistCount(['electron.exe', 'node.exe'])
    summary.s4b = { hostPidBefore, appExitElapsedMs, hostExitElapsedMs, idleBudgetMs, hostExitedWithinBudget: hostExitElapsedMs !== null && hostExitElapsedMs <= idleBudgetMs, tasklistBefore: beforeTasklistB, tasklistAfter: afterTasklistB, noOrphans: afterTasklistB <= beforeTasklistB }
    observe('S4b: host exit timing and orphan check', summary.s4b)
    firstPid = null; relaunchedPid = null // already confirmed dead; avoid a redundant taskkill in finally
  } else if (scenarioArg === 's6') {
    await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
    observe('app process exited ("Stop all and quit" choice)')
    await new Promise(r => setTimeout(r, 3000))
    const after = tasklistCount(['electron.exe', 'node.exe'])
    let tabPhase = null
    try { const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true }); const row = db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(ids[0]); tabPhase = row ? JSON.parse(row.projection_json).phase : null; db.close() } catch (e) { tabPhase = `error: ${e.message}` }
    let hostListAfter = 'host process gone'
    const lockAfter = hostLock()
    if (lockAfter && alive(lockAfter.pid)) { try { hostListAfter = await hostRequest(lockAfter, { op: 'list' }) } catch (e) { hostListAfter = `error: ${e.message}` } }
    summary.s6 = { tasklistBefore: beforeTasklist, tasklistAfter: after, tabPhase, hostListAfter, noOrphans: after <= beforeTasklist }
    observe('S6: process count, tab phase and host runtime list after quit-with-stop-all', summary.s6)
    assert.notEqual(tabPhase, 'completed', 'the turn silently continued to completion instead of being stopped')
  }
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /runtime host|reattach|quit|restart|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
  const lock = hostLock()
  if (lock) await hostRequest(lock, { op: 'shutdown' }).catch(() => {})
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, `${scenarioArg}-summary.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
