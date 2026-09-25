import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The phone's 6-digit lock and its terminal, the way the owner meets them: the real Electron app
// serves the phone app over its real HTTPS listener and a parked, phone-sized BrowserWindow in its
// own session plays the phone. Locked -> wrong code -> right code -> open a terminal with the code
// again -> run `echo ok` -> leave it idle until it locks, and the shell and its audit line with it.
// No model inference. Run after `npm.cmd run build`, through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-lock.mjs
// Screenshots and report.json go to artifacts/phone-lock/.
const CODE = '482915'
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-lock-'))
const output = resolve('artifacts/phone-lock')
await mkdir(output, { recursive: true })
const userData = join(root, 'profile')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: userData, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

/** One HTTPS call as the phone makes it, trusting the listener's own chain. */
const call = (origin, path, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, origin)
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', rejectUnauthorized: false, headers: { host: url.host, ...headers } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } resolve({ status: response.statusCode, text, json }) })
  })
  req.once('error', reject)
  req.end()
})

const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  let value
  for (;;) {
    value = await read().catch(() => undefined)
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 600))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/* A phone-sized window in its own session, parked left of every display, never activated. */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneLockConsole ??= {}
  const log = globalThis.__phoneLockConsole[win.id] = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') log.push(text)
  })
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return { id: win.id }
}, { partition })

