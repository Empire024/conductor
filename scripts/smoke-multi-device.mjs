import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { hostname, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'

/**
 * The whole of docs/multi-device.md that one machine can actually create: two real Conductor
 * instances here, 'host' playing MAIN and 'controller' playing the laptop.
 *
 * Both run with exposure 'loopback' and `relay: false`. Tailscale exposure cannot bind on a machine
 * without Tailscale - the listener deliberately refuses to start rather than widen - so loopback
 * stands in for the tailnet here. This does not prove cross-network reachability: nothing below
 * says anything about a real tailnet address, about DERP fallback behind a real NAT, or about a
 * Tailscale ACL being enforced by Tailscale's own coordination server. Those are the two-machine
 * checklist in docs/multi-device.md and they cannot be closed by anything running on one machine.
 *
 * What it does prove is the protocol both sides speak: pairing without a relay, a project opened on
 * the laptop with no local copy, files written through the grant with revision checks, a shell that
 * really runs on the host, attach-from-offset across a restart of the controller, detach that
 * survives a restart and dials nothing, revocation that lands immediately, and an unpaired device
 * refused at the door.
 *
 * Run with: powershell -NoProfile -File scripts/run-smoke-background.ps1 -SmokeScript scripts/smoke-multi-device.mjs
 */
const root = await mkdtemp(join(tmpdir(), 'conductor-multi-device-'))
const output = resolve('artifacts/multi-device')
await mkdir(output, { recursive: true })
const sharedGitHubState = join(root, 'github-state.json')
await writeFile(sharedGitHubState, JSON.stringify({ keys: [], gists: [] }))

const results = { startedAt: new Date().toISOString(), checks: [], failures: [], notes: {}, screenshots: [] }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }
const note = (key, value) => { results.notes[key] = value; console.log(`note ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`) }
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
  const instance = { app, page, name }
  launched.push(instance)
  return instance
}

/** Closes one instance through the application's own guarded quit, leaving its profile on disk. */
const close = async instance => {
  await cleanupFixtureApp(instance.app, results, `${instance.name} shutdown`)
  const at = launched.indexOf(instance)
  if (at >= 0) launched.splice(at, 1)
}

const signIn = async page => {
  const started = await page.evaluate(() => window.conductor.remote.signIn())
  assert.equal(started.phase, 'awaiting-authorization')
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState()), { timeout: 15000 })
    .toMatchObject({ phase: 'signed-in', identity: { login: 'offline-remote-fixture' } })
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState().then(state => state.deviceKeyFingerprint)), { timeout: 15000 })
    .not.toBeNull()
}

const enableRemote = async (page, machineName) => {
  await page.evaluate(name => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: false, machineName: name }), machineName)
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.listening)), { timeout: 30000 }).toBe(true)
  return await page.evaluate(() => window.conductor.remote.state().then(state => state.endpoint))
}

const gists = async () => JSON.parse(await readFile(sharedGitHubState, 'utf8')).gists ?? []

/** Terminal output as the pane sees it, collected in the page from the ordinary broadcast. */
const watchRuntime = page => page.evaluate(() => {
  const scope = window
  scope.__smokeStop?.()
  scope.__smokeTerminal = []
  scope.__smokeFiles = []
  const stopTerminal = scope.conductor.terminals.onData(payload => scope.__smokeTerminal.push(payload))
  const stopFiles = scope.conductor.files.onChanged(change => scope.__smokeFiles.push(change))
  scope.__smokeStop = () => { stopTerminal(); stopFiles() }
})

const terminalText = (page, localTerminalId) => page.evaluate(
  id => (window.__smokeTerminal ?? []).filter(entry => entry.id === id).map(entry => entry.data).join(''), localTerminalId)

const fileNotices = page => page.evaluate(() => window.__smokeFiles ?? [])

/**
 * A PTY at a fixed width wraps, repaints and colours what it echoes. Comparing the terminal as a
 * stream of visible characters - escapes and layout removed - is the honest way to ask whether a
 * command's answer came back, without asserting on how conpty chose to draw it.
 */
const visible = text => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b[@-Z\\-_]/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\s+/g, '')
  .toLowerCase()

