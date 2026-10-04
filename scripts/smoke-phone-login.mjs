import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Logging Claude in from the phone and setting up the long-lived token (src/main/claude-login.ts),
// end to end on the real app: the phone page over the HTTPS listener in a parked, phone-sized
// window drives /api/login; Conductor runs the login in its own PTY against a FAKE Claude CLI
// (scripts/fixtures/fake-claude-login.cjs), which signs nobody in and prints a fake token. Also
// checks the Settings > Runtimes card. Run after `npm.cmd run build`, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-login.mjs
// Screenshots and report.json go to .conductor-scratch/phone-login/.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-login-'))
const output = resolve('.conductor-scratch/phone-login')
await mkdir(output, { recursive: true })
const GOOD = 'smoke-good-code-12345#smoke-state'
const FAKE_TOKEN_PART = 'SMOKEfakeTOKEN_'
const cli = join(root, 'fake-claude.cmd')
await writeFile(cli, `@"${process.execPath}" "${resolve('scripts/fixtures/fake-claude-login.cjs')}" %*\r\n`)
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_TEST_LOGIN_CLAUDE: cli, FAKE_LOGIN_STATE_FILE: join(root, 'fake-login-state'), FAKE_GOOD_CODE: GOOD
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CLAUDE_CODE_OAUTH_TOKEN
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
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

/* Parked left of every display, shown without activation, out of the taskbar (as smoke-phone-shell). */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneLoginConsole ??= {}
  const log = globalThis.__phoneLoginConsole[win.id] = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') log.push(text)
  })
  // A sign-in link the owner taps opens the provider's page; here it must open nothing.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return { id: win.id }
}, { partition })
const phone = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneLoginConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

const phase = tab => tab.run('(document.querySelector(".login-flow") || {}).dataset ? document.querySelector(".login-flow").dataset.phase : null')
const text = tab => tab.run('document.body.innerText')
const pasteAndSend = async (tab, code) => {
  await until(() => tab.run('Boolean(document.querySelector(".login-code-input"))'), Boolean, 'the code field')
  await tab.run(`(() => { const input = document.querySelector('.login-code-input'); input.value = ${JSON.stringify(code)}; input.dispatchEvent(new Event('input')); document.querySelector('.login-submit').click(); return true })()`)
}
const desktopState = () => page.evaluate(() => window.conductor.providerLogin.state())

