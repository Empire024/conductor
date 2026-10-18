import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// A desktop question card that closes while the owner is typing its answer keeps the answer:
// Stop ends the turn (the question expires), the card turns into "Question closed" with the typed
// text, and "Send as message" delivers it to the agent as an ordinary message with a note
// (structured-sessions deliverLateAnswer). Real Electron main/renderer; only the provider is the
// synthetic Claude fixture (no inference). Parked window. Run after a build, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-desktop-stale-question.mjs
// CONDUCTOR_SMOKE_MAIN points it at another build's out/main/index.js.
const root = await mkdtemp(join(tmpdir(), 'conductor-desktop-stale-question-'))
const output = resolve('.conductor-scratch/desktop-stale-question')
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
const typed = 'Typed on the desktop after it closed'

let id
const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Desktop stale question'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Desktop stale question' }).click()
  await launcherTile(page, 'Claude').click()
  const composer = page.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('SYNTHETIC QUESTION closed while typing on the desktop')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const card = page.locator('.sa-interaction.needs-attention')
  await expect(card).toContainText('Which theme should this workspace use?')

  await card.locator('.sa-question-option').filter({ hasText: 'Other' }).click()
  await card.locator('.sa-custom-answer input').fill(typed)
  await page.screenshot({ path: join(output, '1-typing.png') })
  // Stop from outside the card, as the owner pressing Stop or another screen would: the question expires.
  await page.evaluate(id => window.conductor.structured.interrupt(id, false), id)
  const closed = page.locator('.sa-interaction-closed')
  await expect(closed).toBeVisible()
  await expect(closed).toContainText('Question closed')
  await expect(closed).toContainText('closed before your answer was sent')
  await expect(closed.locator('.sa-custom-answer input')).toHaveValue(typed)
  await expect(closed.getByRole('button', { name: 'Send as message', exact: true })).toBeEnabled()
  await expect(closed.getByRole('button', { name: 'Discard', exact: true })).toBeVisible()
  const question = (await snapshot()).items.find(item => item.data.type === 'interaction')
  assert.notEqual(question.data.interaction.status, 'pending', 'the request itself closed')
  await page.screenshot({ path: join(output, '2-closed-with-typed-answer.png') })
  check('A question that closes while its answer is typed keeps the typed answer as a closed card with Send as message and Discard')

  await closed.getByRole('button', { name: 'Send as message', exact: true }).click()
  const delivered = await expect.poll(async () => {
    const items = (await snapshot()).items
    const message = items.find(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes(typed))
    return Boolean(message && items.some(item => item.sequence > message.sequence && item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('late answer received')))
  }, { timeout: 20000 }).toBe(true).then(() => true)
  assert.ok(delivered)
  const message = (await snapshot()).items.find(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes(typed))
  assert.match(message.data.text, /question had closed before the answer was submitted/)
  assert.match(message.data.text, new RegExp('Which theme should this workspace use\\?\\nAnswer: ' + typed))
  await expect(closed).toHaveCount(0)
  const note = await page.locator('.sa-interaction-resolved').first().evaluate(node => node.textContent)
  assert.match(note, /sent to the agent as a message/)
  await page.screenshot({ path: join(output, '3-sent-as-message.png') })
  check('Send as message delivers the kept answer to the agent as a message with a note; the card says so and closes')

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
