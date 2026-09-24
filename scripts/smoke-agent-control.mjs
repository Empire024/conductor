import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// Real Electron main/preload/renderers and HTTP broker; only provider processes are synthetic.
const root = await mkdtemp(join(tmpdir(), 'conductor-control-smoke-'))
const output = resolve('artifacts/agent-control')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const sourceProvider = process.argv.includes('--provider=codex') ? 'codex' : 'claude'
const sourceLabel = sourceProvider === 'claude' ? 'Claude' : 'Codex'
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
// Whole-run watchdog: every step below is bounded, and this catches anything that still is not.
// Kills the whole Electron tree: on Windows a plain kill of the main pid leaves it running.
const killElectron = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else app.process().kill('SIGKILL') } catch { /* already gone */ } }
const watchdog = setTimeout(() => { console.error('FAIL smoke-agent-control exceeded 180 s; killing Electron'); killElectron(); process.exit(1) }, 180_000)
watchdog.unref()
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Native provider must receive the protocol briefing')
  return { endpoint, token }
}
const call = async (auth, method, args = {}) => {
  // Bounded: a control call that never answers must fail this smoke, not hang it.
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30_000) })
  const result = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(result))
  return result.result
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('Control smoke'))
  await writeFile(join(project.path, 'notes.md'), 'Original editor contents\n')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Control smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: sourceLabel }).click()
  await expect(page.getByRole('textbox', { name: sourceProvider === 'claude' ? 'Message Claude Code' : 'Message Codex', exact: true })).toBeEnabled()
  const sourceId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async ({ id, provider }) => { await window.conductor.structured.connect(id); const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, provider === 'claude' ? 'SYNTHETIC STEER START' : 'synthetic:steer', { ...state.settings, model: provider === 'claude' ? 'synthetic-claude' : 'synthetic-model', effort: 'low' }, []) }, { id: sourceId, provider: sourceProvider })
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const owner = await credentials()
  const tools = await call(owner, 'tools.list'); assert.ok(tools['router.dispatch'])
  const state = await call(owner, 'app.state')
  assert.equal(state.project.id, project.id)
  check('Native provider receives scoped app-control briefing and discovers project/workspace state')

  const catalog = await call(owner, 'models.list')
  const routerModel = catalog.find(provider => provider.provider === 'codex').models[0].id
  const started = await call(owner, 'router.start', { prompt: 'Coordinate this synthetic fixture', provider: 'codex', model: routerModel })
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Your orchestration task ID is ' + started.taskId))).toBe(true)
  const router = await credentials()
  const workers = await call(router, 'router.dispatch', { tasks: [{ title: 'Visible worker', prompt: 'SYNTHETIC B bounded native fixture', provider: 'codex', model: 'synthetic-model', effort: 'low' }] })
  assert.equal(workers.length, 1); assert.ok(workers[0].agentSessionId)
  const worker = workers[0]
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), worker.agentSessionId))?.phase).toBe('completed')
  const workerState = await page.evaluate(id => window.conductor.structured.snapshot(id), worker.agentSessionId)
  assert.ok(workerState.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes('bounded native fixture')))
  assert.ok(workerState.items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('Synthetic fixture continuation')))
  // The old always-on .agent-control-links strip is now one labelled marker per tab header
  // (AgentControlLinks.tsx: MAIN / COWORKER) whose popover lists the relationship.
  const workerMarker = page.getByRole('button', { name: 'Visible worker is a coworker controlled by Conductor router; show relationship details', exact: true })
  await expect(workerMarker).toHaveText('COWORKER')
  await workerMarker.click()
  const relationships = page.getByRole('dialog', { name: 'Agent tab relationships for Visible worker', exact: true })
  await expect(relationships).toContainText('Conductor router')
  await expect(relationships.getByRole('button', { name: 'Disconnect control of Visible worker', exact: true })).toBeVisible()
  await relationships.getByRole('button', { name: 'Close agent tab relationships', exact: true }).click()
  // The owner's source tab is marked MAIN over the router it started; the sidebar row names the chain too.
  await expect(page.getByRole('button', { name: sourceLabel + ' is the main coordinating tab and controls 1 coworker: Conductor router; show relationship details', exact: true })).toHaveText('MAIN')
  await expect(page.getByRole('button', { name: 'Visible worker is coworker controlled by Conductor router; show the main tab', exact: true })).toBeVisible()
  const board = await page.evaluate(projectId => window.conductor.orchestration.snapshot(projectId), project.id)
  assert.ok(board.agents.some(agent => agent.role === 'conductor-router'))
  assert.ok(board.tasks.some(task => task.id === worker.taskId))
  check('Router uses persisted agent/routine/task state and dispatches a visible native coworker turn with control links')

  await call(router, 'tabs.detach', { tabId: worker.tabId })
  await expect.poll(() => app.windows().length).toBe(2)
  const detached = app.windows().find(candidate => candidate !== page)
  await expect(detached.getByRole('button', { name: 'Visible worker is a coworker controlled by Conductor router; show relationship details', exact: true })).toBeVisible()
  await page.evaluate(uri => window.conductor.agentControl.openUri(uri), worker.uri)
  await expect(detached.locator('[data-structured-session="' + worker.agentSessionId + '"]')).toBeVisible()
  assert.equal(await app.evaluate(({ BrowserWindow }) => new URL(BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? 'file:///').searchParams.has('detached')), true)
  await page.evaluate(scope => window.conductor.agentControl.focusTab(scope.projectId, scope.sessionId, scope.tabId), { projectId: project.id, sessionId: state.workspace.id, tabId: started.tab.id })
  check('Detached control links keep both identities and stable tab URIs focus the correct native window')
  const file = await call(owner, 'files.read', { path: 'notes.md' })
  await page.evaluate(uri => window.conductor.agentControl.openUri(uri), file.uri)

  await expect(page.locator('.file-tab.active')).toContainText('notes.md')
  const editor = page.locator('.file-tab-content:not([hidden]) .monaco-editor')
  await expect(editor).toContainText('Original editor contents')
  await call(owner, 'files.write', { path: 'notes.md', content: 'Agent protocol update\n', expectedContent: 'Original editor contents\n' })
  await expect(editor).toContainText('Agent protocol update')
  await writeFile(join(project.path, 'notes-replacement.tmp'), 'External atomic update\n')
  await rename(join(project.path, 'notes-replacement.tmp'), join(project.path, 'notes.md'))
  await expect(editor).toContainText('External atomic update')
  check('Protocol writes and external atomic saves update the visible editor immediately')
  const input = editor.locator('textarea')
  await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.type('Owner unsaved draft')
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toBeVisible()
  await writeFile(join(project.path, 'notes.md'), 'Another external update\n')
  await expect(page.getByText('This file changed on disk. Your unsaved edits are preserved; save a copy or reload the current file.', { exact: true })).toBeVisible()
  await expect(editor).toContainText('Owner unsaved draft')
  assert.equal(await readFile(join(project.path, 'notes.md'), 'utf8'), 'Another external update\n')
  check('External edits preserve dirty user buffers and flag a conflict instead of authorizing stale overwrites')

  const links = await page.evaluate(scope => window.conductor.agentControl.links(scope.projectId, scope.sessionId), { projectId: project.id, sessionId: state.workspace.id })
  assert.equal(links.length, 2)
  await page.evaluate(id => window.conductor.agentControl.release(id), worker.agentSessionId)
  await expect.poll(() => page.evaluate(scope => window.conductor.agentControl.links(scope.projectId, scope.sessionId), { projectId: project.id, sessionId: state.workspace.id })).toHaveLength(1)
  check('Owner can release a control relationship while native work remains intact')
  await page.screenshot({ path: join(output, 'control-and-live-editor.png') })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, sourceProvider, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} catch (error) {
  process.exitCode = 1
  console.error('FAIL after: ' + (checks.at(-1) ?? 'nothing') + '\n' + (error?.stack ?? String(error)))
  console.error('Last provider input (tail): ' + (await readFile(capture, 'utf8').catch(() => '<none>')).slice(-1500))
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  // Answer the close prompts by label, not index: "Don't Save" for the owner's dirty draft and
  // "Stop work and quit" for the still-running fixture turns (index 1 there is Cancel).
  await Promise.race([app.evaluate(({ dialog }) => {
    const answer = async (...args) => { const buttons = (args.at(-1)?.buttons ?? []); const index = buttons.findIndex(label => label === "Don't Save" || label === 'Stop work and quit'); return { response: index >= 0 ? index : 0, checkboxChecked: false } }
    dialog.showMessageBox = answer
  }), new Promise(done => setTimeout(done, 5000))]).catch(() => {})
  // A close that never settles (a pending native turn, a quit prompt) must not hang the run.
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise(done => setTimeout(() => done(false), 20_000))])
  if (!closed) { console.error('FAIL app.close did not settle within 20 s; killing Electron'); killElectron(); process.exitCode = 1 }
  await rm(capture, { force: true })
}
// Playwright's connection can keep the loop alive after a forced kill; the verdict is already set.
process.exit(process.exitCode ?? 0)
