import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Raw synthetic Codex protocol -> production adapter -> SQLite -> production Electron renderer.
// All telemetry is deterministic fixture data. No provider credentials or inference are used.
const root = await mkdtemp(join(tmpdir(), 'conductor-telemetry-'))
const output = resolve('artifacts/backlog-followup')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Telemetry fixture'))
  await page.reload()
  await page.getByText('Telemetry fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) {
    await page.locator('.session-add').click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  }
  const pane = page.locator('.structured-agent-pane')
  await pane.waitFor()
  const sessionId = await pane.getAttribute('data-structured-session')
  await page.getByRole('button', { name: 'View usage', exact: true }).click()
  const usage = page.getByRole('dialog', { name: 'Usage', exact: true })
  await expect(usage).toContainText('Token usage has not been reported.')
  await page.getByRole('button', { name: 'Close Usage', exact: true }).click()
  results.checks.push('View usage is available in an empty tab and missing telemetry remains unknown')

  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('synthetic:telemetry')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.sa-live-tokens')).toHaveText('1,020 tokens', { timeout: 15000 })
  await expect(page.locator('.sa-subagent-summary')).toContainText('2 subagents · 2 running')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)).phase).toBe('running')
  results.checks.push('Running status displays live reported tokens; child usage does not inflate main totals')

  const timeline = page.locator('.sa-timeline')
  await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
  await writeFile(join(project.path, '.synthetic-telemetry-next'), 'Release second synthetic telemetry report.\n')
  await expect(page.locator('.sa-live-tokens')).toHaveText('1,100 tokens')
  await expect(page.locator('.sa-subagent-summary')).toContainText('2 subagents · 1 running · 1 completed')
  await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
  await expect(page.locator('.sa-jump')).toHaveCount(0)
  await page.screenshot({ path: join(output, 'telemetry-running.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/telemetry-running.png')
  results.checks.push('Live token count increments while running and existing bottom position follows new messages')

  await page.locator('.sa-subagent-summary').click()
  const roster = page.getByRole('dialog', { name: 'Subagents', exact: true })
  await expect(roster.locator('.sa-subagent-roster > li')).toHaveCount(2)
  await expect(roster.locator('.sa-subagent-state')).toHaveText(['Completed', 'Running'])
  await page.screenshot({ path: join(output, 'telemetry-subagents.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/telemetry-subagents.png')
  await page.getByRole('button', { name: 'Close Subagents', exact: true }).click()
  results.checks.push('Subagent roster shows each child once with its latest status')

  await page.getByRole('button', { name: 'View usage', exact: true }).click()
  await expect(usage).toBeVisible()
  await expect(usage).toContainText('Total tokens')
  await expect(usage).toContainText('1,100')
  await expect(usage).toContainText('Reasoning tokens')
  await expect(usage).toContainText('60')
  await expect(usage).toContainText('Cached input tokens')
  await expect(usage).toContainText('400')
  await expect(usage).toContainText('200,000 tokens')
  await expect(usage).toContainText('24% used')
  await expect(usage).toContainText('10% used')
  await expect(usage).not.toContainText('9,500')
  await page.screenshot({ path: join(output, 'telemetry-usage.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/telemetry-usage.png')
  await page.keyboard.press('Escape')
  await expect(usage).toHaveCount(0)
  results.checks.push('View usage exposes reasoning, cache, context and account windows; Escape closes details')

  await timeline.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await writeFile(join(project.path, '.synthetic-telemetry-finish'), 'Release final synthetic telemetry report.\n')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)).phase).toBe('completed')
  await expect(page.locator('.sa-subagent-summary')).toContainText('2 subagents · 1 completed · 1 failed')
  await expect(page.locator('.sa-jump')).toBeVisible()
  await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await expect(page.locator('.sa-jump')).toHaveCount(0)
  await expect(timeline).toContainText('Synthetic telemetry complete')
  await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
  await page.getByRole('button', { name: 'View usage', exact: true }).click()
  await expect(usage).toContainText('1,700')
  await page.getByRole('button', { name: 'Close Usage', exact: true }).click()
  results.checks.push('Completed and failed child statuses remain visible; scrolling back to bottom resumes latest messages without an extra click')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  const page = await app.firstWindow()
  await page.screenshot({ path: join(output, 'telemetry-failure.png'), fullPage: true }).catch(() => {})
  results.failureDom = await page.locator('body').innerText().catch(() => null)
  throw error
} finally {
  await writeFile(join(output, 'telemetry-results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
