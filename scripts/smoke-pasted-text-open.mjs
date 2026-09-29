import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Pasted text opens as a file (feature-list 21b9a1d6): a long paste folds into a chip; clicking
// it in the composer opens the text read-only in the document strip; after sending, the chip
// on the sent message opens it too, and still does after a reload with the file deleted (the
// text is kept as a conversation artifact). A throwaway test profile only; CONDUCTOR_TEST_USER_DATA
// parks the window off every display. Run through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-pasted-text-open.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-pasted-open-'))
const output = resolve('artifacts/pasted-text-open')
await mkdir(output, { recursive: true })
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  CONDUCTOR_BACKGROUND_WINDOWS: '1'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const PASTED = Array.from({ length: 40 }, (_, index) => `pasted line ${index + 1}: the owner wants to re-read this`).join('\n')
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = [], screenshots = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const shot = async (locator, name) => { const path = join(output, name + '.png'); await locator.screenshot({ path }); screenshots.push(path) }
const preview = page.locator('.workspace-files .text-preview')

try {
  await page.waitForFunction(() => Boolean(window.conductor?.files?.openPastedText))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))
  const project = await page.evaluate(() => window.conductor.projects.create('Pasted text smoke'))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Pasted text smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).first().click()
  const pane = page.locator('.structured-agent-pane').first()
  const composer = pane.locator('textarea').first()
  await expect(composer).toBeEnabled()
  const id = await pane.getAttribute('data-structured-session')

  await composer.click()
  await composer.pressSequentially('SYNTHETIC B keep ')
  await composer.evaluate((element, text) => { element.focus(); document.execCommand('insertText', false, text) }, PASTED)
  const draftChip = pane.locator('.sa-context-chips button').filter({ hasText: 'Pasted text #1: 40 lines' })
  await expect(draftChip).toBeVisible()
  await expect(composer).toHaveValue('SYNTHETIC B keep [Pasted text #1: 40 lines]')
  check('A 40-line paste folded into a chip')

  await draftChip.click()
  await expect(preview).toContainText('pasted line 40: the owner wants to re-read this')
  await shot(page, '1-draft-chip-opened')
  check('Clicking the draft chip opens the full text in a read-only preview')

  await composer.press('Enter')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), id))?.phase, { timeout: 30000 }).toBe('completed')
  const sentChip = pane.locator('.sa-message-attachments .sa-pasted-link').first()
  await expect(sentChip).toHaveText(/Pasted text #1: 40 lines/)
  const sent = await page.evaluate(id => window.conductor.structured.snapshot(id), id)
  const attachment = sent.items.find(item => item.data.type === 'text' && item.data.role === 'user').data.attachments[0]
  assert.ok(attachment.artifactId, 'the sent pasted text names its artifact')
  assert.equal(attachment.content, undefined, 'the timeline does not carry the text itself')
  check('The sent message keeps the chip, backed by a conversation artifact')

  await rm(join(project.path, '.conductor', 'pasted-text'), { recursive: true, force: true })
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Pasted text smoke' }).click()
  const reloadedChip = page.locator('.structured-agent-pane .sa-message-attachments .sa-pasted-link').first()
  await expect(reloadedChip).toBeVisible({ timeout: 20000 })
  await reloadedChip.click()
  await expect(preview).toContainText('pasted line 1: the owner wants to re-read this')
  await expect(preview).toContainText('pasted line 40: the owner wants to re-read this')
  await shot(page, '2-sent-chip-after-reload')
  check('After a reload, with the file deleted, the sent chip reopens the full text')
  assert.deepEqual(errors, [])
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, screenshots, errors }, null, 2))
  await app.close().catch(() => {})
}
