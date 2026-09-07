import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Isolated synthetic provider processes; no live credentials, inference, or clipboard.
const provider = process.argv.includes('--provider=claude') ? 'claude' : 'codex'
const providerName = provider === 'claude' ? 'Claude' : 'Codex'
const attachmentCount = provider === 'codex' ? 2 : 1
const root = await mkdtemp(join(tmpdir(), 'conductor-drafts-'))
const output = resolve('artifacts/composer-drafts', provider + (process.argv.includes('--baseline') ? '-baseline' : ''))
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const launch = () => electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
let app = await launch()
let page = await app.firstWindow()
const errors = []
const results = { synthetic: true, provider, checks: [], failures: [] }
const watch = () => page.on('pageerror', error => errors.push(error.message))
const composer = () => page.getByRole('textbox', { name: /^Message / }).last()
const selectProject = async name => {
  const previousProject = await page.locator('.project-row.active').textContent()
  const previousPane = page.locator('.structured-agent-pane:visible')
  const previousId = await previousPane.count() ? await previousPane.getAttribute('data-structured-session') : null
  await page.locator('.project-row').filter({ hasText: name }).click()
  await expect(page.locator('.project-row.active')).toContainText(name)
  if (previousId && !previousProject.includes(name)) await expect(page.locator(`[data-structured-session="${previousId}"]`)).toHaveCount(0)
  await page.locator('.structured-agent-pane:visible, .launcher-grid:visible').first().waitFor()
  if (!await page.locator('.structured-agent-pane:visible').count()) await page.locator('.launcher-grid:visible button').filter({ hasText: providerName }).click()
  await expect(composer()).toBeEnabled()
}
try {
  watch()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const projects = await page.evaluate(async () => [await window.conductor.projects.create('Draft project A'), await window.conductor.projects.create('Draft project B')])
  await writeFile(join(projects[0].path, 'context.txt'), 'Exact attached context before switching.\n')
  await writeFile(join(projects[0].path, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=', 'base64'))
  await page.reload()
  await selectProject('Draft project A')
  const firstId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const firstText = '  Unsent project A\nKeep whitespace, café, and 🧪.  '
  await composer().fill(firstText)
  await page.getByRole('button', { name: 'Attach file context', exact: true }).click()
  await page.getByRole('combobox', { name: 'Context file path', exact: true }).fill('context.txt')
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(page.locator('.sa-context-chips')).toContainText('context.txt')
  await selectProject('Draft project B')
  const secondId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  assert.notEqual(firstId, secondId)
  await expect(composer()).toHaveValue('')
  await composer().fill('Independent project B draft')
  await selectProject('Draft project A')
  await expect(composer()).toHaveValue(firstText)
  await expect(page.locator('.sa-context-chips')).toContainText('context.txt')
  results.checks.push('Project switching restores exact unsent text and attached context without leaking another project draft')

  await page.locator('.session-add').click()
  await page.locator('.launcher-grid button').filter({ hasText: providerName }).click()
  await expect(composer()).toBeEnabled()
  const workspaceId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await expect(composer()).toHaveValue('')
  await composer().fill('Separate workspace draft')
  await page.evaluate(id => window.conductor.structured.rename(id, 'Draft history target'), workspaceId)
  await page.locator('.session-tab').first().click()
  await expect(composer()).toHaveValue(firstText)
  await page.locator('.session-tab').nth(1).click()
  await expect(composer()).toHaveValue('Separate workspace draft')
  await page.locator('.session-tab').first().click()
  await page.getByRole('button', { name: 'Conversation history', exact: true }).click()
  await page.locator('.sa-history-list button').filter({ hasText: 'Draft history target' }).click()
  await expect(composer()).toHaveValue('Separate workspace draft')
  await expect(composer()).toBeDisabled()
  await page.getByRole('button', { name: 'Back to current', exact: true }).click()
  await expect(composer()).toHaveValue(firstText)
  results.checks.push('Workspaces and historical conversations have separate drafts; returning to current restores the right composer')

  await writeFile(join(projects[0].path, 'context.txt'), 'Later file bytes must not replace attached context.\n')
  await page.reload()
  await expect(composer()).toHaveValue(firstText)
  await page.locator('.sa-context-chips button').first().click()
  await expect(page.getByRole('dialog')).toContainText('Exact attached context before switching.')
  await page.keyboard.press('Escape')
  await composer().focus()
  if (provider === 'codex') {
  await expect.poll(async () => Boolean((await page.evaluate(id => window.conductor.structured.snapshot(id), firstId)).capabilities?.imageAttachments)).toBe(true)
  await page.getByRole('button', { name: 'Attach file context', exact: true }).click()
  await page.getByRole('combobox', { name: 'Context file path', exact: true }).fill('pixel.png')
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(page.locator('.sa-context-chips')).toContainText('pixel.png')
  }
  await page.locator('.pane-close-button').first().click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reopen', exact: true }).click()
  await expect(composer()).toHaveValue(firstText)
  if (provider === 'codex') {
  await page.locator('.sa-context-chips button').filter({ hasText: 'pixel.png' }).click()
  await expect(page.locator('.sa-context-image')).toBeVisible()
  await expect.poll(() => page.locator('.sa-context-image').evaluate(image => image.naturalWidth)).toBe(1)
  }
  await page.keyboard.press('Escape')
  results.checks.push('Reload and close/reopen preserve captured file context' + (provider === 'codex' ? '; restored image attachments can be inspected' : ''))

  await page.locator('.pane-menu-button').first().click()
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect(page.locator('.pane-group')).toHaveCount(2)
  await page.locator('.pane-menu-button').first().click()
  const nextWindow = app.waitForEvent('window')
  await page.getByRole('button', { name: 'Open as window', exact: true }).click()
  const detached = await nextWindow
  detached.on('pageerror', error => errors.push(error.message))
  await expect(detached.getByRole('textbox', { name: /^Message / })).toHaveValue(firstText)
  await detached.keyboard.press('Control+e')
  await expect(detached.getByRole('combobox', { name: 'Search files', exact: true })).toBeFocused()
  await expect(detached.locator('.file-picker-results').getByRole('option').first()).toBeVisible()
  await detached.keyboard.press('Escape')
  await expect(detached.locator('.status-version-button')).toBeVisible()
  results.checks.push('Detached windows support Ctrl+E and show a clickable installed version')
  const detachedText = 'Draft edited in a detached window'
  await detached.getByRole('textbox', { name: /^Message / }).fill(detachedText)
  await detached.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => app.windows().length).toBe(1)
  await page.locator('.pane-menu-button').first().click()
  await page.getByRole('button', { name: 'Retrieve closed tab', exact: true }).click()
  await expect(composer()).toHaveValue(detachedText)
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(attachmentCount)
  results.checks.push('Detaching and retrieving a pane preserve text, attached context, and edits made in the other window')

  await app.close()
  app = await launch()
  page = await app.firstWindow()
  watch()
  await expect(composer()).toHaveValue(detachedText)
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(attachmentCount)
  for (const id of [firstId, secondId, workspaceId]) {
    const snapshot = await page.evaluate(id => window.conductor.structured.snapshot(id), id)
    assert.equal(snapshot.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, 0)
  }
  results.checks.push('Full application restart restores drafts; all navigation and restoration submitted zero provider prompts')

  const resume = page.getByRole('button', { name: 'Resume conversation', exact: true })
  if (await resume.count()) await resume.click()
  if (provider === 'codex') await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), firstId)).phase).toBe('idle')
  const invalid = 'x'.repeat(60_001)
  await composer().fill(invalid)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('60000')
  await expect(composer()).toHaveValue(invalid)
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(attachmentCount)
  await composer().fill('SYNTHETIC B: without tools, report the fixture result.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(composer()).toHaveValue('')
  await expect(page.locator('.sa-context-chips > span')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), firstId)).phase).toBe('completed')
  await page.reload()
  await expect(composer()).toHaveValue('')
  results.checks.push('Rejected sends keep text and attachments; a successful synthetic provider send clears them durably')

  // Hold only this isolated test app's submit IPC to exercise a delayed acknowledgement.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('structured:submit')
    ipcMain.handle('structured:submit', (_event, id, text) => new Promise(resolve => { globalThis.draftTestPending = { id, text, resolve } }))
  })
  await composer().fill('Message awaiting acknowledgement')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.draftTestPending))).toBe(true)
  await composer().fill('New draft typed while sending')
  await app.evaluate(() => { globalThis.draftTestPending.resolve(); globalThis.draftTestPending = null })
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await expect(composer()).toHaveValue('New draft typed while sending')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.draftTestPending))).toBe(true)
  await selectProject('Draft project B')
  await expect(composer()).toHaveValue('Independent project B draft')
  await app.evaluate(() => { globalThis.draftTestPending.resolve(); globalThis.draftTestPending = null })
  await expect(composer()).toHaveValue('Independent project B draft')
  await selectProject('Draft project A')
  await expect(composer()).toHaveValue('')
  results.checks.push('Controlled IPC acknowledgement preserves newer typing and clears only the submitted conversation after project switching')
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
