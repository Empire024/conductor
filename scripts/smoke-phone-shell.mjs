import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The phone web app as a phone browser meets it: the real Electron app serves it over its real HTTPS
// listener, and a second, parked BrowserWindow in its own session plays the phone. It checks the
// boot guard, the connection check, the certificate page, the pairing landing in iPhone Safari and
// iPhone Chrome, pairing itself, and what a reload shows once the desktop stops answering. No model
// inference happens. Run after `npm.cmd run build`; screenshots and report.json go to
// artifacts/swarm-2026-09-23/phone-app/.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-shell-'))
const output = resolve('artifacts/swarm-2026-09-23/phone-app')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1'

/** One HTTPS call that trusts nothing yet, the way a phone first meets the listener. */
const call = (origin, path) => new Promise((resolve, reject) => {
  const url = new URL(path, origin)
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', rejectUnauthorized: false, headers: { host: url.host } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } resolve({ status: response.statusCode, headers: response.headers, text, json }) })
  })
  req.once('error', reject)
  req.end()
})

const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  let value
  for (;;) {
    /* A read during a navigation can fail; that is just not yet. */
    value = await read().catch(() => undefined)
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 600))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const formatCode = raw => { const letters = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, ''); return letters.length > 4 ? letters.slice(0, 4) + '-' + letters.slice(4) : letters }

/* A phone-sized window in its own session, parked left of every display like the app's own windows
   under CONDUCTOR_TEST_USER_DATA: shown without activation so it paints and reports itself visible,
   never over the owner's screen, never in the taskbar. The session trusts only the listener's
   loopback certificate, which also makes it a secure context where the service worker can run. */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneShellConsole ??= {}
  const log = globalThis.__phoneShellConsole[win.id] = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') log.push(text)
  })
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return { id: win.id, userAgent: win.webContents.getUserAgent() }
}, { partition })

