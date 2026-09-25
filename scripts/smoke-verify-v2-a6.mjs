import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG exceeded 180s at ' + lastStep)
  await writeFile(join(output, 'a6-partial.json'), JSON.stringify({ lastStep }, null, 2)).catch(() => {})
  process.exit(2)
}, 180_000)
watchdog.unref()
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const b = args.at(-1)?.buttons ?? []; const i = b.findIndex(l => l === "Don't Save" || l === 'Stop work and quit'); return { response: i >= 0 ? i : 0, checkboxChecked: false } } }),
    new Promise((r) => setTimeout(r, 5000))
  ]).catch(() => {})
  let pid; try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}

const root = await mkdtemp(join(tmpdir(), 'conductor-v2a6-'))
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const draftText = 'draft-A6 ünïcødé 🎉 中文'
let result = { label: 'A6', pass: false }
try {
  step('launch 1')
  const app1 = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  let draftAfterSwitch
  try {
    const page = await app1.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    step('create project + tab A')
    await page.evaluate(() => window.conductor.projects.create('A6 fixture'))
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'A6 fixture' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 15000 })
    step('typing draft')
    await composer.fill(draftText)
    step('opening a second session (tab B)')
    await page.locator('.sidebar .new-session').click({ timeout: 10000 })
    await page.waitForTimeout(200)
    step('switching back to the session with the draft')
    const rows = page.locator('.sidebar-session-row')
    await rows.first().click({ timeout: 10000 })
    await page.waitForTimeout(200)
    draftAfterSwitch = await composer.inputValue().catch(() => '<not found>')
    step('draft after switch: ' + JSON.stringify(draftAfterSwitch))
    await page.screenshot({ path: join(output, 'a6-after-switch.png') })
  } finally { await safeClose(app1) }

  step('relaunching same profile')
  const app2 = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  let draftAfterRelaunch
  try {
    const page2 = await app2.firstWindow()
    page2.setDefaultTimeout(15000)
    await page2.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    await page2.locator('.project-row').filter({ hasText: 'A6 fixture' }).click().catch(() => {})
    await page2.waitForTimeout(1000)
    const composer2 = page2.getByRole('textbox', { name: /Message Claude/i }).first()
    draftAfterRelaunch = await composer2.inputValue().catch(() => '<not found>')
    await page2.screenshot({ path: join(output, 'a6-after-relaunch.png') })
  } finally { await safeClose(app2) }

  result = { label: 'A6', pass: true, record: { draftAfterSwitch, matchesAfterSwitch: draftAfterSwitch === draftText, draftAfterRelaunch, matchesAfterRelaunch: draftAfterRelaunch === draftText } }
  console.log('RESULT ' + JSON.stringify(result.record))
} catch (error) {
  result = { label: 'A6', pass: false, error: String(error?.stack ?? error), lastStep }
  console.error('FAIL A6 at [' + lastStep + ']: ' + error)
} finally {
  clearTimeout(watchdog)
  await writeFile(join(output, 'a6-result.json'), JSON.stringify(result, null, 2))
}
process.exit(0)
