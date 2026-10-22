import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'
import { launcherTile } from './lib/launcher-tile.mjs'

/**
 * feature-list laptop-full-mirror: the paired laptop is a full mirror of MAIN.
 *
 * Two real Conductor instances on loopback with the offline GitHub stand-in: 'host' plays MAIN,
 * 'controller' plays the laptop. Only the Claude provider is synthetic (fake-claude, no inference).
 * Windows are parked. What it proves:
 *  - a MAIN project the owner never ticked when pairing reaches the laptop by itself (mirror everything);
 *  - every conversation MAIN is running appears on the laptop as a tab, in a workspace named like
 *    MAIN's, labelled MAIN, with its history, without anyone pressing Open;
 *  - a prompt typed in such a tab on the laptop runs in the conversation on MAIN;
 *  - a conversation MAIN opens later appears on the laptop by itself;
 *  - the laptop's own tabs run beside them, unlabelled (this computer);
 *  - MAIN's machines list names the laptop as controlling it and MAIN's real GitHub login;
 *  - with "Mirror everything" switched off on MAIN, the laptop launcher says why and what to click.
 *
 * Run after a build, one smoke at a time:
 *   node scripts/smoke-lock.mjs -- node scripts/smoke-laptop-full-mirror.mjs
 * CONDUCTOR_SMOKE_MAIN points it at another build's out/main/index.js.
 */
const root = await mkdtemp(join(tmpdir(), 'conductor-laptop-full-mirror-'))
const output = resolve('.conductor-scratch/laptop-full-mirror')
await mkdir(output, { recursive: true })
const sharedGitHubState = join(root, 'github-state.json')
await writeFile(sharedGitHubState, JSON.stringify({ keys: [], gists: [] }))

const results = { startedAt: new Date().toISOString(), checks: [], failures: [], inference: 'none' }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }
const launched = []
const busy = ['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting']

const launch = async name => {
  const env = {
    ...process.env,
    CONDUCTOR_BACKGROUND_WINDOWS: '1',
    CONDUCTOR_OFFLINE_TESTS: '1',
    CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
    CONDUCTOR_TEST_USER_DATA: join(root, name + '-profile'),
    CONDUCTOR_PROJECTS_ROOT: join(root, name + '-projects'),
    CONDUCTOR_TEST_REMOTE_GITHUB: '1',
    CONDUCTOR_TEST_REMOTE_GITHUB_STATE: sharedGitHubState
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CONDUCTOR_LIVE_TESTS
  delete env.CONDUCTOR_GITHUB_CLIENT_ID
  const app = await electron.launch({ args: [process.env.CONDUCTOR_SMOKE_MAIN ?? resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
  await page.waitForFunction(() => Boolean(window.conductor?.remote))
  const instance = { app, page, name, errors }
  launched.push(instance)
  return instance
}

const signIn = async page => {
  await page.evaluate(() => window.conductor.remote.signIn())
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState()), { timeout: 15000 }).toMatchObject({ phase: 'signed-in' })
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState().then(state => state.deviceKeyFingerprint)), { timeout: 15000 }).not.toBeNull()
}

const enableRemote = async (page, machineName) => {
  await page.evaluate(name => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, relay: false, machineName: name }), machineName)
  await expect.poll(() => page.evaluate(() => window.conductor.remote.state().then(state => state.listening)), { timeout: 30000 }).toBe(true)
}

const snapshot = (page, id) => page.evaluate(id => window.conductor.structured.snapshot(id), id)
const settle = async (page, id) => expect.poll(async () => (await snapshot(page, id))?.phase, { timeout: 30000 }).toBe('completed')

/** Opens a Claude tab the way the owner does, sends one prompt, and returns its session id. */
const conversation = async (page, prompt, newTab) => {
  if (newTab) await page.locator('.pane-add-tab').first().click()
  await launcherTile(page, 'Claude').click()
  const pane = page.locator('.structured-agent-pane:visible').last()
  const composer = pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill(prompt)
  await pane.getByRole('button', { name: 'Send message', exact: true }).click()
  const id = await pane.getAttribute('data-structured-session')
  await settle(page, id)
  return id
}

