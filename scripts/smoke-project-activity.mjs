// Cross-project activity: a project row must reflect what its agents are doing even when that
// project is not the open one, and after a relaunch that never mounts its panes.
import { _electron as electron, expect } from '@playwright/test'
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-project-activity-'))
const output = resolve('artifacts/project-activity')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const checks = []
const pass = (name) => { checks.push(name); console.log('PASS ' + name) }
const errors = []

const launch = async () => {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
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
  const beta = await session.page.evaluate(() => window.conductor.projects.create('Beta'))
  // The synthetic Claude fixture edits these exact bytes; without them its turn fails instead
  // of reaching an approval.
  await writeFile(join(beta.path, 'panel.mjs'), (await readFile(resolve('scripts/fixtures/panel.mjs'), 'utf8')).replace(/\r\n/g, '\n'))
  await copyFile(resolve('scripts/fixtures/panel.test.mjs'), join(beta.path, 'panel.test.mjs'))
} finally {
  await session.app.close().catch(() => {})
}

session = await launch()
try {
  const { page, row, shot } = session
  const startClaudePane = async () => {
    if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click()
    else { await page.locator('.pane-add-tab').click(); await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click() }
    await page.locator('.structured-agent-pane').last().waitFor()
    return page.locator('.structured-agent-pane').last().getAttribute('data-structured-session')
  }
  const send = async () => {
    const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
    await composer.fill('SYNTHETIC A: remove the two unused declarations, then run node --test panel.test.mjs once.')
    await page.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 20_000 })
  }

  await row('Beta').click()
  const finished = await startClaudePane()
  await send()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(async () => (await page.evaluate((id) => window.conductor.structured.snapshot(id), finished))?.phase, { timeout: 20_000 }).toBe('completed')

  // Leave for Alpha: Beta's panes unmount, and the only thing that can still answer for its row
  // is the main process.
  await row('Alpha').click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  await expect(row('Beta').locator('.session-activity-dot.done')).toHaveCount(1)
  await shot('beta-done-from-alpha')
  pass('A project that is not open reports the agent that finished in it')

  // A second workspace tab in Beta, blocked on an approval: needing attention outranks the
  // conversation that already finished.
  await row('Beta').click()
  await startClaudePane()
  await send()
  await row('Alpha').click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  await expect(row('Beta').locator('.session-attention-badge')).toHaveCount(1)
  await shot('beta-needs-attention-from-alpha')
  pass('Several agents in different states roll up to the most urgent one, from another project')
} finally {
  await session.app.close().catch(() => {})
}

session = await launch()
try {
  const { page, row, shot } = session
  // Nothing in this launch ever mounted a pane for Beta: the row is answered from persisted
  // backend state, not from events this window happened to see. Quitting mid-approval left no
  // live runtime, so nothing may still claim attention or claim to be working; the two
  // conversations the quit disconnected read as waiting on you, exactly as their panes would.
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  await expect(row('Beta').locator('.session-attention-badge')).toHaveCount(0)
  await expect(row('Beta').locator('.session-activity-dot.working')).toHaveCount(0)
  await expect(row('Beta').locator('.session-activity-dot.waiting')).toHaveCount(1)
  await shot('beta-after-relaunch')
  pass('A project whose panes were never mounted this launch still reports its agents, without stale working or attention state')

  // Opening the project must not change the answer: the mounted panes agree with the backend.
  await row('Beta').click()
  await page.locator('.structured-agent-pane').first().waitFor({ state: 'attached' })
  await expect(row('Beta').locator('.session-activity-dot.waiting')).toHaveCount(1)
  pass('Mounting the project reports the same status the backend already showed')
} finally {
  await session.app.close().catch(() => {})
}

assert.deepEqual(errors, [])
console.log(JSON.stringify({ root, checks }, null, 2))
