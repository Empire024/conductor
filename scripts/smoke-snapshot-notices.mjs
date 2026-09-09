import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Real Electron, real Claude adapter wire protocol, real snapshot layer: a turn that writes a
// memory file, a sibling project file and one workspace file must leave the conversation clean.
// Before the fix this same turn printed "Snapshot unavailable: File is outside the session
// workspace" once per tool call, which is what the owner actually saw.
const root = await mkdtemp(join(tmpdir(), 'conductor-snapshot-notices-'))
const outside = join(root, 'outside')
await mkdir(outside, { recursive: true })
const output = resolve('artifacts/snapshot-notices')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_SMOKE_OUTSIDE_DIR: outside
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], failures: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))

  // The window this smoke run drives must never be over the owner's screen.
  const parked = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.getBounds()))
  assert.ok(parked.every(bounds => bounds.x < -1000), `Smoke window was not parked off-screen: ${JSON.stringify(parked)}`)
  results.checks.push('The smoke window is parked off every display, never over the owner')

  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Snapshot notice fixture'))
  const target = join(project.path, 'panel.mjs')
  await writeFile(target, (await readFile(resolve('scripts/fixtures/panel.mjs'), 'utf8')).replace(/\r\n/g, '\n'))
  await copyFile(resolve('scripts/fixtures/panel.test.mjs'), join(project.path, 'panel.test.mjs'))
  const baseline = await readFile(target, 'utf8')
  await page.reload()
  await page.getByText('Snapshot notice fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) {
    await page.locator('.session-add').click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  }
  await page.locator('.structured-agent-pane').waitFor()
  const sessionId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')

  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await composer.fill('SYNTHETIC OUTSIDE: write the memory and sibling files, then edit panel.mjs.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId))?.phase, { timeout: 30_000 }).toBe('completed')

  // The out-of-workspace writes really happened; the workspace edit really landed.
  assert.equal(await readFile(join(outside, 'memory', 'fact.md'), 'utf8'), 'remembered outside the workspace\n')
  assert.equal(await readFile(join(outside, 'sibling-project', 'notes.md'), 'utf8'), 'a sibling project file\n')
  assert.notEqual(await readFile(target, 'utf8'), baseline)
  results.checks.push('The turn wrote two files outside the workspace and edited one inside it')

  const items = (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)).items
  const notices = items.filter(item => item.data.type === 'notice' && item.data.message.startsWith('Snapshot unavailable:'))
  assert.deepEqual(notices.map(item => item.data.message), [], `The conversation reported snapshot failures it should have stayed quiet about: ${JSON.stringify(notices.map(item => item.data.message))}`)
  results.checks.push('No "Snapshot unavailable" notice reached the conversation')

  // Silence is not enough: the in-workspace edit must still produce a real, undoable diff.
  const changes = items.filter(item => item.data.type === 'changes').flatMap(item => item.data.changes)
  assert.deepEqual(changes.map(change => change.path), ['panel.mjs'], `Unexpected recorded changes: ${JSON.stringify(changes.map(change => change.path))}`)
  assert.ok(changes[0].artifactId, 'The in-workspace edit produced no diff artifact')
  results.checks.push('The in-workspace edit still produced exactly one diff artifact')

  // And the timeline the owner reads shows the edit, with nothing shouting at them.
  await expect(page.locator('.structured-agent-pane')).not.toContainText('Snapshot unavailable')
  await page.screenshot({ path: join(output, 'clean-timeline.png'), fullPage: true })
  results.screenshots.push('artifacts/snapshot-notices/clean-timeline.png')

  await page.getByRole('button', { name: 'Local change history', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Local change history/ })
  await expect(dialog).toContainText('panel.mjs')
  await expect(dialog).not.toContainText('fact.md')
  await expect(dialog).not.toContainText('notes.md')
  await page.screenshot({ path: join(output, 'change-history.png'), fullPage: true })
  results.screenshots.push('artifacts/snapshot-notices/change-history.png')
  results.checks.push('Change history lists only the workspace file, not the outside writes')

  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`)
} catch (error) {
  results.failures.push(error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
process.exit(results.failures.length ? 1 : 0)
