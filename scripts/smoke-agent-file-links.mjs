import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// A synthetic Claude turn whose reply carries the exact link shapes a provider writes for a
// Windows path: `/C:/…` with %20 spaces, `file:///C:/…`, a native `C:\…` path into a sibling
// project, and one path in no open project that must stay refused.
const root = await mkdtemp(join(tmpdir(), 'conductor-file-links-'))
const output = resolve('artifacts/agent-file-links')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const results = { root, checks: [], notes: [], errors: [] }
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15_000)
page.on('pageerror', (error) => results.errors.push(error.stack ?? error.message))
const shot = (name) => page.screenshot({ path: join(output, name + '.png'), fullPage: true })
const menu = () => page.locator('.sa-file-link-menu')
const menuItem = (label) => menu().getByRole('menuitem').filter({ hasText: label })
async function openMenu(link) {
  await link.click({ button: 'right' })
  await expect(menu()).toBeVisible()
  return menu()
}
async function shellCalls() {
  return app.evaluate(() => globalThis.__conductorShellCalls ?? [])
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })

  // The two shell entry points these actions end in would take the owner's desktop (an Explorer
  // window, the default browser, Blender). Record them in the main process instead of firing them.
  const stubbed = await app.evaluate(({ shell }) => {
    globalThis.__conductorShellCalls = []
    try {
      shell.openExternal = async (target) => { globalThis.__conductorShellCalls.push(['openExternal', target]) }
      shell.openPath = async (target) => { globalThis.__conductorShellCalls.push(['openPath', target]); return '' }
      shell.showItemInFolder = (target) => { globalThis.__conductorShellCalls.push(['showItemInFolder', target]) }
    } catch { /* reported below */ }
    return ['openExternal', 'openPath', 'showItemInFolder'].every((name) => String(shell[name]).includes('__conductorShellCalls'))
  })
  assert.ok(stubbed, 'Could not record shell calls in the main process')

  const project = await page.evaluate(() => window.conductor.projects.create('Link fixture'))
  const sibling = await page.evaluate(() => window.conductor.projects.create('Sibling project'))
  await mkdir(join(project.path, 'renders'), { recursive: true })
  await mkdir(join(sibling.path, 'docs'), { recursive: true })
  const pngPath = join(project.path, 'renders', 'Before after comparison.png')
  const blendPath = join(project.path, 'CR5 model.blend')
  const siblingPath = join(sibling.path, 'docs', 'Sibling notes.md')
  await writeFile(pngPath, PNG_1x1)
  await writeFile(blendPath, Buffer.concat([Buffer.from('BLENDER-v304RENDH'), Buffer.alloc(2048, 7)]))
  await writeFile(siblingPath, '# Sibling notes\n\nOwned by the other open project.\n')

  const driveUrl = (path) => '/' + path.replaceAll('\\', '/').replaceAll(' ', '%20')
  const reply = [
    'Here is the delivery.',
    '',
    '- Before/after comparison: [Before after comparison.png](' + driveUrl(pngPath) + ')',
    '- Updated Blender model: [CR5 model.blend](<file:///' + blendPath.replaceAll('\\', '/') + '>)',
    '- Sibling project note: [Sibling notes.md](<' + siblingPath + '>)',
    '- Outside every project: [hosts](/C:/Windows/System32/drivers/etc/hosts)'
  ].join('\n')

  await page.reload()
  await page.getByText('Link fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  else if (!await page.locator('.structured-agent-pane').count()) {
    await page.locator('.session-add').click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  }
  await page.locator('.structured-agent-pane').waitFor()
  const sessionId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.getByRole('textbox', { name: /message|prompt/i }).last().fill('SYNTHETIC FILELINKS\n<<<\n' + reply + '\n>>>')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate((id) => window.conductor.structured.snapshot(id), sessionId))?.phase, { timeout: 20_000 }).toBe('completed')

  const message = page.locator('.sa-assistant .sa-markdown').last()
  const links = message.locator('a')
  await expect(links).toHaveCount(3)
  await expect(message).toContainText('hosts')
  results.checks.push('The three in-project link shapes (/C:/… with %20, file:///C:/…, native C:\\… into a sibling project) render as live links; a path in no open project is not linkable at all')
  const pngLink = links.filter({ hasText: 'Before after comparison.png' })
  const blendLink = links.filter({ hasText: 'CR5 model.blend' })
  const siblingLink = links.filter({ hasText: 'Sibling notes.md' })
  await shot('message')

  // 1. Plain click on the /C:/… PNG link: the exact link that used to be dead.
  await pngLink.click()
  // Every open file tab stays mounted; only the active one is not hidden.
  const preview = page.locator('.file-tab-content:not([hidden]) .file-preview-pane')
  await expect(preview.locator('header strong')).toHaveText('Before after comparison.png')
  const image = preview.locator('.image-preview-stage img')
  await expect(image).toBeVisible()
  assert.ok(await image.evaluate((el) => el.complete && el.naturalWidth > 0), 'The PNG preview did not decode any pixels')
  await expect(page.locator('.file-tab').filter({ hasText: 'Before after comparison.png' })).toHaveCount(1)
  results.checks.push('Clicking the /C:/…%20… PNG link opens the image preview and the PNG actually decodes')
  await shot('png-preview')

  // 2. Plain click on the file:///C:/… .blend link: a binary must be described and handed to the
  //    OS, never loaded into the text editor as unreadable bytes.
  await blendLink.click()
  await expect(preview.locator('header strong')).toHaveText('CR5 model.blend')
  await expect(preview.locator('.file-preview-state.binary')).toContainText('Conductor has no viewer for this file type')
  await expect(preview.locator('.file-preview-state.error')).toHaveCount(0)
  await preview.getByRole('button', { name: 'Open with default app' }).click()
  await expect.poll(shellCalls).toContainEqual(['openPath', blendPath])
  results.checks.push('Clicking the file:///C:/… .blend link describes the binary and its "Open with default app" reaches the OS handler with the real absolute path')
  await shot('blend-preview')

  // 3. All six context-menu actions on an agent's link.
  await openMenu(pngLink)
  await expect(menu().getByRole('menuitem')).toHaveCount(6)
  await expect(menu().getByRole('menuitem')).toHaveText([/Edit/, /Open in browser/, /Open in default browser/, /Preview/, /Reveal in Conductor Explorer/, /Show in Windows Explorer/])
  await menuItem('Preview').click()
  await expect(preview.locator('header strong')).toHaveText('Before after comparison.png')

  await openMenu(pngLink)
  await menuItem('Show in Windows Explorer').click()
  await expect.poll(shellCalls).toContainEqual(['showItemInFolder', pngPath])

  await openMenu(pngLink)
  await menuItem('Open in default browser').click()
  await expect.poll(async () => (await shellCalls()).some(([name, target]) => name === 'openExternal' && target.includes('Before')), { timeout: 20_000 }).toBe(true)

  await openMenu(pngLink)
  await menuItem('Open in browser').click()
  await expect(page.locator('.file-view-toolbar button[aria-label="Open in browser"]')).toHaveAttribute('aria-pressed', 'true')

  if (!await page.locator('.explorer-sidebar .explorer-tree:visible').count()) await page.locator('.activity-rail button[aria-label="Explorer"]').click()
  await expect(page.locator('.explorer-sidebar .explorer-tree:visible').first()).toBeVisible()
  await openMenu(pngLink)
  await menuItem('Reveal in Conductor Explorer').click()
  await expect(page.locator('.explorer-row:visible').filter({ hasText: 'Before after comparison.png' }).first()).toBeVisible()
  results.checks.push('The right-click menu on an agent link offers all six actions and each one acts on the linked file: preview, OS reveal, default browser, in-app browser and Conductor Explorer reveal')
  await shot('context-menu')

  await openMenu(pngLink)
  await menuItem('Edit').click()
  await expect(page.locator('.file-tab').filter({ hasText: 'Before after comparison.png' })).toHaveCount(1)

  // 4. A link into a different project that is open in the same session.
  await siblingLink.click()
  await expect(page.locator('.file-view-toolbar > span').first()).toHaveText('docs/Sibling notes.md')
  await expect(page.locator('.file-tab').filter({ hasText: 'Sibling notes.md' })).toHaveCount(1)
  await expect(page.locator('.file-tab-content:not([hidden])')).toContainText('Owned by the other open project')
  await openMenu(siblingLink)
  await menuItem('Show in Windows Explorer').click()
  await expect.poll(shellCalls).toContainEqual(['showItemInFolder', siblingPath])
  results.checks.push('A link whose absolute path lands in a different open project opens that project\'s file and scopes its menu actions to that project, not the conversation\'s own')
  await shot('sibling-project')

  results.notes.push('Reveal in Conductor Explorer only flashes the row in the explorer of the project that owns the file, so for a sibling-project link it is a no-op until that project\'s explorer is on screen.')
  await expect(page.locator('.sa-error')).toHaveCount(0)
  assert.deepEqual(results.errors, [])
} catch (error) {
  results.errors.push(error.stack ?? String(error))
  await shot('failure').catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
}
