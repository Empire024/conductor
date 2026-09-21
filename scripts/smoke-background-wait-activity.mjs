// A conversation that backgrounded a command is not finished when its turn reports 'completed':
// the Bash call returned the moment the work was detached and the result followed behind it, so
// neither the tool row nor the turn lifecycle knows the render is still going. The tab has to keep
// saying so until the runtime's own background inventory is empty — and the turn the runtime then
// resumes by itself, with nothing of the owner's delivered into it, has to read as working.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-background-wait-'))
const output = resolve('artifacts/background-wait-activity')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_SMOKE_BACKGROUND_MS: '12000'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const checks = []
const pass = (name) => { checks.push(name); console.log('PASS ' + name) }
const errors = []

const launch = async () => {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.sidebar-section.projects-section').waitFor()
  const shot = async (name) => {
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'))
  }
  return { app, page, shot, row: (name) => page.locator('.project-row').filter({ hasText: name }) }
}

// The project list is read at launch, so the workspace this run drives has to exist before it.
let session = await launch()
try { await session.page.evaluate(() => window.conductor.projects.create('Render')) }
finally { await session.app.close().catch(() => {}) }

session = await launch()
const { app, page, shot, row } = session

try {
  await row('Render').click()

  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click()
  else { await page.locator('.pane-add-tab').click(); await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click() }
  await page.locator('.structured-agent-pane').last().waitFor()
  const agentId = await page.locator('.structured-agent-pane').last().getAttribute('data-structured-session')
  const snapshot = () => page.evaluate((id) => window.conductor.structured.snapshot(id), agentId)

  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await composer.fill('SYNTHETIC BASH WAIT: start the long render in the background.')
  await page.getByRole('combobox', { name: 'Model', exact: true }).click()
  await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  // The turn is over and the Bash row reports completed. The render is not over.
  await expect.poll(async () => (await snapshot())?.phase, { timeout: 20_000 }).toBe('completed')
  await expect.poll(async () => (await snapshot())?.backgroundTasks, { timeout: 20_000 }).toBe(1)
  await expect(page.locator('.workspace-tab-row .tab-activity.waiting_background')).toHaveCount(1)
  await expect(page.locator('.workspace-tab-row .tab-activity.complete')).toHaveCount(0)
  await expect(page.locator('.workspace-tab-row .tab-activity.waiting_background')).toHaveAttribute('title', 'Waiting on background work')
  await shot('tab-waiting-on-background-work')
  pass('A settled turn that left a backgrounded command running keeps the waiting indicator, not the checkmark')

  await expect(row('Render').locator('.session-activity-dot.done')).toHaveCount(0)
  await expect(row('Render').locator('.session-activity-dot.working')).toHaveCount(1)
  pass('Its workspace and project rows report working rather than finished')

  // The runtime resumes the conversation by itself when the task reports; nothing of the owner's
  // was delivered into that turn, and the tab used to sit idle through the whole of it.
  await expect(page.locator('.workspace-tab-row .tab-activity.working')).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(async () => (await snapshot())?.phase).toBe('running')
  await shot('tab-working-during-resumed-turn')
  pass('A turn the runtime resumes by itself reads as working while it streams')

  await expect(page.locator('.workspace-tab-row .tab-activity.complete')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.workspace-tab-row .tab-activity.waiting_background')).toHaveCount(0)
  await expect.poll(async () => (await snapshot())?.backgroundTasks).toBeUndefined()
  await expect(row('Render').locator('.session-activity-dot.done')).toHaveCount(1)
  await shot('tab-finished-once-inventory-drained')
  pass('The tab turns green only once the background inventory is empty')
} finally {
  await app.close().catch(() => {})
}

assert.deepEqual(errors, [])
console.log(JSON.stringify({ root, checks }, null, 2))
