import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'
import { RelayServer } from '../src/relay-server/server.ts'
import { generateRoomSecret } from '../src/main/relay-room.ts'

/**
 * The relay, set up the way an owner actually sets it up: by typing into Account & machines.
 *
 * smoke-conductor-relay.mjs proves the route works when the settings are set through the bridge.
 * This proves the settings are reachable at all - that the panel renders the two boxes, that the
 * button saves both, that the secret is not echoed back into the renderer, and that the panel then
 * says which relay is carrying the machine.
 *
 * Run with: powershell -NoProfile -File scripts/run-smoke-background.ps1 -SmokeScript scripts/smoke-relay-settings.mjs
 */
const root = await mkdtemp(join(tmpdir(), 'conductor-relay-settings-'))
const output = resolve('artifacts/relay-settings')
await mkdir(output, { recursive: true })
const sharedGitHubState = join(root, 'github-state.json')
await writeFile(sharedGitHubState, JSON.stringify({ keys: [], gists: [] }))

const results = { checks: [], screenshots: [], failures: [] }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }

const secret = generateRoomSecret()
const relay = new RelayServer({ secrets: [secret], port: 0, host: '127.0.0.1' })
const bound = await relay.listen()
const endpoint = `ws://127.0.0.1:${bound.port}`

let launched = null
try {
  const env = {
    ...process.env,
    CONDUCTOR_BACKGROUND_WINDOWS: '1',
    CONDUCTOR_OFFLINE_TESTS: '1',
    CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
    CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
    CONDUCTOR_TEST_REMOTE_GITHUB: '1',
    CONDUCTOR_TEST_REMOTE_GITHUB_STATE: sharedGitHubState
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CONDUCTOR_LIVE_TESTS
  delete env.CONDUCTOR_GITHUB_CLIENT_ID
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await page.waitForFunction(() => Boolean(window.conductor?.remote))
  launched = { app, name: 'relay-settings' }

  await page.evaluate(() => window.conductor.remote.signIn())
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState().then(state => state.phase)), { timeout: 20000 }).toBe('signed-in')
  await page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: true }))

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.locator('.settings-panel')
  await expect(panel).toBeVisible()
  const account = panel.getByText('Account & machines', { exact: true })
  await account.scrollIntoViewIfNeeded()
  await expect(account).toBeVisible()
  check('the account section opened')

  const relayCard = panel.locator('.remote-relay-server')
  await relayCard.scrollIntoViewIfNeeded()
  await expect(relayCard.getByText('Run the relay yourself', { exact: true })).toBeVisible()
  const address = relayCard.locator('input[type="text"]')
  const room = relayCard.locator('input[type="password"]')
  await expect(address).toBeVisible()
  await expect(room).toBeVisible()
  await page.screenshot({ path: join(output, 'relay-settings-empty.png') })
  results.screenshots.push('artifacts/relay-settings/relay-settings-empty.png')
  check('the panel offers an address and a room secret, with the secret masked')

  await address.fill(endpoint)
  await room.fill(secret)
  await relayCard.getByRole('button', { name: 'Use this relay', exact: true }).click()

  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relay.route)), { timeout: 30000 }).toBe('server')
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relay.phase)), { timeout: 30000 }).toBe('ready')
  check('typing the address and the secret put this machine on its own relay')

  // The secret is write-only from the renderer: the state says one is held, never what it is.
  const state = await page.evaluate(() => window.conductor.remote.state())
  assert.equal(state.relaySecretSet, true)
  assert.equal(state.settings.relayEndpoint, endpoint)
  assert.ok(!JSON.stringify(state).includes(secret), 'the room secret came back to the renderer')
  await expect(room).toHaveValue('')
  check('the secret is held on the machine and never handed back to the window')

  const route = panel.locator('.remote-endpoint').getByText(/Your own relay/)
  await route.scrollIntoViewIfNeeded()
  await expect(route).toBeVisible()
  await page.screenshot({ path: join(output, 'relay-settings-connected.png') })
  results.screenshots.push('artifacts/relay-settings/relay-settings-connected.png')
  check('the panel says which relay is carrying this machine')

  await relayCard.getByRole('button', { name: 'Back to the gist', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relay.route)), { timeout: 20000 }).toBe('github')
  const cleared = await page.evaluate(() => window.conductor.remote.state())
  assert.equal(cleared.settings.relayEndpoint, '')
  assert.equal(cleared.relaySecretSet, false)
  check('the owner can put the machine back on the gist mailbox from the same place')
} catch (error) {
  results.failures.push(String(error?.stack ?? error))
} finally {
  if (launched) {
    try { await cleanupFixtureApp(launched.app, results, 'relay settings cleanup') }
    catch (error) { results.failures.push(String(error?.stack ?? error)) }
  }
  await relay.close()
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n')
}

if (results.failures.length) {
  throw results.failures.length === 1
    ? new Error(results.failures[0])
    : new AggregateError(results.failures.map(detail => new Error(detail)), 'Relay settings smoke failed')
}
console.log(`\n${results.checks.length} checks passed`)
