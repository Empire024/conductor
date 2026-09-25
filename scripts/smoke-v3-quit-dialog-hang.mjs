import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// V3 verify S12 hang evidence: app.restart{force:false} with only idle/stopped tabs (no running
// turns) returns 200 {restarting:true} but the process does not exit within 30-120s (see S12 in
// results.md, 3 prior runs). This run captures WHY: launches with --inspect=0 so the main process's
// own Node inspector can be queried (BrowserWindow list, in case a native dialog/modal is silently
// blocking exit), plus a PowerShell process/window snapshot and a CDP screenshot of the parked
// window, all written under artifacts/v3-verify/S12/.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-quit-dialog-hang.mjs

const HARD_TIMEOUT_MS = 6 * 60_000
const output = resolve('artifacts/v3-verify/S12')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-hang-'))
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
const emit = m => send({ uuid: randomUUID(), session_id: 'v3-hang-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const slow = JSON.stringify(message).includes('stream slowly')
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  if (slow) { for (let i = 0; i < 200; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) } }
  else emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: slow ? 'slow-done' : 'Short done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 hang-diagnosis smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credentialFile = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const call = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const psJson = cmd => new Promise(done => execFile('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }, (err, stdout) => done(stdout ?? String(err))))

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); writeFile(join(output, 'S12-hang-summary.json'), JSON.stringify({ ...summary, observations }, null, 2)).finally(() => process.exit(1)) }, HARD_TIMEOUT_MS)
let firstPid = null, failed = null, browser
const appLog = join(output, 'app.log')
try {
  const cdpPort = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const inspectPort = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid, cdpPort, inspectPort })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credentialFile()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 hang diagnosis' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 hang diagnosis' }).first().click()
  await page.waitForTimeout(500)

  // Set up 10 idle + 1 stopped-with-queued-prompt, no running turns (the S12 no-dialog case).
  const idleIds = []
  for (let i = 0; i < 10; i++) {
    const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: `Idle ${i}` })
    const id = tab.resourceId ?? tab.agentSessionId
    idleIds.push(id)
    await call('agents.submit', { agentSessionId: id, prompt: `short ${i}` })
  }
  for (const id of idleIds) await expect.poll(async () => (await call('agents.status', { agentSessionId: id })).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  const stoppedTab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Stopped with queued' })
  const stoppedId = stoppedTab.resourceId ?? stoppedTab.agentSessionId
  await call('agents.submit', { agentSessionId: stoppedId, prompt: 'stream slowly' })
  await expect.poll(async () => (await call('agents.status', { agentSessionId: stoppedId })).phase, { timeout: 10_000, intervals: [250] }).not.toBe(undefined)
  await call('agents.steer', { agentSessionId: stoppedId, prompt: 'queued while stopping' }).catch(() => {})
  await call('agents.interrupt', { agentSessionId: stoppedId })
  await new Promise(r => setTimeout(r, 1000))
  observe('12-tab state ready: 10 idle + 1 stopped (interrupted) with a leftover queued prompt, no running turns')

  const restart = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'app.restart', args: { force: false }, scope: { projectId } }) })
  const restartBody = await restart.json()
  observe('app.restart{force:false} sent', { status: restart.status, body: restartBody })

  await new Promise(r => setTimeout(r, 20_000))
  const stillAlive = alive(firstPid)
  observe('process alive 20s after the 200 response?', { stillAlive, firstPid })

  const hang = { stillAlive, firstPid }
  if (stillAlive) {
    // Query the main process's own Node inspector for BrowserWindow state.
    try {
      const list = await fetch(`http://127.0.0.1:${inspectPort}/json`).then(r => r.json())
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
      const expression = `JSON.stringify((process.mainModule.require('electron').BrowserWindow.getAllWindows()).map(w => ({ title: w.getTitle(), bounds: w.getBounds(), visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized() })))`
      const evalResult = await rpc('Runtime.evaluate', { expression, returnByValue: true })
      hang.browserWindows = JSON.parse(evalResult.result.value)
      ws.close()
      observe('BrowserWindow.getAllWindows() over the main process inspector', { browserWindows: hang.browserWindows })
    } catch (error) { hang.inspectorError = String(error.message ?? error); observe('inspector query failed', { message: hang.inspectorError }) }

    // Owner app.state (pendingQuitConfirmation).
    try {
      owner = await credentialFile().catch(() => owner)
      hang.appState = await call('app.state')
      observe('app.state while hung', { pendingQuitConfirmation: hang.appState.pendingQuitConfirmation })
    } catch (error) { hang.appStateError = String(error.message ?? error) }

    // PowerShell: MainWindowTitle and child processes of the hung pid.
    hang.mainWindowTitle = (await psJson(`(Get-Process -Id ${firstPid} -ErrorAction SilentlyContinue).MainWindowTitle`)).trim()
    hang.childProcesses = (await psJson(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${firstPid}" | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`)).trim()
    observe('PowerShell window/process snapshot', { mainWindowTitle: hang.mainWindowTitle, childProcesses: hang.childProcesses })

    // Screenshot of the parked main window.
    try { await page.screenshot({ path: join(output, 'S12-hang-screenshot.png') }); hang.screenshot = 'S12-hang-screenshot.png' } catch (error) { hang.screenshotError = String(error.message ?? error) }

    // Any dirty/unsaved editor state in the test profile that could be blocking a close-confirm?
    try {
      const settingsPath = join(profile, 'window-state.json')
      hang.windowStateFile = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : '(none)'
    } catch { /* ignore */ }
  }
  summary.hang = hang
  observe(stillAlive ? 'CONFIRMED HANG with evidence captured' : 'process exited before 20s (not reproduced this run)')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  if (firstPid && alive(firstPid)) { try { execFileSync('taskkill.exe', ['/pid', String(firstPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
}
const result = { result: failed ? 'FAIL' : 'DIAGNOSED', ...summary, observations }
await writeFile(join(output, 'S12-hang-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exit(failed ? 1 : 0)
