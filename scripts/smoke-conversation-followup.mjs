import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-conversation-followup-'))
const output = resolve('artifacts/backlog-followup')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [] }
const page = await app.firstWindow()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  const project = await page.evaluate(() => window.conductor.projects.create('Conversation follow-up'))
  await writeFile(join(project.path, 'context.txt'), 'ATTACHMENT_BODY_MUST_STAY_OUT_OF_VISIBLE_PROMPT')
  await page.reload()
  await page.getByText('Conversation follow-up', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('SYNTHETIC QUESTION: choose a theme')
  const mode = page.getByRole('combobox', { name: 'Conversation mode', exact: true })
  await expect(mode).toBeVisible()
  await mode.selectOption('plan')
  await expect(mode).toHaveValue('plan')
  await mode.selectOption('accept-edits')
  await expect(mode).toHaveValue('accept-edits')
  await mode.selectOption('auto')
  await page.getByRole('button', { name: 'Attach file context', exact: true }).click()
  await page.getByRole('combobox', { name: 'Context file path', exact: true }).fill('context')
  await page.locator('.sa-file-suggestions [role=option]').filter({ hasText: 'context.txt' }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
  const request = page.locator('.sa-interaction.needs-attention')
  await expect(request).toContainText('Which theme should this workspace use?')
  await expect(mode).toHaveValue('auto')
  assert.equal((await snapshot()).settings.permission, 'auto')
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveText('Synthetic Claude fixture')
  await expect(page.locator('.sa-user')).toHaveCount(1)
  await expect(page.locator('.sa-user')).toContainText('context.txt')
  await expect(page.locator('.sa-user')).not.toContainText('ATTACHMENT_BODY_MUST_STAY_OUT_OF_VISIBLE_PROMPT')
  assert.equal((await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user')[0].data.text, 'SYNTHETIC QUESTION: choose a theme')
  const geometry = await page.evaluate(() => ({ session: document.querySelector('.sa-session-bar').getBoundingClientRect().height, tabs: document.querySelector('.pane-header').getBoundingClientRect().height }))
  assert.ok(geometry.session <= 26 && geometry.tabs <= 30, JSON.stringify(geometry))
  await expect(page.locator('.tab-model')).toHaveCount(0)
  results.checks.push('Auto/Plan/Edit live in the composer; actual model is explicit; attachment bytes stay out of displayed prompt; headers are compact')

  for (const text of ['SYNTHETIC B: first queued', 'SYNTHETIC B: second queued', 'SYNTHETIC B: third queued']) {
    await composer.fill(text)
    await page.getByRole('button', { name: 'Queue message', exact: true }).click()
    await expect(composer).toHaveValue('')
  }
  await expect(page.locator('.sa-queue')).toHaveCount(3)
  await page.getByRole('button', { name: 'Remove queued message 2', exact: true }).click()
  await expect(composer).toHaveValue('SYNTHETIC B: second queued')
  await composer.fill('')
  await expect(page.locator('.sa-queue')).toHaveCount(2)
  assert.ok(await request.evaluate(el => el.querySelector('.sa-interaction-actions').getBoundingClientRect().top < el.querySelector('.sa-request-details').getBoundingClientRect().top))
  await request.locator('.sa-question-option').filter({ hasText: 'Night' }).click()
  await expect(request.getByRole('radio', { name: /Night/ })).toBeChecked()
  await expect(request.locator('.sa-question-option.selected')).toContainText('Night')
  await page.screenshot({ path: join(output, 'claude-question-queue.png'), fullPage: true })
  await request.getByRole('button', { name: 'Submit answers', exact: true }).click()
  await expect.poll(async () => {
    const state = await snapshot()
    return state.phase === 'completed' && state.queuedPrompts.length === 0 && state.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length === 3
  }, { timeout: 15000 }).toBe(true)
  const completed = await snapshot()
  assert.deepEqual(completed.items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text), ['SYNTHETIC QUESTION: choose a theme', 'SYNTHETIC B: first queued', 'SYNTHETIC B: third queued'])
  assert.equal(completed.items.filter(item => item.data.type === 'text' && item.data.text === 'Night was selected.').length, 1)
  results.checks.push('Three messages queue; removing the middle preserves FIFO; choices submit once; streamed/final Claude response is not repeated')

  await composer.fill('SYNTHETIC QUESTION: interrupt this turn')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(request).toBeVisible()
  await composer.focus()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await snapshot()).phase).toBe('interrupted')
  await expect(page.locator('.sa-timeline')).not.toContainText('[ede_diagnostic]')
  await expect(page.getByRole('button', { name: 'Resume conversation', exact: true })).toBeVisible()
  assert.equal((await snapshot()).nativeSessionId, completed.nativeSessionId)
  results.checks.push('Escape interrupts the same Claude session cleanly without exposing stop diagnostics')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'conversation-failure.png'), fullPage: true }).catch(() => {})
  results.dom = await page.locator('body').innerText().catch(() => '')
  throw error
} finally {
  await writeFile(join(output, 'conversation-results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
