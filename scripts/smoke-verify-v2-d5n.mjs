import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const b = args.at(-1)?.buttons ?? []; const i = b.findIndex(l => l === "Don't Save" || l === 'Stop work and quit'); return { response: i >= 0 ? i : 0, checkboxChecked: false } } }),
    new Promise((r) => setTimeout(r, 5000))
  ]).catch(() => {})
  let pid; try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(() => { console.error('WATCHDOG exceeded 280s at ' + lastStep); process.exit(2) }, 280_000)
watchdog.unref()

const root = await mkdtemp(join(tmpdir(), 'conductor-v2d5n-'))
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_SMOKE_BACKGROUND_MS: '20000', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
let result = { label: 'D5n', pass: false }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
  step('creating project')
  await page.evaluate(() => window.conductor.projects.create('D5n fixture'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'D5n fixture' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const visible = page.locator('.pane-tab-content:visible')
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const composer = visible.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled({ timeout: 20000 })
  step('sending SYNTHETIC BASH WAIT')
  await composer.fill('SYNTHETIC BASH WAIT')
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForTimeout(500)
  step('opening CLI drawer')
  await visible.getByRole('button', { name: 'CLI', exact: true }).click()
  const live = visible.locator('.sa-cli-live')
  await expect(live).toBeVisible({ timeout: 20000 })
  const timeOrigin0 = await page.evaluate(() => performance.timeOrigin)
  const timeline = visible.locator('.sa-timeline')

  const sample = async (label) => {
    const xtermText = await live.locator('.native-cli-terminal').innerText().catch(() => '<none>')
    const itemCount = await timeline.evaluate((el) => el.querySelectorAll('[data-item-id]').length).catch(() => -1)
    const snap = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    return { label, xtermTextTail: xtermText.slice(-400), itemCount, phase: snap.phase }
  }
  const t0 = await sample('t0')
  await page.screenshot({ path: join(output, 'd5n-t0.png') })
  await page.waitForTimeout(3000)
  const t3 = await sample('t3')
  await page.waitForTimeout(3000)
  const t6 = await sample('t6')
  await page.screenshot({ path: join(output, 'd5n-t6.png') })

  step('closing and reopening the drawer')
  await visible.locator('.sa-session-bar').getByRole('button', { name: 'CLI', exact: true }).click()
  await expect(live).toBeHidden({ timeout: 10000 })
  await visible.locator('.sa-session-bar').getByRole('button', { name: 'CLI', exact: true }).click()
  await expect(live).toBeVisible({ timeout: 10000 })
  const timeOrigin1 = await page.evaluate(() => performance.timeOrigin)

  result = { label: 'D5n', pass: true, record: { t0, t3, t6, sameRenderer: timeOrigin0 === timeOrigin1, pageErrors: errors } }
  console.log('RESULT ' + JSON.stringify(result.record))
} catch (error) {
  result = { label: 'D5n', pass: false, error: String(error?.stack ?? error), lastStep }
  console.error('FAIL D5n at [' + lastStep + ']: ' + error)
  await page.screenshot({ path: join(output, 'd5n-failure.png') }).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await writeFile(join(output, 'd5n-result.json'), JSON.stringify(result, null, 2))
  await safeClose(app)
}
process.exit(0)
