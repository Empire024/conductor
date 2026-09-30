import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Full Auto state card (feature-list full-auto-ui-redesign): off/on/tab list/disclosure, in a
// throwaway test profile only. CONDUCTOR_TEST_USER_DATA parks the window off every display and
// the policy written here never touches the owner's installation. Run through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-full-auto-card.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-full-auto-card-'))
const output = resolve('artifacts/full-auto-card')
await mkdir(output, { recursive: true })
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  CONDUCTOR_BACKGROUND_WINDOWS: '1'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const ENABLE = "Enable Full Auto for Conductor's Claude workers"
const DISABLE = 'Disable Full Auto for Claude workers'
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = [], screenshots = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const shot = async (locator, name) => { const path = join(output, name + '.png'); await locator.screenshot({ path }); screenshots.push(path) }
const policy = () => page.evaluate(() => window.conductor.claudeFullAuto.state())

try {
  await page.waitForFunction(() => Boolean(window.conductor?.claudeFullAuto))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))
  assert.equal((await policy()).enabled, false, 'A fresh test profile starts without Full Auto')
  await page.evaluate(() => window.conductor.projects.create('Full Auto card smoke'))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Full Auto card smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.rename?.(id, 'Card fixture worker')
    await window.conductor.structured.submit(id, 'SYNTHETIC B a live worker', { ...state.settings, permission: 'auto', plan: false, model: 'synthetic-claude', effort: 'low' }, [])
  }, id)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), id))?.phase, { timeout: 20000 }).toBe('completed')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Runtimes', exact: true }).click()
  const card = panel.locator('.sa-full-auto-control')
  await expect(card).toHaveAttribute('data-state', 'off')
  await expect(card.locator('.sa-full-auto-badge')).toHaveText('Off')
  await expect(card.locator('.sa-full-auto-explain')).not.toHaveAttribute('open', '')
  await expect(card.locator('.sa-full-auto-explain p').first()).toBeHidden()
  await shot(card, '1-off')
  check('Off state: badge Off, Guarded Auto line, explanation collapsed')

  // Synthetic DOM replay still cannot authorize.
  await card.evaluate(element => element.querySelector('button').click())
  assert.equal((await policy()).enabled, false)
  check('Synthetic click on the card toggle does not authorize Full Auto')

  await card.getByRole('button', { name: ENABLE, exact: true }).click()
  await expect.poll(async () => { const s = await policy(); return s.enabled && !s.applying }, { timeout: 60000 }).toBe(true)
  await expect(card).toHaveAttribute('data-state', 'on')
  await expect(card.locator('.sa-full-auto-badge')).toHaveText('On')
  await expect(card.locator('.sa-full-auto-title small')).toContainText('Authorized since')
  await expect(card.getByRole('button', { name: DISABLE, exact: true })).toBeVisible()
  const listed = await expect.poll(async () => card.locator('.sa-full-auto-tabs li').count(), { timeout: 30000 }).toBeGreaterThan(0).then(() => true, () => false)
  await shot(card, '2-on')
  await shot(panel, '2-on-settings-page')
  check(`On state: badge On, authorized since, disable action; confirmed tabs listed: ${listed ? await card.locator('.sa-full-auto-tabs li').allTextContents() : 'none (fixture did not confirm bypassPermissions)'}`)

  await card.locator('.sa-full-auto-explain summary').click()
  await expect(card.locator('.sa-full-auto-explain p').first()).toContainText('bypassPermissions')
  await shot(card, '3-on-explained')
  check('Explanation opens behind the disclosure')

  // The composer carries no Full Auto disclosure (wizard-means-wizard): the card is here only.
  assert.equal(await page.locator('.structured-agent-pane .sa-full-auto-control').count(), 0)
  check('No Full Auto card in the conversation composer')

  await card.getByRole('button', { name: DISABLE, exact: true }).click()
  await expect.poll(async () => { const s = await policy(); return !s.enabled && !s.applying }, { timeout: 60000 }).toBe(true)
  await expect(card).toHaveAttribute('data-state', 'off')
  await shot(card, '5-off-again')
  check('Disable returns the card to Off')
  assert.deepEqual(errors, [])
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, screenshots, errors }, null, 2))
  await app.close().catch(() => {})
}
