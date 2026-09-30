import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The composer of a Claude wizard tab with Full Auto on (feature-list wizard-means-wizard): no
// banner, disclosure or status line above the textbox. Screenshots of the composer area go to
// artifacts/composer-clean/<label>. Throwaway parked profile; run through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-composer-clean.mjs [label]
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
// CONDUCTOR_SMOKE_REPORT_ONLY=1 takes the screenshots without asserting (a "before" build).
const label = process.argv[2] ?? 'after'
const reportOnly = process.env.CONDUCTOR_SMOKE_REPORT_ONLY === '1'
const root = await mkdtemp(join(tmpdir(), 'conductor-composer-clean-'))
const output = resolve('artifacts/composer-clean', label)
await mkdir(output, { recursive: true })
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  CONDUCTOR_BACKGROUND_WINDOWS: '1'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = [], screenshots = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = (ok, text) => { if (!reportOnly) assert.ok(ok, text); checks.push((ok ? 'PASS ' : 'FAIL ') + text); console.log((ok ? 'PASS ' : 'FAIL ') + text) }
const shot = async (locator, name) => { const path = join(output, name + '.png'); await locator.screenshot({ path }); screenshots.push(path) }

try {
  await page.waitForFunction(() => Boolean(window.conductor?.claudeFullAuto))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
  await page.evaluate(() => window.conductor.projects.create('Composer clean smoke'))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Composer clean smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  const textbox = page.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(textbox).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  // Full Auto on for the installation (a trusted click is required, so through the Settings card).
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Runtimes', exact: true }).click()
  await panel.getByRole('button', { name: "Enable Full Auto for Conductor's Claude workers", exact: true }).click()
  await expect.poll(async () => { const s = await page.evaluate(() => window.conductor.claudeFullAuto.state()); return s.enabled && !s.applying }, { timeout: 60000 }).toBe(true)
  await panel.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(panel).toBeHidden()
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B a live worker', { ...state.settings, permission: 'auto', plan: false, model: 'synthetic-claude', effort: 'low' }, [])
  }, id)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), id))?.phase, { timeout: 20000 }).toBe('completed')
  const pane = page.locator('.structured-agent-pane')
  const composer = pane.locator('form.sa-composer')
  await shot(composer, '1-composer-full-auto')

  const wand = pane.locator('.wizard-toggle')
  if (!await wand.isDisabled()) {
    await wand.click()
    await expect(wand).toHaveAttribute('aria-pressed', 'true')
  }
  await shot(composer, '2-composer-wizard')
  await shot(pane, '3-pane-wizard')

  check(await composer.locator('.sa-full-auto-details, .sa-full-auto-control').count() === 0, 'No Full Auto authorization disclosure in the composer')
  check(await composer.locator('.sa-request-summary').count() === 0, 'No permission status line above the textbox')
  const box = await composer.boundingBox(), area = await textbox.boundingBox()
  check(Boolean(box && area) && area.y - box.y < 40, `Textbox starts at the top of the composer (offset ${box && area ? Math.round(area.y - box.y) : '?'} px)`)
  // The settings card in Runtimes still owns the policy.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Runtimes', exact: true }).click()
  check(await panel.locator('.sa-full-auto-control').count() === 1, 'Full Auto stays controllable in Settings → Runtimes')
  if (!reportOnly) assert.deepEqual(errors, [])
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, screenshots, errors }, null, 2))
  await app.close().catch(() => {})
}
