// FX31 loading cursor (1fca9e10): a click that starts slow work in main shows the progress cursor
// over the app and a busy state on the clicked control until it is done; a fast one shows nothing.
// Real Electron main, preload and renderer in a parked window; the one IPC handler behind the
// Source control panel's Refresh button is replaced from the main process with one whose delay
// the smoke sets, so "slow" and "fast" are exact.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-busy-cursor.mjs [--build]
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

if (process.argv.includes('--build')) {
  const built = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0) throw new Error('electron-vite build failed')
}
const output = resolve('artifacts/busy-cursor')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-busy-'))
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
const killElectron = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else app.process().kill('SIGKILL') } catch { /* already gone */ } }
const watchdog = setTimeout(() => { console.error('FAIL smoke-busy-cursor exceeded 3 min'); killElectron(); process.exit(1) }, 180_000)
watchdog.unref()
const checks = []
const check = label => { checks.push(label); console.log('PASS ' + label) }
let failed = false
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.delivery))
  const project = await page.evaluate(() => window.conductor.projects.create('Busy smoke'))
  spawnSync('git', ['init', '-q'], { cwd: project.path })
  await writeFile(join(project.path, 'notes.md'), 'hello\n')
  await page.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'source-control'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.delivery))
  await page.locator('.project-row').filter({ hasText: 'Busy smoke' }).click()
  const refresh = page.getByRole('button', { name: 'Refresh repository status' })
  await refresh.waitFor()
  await expect(refresh).toBeEnabled()

  // The status call behind Refresh answers after a delay this smoke controls.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__busyDelay = 0
    ipcMain.removeHandler('delivery:status')
    ipcMain.handle('delivery:status', async (_event, projectId) => {
      await new Promise(done => setTimeout(done, globalThis.__busyDelay))
      return { projectId, available: false, reason: 'Busy-cursor smoke status.', branch: null, upstream: null, ahead: 0, behind: 0, head: null, headSubject: null, files: [], github: null, releaseWorkflow: false, checkedAt: new Date().toISOString() }
    })
  })
  // Every change of the busy state, timed from the click.
  await page.evaluate(() => {
    window.__busyLog = []
    const record = () => window.__busyLog.push({ at: performance.now(), app: document.documentElement.classList.contains('ipc-busy'), controls: document.querySelectorAll('[data-ipc-busy]').length })
    new MutationObserver(record).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'data-ipc-busy'] })
  })
  const busyNow = () => page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Refresh repository status"]')
    return { app: document.documentElement.classList.contains('ipc-busy'), cursor: getComputedStyle(document.body).cursor, buttonBusy: button?.hasAttribute('data-ipc-busy') ?? false, ariaBusy: button?.getAttribute('aria-busy') ?? null, buttonCursor: button ? getComputedStyle(button).cursor : null }
  })
  const clickAt = async () => { await expect(refresh).toBeEnabled(); await page.evaluate(() => { window.__busyLog = []; window.__clickAt = performance.now() }); await refresh.click() }

  // Slow: 1.5 s of work.
  await app.evaluate(() => { globalThis.__busyDelay = 1500 })
  await clickAt()
  await page.waitForTimeout(400)
  const during = await busyNow()
  console.log('during slow work:', JSON.stringify(during))
  await page.screenshot({ path: join(output, 'busy.png') })
  assert.equal(during.app, true, 'the app shows the busy state while the click\'s work runs')
  assert.equal(during.cursor, 'progress')
  assert.equal(during.buttonBusy, true, 'the clicked control is marked busy')
  assert.equal(during.ariaBusy, 'true')
  assert.equal(during.buttonCursor, 'progress')
  const shownAfter = await page.evaluate(() => { const first = window.__busyLog.find(entry => entry.app); return first ? Math.round(first.at - window.__clickAt) : null })
  check(`A slow click shows the progress cursor and a busy Refresh button ${shownAfter} ms after the click`)
  await page.waitForTimeout(1600)
  const after = await busyNow()
  assert.equal(after.app, false, 'the busy state clears when the work is done')
  assert.equal(after.buttonBusy, false)
  assert.equal(after.ariaBusy, null)
  assert.notEqual(after.cursor, 'progress')
  check('The cursor and the button return to normal when the work completes')

  // Fast: 20 ms of work never shows anything.
  await app.evaluate(() => { globalThis.__busyDelay = 20 })
  await clickAt()
  await page.waitForTimeout(700)
  const fastLog = await page.evaluate(() => window.__busyLog.filter(entry => entry.app || entry.controls))
  assert.deepEqual(fastLog, [], 'a fast action must not flicker the busy state')
  check('A fast (20 ms) click never shows the busy state')

  // Background calls (not started by a click) never move the cursor.
  await app.evaluate(() => { globalThis.__busyDelay = 800 })
  await page.evaluate(() => { window.__busyLog = [] })
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.conductor.delivery.status(document.querySelector('.project-row')?.getAttribute('data-project-id') ?? 'none').catch(() => null))
  const backgroundLog = await page.evaluate(() => window.__busyLog.filter(entry => entry.app))
  assert.deepEqual(backgroundLog, [], 'work no click started must not show the busy cursor')
  check('An 800 ms call no click started leaves the cursor alone')
} catch (error) {
  failed = true
  console.error('FAIL', error?.stack ?? error)
} finally {
  killElectron()
  await writeFile(join(output, 'result.json'), JSON.stringify({ at: new Date().toISOString(), checks, pass: !failed }, null, 2))
  console.log(failed ? 'FAIL' : `PASS ${checks.length} checks`, output)
  process.exit(failed ? 1 : 0)
}
