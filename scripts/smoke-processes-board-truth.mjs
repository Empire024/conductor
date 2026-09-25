// The Processes board must tell a settled conversation from a working one (feature-list.md:
// processes-board-stale-working, token-accounting-repeated-context). Two fixture coworkers:
//  - one whose turn settled while a backgrounded command still runs: "Viewing", never "Working";
//  - one that finished normally, whose persisted runtime row is then left saying 'working' - the
//    state the owner's own database held for W12/W14/W17 hours after they finished (a detached
//    subagent that never reported its end). It must read "Finished" with its age.
// The finished one replays cached Claude usage, so its headline must be processed tokens (new
// input + cache write + output), not the context it re-read on every message.
// Run through: node scripts/smoke-lock.mjs -- node scripts/smoke-processes-board-truth.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-board-truth-'))
const output = resolve('artifacts/processes-board-truth')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_USER_DATA: profile,
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  // The backgrounded render outlives the whole run.
  CONDUCTOR_SMOKE_BACKGROUND_MS: '600000'
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
try { await session.page.evaluate(() => window.conductor.projects.create('Board truth')) }
finally { await session.app.close().catch(() => {}) }

session = await launch()
const { app, page, shot, row } = session

try {
  await row('Board truth').click()
  const startTab = async (prompt) => {
    if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click()
    else { await page.locator('.pane-add-tab').first().click(); await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click() }
    const pane = page.locator('.structured-agent-pane').last()
    await pane.waitFor()
    const id = await pane.getAttribute('data-structured-session')
    await pane.getByRole('textbox', { name: /message|prompt/i }).fill(prompt)
    await pane.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
    await pane.getByRole('button', { name: 'Send message', exact: true }).click()
    return id
  }
  const snapshot = (id) => page.evaluate((agentId) => window.conductor.structured.snapshot(agentId), id)

  const viewingId = await startTab('SYNTHETIC BASH WAIT: start the long render in the background.')
  await expect.poll(async () => (await snapshot(viewingId))?.phase, { timeout: 20_000 }).toBe('completed')
  await expect.poll(async () => (await snapshot(viewingId))?.backgroundTasks, { timeout: 20_000 }).toBe(1)

  const finishedId = await startTab('SYNTHETIC LONG 40')
  await expect.poll(async () => (await snapshot(finishedId))?.phase, { timeout: 30_000 }).toBe('completed')
  assert.equal((await snapshot(finishedId))?.backgroundTasks ?? 0, 0)

  // Leave the finished coworker's persisted row exactly as the owner's database had it.
  const db = new DatabaseSync(join(profile, 'conductor.db'))
  try { db.prepare("UPDATE agent_sessions SET status = 'running', activity_phase = 'working' WHERE id = ?").run(finishedId) }
  finally { db.close() }

  await page.getByRole('button', { name: 'Processes', exact: true }).click()
  const board = page.locator('.pd-dashboard').first()
  await board.waitFor()
  const boardRow = (id) => board.locator(`[data-process-id="${id}"]`)
  await expect(boardRow(viewingId).locator('.pd-state strong')).toHaveText('Viewing', { timeout: 15_000 })
  await expect(boardRow(viewingId).locator('.pd-state-marker')).toHaveClass(/viewing/)
  pass('A settled coworker whose backgrounded command still runs reads Viewing, not Working')

  // The board polls the persisted rows every 2.5 s; give it two rounds to read the stale one.
  await page.waitForTimeout(6000)
  await expect(boardRow(finishedId).locator('.pd-state strong')).toHaveText('Finished')
  await expect(boardRow(finishedId).locator('.pd-state small')).toHaveText(/ago$/)
  await expect(board.locator('.pd-row.state-working')).toHaveCount(0)
  pass('A finished coworker whose persisted row still says working reads Finished with its age')

  // 20 messages each re-reading ~20k of cache: the provider total is ~400k+, processed is ~7k.
  const usage = boardRow(finishedId).locator('.pd-usage')
  const headline = await usage.locator('strong').textContent()
  const detail = await usage.locator('small').textContent()
  const title = await usage.getAttribute('title')
  console.log(JSON.stringify({ headline, detail, title }))
  assert.match(headline ?? '', /^\d+(\.\d)?k tok$/, `headline ${headline}`)
  assert.ok(parseFloat(headline) < 20, `processed headline must leave out the re-read context: ${headline}`)
  assert.match(detail ?? '', /out · .*cache reads/)
  assert.match(title ?? '', /Cache reads [\d,]+ \(≈ [\d,]+ billed-equivalent\)/)
  await expect(board.locator('.pd-overview')).toContainText('Processed tokens')
  await expect(board.locator('.pd-overview')).toContainText('Output tokens')
  pass('The usage headline is processed tokens, with output and cache reads shown beside it')
  await shot('processes-board-truth')
} finally {
  await app.close().catch(() => {})
}

assert.deepEqual(errors, [])
console.log(JSON.stringify({ root, checks }, null, 2))
