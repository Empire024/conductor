import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Isolated synthetic processes exercise real IPC without provider inference.
const provider = process.argv.includes('--provider=claude') ? 'claude' : 'codex'
const behavior = process.argv.find(arg => arg.startsWith('--behavior='))?.split('=')[1] ?? 'accepted'
const root = await mkdtemp(join(tmpdir(), 'conductor-steering-'))
const output = resolve('artifacts/steering', provider + '-' + behavior)
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_STEER: behavior }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const results = { synthetic: true, provider, behavior, checks: [], failures: [] }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('Steering fixture'))
  await writeFile(join(project.path, 'context.txt'), 'Exact added context')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Steering fixture' }).click()
  await page.locator('.launcher-grid:visible button').filter({ hasText: provider === 'claude' ? 'Claude' : 'Codex' }).click()
  const pane = page.locator('.structured-agent-pane:visible')
  const id = await pane.getAttribute('data-structured-session')
  const composer = pane.getByRole('textbox', { name: /^Message / })
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
  await expect(composer).toBeEnabled()
  await composer.fill(provider === 'claude' ? 'SYNTHETIC STEER START' : 'synthetic:steer')
  await pane.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect.poll(async () => (await snapshot()).capabilities.steering).toBe(true)
  await expect(composer).toHaveAttribute('placeholder', 'Send to running turn')
  await composer.fill('SYNTHETIC STEER DATA: keep this text')
  await pane.getByRole('button', { name: 'Attach file context', exact: true }).click()
  await pane.getByRole('combobox', { name: 'Context file path', exact: true }).fill('context.txt')
  await pane.getByRole('button', { name: 'Attach', exact: true }).click()
  const before = await snapshot()
  const turnId = (await page.evaluate(id => window.conductor.structured.events(id), id)).filter(event => event.data.type === 'session' && event.turnId).at(-1).turnId
  await pane.getByRole('button', { name: 'Steer', exact: true }).click()
  if (behavior === 'malformed') {
    await expect(pane.getByRole('alert')).toContainText('your draft was kept')
    await expect(composer).toHaveValue('SYNTHETIC STEER DATA: keep this text')
    await expect(pane.locator('.sa-context-chips')).toContainText('context.txt')
    assert.equal((await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, 1)
    assert.ok(!(await snapshot()).queued)
    results.checks.push('Uncertain RPC delivery retains composer text and attachments without queueing or claiming success')
  } else if (behavior === 'stale') {
    await expect(composer).toHaveValue('')
    await expect(pane.getByLabel('Queued messages')).toContainText('SYNTHETIC STEER DATA: keep this text')
    assert.equal((await snapshot()).queued.attachments[0].content, 'Exact added context')
    await pane.getByRole('button', { name: 'Remove queued message 1', exact: true }).click()
    await expect(composer).toHaveValue('SYNTHETIC STEER DATA: keep this text')
    await expect(pane.locator('.sa-context-chips')).toContainText('context.txt')
    results.checks.push('Stale expectedTurnId queues captured input and cancellation restores its exact draft')
  } else {
    await expect(composer).toHaveValue('')
    await expect(pane.getByLabel('Queued messages')).toHaveCount(0)
    const after = await snapshot()
    assert.equal(after.runtimeId, before.runtimeId)
    assert.equal(after.phase, 'running')
    const users = after.items.filter(item => item.data.type === 'text' && item.data.role === 'user')
    assert.equal(users.length, 2)
    assert.equal(users.at(-1).turnId, turnId)
    assert.equal(users.at(-1).data.text, 'SYNTHETIC STEER DATA: keep this text')
    assert.equal(users.at(-1).data.attachments[0].name, 'context.txt')
    await expect(pane.getByText('SYNTHETIC STEER DATA: keep this text', { exact: true })).toBeVisible()
    await expect(pane.locator('.sa-context-chips')).toHaveCount(0)
    results.checks.push('Steer affordance routes through real IPC into the running turn, adds one transcript message, and clears only delivered input')
  }
  await page.screenshot({ path: join(output, 'steering.png'), fullPage: true })
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
