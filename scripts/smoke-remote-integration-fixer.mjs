import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// Real Electron/main/preload/renderer coverage with two modes:
//   default       two isolated app/service instances and deterministic GitHub/provider fixtures
//   --live-github the bundled public OAuth client ID against GitHub, without running a provider
// The Windows process-error-mode wrapper must launch this file; every window is parked off-screen.
const liveGitHub = process.argv.includes('--live-github')
const mediaFiles = process.argv.includes('--media-files')
const root = await mkdtemp(join(tmpdir(), liveGitHub ? 'conductor-github-live-' : 'conductor-remote-integration-'))
const output = resolve(liveGitHub ? 'artifacts/remote-github-live' : 'artifacts/remote-integration')
await mkdir(output, { recursive: true })
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
assert.equal(slot.status, 'granted', 'Electron smoke slot is not granted')
assert.equal(slot.agentSessionId, 'agent_mtybvpmw_fdnpyc5', 'Electron smoke slot belongs to another worker')
assert.equal(slot.script, 'scripts/smoke-remote-integration-fixer.mjs', 'Electron smoke slot names another script')
assert.ok(Number.isSafeInteger(slot.generation), 'Electron smoke slot has no generation')
const buildNumber = String(slot.reason ?? '').match(/Build\s*(\d+)/i)?.[1] ?? String(slot.build ?? 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '-')
const runLabel = `build${buildNumber}-generation${slot.generation}`

const results = { actualElectron: true, syntheticAccount: !liveGitHub, physicalSecondMachine: false, checks: [], failures: [] }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }
const safeError = error => String(error?.stack ?? error)
  .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
  .replace(/\bgh[orups]_[A-Za-z0-9_-]+\b/g, '[REDACTED GITHUB CREDENTIAL]')
const failureDetails = error => error instanceof AggregateError
  ? error.errors.flatMap(failureDetails)
  : [safeError(error)]
let diagnosticPage = null
let diagnosticStep = 'startup'
let failureCaptured = false
const step = label => { diagnosticStep = label }

const captureFailure = async error => {
  if (failureCaptured) return
  failureCaptured = true
  if (!diagnosticPage || diagnosticPage.isClosed()) return
  const screenshot = join(output, `failure-${runLabel}.png`)
  const artifact = join(output, `failure-${runLabel}.json`)
  await diagnosticPage.screenshot({ path: screenshot, fullPage: true }).catch(() => {})
  const candidates = diagnosticPage.locator('.structured-agent-pane:visible, .remote-files-pane:visible, .code-pane:visible, .remote-control-settings:visible')
  const scoped = await (await candidates.count() ? candidates.last() : diagnosticPage.locator('body')).evaluate(element => ({
    tag: element.tagName,
    className: element.className,
    text: element.textContent?.slice(0, 30_000) ?? '',
    links: [...element.querySelectorAll('a')].slice(0, 200).map(link => ({ text: link.textContent, href: link.getAttribute('href'), className: link.className })),
    buttons: [...element.querySelectorAll('button')].slice(0, 200).map(button => ({ text: button.textContent, ariaLabel: button.getAttribute('aria-label'), disabled: button.disabled })),
    machineId: element.getAttribute('data-machine-id') ?? element.getAttribute('data-file-machine')
  })).catch(() => null)
  const aria = await (await candidates.count() ? candidates.last() : diagnosticPage.locator('body')).ariaSnapshot({ timeout: 5000 }).catch(() => '')
  await writeFile(artifact, JSON.stringify({ step: diagnosticStep, error: safeError(error), title: await diagnosticPage.title().catch(() => ''), aria, scoped }, null, 2) + '\n', { flag: 'wx' }).catch(() => {})
}

const launch = async ({ name, fixture = false, sharedGitHubState, providerPromptCapture, providerStartCapture }) => {
  const env = {
    ...process.env,
    CONDUCTOR_BACKGROUND_WINDOWS: '1',
    CONDUCTOR_OFFLINE_TESTS: '1',
    CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_USER_DATA: join(root, name + '-profile'),
    CONDUCTOR_PROJECTS_ROOT: join(root, name + '-projects'),
    ...(providerPromptCapture ? { CONDUCTOR_TEST_CONTROL_CAPTURE: providerPromptCapture } : {}),
    ...(providerStartCapture ? { CONDUCTOR_TEST_PROVIDER_START_CAPTURE: providerStartCapture } : {}),
    ...(fixture ? {
      CONDUCTOR_TEST_REMOTE_GITHUB: '1',
      CONDUCTOR_TEST_REMOTE_GITHUB_STATE: sharedGitHubState
    } : {})
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CONDUCTOR_LIVE_TESTS
  // The live mode specifically proves the installed default. Do not inherit a developer override.
  delete env.CONDUCTOR_GITHUB_CLIENT_ID
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await page.waitForFunction(() => Boolean(window.conductor?.remote))
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__conductorSmokeExternalUrls = []
    globalThis.__conductorSmokeDownloadPath = null
    shell.openExternal = async url => { globalThis.__conductorSmokeExternalUrls.push(String(url)) }
    dialog.showSaveDialog = async () => {
      const filePath = globalThis.__conductorSmokeDownloadPath
      return filePath ? { canceled: false, filePath } : { canceled: true, filePath: '' }
    }
  })
  await page.evaluate(async () => {
    await window.conductor.settings.setZoom(1)
    await window.conductor.settings.setThemeAuto(false)
    await window.conductor.settings.setThemeVariant('night')
  })
  diagnosticPage = page
  return { app, page }
}

