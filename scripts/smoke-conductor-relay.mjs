import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'
import { RelayServer } from '../src/relay-server/server.ts'
import { generateRoomSecret } from '../src/main/relay-room.ts'

/**
 * Two real Conductor instances linked through a relay the owner runs, with no route between them.
 *
 * This is the same shape as smoke-remote-relay.mjs - the pairing code's address is rewritten to a
 * port nothing answers on, so the direct transport cannot be what carries anything - but the
 * mailbox is gone. A real relay server listens, and the two machines meet on it.
 *
 * The controller starts with no relay configured at all. It learns the address and the room secret
 * from the pairing code, which is the only way an owner should have to do this: they already carry
 * the code between their own machines through a channel they trust.
 *
 * Run with: powershell -NoProfile -File scripts/run-smoke-background.ps1 -SmokeScript scripts/smoke-conductor-relay.mjs
 */
const root = await mkdtemp(join(tmpdir(), 'conductor-own-relay-'))
const output = resolve('artifacts/conductor-relay')
await mkdir(output, { recursive: true })
const sharedGitHubState = join(root, 'github-state.json')
await writeFile(sharedGitHubState, JSON.stringify({ keys: [], gists: [] }))

const results = { checks: [], failures: [] }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }
const launched = []

/**
 * Normally this starts its own relay. Point CONDUCTOR_RELAY_SMOKE_ENDPOINT and
 * CONDUCTOR_RELAY_SMOKE_SECRET at one that is already running - a container, or a deployed one -
 * and the same checks run against that instead, which is how the packaged image is verified to be
 * the same relay as the source.
 */
const external = process.env.CONDUCTOR_RELAY_SMOKE_ENDPOINT && process.env.CONDUCTOR_RELAY_SMOKE_SECRET
const secret = external ? process.env.CONDUCTOR_RELAY_SMOKE_SECRET : generateRoomSecret()
const relay = external ? null : new RelayServer({ secrets: [secret], port: 0, host: '127.0.0.1' })
const bound = relay ? await relay.listen() : null
const endpoint = external ? process.env.CONDUCTOR_RELAY_SMOKE_ENDPOINT : `ws://127.0.0.1:${bound.port}`
const healthUrl = `${endpoint.replace(/^ws/, 'http').replace(/\/v1\/socket$/, '')}/v1/health`
console.log(`relay at ${endpoint}${external ? ' (already running)' : ''}`)

const launch = async name => {
  const env = {
    ...process.env,
    CONDUCTOR_BACKGROUND_WINDOWS: '1',
    CONDUCTOR_OFFLINE_TESTS: '1',
    CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_USER_DATA: join(root, name + '-profile'),
    CONDUCTOR_PROJECTS_ROOT: join(root, name + '-projects'),
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
  launched.push({ app, name })
  return { app, page, name }
}

const signIn = async page => {
  const started = await page.evaluate(() => window.conductor.remote.signIn())
  assert.equal(started.phase, 'awaiting-authorization')
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState()), { timeout: 15000 })
    .toMatchObject({ phase: 'signed-in', identity: { login: 'offline-remote-fixture' } })
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState().then(state => state.deviceKeyFingerprint)), { timeout: 15000 })
    .not.toBeNull()
}

const mailboxes = async () => JSON.parse(await readFile(sharedGitHubState, 'utf8')).gists ?? []
const health = async () => await (await fetch(healthUrl)).json()