const phone = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  /* A hash change is a same-document navigation, which loadURL is not the tool for. */
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  reload: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).webContents.reload() }, id),
  text: () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript('document.body ? document.body.innerText : ""', true), id),
  userAgent: ua => app.evaluate(({ BrowserWindow }, { id, ua }) => BrowserWindow.fromId(id).webContents.setUserAgent(ua), { id, ua }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneShellConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

const phoneWindows = []
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const port = new URL(desktop.primaryEndpoint).port
  const origin = `https://127.0.0.1:${port}`

  // ------------------------------------------------------------------ HTTP level
  const index = await call(origin, '/')
  assert.equal(index.status, 200)
  const bootAt = index.text.indexOf('<script src="/boot.js"></script>')
  assert.ok(bootAt > 0 && index.text.indexOf('<script src="/app.js" defer></script>') > bootAt, 'boot.js loads, blocking, before the deferred app.js')
  const boot = await call(origin, '/boot.js')
  assert.equal(boot.status, 200)
  assert.match(boot.headers['content-type'], /^text\/javascript/)
  assert.ok(boot.text.includes('ConductorBoot'), 'the real boot guard is served, not the placeholder')
  const worker = await call(origin, '/sw.js')
  assert.ok(worker.text.includes("'conductor-phone-v2'") && worker.text.includes("'/boot.js'"))
  const health = await call(origin, '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  check('The listener serves the boot guard before app.js, the v2 worker precaching it, and an unauthenticated /api/health')

  // ------------------------------------------------------------------ the phone, unpaired
  const opened = await openPhone('phone-shell')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  await tab.load(origin + '/')
  await until(() => tab.run('window.__conductorBooted === true'), Boolean, 'the app to boot')
  assert.match(await tab.text(), /pairing code/i)
  assert.equal(await tab.run('document.querySelector("[data-boot]") === null'), true, 'the boot placeholder is gone')
  await tab.shot('smoke-pair')
  check('The served app boots in a phone-sized window, sets __conductorBooted and clears the boot placeholder')

  await tab.go('#diagnose')
  const diagnose = await until(() => tab.text(), text => text.includes('Reached Conductor'), 'the connection check')
  assert.ok(diagnose.includes('Reached Conductor ' + health.json.version), diagnose)
  assert.match(diagnose, /not paired yet/)
  await tab.shot('smoke-diagnose')
  check('#diagnose reports what /api/health answered, with no token')

  await tab.go('#trust')
  await until(() => tab.text(), text => text.includes('Trust this computer'), 'the certificate page')
  assert.equal(await tab.run('Boolean(document.querySelector(\'a[href="/ca.crt"]\'))'), true)
  await tab.shot('smoke-trust')
  check('#trust renders and links /ca.crt')

  // ------------------------------------------------------------------ the pairing landing
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  const code = formatCode(desktop.pairing.code)

  await tab.userAgent(IPHONE_CHROME)
  await tab.load('about:blank')
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('window.__conductorBooted === true'), Boolean, 'the app to boot in iPhone Chrome')
  assert.equal(await tab.run('location.hash'), '#/', 'the secret fragment is dropped at once')
  assert.equal(await tab.run('document.querySelector(".pair-code").textContent'), code)
  const handoff = await tab.run('Array.from(document.querySelectorAll("a")).find(a => a.textContent === "Open in Safari").getAttribute("href")')
  assert.equal(handoff, `x-safari-https://127.0.0.1:${port}/#pair=${encodeURIComponent(code)}`)
  assert.match(await tab.text(), /Already have Conductor on your Home Screen/)
  await tab.shot('smoke-pair-ios-chrome')
  check('iPhone Chrome: the landing hands off to Safari with #pair= kept and shows the code large')

  await tab.userAgent(IPHONE_SAFARI)
  await tab.load('about:blank')
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('window.__conductorBooted === true'), Boolean, 'the app to boot in iPhone Safari')
  assert.match(await tab.text(), /Add to Home Screen, then Add/)
  assert.equal(await tab.run('document.querySelector(".code-input").value'), code)
  await tab.shot('smoke-pair-ios-safari')
  await tab.go('#trust')
  await until(() => tab.text(), text => text.includes('Certificate Trust Settings'), 'the iPhone Safari certificate steps')
  await tab.shot('smoke-trust-ios-safari')
  check('iPhone Safari: the landing explains the Home Screen storage and keeps the form; #trust lists the profile steps')

  // ------------------------------------------------------------------ pairing for real
  await tab.userAgent(opened.userAgent)
  await tab.load('about:blank')
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('document.querySelector(".code-input") && document.querySelector(".code-input").value'), value => value === code, 'the code filled in')
  await tab.shot('smoke-pair-filled')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".live-dot.live"))'), Boolean, 'the live session list')
  desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.devices.length, 1)
  await tab.shot('smoke-sessions')
  check('#pair=CODE fills the code and pairing from the phone window reaches the live session list')

  await tab.go('#/phone')
  await until(() => tab.text(), text => text.includes('Connection check'), 'the Phone screen')
  await tab.shot('smoke-phone')
  await tab.go('#diagnose')
  const paired = await until(() => tab.text(), text => text.includes('Paired as'), 'the paired connection check')
  assert.match(paired, /Live connection\s+Open/)
  await tab.shot('smoke-diagnose-paired')
  check('The Phone screen links the connection check, which reports the pairing and the open stream')
  const controlled = await until(() => tab.run('navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))'), Boolean, 'the service worker to control the page', 15000).catch(() => false)

  // ------------------------------------------------------------------ app.js cannot load
  const brokenOpened = await openPhone('phone-shell-broken')
  phoneWindows.push(brokenOpened.id)
  await app.evaluate(({ session }) => {
    session.fromPartition('phone-shell-broken').webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).pathname === '/app.js' }))
  })
  const broken = phone(brokenOpened.id)
  await broken.load(origin + '/')
  const card = await until(() => broken.text(), text => text.includes('did not start'), 'the boot card', 10000)
  assert.match(card, /could not be loaded/)
  await broken.shot('smoke-boot-card')
  await broken.close()
  check('With app.js blocked, the boot guard shows "did not start" with the address and the facts instead of a blank page')

  // ------------------------------------------------------------------ the computer stops answering
  desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: false }))
  assert.equal(desktop.listening, false)
  /* A paired list says so after 20 seconds of the owner looking at it. A parked window that
     Windows counts as occluded reports itself hidden and never "looks", so there the token goes and
     the reload lands on the pairing screen, whose own health check says the same thing at once. */
  const visibility = await tab.run('document.visibilityState')
  if (visibility !== 'visible') await tab.run('localStorage.removeItem("conductor.phone.token"); true')
  await tab.go('#/')
  await tab.reload()
  const offline = await until(() => tab.text(), text => /not answering|did not start/.test(text), 'the phone to say the computer is not answering', 45000)
  assert.ok(offline.trim().length > 0)
  await tab.shot('smoke-offline')
  check('After the desktop stops listening, a reload of the phone shows "' + (offline.includes('did not start') ? 'did not start' : 'not answering') + '", not a blank page (' + (visibility === 'visible' ? 'paired session list' : 'pairing screen, window reported ' + visibility) + '; service worker in control: ' + controlled + ')')

  const phoneErrors = (await tab.consoleErrors()).filter(text => /Uncaught/.test(text))
  assert.deepEqual(phoneErrors, [], 'no uncaught error in the phone window')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'smoke-report.json'), JSON.stringify({ checks, errors, phoneConsoleErrors: await tab.consoleErrors(), serviceWorkerControlled: controlled, offlinePath: visibility === 'visible' ? 'session list banner' : 'pairing screen note', inference: 'none' }, null, 2))
} finally {
  for (const id of phoneWindows) await phone(id).close().catch(() => {})
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
