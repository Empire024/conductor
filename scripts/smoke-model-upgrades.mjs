import { _electron as electron, expect } from '@playwright/test'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Auto model upgrade (docs/model-upgrades.md) in the real app, parked, with no network and no
// global install: a fake npm registry says Codex 0.155.9 and Claude Code 3.0.0 exist, a fake npm
// lays out fake CLIs (scripts/fixtures/fake-npm.mjs, fake-upgrade-cli.mjs) whose catalogs add
// GPT-6.1-Sol (the new Codex default) and Claude Opus 5.6.
//  1. models.upgrades.check: Codex 0.155.9 speaks this Conductor's protocol, so GPT-6.1-Sol is
//     offered ready; Claude Code 3.0.0 needs a protocol bump and, with no Conductor checkout open
//     in the test profile, is blocked with the reason (nothing half done).
//  2. The owner's card shows "GPT-6.1-Sol is available (better than GPT-6-Astra: …)"; OK pins the
//     scratch CLI as a Conductor-owned copy and promotes the model; the card goes away.
//  3. A decline is remembered across a re-check. npm only ever ran with --prefix in the profile.
// Run after `npm run build`, through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-model-upgrades.mjs
const root = await mkdtemp(join(tmpdir(), 'conductor-model-upgrades-'))
const output = resolve('artifacts/model-upgrades')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), bin = join(root, 'bin')
await mkdir(bin, { recursive: true })
const windows = process.platform === 'win32'
const fakeCli = resolve('scripts/fixtures/fake-upgrade-cli.mjs'), fakeNpm = resolve('scripts/fixtures/fake-npm.mjs')
const catalogs = join(root, 'catalogs.json'), npmLog = join(root, 'npm.log')
const OLD_CODEX = [{ id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true }, { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna' }]
const OLD_CLAUDE = [{ id: 'default', displayName: 'Default (recommended)' }, { id: 'opus[1m]', displayName: 'Claude Opus 5.5 (1M context)', isDefault: true }, { id: 'sonnet', displayName: 'Claude Sonnet 5' }]
await writeFile(catalogs, JSON.stringify({
  codex: { '0.155.1': OLD_CODEX, '0.155.9': [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true }, { ...OLD_CODEX[0], isDefault: false }, OLD_CODEX[1]] },
  claude: { '2.1.282': OLD_CLAUDE, '3.0.0': [...OLD_CLAUDE, { id: 'claude-opus-5-6', displayName: 'Claude Opus 5.6' }] }
}))
/** The "installed" CLIs this profile sees, launchers for the fake CLI at a fixed version. */
const launcher = async (provider, version) => {
  const path = join(bin, windows ? `${provider}.cmd` : provider)
  await writeFile(path, windows
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${fakeCli}" --fake-provider ${provider} --fake-version ${version} %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${fakeCli}" --fake-provider ${provider} --fake-version ${version} "$@"\n`)
  if (!windows) chmodSync(path, 0o755)
  return path
}
const latest = { '@openai/codex': '0.155.9', '@anthropic-ai/claude-code': '3.0.0' }
const registryHits = []
const registry = createServer((request, response) => {
  registryHits.push(request.url)
  const name = decodeURIComponent((request.url ?? '').replace(/^\//, '').replace(/\/latest$/, ''))
  if (latest[name]) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ name, version: latest[name] })); return }
  response.writeHead(404); response.end('{}')
})
await new Promise(done => registry.listen(0, '127.0.0.1', done))
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_NPM_REGISTRY: `http://127.0.0.1:${registry.address().port}`, CONDUCTOR_MODEL_UPGRADE_NPM: fakeNpm, CONDUCTOR_FAKE_NPM_LOG: npmLog, CONDUCTOR_FAKE_CLI_CATALOGS: catalogs,
  CONDUCTOR_MODEL_UPGRADE_FIXER: 'off', CONDUCTOR_CODEX_PATH: await launcher('codex', '0.155.1'), CONDUCTOR_CLAUDE_PATH: await launcher('claude', '2.1.282'),
  CODEX_HOME: join(root, 'codex-home'), CLAUDE_CONFIG_DIR: join(root, 'claude-home')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const errors = [], checks = []
const check = label => { checks.push(label); console.log('PASS ' + label) }
let app, page
const owner = async () => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
  return JSON.parse(await readFile(path, 'utf8'))
}
const control = async (method, args = {}) => {
  const credential = await owner()
  const response = await fetch(credential.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(body))
  return body.result
}
const offer = (status, id) => status.offers.find(entry => entry.id === id)

try {
  app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
  await page.waitForFunction(() => Boolean(window.conductor?.modelUpgrades))

  // 1. One pass: npm, scratch installs, catalog probes, offers.
  let status = await control('models.upgrades.check')
  const codex = status.providers.find(entry => entry.provider === 'codex'), claude = status.providers.find(entry => entry.provider === 'claude')
  assert.deepEqual([codex.installed, codex.latest, codex.error], ['0.155.1', '0.155.9', null], JSON.stringify(status.providers))
  assert.deepEqual([claude.installed, claude.latest], ['2.1.282', '3.0.0'], JSON.stringify(status.providers))
  check('the watch read both CLIs on the fake registry and the installed versions')
  const sol = offer(status, 'codex:gpt-6.1-sol')
  assert.equal(sol?.state, 'ready', JSON.stringify(status.offers))
  assert.equal(sol.protocolBump, false)
  assert.deepEqual([sol.cli.from, sol.cli.to], ['0.155.1', '0.155.9'])
  assert.match(sol.summary, /^GPT-6.1-Sol is available \(better than GPT-6-Astra: the catalog now makes it the default instead of GPT-6-Astra\)\. Needs Codex 0\.155\.9 \(now 0\.155\.1\)\. Switch\?$/)
  check('GPT-6.1-Sol offered ready, no protocol bump: ' + sol.summary)
  const opus = offer(status, 'claude:claude-opus-5-6')
  assert.equal(opus?.state, 'blocked', JSON.stringify(status.offers))
  assert.equal(opus.protocolBump, true)
  assert.match(opus.reason, /no Conductor checkout is open/)
  check('Claude Opus 5.6 needs Claude Code 3.0.0, a protocol bump: blocked with the reason, not offered')
  const npmCalls = readFileSync(npmLog, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(npmCalls.length, 2)
  for (const call of npmCalls) {
    assert.ok(!call.includes('-g') && !call.includes('--global'), JSON.stringify(call))
    assert.ok(call[call.indexOf('--prefix') + 1].startsWith(join(profile, 'model-upgrades', 'cli')), JSON.stringify(call))
  }
  check('npm ran twice, each time into a scratch prefix under the profile, never global')

  // 2. The card and the one OK.
  const card = page.locator('.model-upgrade-card[data-offer="codex:gpt-6.1-sol"]')
  await card.waitFor({ state: 'visible' })
  await expect(card).toContainText('GPT-6.1-Sol is available (better than GPT-6-Astra')
  await expect(page.locator('.model-upgrade-card')).toHaveCount(1)
  const box = await card.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight } })
  assert.ok(box.left >= 0 && box.top >= 0 && box.right <= box.width && box.bottom <= box.height, 'card outside the window: ' + JSON.stringify(box))
  await card.screenshot({ path: join(output, 'card-only.png') })
  await page.screenshot({ path: join(output, 'card.png') })
  check('the owner sees one card for the ready offer (the blocked one shows no card)')
  await card.getByRole('button', { name: 'OK, switch' }).click()
  await expect.poll(async () => offer(await control('models.upgrades.status'), 'codex:gpt-6.1-sol')?.state, { timeout: 30_000 }).toBe('applied')
  await expect(page.locator('.model-upgrade-card')).toHaveCount(0)
  status = await control('models.upgrades.status')
  const pins = JSON.parse(await readFile(join(profile, 'local-updates', 'cli-cache', 'cli-pins.json'), 'utf8'))
  assert.equal(pins.pins.codex?.version, '0.155.9', JSON.stringify(pins))
  assert.equal(pins.pins.codex?.restorePoint, 'model-upgrade')
  assert.ok(existsSync(pins.pins.codex.executable) && pins.pins.codex.executable.startsWith(join(profile, 'local-updates', 'cli-cache')), pins.pins.codex.executable)
  const promoted = await page.evaluate(() => window.conductor.modelUpgrades.promoted())
  assert.deepEqual([promoted.codex?.model, promoted.codex?.replaces, promoted.codex?.frontier], ['gpt-6.1-sol', 'gpt-6-astra', true], JSON.stringify(promoted))
  check('OK pinned a Conductor-owned Codex 0.155.9 and promoted GPT-6.1-Sol where GPT-6-Astra was: ' + offer(status, 'codex:gpt-6.1-sol').steps.join(' / '))

  // 3. Decline is remembered; a re-check finds nothing new and installs nothing again.
  await control('models.upgrades.decline', { id: 'claude:claude-opus-5-6' })
  status = await control('models.upgrades.check')
  assert.equal(offer(status, 'claude:claude-opus-5-6')?.state, 'declined')
  assert.ok(status.declined['claude:claude-opus-5-6'])
  assert.equal(status.offers.length, 2, JSON.stringify(status.offers))
  const codexWatch = status.providers.find(entry => entry.provider === 'codex')
  assert.deepEqual([codexWatch.installed, codexWatch.launches], ['0.155.1', '0.155.9'], JSON.stringify(codexWatch))
  check('the decline is remembered and the re-check offered nothing new')
  const wizardTry = await fetch((await owner()).endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + (await owner()).token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'models.upgrades.configure', args: { wizardMayAccept: 'yes' } }) })
  assert.equal(wizardTry.status, 400)
  status = await control('models.upgrades.configure', { wizardMayAccept: true })
  assert.equal(status.wizardMayAccept, true)
  check('models.upgrades.configure validates and records the owner\'s wizard opt-in')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, registryHits, npmCalls: readFileSync(npmLog, 'utf8').trim().split(/\r?\n/).length, status }, null, 2))
  console.log(`smoke-model-upgrades passed (${checks.length} checks)`)
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) }).catch(() => {})
  await app?.close().catch(() => {})
  await new Promise(done => registry.close(done))
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
