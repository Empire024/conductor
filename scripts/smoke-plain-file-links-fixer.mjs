import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Derived from smoke-agent-file-links.mjs. This fixture keeps the existing Markdown link and
// exercises the new plain-prose and inline-code forms without calling a live provider.
const root = await mkdtemp(join(tmpdir(), 'conductor-plain-file-links-'))
const output = resolve('artifacts/plain-file-links-fixer')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const results = { root, checks: [], errors: [] }
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15_000)
page.on('pageerror', error => results.errors.push(error.stack ?? error.message))
const shot = name => page.screenshot({ path: join(output, name + '.png'), fullPage: true })
const menu = () => page.locator('.sa-file-link-menu')
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Plain links fixture'))
  const sibling = await page.evaluate(() => window.conductor.projects.create('Plain links sibling'))
  await mkdir(join(project.path, 'renders'), { recursive: true })
  await mkdir(join(sibling.path, 'docs'), { recursive: true })
  await writeFile(join(project.path, 'renders', 'Before after comparison.png'), Buffer.from('plain-file-link fixture'))
  await writeFile(join(project.path, 'CR5 model.blend'), Buffer.from('BLENDER-v304'))
  await writeFile(join(sibling.path, 'docs', 'Sibling notes.md'), '# sibling\n')
  const siblingPath = join(sibling.path, 'docs', 'Sibling notes.md')
  const reply = [
    'Plain local path: renders/Before after comparison.png:1.',
    'Inline local path: `CR5 model.blend`.',
    'Sibling Windows path: ' + siblingPath + '.',
    'Invalid local-looking path: renders/missing file.png.',
    'Existing Markdown link: [Before after comparison.png](renders/Before%20after%20comparison.png).',
    '',
    '```text',
    'renders/Before after comparison.png',
    '```'
  ].join('\n')
  await page.reload()
  await page.getByText('Plain links fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) { await page.locator('.session-add').click(); await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click() }
  await page.locator('.structured-agent-pane').waitFor()
  const sessionId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.getByRole('textbox', { name: /message|prompt/i }).last().fill('SYNTHETIC FILELINKS\n<<<\n' + reply + '\n>>>')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId))?.phase).toBe('completed')
  const message = page.locator('.sa-assistant .sa-markdown').last()
  await expect(message.locator('a')).toHaveCount(4)
  await expect(message).toContainText('renders/missing file.png')
  await expect(message.locator('a').filter({ hasText: 'missing file.png' })).toHaveCount(0)
  await expect(message.locator('.sa-code-block a')).toHaveCount(0)
  results.checks.push('Verified prose, inline-code, and sibling Windows paths link; an invalid path and fenced code remain ordinary text')
  const prose = message.locator('a').filter({ hasText: 'renders/Before after comparison.png' }).first()
  const inline = message.locator('a').filter({ hasText: 'CR5 model.blend' })
  const siblingLink = message.locator('a').filter({ hasText: 'Sibling notes.md' })
  const existing = message.locator('a').filter({ hasText: 'Before after comparison.png' }).last()
  await prose.click()
  await expect(page.locator('.file-tab-content:not([hidden])')).toContainText('Before after comparison.png')
  await inline.click()
  await expect(page.locator('.file-tab-content:not([hidden])')).toContainText('CR5 model.blend')
  await siblingLink.click()
  await expect(page.locator('.file-tab-content:not([hidden])')).toContainText('sibling')
  results.checks.push('Plain and inline-code paths open their correct project files, including an open sibling project')
  // Let the stat cache pass its TTL, then cause unrelated UI work before using the already
  // completed message again. Both links must remain live; mounted messages retain their last
  // successful verification and revalidate only on a later mount or text change.
  await page.waitForTimeout(15_250)
  await page.locator('.activity-rail button[aria-label="Explorer"]').click()
  await prose.click()
  await expect(page.locator('.file-tab-content:not([hidden])')).toContainText('Before after comparison.png')
  await inline.click()
  await expect(page.locator('.file-tab-content:not([hidden])')).toContainText('CR5 model.blend')
  results.checks.push('Completed-message links survive cache expiry and unrelated rendering while mounted')
  await page.evaluate(() => { window.__plainFileLinkModifier = null; window.addEventListener('conductor:agent-file', event => { window.__plainFileLinkModifier = event.detail }, { once: true }) })
  await existing.click({ modifiers: ['Control'] })
  await expect.poll(() => page.evaluate(() => window.__plainFileLinkModifier?.path)).toBe('renders/Before after comparison.png')
  await existing.click({ button: 'right' })
  await expect(menu()).toBeVisible()
  await expect(menu().getByRole('menuitem')).toHaveCount(6)
  await menu().getByRole('menuitem').filter({ hasText: 'Preview' }).click()
  results.checks.push('Existing Markdown links keep Ctrl-click and all six context actions')
  await expect(page.locator('.sa-error')).toHaveCount(0)
  assert.deepEqual(results.errors, [])
  await shot('plain-file-links')
} catch (error) {
  results.errors.push(error.stack ?? String(error))
  await shot('failure').catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
}
