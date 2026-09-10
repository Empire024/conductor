import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Raw synthetic Codex protocol -> production adapter -> SQLite -> production Electron renderer.
// The usage cap itself is written through the real IPC bridge (window.conductor.usageCaps),
// exactly what the owner's own "Usage & limits" panel calls -- nothing here is faked.
const root = await mkdtemp(join(tmpdir(), 'conductor-usage-warning-'))
const output = resolve('artifacts/backlog-followup')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Usage warning fixture'))
  await page.reload()
  await page.getByText('Usage warning fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) {
    await page.locator('.session-add').click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  }
  const pane = page.locator('.structured-agent-pane')
  await pane.waitFor()
  const sessionId = await pane.getAttribute('data-structured-session')

  await expect(page.locator('.sa-usage-warning')).toHaveCount(0)
  results.checks.push('No warning before any usage cap is configured')

  // A token cap set above the fixture's own final total (1,700) so the cap is never itself
  // "reached" -- this exercises only the pre-emptive warning, not the separate hard-stop
  // enforcement a reached cap would trigger.
  await page.evaluate((id) => window.conductor.usageCaps.write('tab', id, { metric: 'tokens', limit: 1800, basis: 'conversation' }), sessionId)
  results.checks.push('Tab-scoped token cap written through the real usage-cap IPC bridge')

  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('synthetic:telemetry')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.sa-live-tokens')).toHaveText('20 output tokens', { timeout: 15000 })
  await expect(page.locator('.sa-usage-warning')).toHaveCount(0)
  results.checks.push('Still silent well below the cap (20 of 1,800 tokens)')

  await writeFile(join(project.path, '.synthetic-telemetry-next'), 'Release second synthetic telemetry report.\n')
  await expect(page.locator('.sa-live-tokens')).toHaveText('100 output tokens', { timeout: 15000 })
  // Conversation total is 1,100 here (61% of the 1,800 cap) -- below the 70% "approaching" floor.
  await expect(page.locator('.sa-usage-warning')).toHaveCount(0)
  results.checks.push('Still silent at 1,100 of 1,800 tokens (61%, below the 70% approaching floor)')

  await writeFile(join(project.path, '.synthetic-telemetry-finish'), 'Release final synthetic telemetry report.\n')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)).phase, { timeout: 15000 }).toBe('completed')
  const warning = page.locator('.sa-usage-warning')
  await expect(warning).toBeVisible()
  await expect(warning).toHaveClass(/level-high/)
  await expect(warning).toContainText('Expensive')
  await expect(warning).toHaveAttribute('title', /1,700 of 1,800 capped tokens/)
  results.checks.push('Composer control line shows a visible, in-line "Expensive" warning at 1,700 of 1,800 tokens (94%) -- not hidden behind View usage')
  await page.screenshot({ path: join(output, 'usage-warning-tab-high.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/usage-warning-tab-high.png')

  // The Processes summary in the sidebar footer reads the same real IPC channels
  // (structured.snapshot + usageCaps.read) on its own poll, independent of the open tab.
  const processesWarning = page.locator('.process-status-summary-warning')
  await expect(processesWarning).toBeVisible({ timeout: 10000 })
  await expect(processesWarning).toHaveClass(/level-high/)
  const expensiveRow = page.locator('.process-status-summary-row.level-high')
  await expect(expensiveRow).toBeVisible()
  await expect(expensiveRow).toHaveAttribute('title', /getting expensive/i)
  results.checks.push('Processes summary in the sidebar shows the same project as expensive, at a glance and across projects')
  await page.screenshot({ path: join(output, 'usage-warning-processes-high.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/usage-warning-processes-high.png')

  // Clearing the cap removes the only figure this conversation has to warn on (the synthetic
  // Codex fixture never reports cost), so both warnings must fully clear, not just downgrade.
  await page.evaluate((id) => window.conductor.usageCaps.write('tab', id, null), sessionId)
  await expect(page.locator('.sa-usage-warning')).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('.process-status-summary-warning')).toHaveCount(0, { timeout: 10000 })
  results.checks.push('Clearing the cap clears both warnings -- the tab pill and the Processes badge -- without a reload')

  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  const page = await app.firstWindow()
  await page.screenshot({ path: join(output, 'usage-warning-failure.png'), fullPage: true }).catch(() => {})
  results.failureDom = await page.locator('body').innerText().catch(() => null)
  throw error
} finally {
  await writeFile(join(output, 'usage-warning-results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
