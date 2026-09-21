import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The whole "Continue agents when their usage limit resets" chain, end to end and unfaked:
// the owner's own toggle in the workspace bar -> the registered spec in main -> a real Codex
// adapter turn that fails with a quota message -> the persisted wait -> the automatic
// "continue" that lands as a second real turn. The only synthetic part is the provider's
// reply, which names a reset three seconds out so a smoke run can wait for it.
const root = await mkdtemp(join(tmpdir(), 'conductor-limit-continuation-'))
const output = resolve('artifacts/backlog-followup')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  await page.evaluate(() => window.conductor.projects.create('Limit continuation fixture'))
  await page.reload()
  await page.getByText('Limit continuation fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) {
    await page.locator('.session-add').click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  }
  const pane = page.locator('.structured-agent-pane')
  await pane.waitFor()
  const sessionId = await pane.getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)

  // The conversation is registered first and the toggle flipped afterwards -- the ordering the
  // owner actually works in, and the one that used to leave the spec answering "false" for ever.
  const toggle = page.getByRole('button', { name: 'Enable automatic limit continuation', exact: true })
  await toggle.click()
  await expect(page.locator('.continuation-toggle.active')).toBeVisible()
  results.checks.push('Workspace limit-continuation toggle turned on through the real session bar, after the conversation was already open')

  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('synthetic:usage-limit')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect.poll(async () => (await snapshot()).limitResumeAt ?? null, { timeout: 15000 }).not.toBeNull()
  results.checks.push('Provider quota message recognised: the conversation now carries a reset time instead of a bare failure')
  await expect(pane.getByText(/Conductor will send "continue" automatically at/)).toBeVisible()
  results.checks.push('The conversation states, in the timeline, exactly what Conductor is about to do and when')

  // A closed window is a wait with a known end, so the tab and its project roll up as limited.
  await expect.poll(async () => (await page.evaluate(() => window.conductor.agents.listProcesses()))
    .find(process => process.id === sessionId)?.activityPhase, { timeout: 10000 }).toBe('limited')
  results.checks.push('Tab activity reports "limited" rather than "failed" while the window is closed')
  await page.screenshot({ path: join(output, 'limit-continuation-waiting.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/limit-continuation-waiting.png')

  const waiting = await snapshot()
  assert.equal(waiting.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, 1, 'Nothing should be sent while the window is still closed')

  // Nobody touches the app from here: the next turn is Conductor's own.
  await expect.poll(async () => (await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text), { timeout: 20000 })
    .toEqual(['synthetic:usage-limit', 'continue'])
  results.checks.push('When the window reopened, Conductor sent "continue" itself -- a second real provider turn, with no owner action')
  await expect.poll(async () => (await snapshot()).limitResumeAt ?? null, { timeout: 10000 }).toBeNull()
  await expect.poll(async () => (await snapshot()).phase, { timeout: 20000 }).toBe('completed')
  results.checks.push('The wait is cleared once it is spent; the continued turn settles normally')
  await page.screenshot({ path: join(output, 'limit-continuation-resumed.png'), fullPage: true })
  results.screenshots.push('artifacts/backlog-followup/limit-continuation-resumed.png')

  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  const page = await app.firstWindow()
  await page.screenshot({ path: join(output, 'limit-continuation-failure.png'), fullPage: true }).catch(() => {})
  results.failureDom = await page.locator('body').innerText().catch(() => null)
  throw error
} finally {
  await writeFile(join(output, 'limit-continuation-results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