const type = (page, localTerminalId, command) =>
  page.evaluate(({ id, line }) => window.conductor.terminals.write(id, line + '\r'), { id: localTerminalId, line: command })

const awaitTerminal = async (page, localTerminalId, needle, timeout = 40000) => {
  const wanted = visible(needle)
  await expect.poll(async () => visible(await terminalText(page, localTerminalId)).includes(wanted), { timeout, intervals: [200, 250, 500] })
    .toBe(true)
}

/** An unpaired caller at the door: no device key, no signature, nothing but the address. */
const rawCall = (origin, path, body) => new Promise((resolveRequest, rejectRequest) => {
  const url = new URL(origin)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const call = httpsRequest({
    host: url.hostname, port: Number(url.port), path, method: 'POST', rejectUnauthorized: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
  }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
  })
  call.on('error', rejectRequest)
  call.end(payload)
})

const screenshot = async (locator, name) => {
  const path = join(output, name)
  await locator.screenshot({ path })
  results.screenshots.push(path)
  return path
}


/** The settings panel, scrolled to the one section this smoke is about. */
const openAccountAndMachines = async page => {
  if (!await page.locator('.remote-control-settings').count()) {
    await page.locator('button[aria-label="Settings"]').first().click()
  }
  const panel = page.locator('.remote-control-settings')
  await panel.waitFor({ state: 'visible', timeout: 15000 })
  return panel
}

const closeSettings = async page => {
  const closer = page.locator('.settings-panel button[aria-label="Close settings"], .settings-panel header button').first()
  if (await closer.count()) await closer.click().catch(() => undefined)
  await page.keyboard.press('Escape').catch(() => undefined)
}

const thisMachine = hostname()
let host, controller, stranger
let hostProject, remoteProject, controllerSessionId, machineId, peerId, hostEndpoint, binding
const helloPath = () => join(hostProject.path, 'hello.txt')

