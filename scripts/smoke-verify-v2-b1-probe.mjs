import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2b1p-'))
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const b = args.at(-1)?.buttons ?? []; const i = b.findIndex(l => l === "Don't Save" || l === 'Stop work and quit'); return { response: i >= 0 ? i : 0, checkboxChecked: false } } }),
    new Promise((r) => setTimeout(r, 5000))
  ]).catch(() => {})
  let pid; try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_STEER: 'review', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const t0 = Date.now()
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
console.log('launch took ' + (Date.now() - t0) + 'ms')
const page = await app.firstWindow()
page.setDefaultTimeout(30000)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
  await page.evaluate(() => window.conductor.projects.create('B1Probe'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'B1Probe' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true })
  await expect(composer).toBeEnabled({ timeout: 20000 })
  await composer.fill('synthetic:backlog')
  const t1 = Date.now()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
  console.log('turn running after ' + (Date.now() - t1) + 'ms')
  await composer.fill('probe queued message')
  const t2 = Date.now()
  const queueBtn = page.getByRole('button', { name: 'Queue message', exact: true })
  const visibleWithin = await queueBtn.isVisible({ timeout: 30000 }).catch(() => false)
  console.log('Queue message visible=' + visibleWithin + ' after ' + (Date.now() - t2) + 'ms')
  if (!visibleWithin) {
    const html = await page.locator('.sa-composer').innerHTML().catch(() => '<no composer>')
    console.log('composer HTML sample: ' + html.slice(0, 1500))
    const allButtons = await page.locator('.sa-composer button').allTextContents().catch(() => [])
    console.log('composer buttons: ' + JSON.stringify(allButtons))
  } else {
    await queueBtn.click()
    console.log('queued OK, sa-queue count=' + await page.locator('.sa-queue').count())
  }
} catch (error) {
  console.error('PROBE FAIL: ' + (error?.stack ?? error))
} finally { await safeClose(app) }
process.exit(0)
