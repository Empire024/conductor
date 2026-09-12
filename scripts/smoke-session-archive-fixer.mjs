import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// Actual Electron main/preload/renderers with fixed offline provider fixtures. Every launched
// window is parked off-screen by CONDUCTOR_TEST_USER_DATA and the process wrapper.
const agentId = 'agent_mtycn51c_al80cic'
const script = 'scripts/smoke-session-archive-fixer.mjs'
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
assert.equal(slot.status, 'granted', 'Electron smoke slot is not granted')
assert.equal(slot.agentSessionId, agentId, 'Electron smoke slot belongs to another worker')
assert.equal(slot.script, script, 'Electron smoke slot names another script')
assert.ok(Number.isSafeInteger(slot.generation), 'Electron smoke slot has no generation')

const root = await mkdtemp(join(tmpdir(), 'conductor-session-archive-'))
const profile = join(root, 'profile')
const projectsRoot = join(root, 'projects')
const archivePath = join(root, 'Owner desk.conductor-session')
const providerStarts = join(root, 'provider-start.txt')
const output = resolve('artifacts/session-archive-fixer')
const evidenceId = `generation${slot.generation}`
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_BACKGROUND_WINDOWS: '1',
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_PROVIDER_START_CAPTURE: providerStarts,
  CONDUCTOR_TEST_USER_DATA: profile,
  CONDUCTOR_PROJECTS_ROOT: projectsRoot
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
delete env.CONDUCTOR_UPDATE_DEV

const result = { actualElectron: true, syntheticProviders: true, checks: [], errors: [] }
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
const screenshot = (page, name) => page.screenshot({ path: join(output, `${name}-${evidenceId}.png`), fullPage: true })

const launch = async () => {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => result.errors.push(error.stack ?? error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.sessionArchive?.open))
  await app.evaluate(({ dialog, ipcMain }) => {
    globalThis.__sessionSmokeDialogs = []
    globalThis.__sessionSmokeSavePath = null
    globalThis.__sessionSmokeOpenPath = null
    globalThis.__sessionSmokeMessageResponse = 1
    dialog.showSaveDialog = async () => {
      const filePath = globalThis.__sessionSmokeSavePath
      return filePath ? { canceled: false, filePath } : { canceled: true, filePath: '' }
    }
    dialog.showOpenDialog = async () => {
      const filePath = globalThis.__sessionSmokeOpenPath
      return filePath ? { canceled: false, filePaths: [filePath] } : { canceled: true, filePaths: [] }
    }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      globalThis.__sessionSmokeDialogs.push({ title: options?.title ?? '', message: options?.message ?? '', buttons: options?.buttons ?? [] })
      return { response: globalThis.__sessionSmokeMessageResponse, checkboxChecked: false }
    }
    const checkpoint = ipcMain._invokeHandlers.get('recovery:checkpoint')
    globalThis.__sessionSmokeRecovery = []
    ipcMain.removeHandler('recovery:checkpoint')
    ipcMain.handle('recovery:checkpoint', async (...args) => {
      const snapshot = args[1]
      const diagnostic = {
        activeProjectId: snapshot?.activeProjectId,
        activeSessionId: snapshot?.activeSessionId,
        sessions: snapshot?.sessions?.map(session => ({ id: session.id, layout: session.layout, closedTabs: session.closedTabs })),
        documents: snapshot?.documents
      }
      try {
        const value = await checkpoint(...args)
        globalThis.__sessionSmokeRecovery.push({ ...diagnostic, status: 'saved' })
        return value
      } catch (error) {
        globalThis.__sessionSmokeRecovery.push({ ...diagnostic, status: 'failed', error: String(error?.stack ?? error) })
        throw error
      }
    })
  })
  await page.evaluate(() => window.conductor.settings.setDebugLogging(true))
  return { app, page }
}

const setDialogs = (app, { savePath = null, openPath = null, response = 1 } = {}) => app.evaluate((_electron, state) => {
  globalThis.__sessionSmokeSavePath = state.savePath
  globalThis.__sessionSmokeOpenPath = state.openPath
  globalThis.__sessionSmokeMessageResponse = state.response
}, { savePath, openPath, response })

