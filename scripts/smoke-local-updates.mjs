import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

// Synthetic, non-executable artifacts test native updater discovery only.
// No download/install action, provider process, or inference is permitted.
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
  assert.equal(await readFile(join(feed, descriptor.installer), 'utf8'), bytes.toString())
  result.checks.push('No synthetic installer was downloaded or executed; fixture bytes unchanged')
} catch (error) {
  result.failures.push(String(error.stack ?? error))
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise(resolve => remote.close(resolve))
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