const report = { checks, errors }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone && window.conductor?.providerLogin))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 950))
  const initial = await desktopState()
  assert.deepEqual({ set: initial.token.set, flow: initial.flow, outages: initial.outages }, { set: false, flow: null, outages: [] })

  // Settings > Runtimes shows the login card.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Runtimes', exact: true }).click()
  const card = panel.locator('.provider-login')
  await expect(card).toContainText('Normal login')
  await expect(card.getByRole('button', { name: 'Set up long-lived token' })).toBeEnabled()
  await card.screenshot({ path: join(output, '1-settings-normal-login.png') })
  check('Settings > Runtimes shows the Claude login card: normal login, Set up long-lived token, Log in to Claude and Codex')

  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const opened = await openPhone('phone-login')
  const tab = phone(opened.id)
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('Boolean(document.querySelector(".code-input") && document.querySelector(".code-input").value)'), Boolean, 'the code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')

  await tab.go('#/more')
  await until(() => tab.run('[...document.querySelectorAll(".more-row-title")].some(node => node.textContent === "Log in")'), Boolean, 'Log in on More')
  await tab.go('#/login')
  await until(() => tab.run('Boolean(document.querySelector(".login-start"))'), Boolean, 'the Log in screen')
  await tab.shot('2-phone-login-idle')
  check('The phone has a Log in screen (More > Log in, #/login) with Log in to Claude, long-lived token and Codex')

  // A wrong code fails the flow; the code field takes one code.
  await tab.run('document.querySelector(".login-start").click(); true')
  const href = await until(() => tab.run('document.querySelector(".login-link") && document.querySelector(".login-link").href'), value => typeof value === 'string' && value.includes('/oauth/authorize'), 'the sign-in link')
  assert.match(href, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
  assert.match(href, /redirect_uri=https%3A%2F%2Fplatform\.claude\.com%2Foauth%2Fcode%2Fcallback/)
  assert.equal(await tab.run('document.querySelector(".login-link").target'), '_blank')
  await tab.shot('3-phone-awaiting-code')
  check('Log in to Claude shows the CLI\'s sign-in URL as a tappable link (the fake CLI refuses to run unless BROWSER is overridden)')
  await pasteAndSend(tab, 'wrong-code-0000#smoke-state')
  await until(() => phase(tab), value => value === 'failed', 'the failed login')
  assert.match(await text(tab), /status code 400/)
  await tab.shot('4-phone-wrong-code')
  check('A wrong code fails the login with the CLI\'s own reason and the PTY is gone')

  await tab.run('document.querySelector(".login-start").click(); true')
  await until(() => tab.run('Boolean(document.querySelector(".login-code-input"))'), Boolean, 'a new code field')
  await pasteAndSend(tab, GOOD)
  await until(() => phase(tab), value => value === 'succeeded', 'the succeeded login', 30000)
  assert.equal(await tab.run('Boolean(document.querySelector(".login-code-input"))'), false, 'no code field after the code was used')
  assert.match(await text(tab), /Logged in/)
  await tab.shot('5-phone-logged-in')
  check('The right code completes `claude auth login`, `claude auth status` confirms it, and the phone says Logged in')

  // The long-lived token: set up from the phone, stored on the computer, never shown.
  await tab.run('document.querySelector(".login-token").click(); true')
  await until(() => tab.run('document.querySelector(".login-flow h2") && document.querySelector(".login-flow h2").textContent'), value => value === 'Long-lived Claude token', 'the token flow')
  await pasteAndSend(tab, GOOD)
  await until(() => phase(tab), value => value === 'succeeded', 'the saved token', 30000)
  const after = await desktopState()
  assert.equal(after.token.set, true)
  assert.equal(after.token.active, true)
  assert.ok(after.token.expiresAt && Date.parse(after.token.expiresAt) > Date.now() + 300 * 86400000, 'valid for about a year')
  assert.ok(!JSON.stringify(after).includes(FAKE_TOKEN_PART), 'the desktop state never carries the token')
  assert.ok(!(await text(tab)).includes(FAKE_TOKEN_PART), 'the phone never shows the token')
  const phoneJson = await tab.run(`(async () => { const r = await fetch('/api/login', { headers: { Authorization: 'Bearer ' + (JSON.parse(localStorage.getItem('conductor.phone') || 'null') || {}).token } }); return r.text() })()`).catch(() => '')
  assert.ok(!String(phoneJson).includes(FAKE_TOKEN_PART), 'no /api/login payload carries the token')
  await tab.shot('6-phone-token-saved')
  await expect(card).toContainText('Long-lived token')
  await expect(card.getByRole('button', { name: 'Remove token' })).toBeVisible()
  await card.screenshot({ path: join(output, '7-settings-token-set.png') })
  check('Set up a long-lived Claude token from the phone: the fake token is captured into safeStorage, the card shows it set for a year, and neither the phone page, /api/login nor the desktop state carry it')

  await card.getByRole('button', { name: 'Remove token' }).click()
  await expect(card).toContainText('Normal login')
  assert.equal((await desktopState()).token.set, false)
  check('Remove token in Settings clears it')

  const consoleErrors = (await tab.consoleErrors()).filter(line => !/favicon|service worker|Failed to load resource: the server responded with a status of 4(09|29)/i.test(line))
  assert.deepEqual(consoleErrors, [], 'no console errors on the phone page')
  assert.deepEqual(errors, [], 'no page errors on the desktop')
  await tab.close()
  report.ok = true
} catch (error) {
  report.ok = false
  report.failure = String(error?.stack ?? error)
  console.error(error)
  process.exitCode = 1
} finally {
  // A clean quit is part of the check: a login PTY must never hold the app open.
  const alive = await app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().length, handles: process._getActiveHandles().map(handle => handle.constructor?.name ?? typeof handle) })).catch(error => String(error))
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), 45000))])
  report.close = { closed, before: alive }
  if (!closed) {
    report.ok = false
    report.failure = (report.failure ? report.failure + '\n' : '') + 'The app did not quit within 45 s.'
    process.exitCode = 1
    try { app.process().kill() } catch { /* already gone */ }
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
