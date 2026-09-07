import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
const root = await mkdtemp(join(tmpdir(), 'conductor-real-update-download-'))
const profile = join(root, 'profile'), feed = join(profile, 'local-updates')
await mkdir(feed, { recursive: true })
const source = join(process.env.APPDATA, 'Conductor', 'local-updates')
const descriptor = JSON.parse(await readFile(join(source, 'conductor-local-build.json'), 'utf8'))
for (const name of [descriptor.installer, descriptor.blockmap, 'conductor-local-build.json']) {
  assert.ok(!/[\\/]/.test(name)); await copyFile(join(source, name), join(feed, name))
}
const remote = createServer((_request, response) => { response.writeHead(200); response.end('version: 0.1.3\nfiles: []\n') })
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
const remoteUrl = 'http://127.0.0.1:' + remote.address().port + '/'
await writeFile(join(root, 'app-update.yml'), 'provider: generic\nurl: ' + remoteUrl + '\nupdaterCacheDirName: download-only-qa\n')
const env = { ...process.env, CONDUCTOR_DOWNLOAD_QA_ROOT: root, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_UPDATE_DEV: '1', CONDUCTOR_UPDATE_URL: remoteUrl }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS
let app
const result = { actualElectron: true, actualNativeDownload: true, actualInstallerBytes: true, installedVersionMetadata: 'simulated 0.1.4', installation: 'forbidden by test-only boundary', version: descriptor.version, checks: [], failures: [] }
try {
  app = await electron.launch({ args: [resolve('scripts/fixtures/local-update-download-bootstrap.cjs')], env, timeout: 30000 })
  const page = await app.firstWindow()
  await expect.poll(() => page.evaluate(() => window.conductor?.updates.getState()), { timeout: 25000 }).toMatchObject({ phase: 'available', source: 'local', availableVersion: descriptor.version })
  await page.getByRole('button', { name: 'Download update', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.conductor.updates.getState()), { timeout: 45000 }).toMatchObject({ phase: 'ready', source: 'local', availableVersion: descriptor.version })
  const details = await app.evaluate(() => ({ paths: global.__downloadQA.instances.map(instance => instance.installerPath).filter(Boolean), attempts: global.__downloadQA.installAttempts }))
  assert.equal(details.attempts, 0); assert.equal(details.paths.length, 1)
  const rel = relative(root, details.paths[0]); assert.ok(!isAbsolute(rel) && !rel.startsWith('..'))
  const hash = createHash('sha512'); let size = 0
  for await (const chunk of createReadStream(details.paths[0])) { hash.update(chunk); size += chunk.length }
  assert.equal(hash.digest('base64'), descriptor.sha512); assert.equal(size, descriptor.size)
  result.checks.push('Real UI Download update reached ready through native NsisUpdater and production loopback feed', 'Isolated cached installer SHA-512 and byte size match the actual packaged executable', 'No installer was executed or installed profile/cache modified')
  await page.screenshot({ path: resolve('artifacts/local-update-ui/real-download-ready.png'), fullPage: true })
} catch (error) { result.failures.push(String(error.stack ?? error)); process.exitCode = 1 }
finally { await app?.close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); await writeFile(resolve('artifacts/local-update-ui/real-download-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)) }
