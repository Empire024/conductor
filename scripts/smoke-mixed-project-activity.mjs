// A project whose tabs are a MIX of live work and a tab that lost its connection must read as
// working: the owner can see the running agent, so a warning colour on the project row is a lie
// about the project as a whole. The disconnected tab keeps its own warning, and a project with
// nothing left running still falls back to it.
//
// Same harness as smoke-project-activity.mjs: synthetic Claude fixture -> production adapter ->
// SQLite -> the real Electron UI. Every launch here sets CONDUCTOR_TEST_USER_DATA, so the window
// is parked far off-screen and never takes focus.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-mixed-activity-'))
const output = resolve('artifacts/mixed-project-activity')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  // Long enough that no background worker reports back during the run: every tab that is meant
  // to be working stays working for the whole script.
  CONDUCTOR_SMOKE_BACKGROUND_MS: '600000'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const errors = []
const failures = []
const observed = {}
const check = (name, actual, expected) => {
  observed[name] = actual
  if (actual === expected) console.log(`PASS ${name}: ${actual}`)
  else { failures.push(`${name}: expected ${expected}, observed ${actual}`); console.log(`FAIL ${name}: expected ${expected}, observed ${actual}`) }
}

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
  // What the sidebar actually paints for a row: the attention bell, or the activity dot's own
  // state class, or nothing at all.
  const stateOf = async (locator) => {
    if (await locator.locator('.session-attention-badge').count()) return 'attention'
    const classes = await locator.locator('.session-activity-dot').evaluateAll((nodes) => nodes.map((node) => node.className))
    if (!classes.length) return 'none'
    return classes.map((value) => value.replace('session-activity-dot', '').trim()).join('+')
  }
  const projectState = () => stateOf(row('Beta'))
  const workspaceState = (index) => stateOf(page.locator('.sidebar-session-row').nth(index))

  const startClaudePane = async () => {
    if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click()
    else { await page.locator('.pane-add-tab').first().click(); await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).click() }
    await page.locator('.structured-agent-pane').last().waitFor()
    return page.locator('.structured-agent-pane').last().getAttribute('data-structured-session')
  }
  // A turn that hands its work to a background worker: its own turn reports 'completed' while the
  // conversation keeps working, which is a tab that is unambiguously live with no approval
  // pending to muddy the project row.
  const sendBackground = async (id) => {
    const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
    await composer.fill('SYNTHETIC BACKGROUND: dispatch a worker and report back when it finishes.')
    await page.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((value) => window.conductor.structured.snapshot(value), id))?.phase, { timeout: 20_000 }).toBe('completed')
  }
  const phaseOf = (id) => page.evaluate((value) => window.conductor.structured.snapshot(value), id).then((state) => state?.phase)
  // Closing a workspace kills its runtimes, which is a real lost connection for a conversation
  // that was still in flight; bringing the workspace back puts that tab on screen again, exactly
  // as the owner sees it after a runtime drops.
  const dropAndRestore = async (index, expectedTabs) => {
    await page.locator('.session-tab').nth(index).locator('.session-tab-close').click()
    await expect(page.locator('.session-tab')).toHaveCount(expectedTabs - 1)
    await page.keyboard.press('Control+Shift+Z')
    await expect(page.locator('.session-tab')).toHaveCount(expectedTabs)
  }

  await row('Beta').click()
  const working = await startClaudePane()
  await sendBackground(working)
  await expect(page.locator('.pane-tab .tab-activity.working')).toHaveCount(1)
  check('project with one working tab', await projectState(), 'working')

  await page.locator('.session-add').click()
  await expect(page.locator('.session-tab')).toHaveCount(2)
  const dropped = await startClaudePane()
  await sendBackground(dropped)
  await dropAndRestore(1, 2)
  await expect.poll(() => phaseOf(dropped)).toBe('disconnected')
  await expect(page.locator('.pane-tab .tab-activity.disconnected')).toHaveCount(1)
  check('the tab that lost its connection still warns on its own', await phaseOf(dropped), 'disconnected')

  // One workspace working, another holding the disconnected tab.
  check('project mixing a working workspace with a disconnected one', await projectState(), 'working')
  await shot('mixed-across-workspaces')

  // ...and the same mix inside a single workspace: the restored workspace gets a second, live tab.
  const alsoWorking = await startClaudePane()
  await sendBackground(alsoWorking)
  await expect(page.locator('.pane-tab .tab-activity.working')).toHaveCount(1)
  await expect(page.locator('.pane-tab .tab-activity.disconnected')).toHaveCount(1)
  check('workspace mixing a working tab with a disconnected one', await workspaceState(1), 'working')
  check('project of that workspace', await projectState(), 'working')
  await shot('mixed-within-one-workspace')

  // Leaving for Alpha unmounts every Beta pane, so only the main process can answer for its row.
  await row('Alpha').click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  check('project rolled up by the main process while its panes are closed', await projectState(), 'working')
  await shot('mixed-from-another-project')

  // Nothing left running: the disconnected warning is only outranked, never lost.
  await row('Beta').click()
  await page.locator('.structured-agent-pane').first().waitFor({ state: 'attached' })
  await dropAndRestore(1, 2)
  await dropAndRestore(0, 2)
  await expect.poll(() => phaseOf(working)).toBe('disconnected')
  await expect.poll(() => phaseOf(alsoWorking)).toBe('disconnected')
  check('project whose tabs are all disconnected', await projectState(), 'waiting')
  await shot('all-disconnected')

  await row('Alpha').click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  check('all-disconnected project rolled up by the main process', await projectState(), 'waiting')
} finally {
  await app.close().catch(() => {})
}

console.log(JSON.stringify({ root, observed, failures, errors }, null, 2))
assert.deepEqual(failures, [])
assert.deepEqual(errors, [])
