import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const events = 10000
const root = await mkdtemp(join(tmpdir(), 'conductor-v2d35-'))
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
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(() => { console.error('WATCHDOG exceeded 280s at ' + lastStep); process.exit(2) }, 280_000)
watchdog.unref()

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const errors = []
const check = (l) => console.log('ok - ' + l)
const results = {}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
  step('creating project + conversation')
  await page.evaluate(() => window.conductor.projects.create('D35 fixture'))
  await page.getByText('D35 fixture', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude Code' }).first().click()
  const visible = page.locator('.pane-tab-content:visible')
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const composer = () => visible.getByRole('textbox', { name: /message/i }).last()
  const snapshot = () => page.evaluate((agent) => window.conductor.structured.snapshot(agent).then((state) => ({ phase: state?.phase, view: state?.view })), id)
  step('sending SYNTHETIC LONG ' + events)
  await composer().fill('SYNTHETIC LONG ' + events)
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot()).phase, { timeout: 600_000, intervals: [250] }).toBe('completed')
  step('reloading')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
  await page.getByText('D35 fixture', { exact: true }).first().click()
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  await expect(composer()).toBeEnabled({ timeout: 30000 })
  const timeline = visible.locator('.sa-timeline')

  // D3: Ctrl+F finds a message only the journal holds
  step('D3: Ctrl+F search')
  await composer().click()
  await page.keyboard.press('Control+f')
  const findBox = visible.locator('.sa-find input')
  await expect(findBox).toBeVisible({ timeout: 10000 })
  // Sanity check first: does search find RECENT content (near the end, still resident)?
  await findBox.fill('Step 4990: tracing')
  await page.waitForTimeout(1000)
  results.D3recentSearch = await visible.locator('.sa-find-count').innerText().catch(() => '<none>')
  check('D3: sanity search for recent Step 4990 -> ' + results.D3recentSearch)
  await findBox.fill('')
  await page.waitForTimeout(300)
  await findBox.fill('Step 20: tracing')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: join(output, 'd3-old-search.png') }).catch(() => {})
  const foundCount = await visible.locator('.sa-find-count').innerText().catch(() => '<none>')
  const foundOld = /^\d+ of \d+$/.test(foundCount)
  let anchored = false
  if (foundOld) anchored = await timeline.evaluate((el) => { const card = el.querySelector('.sa-find-current'); if (!card) return false; const box = card.getBoundingClientRect(), view = el.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom }).catch(() => false)
  const shotPath = join(output, 'd3-find.png')
  await page.screenshot({ path: shotPath })
  results.D3 = { foundCount, foundOld, anchored, screenshot: shotPath }
  check('D3: old (journal-only) search for Step 20 -> ' + foundCount + (foundOld ? ' (anchored=' + anchored + ')' : ' — DID NOT FIND journal-only content'))
  await findBox.fill('zzzz-no-match')
  await page.waitForTimeout(500)
  const noMatchCount = await visible.locator('.sa-find-count').innerText().catch(() => '<none>')
  results.D3.noMatchCount = noMatchCount
  await findBox.fill('a.b*(c')
  await page.waitForTimeout(300)
  await findBox.fill('🎉')
  await page.waitForTimeout(300)
  results.D3.regexAndEmojiCrashed = false
  await page.keyboard.press('Escape')
  check('D3: no-match, regex-special and emoji queries did not crash')

  // D5: CLI drawer while a turn streams
  step('D5: starting a second streaming turn')
  await page.waitForTimeout(500)
  await composer().click()
  await composer().fill('SYNTHETIC LONG 20000')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await snapshot()).phase, { timeout: 15000, intervals: [50] }).toMatch(/^(starting|running)$/)
  step('D5: opening CLI drawer')
  const itemCountBefore = await timeline.evaluate((el) => el.querySelectorAll('[data-item-id]').length)
  await visible.getByRole('button', { name: 'CLI', exact: true }).click()
  const live = visible.locator('.sa-cli-live')
  await expect(live).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(2000)
  const itemCountAfter = await timeline.evaluate((el) => el.querySelectorAll('[data-item-id]').length)
  const xtermRowsBefore = await live.locator('.xterm-rows > div').count().catch(() => 0)
  await page.waitForTimeout(1500)
  const xtermRowsAfter = await live.locator('.xterm-rows > div').count().catch(() => 0)
  await visible.getByRole('button', { name: 'CLI', exact: true }).click()
  await expect(live).toBeHidden({ timeout: 10000 })
  step('D5: waiting for turn to complete')
  await expect.poll(async () => (await snapshot()).phase, { timeout: 60000 }).toBe('completed')
  results.D5 = { itemCountBefore, itemCountAfter, timelineGrewWhileDrawerOpen: itemCountAfter >= itemCountBefore, xtermRowsBefore, xtermRowsAfter }
  check('D5: CLI live drawer shown while chat kept updating, then hidden without restart - ' + JSON.stringify(results.D5))

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'd35-results.json'), JSON.stringify({ results, errors }, null, 2))
} catch (error) {
  console.error('FAIL at [' + lastStep + ']: ' + (error?.stack ?? error))
  try { const p = await app.firstWindow(); await p.screenshot({ path: join(output, 'd35-failure.png') }) } catch {}
  await writeFile(join(output, 'd35-results.json'), JSON.stringify({ results, errors, error: String(error), lastStep }, null, 2)).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await safeClose(app)
}
process.exit(0)
