import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(() => { console.error('WATCHDOG exceeded 280s at ' + lastStep); process.exit(2) }, 280_000)
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
function percentile(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] }

const root = await mkdtemp(join(tmpdir(), 'conductor-v2typing-'))
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const results = {}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
  step('creating 10k-event conversation')
  await page.evaluate(() => window.conductor.projects.create('Typing fixture'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Typing fixture' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const visible = page.locator('.pane-tab-content:visible')
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  const id = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const composer = () => visible.getByRole('textbox', { name: /message/i }).last()
  await composer().fill('SYNTHETIC LONG 10000')
  await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 120000, intervals: [250] }).toBe('completed')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
  await page.locator('.project-row').filter({ hasText: 'Typing fixture' }).click()
  await visible.locator('.structured-agent-pane').waitFor({ timeout: 30000 })
  await expect(composer()).toBeEnabled({ timeout: 30000 })

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  // A4: 1 MB paste
  step('A4: pasting 1 MB')
  await composer().fill('')
  await composer().click()
  const before = Date.now()
  await page.keyboard.insertText('x'.repeat(1_048_576 / 2) + '\n' + 'y'.repeat(1_048_576 / 2))
  // wait for the UI to settle: either an alert/refusal, or chips, and measure to next paint
  let pasteUiMs = null, pasteOutcome = 'unknown'
  try {
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 })
    pasteUiMs = Date.now() - before
    pasteOutcome = 'alert: ' + (await page.getByRole('alert').innerText().catch(() => '<none>'))
  } catch {
    try {
      await expect(page.locator('.sa-context-chips')).toBeVisible({ timeout: 5000 })
      pasteUiMs = Date.now() - before
      pasteOutcome = 'chips: ' + (await page.locator('.sa-context-chips').innerText().catch(() => '<none>'))
    } catch { pasteOutcome = 'neither alert nor chips appeared within 5s' }
  }
  const draftAfterPaste = await composer().inputValue()
  const shotPath = join(output, 'a4-paste.png')
  await page.screenshot({ path: shotPath })
  results.A4 = { pasteUiMs, pasteOutcome, draftPreserved: draftAfterPaste.length > 0 || pasteOutcome.startsWith('chips'), draftLength: draftAfterPaste.length, screenshot: shotPath }
  console.log('A4 ' + JSON.stringify(results.A4))

  // typing 100 chars right after the paste, still under throttle
  step('A4b: typing 100 chars after paste')
  await composer().fill('')
  const chars100 = 'the quick brown fox jumps over a lazy dog while conductor keeps every tab alive '.slice(0, 100)
  const latencies = []
  for (const ch of chars100) {
    const t0 = Date.now()
    await page.keyboard.type(ch, { delay: 0 })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    latencies.push(Date.now() - t0)
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  results.A4.postPasteTyping = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) }
  console.log('A4 post-paste typing ' + JSON.stringify(results.A4.postPasteTyping))

  // A5: typing while a turn streams
  step('A5: starting a streaming turn')
  await composer().fill('')
  await composer().click()
  await composer().fill('SYNTHETIC LONG 20000')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 15000, intervals: [50] }).toMatch(/^(starting|running)$/).catch(() => {})
  const typed = 'the quick brown fox jumps over a lazy dog while conductor keeps every tab alive and the composer answers each key without waiting on storage or hidden panes'.slice(0, 200)
  const latencies2 = []
  let typedSoFar = ''
  for (const ch of typed) {
    const t0 = Date.now()
    await page.keyboard.type(ch, { delay: 0 })
    typedSoFar += ch
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    latencies2.push(Date.now() - t0)
    await new Promise((r) => setTimeout(r, 50))
  }
  const sorted2 = [...latencies2].sort((a, b) => a - b)
  const textareaValue = await composer().inputValue()
  results.A5 = { p50: percentile(sorted2, 50), p95: percentile(sorted2, 95), p99: percentile(sorted2, 99), max: sorted2.at(-1), textMatches: textareaValue === typedSoFar, phaseDuringTyping: (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase }
  console.log('A5 ' + JSON.stringify(results.A5))
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await composer().fill('')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)

  // A6: draft durability across tab switch and relaunch
  step('A6: typing a draft and switching tabs')
  const draftText = 'draft-A6 ünïcødé 🎉 中文'
  await composer().fill(draftText)
  await page.locator('.sidebar .new-session').click().catch(() => {})
  await page.waitForTimeout(150)
  await page.locator('.sidebar-session-row').first().click().catch(() => {})
  await page.waitForTimeout(150)
  const draftAfterSwitch = await composer().inputValue().catch(() => '<composer not found>')
  results.A6 = { draftAfterSwitch, matchesBeforeRelaunch: draftAfterSwitch === draftText }
  console.log('A6 after switch: ' + JSON.stringify(results.A6))

  await writeFile(join(output, 'typing-results-partial.json'), JSON.stringify({ results, errors }, null, 2))
} catch (error) {
  console.error('FAIL at [' + lastStep + ']: ' + (error?.stack ?? error))
  await writeFile(join(output, 'typing-results-partial.json'), JSON.stringify({ results, errors, error: String(error), lastStep }, null, 2)).catch(() => {})
} finally {
  clearTimeout(watchdog)
  await safeClose(app)
}

// A6 part 2: relaunch the same profile and confirm the draft survived a graceful close.
try {
  step('A6: relaunching same profile')
  const app2 = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  try {
    const page2 = await app2.firstWindow()
    page2.setDefaultTimeout(20000)
    await page2.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
    await page2.locator('.project-row').filter({ hasText: 'Typing fixture' }).click().catch(() => {})
    await page2.waitForTimeout(1000)
    const composer2 = page2.getByRole('textbox', { name: /message/i }).last()
    const draftAfterRelaunch = await composer2.inputValue().catch(() => '<composer not found>')
    const shotPath2 = join(output, 'a6-after-relaunch.png')
    await page2.screenshot({ path: shotPath2 })
    results.A6 = { ...(results.A6 ?? {}), draftAfterRelaunch, matchesAfterRelaunch: draftAfterRelaunch === 'draft-A6 ünïcødé 🎉 中文', screenshot: shotPath2 }
    console.log('A6 after relaunch: ' + JSON.stringify(results.A6))
  } finally { await safeClose(app2) }
} catch (error) {
  console.error('A6 relaunch check failed: ' + error)
  results.A6 = { ...(results.A6 ?? {}), relaunchError: String(error) }
}
await writeFile(join(output, 'typing-results.json'), JSON.stringify({ results, errors }, null, 2))
process.exit(0)
