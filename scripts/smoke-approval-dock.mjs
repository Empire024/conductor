import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Approvals do not get stuck in scrollback (owner, 2026-10-22: "approvals can get stuck in chat -
// and then when the agent is continuing, i gotta scroll up to even find em.. even if i click the
// bottom left one"). Raw offline Claude protocol (SYNTHETIC PERMISSION BUSY: the approval waits
// while the turn streams forty more tool calls) -> production adapter -> real React pane, parked
// off screen. Checks: the card is docked above the composer with live buttons, its timeline row
// only marks where it was asked, the dock stays in view wherever the timeline is scrolled, the
// sidebar's Needs attention row reveals it, and answering it from the dock clears the dock.
// The fixture never executes a command.
const root = await mkdtemp(join(tmpdir(), 'conductor-approval-dock-'))
const output = resolve('artifacts/approval-dock')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, checks: [], screenshots: [], failures: [], root }
let page
const shot = async name => { const path = join(output, name + '.png'); await page.screenshot({ path }); results.screenshots.push(path); return path }
try {
  page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  await page.evaluate(() => window.conductor.projects.create('Approval dock fixture'))
  await page.reload()
  await page.getByText('Approval dock fixture', { exact: true }).first().click()
  await launcherTile(page, 'Claude').click()
  const pane = page.locator('.structured-agent-pane').first()
  await pane.waitFor()
  const sessionId = await pane.getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
  const timeline = pane.locator('.sa-timeline')
  const dock = pane.locator('[data-interaction-dock]')
  const allow = dock.getByRole('button', { name: 'Allow once', exact: true })
  const inViewport = locator => locator.evaluate(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.top >= 0 && box.bottom <= window.innerHeight && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === element })

  // A new tab opens in Auto; the approval card belongs to Ask mode.
  await pane.getByRole('button', { name: 'Conversation mode', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /^Ask/ }).click()
  await expect(pane.getByRole('button', { name: 'Conversation mode', exact: true })).toContainText('Ask')
  await pane.getByRole('textbox', { name: /^Message / }).fill('SYNTHETIC PERMISSION BUSY')
  await pane.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(allow).toBeEnabled({ timeout: 15_000 })
  await expect.poll(async () => (await snapshot()).items.filter(item => item.data.type === 'tool' && item.nativeItemId?.startsWith('busy-tool-')).length, { timeout: 20_000 }).toBe(40)
  await expect(dock).toHaveAttribute('data-interaction-dock', '1')
  await expect(dock).toContainText('Approval waiting')
  assert.equal((await snapshot()).items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending').length, 1)
  await expect(timeline.locator('form.sa-interaction')).toHaveCount(0)
  await expect(timeline.locator('.sa-interaction-in-dock')).toHaveCount(1)
  await expect(timeline.locator('.sa-interaction-in-dock')).toContainText('Waiting for your approval above the message box')
  assert.equal(await inViewport(allow), true, 'Allow once is on screen at the live end')
  results.checks.push('After forty more tool calls the approval is docked above the composer with live buttons; its timeline row only marks where it was asked')
  await shot('docked-live-end')

  await timeline.evaluate(element => { element.scrollTop = 0 })
  await page.waitForTimeout(150)
  assert.equal(await inViewport(allow), true, 'Allow once stays on screen with the timeline scrolled to its top')
  const row = timeline.locator('.sa-interaction-in-dock')
  await row.scrollIntoViewIfNeeded()
  await row.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(pane.locator('.sa-interaction-dock-pulse')).toHaveCount(1, { timeout: 3000 })
  results.checks.push('The dock stays in view with the timeline scrolled away; the row\'s Show pulses it')
  await shot('docked-scrolled-up')

  const attention = page.locator('.needs-attention [data-attention-reason]').first()
  await attention.waitFor({ timeout: 20_000 })
  await expect(pane.locator('.sa-interaction-dock-pulse')).toHaveCount(0, { timeout: 4000 })
  await timeline.evaluate(element => { element.scrollTop = 0 })
  await attention.click()
  await expect(pane.locator('.sa-interaction-dock-pulse')).toHaveCount(1, { timeout: 3000 })
  assert.equal(await inViewport(allow), true, 'Allow once is on screen after the Needs attention click')
  results.checks.push(`Needs attention (${await attention.getAttribute('data-attention-reason')}) brings the docked approval into view and pulses it`)
  await shot('needs-attention-reveal')

  await pane.locator('.sa-attention-badge').click()
  await expect(pane.locator('.sa-interaction-dock-pulse')).toHaveCount(1, { timeout: 3000 })
  results.checks.push('The header\'s pending badge reveals the dock too')

  await allow.click()
  await expect.poll(async () => (await snapshot()).phase, { timeout: 15_000 }).toBe('completed')
  await expect(dock).toHaveCount(0)
  await expect(timeline.locator('.sa-interaction-in-dock')).toHaveCount(0)
  await expect(timeline.locator('.sa-interaction-resolved')).toHaveCount(1)
  assert.equal((await snapshot()).items.find(item => item.data.type === 'interaction').data.interaction.status, 'resolved')
  results.checks.push('Allow once from the dock resolves the request; the dock leaves and the timeline row reads as answered')
  await shot('answered')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  try { await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2)) }
  finally { await app.close() }
  console.log(JSON.stringify(results, null, 2))
}