const signInFixture = async page => {
  const started = await page.evaluate(() => window.conductor.remote.signIn())
  assert.equal(started.phase, 'awaiting-authorization')
  assert.equal(started.prompt?.userCode, 'TEST-ONLY')
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState()), { timeout: 10000 })
    .toMatchObject({ phase: 'signed-in', identity: { id: 4242, login: 'offline-remote-fixture' } })
  await expect.poll(() => page.evaluate(() => window.conductor.remote.githubState().then(state => state.deviceKeyFingerprint)), { timeout: 10000 })
    .not.toBeNull()
  return page.evaluate(() => window.conductor.remote.githubState())
}

const assertNoRendererCredentials = state => {
  const forbidden = /^(?:access_?token|refresh_?token|device_?code|private_?key)$/i
  const visit = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, forbidden, `Renderer state exposed credential field ${key}`)
      visit(child)
    }
  }
  visit(state)
}

const fixtureKeys = async sharedGitHubState => {
  const state = JSON.parse(await readFile(sharedGitHubState, 'utf8'))
  return Array.isArray(state.keys) ? state.keys : []
}

const appControlCredentials = async capture => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The host provider did not receive its scoped app-control briefing')
  return { endpoint, token }
}

const appControlCall = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args })
  })
  const payload = await response.json()
  assert.equal(response.status, 200, `${method} was refused: ${JSON.stringify(payload?.error ?? {})}`)
  return payload.result
}

const readIdentity = async projectPath => {
  const file = join(projectPath, '.conductor', 'project.json')
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await readFile(file, 'utf8') } catch { await new Promise(resolveWait => setTimeout(resolveWait, 50)) }
  }
  throw new Error('Host project identity was not created')
}

const removePersistedTabMachine = (profile, workspaceId, resourceId) => {
  const db = new DatabaseSync(join(profile, 'conductor.db'))
  try {
    const row = db.prepare('SELECT layout_json FROM sessions WHERE id = ?').get(workspaceId)
    assert.ok(row?.layout_json, 'Remote workspace was not persisted in the disposable controller profile')
    const layout = JSON.parse(row.layout_json)
    let changed = 0
    const visit = node => {
      if (node.type === 'split') { node.children.forEach(visit); return }
      for (const tab of node.tabs) if (tab.resourceId === resourceId) {
        const { machineId: removed, ...state } = tab.state ?? {}
        assert.ok(removed, 'The exact remote tab had no persisted machine metadata to remove')
        tab.state = state
        changed++
      }
    }
    visit(layout.root)
    assert.equal(changed, 1, 'Expected exactly one persisted remote tab to become stale')
    const result = db.prepare('UPDATE sessions SET layout_json = ? WHERE id = ?').run(JSON.stringify(layout), workspaceId)
    assert.equal(result.changes, 1, 'The disposable remote workspace was not updated')
  } finally { db.close() }
}

const openProject = async (page, name) => {
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await expect(page.locator('.launcher-grid')).toBeVisible()
}

const stopRemoteConversation = async (page, sessionId) => {
  await page.evaluate(id => window.conductor.structured.interrupt(id, false), sessionId)
  const deadline = Date.now() + 10_000
  let phase
  do {
    phase = await page.evaluate(id => window.conductor.structured.snapshot(id).then(state => state.phase), sessionId)
    if (!['starting', 'running', 'waiting_input', 'waiting_approval', 'interrupting'].includes(phase)) return phase
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  } while (Date.now() < deadline)
  throw new Error(`Remote conversation ${sessionId} remained ${phase} after interrupt`)
}

