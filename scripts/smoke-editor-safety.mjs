import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-editor-safety-'))
const output = resolve('artifacts/editor-safety')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_MODEL_CATALOG: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
const errors = [], checks = []
page.on('pageerror', (error) => { if (!(error.message === 'Canceled' && /Delayer.cancel/.test(error.stack ?? ''))) errors.push(error.stack ?? error.message) })
const check = (name) => { checks.push(name); console.log('PASS ' + name) }
const screenshot = async (name) => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'))
}
const activeEditor = () => page.locator('.workspace-files:visible .file-tab-content:not([hidden]) .monaco-editor textarea')
const chooseDialog = (response, change) => app.evaluate(({ dialog }, { response, change }) => {
  globalThis.__editorDialogChoice = response
  globalThis.__editorDialogChange = change
  globalThis.__editorDialogs ??= []
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    globalThis.__editorDialogs.push(options)
    if (options.type === 'question' && globalThis.__editorDialogChange) {
      globalThis.__editorDialogChange = undefined
      await new Promise(resolve => { globalThis.__editorReleaseDialog = resolve })
    }
    return { response: globalThis.__editorDialogChoice, checkboxChecked: false }
  }
}, { response, change })
const open = async (path) => {
  await page.keyboard.press('Control+e')
  await page.getByRole('combobox', { name: 'Search files', exact: true }).fill(path)
  await page.getByRole('option').filter({ hasText: path }).first().click()
  await expect(activeEditor()).toBeVisible()
}
const draft = async (projectId, path) => page.evaluate(async ({ projectId, path }) => {
  window.dispatchEvent(new Event('conductor:flush-editors'))
  const file = Object.keys(localStorage).filter(key => key.startsWith('conductor.workspaceFiles.')).flatMap(key => JSON.parse(localStorage.getItem(key)).files).find(file => file.path === path && file.projectId === projectId)
  return file ? window.conductor.files.getDraft(file.id, projectId, path) : null
}, { projectId, path })
try {
  await page.waitForFunction(() => Boolean(window.conductor?.files.readForEditor))
  const project = await page.evaluate(() => window.conductor.projects.create('Editor Safety'))
  const path = join(project.path, 'safety.ts')
  await writeFile(path, 'original disk\n')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Editor Safety' }).click()
  await chooseDialog(0)
  await open('safety.ts')
  assert.equal(await draft(project.id, 'safety.ts'), null)
  await writeFile(path, 'new agent work\n')
  await page.getByRole('button', { name: 'Close safety.ts', exact: true }).click()
  await expect(page.locator('.file-tab')).toHaveCount(0)
  assert.equal(await readFile(path, 'utf8'), 'new agent work\n')
  assert.equal(await app.evaluate(() => globalThis.__editorDialogs.length), 0)
  check('Closing an untouched stale editor never prompts or overwrites newer disk content')

  await open('safety.ts')
  await activeEditor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('my unsaved edit')
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toBeVisible()
  const initial = await draft(project.id, 'safety.ts')
  assert.equal(initial.baseContent, 'new agent work\n')
  await writeFile(path, 'agent changed it again\n')
  await page.locator('.code-toolbar').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.code-save-error')).toContainText('changed on disk')
  assert.equal(await readFile(path, 'utf8'), 'agent changed it again\n')
  assert.equal((await draft(project.id, 'safety.ts')).content, initial.content)
  await screenshot('conflict-recovery-success')
  check('Explicit save refuses a newer disk version and preserves the exact local draft')

  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect.poll(async () => (await readdir(project.path)).filter(name => /\.recovered-/.test(name)).length).toBe(1)
  const copy = (await readdir(project.path)).find(name => /\.recovered-/.test(name))
  assert.equal(await readFile(join(project.path, copy), 'utf8'), initial.content)
  assert.equal(await readFile(path, 'utf8'), 'agent changed it again\n')
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reload from disk?', exact: true })).toBeVisible()
  await page.getByRole('dialog', { name: 'Reload from disk?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal((await draft(project.id, 'safety.ts')).content, initial.content)
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await page.getByRole('dialog', { name: 'Reload from disk?', exact: true }).getByRole('button', { name: 'Reload from disk', exact: true }).click()
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toHaveCount(0)
  assert.equal(await draft(project.id, 'safety.ts'), null)
  check('Save a copy preserves both versions; reload requires a decision and resets the baseline')

  await activeEditor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' edit before close')
  const closeDraft = await draft(project.id, 'safety.ts')
  await chooseDialog(0, true)
  await page.getByRole('button', { name: 'Close safety.ts', exact: true }).click()
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.__editorReleaseDialog))).toBe(true)
  await writeFile(path, 'agent wrote while Save dialog was open\n')
  await app.evaluate(() => { globalThis.__editorReleaseDialog(); globalThis.__editorReleaseDialog = undefined })
  await expect(page.locator('.code-save-error')).toContainText('changed on disk')
  await expect(page.locator('.file-tab')).toHaveCount(1)
  assert.equal(await readFile(path, 'utf8'), 'agent wrote while Save dialog was open\n')
  assert.equal((await draft(project.id, 'safety.ts')).content, closeDraft.content)
  check('Save on close rechecks disk after the dialog and keeps conflicting edits open')

  await chooseDialog(1)
  await page.getByRole('button', { name: 'Close safety.ts', exact: true }).click()
  await expect(page.locator('.file-tab')).toHaveCount(0)
  assert.equal(await readFile(path, 'utf8'), 'agent wrote while Save dialog was open\n')
  await open('safety.ts')
  await activeEditor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' first save')
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('files:write')
    globalThis.__editorOriginalWrite = handler
    ipcMain.removeHandler('files:write')
    ipcMain.handle('files:write', async (...args) => { await new Promise(resolve => setTimeout(resolve, 300)); return handler(...args) })
  })
  await page.keyboard.press('Control+s')
  await page.keyboard.type(' latest edit')
  await page.keyboard.press('Control+s')
  await expect.poll(() => readFile(path, 'utf8')).toBe('agent wrote while Save dialog was open\n first save latest edit')
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toHaveCount(0)
  assert.equal(await draft(project.id, 'safety.ts'), null)
  check('Repeated Ctrl+S while saving serializes the latest buffer without losing intervening edits')

  await page.keyboard.type('x')
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.file-tab.active .file-dirty-dot')).toHaveCount(0)
  assert.equal(await draft(project.id, 'safety.ts'), null)
  check('Undoing back to the saved text removes the recovery draft')

  await page.keyboard.type(' first workspace draft')
  await page.locator('.sidebar .new-session').click()
  await expect(page.locator('.session-tab.active')).toContainText('Workspace 2')
  await open('safety.ts')
  await expect(page.locator('.workspace-files:visible .view-lines')).not.toContainText('first workspace draft')
  await activeEditor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' second workspace edit')
  await page.keyboard.press('Control+s')
  await expect.poll(() => readFile(path, 'utf8')).toBe('agent wrote while Save dialog was open\n first save latest edit second workspace edit')
  await page.locator('.sidebar-session-row').filter({ has: page.getByText('Workspace', { exact: true }) }).click()
  await expect(page.locator('.workspace-files:visible .view-lines')).toContainText('first workspace draft')
  await page.locator('.workspace-files:visible .code-toolbar').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.workspace-files:visible .code-save-error')).toContainText('changed on disk')
  assert.equal(await readFile(path, 'utf8'), 'agent wrote while Save dialog was open\n first save latest edit second workspace edit')
  check('Two workspaces keep independent editor models and cannot overwrite each other with an older baseline')

  await page.locator('.workspace-files:visible').getByRole('button', { name: 'New file', exact: true }).click()
  const fileName = page.getByRole('textbox', { name: 'New file name', exact: true })
  await expect(fileName).toBeFocused()
  await expect(fileName).toHaveValue('untitled.md')
  await expect(activeEditor()).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'New file', exact: true })).toHaveCount(0)
  await screenshot('inline-new-file-success')
  assert.equal(await readFile(join(project.path, 'untitled.md'), 'utf8'), '')
  await fileName.press('Escape')
  await expect(activeEditor()).toBeFocused()
  await page.keyboard.type('keep these notes')
  await page.keyboard.press('Control+s')
  await expect.poll(() => readFile(join(project.path, 'untitled.md'), 'utf8')).toBe('keep these notes')
  check('New file opens its editor immediately with inline naming; Escape keeps a usable untitled.md')

  await page.locator('.workspace-files:visible').getByRole('button', { name: 'New file', exact: true }).click()
  await expect(fileName).toHaveValue('untitled-2.md')
  await fileName.fill('safety.ts')
  await fileName.press('Enter')
  await expect(page.locator('.file-create-error')).toContainText('already exists')
  assert.equal(await readFile(path, 'utf8'), 'agent wrote while Save dialog was open\n first save latest edit second workspace edit')
  await fileName.fill('notes.md')
  await fileName.press('Enter')
  await expect(fileName).toHaveCount(0)
  await expect(page.locator('.workspace-files:visible .file-tab.active')).toContainText('notes.md')
  assert.equal(await readFile(join(project.path, 'notes.md'), 'utf8'), '')
  check('Inline naming chooses unique defaults, rejects existing names, and commits a new name without a popup')

  await page.locator('.activity-rail').getByRole('button', { name: 'Settings', exact: true }).click()
  const extension = page.getByRole('textbox', { name: 'Default file extension', exact: true })
  await extension.fill('txt')
  await extension.press('Enter')
  await expect.poll(() => page.evaluate(async () => (await window.conductor.settings.get()).defaultNewFileExtension)).toBe('txt')
  await page.locator('.settings-panel header button').click()
  await page.locator('.workspace-files:visible').getByRole('button', { name: 'New file', exact: true }).click()
  await expect(fileName).toHaveValue('untitled.txt')
  await fileName.press('Escape')
  assert.equal(await readFile(join(project.path, 'untitled.txt'), 'utf8'), '')
  check('Settings persists the default new-file extension and applies it to the next editor tab')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ synthetic: true, checks, errors }, null, 2) + '\n')
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'failure.json'), JSON.stringify({ checks, errors, dialogs: await app.evaluate(() => globalThis.__editorDialogs), error: String(error) }, null, 2))
  throw error
} finally { await chooseDialog(1); await app.close() }
