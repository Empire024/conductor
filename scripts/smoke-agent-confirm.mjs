import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// An agent's request to the owner, end to end through the real HTTP broker, main process and
// renderer: it is shown once however often the agent repeats it, survives a renderer reload, and
// the agent is told the owner's actual answer. The window stays parked the whole time.
const root = await mkdtemp(join(tmpdir(), 'conductor-confirm-smoke-'))
const output = resolve('artifacts/agent-confirm')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const post = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { status: response.status, body: await response.json() }
}
const parked = () => app.evaluate(({ BrowserWindow, screen }) => {
  const window = BrowserWindow.getAllWindows()[0]
  const area = screen.getPrimaryDisplay().workArea
  return { x: window.getBounds().x, left: area.x, focused: window.isFocused() }
})
try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentConfirm?.pending))
  const project = await page.evaluate(() => window.conductor.projects.create('Confirm smoke'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Confirm smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const sourceId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => { await window.conductor.structured.connect(id); const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SYNTHETIC STEER START', { ...state.settings, model: 'synthetic-claude', effort: 'low' }, []) }, sourceId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(auth.endpoint && auth.token, 'The synthetic provider must receive the control briefing')
  const remembered = await post(auth, 'memory.remember', { gist: 'Confirm smoke memory' })
  assert.equal(remembered.status, 200, JSON.stringify(remembered.body))
  const memoryId = remembered.body.result.id
  assert.ok(memoryId)

  const dialog = page.locator('.agent-confirm-dialog')
  const first = post(auth, 'memory.forget', { id: memoryId })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Confirm smoke memory')
  // The broker refuses a second concurrent call from the same session outright.
  const repeated = await post(auth, 'memory.forget', { id: memoryId })
  assert.equal(repeated.status, 409, JSON.stringify(repeated.body))
  await expect(dialog).toHaveCount(1)
  assert.equal((await page.evaluate(() => window.conductor.agentConfirm.pending())).length, 1)
  check('The request reaches the renderer, and a repeated call while it waits does not queue a second dialog')

  await page.reload()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Confirm smoke memory')
  check('A renderer reload shows the request that is still waiting instead of losing it')

  const window = await parked()
  assert.ok(window.x <= window.left - 5000, 'The window must stay parked off every display: ' + JSON.stringify(window))
  assert.equal(window.focused, false)
  check('Revealing the request keeps a test window parked and unfocused')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  const declined = await first
  assert.equal(declined.status, 400)
  assert.equal(declined.body.error, 'The owner declined to forget this memory')
  check('The owner’s Cancel reaches the agent as a real decline')

  const allowed = post(auth, 'memory.forget', { id: memoryId })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Allow' }).click()
  const removed = await allowed
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.deepEqual(removed.body.result, { removed: true })
  check('Allow completes the agent’s request')

  await page.screenshot({ path: join(output, 'agent-confirm.png') })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2))
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(capture, { force: true })
}