const fileMenuAction = async (page, label) => {
  await page.locator('.titlebar-brand').click()
  await page.getByRole('menu').getByRole('button').filter({ hasText: label }).click()
}

const nativeMenuAction = (app, id) => app.evaluate(({ Menu }, itemId) => {
  const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
  if (!item) throw new Error(`Native menu item ${itemId} is unavailable`)
  item.click()
}, id)

const nativeQuit = app => app.evaluate(({ Menu }) => {
  const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File')
  const quit = file?.submenu?.items.find(item => item.label === 'Quit')
  if (!quit) throw new Error('Native Quit menu item is unavailable')
  quit.click()
})
const dialogs = app => app.evaluate(() => globalThis.__sessionSmokeDialogs)

const activeEditor = page => page.locator('.workspace-files:visible .file-tab-content:not([hidden]) .monaco-editor textarea')
const draftFor = (page, projectId, path) => page.evaluate(async ({ projectId, path }) => {
  window.dispatchEvent(new Event('conductor:flush-editors'))
  const file = Object.keys(localStorage).filter(key => key.startsWith('conductor.workspaceFiles.')).flatMap(key => {
    try { return JSON.parse(localStorage.getItem(key)).files ?? [] } catch { return [] }
  }).find(item => item.projectId === projectId && item.path === path)
  return file ? window.conductor.files.getDraft(file.id, projectId, path, file.machineId) : null
}, { projectId, path })

const openFile = async (page, path) => {
  await page.keyboard.press('Control+e')
  await page.getByRole('combobox', { name: 'Search files', exact: true }).fill(path)
  await page.getByRole('option').filter({ hasText: path }).first().click()
  await expect(activeEditor(page)).toBeVisible()
}

const createFailingParkingWindow = app => app.evaluate(({ BrowserWindow }) => {
  const parking = new BrowserWindow({ show: false, skipTaskbar: true, x: -32000, y: -32000, width: 120, height: 80 })
  parking.webContents.executeJavaScript = async () => { throw new Error('Blank browser parking host must not receive editor flushes') }
  globalThis.__sessionSmokeParking = parking
  return BrowserWindow.getAllWindows().length
})

const closeFixture = async app => {
  let parkingFailure
  try {
    await app.evaluate(() => {
      globalThis.__sessionSmokeParking?.destroy()
      globalThis.__sessionSmokeParking = null
    })
  } catch (error) { parkingFailure = error }
  let cleanupFailure
  try { await cleanupFixtureApp(app, result, 'session archive fixture cleanup') }
  catch (error) { cleanupFailure = error }
  if (parkingFailure && cleanupFailure) throw new AggregateError([parkingFailure, cleanupFailure], 'Parking host removal and fixture cleanup both failed')
  if (parkingFailure) throw parkingFailure
  if (cleanupFailure) throw cleanupFailure
}

