import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Token burn meter (feature-list codex-credit-burn 2): a Codex tab whose synthetic relay turn
// reports 6.4M tokens gets the flame badge on the tab strip and a notice, Settings > Usage lists
// it, and raising the alert rate clears the badge. A throwaway test profile only;
// CONDUCTOR_TEST_USER_DATA parks the window off every display. Run through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-token-burn.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-token-burn-'))
const output = resolve('artifacts/token-burn')
await mkdir(output, { recursive: true })
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  CONDUCTOR_BACKGROUND_WINDOWS: '1', CONDUCTOR_TEST_TOKEN_BURN_MS: '1000'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = [], screenshots = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const shot = async (locator, name) => { const path = join(output, name + '.png'); await locator.screenshot({ path }); screenshots.push(path) }

try {
  await page.waitForFunction(() => Boolean(window.conductor?.tokenBurn))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))
  assert.equal(await page.evaluate(() => window.conductor.tokenBurn.alertPerHour()), 5_000_000, 'A fresh profile alerts at 5M tokens an hour')
  await page.evaluate(() => window.conductor.projects.create('Token burn smoke'))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Token burn smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).first().click()
  const pane = page.locator('.structured-agent-pane').first()
  await expect(pane).toBeVisible()
  const id = await pane.getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'synthetic:token-burn', state.settings, [])
  }, id)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), id))?.phase, { timeout: 30000 }).toBe('completed')
  check('A Codex relay turn reported 6.4M input tokens')

  const snapshot = await expect.poll(async () => (await page.evaluate(() => window.conductor.tokenBurn.snapshot())).rates.find(rate => rate.agentSessionId === id)?.tokensPerHour ?? 0, { timeout: 15000 }).toBe(6_420_000).then(() => page.evaluate(() => window.conductor.tokenBurn.snapshot()))
  const rate = snapshot.rates.find(entry => entry.agentSessionId === id)
  assert.equal(rate.alert, true)
  assert.equal(rate.cachedPerHour, 6_000_000)
  check(`The meter measured ${rate.tokensPerHour} tokens/h (${rate.reports} report), alert on`)

  const tab = page.locator(`[data-control-agent-id="${id}"]`).first()
  const badge = tab.locator('.pane-tab-burn')
  await expect(badge).toBeVisible({ timeout: 10000 })
  await expect(badge).toHaveText('6.4M/h')
  await expect(page.locator('.app-toast')).toContainText('is burning 6.4M/h tokens')
  await shot(page.locator('.pane-tabs').first(), '1-tab-badge')
  check('The tab shows a 6.4M/h flame and a notice announced the crossing')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Usage', exact: true }).click()
  const setting = panel.locator('.token-burn-setting')
  await expect(setting.locator(`li[data-agent-session-id="${id}"]`)).toHaveClass(/alert/)
  await expect(setting.locator(`li[data-agent-session-id="${id}"] .token-burn-rate`)).toHaveText('6.4M/h')
  await shot(setting, '2-settings-meter')
  check('Settings > Usage lists the tab at 6.4M/h, marked as alerting')

  await setting.getByRole('combobox', { name: 'Token burn alert' }).selectOption('10000000')
  await expect.poll(() => page.evaluate(() => window.conductor.tokenBurn.alertPerHour())).toBe(10_000_000)
  await expect(setting.locator(`li[data-agent-session-id="${id}"]`)).not.toHaveClass(/alert/)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(badge).toBeHidden()
  await shot(page.locator('.pane-tabs').first(), '3-badge-cleared')
  check('Raising the alert to 10M/h clears the badge')
  assert.deepEqual(errors, [])
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, screenshots, errors }, null, 2))
  await app.close().catch(() => {})
}
