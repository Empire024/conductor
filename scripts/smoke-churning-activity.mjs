// A conversation that handed its work to a background subagent is still churning after its own
// turn reports 'completed'. Neither its tab nor its project may claim it finished until the
// child reports back — including from another project, where only the main process can answer.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-churning-activity-'))
const output = resolve('artifacts/churning-activity')
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

let session = await launch()
try {
  await session.page.evaluate(() => window.conductor.projects.create('Alpha'))
  await session.page.evaluate(() => window.conductor.projects.create('Beta'))
} finally {
  await session.app.close().catch(() => {})
}

session = await launch()
const { app, page, shot, row } = session
try {
  await row('Beta').click()

  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click()
  else { await page.locator('.pane-add-tab').click(); await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click() }
  await page.locator('.structured-agent-pane').last().waitFor()
  const agentId = await page.locator('.structured-agent-pane').last().getAttribute('data-structured-session')

  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await composer.fill('SYNTHETIC BACKGROUND: dispatch a worker and report back when it finishes.')
  await page.getByRole('combobox', { name: 'Model', exact: true }).click()
  await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  // The conversation's own turn is over; its background child is not.
  await expect.poll(async () => (await page.evaluate((id) => window.conductor.structured.snapshot(id), agentId))?.phase, { timeout: 20_000 }).toBe('completed')
  await expect(page.locator('.workspace-tab-row .tab-activity.working')).toHaveCount(1)
  await expect(page.locator('.workspace-tab-row .tab-activity.complete')).toHaveCount(0)
  await shot('tab-still-working')
  pass('The tab of a conversation whose background subagent is still running keeps its working indicator')

  await expect(row('Beta').locator('.session-activity-dot.done')).toHaveCount(0)
  await expect(row('Beta').locator('.session-activity-dot.working')).toHaveCount(1)
  pass('Its workspace and project rows report working, not finished')

  // Leaving for Alpha unmounts every Beta pane, so only the main process can answer for its row.
  await row('Alpha').click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  await expect(row('Beta').locator('.session-activity-dot.done')).toHaveCount(0)
  await expect(row('Beta').locator('.session-activity-dot.working')).toHaveCount(1)
  await shot('beta-working-from-alpha')
  pass('A project that is not open never rolls up green while an agent in it is still churning')

  // Once the child reports back, nothing is left to wait for.
  await expect(row('Beta').locator('.session-activity-dot.done')).toHaveCount(1, { timeout: 30_000 })
  await expect(row('Beta').locator('.session-activity-dot.working')).toHaveCount(0)
  await shot('beta-done-after-child')
  pass('The project reports finished as soon as the background subagent reports back')

  await row('Beta').click()
  await page.locator('.structured-agent-pane').first().waitFor({ state: 'attached' })
  await expect(page.locator('.workspace-tab-row .tab-activity.complete')).toHaveCount(1)
  pass('The tab settles to finished with the project, once its child is done')
} finally {
  await app.close().catch(() => {})
}

assert.deepEqual(errors, [])
console.log(JSON.stringify({ root, checks }, null, 2))