const phone = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  text: () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript('document.body ? document.body.innerText : ""', true), id),
  input: event => app.evaluate(({ BrowserWindow }, { id, event }) => { BrowserWindow.fromId(id).webContents.sendInputEvent(event) }, { id, event }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneLockConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

const tapCode = (tab, digits) => tab.run(`(() => {
  const keys = Array.from(document.querySelectorAll('.lock-key'))
  for (const digit of ${JSON.stringify(digits)}) keys.find(key => key.textContent === digit).click()
  return true
})()`)

const terminalText = tab => tab.run('Array.from(document.querySelectorAll(".xterm-rows > div")).map(row => row.textContent).join("\\n")')

const phoneWindows = []
let timeline = {}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  await page.evaluate(() => window.conductor.projects.create('Phone lock smoke'))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  assert.equal(desktop.lock.configured, false)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`

  // ------------------------------------------------------------------ pair, while there is no code
  const opened = await openPhone('phone-lock')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('document.querySelector(".code-input") && document.querySelector(".code-input").value.length'), value => value > 0, 'the pairing code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".live-dot.live"))'), Boolean, 'the live session list')
  const token = await tab.run('localStorage.getItem("conductor.phone.token")')
  assert.ok(token)
  check('A phone pairs and reaches the live session list while no code is set')

  // ------------------------------------------------------------------ set the code: the phone locks
  desktop = await page.evaluate(code => window.conductor.phone.setLockCode(code), CODE)
  assert.equal(desktop.lock.configured, true)
  desktop = await page.evaluate(() => window.conductor.phone.setLockIdle(1))
  assert.equal(desktop.lock.idleMinutes, 1)
  await until(() => tab.text(), text => text.includes('Conductor is locked'), 'the phone to show the lock pad')
  assert.equal(await tab.run('document.querySelector(".tabbar").hidden'), true)
  const refused = await call(origin, '/api/state', { authorization: 'Bearer ' + token })
  assert.equal(refused.status, 423)
  assert.equal(refused.json.locked, true)
  assert.equal((await call(origin, '/api/health')).status, 200)
  await tab.shot('01-locked')
  check('Setting the code on the desktop locks the open phone at once; the server answers 423 to its token, /api/health stays open')

  // ------------------------------------------------------------------ wrong code, then right code
  await tapCode(tab, '111111')
  await until(() => tab.text(), text => /That code is wrong\. 4 tries left/.test(text), 'the wrong-code message')
  desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.lock.failures, 1)
  await tab.shot('02-wrong-code')
  check('A wrong code says so with the tries left, and the desktop counts it')

  await tapCode(tab, CODE)
  await until(() => tab.run('Boolean(document.querySelector(".live-dot.live"))'), Boolean, 'the session list after unlocking')
  desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.lock.failures, 0)
  assert.equal(desktop.lock.unlockedDevices.length, 1)
  await tab.shot('03-unlocked')
  check('The right code unlocks: live list back, failures cleared, the desktop lists the phone as unlocked')

  // ------------------------------------------------------------------ terminal: code again, echo ok
  await tab.go('#/system')
  await until(() => tab.run('Boolean(document.querySelector(".terminal-open"))'), Boolean, 'the Terminal button on System')
  await tab.run('document.querySelector(".terminal-open").click(); true')
  await until(() => tab.run('Boolean(document.querySelector(".terminal-code"))'), Boolean, 'the terminal setup card')
  await tab.shot('04-terminal-setup')
  await tab.run(`document.querySelector('.terminal-code').value = ${JSON.stringify(CODE)}; Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Open terminal').click(); true`)
  await until(() => terminalText(tab), text => /\S/.test(text || ''), 'the shell prompt', 30000)
  assert.equal(await tab.run('Array.from(document.querySelectorAll(".terminal-key")).map(node => node.textContent).join(" ")'), 'Ctrl Esc Tab ← ↑ ↓ → Paste Copy')
  await tab.shot('05-terminal-open')

  await tab.run('document.querySelector(".xterm-helper-textarea").focus(); true')
  for (const char of 'echo ok') await tab.input({ type: 'char', keyCode: char })
  await tab.input({ type: 'keyDown', keyCode: 'Return' })
  await tab.input({ type: 'char', keyCode: '\r' })
  await tab.input({ type: 'keyUp', keyCode: 'Return' })
  let ran = await until(() => terminalText(tab), text => /^\s*ok\s*$/m.test(text || ''), 'echo ok to answer', 8000).catch(() => null)
  let typedBy = 'key events'
  if (!ran) {
    // A parked window that is never focused may not route key events; xterm reads an input event
    // as typing too, which is what a phone's keyboard produces.
    typedBy = 'input events'
    await tab.run(`(() => { const area = document.querySelector('.xterm-helper-textarea'); area.dispatchEvent(new InputEvent('input', { data: 'echo ok', inputType: 'insertText' })); area.dispatchEvent(new InputEvent('input', { data: '\\r', inputType: 'insertText' })); return true })()`)
    ran = await until(() => terminalText(tab), text => /^\s*ok\s*$/m.test(text || ''), 'echo ok to answer', 15000)
  }
  await tab.shot('06-echo-ok')
  check(`The terminal opens only with the code typed again, shows the mobile key row, and runs echo ok (typed by ${typedBy})`)

  // ------------------------------------------------------------------ idle: the phone locks, the shell dies
  const idleStarted = Date.now()
  await until(() => tab.text(), text => text.includes('Conductor is locked'), 'the idle lock', 120000)
  timeline.idleLockSeconds = Math.round((Date.now() - idleStarted) / 1000)
  desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.lock.unlockedDevices.length, 0)
  const audit = await until(() => readFile(join(userData, 'logs', 'phone-audit.log'), 'utf8'), text => /phone terminal: device /.test(text || ''), 'the audit line', 20000)
  const lines = audit.split('\n').filter(line => line.includes('phone terminal:'))
  assert.equal(lines.length, 1, audit)
  assert.match(lines[0], / in Phone lock smoke \/ /)
  assert.match(lines[0], /; phone locked; \d+ bytes typed$/)
  assert.ok(!lines[0].includes('echo'), 'the audit line never holds what was typed')
  await tab.shot('07-idle-locked')
  check(`Left alone, the phone locked after ${timeline.idleLockSeconds} s (1-minute setting), the shell was killed and one audit line records it without its input`)

  const phoneErrors = (await tab.consoleErrors()).filter(text => /Uncaught/.test(text))
  assert.deepEqual(phoneErrors, [], 'no uncaught error in the phone window')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, timeline, auditLine: lines[0], inference: 'none' }, null, 2))
} finally {
  for (const id of phoneWindows) await phone(id).close().catch(() => {})
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
