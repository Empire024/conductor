import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Real Electron + real snapshots: an agent edit, the per-conversation change view, and an
// actual revert of bytes on disk — none of it needing a commit or even a git repository.
const root = await mkdtemp(join(tmpdir(), 'conductor-change-history-'))
const output = resolve('artifacts/change-history')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], failures: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Change history fixture'))
  const target = join(project.path, 'panel.mjs')
  await writeFile(target, (await readFile(resolve('scripts/fixtures/panel.mjs'), 'utf8')).replace(/\r\n/g, '\n'))
  await copyFile(resolve('scripts/fixtures/panel.test.mjs'), join(project.path, 'panel.test.mjs'))
  const baseline = await readFile(target, 'utf8')
  await page.reload()
  await page.getByText('Change history fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) {
    await page.locator('.session-add').click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  }
  await page.locator('.structured-agent-pane').waitFor()
  const sessionId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')

  // An empty conversation must say so rather than showing a bare list.
  await page.getByRole('button', { name: 'Local change history', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Local change history/ })).toContainText('has not written any files')
  await page.getByRole('button', { name: /Close Local change history/ }).click()
  results.checks.push('An untouched conversation reports that it has written nothing')

  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await composer.fill('SYNTHETIC A: remove the two unused declarations, then run node --test panel.test.mjs once.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId))?.phase, { timeout: 20_000 }).toBe('completed')
  const edited = await readFile(target, 'utf8')
  assert.notEqual(edited, baseline)

  await page.getByRole('button', { name: 'Local change history', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Local change history/ })
  await expect(dialog).toContainText('panel.mjs')
  await expect(dialog).toContainText('1 file')
  await page.screenshot({ path: join(output, 'by-file.png'), fullPage: true })
  results.screenshots.push('artifacts/change-history/by-file.png')

  // The diff of the recorded change opens straight from this view.
  await dialog.getByRole('button', { name: /^1 edit$/ }).click()
  await dialog.getByRole('button', { name: 'View diff', exact: true }).first().click()
  await page.locator('.monaco-diff-editor').waitFor()
  await page.getByRole('button', { name: /Close Historical diff/ }).click()
  results.checks.push('Every file the conversation touched is listed with its diff, before anything is committed')

  // Turn grouping labels the restore with the prompt that caused it.
  await dialog.getByRole('button', { name: 'By turn', exact: true }).click()
  await expect(dialog).toContainText('SYNTHETIC A: remove the two unused declarations')
  await page.screenshot({ path: join(output, 'by-turn.png'), fullPage: true })
  results.screenshots.push('artifacts/change-history/by-turn.png')
  await dialog.getByRole('button', { name: 'By file', exact: true }).click()

  // A file changed behind Conductor's back is never silently overwritten.
  const later = edited + '// Later user change, preserved by conflict-safe revert.\n'
  await writeFile(target, later)
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(dialog).toContainText('changed outside')
  await expect(dialog.getByRole('button', { name: /Revert file/ })).toBeDisabled()
  await page.screenshot({ path: join(output, 'conflict.png'), fullPage: true })
  results.screenshots.push('artifacts/change-history/conflict.png')
  assert.equal(await readFile(target, 'utf8'), later)
  results.checks.push('An edit made outside the conversation disables the revert and says why; the new bytes stay on disk')

  // Put the agent's own version back, then actually revert it to the pre-agent bytes.
  await writeFile(target, edited)
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /Revert file/ })).toBeEnabled()
  await dialog.getByRole('button', { name: /Revert file/ }).click()
  const confirm = page.getByRole('dialog', { name: 'Restore files', exact: true })
  await expect(confirm).toContainText('panel.mjs')
  await confirm.getByRole('button', { name: 'Restore now', exact: true }).click()
  await expect(dialog).toContainText('Restored 1 file')
  assert.equal(await readFile(target, 'utf8'), baseline)
  results.checks.push('Reverting a file restores the exact bytes from before the agent wrote it, with no git involved')

  // The spent snapshot is not offered a second time.
  await expect(dialog).toContainText(/Already restored/)
  await expect(dialog.getByRole('button', { name: /Revert file/ })).toBeDisabled()
  await page.screenshot({ path: join(output, 'reverted.png'), fullPage: true })
  results.screenshots.push('artifacts/change-history/reverted.png')
  await page.getByRole('button', { name: /Close Local change history/ }).click()

  // The revert is durable history, not just a UI state.
  await page.reload()
  await page.locator('.structured-agent-pane').waitFor()
  const restored = await page.evaluate(id => window.conductor.structured.changeHistory(id), sessionId)
  assert.equal(restored.files.length, 1)
  assert.equal(restored.files[0].revert.restore.length, 0)
  assert.match(restored.files[0].revert.blocked[0].reason, /Already restored/)
  assert.equal(await readFile(target, 'utf8'), baseline)
  results.checks.push('Restart shows the same history and still refuses to reapply a spent snapshot')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
process.exit(results.failures.length ? 1 : 0)
