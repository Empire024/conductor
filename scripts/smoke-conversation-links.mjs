import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// The links & files rail (feature-list e90b679f): an agent reply with links, a file mention and a
// closing plain-text question shows in the rail beside the timeline. A row jumps to its message,
// Open opens the file, and "Asked you" can be dismissed; the rail stays open across a tab switch
// that unmounts the conversation view. Real Electron main/renderer; only the provider is the
// synthetic Claude fixture (no inference). Parked window; nothing opens an external browser.
// Run after a build, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-conversation-links.mjs
// CONDUCTOR_SMOKE_MAIN points it at another build's out/main/index.js.
const root = await mkdtemp(join(tmpdir(), 'conductor-conversation-links-'))
const output = resolve('.conductor-scratch/conversation-links')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [process.env.CONDUCTOR_SMOKE_MAIN ?? resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const busy = ['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting']

let id
const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('Conversation links'))
  await writeFile(join(project.path, 'notes.md'), '# Notes\n')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Conversation links' }).click()
  await launcherTile(page, 'Claude').click()
  const composer = page.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('SYNTHETIC LINKS for the rail')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await expect.poll(async () => (await snapshot())?.phase, { timeout: 20000 }).toBe('completed')

  const toggle = page.getByRole('button', { name: 'Links and files', exact: true })
  await expect(toggle.locator('.sa-links-dot')).toHaveCount(1)
  await toggle.click()
  const rail = page.locator('.sa-links-rail')
  await expect(rail).toBeVisible()
  await expect(rail.locator('.sa-links-item')).toHaveText([/the guide/, /example\.org\/status/, /notes\.md/])
  await expect(rail.locator('.sa-links-asked')).toContainText('Should I also update the changelog?')
  await page.screenshot({ path: join(output, '1-rail.png') })
  check('The rail lists the reply\'s links and verified file, and the question it ended with')

  await rail.locator('.sa-links-item').filter({ hasText: 'notes.md' }).click()
  await expect(page.locator('.sa-activity-flash')).toHaveCount(1)
  await rail.getByRole('button', { name: 'Open notes.md', exact: true }).click()
  await expect(page.locator('.file-tab, .pane-tab').filter({ hasText: 'notes.md' }).first()).toBeVisible()
  check('A row jumps to the message it came from, and Open opens the file in the editor')

  await page.locator(`.pane-tab[data-control-agent-id="${id}"]`).click()
  await rail.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(rail.locator('.sa-links-asked')).toHaveCount(0)
  await expect(toggle.locator('.sa-links-dot')).toHaveCount(0)
  // Away and back: the conversation view remounts with the rail still open and the question still dismissed.
  await page.locator('.pane-add-tab').first().click()
  await expect(page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)).toHaveCount(0)
  await page.locator(`.pane-tab[data-control-agent-id="${id}"]`).click()
  await expect(page.locator('.sa-links-rail')).toBeVisible()
  await expect(page.locator('.sa-links-rail .sa-links-item')).toHaveCount(3)
  await expect(page.locator('.sa-links-asked')).toHaveCount(0)
  await page.screenshot({ path: join(output, '2-after-switch.png') })
  check('Asked you is dismissible; the rail stays open and dismissed across a tab switch')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  if (id) {
    const phase = (await snapshot().catch(() => null))?.phase
    if (busy.includes(phase)) await page.evaluate(id => window.conductor.structured.interrupt(id, false), id).catch(() => {})
  }
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  const quit = await Promise.race([app.close().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30000))])
  if (!quit) { console.log('app.close timed out; killing the parked app'); app.process().kill(); process.exitCode = 1; setTimeout(() => process.exit(1), 5000).unref() }
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
