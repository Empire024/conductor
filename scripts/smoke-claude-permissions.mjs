import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Raw offline protocol -> production Claude adapter -> durable IPC -> real React panes.
// All fixture permissions describe echo commands; none executes a shell command.
const root = await mkdtemp(join(tmpdir(), 'conductor-permission-ui-'))
const output = resolve('artifacts/claude-permissions-ui')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, checks: [], failures: [], root }
let page
try {
  page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Claude permission fixture'))
  await page.reload()
  await page.getByText('Claude permission fixture', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const panes = page.locator('.structured-agent-pane')
  await panes.first().waitFor()
  const sessionId = await panes.first().getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
  const interactionCount = async () => (await snapshot()).items.filter(item => item.data.type === 'interaction').length
  const pending = () => panes.first().locator('form.sa-interaction')
  const submit = async scenario => {
    await panes.first().getByRole('textbox', { name: /^Message / }).fill('SYNTHETIC PERMISSION ' + scenario)
    await panes.first().getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const complete = () => expect.poll(async () => (await snapshot()).phase, { timeout: 15000 }).toBe('completed')
  await submit('SCOPED')
  await expect(pending().getByRole('button', { name: 'Allow for this session', exact: true })).toBeEnabled()
  await expect(pending().getByRole('button', { name: 'Switch to auto-mode', exact: true })).toBeEnabled()
  await expect(pending()).toContainText('Scope: Bash(echo conductor-session-scope)')
  await expect(pending()).toContainText('cleared when it restarts or resumes')
  await page.screenshot({ path: join(output, 'permission-options.png'), fullPage: true })
  await pending().getByRole('button', { name: 'Allow for this session', exact: true }).click()
  await complete()
  const firstCount = await interactionCount()
  assert.equal((await snapshot()).settings.permission, 'default')
  await submit('REPEAT'); await complete()
  assert.equal(await interactionCount(), firstCount)
  results.checks.push('Both actions visible with exact native rule scope; session grant reuses the synthetic native rule without changing permission mode')

  await submit('ONCE')
  await pending().getByRole('button', { name: 'Allow once', exact: true }).click(); await complete()
  await submit('DENY')
  await pending().getByRole('button', { name: 'Deny', exact: true }).click(); await complete()
  assert.equal((await snapshot()).settings.permission, 'default')
  results.checks.push('Existing Allow once and Deny resolve their selected request and retain Ask mode')

  await submit('REJECT')
  await pending().getByRole('button', { name: 'Switch to auto-mode', exact: true }).click()
  await expect(pending().getByRole('alert')).toContainText('Synthetic managed policy disables auto-mode')
  assert.equal((await snapshot()).phase, 'waiting_approval')
  assert.equal((await snapshot()).settings.permission, 'default')
  await expect(pending().getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
  await pending().getByRole('button', { name: 'Deny', exact: true }).click(); await complete()
  results.checks.push('Definitive native mode rejection is visible, keeps the approval pending, and permits Deny through the same IPC request')

  // Mount the same backend conversation in two actual split panes. Ordinary tab
  // duplication starts a new agent, so construct only this isolated test layout.
  await expect.poll(async () => page.evaluate(async ({ projectId, id }) => {
    const sessions = await window.conductor.sessions.list(projectId)
    return sessions.some(session => JSON.stringify(session.layout).includes(id))
  }, { projectId: project.id, id: sessionId })).toBe(true)
  const sharedWorkspace = await page.evaluate(async ({ projectId, id }) => {
    const sessions = await window.conductor.sessions.list(projectId)
    const session = sessions.find(session => JSON.stringify(session.layout).includes(id))
    const groups = node => node.type === 'group' ? [node] : node.children.flatMap(groups)
    const group = groups(session.layout.root).find(group => group.tabs.some(tab => tab.resourceId === id))
    const tab = group.tabs.find(tab => tab.resourceId === id)
    const first = { ...group, tabs: [tab], activeTabId: tab.id }
    const copied = { ...tab, id: 'permission-shared-pane', title: 'Claude shared view' }
    const second = { ...first, id: 'permission-shared-group', tabs: [copied], activeTabId: copied.id }
    const layout = { version: 1, root: { type: 'split', id: 'permission-split', direction: 'horizontal', children: [first, second], sizes: [50, 50] } }
    await window.conductor.sessions.save(session.id, layout, null, [])
    return { ...session, layout, maximizedGroupId: null, closedTabs: [] }
  }, { projectId: project.id, id: sessionId })
  await app.evaluate(({ BrowserWindow }, session) => BrowserWindow.getAllWindows()[0].webContents.send('sessions:restored', session), sharedWorkspace)
  await expect(panes).toHaveCount(2)
  await submit('SESSION_EDIT')
  await expect(pending()).toContainText('all file edits and filesystem operations Claude permits in Edit mode')
  await pending().getByRole('button', { name: 'Allow for this session', exact: true }).click(); await complete()
  const editCount = await interactionCount()
  for (let index = 0; index < 2; index++) await expect(panes.nth(index).getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Edit')
  assert.equal((await snapshot()).settings.temporaryPermission.restore, 'default')
  assert.equal((await snapshot()).settings.temporaryPermission.runtimeId, (await snapshot()).runtimeId)
  await submit('REPEAT_EDIT'); await complete()
  assert.equal(await interactionCount(), editCount)
  await page.reload()
  await expect(panes.first().getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Edit')
  await page.evaluate(id => window.conductor.structured.resume(id), sessionId)
  await expect.poll(async () => (await snapshot()).phase).toBe('idle')
  for (let index = 0; index < 2; index++) await expect(panes.nth(index).getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Ask')
  assert.equal((await snapshot()).settings.temporaryPermission, undefined)
  await submit('REPEAT_EDIT')
  await pending().getByRole('button', { name: 'Allow once', exact: true }).click(); await complete()
  results.checks.push('Native offered session Edit mode updates both panes, persists across turns and renderer reload, then restores Ask and requests permission again after runtime resume')
  await submit('AUTO')
  await expect(panes.nth(1).getByRole('button', { name: 'Switch to auto-mode', exact: true })).toBeEnabled()
  await pending().getByRole('button', { name: 'Switch to auto-mode', exact: true }).click()
  await complete()
  for (let index = 0; index < 2; index++) {
    await expect(panes.nth(index).getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Auto')
    await expect(panes.nth(index).locator('form.sa-interaction')).toHaveCount(0)
  }
  assert.equal((await snapshot()).settings.permission, 'auto')
  assert.equal((await snapshot()).settings.plan, false)
  assert.equal((await snapshot()).capabilities.effectiveSettings.permissionMode, 'auto')
  await page.screenshot({ path: join(output, 'auto-mode-shared-panes.png'), fullPage: true })
  results.checks.push('Native auto-mode ACK resolves once, persists mode, and updates both mounted panes without reload')

  await submit('REQUIRED')
  await expect(pending().getByRole('button', { name: 'Allow for this session', exact: true })).toBeDisabled()
  await expect(pending().getByRole('button', { name: 'Switch to auto-mode', exact: true })).toBeDisabled()
  await expect(pending()).toContainText('individual approval')
  await pending().getByRole('button', { name: 'Deny', exact: true }).click(); await complete()
  await page.reload()
  await expect(panes).toHaveCount(2)
  await expect(panes.first().getByRole('button', { name: 'Conversation mode', exact: true })).toHaveText('Auto')
  assert.equal((await snapshot()).settings.permission, 'auto')
  results.checks.push('Mandatory native approval stays visible in Auto, unavailable session scope is explained, and reload retains confirmed Auto mode')

  await page.evaluate(id => window.conductor.structured.resume(id), sessionId)
  await expect.poll(async () => (await snapshot()).phase).toBe('idle')
  await submit('REPEAT')
  await pending().getByRole('button', { name: 'Allow once', exact: true }).click(); await complete()
  results.checks.push('Explicit runtime resume clears native session rules and a repeated permission asks again')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  try { await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2)) }
  finally { await app.close() }
  console.log(JSON.stringify(results, null, 2))
}
