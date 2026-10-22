import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'
import { launcherTile } from './lib/launcher-tile.mjs'

/**
 * feature-list 21233d3f: a project that lives on MAIN shows, on the laptop, the tabs MAIN is
 * actually running - and the files they deliver open on the laptop.
 *
 * Two real Conductor instances on loopback with the offline GitHub stand-in: 'host' plays MAIN,
 * 'controller' plays the laptop. The only synthetic part is the Claude provider (fake-claude, no
 * inference). Windows are parked; the default app is never launched (the automation profile records
 * the path instead). What it proves:
 *  - the laptop launcher lists MAIN's conversations by MAIN's workspace, and "Open all" mirrors them
 *    as tabs here with their history;
 *  - a prompt typed on the laptop reaches the conversation on MAIN;
 *  - a PDF a MAIN conversation delivered opens on the laptop as a cached copy with the same bytes;
 *  - closing the laptop tab only stops watching: MAIN keeps its tab;
 *  - a project renamed on MAIN keeps working from the laptop (no "moved since it was shared").
 *
 * Run after a build, one smoke at a time:
 *   node scripts/smoke-lock.mjs -- node scripts/smoke-remote-workspace-tabs.mjs
 * CONDUCTOR_SMOKE_MAIN points it at another build's out/main/index.js.
 */
const root = await mkdtemp(join(tmpdir(), 'conductor-remote-workspace-tabs-'))
const output = resolve('.conductor-scratch/remote-workspace-tabs')
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

