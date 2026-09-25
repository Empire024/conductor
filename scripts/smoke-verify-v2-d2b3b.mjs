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

async function freshApp(label) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-v2-' + label + '-'))
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
  return { app, page }
}

const results = {}

// D2b: fresh SYNTHETIC LONG 4000 (under the 20k deletion cap)
try {
  const { app, page } = await freshApp('d2b')
  try {
    step('D2b: create conversation')
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => window.__copied.push(t) })
    await page.evaluate(() => window.conductor.projects.create('D2b fixture'))
    await page.getByText('D2b fixture', { exact: true }).first().click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).first().click()
    const visible = page.locator('.pane-tab-content:visible')
    await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
    const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
    const composer = () => visible.getByRole('textbox', { name: /message/i }).last()
    step('D2b: sending SYNTHETIC LONG 4000')
    await composer().fill('SYNTHETIC LONG 4000')
    await visible.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 120000, intervals: [250] }).toBe('completed')
    step('D2b: reload and copy transcript')
    await page.reload()
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => window.__copied.push(t) })
    await page.getByText('D2b fixture', { exact: true }).first().click()
    await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
    const t0 = Date.now()
    await visible.getByRole('button', { name: 'Copy transcript', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__copied.length), { timeout: 15000 }).toBe(1)
    const copyMs = Date.now() - t0
    const markdown = await page.evaluate(() => window.__copied[0])
    await writeFile(join(output, 'transcript-4000.md'), markdown)
    const startsCorrectly = markdown.startsWith('# SYNTHETIC LONG 4000') && markdown.includes('## You\n\nSYNTHETIC LONG 4000')
    const endsCorrectly = markdown.trim().endsWith('4000 provider messages replayed; no model or tool execution.')
    const headingCount = (markdown.match(/^## /gm) ?? []).length
    results.D2b = { bytes: markdown.length, headingCount, copyMs, startsCorrectly, endsCorrectly, head: markdown.slice(0, 200), tail: markdown.slice(-300) }
    console.log('RESULT D2b ' + JSON.stringify(results.D2b))
  } catch (error) {
    results.D2b = { error: String(error?.stack ?? error) }
    console.error('FAIL D2b: ' + error)
  } finally { await safeClose(app) }
} catch (error) { results.D2b = { error: 'launch failed: ' + String(error) } }

// D3b: fresh SYNTHETIC LONG 10000, search Step 4990 (journal-only, within floor) and Step 1700 (just above floor)
try {
  const { app, page } = await freshApp('d3b')
  try {
    step('D3b: create conversation')
    await page.evaluate(() => window.conductor.projects.create('D3b fixture'))
    await page.getByText('D3b fixture', { exact: true }).first().click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).first().click()
    const visible = page.locator('.pane-tab-content:visible')
    await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
    const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
    const composer = () => visible.getByRole('textbox', { name: /message/i }).last()
    step('D3b: sending SYNTHETIC LONG 10000')
    await composer().fill('SYNTHETIC LONG 10000')
    await visible.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 120000, intervals: [250] }).toBe('completed')
    await page.reload()
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    await page.getByText('D3b fixture', { exact: true }).first().click()
    await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
    await expect(composer()).toBeEnabled({ timeout: 30000 })
    const timeline = visible.locator('.sa-timeline')

    const searchFor = async (label, query) => {
      step('D3b: searching ' + label)
      await composer().click()
      await page.keyboard.press('Control+f')
      const findBox = visible.locator('.sa-find input')
      await expect(findBox).toBeVisible({ timeout: 10000 })
      await findBox.fill('')
      const t0 = Date.now()
      await findBox.fill(query)
      let count = '<timeout>'
      try {
        await expect(visible.locator('.sa-find-count')).toHaveText(/^\d+ of \d+$/, { timeout: 20000 })
        count = await visible.locator('.sa-find-count').innerText()
      } catch { count = await visible.locator('.sa-find-count').innerText().catch(() => '<none>') }
      const ms = Date.now() - t0
      let anchored = false
      if (/^\d+ of \d+$/.test(count)) {
        await page.keyboard.press('Enter')
        anchored = await timeline.evaluate((el) => { const card = el.querySelector('.sa-find-current'); if (!card) return false; const box = card.getBoundingClientRect(), view = el.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom }).catch(() => false)
      }
      const shotPath = join(output, `d3b-${label}.png`)
      await page.screenshot({ path: shotPath })
      await page.keyboard.press('Escape')
      return { query, count, ms, anchored, screenshot: shotPath }
    }

    results.D3b = {
      step4990: await searchFor('step4990', 'Step 4990: tracing'),
      step1700: await searchFor('step1700', 'Step 1700: tracing')
    }
    console.log('RESULT D3b ' + JSON.stringify(results.D3b))
  } catch (error) {
    results.D3b = { error: String(error?.stack ?? error) }
    console.error('FAIL D3b: ' + error)
  } finally { await safeClose(app) }
} catch (error) { results.D3b = { error: 'launch failed: ' + String(error) } }

clearTimeout(watchdog)
await writeFile(join(output, 'd2b3b-results.json'), JSON.stringify(results, null, 2))
console.log('D2b/D3b DONE')
process.exit(0)
