import { _electron as electron, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// FX18 `always-on-machines`, the Windows half and Conductor's own part, in the real app:
//  1. Settings > Machines shows "Always on" with "Start Conductor when I log in" (off by default),
//     turning it on reaches the login item, and machines.list's local machine reports readiness
//     with the missing steps in words. A test profile never writes the OS login items: the smoke
//     checks the real OS entry for this electron.exe stays untouched.
//  2. The failsafe: a phone paired and unlocked before the restart is locked again after an
//     unattended start (a relaunch with --conductor-login-start), and gets in only with the code.
// No model inference. Run after `npm run build`, through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-always-on.mjs
// Screenshots and report.json go to artifacts/always-on/.
const CODE = '731406'
const LOGIN_ARG = '--conductor-login-start'
const root = await mkdtemp(join(tmpdir(), 'conductor-always-on-'))
const output = resolve('artifacts/always-on')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const errors = [], checks = [], report = {}
const check = label => { checks.push(label); console.log('PASS ' + label) }
let app, page

const launch = async (extra = []) => {
  app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js'), ...extra], env, timeout: 30000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
  await page.waitForFunction(() => Boolean(window.conductor?.settings?.alwaysOn))
}
const close = async () => {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) }).catch(() => {})
  await app.close()
}
const owner = async () => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
  return JSON.parse(await readFile(path, 'utf8'))
}
const control = async (method, args, scope) => {
  const credential = await owner()
  const response = await fetch(credential.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, scope }) })
  const body = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(body))
  return body.result
}
/** One HTTPS call as a phone makes it. */
const phoneCall = (origin, path, { method = 'GET', headers = {}, body } = {}) => new Promise((done, fail) => {
  const url = new URL(path, origin)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname, method, rejectUnauthorized: false, headers: { host: url.host, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } done({ status: response.statusCode, json }) })
  })
  req.once('error', fail)
  req.end(payload)
})
const localMachine = machines => machines.find(machine => machine.kind === 'local')
const conductorCheck = readiness => readiness.checks.find(entry => entry.id === 'conductor')