/** Opens a Claude tab on the host the way the owner does, sends one prompt, and returns its session id. */
const hostConversation = async (page, prompt, newTab) => {
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
  await enableRemote(controller.page, 'Laptop')
  const hostProject = await host.page.evaluate(() => window.conductor.projects.create('Untitled project 9'))
  const ticket = await host.page.evaluate(() => window.conductor.remote.createTicket())
  const connecting = controller.page.evaluate(encoded => window.conductor.remote.connect(encoded), ticket.encoded)
  await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending.length)), { timeout: 40000 }).toBe(1)
  const pending = await host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending[0]))
  await host.page.evaluate(({ id, projectId }) => window.conductor.remote.approve(id, [projectId]), { id: pending.id, projectId: hostProject.id })
  await connecting
  // This smoke covers opening MAIN's tabs by hand, so MAIN's "Mirror everything" is switched off
  // (smoke-laptop-full-mirror covers it on).
  const pairedPeer = (await host.page.evaluate(() => window.conductor.remote.state())).peers.find(entry => !entry.revokedAt)
  await host.page.evaluate(id => window.conductor.remote.setPeerMirror(id, false), pairedPeer.id)
  const machineId = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0].machineId
  check('MAIN and the laptop are paired over loopback with one shared project')

  // ---- the owner renames the project on MAIN itself, as happened to haf-stuff ------------------
  const renamed = await host.page.evaluate(id => window.conductor.projects.rename(id, 'haf-stuff'), hostProject.id)
  assert.ok(renamed.path.endsWith('haf-stuff'), `the host rename did not move the folder: ${renamed.path}`)
  const hostPath = renamed.path

  // ---- MAIN runs two conversations; one of them delivers a PDF ---------------------------------
  const pdf = join(hostPath, 'output', 'HAF logo.pdf')
  await mkdir(join(hostPath, 'output'), { recursive: true })
  const pdfBytes = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
  await writeFile(pdf, pdfBytes)
  await host.page.reload()
  await host.page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  hostSessions.push(await hostConversation(host.page, 'SYNTHETIC DELIVERED ' + pdf.replaceAll('\\', '/'), false))
  hostSessions.push(await hostConversation(host.page, 'SYNTHETIC LINKS from MAIN', true))
  check('MAIN runs two Claude conversations in the renamed project, one of which delivered a PDF')

  // ---- the laptop: the remote project lists MAIN's tabs -----------------------------------------
  // The laptop picks the rename up the next time it reads MAIN's projects; ask now rather than
  // wait out the probe timer.
  await expect.poll(async () => {
    await controller.page.evaluate(id => window.conductor.remote.remoteProjects(id), machineId).catch(() => [])
    return (await controller.page.evaluate(() => window.conductor.projects.list()))
      .find(project => project.remote?.machineId && project.remote.remoteProjectId === hostProject.id)?.name
  }, { timeout: 60000, intervals: [1000, 2000, 5000] }).toBe('haf-stuff')
  const remoteProject = (await controller.page.evaluate(() => window.conductor.projects.list()))
    .find(project => project.remote?.remoteProjectId === hostProject.id)
  const tasks = await controller.page.evaluate(id => window.conductor.projectTasks.get(id).then(() => 'ok', error => String(error?.message ?? error)), remoteProject.id)
  assert.equal(tasks, 'ok', `Project tasks for the renamed project failed from the laptop: ${tasks}`)
  check('a project renamed on MAIN is still served to the laptop (Project tasks load; no "moved since it was shared")')

  await controller.page.reload()
  await controller.page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  const list = controller.page.locator('.launcher-remote-conversations')
  await expect(list).toContainText('Tabs running on MAIN', { timeout: 30000 })
  await expect(list.locator('.launcher-attach-list li')).toHaveCount(2)
  await controller.page.screenshot({ path: join(output, '1-launcher-lists-main-tabs.png') })
  check('the laptop launcher lists the two conversations MAIN is running, under MAIN\'s workspace')

  await list.getByRole('button', { name: 'Open all 2', exact: true }).click()
  const mirroredTabs = controller.page.locator('.pane-tab').filter({ hasText: '· MAIN' })
  await expect(mirroredTabs).toHaveCount(2, { timeout: 20000 })
  const pane = controller.page.locator('.structured-agent-pane:visible').last()
  const localId = await pane.getAttribute('data-structured-session')
  await expect(pane).toContainText(/synthetic links from main/i, { timeout: 30000 })
  check('"Open all 2" mirrored both MAIN conversations into tabs here, history included')

  // A second "Open all" has nothing left to open.
  await controller.page.locator('.pane-add-tab').first().click()
  await expect(controller.page.locator('.launcher-remote-conversations .launcher-attach-list li')).toHaveCount(2, { timeout: 20000 })
  await expect(controller.page.locator('.launcher-remote-conversations').getByRole('button', { name: /^Open all/ })).toHaveCount(0)
  await expect(controller.page.locator('.launcher-remote-conversations')).toContainText('open here')
  check('conversations already mirrored are marked "open here" and left out of Open all')

  // ---- the PDF a MAIN conversation delivered opens on the laptop -------------------------------
  // A settled conversation folds into the workspace's Done group, so it is reached the way the owner
  // would from here: its row in the launcher selects the tab already showing it.
  await controller.page.locator('.launcher-remote-conversations .launcher-attach-list button').filter({ hasText: 'SYNTHETIC DELIVERED' }).click()
  const deliveredPane = controller.page.locator('.structured-agent-pane:visible').last()
  await expect(deliveredPane).toContainText('The logo is done', { timeout: 30000 })
  await deliveredPane.getByRole('button', { name: 'Links and files', exact: true }).click()
  const rail = controller.page.locator('.sa-links-rail')
  await expect(rail).toBeVisible()
  const open = rail.getByRole('button', { name: 'Open HAF logo.pdf', exact: true }).first()
  await expect(open).toHaveAttribute('title', 'Open a copy with the default app')
  await open.click()
  await expect.poll(() => controller.app.evaluate(() => (globalThis.__conductorRemoteOpened ?? []).length), { timeout: 20000 }).toBe(1)
  const copy = (await controller.app.evaluate(() => globalThis.__conductorRemoteOpened))[0]
  assert.ok(copy.replaceAll('\\', '/').includes('/remote-open/'), `the copy is not in the remote-open cache: ${copy}`)
  assert.ok(copy.endsWith('HAF logo.pdf'), copy)
  assert.equal(readFileSync(copy, 'utf8'), pdfBytes, 'the laptop copy does not hold the bytes MAIN delivered')
  await expect(rail.locator('.sa-links-error')).toHaveCount(0)
  await controller.page.screenshot({ path: join(output, '2-delivered-pdf-opened.png') })
  check('the PDF a MAIN conversation delivered opened on the laptop as a cached copy with the same bytes')

  // ---- typing on the laptop reaches the conversation on MAIN -----------------------------------
  const deliveredLocalId = await deliveredPane.getAttribute('data-structured-session')
  const before = (await snapshot(host.page, hostSessions[0])).items.length
  const composer = deliveredPane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('SYNTHETIC LINKS from the laptop')
  await deliveredPane.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => JSON.stringify((await snapshot(host.page, hostSessions[0])).items.slice(before)), { timeout: 30000 }).toContain('from the laptop')
  await settle(host.page, hostSessions[0])
  check('a prompt typed in the mirrored tab on the laptop ran in the conversation on MAIN')

  // ---- closing the laptop tab leaves MAIN's tab alone ------------------------------------------
  // The mirror settles after the host does; closing a tab that still reads as working would ask first.
  await settle(controller.page, deliveredLocalId)
  const hostTabsBefore = await host.page.locator('.pane-tab[data-control-agent-id]').count()
  await controller.page.locator(`.pane-tab[data-control-agent-id="${deliveredLocalId}"]`).locator('.tab-close').click()
  await expect(controller.page.locator(`.pane-tab[data-control-agent-id="${deliveredLocalId}"]`)).toHaveCount(0)
  await new Promise(done => setTimeout(done, 1500))
  const listing = await controller.page.evaluate(id => window.conductor.remote.workspaceTabs(id), remoteProject.id)
  const still = listing.workspaces.flatMap(workspace => workspace.tabs).find(entry => entry.agentSessionId === hostSessions[0])
  assert.ok(still, 'closing the laptop tab closed the conversation on MAIN')
  assert.equal(still.localSessionId, undefined, 'the closed laptop tab still mirrors the conversation')
  assert.equal(await host.page.locator('.pane-tab[data-control-agent-id]').count(), hostTabsBefore)
  check('closing the mirrored tab on the laptop only stopped watching; MAIN kept its tab')

  assert.ok(localId)
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
    : new AggregateError(results.failures.map(detail => new Error(detail)), 'Remote workspace tabs smoke failed')
}
console.log(`\n${results.checks.length} checks passed`)
