import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// A half-typed answer in an open question card survives switching tabs. tab-keep-alive.ts unmounts
// an inactive conversation view on purpose; the card keeps its draft in question-drafts.ts and a
// remounted card starts from it. Real Electron main/renderer; only the provider is the synthetic
// Claude fixture (no inference). Parked window. Run after a build, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-question-draft-suspend.mjs
// CONDUCTOR_SMOKE_MAIN points it at another build's out/main/index.js.
const root = await mkdtemp(join(tmpdir(), 'conductor-question-draft-suspend-'))
const output = resolve('.conductor-scratch/question-draft-suspend')
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
const typed = 'Typed before switching tabs'

let id
const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Question draft suspend'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Question draft suspend' }).click()
  await launcherTile(page, 'Claude').click()
  const composer = page.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('SYNTHETIC QUESTION draft across a tab switch')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const card = page.locator('.sa-interaction.needs-attention')
  await expect(card).toContainText('Which theme should this workspace use?')
  await card.locator('.sa-question-option').filter({ hasText: 'Other' }).click()
  await card.locator('.sa-custom-answer input').fill(typed)

  // Another tab takes the pane: the conversation's view, and with it the card, unmounts.
  await page.locator('.pane-add-tab').first().click()
  await expect(page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)).toHaveCount(0)
  await expect(page.locator('.sa-custom-answer input')).toHaveCount(0)
  await page.screenshot({ path: join(output, '1-other-tab.png') })

  await page.locator(`.pane-tab[data-control-agent-id="${id}"]`).click()
  await expect(page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)).toBeVisible()
  const back = page.locator('.sa-interaction.needs-attention')
  await expect(back.locator('.sa-custom-answer input')).toHaveValue(typed)
  await expect(back.getByRole('radio', { name: /Other/ })).toBeChecked()
  assert.equal((await snapshot()).items.find(item => item.data.type === 'interaction').data.interaction.status, 'pending')
  await page.screenshot({ path: join(output, '2-back-with-draft.png') })
  check('An open question card keeps its half-typed answer across a tab switch that unmounts the conversation view')

  await back.getByRole('button', { name: 'Submit answers', exact: true }).click()
  await expect.poll(async () => (await snapshot()).items.find(item => item.data.type === 'interaction').data.interaction.status).toBe('resolved')
  // The sent answer is not kept: leaving (to the launcher tab opened above) and coming back shows the
  // answered row, not a card offering it again.
  await page.locator('.pane-tab:not([data-control-agent-id])').filter({ hasText: 'New tab' }).first().click()
  await expect(page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)).toHaveCount(0)
  await page.locator(`.pane-tab[data-control-agent-id="${id}"]`).click()
  await expect(page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)).toBeVisible()
  await expect(page.locator('.sa-interaction-closed')).toHaveCount(0)
  await expect(page.locator('.sa-custom-answer input')).toHaveCount(0)
  await page.screenshot({ path: join(output, '3-answered.png') })
  check('Once submitted, the answer is cleared: a remounted view does not offer it again')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  if (id) {
    const phase = (await snapshot().catch(() => null))?.phase
    if (busy.includes(phase)) await page.evaluate(id => window.conductor.structured.interrupt(id, false), id).catch(() => {})
  }
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  // A quit that still waits on something must not hold the smoke lock.
  const quit = await Promise.race([app.close().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30000))])
  if (!quit) { console.log('app.close timed out; killing the parked app'); app.process().kill(); process.exitCode = 1; setTimeout(() => process.exit(1), 5000).unref() }
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
