import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2d-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const results = []
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }

let watchdogApp = null
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: exceeded 300s, last step: ' + lastStep)
  try { if (watchdogApp) { const buf = await watchdogApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.capturePage().then(img => img.toPNG().toString('base64'))); if (buf) await writeFile(join(output, 'd-timeout.png'), Buffer.from(buf, 'base64')) } } catch (e) { console.error('watchdog screenshot failed: ' + e) }
  await writeFile(join(output, 'd-extra-results-partial.json'), JSON.stringify({ lastStep, results }, null, 2)).catch(() => {})
  process.exit(2)
}, 300_000)
watchdog.unref()

// Safe teardown: stub the "Work is still running" quit dialog, close with a bound, and taskkill
// only this run's Electron if close() never resolves (scripts/smoke-agent-control.mjs pattern).
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args) => {
        const buttons = args.at(-1)?.buttons ?? []
        const index = buttons.findIndex(label => label === "Don't Save" || label === 'Stop work and quit')
        return { response: index >= 0 ? index : 0, checkboxChecked: false }
      }
    }),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]).catch(() => {})
  let pid
  try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 20_000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}

const run = async (label, fn) => {
  try { const record = await fn(); results.push({ label, pass: true, record }); console.log('PASS ' + label, JSON.stringify(record)) }
  catch (error) { results.push({ label, pass: false, error: String(error?.stack ?? error), lastStep }); console.error('FAIL ' + label + ' at step [' + lastStep + ']: ' + error) }
}

async function launch(label) {
  step('launch ' + label)
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile-' + label), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects-' + label) }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  watchdogApp = app
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  step('launched ' + label)
  return { app, page, errors }
}

// D4: Copy transcript on an empty new conversation and a 1-turn conversation
await run('D4', async () => {
  const { app, page } = await launch('d4')
  try {
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => window.__copied.push(t) })
    await page.evaluate(() => window.conductor.projects.create('D4 empty'))
    await page.reload()
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => window.__copied.push(t) })
    await page.locator('.project-row').filter({ hasText: 'D4 empty' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 15000 })
    step('D4: copying empty transcript')
    await page.getByRole('button', { name: 'Copy transcript', exact: true }).click()
    await page.waitForTimeout(500)
    const emptyCopy = await page.evaluate(() => window.__copied.at(-1))
    const emptyCopyLen = (emptyCopy ?? '').length
    step('D4: one-turn conversation')
    await composer.fill('SYNTHETIC B one turn')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).toBe('completed')
    await page.getByRole('button', { name: 'Copy transcript', exact: true }).click()
    await page.waitForTimeout(500)
    const oneTurnCopy = await page.evaluate(() => window.__copied.at(-1))
    step('D4: done')
    return { emptyCopyLen, emptyCopySample: (emptyCopy ?? '').slice(0, 200), oneTurnCopyLen: (oneTurnCopy ?? '').length, oneTurnSample: (oneTurnCopy ?? '').slice(0, 300) }
  } finally { await safeClose(app) }
})

// D6: toggle CLI drawer 10x in 5s during a streaming turn
await run('D6', async () => {
  const { app, page, errors } = await launch('d6')
  try {
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    await page.evaluate(() => window.conductor.projects.create('D6 toggle'))
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'D6 toggle' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 15000 })
    const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    step('D6: sending SYNTHETIC LONG 3000')
    await composer.fill('SYNTHETIC LONG 3000')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toMatch(/^(starting|running)$/)
    step('D6: turn starting/running, toggling CLI 10x')
    const timeOrigin0 = await page.evaluate(() => performance.timeOrigin)
    let toggled = 0
    const toggleErrors = []
    for (let i = 0; i < 10; i++) {
      try {
        const cliToggle = page.locator('.structured-agent-pane').getByRole('button', { name: 'CLI', exact: true }).first()
        await cliToggle.click({ timeout: 8000 })
        toggled++
        await page.waitForTimeout(500)
        step('D6: toggle ' + (i + 1) + ' ok')
      } catch (error) {
        toggleErrors.push({ i, error: String(error?.message ?? error).split('\n')[0] })
        step('D6: toggle ' + (i + 1) + ' FAILED: ' + toggleErrors.at(-1).error)
        await page.screenshot({ path: join(output, `d6-toggle-fail-${i}.png`) }).catch(() => {})
      }
    }
    const xtermCount = await page.locator('.xterm').count()
    const timeOrigin1 = await page.evaluate(() => performance.timeOrigin)
    step('D6: waiting for turn to complete')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).toBe('completed')
    step('D6: done')
    return { toggled, toggleErrors, xtermCount, sameRenderer: timeOrigin0 === timeOrigin1, pageErrors: errors }
  } finally { await safeClose(app) }
})

// D7: idle conversation, open CLI, type into native terminal
await run('D7', async () => {
  const { app, page } = await launch('d7')
  try {
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    await page.evaluate(() => window.conductor.projects.create('D7 cli type'))
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'D7 cli type' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 15000 })
    step('D7: opening CLI')
    await page.getByRole('button', { name: 'CLI', exact: true }).click()
    const terminal = page.locator('.native-cli-terminal').first()
    await expect(terminal).toBeVisible({ timeout: 20000 })
    await terminal.click()
    step('D7: typing sentinel')
    await page.keyboard.type('echo-v2-sentinel')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)
    const bufferText = await terminal.innerText()
    step('D7: done')
    return { echoed: bufferText.includes('echo-v2-sentinel'), sample: bufferText.slice(-500) }
  } finally { await safeClose(app) }
})

await writeFile(join(output, 'd-extra-results.json'), JSON.stringify(results, null, 2))
clearTimeout(watchdog)
const failed = results.filter(r => !r.pass)
console.log(failed.length ? `FAILURES: ${failed.map(f => f.label).join(', ')}` : 'ALL D-EXTRA CASES PASSED')
process.exit(0)
