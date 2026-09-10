// Ctrl+F in a real Conductor window: two conversations seeded in one workspace by the synthetic
// offline fixture, then find-in-workspace driven with actual Chromium keystrokes.
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-find-'))
const output = resolve('artifacts/conversation-find')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, checks: [], failures: [] }
const page = await app.firstWindow()
page.setDefaultTimeout(20_000)
const errors = []
page.on('pageerror', error => errors.push(error.stack ?? error.message))
const findBar = page.locator('.sa-find')
const findInput = page.getByRole('textbox', { name: 'Find in conversations', exact: true })
const count = page.locator('.sa-find-count')
const pane = page.locator('.structured-agent-pane').last()
const search = async (text) => { await findInput.fill(text); await page.waitForTimeout(450) }
const seed = async (marker) => {
  await page.locator('.launcher-grid').last().locator('button').filter({ hasText: 'Codex' }).click()
  await pane.waitFor()
  const id = await pane.getAttribute('data-structured-session')
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).last().fill(`synthetic:activity-groups\nFINDABLE MARKER ${marker} lives in this conversation.`)
  await page.getByRole('button', { name: 'Send message', exact: true }).last().click()
  await page.waitForFunction(async id => (await window.conductor.structured.snapshot(id))?.phase === 'completed', id, { timeout: 20_000 })
  return id
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.evaluate(() => window.conductor.projects.create('Find fixture'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.getByText('Find fixture', { exact: true }).first().click()

  const alpha = await seed('alpha')
  await page.locator('.pane-add-tab').click()
  const beta = await seed('beta')
  assert.notEqual(alpha, beta)
  results.checks.push('Two conversations seeded in one workspace through the synthetic offline provider')

  await page.locator('.sa-timeline').last().click({ position: { x: 8, y: 8 } })
  await page.keyboard.press('Control+f')
  await findBar.waitFor()
  await findInput.press('Escape')
  assert.equal(await findBar.count(), 0)
  results.checks.push('Ctrl+F opens the find bar for the focused conversation pane, Escape closes it')

  await page.getByRole('combobox', { name: 'Model', exact: true }).last().click()
  const modelSearch = page.getByRole('textbox', { name: 'Search models', exact: true })
  await modelSearch.waitFor()
  await page.keyboard.press('Control+f')
  assert.equal(await findBar.count(), 0)
  await modelSearch.press('Escape')
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true }).last()
  await composer.fill('draft that must survive')
  await page.keyboard.press('Control+f')
  await findBar.waitFor()
  assert.equal(await composer.inputValue(), 'draft that must survive')
  await composer.fill('')
  results.checks.push("The pane's own model search keeps Ctrl+F; opening find from the composer leaves its draft untouched")

  await search('findable marker')
  await page.waitForFunction(() => document.querySelector('.sa-find-count')?.textContent === '1 of 1')
  const current = page.locator('.sa-find-current')
  assert.equal(await current.count(), 1)
  assert.match(await current.innerText(), /FINDABLE MARKER beta/)
  const marked = await page.evaluate(() => [...(CSS.highlights?.get('conductor-find-current') ?? [])].map(range => range.toString()))
  assert.deepEqual(marked, ['FINDABLE MARKER'])
  results.checks.push('The match in this conversation is highlighted in place, at message level and on the exact text range')

  const group = page.locator('.sa-find-results section').filter({ hasText: 'alpha' })
  await group.waitFor()
  assert.match(await group.innerText(), /FINDABLE MARKER alpha/)
  await page.screenshot({ path: join(output, 'conversation-find.png'), fullPage: true })
  results.checks.push('The other conversation in the workspace is listed as a grouped result with snippet context')

  await search('inspect')
  await page.waitForFunction(() => document.querySelector('.sa-find-count')?.textContent === '1 of 2')
  await findInput.press('Enter')
  await page.waitForFunction(() => document.querySelector('.sa-find-count')?.textContent === '2 of 2')
  await findInput.press('Enter')
  await page.waitForFunction(() => document.querySelector('.sa-find-count')?.textContent === '1 of 2')
  await findInput.press('Shift+Enter')
  await page.waitForFunction(() => document.querySelector('.sa-find-count')?.textContent === '2 of 2')
  results.checks.push('Enter and Shift+Enter step through matches and wrap around in both directions')

  await search('EXACT OUTPUT')
  assert.equal(await count.innerText(), 'No matches')
  assert.equal(await page.locator('.sa-find-results section').count(), 0)
  assert.equal(await page.locator('.sa-find-current').count(), 0)
  const stored = await page.evaluate(() => window.conductor.structured.snapshot(document.querySelector('.sa-find').closest('.structured-agent-pane').dataset.structuredSession))
  assert.ok(stored.items.some(item => item.data.type === 'tool' && String(item.data.output).includes('EXACT OUTPUT')))
  results.checks.push('Text that only exists in tool output and provider internals is not a match in either scope')

  await search('findable marker')
  await group.locator('button').first().click()
  await page.waitForFunction(id => document.querySelector('.sa-find')?.closest('.structured-agent-pane')?.dataset.structuredSession === id, alpha)
  await page.waitForFunction(() => /FINDABLE MARKER alpha/.test(document.querySelector('.sa-find-current')?.textContent ?? ''))
  await page.screenshot({ path: join(output, 'conversation-find-cross.png'), fullPage: true })
  results.checks.push('Activating a result opens that conversation and highlights the matching message there')

  await findInput.press('Escape')
  assert.equal(await findBar.count(), 0)
  assert.equal(await page.locator('.sa-find-current').count(), 0)
  assert.deepEqual(await page.evaluate(() => [...(CSS.highlights?.keys() ?? [])]), [])
  results.checks.push('Escape closes the find bar and removes every highlight')

  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'conversation-find-failed.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'conversation-find-results.json'), JSON.stringify({ ...results, errors }, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