try {
  // ------------------------------------------------------------------ launch 1: the setting
  await launch()
  const project = await page.evaluate(() => window.conductor.projects.create('Always-on smoke'))
  const osBefore = await app.evaluate(({ app }, arg) => app.getLoginItemSettings({ path: process.execPath, args: [arg] }).openAtLogin, LOGIN_ARG)

  let state = await page.evaluate(() => window.conductor.settings.alwaysOn(true))
  assert.deepEqual(state.loginItem, { enabled: false, backend: 'simulated', startedAtLogin: false })
  let machines = await control('machines.list', {}, { projectId: project.id })
  let local = localMachine(machines)
  assert.ok(local?.readiness, 'machines.list has local readiness: ' + JSON.stringify(local))
  assert.equal(conductorCheck(local.readiness).ok, false)
  assert.ok(local.readiness.missing.some(line => line.includes('Start Conductor when I log in')), JSON.stringify(local.readiness.missing))
  if (process.platform === 'win32') {
    assert.deepEqual(local.readiness.checks.map(entry => entry.id), ['sleep', 'boot-unlock', 'tailscale', 'conductor', 'failsafe'])
    assert.ok(local.readiness.notes.some(note => /BIOS/.test(note)))
  }
  report.readinessBefore = local.readiness
  check('Start at login is off by default, and machines.list reports this PC\'s readiness with "Start Conductor when I log in" missing')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Machines', exact: true }).click()
  const section = panel.getByTestId('always-on-settings')
  await expect(section.getByText('Always on', { exact: true })).toBeVisible()
  const toggle = section.getByRole('checkbox', { name: 'Start Conductor when I log in' })
  await expect(toggle).not.toBeChecked()
  await expect(section.locator('li[data-check]')).toHaveCount(local.readiness.checks.length)
  await page.screenshot({ path: join(output, 'machines-before.png') })
  await section.locator('label.theme-auto-setting').click()
  await expect(toggle).toBeChecked()
  await expect(section.locator('li[data-check="conductor"]')).toHaveAttribute('data-state', 'ok')
  await page.waitForTimeout(400) // the switch's 140 ms slide
  await page.screenshot({ path: join(output, 'machines-after.png') })
  state = await page.evaluate(() => window.conductor.settings.alwaysOn())
  assert.equal(state.loginItem.enabled, true)
  machines = await control('machines.list', {}, { projectId: project.id })
  local = localMachine(machines)
  assert.equal(conductorCheck(local.readiness).ok, true)
  assert.ok(!local.readiness.missing.some(line => line.includes('Conductor opens at login')))
  report.readinessAfter = local.readiness
  const osAfter = await app.evaluate(({ app }, arg) => app.getLoginItemSettings({ path: process.execPath, args: [arg] }).openAtLogin, LOGIN_ARG)
  assert.equal(osAfter, osBefore, 'a test profile must not change the OS login items')
  check('Turning on "Start Conductor when I log in" in Settings > Machines flips the readiness check in the panel and in machines.list, without touching the OS login items')

  // ------------------------------------------------------------------ the failsafe before the restart
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'phone listener starts: ' + desktop.message)
  let origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  const paired = await phoneCall(origin, '/api/pair', { method: 'POST', body: { code: desktop.pairing.code, name: 'Smoke phone' } })
  assert.equal(paired.status, 200, JSON.stringify(paired.json))
  const token = paired.json.token
  const auth = { authorization: 'Bearer ' + token }
  await page.evaluate(code => window.conductor.phone.setLockCode(code), CODE)
  assert.equal((await phoneCall(origin, '/api/state', { headers: auth })).status, 423)
  const unlocked = await phoneCall(origin, '/api/lock/unlock', { method: 'POST', headers: auth, body: { code: CODE } })
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.json))
  assert.equal((await phoneCall(origin, '/api/state', { headers: { ...auth, 'x-conductor-unlock': unlocked.json.unlockToken } })).status, 200)
  machines = await control('machines.list', {}, { projectId: project.id })
  assert.equal(localMachine(machines).readiness.checks.find(entry => entry.id === 'failsafe').ok, true)
  check('Before the restart a paired phone gets in only after the 6-digit code, and readiness counts the code as the failsafe')
  await close()

  // ------------------------------------------------------------------ launch 2: an unattended start
  await launch([LOGIN_ARG])
  state = await page.evaluate(() => window.conductor.settings.alwaysOn())
  assert.equal(state.loginItem.startedAtLogin, true)
  assert.equal(state.loginItem.enabled, true)
  const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null)
  assert.equal(focused, true, 'a login start takes no focus')
  desktop = await page.evaluate(() => window.conductor.phone.state())
  await expect.poll(async () => (desktop = await page.evaluate(() => window.conductor.phone.state())).listening, { timeout: 20_000 }).toBe(true)
  origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const oldUnlock = await phoneCall(origin, '/api/state', { headers: { ...auth, 'x-conductor-unlock': unlocked.json.unlockToken } })
  assert.equal(oldUnlock.status, 423, 'the old unlock must not survive the restart: ' + JSON.stringify(oldUnlock.json))
  const lockState = await phoneCall(origin, '/api/lock/state', { headers: auth })
  assert.equal(lockState.status, 200)
  assert.equal(lockState.json.configured, true)
  assert.equal(lockState.json.unlocked, false)
  const wrong = await phoneCall(origin, '/api/lock/unlock', { method: 'POST', headers: auth, body: { code: '000000' } })
  assert.notEqual(wrong.status, 200)
  const again = await phoneCall(origin, '/api/lock/unlock', { method: 'POST', headers: auth, body: { code: CODE } })
  // A wrong attempt makes the next one wait a few seconds.
  const reopened = again.status === 200 ? again : await (async () => { await new Promise(done => setTimeout(done, 5500)); return phoneCall(origin, '/api/lock/unlock', { method: 'POST', headers: auth, body: { code: CODE } }) })()
  assert.equal(reopened.status, 200, JSON.stringify(reopened.json))
  assert.equal((await phoneCall(origin, '/api/state', { headers: { ...auth, 'x-conductor-unlock': reopened.json.unlockToken } })).status, 200)
  report.afterLoginStart = { startedAtLogin: true, focusedWindow: false, oldUnlockStatus: oldUnlock.status, lockState: lockState.json, wrongCodeStatus: wrong.status }
  check('After an unattended start (--conductor-login-start) the window takes no focus, the paired phone is locked again, a wrong code is refused, and only the code lets it back in')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', platform: process.platform, ...report }, null, 2))
  console.log('\nsmoke-always-on: ' + checks.length + ' checks passed')
} finally {
  await close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
