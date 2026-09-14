import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'

/**
 * Two real Conductor instances reaching each other with no route between them.
 *
 * The direct transport is deliberately broken here: the pairing code's address is rewritten to a
 * port nothing listens on, which is what a laptop that moved networks actually finds when it dials
 * the address it was paired at. Everything after that has to travel through the encrypted relay,
 * over an offline stand-in for the account's gists, and the smoke asserts both that it works and
 * that nothing readable was ever written into the mailbox.
 *
 * Run with: powershell -NoProfile -File scripts/run-smoke-background.ps1 -SmokeScript scripts/smoke-remote-relay.mjs
 */
const root = await mkdtemp(join(tmpdir(), 'conductor-remote-relay-'))
const output = resolve('artifacts/remote-relay')
await mkdir(output, { recursive: true })
const sharedGitHubState = join(root, 'github-state.json')
await writeFile(sharedGitHubState, JSON.stringify({ keys: [], gists: [] }))

const results = { checks: [], failures: [] }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }
const launched = []

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

let host, controller
try {
  host = await launch('host')
  controller = await launch('controller')
  const hostProject = await host.page.evaluate(() => window.conductor.projects.create('Relay host project'))
  const controllerProject = await controller.page.evaluate(() => window.conductor.projects.create('Relay controller project'))

  await signIn(host.page)
  await signIn(controller.page)
  check('both machines signed into the same account')

  // Loopback exposure with the relay on: no port is published anywhere, which is the configuration
  // a machine behind someone else's router actually runs in.
  await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: true, machineName: 'Relay host' }))
  await controller.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: true, machineName: 'Relay controller' }))

  await expect.poll(async () => (await mailboxes()).length, { timeout: 30000 }).toBe(2)
  const published = await mailboxes()
  for (const gist of published) {
    assert.ok(gist.files['machine.json'], 'a mailbox published no directory entry')
    const entry = JSON.parse(gist.files['machine.json'])
    assert.equal(entry.version, 1)
    assert.ok(entry.sealKey && entry.signature && entry.deviceKey, 'a directory entry is missing its keys or signature')
  }
  check('each machine published a signed mailbox entry on the shared account')

  await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.relay.phase)), { timeout: 30000 }).toBe('ready')
  await expect.poll(() => controller.page.evaluate(() => window.conductor.remote.state().then(state => state.relay.reachable.length)), { timeout: 30000 }).toBe(1)
  check('each machine found the other through the account with no address between them')

  // The pairing code is taken from the host and then given the address a machine that moved
  // networks would have: a port nothing answers on. Only the relay can carry anything after this.
  const ticket = await host.page.evaluate(() => window.conductor.remote.createTicket())
  assert.ok(ticket.ticket.relayKey, 'the pairing code carried no relay key')
  assert.ok(ticket.ticket.deviceKey, 'the pairing code carried no device key')
  const stranded = Buffer.from(JSON.stringify({ ...ticket.ticket, host: '127.0.0.1', port: 9 }), 'utf8').toString('base64url')
  check('a pairing code carries the keys needed to reach a machine off its network')

  const connecting = controller.page.evaluate(encoded => window.conductor.remote.connect(encoded), stranded)
  const pending = await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending)), { timeout: 40000 })
    .toHaveLength(1).then(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending[0])))
  check('the pairing request reached the host with no route to it')

  await host.page.evaluate(({ id, projectId }) => window.conductor.remote.approve(id, [projectId]), { id: pending.id, projectId: hostProject.id })
  await connecting
  const connection = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0]
  assert.equal(connection.status, 'connected')
  check('the pairing completed entirely over the encrypted relay')

  const advertised = await controller.page.evaluate(machineId => window.conductor.remote.remoteProjects(machineId), connection.machineId)
  assert.equal(advertised.length, 1, 'the host advertised the wrong number of projects')
  assert.equal(advertised[0].name, 'Relay host project')
  check('a real remote call answered across the relay')

  await controller.page.evaluate(({ machineId, localId, remoteId }) => window.conductor.remote.confirmProject(machineId, localId, remoteId), {
    machineId: connection.machineId, localId: controllerProject.id, remoteId: advertised[0].id
  })
  const files = await controller.page.evaluate(({ machineId, projectId }) => window.conductor.remote.files.list({ machineId, projectId, path: '.' }),
    { machineId: connection.machineId, projectId: controllerProject.id })
  assert.ok(Array.isArray(files), `a remote directory listing did not come back: ${JSON.stringify(files)}`)
  check('the controller read the host filesystem with no route to the host')

  const transport = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0].transport
  assert.equal(transport, 'relay', `expected the relay to have carried the call, got ${transport}`)
  check('the connection reports the relay as the route it used')

  // The account holds the messages, so what it holds has to be unreadable.
  const readable = (await mailboxes()).flatMap(gist => Object.entries(gist.files))
    .filter(([name]) => /^m\./.test(name))
    .filter(([, content]) => /projects\.list|remote\/call|Relay host project|files\.list/.test(content))
  assert.deepEqual(readable.map(([name]) => name), [], 'a relayed message was readable in the mailbox')
  const machines = await controller.page.evaluate(() => window.conductor.remote.machines())
  assert.equal(machines.length, 2)
  check('nothing readable was written to the account, only sealed messages')

  /**
   * The staleness that made a reachable machine read as "unavailable" in the launcher. A paired
   * machine's status used to be only a side effect of real work, so one failed call left it marked
   * offline and the launcher then disabled it — which is also the one place the owner would have
   * made the call that cleared it. A probe has to be able to recover it on its own.
   */
  await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: false }))
  await controller.page.evaluate(async machineId => {
    try { await window.conductor.remote.remoteProjects(machineId) } catch { /* expected while it is down */ }
  }, connection.machineId)
  await expect.poll(() => controller.page.evaluate(async id => (await window.conductor.remote.machines()).find(m => m.id === id)?.status, connection.machineId))
    .toBe('offline')
  check('a machine that stops answering is marked offline')

  await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true }))
  const recovered = await expect.poll(async () => {
    const list = await controller.page.evaluate(() => window.conductor.remote.refreshMachines())
    return list.find(machine => machine.id === connection.machineId)?.status
  }, { timeout: 60000 }).toBe('online').then(() => controller.page.evaluate(() => window.conductor.remote.machines()))
  assert.equal(recovered.find(machine => machine.id === connection.machineId)?.status, 'online')
  check('a probe alone brings a recovered machine back, with no other call to make it happen')

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
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n')
}

if (results.failures.length) {
  throw results.failures.length === 1
    ? new Error(results.failures[0])
    : new AggregateError(results.failures.map(detail => new Error(detail)), 'Remote relay smoke failed')
}
console.log(`\n${results.checks.length} checks passed`)
