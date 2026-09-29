import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// "Browser is stuck open after I close it" (feature-list conductor-task:55f19f67). The sidebar
// browser is a main-owned native WebContentsView painted over the window, not DOM, so closing
// the sidebar must tell the main process to hide it. Covers every way the owner closes it: the
// Browser rail button pressed again, the rail's Close workspace sidebar button, and the title-bar
// close of a detached browser window. Parked (CONDUCTOR_TEST_USER_DATA), offline, no provider.
const root = await mkdtemp(join(tmpdir(), 'conductor-browser-close-'))
const output = resolve('artifacts/browser-close')
await mkdir(output, { recursive: true })
const report = { checks: [], failures: [], root }
const check = label => { report.checks.push(label); console.log('PASS ' + label) }

const site = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html><head><title>Close me</title></head><body><h1>Close me</h1></body></html>')
})
await new Promise(done => site.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${site.address().port}/`

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_BACKGROUND_WINDOWS: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [process.env.CONDUCTOR_SMOKE_MAIN || resolve('out/main/index.js')], env, timeout: 30_000 })
const mainLog = []
app.process().stdout?.on('data', chunk => mainLog.push(String(chunk)))
app.process().stderr?.on('data', chunk => mainLog.push(String(chunk)))
app.process().once('exit', (code, signal) => mainLog.push(`main process exited ${code} ${signal}`))
const page = await app.firstWindow(); page.setDefaultTimeout(20_000)
const rendererErrors = []; page.on('pageerror', error => { if (error.message !== 'Canceled') rendererErrors.push(error.stack ?? error.message) })
const rail = page.getByRole('navigation', { name: 'Activity' })
/** Where the guest is painted: which window hosts it and whether the native view is visible. */
const surface = id => app.evaluate(({ BrowserWindow }, wanted) => {
  for (const window of BrowserWindow.getAllWindows()) {
    for (const child of window.contentView.children ?? []) {
      if (child.webContents?.id === wanted) return { title: window.getTitle(), visible: child.getVisible(), bounds: child.getBounds(), hostId: window.id }
    }
  }
  return null
}, id)
/** Painted over the workspace: a visible view in the workspace window (the window itself is parked). */
const workspaceWindowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id)
const shown = async id => { const value = await surface(id); return Boolean(value?.visible && value.hostId === workspaceWindowId) }
const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => window.getTitle()))
let originalFailure, cleanupFailure

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.browser))
  const project = await page.evaluate(async url => {
    const created = await window.conductor.projects.create('Browser close project')
    localStorage.setItem(`conductor.browserSidebar.${created.id}`, url)
    return created
  }, origin)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()

  const browserButton = rail.getByRole('button', { name: 'Browser', exact: true })
  const browser = page.locator('.browser-sidebar:not([hidden])')
  await browserButton.click()
  await expect(browser).toBeVisible()
  await expect.poll(() => browser.locator('.browser-pane').getAttribute('data-browser-web-contents-id')).toMatch(/^\d+$/)
  const guestId = Number(await browser.locator('.browser-pane').getAttribute('data-browser-web-contents-id'))
  await expect.poll(() => shown(guestId)).toBe(true)
  check('Opening Browser from the rail paints the project guest')

  await browserButton.click()
  await expect(page.locator('.left-shell.rail-only')).toHaveCount(1)
  await expect.poll(() => shown(guestId), { message: 'the native browser must hide when Browser is pressed again' }).toBe(false)
  await page.setViewportSize({ width: 1300, height: 820 }).catch(() => {})
  await page.waitForTimeout(400)
  assert.equal(await shown(guestId), false, 'a later resize must not bring the closed browser back')
  check('Pressing Browser on the rail again hides the native browser and it stays hidden')

  await browserButton.click()
  await expect.poll(() => shown(guestId)).toBe(true)
  await rail.getByRole('button', { name: 'Close workspace sidebar', exact: true }).click()
  await expect.poll(() => shown(guestId), { message: 'the native browser must hide when the sidebar is closed' }).toBe(false)
  check('Close workspace sidebar hides the native browser')

  await rail.getByRole('button', { name: 'Open workspace sidebar', exact: true }).click()
  await expect.poll(() => shown(guestId)).toBe(true)
  await browser.getByRole('button', { name: 'Detach browser without taking focus', exact: true }).click()
  await expect.poll(async () => (await windows()).some(title => /Browser close project.*Browser/.test(title))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => /Browser close project.*Browser/.test(window.getTitle()))?.close())
  await expect.poll(async () => (await windows()).some(title => /Browser close project.*Browser/.test(title))).toBe(false)
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await page.waitForTimeout(1500)
  assert.equal((await windows()).some(title => /Browser close project.*Browser/.test(title)), false, 'the detached browser window must not reopen')
  check('Closing the detached browser window keeps it closed')

  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.browser))
  await page.waitForTimeout(1500)
  assert.equal((await windows()).some(title => /Browser close project.*Browser/.test(title)), false, 'a reload must not restore a closed detached browser')
  check('A renderer reload does not restore a detached browser the owner closed')

  assert.deepEqual(rendererErrors, [])
} catch (error) {
  originalFailure = error
  report.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
} finally {
  try { await cleanupFixtureApp(app, report, 'browser close fixture cleanup') }
  catch (error) { cleanupFailure = error; report.failures.push(error.stack ?? String(error)) }
  report.mainLog = mainLog.join('').slice(-8000)
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  site.close()
}
const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
