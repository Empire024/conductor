import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Actual Electron main/preload/UI and native session adapters. Provider processes
// and the Fixer's routing decision are synthetic; this never runs inference.
const root = await mkdtemp(join(tmpdir(), 'conductor-task-dispatch-'))
const output = resolve('artifacts/project-task-dispatch')
const capture = join(root, 'provider-input.txt')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_MODEL_CATALOG: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_UPDATE_DEV
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const result = { actualElectron: true, syntheticProviders: true, syntheticRoutingDecision: true, checks: [], errors: [] }
page.on('pageerror', error => result.errors.push(error.stack ?? error.message))
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
const shot = async name => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))))
  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, name + '.png'), Buffer.from(image, 'base64'))
}
const report = "Circle on to-do should actually be select - if we want to mark to-do as done, let's do it another way  (i.e. our in progress / done selector, done will move it to Done).\nselecting a bug, or multiple will enable us to assign it to an open tab, or create a tab with an agent easily from project tasks view that'll fix it. let us decide on model + effort, or have Auto option where the main Fixer agent decides for each task and calls appropriate models with appropriate efforts as subagents."
let project
const board = () => page.evaluate(id => window.conductor.projectTasks.get(id), project.id)
const snapshot = id => page.evaluate(id => window.conductor.structured.snapshot(id), id)
const tasksPane = () => page.locator('.project-backlog')
const showTasks = async () => {
  if (!await tasksPane().isVisible()) await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  await expect(tasksPane()).toBeVisible()
}
const add = async title => {
  await page.getByRole('textbox', { name: 'New project task' }).fill(title)
  await page.getByRole('textbox', { name: 'New project task' }).press('Control+Enter')
  await expect(page.getByRole('textbox', { name: 'New project task' })).toHaveValue('')
  return (await board()).tasks.find(task => task.title === title)
}
const taskRow = id => page.locator('.project-task[data-task-id="' + id + '"]')
const select = async id => {
  const circle = taskRow(id).getByRole('checkbox')
  if (await circle.getAttribute('aria-checked') !== 'true') await circle.click()
  await expect(circle).toBeChecked()
}
const clear = async () => {
  const button = page.getByRole('button', { name: 'Clear selection', exact: true })
  if (await button.isVisible()) await button.click()
}
const dialog = name => page.getByRole('dialog', { name, exact: true })
const closeResult = async name => {
  await dialog(name).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog(name)).toHaveCount(0)
}
const captureDispatches = async () => app.evaluate(({ ipcMain }) => {
  const original = ipcMain._invokeHandlers.get('project-tasks:dispatch')
  globalThis.__taskDispatchCalls = []
  ipcMain.removeHandler('project-tasks:dispatch')
  ipcMain.handle('project-tasks:dispatch', async (...args) => {
    const call = { request: args[3] }
    globalThis.__taskDispatchCalls.push(call)
    call.result = await original(...args)
    return call.result
  })
})
try {
  await page.waitForFunction(() => Boolean(window.conductor?.projectTasks?.dispatch))
  project = await page.evaluate(() => window.conductor.projects.create('Task dispatch smoke'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Codex', exact: true })).toBeEnabled()
  const existingId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(id => window.conductor.structured.connect(id), existingId)
  await expect.poll(async () => (await snapshot(existingId)).capabilities?.models.map(model => model.id)).toContain('synthetic-model')
  await page.getByRole('combobox', { name: 'Model', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search models', exact: true }).fill('synthetic-model')
  await page.getByRole('textbox', { name: 'Search models', exact: true }).press('Enter')
  await page.getByRole('slider', { name: 'Reasoning effort' }).press('Home')
  await showTasks()
  const input = page.getByRole('textbox', { name: 'New project task' })
  await input.fill(report)
  await input.press('Enter')
  await input.type('Additional paragraph.')
  const multiline = report + '\nAdditional paragraph.'
  await expect(input).toHaveValue(multiline)
  assert.equal((await board()).tasks.length, 0)
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })))
  assert.equal((await board()).tasks.length, 0)
  await input.press('Control+Enter')
  await expect(input).toHaveValue('')
  let first = (await board()).tasks.find(task => task.title === multiline)
  assert.ok(first, 'The complete pasted user report must round-trip')
  assert.equal(await taskRow(first.id).locator('.project-task-title').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap')
  await taskRow(first.id).locator('.project-task-title').click()
  const edit = page.getByRole('textbox', { name: 'Edit task', exact: true })
  const edited = multiline + '\n\n- Keep the exact report.\n- Preserve the second paragraph.'
  await edit.fill(edited)
  await edit.press('Control+Enter')
  await expect(edit).toHaveCount(0)
  first = (await board()).tasks.find(task => task.id === first.id)
  assert.equal(first.title, edited)
  check('Verbatim multiline report saves with Ctrl+Enter, Enter adds a line, IME does not submit, and edit preserves paragraphs and lists')

  // Force a real optimistic revision rejection at the IPC boundary without
  // relying on the filesystem watcher's polling interval.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project-tasks:edit')
    globalThis.__taskEditOriginal = original
    ipcMain.removeHandler('project-tasks:edit')
    ipcMain.handle('project-tasks:edit', (event, projectId, revision, edit) => original(event, projectId, 'stale-smoke-revision', edit))
  })
  const unsaved = 'Keep this failed draft.\n\nSecond paragraph stays here.'
  await input.fill(unsaved); await input.press('Control+Enter')
  await expect(tasksPane().getByRole('alert')).toContainText(/changed|revision/i)
  await expect(input).toHaveValue(unsaved)
  await taskRow(first.id).locator('.project-task-title').click()
  await edit.fill(unsaved); await edit.press('Control+Enter')
  await expect(edit).toHaveValue(unsaved)
  assert.equal((await board()).tasks.find(task => task.id === first.id).title, edited)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('project-tasks:edit'); ipcMain.handle('project-tasks:edit', globalThis.__taskEditOriginal) })
  await input.fill('')
  check('Rejected stale add and edit retain the full draft without changing the task file')

  const second = await add('Second task for existing agent')
  const third = await add('Task for a new model')
  const fourth = await add('Task for Auto Fixer')
  const beforeSelection = await readFile(join(project.path, 'feature-list.md'), 'utf8')
  await select(first.id); await select(second.id)
  await expect(page.locator('.project-task-selection')).toContainText('2 selected')
  assert.equal(await readFile(join(project.path, 'feature-list.md'), 'utf8'), beforeSelection)
  assert.equal((await board()).tasks.find(task => task.id === first.id).status, 'todo')
  await taskRow(second.id).getByRole('combobox', { name: 'Status of ' + second.title, exact: true }).selectOption('done')
  await expect(taskRow(second.id)).toHaveCount(0)
  await page.locator('.project-task-done-heading').click()
  await expect(page.getByRole('region', { name: 'Completed tasks', exact: true })).toContainText(second.title)
  await taskRow(second.id).getByRole('combobox', { name: 'Status of ' + second.title, exact: true }).selectOption('todo')
  check('Single and multiple circles only select; the Done selector moves tasks into the completed group')
  await clear()
  await page.getByRole('textbox', { name: 'Search project tasks', exact: true }).fill('Task for')
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await expect(taskRow(third.id).getByRole('checkbox')).toBeChecked()
  await expect(taskRow(fourth.id).getByRole('checkbox')).toBeChecked()
  await page.getByRole('textbox', { name: 'Search project tasks', exact: true }).fill('')
  await expect(taskRow(first.id).getByRole('checkbox')).not.toBeChecked()
  await clear(); await select(first.id); await select(second.id)
  await shot('selected-tasks')
  check('Select visible respects the current search and retains multiple selections across filtering')

  await page.getByRole('button', { name: 'Assign to tab', exact: true }).click()
  await expect(dialog('Assign to an open tab').getByRole('combobox', { name: 'Open agent tab', exact: true })).toHaveValue(existingId)
  const refreshedTitle = third.title + ' (updated report)'
  await page.evaluate(async ({ projectId, taskId, title }) => {
    const board = await window.conductor.projectTasks.get(projectId)
    await window.conductor.projectTasks.edit(projectId, board.revision, { type: 'update', id: taskId, title })
    window.dispatchEvent(new Event('focus'))
  }, { projectId: project.id, taskId: third.id, title: refreshedTitle })
  await expect(taskRow(third.id).locator('.project-task-title')).toHaveText(refreshedTitle)
  await dialog('Assign to an open tab').getByRole('button', { name: 'Assign tasks', exact: true }).click()
  await expect(dialog('Assign to an open tab').getByRole('alert')).toContainText('task list changed')
  await expect(dialog('Assign to an open tab').getByRole('button', { name: 'Assign tasks', exact: true })).toBeDisabled()
  await dialog('Assign to an open tab').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(taskRow(first.id).getByRole('checkbox')).toBeChecked()
  assert.equal((await snapshot(existingId)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, 0)
  check('Assignment pins the reviewed revision: a background edit blocks submission and preserves the selected tasks')

  await captureDispatches()
  await page.getByRole('button', { name: 'Assign to tab', exact: true }).click()
  await dialog('Assign to an open tab').getByRole('combobox', { name: 'Open agent tab', exact: true }).selectOption(existingId)
  await dialog('Assign to an open tab').getByRole('button', { name: 'Assign tasks', exact: true }).click()
  await expect(dialog('Assign to an open tab')).toContainText('Sent to agent tab')
  await expect.poll(async () => (await board()).tasks.filter(task => task.agentId === existingId).length).toBe(2)
  const existingState = await snapshot(existingId)
  assert.ok(existingState.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes(first.id) && item.data.text.includes(second.id) && item.data.text.includes(edited)))
  await closeResult('Assign to an open tab')
  await expect(page.locator('.project-task-selection')).toContainText('0 selected')
  check('Existing assignment sends both full tasks in one native prompt and records the real conversation owner')

  await select(third.id)
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await dialog('Assign to a new agent').getByRole('combobox', { name: 'Task agent provider', exact: true }).selectOption('codex')
  const model = dialog('Assign to a new agent').getByRole('combobox', { name: 'Task agent model', exact: true })
  await model.selectOption('plain-model')
  await expect(dialog('Assign to a new agent').getByRole('combobox', { name: 'Task agent reasoning effort', exact: true })).toHaveCount(0)
  await model.selectOption('synthetic-model')
  await dialog('Assign to a new agent').getByRole('combobox', { name: 'Task agent reasoning effort', exact: true }).selectOption('low')
  await shot('new-agent-settings')
  await dialog('Assign to a new agent').getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(dialog('Assign to a new agent')).toContainText('Sent to agent tab')
  const newId = (await board()).tasks.find(task => task.id === third.id).agentId
  assert.notEqual(newId, existingId)
  assert.equal((await snapshot(newId)).settings.model, 'synthetic-model')
  assert.equal((await snapshot(newId)).settings.effort, 'low')
  await dialog('Assign to a new agent').getByRole('button', { name: 'Open tab', exact: true }).click()
  await expect(page.locator('[data-structured-session="' + newId + '"]')).toBeVisible()
  await showTasks()
  check('New agent exposes only supported model/effort choices, starts a visible native tab, and opens its conversation')

  await clear(); await select(fourth.id)
  await page.getByRole('button', { name: 'Auto Fixer', exact: true }).click()
  await dialog('Auto Fixer').getByRole('button', { name: 'Start Auto Fixer', exact: true }).click()
  await expect(dialog('Auto Fixer')).toContainText('Sent to agent tab')
  const fixerId = (await board()).tasks.find(task => task.id === fourth.id).agentId
  const fixer = await snapshot(fixerId)
  assert.ok(fixer.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes('Project tasks Fixer') && item.data.text.includes('models.list') && item.data.text.includes('router.dispatch') && item.data.text.includes(fourth.id)))
  assert.notEqual(fixer.settings.permission, 'auto', 'Auto Fixer must not switch the provider permission mode')
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token)
  const call = async (method, args = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const body = await response.json(); assert.equal(response.status, 200, method + ': ' + JSON.stringify(body)); return body.result
  }
  const catalog = await call('models.list')
  assert.ok(catalog.find(provider => provider.provider === 'codex').models.some(model => model.id === 'synthetic-model'))
  const state = await call('app.state')
  assert.ok(state.tabs.some(tab => tab.resourceId === fixerId && tab.title === 'Project tasks Fixer'))
  // The deterministic test driver stands in for the Fixer's model decision. It
  // uses only this isolated fixture session's scoped local protocol credentials.
  const workers = await call('router.dispatch', { tasks: [{ title: 'Selected task coworker', prompt: 'SYNTHETIC B bounded Project task fixture', provider: 'codex', model: 'synthetic-model', effort: 'low', projectTaskIds: [fourth.id] }] })
  assert.equal(workers.length, 1); assert.equal(workers[0].accepted, true); assert.equal(workers[0].error, undefined)
  const worker = workers[0]
  await expect.poll(async () => (await board()).tasks.find(task => task.id === fourth.id).agentId).toBe(worker.agentSessionId)
  assert.equal((await snapshot(worker.agentSessionId)).settings.effort, 'low')
  await closeResult('Auto Fixer')
  await page.evaluate(uri => window.conductor.agentControl.openUri(uri), worker.uri)
  await expect(page.locator('[data-structured-session="' + worker.agentSessionId + '"]')).toBeVisible()
  await shot('fixer-native-coworker')
  check('Auto creates a visible Fixer; its scoped native dispatch opens a coworker with explicit supported model/effort and transfers only the selected claim')

  await showTasks(); await clear(); await select(third.id)
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project-tasks:dispatch')
    globalThis.__taskDispatchOriginal = original
    ipcMain.removeHandler('project-tasks:dispatch')
    ipcMain.handle('project-tasks:dispatch', async (event, projectId, revision, request) => {
      const board = await ipcMain._invokeHandlers.get('project-tasks:get')(event, projectId)
      const options = await ipcMain._invokeHandlers.get('project-tasks:dispatch-options')(event, projectId)
      const target = options.targets.find(target => target.agentSessionId === request.target.agentSessionId)
      return { board, assignments: [{ ...target, taskIds: request.taskIds, model: 'synthetic-model', status: 'failed', error: 'Synthetic uncertain provider response. Inspect the visible tab before retrying.' }] }
    })
  })
  await page.getByRole('button', { name: 'Assign to tab', exact: true }).click()
  await dialog('Assign to an open tab').getByRole('button', { name: 'Assign tasks', exact: true }).click()
  await expect(dialog('Assign to an open tab')).toContainText('Assignment failed')
  await expect(dialog('Assign to an open tab').getByRole('button', { name: 'Open tab', exact: true })).toBeVisible()
  await expect(dialog('Assign to an open tab').getByRole('button', { name: 'Assign tasks', exact: true })).toHaveCount(0)
  await closeResult('Assign to an open tab')
  await expect(taskRow(third.id).getByRole('checkbox')).toBeChecked()
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('project-tasks:dispatch'); ipcMain.handle('project-tasks:dispatch', globalThis.__taskDispatchOriginal) })
  check('Uncertain failed assignment retains selection, offers the visible tab, and cannot automatically resubmit')
  result.dispatches = await app.evaluate(() => globalThis.__taskDispatchCalls)
  assert.equal(result.dispatches.length, 3)
  result.worker = worker
  result.tasks = (await board()).tasks.map(({ id, title, status, agentId }) => ({ id, title, status, agentId }))
  assert.deepEqual(result.errors, [])
} catch (error) {
  result.errors.push(error.stack ?? String(error)); process.exitCode = 1
  await shot('failure').catch(() => {})
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ checks: result.checks, errors: result.errors }, null, 2))
}