let host, controller
try {
  host = await launch('host')
  controller = await launch('controller')
  const hostProject = await host.page.evaluate(() => window.conductor.projects.create('Relay host project'))
  const controllerProject = await controller.page.evaluate(() => window.conductor.projects.create('Relay controller project'))

  await signIn(host.page)
  await signIn(controller.page)
  check('both machines signed into the same account')

  // Loopback exposure: no port is published anywhere, which is the configuration a machine behind
  // someone else's router actually runs in.
  await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: true, machineName: 'Relay host' }))
  await controller.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: true, machineName: 'Relay controller' }))

  // Only the host is told about the relay. The controller has to learn it from the pairing code.
  const configured = await host.page.evaluate(({ address, room }) => window.conductor.remote.setRelayServer(address, room), { address: endpoint, room: secret })
  assert.equal(configured.settings.relayEndpoint, endpoint)
  assert.equal(configured.relaySecretSet, true)
  check('the host was pointed at a relay of its own, with the secret kept out of settings')

  await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.relay.phase)), { timeout: 30000 }).toBe('ready')
  await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.relay.route)), { timeout: 10000 }).toBe('server')
  await expect.poll(async () => (await health()).connections, { timeout: 15000 }).toBe(1)
  check('the host connected to the relay and the relay says so')

  const ticket = await host.page.evaluate(() => window.conductor.remote.createTicket())
  assert.equal(ticket.ticket.relayEndpoint, endpoint, 'the pairing code did not carry the relay address')
  assert.ok(ticket.ticket.relaySecret, 'the pairing code did not carry the room secret')
  assert.ok(ticket.ticket.relayKey && ticket.ticket.deviceKey, 'the pairing code carried no keys')
  // The address a machine that moved networks actually finds when it dials where it was paired.
  const stranded = Buffer.from(JSON.stringify({ ...ticket.ticket, host: '127.0.0.1', port: 9 }), 'utf8').toString('base64url')
  check('a pairing code carries the whole route: the keys, the relay and its secret')

  // The controller is deliberately set up wrong first: its own relay, its own room. Pasting an
  // invite has to move it to the inviting machine's relay, or two correctly configured machines sit
  // in different empty rooms - which is the failure this whole flow exists to remove.
  await controller.page.evaluate(() => window.conductor.remote.setRelayHosting({ enabled: true }))
  await expect.poll(() => controller.page.evaluate(() => window.conductor.remote.state().then(state => state.relayHost.running)), { timeout: 30000 }).toBe(true)
  check('the controller was put on a relay of its own, in a different room')

  const connecting = controller.page.evaluate(encoded => window.conductor.remote.connect(encoded), stranded)
  const pending = await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending)), { timeout: 60000 })
    .toHaveLength(1).then(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending[0])))
  check('the pairing request reached a machine with no route to it')

  const adopted = await controller.page.evaluate(() => window.conductor.remote.state())
  assert.equal(adopted.settings.relayEndpoint, endpoint, 'the controller did not adopt the relay from the pairing code')
  assert.equal(adopted.relay.route, 'server')
  assert.equal(adopted.settings.relayHosting, false, 'the controller kept running its own relay after joining another room')
  assert.equal(adopted.relayHost.running, false, 'the controller kept a relay listening for a room it left')
  check("the invite moved the controller onto the inviting machine's relay and stopped its own")

  await host.page.evaluate(({ id, projectId }) => window.conductor.remote.approve(id, [projectId]), { id: pending.id, projectId: hostProject.id })
  await connecting
  const connection = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0]
  assert.equal(connection.status, 'connected')
  check('the pairing completed entirely over the owner\'s own relay')

  const advertised = await controller.page.evaluate(machineId => window.conductor.remote.remoteProjects(machineId), connection.machineId)
  assert.equal(advertised.length, 1, 'the host advertised the wrong number of projects')
  assert.equal(advertised[0].name, 'Relay host project')
  check('a real remote call answered across the relay')

  // The host's projects are adopted into this machine's own list as that machine's projects, so the
  // id to read files by is the adopted row's - never the controller's own project, which is a
  // different project on a different disk.
  const hostRow = (await controller.page.evaluate(() => window.conductor.projects.list()))
    .find(project => project.remote?.machineId === connection.machineId && project.remote.remoteProjectId === advertised[0].id)
  assert.ok(hostRow, 'the host project was not adopted into the controller\'s project list')
  assert.notEqual(hostRow.id, controllerProject.id, 'a host project must never be listed as this machine\'s own')
  const files = await controller.page.evaluate(({ machineId, projectId }) => window.conductor.remote.files.list({ machineId, projectId, path: '.' }),
    { machineId: connection.machineId, projectId: hostRow.id })
  assert.ok(Array.isArray(files), `a remote directory listing did not come back: ${JSON.stringify(files)}`)
  const transport = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0].transport
  assert.equal(transport, 'relay', `expected the relay to have carried the call, got ${transport}`)
  check('the controller read the host filesystem with no route to the host')

  // The whole point of running a relay is that the account is not in the path at all.
  const written = (await mailboxes()).flatMap(gist => Object.keys(gist.files)).filter(name => /^m\./.test(name))
  assert.deepEqual(written, [], 'a message was written to the GitHub mailbox while a relay was configured')
  check('not one message went through the GitHub account')

  // Presence, not polling: switching the host off has to be visible without anybody asking.
  await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: false }))
  await expect.poll(() => controller.page.evaluate(() => window.conductor.remote.state().then(state => state.relay.reachable.length)), { timeout: 30000 }).toBe(0)
  check('the controller was told the host left, without probing for it')

  await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true }))
  await expect.poll(async () => {
    const list = await controller.page.evaluate(() => window.conductor.remote.refreshMachines())
    return list.find(machine => machine.id === connection.machineId)?.status
  }, { timeout: 60000 }).toBe('online')
  check('the host came back and was reachable again')

  await controller.page.evaluate(machineId => window.conductor.remote.forget(machineId), connection.machineId)
  await host.page.evaluate(peerId => window.conductor.remote.revoke(peerId), connection.peerId)
  check('the pairing was torn down from both sides')
} catch (error) {
  results.failures.push(String(error?.stack ?? error))
} finally {
  for (const entry of launched) {
    try { await cleanupFixtureApp(entry.app, results, `${entry.name} cleanup`) }
    catch (error) { results.failures.push(String(error?.stack ?? error)) }
  }
  if (relay) await relay.close()
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n')
}

if (results.failures.length) {
  throw results.failures.length === 1
    ? new Error(results.failures[0])
    : new AggregateError(results.failures.map(detail => new Error(detail)), 'Conductor relay smoke failed')
}
console.log(`\n${results.checks.length} checks passed`)