const deterministicRemote = async () => {
  const sharedGitHubState = join(root, 'offline-github-account.json')
  const hostPromptCapture = join(root, 'host-provider-prompt.txt')
  const controllerPromptCapture = join(root, 'controller-provider-prompt.txt')
  const hostStartCapture = join(root, 'host-provider-start.txt')
  const controllerStartCapture = join(root, 'controller-provider-start.txt')
  await writeFile(sharedGitHubState, JSON.stringify({ keys: [] }))
  let host
  let controller
  let remoteSessionId = null
  let remoteAuthorityAvailable = false
  const pageErrors = []
  let originalFailure = null
  let cleanupFailure = null
  try {
    step('launch isolated host and controller')
    host = await launch({ name: 'host', fixture: true, sharedGitHubState, providerPromptCapture: hostPromptCapture, providerStartCapture: hostStartCapture })
    controller = await launch({ name: 'controller', fixture: true, sharedGitHubState, providerPromptCapture: controllerPromptCapture, providerStartCapture: controllerStartCapture })
    host.page.on('pageerror', error => pageErrors.push('host: ' + error.message))
    controller.page.on('pageerror', error => pageErrors.push('controller: ' + error.message))

    const hostProject = await host.page.evaluate(() => window.conductor.projects.create('Remote host project'))
    const localProject = await controller.page.evaluate(() => window.conductor.projects.create('Remote controller project'))
    await writeFile(join(hostProject.path, 'host-only.txt'), 'This file exists only in the host working copy.\n')
    await mkdir(join(hostProject.path, 'src'), { recursive: true })
    await mkdir(join(localProject.path, 'src'), { recursive: true })
    await mkdir(join(hostProject.path, 'renders'), { recursive: true })
    await mkdir(join(localProject.path, 'renders'), { recursive: true })
    await mkdir(join(hostProject.path, 'context'), { recursive: true })
    await mkdir(join(localProject.path, 'context'), { recursive: true })
    const hostRenderBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const controllerRenderBytes = Buffer.from('CONTROLLER DECOY IS NOT AN IMAGE')
    await writeFile(join(hostProject.path, 'src', 'file-1.ts'), 'export const owner = "HOST ORIGINAL BYTES"\n')
    await writeFile(join(localProject.path, 'src', 'file-1.ts'), 'export const owner = "CONTROLLER LOCAL BYTES"\n')
    await writeFile(join(hostProject.path, 'renders', 'frame.png'), hostRenderBytes)
    await writeFile(join(localProject.path, 'renders', 'frame.png'), controllerRenderBytes)
    await writeFile(join(hostProject.path, 'context', 'host-notes.txt'), 'HOST ATTACHMENT CONTEXT ONLY\n')
    await writeFile(join(localProject.path, 'context', 'host-notes.txt'), 'CONTROLLER ATTACHMENT DECOY\n')
    await writeFile(join(localProject.path, 'controller-only.txt'), 'This file must never appear in the remote tree.\n')
    await openProject(host.page, hostProject.name)
    await signInFixture(host.page)
    let hostState = await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true, exposure: 'loopback', port: 0, machineName: 'Host fixture' }))
    assert.equal(hostState.listening, true)
    assert.match(hostState.endpoint ?? '', /^https:\/\/127\.0\.0\.1:\d+$/)
    const fixedHostPort = Number(new URL(hostState.endpoint).port)
    hostState = await host.page.evaluate(port => window.conductor.remote.setSettings({ port }), fixedHostPort)
    assert.equal(new URL(hostState.endpoint).port, String(fixedHostPort))

    // The two disposable folders stand in for the same working copy on different machines.
    const identity = await readIdentity(hostProject.path)
    await mkdir(join(localProject.path, '.conductor'), { recursive: true })
    await writeFile(join(localProject.path, '.conductor', 'project.json'), identity)
    await openProject(controller.page, localProject.name)
    await signInFixture(controller.page)
    await controller.page.evaluate(() => window.conductor.remote.setSettings({ machineName: 'Controller fixture' }))
    const hostGitHubState = await host.page.evaluate(() => window.conductor.remote.githubState())
    const controllerGitHubState = await controller.page.evaluate(() => window.conductor.remote.githubState())
    assertNoRendererCredentials(hostGitHubState)
    assertNoRendererCredentials(controllerGitHubState)
    assert.equal((await fixtureKeys(sharedGitHubState)).length, 2)
    check('Two isolated app profiles sign in to one deterministic account and protect separate device keys')

    step('pair and grant the selected host project')
    const ticket = await host.page.evaluate(() => window.conductor.remote.createTicket())
    const connecting = controller.page.evaluate(encoded => window.conductor.remote.connect(encoded), ticket.encoded)
    const pending = await expect.poll(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending)), { timeout: 10000 })
      .toHaveLength(1).then(() => host.page.evaluate(() => window.conductor.remote.state().then(state => state.pending[0])))
    assert.equal(pending.accountId, 4242)
    await host.page.evaluate(({ id, projectId }) => window.conductor.remote.approve(id, [projectId]), { id: pending.id, projectId: hostProject.id })
    await connecting
    remoteAuthorityAvailable = true
    check('The host verifies the controller device key and grants only the selected project')

    const connection = (await controller.page.evaluate(() => window.conductor.remote.state())).connections[0]
    assert.ok(connection?.machineId)
    const advertised = await controller.page.evaluate(machineId => window.conductor.remote.remoteProjects(machineId), connection.machineId)
    assert.equal(advertised.length, 1)
    await controller.page.evaluate(({ machineId, localId, remoteId }) => window.conductor.remote.confirmProject(machineId, localId, remoteId), {
      machineId: connection.machineId, localId: localProject.id, remoteId: hostProject.id
    })
    const machines = await controller.page.evaluate(() => window.conductor.remote.machines())
    assert.equal(machines.find(machine => machine.id === connection.machineId)?.projects[0]?.grant.localProjectId, localProject.id)
    check('Both working-copy identities are explicitly confirmed before placement')

    step('place the remote agent on the selected machine')
    await openProject(controller.page, localProject.name)
    const chooser = controller.page.locator('#launcher-machine')
    await expect(chooser).toBeVisible()
    await chooser.selectOption(connection.machineId)
    await expect(chooser).toHaveValue(connection.machineId)
    await controller.page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
    await expect(controller.page.locator('.structured-agent-pane')).toBeVisible({ timeout: 20000 })
    await expect(controller.page.getByText('Codex · Host fixture', { exact: true }).first()).toBeVisible()
    const localSessionId = await controller.page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    assert.ok(localSessionId)
    remoteSessionId = localSessionId
    const placedTab = await expect.poll(() => controller.page.evaluate(async ({ projectId, resourceId }) => {
      const found = []
      const visit = node => node.type === 'split' ? node.children.forEach(visit) : node.tabs.forEach(tab => { if (tab.resourceId === resourceId) found.push(tab) })
      for (const workspace of await window.conductor.sessions.list(projectId)) visit(workspace.layout.root)
      return found[0] ?? null
    }, { projectId: localProject.id, resourceId: localSessionId })).not.toBeNull().then(() => controller.page.evaluate(async ({ projectId, resourceId }) => {
      const found = []
      const visit = node => node.type === 'split' ? node.children.forEach(visit) : node.tabs.forEach(tab => { if (tab.resourceId === resourceId) found.push(tab) })
      for (const workspace of await window.conductor.sessions.list(projectId)) visit(workspace.layout.root)
      return found[0]
    }, { projectId: localProject.id, resourceId: localSessionId }))
    assert.equal(placedTab.state?.machineId, connection.machineId)
    const localWorkspaceId = await controller.page.evaluate(async ({ projectId, tabId }) => {
      const contains = node => node.type === 'split' ? node.children.some(contains) : node.tabs.some(tab => tab.id === tabId)
      return (await window.conductor.sessions.list(projectId)).find(workspace => contains(workspace.layout.root))?.id ?? null
    }, { projectId: localProject.id, tabId: placedTab.id })
    assert.ok(localWorkspaceId)
    const controllerProfile = join(root, 'controller-profile')
    step('close controller before stale-layout restart')
    await cleanupFixtureApp(controller.app, results, 'controller stale-layout restart cleanup')
    controller = undefined
    step('remove stale layout machine metadata and relaunch')
    removePersistedTabMachine(controllerProfile, localWorkspaceId, localSessionId)
    controller = await launch({ name: 'controller', fixture: true, sharedGitHubState, providerPromptCapture: controllerPromptCapture, providerStartCapture: controllerStartCapture })
    controller.page.on('pageerror', error => pageErrors.push('controller-stale-restart: ' + error.message))
    await expect(controller.page.locator('.project-row').filter({ hasText: localProject.name })).toBeVisible()
    await controller.page.evaluate(({ projectId, workspaceId, tabId }) => window.conductor.agentControl.focusTab(projectId, workspaceId, tabId), {
      projectId: localProject.id, workspaceId: localWorkspaceId, tabId: placedTab.id
    })
    const staleRemotePane = controller.page.locator(`[data-structured-session="${localSessionId}"]`)
    await expect(staleRemotePane).toBeVisible()
    await expect(staleRemotePane).toHaveAttribute('data-file-machine', connection.machineId)
    const staleTab = await controller.page.evaluate(async ({ projectId, workspaceId, resourceId }) => {
      const workspace = (await window.conductor.sessions.list(projectId)).find(item => item.id === workspaceId)
      const tabs = []
      const visit = node => node.type === 'split' ? node.children.forEach(visit) : tabs.push(...node.tabs)
      visit(workspace.layout.root)
      return tabs.find(tab => tab.resourceId === resourceId)
    }, { projectId: localProject.id, workspaceId: localWorkspaceId, resourceId: localSessionId })
    assert.equal(staleTab.state?.machineId, undefined)
    await assert.rejects(readFile(hostStartCapture, 'utf8'), error => error?.code === 'ENOENT')
    await assert.rejects(readFile(controllerStartCapture, 'utf8'), error => error?.code === 'ENOENT')
    await controller.page.evaluate(id => window.conductor.structured.discover(id), localSessionId)
    await assert.rejects(readFile(controllerStartCapture, 'utf8'), error => error?.code === 'ENOENT')
    check('Durable remote ownership survives missing layout machine metadata; mounting and discovery never start a provider on the controller')

    step('submit and mirror the deterministic host response')
    const composer = controller.page.getByRole('textbox', { name: 'Message Codex', exact: true })
    await composer.fill('SYNTHETIC B remote integration fixture')
    await controller.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(controller.page.locator('.sa-timeline')).toContainText('Synthetic fixture continuation', { timeout: 20000 })
    await expect.poll(() => readFile(hostStartCapture, 'utf8').then(Boolean).catch(() => false)).toBe(true)
    assert.match(await readFile(hostPromptCapture, 'utf8'), /SYNTHETIC B remote integration fixture/)
    await assert.rejects(readFile(controllerPromptCapture, 'utf8'), error => error?.code === 'ENOENT')
    const beforeOffline = await controller.page.evaluate(id => window.conductor.structured.snapshot(id), localSessionId)
    assert.ok(beforeOffline.items.some(item => item.data?.type === 'text' && String(item.data.text).includes('Synthetic fixture continuation')))
    check('A deterministic provider response crosses the host and is durably mirrored into the controller history')

    step('open and guarded-save same-name host text from the remote transcript')
    await composer.fill('synthetic:perf-stream')
    await controller.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(controller.page.locator('.sa-timeline')).toContainText('Paragraph 1:', { timeout: 20000 })
    await controller.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => controller.page.evaluate(id => window.conductor.structured.snapshot(id).then(state => state.phase), localSessionId), { timeout: 10000 }).toBe('interrupted')
    const hostFileLink = controller.page.locator('.sa-timeline').getByRole('link', { name: 'src/file-1.ts', exact: true }).first()
    await expect(hostFileLink).toBeVisible({ timeout: 20000 })
    await hostFileLink.click()
    const remoteEditor = controller.page.locator('.workspace-files .code-pane').last()
    await expect(remoteEditor.locator('.code-toolbar')).toContainText(`Remote · ${connection.machineId}`)
    await expect(remoteEditor.locator('.view-lines')).toContainText('HOST ORIGINAL BYTES', { timeout: 20000 })
    await expect(remoteEditor.locator('.view-lines')).not.toContainText('CONTROLLER LOCAL BYTES')
    await remoteEditor.locator('.monaco-editor').click()
    await controller.page.keyboard.press('Control+A')
    await controller.page.keyboard.insertText('export const owner = "HOST GUARDED WRITE"\n')
    await remoteEditor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readFile(join(hostProject.path, 'src', 'file-1.ts'), 'utf8')).toBe('export const owner = "HOST GUARDED WRITE"\n')
    assert.equal(await readFile(join(localProject.path, 'src', 'file-1.ts'), 'utf8'), 'export const owner = "CONTROLLER LOCAL BYTES"\n')
    await controller.page.screenshot({ path: join(output, `remote-host-file-editor-${runLabel}.png`), fullPage: true })
    check('A remote conversation file link opens host-only bytes in a labelled machine-scoped editor and guarded save changes only the host')

    if (mediaFiles) {
      step('browse host-only remote file tree')
      // Keep the remote conversation mounted while the owner browses its host through the Explorer
      // side panel. This exercises the actual renderer bridge rather than reading through hostControl.
      await controller.page.evaluate(({ projectId, workspaceId, tabId }) => window.conductor.agentControl.focusTab(projectId, workspaceId, tabId), {
        projectId: localProject.id, workspaceId: localWorkspaceId, tabId: placedTab.id
      })
      await expect(staleRemotePane).toBeVisible()
      await composer.click()
      await controller.page.getByRole('button', { name: 'Explorer', exact: true }).click()
      const remoteTree = controller.page.locator('.remote-files-pane')
      await expect(remoteTree).toBeVisible()
      await expect(remoteTree).toContainText('Host fixture')
      await expect(remoteTree.getByRole('button', { name: 'host-only.txt', exact: true })).toBeVisible()
      await expect(remoteTree.getByRole('button', { name: 'controller-only.txt', exact: true })).toHaveCount(0)

      step('preview exact host image through loopback capability')
      await remoteTree.getByRole('button', { name: 'renders', exact: true }).click()
      await remoteTree.getByRole('button', { name: 'Preview frame.png', exact: true }).click()
      const remoteImage = remoteTree.locator('.remote-file-preview img')
      await expect(remoteImage).toBeVisible()
      const previewUrl = await remoteImage.getAttribute('src')
      assert.ok(previewUrl?.startsWith('http://127.0.0.1:'), 'Remote preview did not use an opaque loopback capability')
      assert.match(new URL(previewUrl).pathname, /^\/[a-f0-9]{64}$/)
      const previewResponse = await fetch(previewUrl)
      assert.equal(previewResponse.ok, true)
      const previewBytes = Buffer.from(await previewResponse.arrayBuffer())
      assert.deepEqual(previewBytes, hostRenderBytes)
      assert.notDeepEqual(previewBytes, controllerRenderBytes)
      await controller.page.screenshot({ path: join(output, `remote-files-preview-${runLabel}.png`), fullPage: true })

      step('download exact host image to owner-selected path')
      const downloadedRender = join(root, 'owner-selected-frame.png')
      await controller.app.evaluate((_electron, filePath) => { globalThis.__conductorSmokeDownloadPath = filePath }, downloadedRender)
      await remoteTree.getByRole('button', { name: 'Close preview', exact: true }).click()
      await remoteTree.getByRole('button', { name: 'Download frame.png', exact: true }).click()
      await expect.poll(() => readFile(downloadedRender).catch(() => null)).toEqual(hostRenderBytes)

      step('select host-only remote prompt attachment')
      await remoteTree.getByRole('button', { name: /Back/ }).click()
      await remoteTree.getByRole('button', { name: 'context', exact: true }).click()
      await remoteTree.getByRole('button', { name: 'Attach host-notes.txt to focused conversation', exact: true }).click()
      await expect(controller.page.locator('.sa-context-chips')).toContainText('host-notes.txt')
      step('dispatch host-validated remote prompt attachment')
      await composer.fill('SYNTHETIC B host attachment validation')
      await controller.page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => readFile(hostPromptCapture, 'utf8').catch(() => '')).toMatch(/HOST ATTACHMENT CONTEXT ONLY/)
      const attachedPrompt = await readFile(hostPromptCapture, 'utf8')
      assert.doesNotMatch(attachedPrompt, /CONTROLLER ATTACHMENT DECOY/)
      await expect.poll(() => controller.page.evaluate(id => window.conductor.structured.snapshot(id).then(state => state.phase), localSessionId), { timeout: 20000 }).toBe('completed')
      await assert.rejects(readFile(controllerPromptCapture, 'utf8'), error => error?.code === 'ENOENT')
      check('The owner browses a host-only tree, previews and downloads exact host media, and submits host-resolved attachment context without controller fallback')
    }

    step('verify host agent-control filespace and child machine inheritance')
    await assert.rejects(readFile(controllerStartCapture, 'utf8'), error => error?.code === 'ENOENT')
    const hostControl = await appControlCredentials(hostPromptCapture)
    const remoteFile = await appControlCall(hostControl, 'files.read', { path: 'host-only.txt' })
    assert.equal(remoteFile.content, 'This file exists only in the host working copy.\n')
    await assert.rejects(readFile(join(localProject.path, 'host-only.txt'), 'utf8'), error => error?.code === 'ENOENT')
    const hostSource = await host.page.evaluate(async projectId => {
      const tabs = []
      const visit = node => node.type === 'split' ? node.children.forEach(visit) : tabs.push(...node.tabs)
      for (const workspace of await window.conductor.sessions.list(projectId)) visit(workspace.layout.root)
      return tabs.find(tab => tab.kind === 'agent' && tab.state?.remotePeerId) ?? null
    }, hostProject.id)
    assert.ok(hostSource?.resourceId)
    const hostEvents = await host.page.evaluate(id => window.conductor.structured.events(id, 0), hostSource.resourceId)
    assert.ok(hostEvents.some(event => event.cwd === hostProject.path), 'The provider journal did not identify the host working copy')

    const child = await appControlCall(hostControl, 'tabs.open', {
      provider: 'codex', model: 'synthetic-model', title: 'Inherited host child', focus: false
    })
    assert.ok(child.resourceId)
    assert.equal(child.state?.machineId, 'local')
    await appControlCall(hostControl, 'agents.submit', { agentSessionId: child.resourceId, prompt: 'SYNTHETIC B inherited host child' })
    await expect.poll(() => appControlCall(hostControl, 'agents.snapshot', { agentSessionId: child.resourceId }).then(state => state.phase), { timeout: 20000 }).toBe('completed')
    assert.match(await readFile(hostPromptCapture, 'utf8'), /SYNTHETIC B inherited host child/)
    await assert.rejects(readFile(controllerStartCapture, 'utf8'), error => error?.code === 'ENOENT')
    check('The host agent-control scope reads the host project and its linked child inherits the host machine')

    step('verify offline remote history and fail-closed filespace')
    await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: false }))
    await remoteEditor.locator('.monaco-editor').click()
    await controller.page.keyboard.press('Control+A')
    await controller.page.keyboard.insertText('export const owner = "OFFLINE WRITE MUST FAIL"\n')
    await remoteEditor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(remoteEditor.locator('.code-save-error')).toBeVisible()
    assert.equal(await readFile(join(hostProject.path, 'src', 'file-1.ts'), 'utf8'), 'export const owner = "HOST GUARDED WRITE"\n')
    assert.equal(await readFile(join(localProject.path, 'src', 'file-1.ts'), 'utf8'), 'export const owner = "CONTROLLER LOCAL BYTES"\n')
    const offlineRead = await controller.page.evaluate(async ({ machineId, projectId }) => {
      try { await window.conductor.remote.files.read({ machineId, projectId, path: 'src/file-1.ts' }); return false } catch { return true }
    }, { machineId: connection.machineId, projectId: localProject.id })
    assert.equal(offlineRead, true)
    await remoteEditor.locator('.monaco-editor').click()
    await controller.page.keyboard.press('Control+A')
    await controller.page.keyboard.insertText('export const owner = "HOST GUARDED WRITE"\n')
    const failedHonestly = await controller.page.evaluate(async machineId => {
      try { await window.conductor.remote.remoteProjects(machineId); return false } catch { return true }
    }, connection.machineId)
    assert.equal(failedHonestly, true)
    await expect.poll(() => controller.page.evaluate(() => window.conductor.remote.machines()))
      .toContainEqual(expect.objectContaining({ id: connection.machineId, status: 'offline' }))

    await controller.page.getByRole('button', { name: 'New tab', exact: true }).click()
    await expect(controller.page.locator('#launcher-machine')).toHaveValue(connection.machineId)
    await expect(controller.page.locator('.launcher-placement small')).toContainText('Host fixture is offline.')
    await controller.page.evaluate(({ projectId, workspaceId, tabId }) => window.conductor.agentControl.focusTab(projectId, workspaceId, tabId), {
      projectId: localProject.id, workspaceId: localWorkspaceId, tabId: placedTab.id
    })
    await expect(controller.page.locator(`[data-structured-session="${localSessionId}"]`)).toBeVisible()
    await expect(controller.page.locator('.sa-timeline')).toContainText('Synthetic fixture continuation')
    check('When the host goes away, the machine is honestly offline while mirrored history remains readable and placement stays inherited')

    await controller.page.screenshot({ path: join(output, `remote-offline-history-${runLabel}.png`), fullPage: true })
    const restoredHost = await host.page.evaluate(() => window.conductor.remote.setSettings({ enabled: true }))
    assert.equal(restoredHost.listening, true)
    await expect.poll(() => controller.page.evaluate(async machineId => {
      try { await window.conductor.remote.remoteProjects(machineId); return true } catch { return false }
    }, connection.machineId), { timeout: 10000 }).toBe(true)
    await expect.poll(() => controller.page.evaluate(() => window.conductor.remote.machines()))
      .toContainEqual(expect.objectContaining({ id: connection.machineId, status: 'online' }))

    step('stop the remote conversation while pairing authority remains current')
    await stopRemoteConversation(controller.page, localSessionId)
    step('verify owner revocation defeats remote credentials')
    const revoked = await host.page.evaluate(peerId => window.conductor.remote.revoke(peerId), connection.peerId)
    remoteAuthorityAvailable = false
    assert.ok(revoked.peers.find(peer => peer.id === connection.peerId)?.revokedAt)
    const refusedAfterRevoke = await controller.page.evaluate(async machineId => {
      try { await window.conductor.remote.remoteProjects(machineId); return false } catch { return true }
    }, connection.machineId)
    assert.equal(refusedAfterRevoke, true)
    const revokedFileRead = await controller.page.evaluate(async ({ machineId, projectId }) => {
      try { await window.conductor.remote.files.read({ machineId, projectId, path: 'src/file-1.ts' }); return false } catch { return true }
    }, { machineId: connection.machineId, projectId: localProject.id })
    assert.equal(revokedFileRead, true)
    await expect.poll(() => controller.page.evaluate(() => window.conductor.remote.machines()))
      .toContainEqual(expect.objectContaining({ id: connection.machineId, status: 'revoked' }))
    check('Host revocation immediately defeats the controller credential and marks the machine revoked')

    step('verify released remote history survives restart without local execution')
    await controller.page.evaluate(id => window.conductor.remote.releaseTab(id), localSessionId)
    await controller.page.evaluate(machineId => window.conductor.remote.forget(machineId), connection.machineId)
    const controllerSignedOut = await controller.page.evaluate(() => window.conductor.remote.signOut())
    assert.equal(controllerSignedOut.phase, 'signed-out')
    assert.equal(controllerSignedOut.deviceKeyFingerprint, null)
    assertNoRendererCredentials(controllerSignedOut)
    assert.equal((await fixtureKeys(sharedGitHubState)).length, 1)
    step('close signed-out controller before read-only restart')
    await cleanupFixtureApp(controller.app, results, 'controller read-only restart cleanup')
    controller = await launch({ name: 'controller', fixture: true, sharedGitHubState, providerPromptCapture: controllerPromptCapture, providerStartCapture: controllerStartCapture })
    controller.page.on('pageerror', error => pageErrors.push('controller-restart: ' + error.message))
    await controller.page.reload()
    await controller.page.locator('.project-row').filter({ hasText: localProject.name }).click()
    await controller.page.evaluate(({ projectId, workspaceId, tabId }) => window.conductor.agentControl.focusTab(projectId, workspaceId, tabId), {
      projectId: localProject.id, workspaceId: localWorkspaceId, tabId: placedTab.id
    })
    await expect(controller.page.locator(`[data-structured-session="${localSessionId}"]`)).toBeVisible()
    await expect(controller.page.locator('.sa-timeline')).toContainText('Synthetic fixture continuation')
    const retainedRemoteEditor = controller.page.locator('.workspace-files .code-pane').last()
    await expect(retainedRemoteEditor.locator('.code-toolbar')).toContainText(`Remote · ${connection.machineId}`)
    await expect(retainedRemoteEditor.locator('.editor-blocked')).toContainText(/pairing is no longer active|not paired|Remote project access changed/i)
    await expect(retainedRemoteEditor).not.toContainText('CONTROLLER LOCAL BYTES')
    const rejectedDiscover = await controller.page.evaluate(async id => {
      try { await window.conductor.structured.discover(id); return { rejected: false, message: '' } }
      catch (error) { return { rejected: true, message: String(error) } }
    }, localSessionId)
    assert.equal(rejectedDiscover.rejected, true)
    assert.match(rejectedDiscover.message, /pairing is no longer active|saved history remains read-only/)
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
    await assert.rejects(readFile(controllerStartCapture, 'utf8'), error => error?.code === 'ENOENT')
    check('Release, forget, sign-out and app restart retain history read-only without starting a controller-local provider')

    step('sign out and remove isolated fixture device keys')
    const hostSignedOut = await host.page.evaluate(() => window.conductor.remote.signOut())
    assert.equal(hostSignedOut.phase, 'signed-out')
    assert.equal(hostSignedOut.deviceKeyFingerprint, null)
    assertNoRendererCredentials(hostSignedOut)
    assert.equal((await fixtureKeys(sharedGitHubState)).length, 0)
    check('Sign-out removes each isolated OS-vault authority and its own registered device key without exposing credentials')
    await controller.page.screenshot({ path: join(output, `remote-restart-read-only-${runLabel}.png`), fullPage: true })
    assert.deepEqual(pageErrors, [])
  } catch (error) {
    originalFailure = error
    await captureFailure(error)
  } finally {
    if (remoteAuthorityAvailable && controller && remoteSessionId) {
      try { await stopRemoteConversation(controller.page, remoteSessionId) }
      catch (error) { cleanupFailure = new Error('Could not stop the remote fixture conversation before sign-out: ' + safeError(error)) }
    }
    await controller?.page.evaluate(() => window.conductor.remote.signOut()).catch(() => {})
    await host?.page.evaluate(() => window.conductor.remote.signOut()).catch(() => {})
    const cleanupErrors = []
    for (const [launched, label] of [[host, 'host final cleanup'], [controller, 'controller final cleanup']]) {
      try { await cleanupFixtureApp(launched?.app, results, label) }
      catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupFailure) cleanupErrors.unshift(cleanupFailure)
    if (cleanupErrors.length === 1) cleanupFailure = cleanupErrors[0]
    else if (cleanupErrors.length > 1) cleanupFailure = new AggregateError(cleanupErrors, 'Multiple fixture cleanup steps failed')
  }
  const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
  if (failure) throw failure
}

