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
 * This proves an owner can get there at all: start a relay from the panel with nothing typed, watch
 * it mint its own certificate and secret, see the pairing code carry all three to the other machine,
 * and - for a relay that runs somewhere else - type an address and a secret that is never handed
 * back to the window.
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

  // The one flow that matters: a code that carries everything, made by one button.
  await panel.getByRole('button', { name: 'Invite a device', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relayHost.running)), { timeout: 30000 }).toBe(true)
  const invited = await page.evaluate(() => window.conductor.remote.state())
  assert.equal(invited.settings.relayHosting, true, 'inviting a device did not start a relay here')
  assert.equal(invited.relaySecretSet, true, 'inviting a device did not make a room secret')
  await expect(panel.locator('.remote-link .remote-ticket')).not.toHaveValue('')
  await page.screenshot({ path: join(output, 'relay-invite.png') })
  results.screenshots.push('artifacts/relay-settings/relay-invite.png')
  check('one button turned everything on and produced an invite that carries it')

  // Everything the flow replaced is still reachable, one fold down.
  await panel.locator('.remote-advanced > summary').click()
  const relayCard = panel.locator('.remote-relay-server')
  await relayCard.scrollIntoViewIfNeeded()
  await expect(relayCard.getByText('Run the relay on this machine', { exact: true })).toBeVisible()

  // The same relay, switched by hand for an owner who wants to see the parts.
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relayHost.running)), { timeout: 30000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relay.phase)), { timeout: 30000 }).toBe('ready')
  const hosted = await page.evaluate(() => window.conductor.remote.state())
  assert.ok(hosted.relayHost.port, 'the relay it started has no port')
  assert.ok(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/.test(hosted.relayHost.fingerprint ?? ''), 'the relay it started has no certificate')
  assert.equal(hosted.relay.route, 'server')
  assert.equal(hosted.relaySecretSet, true, 'starting a relay did not produce a room secret')
  await page.screenshot({ path: join(output, 'relay-hosted.png') })
  results.screenshots.push('artifacts/relay-settings/relay-hosted.png')
  check('a relay was started from the panel, with its own certificate and a secret it made itself')

  // And the code that carries all of it to the other machine, so nothing is typed there either.
  const code = await page.evaluate(() => window.conductor.remote.createTicket())
  // What the other machine is told to dial is exactly what this one advertises on this network.
  assert.equal(code.ticket.relayEndpoint, hosted.relayHost.addresses[0], 'the pairing code did not carry the relay address')
  assert.ok(code.ticket.relaySecret, 'the pairing code did not carry the room secret')
  assert.equal(code.ticket.relayFingerprint, hosted.relayHost.fingerprint, 'the pairing code did not carry the certificate to pin')
  check('the pairing code carries the address, the secret and the certificate to pin')

  await relayCard.getByText('Run the relay on this machine', { exact: true }).locator('xpath=../..').locator('input[type="checkbox"]').uncheck()
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.relayHost.running)), { timeout: 20000 }).toBe(false)
  await page.evaluate(() => window.conductor.remote.setRelayServer('', ''))
  check('the relay it runs can be stopped from the same place')

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
