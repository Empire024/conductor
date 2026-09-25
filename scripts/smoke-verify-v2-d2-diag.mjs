import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const events = 10000
const root = await mkdtemp(join(tmpdir(), 'conductor-v2d2diag-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const b = args.at(-1)?.buttons ?? []; const i = b.findIndex(l => l === "Don't Save" || l === 'Stop work and quit'); return { response: i >= 0 ? i : 0, checkboxChecked: false } } }),
    new Promise((r) => setTimeout(r, 5000))
  ]).catch(() => {})
  let pid; try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
  await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => window.__copied.push(t) })
  await page.evaluate(() => window.conductor.projects.create('D2 diag'))
  await page.getByText('D2 diag', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).first().click()
  const visible = page.locator('.pane-tab-content:visible')
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const composer = () => visible.getByRole('textbox', { name: /message/i }).last()
  await composer().fill('SYNTHETIC LONG ' + events)
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 600000, intervals: [250] }).toBe('completed')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
  await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => window.__copied.push(t) })
  await page.getByText('D2 diag', { exact: true }).first().click()
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  await visible.getByRole('button', { name: 'Copy transcript', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__copied.length), { timeout: 15000 }).toBe(1)
  const markdown = await page.evaluate(() => window.__copied[0])
  await writeFile(join(output, 'd2-diag-transcript.md'), markdown)
  console.log('RESULT length=' + markdown.length)
  console.log('HEAD: ' + JSON.stringify(markdown.slice(0, 500)))
  console.log('startsWithExpected: ' + markdown.includes('## You\n\nSYNTHETIC LONG ' + events))
} catch (error) {
  console.error('FAIL: ' + (error?.stack ?? error))
} finally { await safeClose(app) }
process.exit(0)
