import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

// Synthetic, non-executable artifacts test native updater discovery only.
// Download/install IPC is replaced by explicitly controlled promises below;
// no real artifact download/install, provider process, or inference is permitted.
const root = await mkdtemp(join(tmpdir(), 'conductor-update-ui-'))
const profile = join(root, 'profile')
const feed = join(profile, 'local-updates')
const output = resolve('artifacts/local-update-ui')
await mkdir(feed, { recursive: true }); await mkdir(output, { recursive: true })
const version = '999.0.1-local.1'
const bytes = Buffer.from('SYNTHETIC UPDATE TEST — NEVER EXECUTE')
const map = Buffer.from('SYNTHETIC BLOCKMAP')
const sha = value => createHash('sha512').update(value).digest('base64')
const descriptor = { schemaVersion: 1, version, createdAt: '2026-09-07T12:00:00Z', commit: null, dirty: true, installer: 'Conductor-Setup-' + version + '.exe', blockmap: 'Conductor-Setup-' + version + '.exe.blockmap', sha512: sha(bytes), size: bytes.length, blockmapSha512: sha(map), blockmapSize: map.length }
await writeFile(join(feed, descriptor.installer), bytes); await writeFile(join(feed, descriptor.blockmap), map)
await writeFile(join(feed, 'conductor-local-build.json'), JSON.stringify(descriptor))
const remote = createServer((request, response) => {
  const body = 'version: 0.0.1\nfiles:\n  - url: missing.exe\n    sha512: ' + sha(bytes) + '\n    size: 1\n'
  response.writeHead(200, { 'Content-Type': 'text/yaml' }); response.end(body)
})
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_UPDATE_DEV: '1', CONDUCTOR_UPDATE_URL: 'http://127.0.0.1:' + remote.address().port + '/' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS
let app
const result = { synthetic: true, actualElectron: true, checks: [], failures: [], screenshots: [] }
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  let page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.conductor))
  // Automatic startup check; do not click Check now first.
  await expect.poll(() => page.evaluate(() => window.conductor.updates.getState()), { timeout: 20_000 }).toMatchObject({ phase: 'available', source: 'local', availableVersion: version })
  await expect(page.locator('.statusbar-update')).toHaveText('Update pending')
  await expect(page.getByRole('dialog')).toContainText('Local test build')
  await page.screenshot({ path: join(output, 'local-update-pending.png'), fullPage: true })
  result.screenshots.push('artifacts/local-update-ui/local-update-pending.png')
  result.checks.push('Native NsisUpdater discovers the verified local generic feed automatically and the real UI shows Update pending / Local test build')
  await page.getByRole('button', { name: 'Not now', exact: true }).first().click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const option = page.getByRole('checkbox', { name: /Include local test builds/ })
  await expect(option).toBeChecked()
  await option.locator('..').click()
  await expect(option).not.toBeChecked()
  await expect.poll(() => page.evaluate(() => window.conductor.updates.getState())).toMatchObject({ phase: 'idle' })
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: /Include local test builds/ })).not.toBeChecked()
  await page.getByRole('checkbox', { name: /Include local test builds/ }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('checkbox', { name: /Include local test builds/ })).toBeChecked()
  await expect.poll(() => page.evaluate(() => window.conductor.updates.getState())).toMatchObject({ phase: 'available', source: 'local' })
  result.checks.push('Opt-out persists across renderer reload; enabling the local feed discovers the build without replacing the release feed')
  // Exercise the real hook and rendered controls through delayed IPC, never an installer.
  await app.evaluate(({ ipcMain }) => {
    const control = { downloads: 0, installs: 0 }
    globalThis.conductorSyntheticUpdateControl = control
    ipcMain.removeHandler('updates:download')
    ipcMain.removeHandler('updates:install')
    ipcMain.handle('updates:download', () => {
      control.downloads++
      return new Promise((resolveRequest, rejectRequest) => { control.resolveDownload = resolveRequest; control.rejectDownload = rejectRequest })
    })
    ipcMain.handle('updates:install', () => {
      control.installs++
      return new Promise((resolveRequest, rejectRequest) => { control.resolveInstall = resolveRequest; control.rejectInstall = rejectRequest })
    })
  })
  const prompt = page.locator('.update-prompt')
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: 'Download update', exact: true }).evaluate(element => { element.click(); element.click() })
  await expect(prompt.getByRole('button', { name: 'Preparing download…', exact: true })).toBeDisabled()
  await expect(page.locator('.statusbar-update')).toHaveText('Preparing download…')
  await expect.poll(() => app.evaluate(() => globalThis.conductorSyntheticUpdateControl.downloads)).toBe(1)
  await expect(prompt).not.toContainText('0%')
  await page.screenshot({ path: join(output, 'local-update-preparing.png'), fullPage: true })
  result.screenshots.push('artifacts/local-update-ui/local-update-preparing.png')
  result.checks.push('Download click shows immediate disabled preparing feedback before its IPC reply; rapid repeated click submits once and does not fabricate 0%')
  const available = { phase: 'available', currentVersion: '0.1.4', availableVersion: version, configured: true, source: 'local' }
  await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('updates:state', state), { ...available, phase: 'downloading', progress: 37.4 })
  await expect(prompt.getByRole('progressbar', { name: 'Update download progress' })).toHaveAttribute('value', '37')
  await expect(page.locator('.statusbar-update')).toHaveText('Downloading 37%')
  await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('updates:state', state), { ...available, phase: 'ready', progress: 100 })
  await expect(prompt.getByRole('button', { name: 'Restart to update', exact: true })).toBeEnabled()
  await expect(page.locator('.statusbar-update')).toHaveText('Restart to update')
  result.checks.push('Authoritative progress reaches the actual controls and ready is actionable before the original download IPC has replied')
  await prompt.getByRole('button', { name: 'Restart to update', exact: true }).evaluate(element => { element.click(); element.click() })
  await expect(prompt.getByRole('button', { name: 'Preparing restart…', exact: true })).toBeDisabled()
  await expect(page.locator('.statusbar-update')).toHaveText('Preparing restart…')
  await expect.poll(() => app.evaluate(() => globalThis.conductorSyntheticUpdateControl.installs)).toBe(1)
  // The old download resolves after a newer install request has already begun.
  await app.evaluate((_electron, state) => globalThis.conductorSyntheticUpdateControl.resolveDownload(state), available)
  await expect(prompt.getByRole('button', { name: 'Preparing restart…', exact: true })).toBeDisabled()
  await expect(page.locator('.statusbar-update')).toHaveText('Preparing restart…')
  result.checks.push('A stale download reply cannot overwrite or unlock a newer restart-preparation request')
  await app.evaluate(() => globalThis.conductorSyntheticUpdateControl.rejectInstall(new Error('SYNTHETIC restart preparation failed; no installer was called')))
  await expect(prompt.getByRole('alert')).toContainText('SYNTHETIC restart preparation failed')
  await expect(prompt.getByRole('button', { name: 'Retry update', exact: true })).toBeEnabled()
  result.checks.push('Restart preparation shows immediate busy feedback, suppresses duplicate submission, and exposes a rejected IPC request without claiming installation succeeded')
  await prompt.getByRole('button', { name: 'Retry update', exact: true }).click()
  await expect(prompt.getByRole('button', { name: 'Preparing download…', exact: true })).toBeDisabled()
  await expect.poll(() => app.evaluate(() => globalThis.conductorSyntheticUpdateControl.downloads)).toBe(2)
  await app.evaluate(() => globalThis.conductorSyntheticUpdateControl.rejectDownload(new Error('SYNTHETIC download transport failed')))
  await expect(prompt.getByRole('alert')).toContainText('SYNTHETIC download transport failed')
  await expect(prompt.getByRole('button', { name: 'Retry update', exact: true })).toBeEnabled()
  await expect(page.locator('.statusbar-update')).toBeEnabled()
  result.checks.push('A rejected download IPC restores an enabled explicit retry and accessible failure details; no automatic retry is submitted')
  assert.equal(await readFile(join(feed, descriptor.installer), 'utf8'), bytes.toString())
  result.checks.push('Controlled IPC was synthetic; no installer was downloaded or executed, no provider ran, and fixture bytes remained unchanged')
} catch (error) {
  result.failures.push(String(error.stack ?? error))
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise(resolve => remote.close(resolve))
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
