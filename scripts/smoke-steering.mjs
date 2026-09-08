import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Offline raw Claude protocol -> real adapter/session IPC -> actual React/Escape.
// No model or native tool execution; the fixture emits deterministic lifecycle frames.
const root = await mkdtemp(join(tmpdir(), 'conductor-steering-ui-'))
const output = resolve('artifacts/steering-ui')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [], root }
let page
try {
  page = await app.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Steering fixture'))
  await page.reload()
  await page.getByText('Steering fixture', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const pane = page.locator('.structured-agent-pane').first()
  await pane.waitFor()
  const id = await pane.getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), id)
  const input = () => pane.getByRole('textbox', { name: /^Message / })
  const send = async (text, action = 'Send message') => {
    await input().fill(text)
    // Backend snapshots can lead the batched renderer event by 32 ms.
    // Exercise Enter only once the intended action is actually offered by the UI.
    await expect(pane.getByRole('button', { name: action, exact: true })).toBeEnabled()
    await input().press('Enter')
  }
  const users = async text => (await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text === text)
  await send('SYNTHETIC STEERING WAIT')
  await expect.poll(async () => (await snapshot()).capabilities?.steering).toBe(true)
  await send('SYNTHETIC STEERING NEXT', 'Steer')
  const pending = pane.getByLabel('Pending steering messages')
  await expect(pending).toContainText('Message will be sent after the next tool use. Esc interrupts and sends now.')
  assert.equal((await users('SYNTHETIC STEERING NEXT')).length, 0)
  await expect(pending).toHaveCount(0)
  assert.equal((await snapshot()).phase, 'running')
  assert.equal((await users('SYNTHETIC STEERING NEXT')).length, 1)
  results.checks.push('Accepted input remains pending until the native next-tool receipt, then appears exactly once while the original turn continues')

  await send('SYNTHETIC STEERING HOLD', 'Steer')
  await expect(pending).toContainText('Received')
  await page.reload()
  await expect(pending).toContainText('SYNTHETIC STEERING HOLD')
  results.checks.push('Pending native delivery survives renderer reload without sending another input')
  const hintFits = await pending.locator('small').evaluate(element => element.getBoundingClientRect().right <= window.innerWidth && getComputedStyle(element).whiteSpace === 'normal')
  assert.equal(hintFits, true, 'Delivery hint must wrap inside the visible pane')
  await input().fill('Unsent draft stays here')
  await expect(pane.getByRole('button', { name: 'Steer', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(output, 'pending-steering.png'), fullPage: true })
  await input().press('Escape')
  await expect.poll(async () => (await snapshot()).phase).toBe('completed')
  await expect(input()).toHaveValue('Unsent draft stays here')
  assert.equal((await users('SYNTHETIC STEERING HOLD')).length, 1)
  assert.equal((await users('Unsent draft stays here')).length, 0)
  await expect(pending).toHaveCount(0)
  results.checks.push('Escape interrupts and expedites only the confirmed unconsumed submitted input, preserving the unsent draft')

  await send('SYNTHETIC STEERING WAIT')
  await expect.poll(async () => (await snapshot()).phase).toBe('running')
  await input().fill('Another unsent draft')
  await expect(pane.getByRole('button', { name: 'Steer', exact: true })).toBeEnabled()
  await input().press('Escape')
  await expect.poll(async () => (await snapshot()).phase).toBe('interrupted')
  await expect(input()).toHaveValue('Another unsent draft')
  assert.equal((await users('Another unsent draft')).length, 0)
  results.checks.push('Escape with no submitted pending input remains a plain stop and never submits the composer draft')
  await pane.getByRole('button', { name: 'Resume conversation', exact: true }).click()
  await expect.poll(async () => (await snapshot()).phase).toBe('idle')
  await send('SYNTHETIC STEERING WAIT')
  await expect.poll(async () => (await snapshot()).phase).toBe('running')
  await send('SYNTHETIC STEERING HOLD', 'Steer')
  await expect(pending).toContainText('Received')
  await pane.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await snapshot()).phase).toBe('interrupted')
  await expect(pending).toContainText('Not sent')
  assert.equal((await users('SYNTHETIC STEERING HOLD')).length, 1)
  await pending.getByRole('button', { name: 'Return steering message to draft' }).click()
  await expect(input()).toHaveValue('SYNTHETIC STEERING HOLD')
  results.checks.push('Stop cancels without expediting, and the unsent pending message can be restored to the composer')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(results, null, 2))
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n')
  await app.close()
}
