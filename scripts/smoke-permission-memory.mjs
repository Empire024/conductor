import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Real production Claude/Codex adapters over the synthetic offline fixtures; no network egress.
// Confirms the owner's remembered permission mode: switching a Claude tab to Auto must carry into
// the next manually opened Claude tab without asking again, and must never leak into a Codex tab,
// which does not offer these modes at all (see permission-memory.ts and structured-sessions.ts).
const root = await mkdtemp(join(tmpdir(), 'conductor-permission-memory-'))
const output = resolve('artifacts/permission-memory')
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Permission memory fixture'))
  await page.reload()
  await page.getByText('Permission memory fixture', { exact: true }).first().click()

  const visible = () => page.locator('.pane-tab-content:visible')
  const activePane = () => visible().locator('.structured-agent-pane')
  const modeButton = () => activePane().getByRole('button', { name: 'Conversation mode', exact: true })
  const snapshot = id => page.evaluate(agent => window.conductor.structured.snapshot(agent), id)

  // First Claude tab: opens on Ask (no remembered mode exists yet), then the owner switches it
  // to Auto through the real Conversation-mode menu (a role=menu of role=menuitemradio options,
  // not a plain button).
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await activePane().waitFor()
  const firstId = await activePane().getAttribute('data-structured-session')
  assert.equal((await snapshot(firstId)).settings.permission, 'default')
  await expect(modeButton()).toHaveText('Ask')
  await modeButton().click()
  await activePane().getByRole('menuitemradio', { name: /Auto/ }).click()
  await expect.poll(async () => (await snapshot(firstId)).settings.permission).toBe('auto')
  await expect(modeButton()).toHaveText('Auto')
  results.checks.push('Switching a Claude tab to Auto persists that mode on its own conversation')

  // Second, manually opened Claude tab: must open already on Auto, without the owner choosing
  // again and without ever asking (no pending approval/interaction should appear).
  await page.locator('.pane-add-tab').click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await activePane().waitFor()
  const secondId = await activePane().getAttribute('data-structured-session')
  assert.notEqual(secondId, firstId, 'the launcher must have opened a second, independent conversation')
  await expect(modeButton()).toHaveText('Auto')
  assert.equal((await snapshot(secondId)).settings.permission, 'auto')
  results.checks.push('A second, manually opened Claude tab remembers the owner\'s last chosen mode without asking again')
  await page.screenshot({ path: join(output, 'second-claude-tab-auto.png'), fullPage: true })

  // A Codex tab must never inherit a Claude-only mode it cannot honour. Codex has no Auto/Edit
  // mode picker at all (its real capabilities report plans:false), so there is no menu to assert
  // against; the underlying settings are the only thing that could leak the remembered mode.
  await page.locator('.pane-add-tab').click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  await activePane().waitFor()
  const codexId = await activePane().getAttribute('data-structured-session')
  assert.notEqual(codexId, secondId)
  await expect(modeButton()).toHaveCount(0)
  assert.equal((await snapshot(codexId)).settings.permission, 'default')
  results.checks.push('A Codex tab never inherits Claude\'s remembered Auto mode, which it cannot offer')

  // Reopening the app (a fresh renderer/main process against the same profile) must still open a
  // brand-new Claude tab on Auto: the preference is durable, not merely an in-memory carryover.
  await app.close()
  const restarted = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  try {
    const restartedPage = await restarted.firstWindow()
    await restartedPage.waitForFunction(() => Boolean(window.conductor?.structured))
    await restartedPage.getByText('Permission memory fixture', { exact: true }).first().click()
    await restartedPage.locator('.pane-add-tab').click()
    await restartedPage.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const restartedPane = restartedPage.locator('.pane-tab-content:visible').locator('.structured-agent-pane')
    await restartedPane.waitFor()
    await expect(restartedPane.getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Auto')
    const thirdId = await restartedPane.getAttribute('data-structured-session')
    assert.equal((await restartedPage.evaluate(id => window.conductor.structured.snapshot(id), thirdId)).settings.permission, 'auto')
    results.checks.push('The remembered mode survives an app restart, so it is a durable preference and not just in-memory state')
  } finally {
    await restarted.close()
  }

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
