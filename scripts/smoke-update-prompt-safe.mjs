import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-safe-update-')), profile = join(root, 'profile'), feed = join(profile, 'local-updates')
await mkdir(feed, { recursive: true })
const version = '999.0.1-local.1', bytes = Buffer.from('SYNTHETIC NEVER EXECUTE'), map = Buffer.from('SYNTHETIC MAP')
const sha = value => createHash('sha512').update(value).digest('base64')
const descriptor = { schemaVersion: 1, version, createdAt: new Date().toISOString(), commit: null, dirty: true, installer: 'Conductor-Setup-' + version + '.exe', blockmap: 'Conductor-Setup-' + version + '.exe.blockmap', sha512: sha(bytes), size: bytes.length, blockmapSha512: sha(map), blockmapSize: map.length }
await writeFile(join(feed, descriptor.installer), bytes); await writeFile(join(feed, descriptor.blockmap), map)
await writeFile(join(feed, 'conductor-local-build.json'), JSON.stringify(descriptor))
const offer = () => writeFile(join(feed, 'conductor-local-offer.json'), JSON.stringify({ version, builder: 'smoke', verified: true, offered: true }))
const remote = createServer((_req, res) => res.end('version: 0.0.1\nfiles: []\n'))
await new Promise(done => remote.listen(0, '127.0.0.1', done))
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_UPDATE_DEV: '1', CONDUCTOR_UPDATE_URL: `http://127.0.0.1:${remote.address().port}/`, CONDUCTOR_SMOKE_BACKGROUND_MS: '5000' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
let app
const checks = []
try {
  app = await electron.launch({ args: [resolve('scripts/fixtures/update-prompt-safe-bootstrap.cjs')], env })
  let page = await app.firstWindow()
  await page.waitForFunction(() => !!window.conductor?.projects)
  await page.evaluate(() => window.conductor.projects.create('Safe update'))
  await app.close()
  app = await electron.launch({ args: [resolve('scripts/fixtures/update-prompt-safe-bootstrap.cjs')], env })
  page = await app.firstWindow(); page.setDefaultTimeout(20000)
  await expect.poll(() => page.evaluate(() => window.conductor?.updates.getState()), { timeout: 20000 }).toMatchObject({ source: 'local', phase: 'available', promptAllowed: false })
  await page.locator('.project-row').filter({ hasText: 'Safe update' }).click()
  if (!await page.locator('.launcher-grid').count()) await page.locator('.pane-add-tab').click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).first().click()
  const id = await page.locator('.structured-agent-pane').last().getAttribute('data-structured-session')
  await page.getByRole('combobox', { name: 'Model', exact: true }).click()
  await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
  await page.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SYNTHETIC BASH WAIT: safe update busy fixture', state.settings) }, id)
  await expect.poll(() => page.evaluate(id => window.conductor.structured.snapshot(id), id)).toMatchObject({ phase: 'completed', backgroundTasks: 1 })
  await offer()
  await expect.poll(() => page.evaluate(() => window.conductor.updates.getState())).toMatchObject({ source: 'local', promptAllowed: false, quietReason: expect.stringContaining('working') })
  await expect(page.locator('.update-prompt')).toHaveCount(0)
  await expect(page.locator('.statusbar-update')).toHaveCount(0)
  checks.push('Verified and offered local update stays quiet while a settled fake tab has live background work')
  await expect(page.locator('.update-prompt')).toHaveCount(1, { timeout: 30000 })
  checks.push('Prompt surfaces automatically once the tab and background work are idle')
  await page.evaluate(() => window.conductor.updates.download())
  await expect(page.getByRole('button', { name: 'Restart to update', exact: true }).last()).toBeEnabled()
  // Inject a real fake turn after the renderer precheck, before the production install handler.
  await app.evaluate(({ ipcMain, BrowserWindow }, id) => {
    const original = ipcMain._invokeHandlers.get('updates:install')
    ipcMain.removeHandler('updates:install')
    ipcMain.handle('updates:install', async (event, ...args) => {
      ipcMain.removeHandler('updates:install'); ipcMain.handle('updates:install', original)
      await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(async () => { const id = ${JSON.stringify(id)}; const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SYNTHETIC BASH WAIT: click race', state.settings) })()`)
      return original(event, ...args)
    })
  }, id)
  await page.getByRole('button', { name: 'Restart to update', exact: true }).last().click()
  await expect(page.getByRole('alertdialog')).toContainText('Work is still running')
  await expect(page.getByRole('button', { name: 'Install when idle', exact: true })).toBeVisible()
  assert.equal(await app.evaluate(() => global.__safeUpdate.installs), 0)
  assert.equal(existsSync(join(profile, 'installer-stub.json')), false)
  checks.push('Click-time main-process recheck refuses new work and offers Install when idle; no installer called')
  await page.getByRole('button', { name: 'Install when idle', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.conductor.updates.getState())).toMatchObject({ phase: 'ready', installWhenIdle: true })
  checks.push('Owner can queue the update without interrupting work')
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  assert.ok(bounds.x < -1000 || bounds.y < -1000, 'Smoke window must be parked')
  console.log(JSON.stringify({ checks, root }, null, 2))
} finally {
  await app?.close(); remote.closeAllConnections(); await new Promise(done => remote.close(done))
}
