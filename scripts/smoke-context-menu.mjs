import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Confirms the owner's "right click to copy" fix through the real, built app: (1) the main
// process actually wires a native context-menu handler onto every window's webContents (there
// is no such handler upstream, so right-clicking produced nothing at all), and (2) the readable
// surfaces the owner reads text from (the project task list, dialogs/notices) are selectable
// with the mouse rather than inheriting the app-wide `body { user-select: none }` default.
const root = await mkdtemp(join(tmpdir(), 'conductor-context-menu-'))
const output = resolve('artifacts/context-menu')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], failures: [] }
let page
try {
  page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Context menu fixture'))
  await page.reload()
  await page.getByText('Context menu fixture', { exact: true }).first().click()

  // (1) Every window's webContents gets our native context-menu listener wired up by the
  // app-level `web-contents-created` hook in src/main/index.ts, and an editable field with no
  // capabilities (fresh, empty, no selection) builds no menu items, matching the pure
  // contextMenuItemIds() logic under unit test.
  const listenerCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.listenerCount('context-menu'))
  assert.ok(listenerCount > 0, 'expected the main process to have attached a context-menu listener to the window webContents')
  results.checks.push('The main window webContents has a context-menu listener attached (none existed before this fix)')

  const emptyMenuBuilt = await app.evaluate(({ BrowserWindow }) => new Promise((resolvePromise) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const params = { isEditable: true, selectionText: '', linkURL: '', mediaType: 'none', x: 0, y: 0, editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false } }
    contents.emit('context-menu', { preventDefault() {} }, params)
    // No native popup should ever appear for a template with zero items; give it a tick to
    // (not) do so before concluding the handler ran without throwing.
    setTimeout(() => resolvePromise(true), 50)
  }))
  assert.ok(emptyMenuBuilt)
  results.checks.push('Emitting context-menu with every edit flag off runs the real installed handler without opening a popup')

  // (2) Selectable surfaces: the project task list and dialogs/notices must not inherit the
  // body-wide `user-select: none`; everything else keeps the default so drag/click UX (tabs,
  // resize handles, sidebar rows) is unaffected.
  await page.getByRole('button', { name: 'Project tasks', exact: true }).click()
  const newTask = page.getByRole('textbox', { name: 'New project task', exact: true })
  await newTask.fill('Selectable task text')
  await page.getByRole('button', { name: 'Add task', exact: true }).click()
  const taskBody = page.locator('.project-task-body').filter({ hasText: 'Selectable task text' }).first()
  await taskBody.waitFor()
  const value = await taskBody.evaluate((element) => getComputedStyle(element).userSelect)
  assert.equal(value, 'text', 'expected .project-task-body to allow text selection')
  results.checks.push('.project-task-body (the backlog task row) computes user-select: text')

  await page.getByRole('checkbox', { name: 'Select Selectable task text' }).click()
  await page.getByRole('button', { name: 'Assign to tab', exact: true }).click()
  const dialog = page.locator('.sa-dialog').first()
  await dialog.waitFor()
  const dialogValue = await dialog.evaluate((element) => getComputedStyle(element).userSelect)
  assert.equal(dialogValue, 'text', 'expected .sa-dialog to allow text selection')
  results.checks.push('.sa-dialog (dialogs and notices) computes user-select: text')
  await page.keyboard.press('Escape')

  const bodyValue = await page.evaluate(() => getComputedStyle(document.body).userSelect)
  assert.equal(bodyValue, 'none', 'expected the body default to remain none so drag/click UX elsewhere is unaffected')
  results.checks.push('body keeps user-select: none as the default (no global flip that would break drag/click UX)')

  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  try { await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2)) }
  finally { try { await app.close() } catch {} }
  console.log(JSON.stringify(results, null, 2))
}
