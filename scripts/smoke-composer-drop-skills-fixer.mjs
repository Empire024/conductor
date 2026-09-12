import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// Offline Codex fixture plus real renderer/IPC/filesystem. It executes no model inference and no
// provider tools; synthetic prompts are used only for the Stop-state lifecycle assertion.
const root = await mkdtemp(join(tmpdir(), 'conductor-composer-drop-'))
const output = resolve('artifacts/composer-drop-skills-fixer')
await mkdir(output, { recursive: true })
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
const evidenceId = `generation${slot.generation}`
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_BACKGROUND_WINDOWS: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(20_000)
const report = { syntheticProvider: true, checks: [], failures: [], root }
const check = label => { report.checks.push(label); console.log('PASS ' + label) }
const rendererErrors = []; page.on('pageerror', error => { if (error.message !== 'Canceled') rendererErrors.push(error.stack ?? error.message) })
let originalFailure, cleanupFailure

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.files))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Composer drop fixture'))
  const folder = join(project.path, 'destination'), outside = join(root, 'outside')
  await mkdir(folder); await mkdir(outside)
  await writeFile(join(project.path, 'move-me.txt'), 'move exact bytes')
  await writeFile(join(project.path, 'collision.txt'), 'source collision')
  await writeFile(join(folder, 'collision.txt'), 'destination collision')
  await writeFile(join(project.path, 'open-me.md'), '# Opened from a workspace drop\n')
  const note = join(outside, 'context.md'), media = join(outside, 'clip.mp4'), image = join(outside, 'pixel.png')
  await writeFile(note, '# Exact external context\nKeep this text.\n')
  await writeFile(media, Buffer.from([0, 255, 17, 32, 99, 128]))
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=', 'base64'))
  await page.reload()
  await page.getByText('Composer drop fixture', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const pane = page.locator('.structured-agent-pane:visible')
  const composer = pane.getByRole('textbox', { name: 'Message Codex', exact: true })
  await expect(composer).toBeEnabled()
  const id = await pane.getAttribute('data-structured-session')
  const snapshot = () => page.evaluate(agentId => window.conductor.structured.snapshot(agentId), id)

  // Real File objects selected from disk retain Electron's native path metadata. Re-dispatch those
  // exact objects as one OS-style Files drop onto the composer.
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'native-drop-fixture'; input.hidden = true; document.body.append(input) })
  await page.locator('#native-drop-fixture').setInputFiles([note, media, image])
  const transfer = await page.evaluateHandle(() => {
    const value = new DataTransfer()
    for (const file of document.querySelector('#native-drop-fixture').files) value.items.add(file)
    return value
  })
  await pane.locator('.sa-composer').dispatchEvent('dragover', { dataTransfer: transfer })
  await pane.locator('.sa-composer').dispatchEvent('drop', { dataTransfer: transfer })
  await expect(pane.locator('.sa-context-chips > span')).toHaveCount(3)
  await pane.locator('.sa-context-chips button').filter({ hasText: 'context.md' }).click()
  await expect(page.getByRole('dialog')).toContainText('# Exact external context')
  await page.keyboard.press('Escape')
  await pane.locator('.sa-context-chips button').filter({ hasText: 'clip.mp4' }).click()
  const mediaDialog = page.getByRole('dialog')
  await expect(mediaDialog).toContainText('This is opaque media')
  const mediaMetadata = JSON.parse(await mediaDialog.locator('pre').textContent())
  assert.deepEqual(Object.keys(mediaMetadata).sort(), ['mimeType', 'path', 'size'])
  assert.equal(mediaMetadata.mimeType, 'video/mp4')
  assert.equal(mediaMetadata.size, 6)
  await page.keyboard.press('Escape')
  await pane.locator('.sa-context-chips button').filter({ hasText: 'pixel.png' }).click()
  await expect(page.locator('.sa-context-image')).toBeVisible()
  await expect.poll(() => page.locator('.sa-context-image').evaluate(element => element.naturalWidth)).toBe(1)
  await page.keyboard.press('Escape')
  check('One OS-style drop attaches exact Markdown, honest opaque MP4 metadata and a preserved image without treating binary bytes as text')

  const retainedDraft = 'Draft survives an invalid file drop'
  await composer.fill(retainedDraft)
  const invalidTransfer = await page.evaluateHandle(() => { const value = new DataTransfer(); value.items.add(new File(['bytes'], 'pathless.bin')); return value })
  await pane.locator('.sa-composer').dispatchEvent('drop', { dataTransfer: invalidTransfer })
  await expect(page.getByRole('alert')).toContainText('did not provide a path')
  await expect(composer).toHaveValue(retainedDraft)
  check('A rejected pathless drop leaves the draft and existing attachments intact')

  const beforeHelper = await snapshot()
  await pane.getByRole('button', { name: 'Composer helpers', exact: true }).click()
  const helpers = pane.getByRole('menu', { name: 'Composer helpers', exact: true })
  await expect(helpers).toContainText('Grill me')
  await expect(helpers).toContainText('Find root cause')
  await expect(helpers).toContainText('Map the code')
  await expect(helpers).toContainText('Risk review')
  await helpers.getByRole('menuitem').filter({ hasText: 'Grill me' }).click()
  await expect(composer).toHaveValue(/Draft survives an invalid file drop[\s\S]+Help me develop this idea by grilling me/)
  const afterHelper = await snapshot()
  assert.deepEqual(afterHelper.settings, beforeHelper.settings)
  assert.equal(afterHelper.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, beforeHelper.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length)
  await pane.getByRole('button', { name: 'Session settings', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Skills & connections', exact: true }).click()
  const discovery = page.getByRole('dialog', { name: 'Codex configuration' })
  await expect(discovery).toContainText('Read-only details')
  await expect(discovery).toContainText(/skills|commands|connections/i)
  await page.keyboard.press('Escape')
  const afterDiscovery = await snapshot()
  assert.deepEqual(afterDiscovery.settings, beforeHelper.settings)
  assert.equal(afterDiscovery.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, beforeHelper.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length)
  check('Grill me and the provider-neutral suite prepare a draft; native skill discovery stays read-only and changes no model, tools or permissions')

  await page.setViewportSize({ width: 520, height: 760 })
  await composer.fill('Narrow composer reachability')
  const send = pane.getByRole('button', { name: 'Send message', exact: true })
  await expect(send).toBeVisible()
  const hostBox = await pane.boundingBox(), buttonBox = await send.boundingBox()
  const geometry = {
    paneRight: hostBox.x + hostBox.width, paneBottom: hostBox.y + hostBox.height,
    buttonRight: buttonBox.x + buttonBox.width, buttonBottom: buttonBox.y + buttonBox.height,
    hit: await send.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element || element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) })
  }
  assert.ok(geometry.buttonRight <= geometry.paneRight && geometry.buttonBottom <= geometry.paneBottom && geometry.hit, JSON.stringify(geometry))
  check('At 520px the final Send control wraps inside the pane and remains the pointer hit target')

  // Explorer collisions and successful moves are exercised through native drag events; the final
  // workspace-stage drop must open an editor instead of attaching context or moving the source.
  const row = name => page.locator('.explorer-row.file').filter({ hasText: name })
  const destination = page.locator('.explorer-row.directory').filter({ hasText: 'destination' })
  await row('collision.txt').dragTo(destination)
  await expect.poll(async () => (await readFile(join(project.path, 'collision.txt'), 'utf8'))).toBe('source collision')
  assert.equal(await readFile(join(folder, 'collision.txt'), 'utf8'), 'destination collision')
  await row('move-me.txt').dragTo(destination)
  await expect.poll(async () => (await readFile(join(folder, 'move-me.txt'), 'utf8'))).toBe('move exact bytes')
  await assert.rejects(access(join(project.path, 'move-me.txt')))
  check('Explorer drop moves once into the chosen folder and a collision preserves both files')

  await row('open-me.md').dragTo(page.locator('.runtime-document-stage'), { targetPosition: { x: 8, y: 8 } })
  await expect(page.locator('.code-pane:visible')).toBeVisible()
  assert.equal(await readFile(join(project.path, 'open-me.md'), 'utf8'), '# Opened from a workspace drop\n')
  check('Dropping a project file on the workspace opens the editor without moving the file')

  // Return to the agent tab for the active Stop/interrupted state proof.
  await page.locator('.pane-tab').filter({ hasText: 'Codex' }).click()
  await composer.fill('synthetic:steer-review')
  await send.click()
  const stop = pane.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  const stopStyle = await stop.evaluate(element => {
    const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; element.append(probe)
    const value = { state: element.getAttribute('data-state'), background: getComputedStyle(element).backgroundImage, color: getComputedStyle(element).color, danger: getComputedStyle(probe).color }
    probe.remove(); return value
  })
  assert.equal(stopStyle.state, 'stop')
  const dangerChannels = stopStyle.danger.match(/[\d.]+/g).slice(0, 3).map(Number)
  assert.ok(dangerChannels[0] > dangerChannels[1] * 1.35 && dangerChannels[0] > dangerChannels[2] * 1.25, stopStyle.danger)
  assert.notEqual(stopStyle.background, 'none')
  assert.equal(stopStyle.color, 'rgb(255, 255, 255)')
  await stop.click()
  await expect.poll(async () => (await snapshot()).phase).toBe('interrupted')
  await expect(pane.getByText('Runtime interrupted', { exact: true })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Resume conversation', exact: true })).toBeVisible()
  check('Stop is visibly red and reachable; interrupted is distinct from idle and offers the same-conversation resume')

  assert.deepEqual(rendererErrors, [])
  await page.screenshot({ path: join(output, `composer-${evidenceId}.png`), fullPage: true })
} catch (error) {
  originalFailure = error
  report.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, `failure-${evidenceId}.png`), fullPage: true }).catch(() => {})
} finally {
  try { await cleanupFixtureApp(app, report, 'composer/drop/skills fixture cleanup') }
  catch (error) { cleanupFailure = error; report.failures.push(error.stack ?? String(error)) }
  await writeFile(join(output, `report-${evidenceId}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
}
const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