let first
let second
let originalFailure
const cleanupFailures = []
try {
  first = await launch()
  const { app, page } = first
  const projectA = await page.evaluate(() => window.conductor.projects.create('Archive source'))
  const projectB = await page.evaluate(() => window.conductor.projects.create('Background work'))
  await writeFile(join(projectA.path, 'literal.ts'), 'export const stable = true\n')
  await page.reload()

  await page.locator('.project-row').filter({ hasText: projectB.name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const agentPane = page.locator('.structured-agent-pane:visible')
  await expect(agentPane).toBeVisible()
  const runningAgentId = await agentPane.getAttribute('data-structured-session')
  assert.ok(runningAgentId)
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const until = Date.now() + 10000
    while (Date.now() < until) {
      const state = await window.conductor.structured.snapshot(id)
      if (state?.capabilities) break
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
    await window.conductor.structured.submit(id, 'synthetic:steer-wait\nKeep this history across the archive.', { permission: 'default', plan: false })
  }, runningAgentId)
  await expect.poll(() => page.evaluate(id => window.conductor.structured.snapshot(id).then(state => state?.phase), runningAgentId)).toBe('running')
  const backgroundWorkspace = (await page.evaluate(id => window.conductor.sessions.list(id), projectB.id))[0]
  const detached = await page.evaluate(({ projectId, sessionId, agentId }) => window.conductor.window.detach(projectId, sessionId, {
    id: 'detached-running-tab', resourceId: agentId, kind: 'agent', title: 'Background Codex', state: { provider: 'codex', viewMode: 'visual' }
  }), { projectId: projectB.id, sessionId: backgroundWorkspace.id, agentId: runningAgentId })
  await expect.poll(() => app.windows().filter(candidate => candidate.url().includes('detached=')).length).toBe(1)
  assert.ok(detached.id)

  await page.locator('.project-row').filter({ hasText: projectA.name }).click()
  await expect(page.locator('.pane-tab')).toHaveCount(1)
  await page.keyboard.press('Control+w')
  await expect(page.locator('.pane-tab')).toHaveCount(0)
  assert.equal(page.isClosed(), false)
  assert.equal((await page.evaluate(id => window.conductor.structured.snapshot(id), runningAgentId)).phase, 'running')
  check('Ctrl+W closes the final tab without closing the application or hidden work in another project')

  await page.keyboard.press('Control+t')
  await expect(page.locator('.launcher-grid')).toBeVisible()
  await page.locator('.launcher-grid button').filter({ hasText: 'PowerShell' }).click()
  await expect(page.locator('.pane-tab').filter({ hasText: 'PowerShell' })).toBeVisible()
  await expect.poll(async () => {
    const sessions = await page.evaluate(id => window.conductor.sessions.list(id), projectA.id)
    const visit = node => node?.type === 'group' ? node.tabs.find(tab => tab.kind === 'terminal')?.resourceId : node?.children.map(visit).find(Boolean)
    return visit(sessions[0]?.layout.root) ?? ''
  }).not.toBe('')
  const terminalId = await page.evaluate(async id => {
    const visit = node => node.type === 'group' ? node.tabs.find(tab => tab.kind === 'terminal')?.resourceId : node.children.map(visit).find(Boolean)
    return visit((await window.conductor.sessions.list(id))[0].layout.root)
  }, projectA.id)
  assert.ok(terminalId)
  await openFile(page, 'literal.ts')
  const literal = 'const client_secret = "literal source text";\n'
  await activeEditor(page).focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(literal)
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toBeVisible()
  const beforeSaveDraft = await draftFor(page, projectA.id, 'literal.ts')
  assert.equal(beforeSaveDraft.baseContent, 'export const stable = true\n')
  assert.equal(beforeSaveDraft.content, 'export const stable = true\n' + literal)

  const windowCount = await createFailingParkingWindow(app)
  assert.ok(windowCount >= 3, 'Main, detached, and blank parking windows were not all present')

  await setDialogs(app, { response: 1 })
  let dialogCount = (await dialogs(app)).length
  await page.locator('.window-close').click()
  await delay(250)
  assert.equal(page.isClosed(), false)
  assert.equal((await dialogs(app)).length, dialogCount + 1)
  assert.equal((await dialogs(app)).at(-1).title, 'Quit Conductor?')
  assert.equal((await page.evaluate(id => window.conductor.structured.snapshot(id), runningAgentId)).phase, 'running')
  check('Title-bar close asks once and Cancel preserves the complete desk and running work')

  await setDialogs(app, { response: 1 })
  dialogCount = (await dialogs(app)).length
  await nativeQuit(app)
  await delay(250)
  assert.equal(page.isClosed(), false)
  assert.equal((await dialogs(app)).length, dialogCount + 1)
  assert.equal((await dialogs(app)).at(-1).title, 'Quit Conductor?')
  assert.equal((await page.evaluate(id => window.conductor.structured.snapshot(id), runningAgentId)).phase, 'running')
  check('Native File > Quit asks once and Cancel leaves cross-project detached work running')

  await setDialogs(app, { savePath: archivePath })
  await fileMenuAction(page, 'Save session')
  await expect.poll(async () => (await stat(archivePath)).size).toBeGreaterThan(0)
  await expect(page.locator('.titlebar-project strong')).toHaveText('Owner desk')
  assert.equal(await readFile(join(projectA.path, 'literal.ts'), 'utf8'), 'export const stable = true\n')
  assert.deepEqual(await draftFor(page, projectA.id, 'literal.ts'), beforeSaveDraft)
  const archive = JSON.parse(await readFile(archivePath, 'utf8'))
  const sourceDraft = archive.drafts.find(item => item.projectId === projectA.id && item.path === 'literal.ts')
  assert.equal(sourceDraft.content, beforeSaveDraft.content)
  assert.equal(sourceDraft.baseContent, beforeSaveDraft.baseContent)
  assert.ok(archive.detached.some(item => item.projectId === projectB.id))
  assert.ok(archive.agents.some(item => item.spec.id === runningAgentId && item.projection.items.some(event => event.data.type === 'text' && event.data.text.includes('Keep this history'))))
  assert.ok(archive.terminals.some(item => item.spec.id === terminalId && item.spec.startupCommand === undefined))
  assert.ok(archive.agents.every(item => item.projection === null || (item.projection.queued === null && item.projection.queuedPrompts.length === 0 && item.projection.pendingSteering.length === 0 && item.projection.settings.permission === 'default' && item.projection.settings.browserMcp === undefined)))
  await screenshot(page, 'named-session-saved')
  check('Title-bar Save writes the named whole-desk archive without changing credential-like source bytes')

  await page.evaluate(() => window.conductor.projects.create('Cancel sentinel'))
  await setDialogs(app, { openPath: archivePath, response: 1 })
  dialogCount = (await dialogs(app)).length
  await fileMenuAction(page, 'Open session')
  await delay(250)
  assert.equal((await dialogs(app)).length, dialogCount + 1)
  assert.equal((await dialogs(app)).at(-1).title, 'Open saved session?')
  await expect(page.locator('.titlebar-project strong')).toHaveText('Owner desk')
  await expect.poll(() => page.evaluate(() => window.conductor.projects.list().then(items => items.map(item => item.name).sort()))).toEqual(['Archive source', 'Background work', 'Cancel sentinel'])
  assert.equal((await page.evaluate(id => window.conductor.structured.snapshot(id), runningAgentId)).phase, 'running')
  assert.deepEqual(await draftFor(page, projectA.id, 'literal.ts'), beforeSaveDraft)
  check('Open session Cancel leaves the visible desk, unsaved draft, and running work unchanged')

  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('terminal:ensure')
    globalThis.__sessionSmokeTerminalEnsures = 0
    ipcMain.removeHandler('terminal:ensure')
    ipcMain.handle('terminal:ensure', (...args) => { globalThis.__sessionSmokeTerminalEnsures++; return original(...args) })
  })
  const providerBeforeOpen = { content: await readFile(providerStarts, 'utf8'), modified: (await stat(providerStarts)).mtimeMs }
  await setDialogs(app, { openPath: archivePath, response: 0 })
  await nativeMenuAction(app, 'open-session')
  await expect(page.locator('.titlebar-project strong')).toHaveText('Owner desk')
  await page.waitForFunction(() => document.readyState === 'complete' && Boolean(window.conductor?.sessionArchive))
  await expect.poll(() => page.evaluate(() => window.conductor.projects.list().then(items => items.map(item => item.name).sort()))).toEqual(['Archive source', 'Background work'])
  assert.equal(await app.evaluate(() => globalThis.__sessionSmokeTerminalEnsures), 0)
  assert.deepEqual({ content: await readFile(providerStarts, 'utf8'), modified: (await stat(providerStarts)).mtimeMs }, providerBeforeOpen)
  assert.ok(app.windows().some(candidate => candidate.url().includes('detached=')), 'Detached window was not restored')
  const recoveryPath = join(profile, 'session-recovery', 'previous.conductor-session')
  assert.ok((await stat(recoveryPath)).size > 0)
  check('Native Open validates, snapshots the prior desk, replaces atomically, restores detached layout, and leaves imported runtimes dormant')

  first = null
  await closeFixture(app)

  second = await launch()
  const { app: restartedApp, page: restartedPage } = second
  await restartedApp.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('terminal:ensure')
    globalThis.__sessionSmokeTerminalEnsures = 0
    ipcMain.removeHandler('terminal:ensure')
    ipcMain.handle('terminal:ensure', (...args) => { globalThis.__sessionSmokeTerminalEnsures++; return original(...args) })
  })
  await setDialogs(restartedApp, { openPath: archivePath, response: 0 })
  await fileMenuAction(restartedPage, 'Open session')
  await expect(restartedPage.locator('.titlebar-project strong')).toHaveText('Owner desk')
  const reopenedProjects = await restartedPage.evaluate(() => window.conductor.projects.list())
  const reopenedSource = reopenedProjects.find(item => item.name === 'Archive source')
  const reopenedBackground = reopenedProjects.find(item => item.name === 'Background work')
  assert.ok(reopenedSource && reopenedBackground)
  const history = await restartedPage.evaluate(projectId => window.conductor.structured.history(projectId), reopenedBackground.id)
  assert.ok(history.length > 0)
  const restoredProjection = await restartedPage.evaluate(id => window.conductor.structured.snapshot(id), history[0].id)
  assert.equal(restoredProjection.phase, 'disconnected')
  assert.ok(restoredProjection.items.some(item => item.data.type === 'text' && item.data.text.includes('Keep this history')))
  const reopenedDraft = await draftFor(restartedPage, reopenedSource.id, 'literal.ts')
  assert.equal(reopenedDraft.content, beforeSaveDraft.content)
  assert.equal(reopenedDraft.baseContent, beforeSaveDraft.baseContent)
  assert.deepEqual({ content: await readFile(providerStarts, 'utf8'), modified: (await stat(providerStarts)).mtimeMs }, providerBeforeOpen)
  check('After an application restart, Open restores the session name, provider history, and exact unsaved draft without autoexecuting a prompt')

  const renderers = restartedApp.windows().filter(candidate => candidate.url().includes('index.html'))
  let terminalDormant
  for (const candidate of renderers) {
    const button = candidate.getByRole('button', { name: 'Start fresh shell', exact: true })
    if (await button.count()) { terminalDormant = button; break }
  }
  assert.ok(terminalDormant, 'Imported terminal did not render its dormant activation control')
  assert.equal(await restartedApp.evaluate(() => globalThis.__sessionSmokeTerminalEnsures ?? 0), 0)
  await screenshot(restartedPage, 'restored-dormant-desk')
  check('Imported terminal is visibly dormant and does not automatically start a shell')

  assert.deepEqual(result.errors, [])
} catch (error) {
  originalFailure = error
  const diagnosticPage = second?.page && !second.page.isClosed() ? second.page : first?.page && !first.page.isClosed() ? first.page : null
  if (diagnosticPage) {
    await screenshot(diagnosticPage, 'failure').catch(() => {})
    result.failureDom = await diagnosticPage.locator('body').evaluate(body => ({
      text: body.innerText.slice(0, 30000),
      dialogs: [...body.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent?.slice(0, 4000) ?? ''),
      dormant: [...body.querySelectorAll('.session-archive-dormant')].map(pane => pane.textContent?.slice(0, 4000) ?? ''),
      projects: [...body.querySelectorAll('.project-row')].map(row => row.textContent?.trim() ?? ''),
      tabs: [...body.querySelectorAll('.pane-tab')].map(tab => tab.textContent?.trim() ?? '')
    })).catch(() => null)
    result.recoveryDiagnostics = await (second?.app ?? first?.app)?.evaluate(() => globalThis.__sessionSmokeRecovery).catch(() => null)
    result.rendererDiagnostics = await diagnosticPage.evaluate(() => window.conductor.debug.getSnapshot()).catch(() => null)
  }
} finally {
  if (first) {
    const pending = first
    first = null
    try { await closeFixture(pending.app) } catch (error) { cleanupFailures.push(error) }
  }
  if (second) {
    const pending = second
    second = null
    try { await closeFixture(pending.app) } catch (error) { cleanupFailures.push(error) }
  }
}
const cleanupFailure = cleanupFailures.length > 1 ? new AggregateError(cleanupFailures, 'Multiple session fixture cleanups failed') : cleanupFailures[0]
const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
if (failure) {
  result.errors.push(String(failure?.stack ?? failure))
  await writeFile(join(output, `failure-${evidenceId}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }).catch(() => {})
  throw failure
}
await writeFile(join(output, `result-${evidenceId}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
