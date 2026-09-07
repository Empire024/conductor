import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-declutter-'))
const output = resolve('artifacts/backlog-followup')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [] }
const page = await app.firstWindow()
try {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  await page.evaluate(() => window.conductor.projects.create('Conversation clarity'))
  await page.reload()
  await page.getByText('Conversation clarity', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('synthetic:activity-groups')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const pane = page.locator('.structured-agent-pane')
  const id = await pane.getAttribute('data-structured-session')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), id)).phase).toBe('completed')
  const group = page.locator('.sa-completed-group')
  await expect(group).toHaveCount(1)
  await expect(group.locator('summary')).toHaveText('8 completed actions')
  await expect(group.locator('.sa-tool').first()).not.toBeVisible()
  await expect(page.locator('.sa-tool:visible')).toHaveCount(1)
  await expect(page.locator('.sa-tool:visible')).toHaveAttribute('aria-label', /failed/)
  await expect(page.locator('.sa-assistant')).toHaveCount(2)
  await expect(page.locator('.sa-kind-subagent')).toHaveCount(0)
  const state = await page.evaluate(id => window.conductor.structured.snapshot(id), id)
  assert.equal(state.items.filter(item => item.data.type === 'tool').length, 9)
  assert.equal(state.items.filter(item => item.data.type === 'subagent' && item.data.name === '/root').length, 0)
  results.checks.push('Eight successful operations collapse to one row; failure and assistant messages remain visible; subagent/root status noise is removed')
  await page.screenshot({ path: join(output, 'conversation-declutter-collapsed.png'), fullPage: true })
  await group.locator('summary').click()
  await expect(group.locator('.sa-tool:visible')).toHaveCount(8)
  await group.locator('.sa-tool-heading').first().click()
  await expect(group.locator('.sa-output').first()).toContainText('EXACT OUTPUT 1')
  await expect(group.locator('.sa-io').first()).toContainText('Write-Output')
  results.checks.push('Expanding the group and an action reveals its exact command and output')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'conversation-declutter-failed.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'conversation-declutter-results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
