// Parked UI check for the local model launcher's compact anonymous control.
// Run after a fresh build: node scripts/smoke-lock.mjs -- node scripts/smoke-anonymous-control.mjs
import assert from 'node:assert/strict'
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'conductor-anonymous-control-'))
const project = 'Anonymous control smoke'
const shots = resolve('artifacts/anonymous-control')
await mkdir(shots, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app
const watchdog = setTimeout(() => { console.error('FAIL smoke timeout'); process.exit(1) }, 3 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForFunction(() => Boolean(window.conductor?.projects))
  const parked = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const bounds = window.getBounds()
    return {
      focused: window.isFocused(),
      overlapping: screen.getAllDisplays().some(({ bounds: display }) =>
        bounds.x < display.x + display.width && bounds.x + bounds.width > display.x &&
        bounds.y < display.y + display.height && bounds.y + bounds.height > display.y)
    }
  })
  assert.deepEqual(parked, { focused: false, overlapping: false }, 'smoke window must remain parked')
  await page.evaluate(name => window.conductor.projects.create(name), project)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project }).first().click()

  const checkbox = page.getByRole('checkbox', { name: 'Anonymous local model' })
  await checkbox.waitFor()
  assert.equal(await checkbox.isChecked(), false, 'default remains ordinary')
  const control = page.locator('.launcher-anonymous')
  const description = await checkbox.getAttribute('aria-describedby')
  assert.ok(description)
  assert.match(await page.locator(`[id="${description}"]`).textContent(), /not restored after a restart.*Files it writes stay/)
  assert.match(await control.locator('label').getAttribute('title'), /Nothing of it is written to history, memory, logs or the phone/)
  const dimensions = await control.evaluate(node => ({ height: node.getBoundingClientRect().height, border: getComputedStyle(node).borderTopWidth }))
  assert.ok(dimensions.height <= 32, `control is too tall: ${dimensions.height}px`)
  assert.equal(dimensions.border, '0px', 'the oversized card border is gone')
  await page.screenshot({ path: join(shots, 'off.png') })

  // An ordinary launch still creates an ordinary tab.
  await page.locator('.launcher-grid button').filter({ hasText: 'Ornith 1.5 9B' }).first().click()
  await page.locator('.sa-session-bar').first().waitFor()
  assert.equal(await page.locator('.pane-tab-anonymous').count(), 0)
  console.log('PASS default launch is ordinary')

  await page.locator('.pane-add-tab').first().click()
  await checkbox.waitFor()
  await checkbox.focus()
  await page.keyboard.press('Space')
  assert.equal(await checkbox.isChecked(), true, 'Space enables anonymous mode')
  await control.locator('label').click()
  assert.equal(await checkbox.isChecked(), false, 'clicking the label turns it off')
  await control.locator('label').click()
  assert.equal(await checkbox.isChecked(), true, 'clicking the label turns it on')
  await page.screenshot({ path: join(shots, 'on.png') })
  await page.locator('.launcher-grid button').filter({ hasText: 'Ornith 1.5 9B' }).first().click()
  await page.locator('.pane-tab-anonymous').first().waitFor()
  await page.locator('.sa-anonymous-mark').first().waitFor()
  console.log('PASS checked launch is anonymous')

  await page.locator('.pane-add-tab').first().click()
  await checkbox.waitFor()
  assert.equal(await checkbox.isChecked(), false, 'a new launcher defaults to ordinary mode')
  await page.screenshot({ path: join(shots, 'off-again.png') })
  console.log('PASS compact control toggles by keyboard and label; screenshots in ' + shots)
  await writeFile(join(shots, 'result.json'), JSON.stringify({ parked, dimensions, screenshots: ['off.png', 'on.png', 'off-again.png'] }, null, 2))
} finally {
  clearTimeout(watchdog)
  if (app) await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15_000))])
  try { app?.process().kill() } catch { /* already gone */ }
}