try {
  // ---- 1. two machines, signed in, one of them hosting -----------------------------------------
  host = await launch('host')
  controller = await launch('controller')
  await signIn(host.page)
  await signIn(controller.page)
  check('both instances signed into the same account through the offline GitHub stand-in')

  hostEndpoint = await enableRemote(host.page, 'MAIN')
  assert.ok(hostEndpoint?.startsWith('https://127.0.0.1:'), `loopback exposure published an unexpected endpoint: ${hostEndpoint}`)
  hostProject = await host.page.evaluate(() => window.conductor.projects.create('MultiDeviceHost'))
  assert.ok(existsSync(hostProject.path), 'the host project has no folder on disk')
  await writeFile(helloPath(), 'hello from MAIN\n')
  await enableRemote(controller.page, 'Laptop')
  note('hostProjectPath', hostProject.path)
  note('hostEndpoint', hostEndpoint)
  check('the host is listening on loopback with a real project folder, and the controller has remote control on')

  // ---- 2. pairing, with no relay anywhere in the ticket -----------------------------------------
  const ticket = await host.page.evaluate(() => window.conductor.remote.createTicket())
  assert.ok(ticket.ticket.code && ticket.ticket.fingerprint, 'the pairing code carried no single-use code or pinned certificate')
  assert.equal(ticket.ticket.host, '127.0.0.1', `loopback exposure advertised ${ticket.ticket.host}`)
  assert.equal(ticket.ticket.relayKey ?? null, null, 'a relay key travelled in a pairing code made with the relay off')
  assert.equal(ticket.ticket.deviceKey ?? null, null, 'a relay directory key travelled in a pairing code made with the relay off')
  assert.equal(ticket.ticket.relayEndpoint ?? null, null, 'a relay address travelled in a pairing code made with the relay off')
  assert.equal(ticket.ticket.relaySecret ?? null, null, 'a relay room secret travelled in a pairing code made with the relay off')
  check('the pairing code carries the keys and the address only - no relayKey, no relayEndpoint')

  const connecting = controller.page.evaluate(encoded => window.conductor.remote.connect(encoded), ticket.encoded)
  const pending = await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending)), { timeout: 40000 })
    .toHaveLength(1).then(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending[0])))
  await host.page.evaluate(({ id, projectId }) => window.conductor.remote.approve(id, [projectId]), { id: pending.id, projectId: hostProject.id })
  await connecting
  const connection = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0]
  assert.equal(connection.status, 'connected')
  machineId = connection.machineId
  peerId = connection.peerId
  check('the ticket was redeemed, the request appeared on the host, and approval with a project left the controller connected')

  // ---- 3. the push channel --------------------------------------------------------------------
  await expect.poll(async () => (await controller.page.evaluate(() => window.conductor.remote.machines())).find(machine => machine.id === machineId)?.connection?.state,
    { timeout: 40000 }).toBe('connected')
  await expect.poll(() => controller.page.evaluate(id => window.conductor.remote.diagnostics(id).then(report => report.stream.open), machineId), { timeout: 40000 }).toBe(true)
  check('the controller reports the host connected and its push channel open')

  // ---- 4. a project that lives on the host, with no local copy ----------------------------------
  const controllerProjectsRoot = join(root, 'controller-projects')
  const before = existsSync(controllerProjectsRoot) ? readdirSync(controllerProjectsRoot) : []
  remoteProject = await controller.page.evaluate(({ id, remoteId }) => window.conductor.remote.openRemoteProject(id, remoteId), { id: machineId, remoteId: hostProject.id })
  assert.equal(remoteProject.remote?.machineId, machineId, 'the opened project does not name the machine it lives on')
  assert.equal(remoteProject.remote?.remoteProjectId, hostProject.id)
  const listed = await controller.page.evaluate(() => window.conductor.projects.list())
  assert.ok(listed.some(project => project.id === remoteProject.id), 'the remote project is not in the controller project list')
  // The record shows the host's own path, which is what the owner is told. What must not exist is a
  // local working copy: nothing was created under this instance's own projects root.
  assert.equal(remoteProject.path, hostProject.path, 'the remote project record does not carry the host path')
  const after = existsSync(controllerProjectsRoot) ? readdirSync(controllerProjectsRoot) : []
  assert.deepEqual(after, before, `the controller created local folders for a remote project: ${JSON.stringify(after)}`)
  assert.equal(after.includes(basename(hostProject.path)), false, 'the controller made its own copy of the host project folder')
  note('remoteProjectLocalCopy', { controllerProjectsRoot, entries: after, hostFolder: basename(hostProject.path) })
  check('the controller opened the host project with no local copy of it anywhere on its own side')

  // ---- 5. files through the grant, with revision checks -----------------------------------------
  await watchRuntime(controller.page)
  const identity = { machineId, projectId: remoteProject.id }
  const directory = await controller.page.evaluate(id => window.conductor.remote.files.list({ ...id, path: '.' }), identity)
  assert.ok(Array.isArray(directory), `a remote directory listing did not come back: ${JSON.stringify(directory)}`)
  assert.ok(directory.some(entry => entry.name === 'hello.txt'), `hello.txt is missing from the remote listing: ${JSON.stringify(directory.map(entry => entry.name))}`)
  const read = await controller.page.evaluate(id => window.conductor.remote.files.read({ ...id, path: 'hello.txt' }), identity)
  const original = read.content ?? read.file?.content
  assert.equal(original, 'hello from MAIN\n', `the host file read back as ${JSON.stringify(original)}`)

  const edited = 'hello from the laptop\n'
  const saved = await controller.page.evaluate(({ id, content, expected }) =>
    window.conductor.remote.files.write({ ...id, path: 'hello.txt', content, expectedContent: expected }), { id: identity, content: edited, expected: original })
  assert.equal((saved.result ?? saved).status, 'saved', `the remote write was not accepted: ${JSON.stringify(saved)}`)
  assert.equal(await readFile(helloPath(), 'utf8'), edited, "the host's own file on disk does not hold what the controller wrote")

  const stale = await controller.page.evaluate(({ id, content, expected }) =>
    window.conductor.remote.files.write({ ...id, path: 'hello.txt', content, expectedContent: expected })
      .then(value => ({ ok: true, value }), reason => ({ ok: false, message: String(reason?.message ?? reason) })), { id: identity, content: 'written over a stale view\n', expected: original })
  const staleStatus = stale.ok ? (stale.value.result ?? stale.value).status : 'rejected'
  assert.notEqual(staleStatus, 'saved', `a write against a stale expectedContent was accepted: ${JSON.stringify(stale)}`)
  assert.equal(await readFile(helloPath(), 'utf8'), edited, 'a refused write still changed the host file')
  note('staleWrite', stale.ok ? stale.value.result ?? stale.value : stale.message)
  check('a file was listed, read and written on the host through the project grant, and a stale write was refused with the disk unchanged')

  // ---- 6. what the push channel said about that write -------------------------------------------
  // The controller subscribes to every shared project's workspace on the stream, so the host's
  // files.changed for that write must arrive here as a files:changed named by the controller's own
  // id for the project. A stream that merely stays open is not evidence - the notice is.
  let notices = []
  await expect.poll(async () => {
    notices = (await fileNotices(controller.page)).filter(change => change.machineId === machineId && change.projectId === remoteProject.id)
    return notices.length
  }, { timeout: 15000, intervals: [250, 500] }).toBeGreaterThanOrEqual(1)
  assert.ok(notices.some(change => String(change.path).replace(/\\/g, '/').endsWith('hello.txt')), 'no notice named hello.txt: ' + JSON.stringify(notices))
  const streamStillOpen = await controller.page.evaluate(id => window.conductor.remote.diagnostics(id), machineId)
  assert.equal(streamStillOpen.stream.open, true, 'the push channel was not open after a remote write')
  note('step6', 'files:changed arrived on the renderer hook for the remote project (' + notices.length + ' notice(s))')
  check('the controller was told over the stream that the remote project changed, naming the file')

  // ---- 7. a shell that really runs on the host ---------------------------------------------------
  const workspaces = await controller.page.evaluate(id => window.conductor.sessions.list(id), remoteProject.id)
  assert.ok(workspaces.length, 'the remote project has no workspace on the controller')
  controllerSessionId = workspaces[0].id
  binding = await controller.page.evaluate(({ id, projectId, sessionId }) =>
    window.conductor.remote.terminals.open({ machineId: id, projectId, sessionId, cols: 100, rows: 30 }),
    { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId })
  assert.ok(binding.localTerminalId && binding.remoteTerminalId, `terminals.open returned no binding: ${JSON.stringify(binding)}`)
  assert.equal(binding.machineId, machineId)

  const mounted = await controller.page.evaluate(({ id, projectId, sessionId, cwd }) =>
    window.conductor.terminals.ensure({ id, projectId, sessionId, title: 'smoke', cwd }),
    { id: binding.localTerminalId, projectId: remoteProject.id, sessionId: controllerSessionId, cwd: remoteProject.path })
  assert.equal(mounted.status, 'running', `mounting the remote terminal did not report a running shell: ${JSON.stringify(mounted)}`)
  assert.equal(mounted.transcript, '', 'the controller produced a local transcript for a shell it does not own')
  assert.match(String(mounted.executable), /terminal$/, `the mounted terminal does not name the machine it runs on: ${JSON.stringify(mounted)}`)

  // Opened at the pane's 100 columns; widened so a long host path is not wrapped by conpty.
  await controller.page.evaluate(id => window.conductor.terminals.resize(id, 220, 30), binding.localTerminalId)
  await type(controller.page, binding.localTerminalId, 'Write-Host ("CONDUCTOR-" + $env:COMPUTERNAME + "-" + $PWD.Path)')
  await awaitTerminal(controller.page, binding.localTerminalId, `CONDUCTOR-${thisMachine}-${hostProject.path}`)
  check(`a command run from the controller answered with this machine's hostname and the HOST project path (${thisMachine})`)

  // Nothing was spawned here. A local terminal in the same instance names a real shell executable;
  // the remote one names the machine it runs on, and leaves no runtime process row behind.
  const localProject = await controller.page.evaluate(() => window.conductor.projects.create('LocalContrast'))
  const localWorkspaces = await controller.page.evaluate(id => window.conductor.sessions.list(id), localProject.id)
  const localTerminalId = 'terminal-local-contrast'
  const localMounted = await controller.page.evaluate(({ id, projectId, sessionId, cwd }) =>
    window.conductor.terminals.ensure({ id, projectId, sessionId, title: 'local contrast', cwd }),
    { id: localTerminalId, projectId: localProject.id, sessionId: localWorkspaces[0].id, cwd: localProject.path })
  assert.match(String(localMounted.executable), /(powershell|pwsh|cmd)/i, `a local terminal did not name a real shell: ${JSON.stringify(localMounted)}`)
  await controller.page.evaluate(id => window.conductor.terminals.kill(id), localTerminalId)
  const controllerProcesses = await controller.page.evaluate(id => window.conductor.agents.listProcesses(id), remoteProject.id)
  assert.deepEqual(controllerProcesses.filter(entry => entry.kind === 'terminal'), [],
    `the controller recorded a runtime process for a shell that runs on the host: ${JSON.stringify(controllerProcesses)}`)
  const hostTerminals = await controller.page.evaluate(({ id, projectId, sessionId }) =>
    window.conductor.remote.terminals.list({ machineId: id, projectId, sessionId }), { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId })
  assert.equal(hostTerminals.length, 1, `the host is running the wrong number of shells: ${JSON.stringify(hostTerminals)}`)
  note('noLocalPty', {
    remoteEnsure: { status: mounted.status, transcript: mounted.transcript, executable: mounted.executable },
    localEnsure: { status: localMounted.status, executable: localMounted.executable },
    controllerTerminalProcessRows: controllerProcesses.filter(entry => entry.kind === 'terminal').length,
    hostTerminals: hostTerminals.length
  })
  check('the controller spawned no shell of its own: the remote mount names the host, records no runtime process here, and the host has exactly one terminal')

  // ---- 8. reattach without a second shell --------------------------------------------------------
  await type(controller.page, binding.localTerminalId, 'Write-Host ("MARK" + "ER-1")')
  await awaitTerminal(controller.page, binding.localTerminalId, 'MARKER-1')
  const beforeAttach = (await controller.page.evaluate(({ id, projectId, sessionId }) =>
    window.conductor.remote.terminals.list({ machineId: id, projectId, sessionId }), { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId }))[0]
  assert.ok(beforeAttach.offset > 0, 'the host reports no buffered output for a shell that has already answered')
  const reattached = await controller.page.evaluate(({ id, projectId, sessionId, remoteTerminalId }) =>
    window.conductor.remote.terminals.attach({ machineId: id, projectId, sessionId, remoteTerminalId }),
    { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId, remoteTerminalId: binding.remoteTerminalId })
  assert.equal(reattached.localTerminalId, binding.localTerminalId, 'attaching to the same host shell produced a second local terminal')
  assert.equal(reattached.remoteTerminalId, binding.remoteTerminalId)
  const afterAttach = await controller.page.evaluate(({ id, projectId, sessionId }) =>
    window.conductor.remote.terminals.list({ machineId: id, projectId, sessionId }), { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId })
  assert.equal(afterAttach.length, 1, `attaching started another shell on the host: ${JSON.stringify(afterAttach)}`)
  assert.ok(visible(await terminalText(controller.page, binding.localTerminalId)).includes(visible('MARKER-1')),
    'output produced before the attach is not in what this view holds')
  note('reattach', {
    localTerminalId: binding.localTerminalId, offsetBeforeAttach: beforeAttach.offset, offsetAfterAttach: afterAttach[0].offset,
    how: 'attach for a shell this machine is already bound to is answered from the binding index without asking the host, which is what makes a second shell impossible. Attach-from-offset on the host itself is exercised across the controller restart in step 9.'
  })
  check('reattaching bound the same local id to the same host shell, with one shell on the host and the earlier output still in the view')

  // ---- 9. the controller restarts; the shell on the host does not -------------------------------
  // Something the shell will do while nobody is attached, so the restart has real output to resume.
  await type(controller.page, binding.localTerminalId, 'Start-Sleep -Seconds 4; Write-Host ("OFFL" + "INE-MARKER"); Set-Content -Path offline.txt -Value ran')
  await close(controller)
  await expect.poll(() => existsSync(join(hostProject.path, 'offline.txt')), { timeout: 30000, intervals: [250, 500] }).toBe(true)
  note('shellRanWhileControllerClosed', join(hostProject.path, 'offline.txt'))

  controller = await launch('controller')
  // What the restarted controller believed while it waited, kept for the report when it never gets there.
  const restartWatch = []
  try {
    await expect.poll(async () => {
      const machine = (await controller.page.evaluate(() => window.conductor.remote.machines())).find(machine => machine.id === machineId)
      restartWatch.push({ at: new Date().toISOString(), status: machine?.status, connection: machine?.connection })
      return machine?.connection?.state
    }, { timeout: 60000 }).toBe('connected')
  } catch (error) {
    note('restartWatch', restartWatch.slice(-4))
    note('restartDiagnostics', await controller.page.evaluate(id => window.conductor.remote.diagnostics(id), machineId).catch(reason => String(reason)))
    note('restartConnectionRecord', await controller.page.evaluate(() => window.conductor.remote.state().then(state => state.connections)))
    note('hostPeersAfterRestart', await host.page.evaluate(() => window.conductor.remote.state().then(state => state.peers.map(peer => ({ id: peer.id, lastSeenAt: peer.lastSeenAt, revokedAt: peer.revokedAt })))))
    throw error
  }
  await watchRuntime(controller.page)
  const remounted = await controller.page.evaluate(({ id, projectId, sessionId, cwd }) =>
    window.conductor.terminals.ensure({ id, projectId, sessionId, title: 'smoke', cwd }),
    { id: binding.localTerminalId, projectId: remoteProject.id, sessionId: controllerSessionId, cwd: remoteProject.path })
  assert.equal(remounted.status, 'running', `the persisted binding did not remount: ${JSON.stringify(remounted)}`)
  await awaitTerminal(controller.page, binding.localTerminalId, 'OFFLINE-MARKER')
  await type(controller.page, binding.localTerminalId, 'Write-Host ("MARK" + "ER-2")')
  await awaitTerminal(controller.page, binding.localTerminalId, 'MARKER-2')
  const afterRestart = await controller.page.evaluate(({ id, projectId, sessionId }) =>
    window.conductor.remote.terminals.list({ machineId: id, projectId, sessionId }), { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId })
  assert.equal(afterRestart.length, 1, `restarting the controller left a second shell on the host: ${JSON.stringify(afterRestart)}`)
  const hostProcesses = await host.page.evaluate(id => window.conductor.agents.listProcesses(id), hostProject.id)
  const hostRunning = hostProcesses.filter(entry => entry.kind === 'terminal' && entry.status !== 'exited')
  assert.equal(hostRunning.length, 1, `the host is running the wrong number of shells after the restart: ${JSON.stringify(hostProcesses)}`)
  check('the controller restarted, reattached the persisted terminal, replayed what the shell said while it was closed, and left exactly one shell on the host')

  // ---- 10. the account was never in the path ----------------------------------------------------
  const mailboxes = await gists()
  assert.deepEqual(mailboxes, [], `something was written to the GitHub account with the relay off: ${JSON.stringify(mailboxes)}`)
  check('not one gist was created: with the relay off the account carried nothing')

  // ---- 11. use this computer independently -------------------------------------------------------
  await controller.page.evaluate(id => window.conductor.remote.detach(id), machineId)
  await expect.poll(async () => (await controller.page.evaluate(() => window.conductor.remote.machines())).find(machine => machine.id === machineId)?.connection?.state,
    { timeout: 20000 }).toBe('detached')
  const refused = await controller.page.evaluate(id => window.conductor.remote.files.list({ ...id, path: '.' })
    .then(value => ({ ok: true, value }), reason => ({ ok: false, message: String(reason?.message ?? reason) })), identity)
  assert.equal(refused.ok, false, 'a detached machine still answered a file listing')
  assert.match(refused.message, /independently/, `the refusal did not say why: ${refused.message}`)
  const detachedState = await controller.page.evaluate(() => window.conductor.remote.state())
  assert.equal(detachedState.connections[0].detached, true, 'the connection was not remembered as detached')
  check('detaching refused every remote call with a message that names the reason, and the connection is marked detached')

  await close(controller)
  controller = await launch('controller')
  const afterDetachRestart = (await controller.page.evaluate(() => window.conductor.remote.machines())).find(machine => machine.id === machineId)
  assert.equal(afterDetachRestart?.connection?.state, 'detached', 'a restarted controller did not come back standalone')
  const detachedDiagnostics = await controller.page.evaluate(id => window.conductor.remote.diagnostics(id), machineId)
  assert.equal(detachedDiagnostics.stream.open, false, 'a detached controller dialled the host anyway')
  check('the restarted controller came back standalone and dialled nothing')

  await controller.page.evaluate(id => window.conductor.remote.attach(id), machineId)
  await expect.poll(async () => (await controller.page.evaluate(() => window.conductor.remote.machines())).find(machine => machine.id === machineId)?.connection?.state,
    { timeout: 40000 }).toBe('connected')
  const relisted = await controller.page.evaluate(id => window.conductor.remote.files.list({ ...id, path: '.' }), identity)
  assert.ok(relisted.some(entry => entry.name === 'hello.txt'), 'attaching again did not restore the remote file listing')
  check('attaching again is what brings the host back, and files work immediately after it')

  // ---- 14 (taken here, while the pairing is healthy). -------------------------------------------
  await watchRuntime(controller.page)
  // Wider, so the panel is not clipped in the capture. The window keeps the exact x/y it was parked
  // at - 6000px off every display, per AGENTS.md - because only its size is changed.
  note('captureBounds', await controller.app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return null
    const [x, y] = window.getPosition()
    window.setBounds({ x, y, width: 1600, height: 1000 })
    return window.getBounds()
  }))
  await controller.page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:projects-changed')))
  const panel = await openAccountAndMachines(controller.page)
  await panel.getByRole('button', { name: 'Diagnostics' }).first().click().catch(() => undefined)
  await controller.page.locator('.remote-standalone-trigger').first().waitFor({ state: 'visible', timeout: 15000 })
  // The drawer is a fixed 430px whatever the window is; at the default 110% zoom its diagnostics
  // values and the standalone button label run past that width. Capture at the smallest zoom the
  // app offers so the artifact shows the whole control rather than a cropped one.
  await controller.page.evaluate(() => window.conductor.settings.setZoom(0.8))
  await panel.scrollIntoViewIfNeeded()
  // The drawer is a fixed 430px, so an element capture of the peer block alone crops the long
  // labels. The window capture is the one that reads as what the owner actually sees.
  const windowShot = await screenshot(controller.page, 'controller-window-account-and-machines.png')
  // Deliberately the whole window rather than a crop of the drawer: cropping inside this fixed
  // overlay returns an empty image on a parked window, and an empty screenshot reads as evidence
  // when it is the opposite. The window capture shows the panel, the sidebar and the title bar at
  // once, which is what the owner is actually looking at.
  await controller.page.locator('.remote-peer-block').first().waitFor({ state: 'visible', timeout: 15000 })
  await controller.page.waitForTimeout(500)
  await closeSettings(controller.page)
  const badge = controller.page.locator('.project-remote-badge').first()
  await badge.waitFor({ state: 'visible', timeout: 15000 })
  await controller.page.waitForTimeout(500)
  assert.match((await badge.textContent()) ?? '', /^Remote: /, 'the sidebar does not show the remote project badge')
  const sidebarShot = await screenshot(controller.page.locator('.projects-section').first(), 'controller-sidebar-remote-badge.png')
  note('screenshots', { windowShot, sidebarShot })
  check('the Account & machines panel shows the paired host, its connection state and the standalone control, and the sidebar shows the Remote: badge')

  // Detaching released the terminal view (not the shell). Bind to the same host shell again so the
  // write after revocation has somewhere real to go.
  const survived = await controller.page.evaluate(({ id, projectId, sessionId }) =>
    window.conductor.remote.terminals.list({ machineId: id, projectId, sessionId }), { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId })
  assert.equal(survived.length, 1, `the host shell did not survive detach and attach: ${JSON.stringify(survived)}`)
  binding = await controller.page.evaluate(({ id, projectId, sessionId, remoteTerminalId }) =>
    window.conductor.remote.terminals.attach({ machineId: id, projectId, sessionId, remoteTerminalId }),
    { id: machineId, projectId: remoteProject.id, sessionId: controllerSessionId, remoteTerminalId: survived[0].terminalId })
  await controller.page.evaluate(({ id, projectId, sessionId, cwd }) =>
    window.conductor.terminals.ensure({ id, projectId, sessionId, title: 'smoke', cwd }),
    { id: binding.localTerminalId, projectId: remoteProject.id, sessionId: controllerSessionId, cwd: remoteProject.path })
  await type(controller.page, binding.localTerminalId, 'Write-Host ("MARK" + "ER-3")')
  await awaitTerminal(controller.page, binding.localTerminalId, 'MARKER-3')

  // ---- 12. revocation --------------------------------------------------------------------------
  await host.page.evaluate(id => window.conductor.remote.revoke(id), peerId)
  const afterRevoke = await controller.page.evaluate(id => window.conductor.remote.files.list({ ...id, path: '.' })
    .then(value => ({ ok: true, value }), reason => ({ ok: false, message: String(reason?.message ?? reason) })), identity)
  assert.equal(afterRevoke.ok, false, `a revoked machine still listed the host filesystem: ${JSON.stringify(afterRevoke.value)}`)
  await expect.poll(() => controller.page.evaluate(id => window.conductor.remote.diagnostics(id).then(report => report.stream.open), machineId),
    { timeout: 8000, intervals: [200, 250] }).toBe(false)
  await type(controller.page, binding.localTerminalId, 'Set-Content -Path after-revoke.txt -Value reached')
  await new Promise(done => setTimeout(done, 3000))
  assert.equal(existsSync(join(hostProject.path, 'after-revoke.txt')), false, 'a keystroke sent after revocation reached the host shell')
  const revokedText = visible(await terminalText(controller.page, binding.localTerminalId))
  assert.ok(revokedText.includes(visible('keystrokes were not sent')), 'the controller did not say the keystrokes were dropped')
  const revokedProcesses = await host.page.evaluate(id => window.conductor.agents.listProcesses(id), hostProject.id)
  const stillRunning = revokedProcesses.filter(entry => entry.kind === 'terminal' && entry.status !== 'exited')
  assert.deepEqual(stillRunning, [], `revocation left a shell running on the host: ${JSON.stringify(revokedProcesses)}`)
  note('revocation', { hostProcesses: revokedProcesses.map(entry => ({ kind: entry.kind, status: entry.status })), refusal: afterRevoke.message })
  check('revoking closed the stream, refused every later call, dropped the keystrokes rather than delivering them, and stopped the shell it had started on the host')

  // ---- 13. an unpaired device at the door --------------------------------------------------------
  stranger = await launch('stranger')
  await signIn(stranger.page)
  const strangerMachines = await stranger.page.evaluate(() => window.conductor.remote.machines())
  assert.deepEqual(strangerMachines.filter(machine => machine.kind === 'peer'), [], 'the stranger instance is paired with something')
  const denied = await rawCall(hostEndpoint, '/remote/call', { method: 'projects.list', args: {} })
  assert.ok(denied.status >= 400 && denied.status < 500, `an unpaired caller got ${denied.status} from the host, not a refusal`)
  assert.equal(denied.body.includes('MultiDeviceHost'), false, `the refusal leaked a project listing: ${denied.body}`)
  note('unpairedCaller', denied)
  check(`an unpaired device signed into the same account is refused at the host's own endpoint (HTTP ${denied.status}), with no listing`)
} catch (error) {
  results.failures.push(String(error?.stack ?? error))
} finally {
  for (const entry of [...launched]) {
    try { await cleanupFixtureApp(entry.app, results, `${entry.name} cleanup`) }
    catch (error) { results.failures.push(String(error?.stack ?? error)) }
  }
  results.finishedAt = new Date().toISOString()
  results.passed = results.failures.length === 0
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n')
}

if (results.failures.length) {
  throw results.failures.length === 1
    ? new Error(results.failures[0])
    : new AggregateError(results.failures.map(detail => new Error(detail)), 'Multi-device smoke failed')
}
console.log(`\n${results.checks.length} checks passed`)
