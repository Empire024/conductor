import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Production Electron UI and database with the offline raw provider fixture only.
const root = await mkdtemp(join(tmpdir(), 'conductor-workspace-restore-'))
const output = resolve('artifacts/backlog-followup')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const results = { synthetic: true, checks: [], failures: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.sessions.restore))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Workspace restore fixture'))
  await page.reload()
  await page.getByText('Workspace restore fixture', { exact: true }).first().click()
  const sidebarName = () => page.locator('.sidebar-session-row > button:first-child').first()
  await sidebarName().dblclick()
  const rename = page.locator('.sidebar-session-rename')
  await expect(rename).toBeFocused()
  await rename.fill('Research workspace')
  await rename.press('Enter')
  await expect(page.locator('.session-tab-name')).toHaveText('Research workspace')
  await sidebarName().dblclick()
  await rename.fill('Cancelled rename')
  await rename.press('Escape')
  await expect(page.locator('.session-tab-name')).toHaveText('Research workspace')
  results.checks.push('Workspace sidebar double-click renames inline; Escape cancels without saving')

  await sidebarName().click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Workspace actions' })
  const sidebarActions = await menu.getByRole('menuitem').allTextContents()
  await page.keyboard.press('Escape')
  await page.locator('.session-tab').click({ button: 'right' })
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), sidebarActions)
  await expect(menu.getByRole('menuitem', { name: /Bring back workspace/ })).toBeDisabled()
  await menu.getByRole('menuitem', { name: 'Rename workspace', exact: true }).click()
  await page.locator('.session-tab-rename').fill('Research workspace')
  await page.locator('.session-tab-rename').press('Enter')
  results.checks.push('Top workspace tabs and sidebar share the same context-menu actions')

  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const composer = () => page.getByRole('textbox', { name: 'Message Codex', exact: true })
  await composer().fill('Draft survives closing, restoration, and restart.')
  const resourceId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), resourceId))?.nativeSessionId, { timeout: 15000 }).toBeTruthy()
  const original = await page.evaluate(id => window.conductor.structured.snapshot(id), resourceId)
  const originalSession = (await page.evaluate(id => window.conductor.sessions.list(id), project.id))[0]
  await page.locator('.session-add').click()
  await expect(page.locator('.session-tab')).toHaveCount(2)
  const closeFirst = () => page.locator('.session-tab').filter({ hasText: 'Research workspace' }).locator('.session-tab-close').click()
  await closeFirst()
  await expect(page.locator('.session-tab')).toHaveCount(1)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), resourceId))?.phase).toBe('disconnected')
  await page.keyboard.press('Control+Shift+Z')
  await expect(page.locator('.session-tab')).toHaveCount(2)
  await expect(composer()).toHaveValue('Draft survives closing, restoration, and restart.')
  assert.equal(await page.locator('.structured-agent-pane').getAttribute('data-structured-session'), resourceId)
  const restored = await page.evaluate(id => window.conductor.structured.snapshot(id), resourceId)
  assert.equal(restored.nativeSessionId, original.nativeSessionId)
  assert.ok((await page.evaluate(id => window.conductor.sessions.list(id), project.id)).some(session => session.id === originalSession.id))
  results.checks.push('Ctrl Shift Z restores the same workspace, agent resource, native conversation, and unsent draft; closing stops the runtime')

  await closeFirst()
  await expect(page.locator('.session-tab')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.session-tab')).toHaveCount(1)
  await page.locator('.session-tab').click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: /Bring back workspace/ })).toBeEnabled()
  await page.screenshot({ path: join(output, 'workspace-restore-menu.png'), fullPage: true, animations: 'disabled' })
  results.screenshots.push('artifacts/backlog-followup/workspace-restore-menu.png')
  await menu.getByRole('menuitem', { name: /Bring back workspace/ }).click()
  await expect(page.locator('.session-tab')).toHaveCount(2)
  await expect(composer()).toHaveValue('Draft survives closing, restoration, and restart.')
  await expect(page.locator('.session-tab.active')).toContainText('Research workspace')
  await page.screenshot({ path: join(output, 'workspace-restored.png'), fullPage: true, animations: 'disabled' })
  results.screenshots.push('artifacts/backlog-followup/workspace-restored.png')
  results.checks.push('Closed workspace recovery survives renderer restart and works through the context menu')
  await page.locator('.session-tab-close').evaluateAll(buttons => buttons.forEach(button => button.click()))
  await expect.poll(async () => (await page.evaluate(id => window.conductor.sessions.list(id), project.id)).length).toBe(0)
  await expect(page.locator('.session-tab')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+Z')
  await expect(page.locator('.session-tab')).toHaveCount(1)
  results.checks.push('Rapidly closing every workspace leaves no stale tabs, and Ctrl Shift Z restores from an empty workspace bar')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  const page = await app.firstWindow()
  await page.screenshot({ path: join(output, 'workspace-restore-failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
  results.failureDom = await page.locator('body').innerText().catch(() => null)
  throw error
} finally {
  await writeFile(join(output, 'workspace-restore-results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
