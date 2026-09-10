import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// A fresh agent tab should name itself from its first message instead of sitting as "Codex"
// forever, and a manual rename (or a second message) must never move it again. Synthetic raw
// protocol process -> production adapter -> SQLite -> actual Electron UI, same harness as
// smoke-structured-agents.mjs, trimmed to just the auto-naming path.
const root = await mkdtemp(join(tmpdir(), 'conductor-offline-'))
const provider = process.argv.includes('--provider=claude') ? 'claude' : 'codex'
const providerLabel = provider === 'claude' ? 'Claude Code' : 'Codex'
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], failures: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  await page.evaluate(() => window.conductor.projects.create('Tab naming fixture'))
  await page.reload()
  await page.getByText('Tab naming fixture', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: providerLabel }).click()
  await page.locator('.structured-agent-pane').waitFor()

  const tabTitle = page.locator('.pane-tab.active .pane-tab-title')
  const genericTitle = provider === 'claude' ? 'Claude' : 'Codex'
  await expect(tabTitle).toHaveText(genericTitle)
  results.checks.push('A fresh agent tab starts on its generic provider name')

  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  if (provider === 'claude') {
    // The offline Claude fixture only resumes cleanly on its named synthetic model (see
    // smoke-structured-agents.mjs); irrelevant to auto-naming, but needed for the later
    // reload/second-message checks to reconnect instead of going 'disconnected'.
    await page.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Synthetic Claude fixture' }).click()
  }
  const firstPrompt = 'Please help me fix the flaky login test that keeps failing intermittently in CI'
  await composer.fill(firstPrompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect.poll(async () => tabTitle.textContent()).not.toBe(genericTitle)
  const derived = await tabTitle.textContent()
  assert.ok(derived.length <= 45, `expected a short tab name, got ${JSON.stringify(derived)}`)
  assert.ok(!derived.includes('\n'), 'tab name must not contain a newline')
  assert.ok(firstPrompt.startsWith(derived.replace(/…$/, '').trim()), `expected the tab name to be a prefix of the prompt, got ${JSON.stringify(derived)}`)
  results.checks.push('Sending the first message names the tab from that prompt: ' + JSON.stringify(derived))

  // History rows should read the same name (requirement: tab titles and history agree).
  await page.getByRole('button', { name: 'Conversation history', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Conversation history', exact: true })).toContainText(derived)
  await page.keyboard.press('Escape')
  results.checks.push('The saved conversation history row shows the same short name as the tab')

  await page.reload()
  await page.locator('.structured-agent-pane').waitFor()
  await expect(page.locator('.pane-tab.active .pane-tab-title')).toHaveText(derived)
  results.checks.push('The auto-named tab survives a renderer reload')

  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), await page.locator('.structured-agent-pane').getAttribute('data-structured-session')))?.phase).toBe('completed')
  const secondComposer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await secondComposer.fill('Also add a regression test once that is fixed')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), await page.locator('.structured-agent-pane').getAttribute('data-structured-session')))?.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length).toBe(2)
  await expect(page.locator('.pane-tab.active .pane-tab-title')).toHaveText(derived)
  results.checks.push('A second message does not re-name the tab')

  // A hand-picked title must never be overwritten by anything automatic afterwards.
  await page.locator('.structured-agent-pane').getByRole('button', { name: 'Session settings', exact: true }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByRole('textbox', { name: 'Conversation title', exact: true }).fill('My manual name')
  await page.getByRole('button', { name: 'Save name', exact: true }).click()
  await expect(page.locator('.pane-tab.active .pane-tab-title')).toHaveText('My manual name')
  results.checks.push('The rename dialog updates the tab strip title immediately')

  const thirdComposer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await thirdComposer.fill('One more message after the manual rename')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), await page.locator('.structured-agent-pane').getAttribute('data-structured-session')))?.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length).toBe(3)
  await expect(page.locator('.pane-tab.active .pane-tab-title')).toHaveText('My manual name')
  results.checks.push('A manually renamed tab is never overwritten by later messages')

  await page.reload()
  await page.locator('.structured-agent-pane').waitFor()
  await expect(page.locator('.pane-tab.active .pane-tab-title')).toHaveText('My manual name')
  results.checks.push('The manual title survives a renderer reload too')

  assert.deepEqual(errors, [])
  results.checks.push('No renderer exceptions')
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  const page = await app.firstWindow()
  results.failureDom = await page.evaluate(() => ({ title: document.title, body: document.body.innerText.slice(-4000) })).catch(() => null)
  throw error
} finally {
  console.log(JSON.stringify(results, null, 2))
  await app.close()
}