const sshFingerprint = key => {
  const encoded = String(key).trim().split(/\s+/)[1]
  if (!encoded) return ''
  return 'SHA256:' + createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/, '')
}

const publicKeyFingerprints = async login => {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/keys?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Conductor-remote-integration-smoke' }
  })
  assert.equal(response.ok, true, `GitHub public-key lookup returned ${response.status}`)
  const keys = await response.json()
  return Array.isArray(keys) ? keys.map(entry => sshFingerprint(entry?.key)).filter(Boolean) : []
}

const liveGitHubAuth = async () => {
  let launched
  let registeredFingerprint = null
  let registeredLogin = null
  let originalFailure = null
  let cleanupFailure = null
  try {
    launched = await launch({ name: 'github-live' })
    const initial = await launched.page.evaluate(() => window.conductor.remote.githubState())
    assertNoRendererCredentials(initial)
    assert.equal(initial.secureStorageAvailable, true, 'The isolated profile must have OS-backed secure storage')
    assert.equal(initial.clientIdConfigured, true, 'The bundled public OAuth client ID must be active')
    const pending = await launched.page.evaluate(() => window.conductor.remote.signIn())
    assert.equal(pending.phase, 'awaiting-authorization')
    assert.ok(pending.prompt?.userCode && pending.prompt?.verificationUri)
    // These are the only authorization values this smoke emits. device_code and OAuth
    // credentials never cross the preload boundary and are never written to the result artifact.
    console.log(`GITHUB DEVICE AUTHORIZATION: ${pending.prompt.verificationUri}  CODE: ${pending.prompt.userCode}`)
    await launched.page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settingsPanel = launched.page.locator('.settings-panel')
    await expect(settingsPanel).toBeVisible()
    const accountSection = settingsPanel.getByText('Account & machines', { exact: true })
    await accountSection.scrollIntoViewIfNeeded()
    await expect(accountSection).toBeVisible()
    const openDeviceFlow = settingsPanel.getByRole('button', { name: `Open ${pending.prompt.verificationUri}`, exact: true })
    await openDeviceFlow.scrollIntoViewIfNeeded()
    await expect(openDeviceFlow).toBeVisible()
    await openDeviceFlow.click()
    const intercepted = await launched.app.evaluate(() => globalThis.__conductorSmokeExternalUrls)
    assert.deepEqual(intercepted, [pending.prompt.verificationUri])
    check('The default public OAuth client starts device flow and external navigation is intercepted')

    const deadline = Date.now() + 10 * 60_000
    let signedIn
    while (Date.now() < deadline) {
      signedIn = await launched.page.evaluate(() => window.conductor.remote.githubState())
      if (signedIn.phase === 'signed-in' && signedIn.deviceKeyFingerprint) break
      if (signedIn.phase === 'signed-out' && signedIn.message) throw new Error('GitHub device authorization did not complete: ' + signedIn.message)
      await new Promise(resolveWait => setTimeout(resolveWait, 1000))
    }
    assert.equal(signedIn?.phase, 'signed-in', 'Timed out waiting for owner authorization')
    assert.ok(signedIn.identity?.login && signedIn.deviceKeyFingerprint)
    assertNoRendererCredentials(signedIn)
    registeredFingerprint = signedIn.deviceKeyFingerprint
    registeredLogin = signedIn.identity.login
    check('GitHub returned the account and Conductor registered this isolated profile device key')

    const listedBefore = await publicKeyFingerprints(registeredLogin)
    assert.ok(listedBefore.includes(registeredFingerprint), 'The registered device key is not visible on the authorized account')
    const signedOut = await launched.page.evaluate(() => window.conductor.remote.signOut())
    assert.equal(signedOut.phase, 'signed-out')
    assert.equal(signedOut.deviceKeyFingerprint, null)
    assertNoRendererCredentials(signedOut)
    assert.doesNotMatch(signedOut.message ?? '', /Remove the "Conductor device" key/)

    let removed = false
    for (let attempt = 0; attempt < 4; attempt++) {
      removed = !(await publicKeyFingerprints(registeredLogin)).includes(registeredFingerprint)
      if (removed) break
      await new Promise(resolveWait => setTimeout(resolveWait, 3000))
    }
    assert.equal(removed, true, 'The isolated profile device key remained on GitHub after sign-out')
    check('Sign-out removes local authority and only the isolated profile device key is gone from GitHub')
    await launched.page.screenshot({ path: join(output, `github-signed-out-${runLabel}.png`), fullPage: true })
  } catch (error) {
    originalFailure = error
    await captureFailure(error)
  } finally {
    if (launched) {
      try {
        const current = await launched.page.evaluate(() => window.conductor.remote.githubState())
        assertNoRendererCredentials(current)
        registeredFingerprint ??= current.deviceKeyFingerprint
        registeredLogin ??= current.identity?.login ?? null
        if (current.phase !== 'signed-out' || current.deviceKeyFingerprint) {
          const cleaned = await launched.page.evaluate(() => window.conductor.remote.signOut())
          assert.equal(cleaned.phase, 'signed-out')
          assert.equal(cleaned.deviceKeyFingerprint, null)
          assertNoRendererCredentials(cleaned)
        }
        if (registeredFingerprint && registeredLogin) {
          let removed = false
          for (let attempt = 0; attempt < 4; attempt++) {
            removed = !(await publicKeyFingerprints(registeredLogin)).includes(registeredFingerprint)
            if (removed) break
            await new Promise(resolveWait => setTimeout(resolveWait, 3000))
          }
          assert.equal(removed, true, 'Live cleanup could not verify removal of the exact isolated-profile device key')
        }
      } catch (error) {
        cleanupFailure = new Error('Live GitHub cleanup failed: ' + safeError(error))
      }
    }
    try { await cleanupFixtureApp(launched?.app, results, 'live GitHub final cleanup') } catch (error) {
      cleanupFailure ??= new Error('Live GitHub app teardown failed: ' + safeError(error))
    }
  }
  const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
  if (failure) throw failure
}

try {
  if (liveGitHub) await liveGitHubAuth()
  else await deterministicRemote()
} catch (error) {
  await captureFailure(error)
  results.failures.push(...failureDetails(error))
  throw error
} finally {
  results.lastStep = diagnosticStep
  const report = JSON.stringify(results, null, 2) + '\n'
  await writeFile(join(output, 'results.json'), report)
  await writeFile(join(output, `results-${runLabel}.json`), report, { flag: 'wx' })
}

console.log(`OK ${results.checks.length} remote integration checks (${liveGitHub ? 'real GitHub device flow' : 'two isolated deterministic instances'}; no physical second-machine claim)`)
