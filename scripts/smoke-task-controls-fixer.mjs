import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Actual Electron main/preload/UI and filesystem persistence. No provider is
// launched and no inference is used; this fixture exercises Project tasks only.
const root = await mkdtemp(join(tmpdir(), 'conductor-task-controls-fixer-'))
const output = resolve('artifacts/task-controls-fixer')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
delete env.CONDUCTOR_UPDATE_DEV

const app = await electron.launch({ args: ['--disable-gpu', resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const result = { actualElectron: true, providerBoundary: 'not exercised', inference: false, checks: [], errors: [] }
page.on('pageerror', error => result.errors.push(error.stack ?? error.message))
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
const shot = async name => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))))
  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, name + '.png'), Buffer.from(image, 'base64'))
}
let project
const board = () => page.evaluate(id => window.conductor.projectTasks.get(id), project.id)
const taskRow = id => page.locator('.project-task[data-task-id="' + id + '"]')
const showTasks = async () => {
  const pane = page.locator('.project-backlog')
  if (!await pane.isVisible()) await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  await expect(pane).toBeVisible()
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.projectTasks?.edit))
  project = await page.evaluate(() => window.conductor.projects.create('Task controls smoke'))
  const fixture = '# Project tasks\n\n## Tasks\n- [ ] Task before <!-- conductor-task:task-before -->\n- [~] Existing multiline task <!-- conductor-task:moving agent=previous_worker priority=high weight=heavy source=smoke -->\n  \n  Original second paragraph.\n- [ ] Task after <!-- conductor-task:task-after -->\n\n## Bugs\n- [ ] Existing bug <!-- conductor-task:bug-sibling -->\n\n## Features\n- [ ] Existing feature <!-- conductor-task:feature-sibling -->\n\n## Ideas\n'
  await writeFile(join(project.path, 'feature-list.md'), fixture)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await showTasks()

  const initial = await board()
  const moving = initial.tasks.find(task => task.id === 'moving')
  assert.ok(moving)
  await taskRow(moving.id).locator('.project-task-title').click()
  const editor = page.getByRole('textbox', { name: 'Edit task', exact: true })
  const type = page.getByRole('combobox', { name: 'Edit task type', exact: true })
  await expect(editor).toHaveValue('Existing multiline task\n\nOriginal second paragraph.')
  await expect(type).toHaveValue('task')
  await type.selectOption('bug')
  const edited = 'Existing multiline task\n\nOriginal second paragraph.\nSaved through the UI.'
  await editor.fill(edited)
  await editor.press('Control+Enter')
  await expect(editor).toHaveCount(0)
  let saved = (await board()).tasks.find(task => task.id === moving.id)
  assert.deepEqual({ title: saved.title, kind: saved.kind, status: saved.status, agentId: saved.agentId, priority: saved.priority, weight: saved.weight }, { title: edited, kind: 'bug', status: 'doing', agentId: 'previous_worker', priority: 'high', weight: 'heavy' })
  let text = await readFile(join(project.path, 'feature-list.md'), 'utf8')
  assert.ok(text.includes('<!-- conductor-task:moving agent=previous_worker priority=high weight=heavy source=smoke -->'))
  assert.ok(text.indexOf('Task before') < text.indexOf('Task after'))
  assert.ok(text.indexOf('Existing bug') < text.indexOf('Existing multiline task'))
  assert.ok(text.indexOf('Existing multiline task') < text.indexOf('## Features'))
  check('Editing type moves one multiline task into the correct section without losing body, claim, status, priority, weight, unknown metadata, or sibling order')

  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await showTasks()
  saved = (await board()).tasks.find(task => task.id === moving.id)
  assert.equal(saved.title, edited)
  assert.equal(saved.kind, 'bug')
  await expect(taskRow(moving.id).locator('.project-task-kind')).toContainText('Bug')
  check('The edited kind and full multiline body survive a renderer reload and fresh backlog read')

  const priority = page.getByRole('slider', { name: 'New task priority', exact: true })
  const weight = page.getByRole('slider', { name: 'New task weight', exact: true })
  await expect(priority).toHaveAttribute('aria-valuetext', 'Normal')
  await priority.press('Home')
  await expect(priority).toHaveAttribute('aria-valuetext', 'Low')
  await priority.press('ArrowRight')
  await priority.press('End')
  await expect(priority).toHaveAttribute('aria-valuetext', 'High')
  const bounds = await weight.boundingBox()
  assert.ok(bounds)
  await page.mouse.click(bounds.x + 2, bounds.y + bounds.height / 2)
  await expect(weight).toHaveAttribute('aria-valuetext', 'Light')
  await page.mouse.click(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2)
  await expect(weight).toHaveAttribute('aria-valuetext', 'Heavy')
  check('Priority responds to keyboard input and weight responds to real pointer positions')

  await page.getByRole('combobox', { name: 'New task type', exact: true }).selectOption('idea')
  const input = page.getByRole('textbox', { name: 'New project task', exact: true })
  await input.fill('Sent with compact controls')
  const send = page.getByRole('button', { name: 'Add task', exact: true })
  assert.equal((await send.textContent()).trim(), '')
  assert.ok(await send.locator('svg').count())
  await send.click()
  await expect(input).toHaveValue('')
  const added = (await board()).tasks.find(task => task.title === 'Sent with compact controls')
  assert.deepEqual({ kind: added.kind, priority: added.priority, weight: added.weight }, { kind: 'idea', priority: 'high', weight: 'heavy' })
  text = await readFile(join(project.path, 'feature-list.md'), 'utf8')
  assert.match(text, /## Ideas[\s\S]*Sent with compact controls .*priority=high weight=heavy/)
  await shot('task-controls')
  check('The accessible icon-only send action saves the slider values and selected task type')
  assert.deepEqual(result.errors, [])
} catch (error) {
  result.errors.push(error.stack ?? String(error))
  process.exitCode = 1
  await shot('failure').catch(() => {})
} finally {
  await app.close()
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