let host, controller
const hostSessions = []
try {
  host = await launch('host')
  controller = await launch('controller')
  await signIn(host.page)
  await signIn(controller.page)
  await enableRemote(host.page, 'MAIN')
  await enableRemote(controller.page, 'Lap')
  const ticked = await host.page.evaluate(() => window.conductor.projects.create('haf-stuff'))
  // A project that already existed when pairing and that the owner did not tick.
  const unticked = await host.page.evaluate(() => window.conductor.projects.create('videos'))
  const ticket = await host.page.evaluate(() => window.conductor.remote.createTicket())
  const connecting = controller.page.evaluate(encoded => window.conductor.remote.connect(encoded), ticket.encoded)
  await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending.length)), { timeout: 40000 }).toBe(1)
  const pending = await host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending[0]))
  // What the approval itself granted; mirroring then shares the rest as soon as the laptop connects.
  const approved = await host.page.evaluate(({ id, projectId }) => window.conductor.remote.approve(id, [projectId]), { id: pending.id, projectId: ticked.id })
  await connecting
  const machineId = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0].machineId
  const granted = approved.peers.find(entry => !entry.revokedAt).grantedProjects.map(entry => entry.projectId)
  assert.deepEqual(granted, [ticked.id], 'pairing should have shared only the ticked project')
  check('MAIN and the laptop are paired over loopback; only haf-stuff was ticked')

  // ---- MAIN runs conversations in both projects ------------------------------------------------
  await host.page.reload()
  await host.page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  hostSessions.push(await conversation(host.page, 'SYNTHETIC LINKS from MAIN haf', false))
  await host.page.locator('.project-row').filter({ hasText: 'videos' }).click()
  hostSessions.push(await conversation(host.page, 'SYNTHETIC LINKS from MAIN videos', false))
  check('MAIN runs a Claude conversation in each project')

  // ---- the laptop: both projects and both conversations arrive by themselves -------------------
  const remoteProjects = async () => {
    await controller.page.evaluate(id => window.conductor.remote.remoteProjects(id), machineId).catch(() => [])
    return (await controller.page.evaluate(() => window.conductor.projects.list())).filter(project => project.remote?.machineId).map(project => project.name).sort()
  }
  await expect.poll(remoteProjects, { timeout: 60000, intervals: [1000, 2000, 5000] }).toEqual(['haf-stuff', 'videos'])
  check('the project the owner never ticked (videos) reached the laptop by itself')
  // Read in the background after each probe of MAIN's projects.
  await expect.poll(async () => {
    await controller.page.evaluate(id => window.conductor.remote.remoteProjects(id), machineId).catch(() => [])
    return controller.page.evaluate(id => window.conductor.remote.state().then(state => JSON.stringify(state.hostMirrors?.[id] ?? 'unknown')), machineId)
  }, { timeout: 30000, intervals: [500, 1000, 2000] }).toContain('"mirror":true')

  /**
   * The MAIN-labelled conversation tabs in a laptop project's open workspaces, read from the saved
   * layouts. The strip is not the place to count them: a finished tab nobody has looked at yet
   * leaves the strip for the sidebar's Done group (workspace clarity), and whether a mirrored
   * conversation has already been pulled as finished depends only on how busy the machine is.
   */
  const mirroredTabs = async name => controller.page.evaluate(async name => {
    const project = (await window.conductor.projects.list()).find(entry => entry.remote?.machineId && entry.name === name)
    if (!project) return []
    const collect = node => node.type === 'group' ? node.tabs : node.children.flatMap(collect)
    return (await window.conductor.sessions.list(project.id)).flatMap(session => collect(session.layout.root))
      .filter(tab => tab.kind === 'agent' && tab.state?.machineName === 'MAIN').map(tab => tab.title)
  }, name)
  await controller.page.reload()
  for (const [name, prompt] of [['haf-stuff', 'synthetic links from main haf'], ['videos', 'synthetic links from main videos']]) {
    await controller.page.locator('.project-row').filter({ hasText: name }).click()
    await expect.poll(() => mirroredTabs(name), { timeout: 45000 }).toEqual([expect.stringMatching(new RegExp(prompt, 'i'))])
    // Reached the way the owner would: its launcher row ("open here") selects the tab already
    // showing it, which then shows in the strip with its MAIN label and MAIN's history.
    const row = controller.page.locator('.launcher-remote-conversations .launcher-attach-list button').filter({ hasText: new RegExp(prompt, 'i') })
    await expect(row).toContainText('open here', { timeout: 20000 })
    await row.click()
    await expect(controller.page.locator('.pane-tab.active .pane-tab-machine')).toHaveText('MAIN')
    const pane = controller.page.locator('.structured-agent-pane:visible').last()
    await expect(pane).toContainText(new RegExp(prompt, 'i'), { timeout: 30000 })
  }
  await controller.page.screenshot({ path: join(output, '1-main-conversations-mirrored.png') })
  check('every MAIN conversation shows on the laptop as a tab labelled MAIN, with its history, without pressing Open')

  // ---- typing on the laptop reaches MAIN --------------------------------------------------------
  const videosPane = controller.page.locator('.structured-agent-pane:visible').last()
  const before = (await snapshot(host.page, hostSessions[1])).items.length
  const composer = videosPane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('SYNTHETIC LINKS from the laptop')
  await videosPane.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => JSON.stringify((await snapshot(host.page, hostSessions[1])).items.slice(before)), { timeout: 30000 }).toContain('from the laptop')
  await settle(host.page, hostSessions[1])
  check('a prompt typed in a mirrored tab on the laptop ran in the conversation on MAIN')

  // ---- a conversation MAIN opens later appears by itself ----------------------------------------
  await host.page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  hostSessions.push(await conversation(host.page, 'SYNTHETIC LINKS second from MAIN', true))
  await controller.page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  await expect.poll(async () => {
    await controller.page.evaluate(id => window.conductor.remote.remoteProjects(id), machineId).catch(() => [])
    return (await mirroredTabs('haf-stuff')).length
  }, { timeout: 60000, intervals: [1000, 2000, 5000] }).toBe(2)
  await controller.page.locator('.pane-add-tab').first().click()
  await expect(controller.page.locator('.launcher-remote-conversations:visible .launcher-attach-list button').filter({ hasText: /second from MAIN/i }).last()).toContainText('open here', { timeout: 20000 })
  check('a conversation MAIN opened later appeared on the laptop by itself')

  // ---- the laptop's own tabs beside them --------------------------------------------------------
  await controller.page.evaluate(() => window.conductor.projects.create('laptop notes'))
  await controller.page.reload()
  await controller.page.locator('.project-row').filter({ hasText: 'laptop notes' }).click()
  const own = await conversation(controller.page, 'SYNTHETIC LINKS on the laptop itself', false)
  assert.equal((await snapshot(controller.page, own)).phase, 'completed')
  await expect(controller.page.locator('.pane-tab-machine')).toHaveCount(0)
  const projects = (await controller.page.evaluate(() => window.conductor.projects.list())).map(project => project.name).sort()
  assert.deepEqual(projects.filter(name => ['haf-stuff', 'laptop notes', 'videos'].includes(name)), ['haf-stuff', 'laptop notes', 'videos'])
  check('the laptop runs its own conversation in its own project beside MAIN\'s, with no machine label')

  // ---- MAIN's machines list names the laptop and the real login ---------------------------------
  const machines = await host.page.evaluate(() => window.conductor.remote.machines())
  const local = machines.find(machine => machine.kind === 'local')
  assert.ok(local.accountLogin, `MAIN's local row still reads as signed out: ${JSON.stringify(local)}`)
  assert.equal(local.controlledBy?.[0]?.machineName, 'Lap', JSON.stringify(local))
  assert.equal(local.controlledBy?.[0]?.connected, true, JSON.stringify(local))
  assert.ok(machines.every(machine => machine.name !== 'Lap' || machine.kind === 'local'), 'the laptop must not be a placement target on MAIN')
  check('MAIN\'s machines list carries its GitHub login and names Lap as controlling it (not as a placement target)')

  // ---- switched off on MAIN, the laptop says why and what to click -----------------------------
  const peer = (await host.page.evaluate(() => window.conductor.remote.state())).peers.find(entry => !entry.revokedAt)
  await host.page.evaluate(id => window.conductor.remote.setPeerMirror(id, false), peer.id)
  await expect.poll(async () => {
    await controller.page.evaluate(id => window.conductor.remote.remoteProjects(id), machineId).catch(() => [])
    return controller.page.evaluate(id => window.conductor.remote.state().then(state => state.hostMirrors?.[id]?.mirror), machineId)
  }, { timeout: 30000 }).toBe(false)
  await controller.page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  await controller.page.locator('.pane-add-tab').first().click()
  await expect(controller.page.locator('.launcher-mirror-off:visible').last()).toContainText('switch on “Mirror everything” for Lap', { timeout: 20000 })
  await controller.page.screenshot({ path: join(output, '2-mirror-off-line.png') })
  check('with mirroring switched off on MAIN, the laptop launcher says why and what to click')

  assert.ok(unticked.id)
  assert.deepEqual(controller.errors, [], `controller page errors: ${controller.errors.join('\n')}`)
  assert.deepEqual(host.errors, [], `host page errors: ${host.errors.join('\n')}`)
} catch (error) {
  results.failures.push(String(error?.stack ?? error))
  for (const entry of launched) await entry.page.screenshot({ path: join(output, `failure-${entry.name}.png`) }).catch(() => {})
} finally {
  if (host) for (const id of hostSessions) {
    const phase = (await snapshot(host.page, id).catch(() => null))?.phase
    if (busy.includes(phase)) await host.page.evaluate(id => window.conductor.structured.interrupt(id, false), id).catch(() => {})
  }
  // The laptop goes first: a host asks before quitting while a paired machine is still attached.
  for (const entry of [...launched].reverse()) {
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
    : new AggregateError(results.failures.map(detail => new Error(detail)), 'Laptop full mirror smoke failed')
}
console.log(`\n${results.checks.length} checks passed`)
