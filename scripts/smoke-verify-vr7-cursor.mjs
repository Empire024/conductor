// VR7 C1/C2 (loading cursor 1fca9e10, FX31 b7e82af). Owner: "add loading cursor state (sometime sthings load
// and idk if i clicked..". The fixer's smoke swaps the IPC handler for a timed stub; here nothing is stubbed.
//   C1  a REAL slow click: Source control Refresh on a local clone of this repository (real git status over
//       ~2.8k files) and a click on another project's row. Measured: the real IPC time (called without a
//       gesture), and every change of the busy state from the click on. Pass: work over 150 ms shows
//       html.ipc-busy, the progress cursor and data-ipc-busy/aria-busy on the clicked control, and clears
//       after; work under 100 ms shows nothing.
//   C2  "background calls never move the cursor", with the app's real pollers: the Tasks board on the real
//       feature-list.md (HEAD's copy, 205 KB, polled every 1.5 s) open twice (drawer and a tab), one click
//       on a control that starts no work, then 30 s hands-off. Pass: no busy state at all. Control: the
//       same 30 s with no click. C2b probes the gesture-chain rule with a controlled background poller.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr7-cursor.mjs
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, REPO, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr7-cursor', output: process.env.VR7_OUT ?? 'artifacts/verification/2026-09-26-vr7' })
watchdog(600)
await loadCheck()

const busyLogInstall = view => view.evaluate(() => {
  window.__busyLog = []
  const rec = () => window.__busyLog.push({ at: performance.now(), app: document.documentElement.classList.contains('ipc-busy'), cursor: getComputedStyle(document.body).cursor, controls: [...document.querySelectorAll('[data-ipc-busy]')].map(node => (node.getAttribute('aria-label') || node.textContent || node.className).trim().slice(0, 40) + (node.getAttribute('aria-busy') === 'true' ? ' [aria-busy]' : '')) })
  window.__busyObserver?.disconnect()
  window.__busyObserver = new MutationObserver(rec)
  window.__busyObserver.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'data-ipc-busy'] })
})
const busyEntries = (view, since = 0) => view.evaluate(since => window.__busyLog.filter(entry => entry.at >= since && (entry.app || entry.controls.length)).map(entry => ({ ...entry, at: Math.round(entry.at) })), since)
const busyFirstLast = (view, since) => view.evaluate(since => {
  const log = window.__busyLog.filter(entry => entry.at >= since)
  const on = log.find(entry => entry.app), off = on ? log.find(entry => entry.at > on.at && !entry.app) : null
  return { shownAfterMs: on ? Math.round(on.at - since) : null, clearedAfterMs: off ? Math.round(off.at - since) : null, cursor: on?.cursor ?? null, controls: [...new Set(log.flatMap(entry => entry.controls))] }
}, since)

try {
  const inst = await launchParked({ mode: 'playwright', name: 'vr7-cursor', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  step('clone this repository (read-only for the source) as the owner-sized project')
  const clone = join(inst.root, 'src', 'conductor-copy')
  const cloned = spawnSync('git', ['clone', '-q', '--local', REPO, clone], { encoding: 'utf8' })
  if (cloned.status !== 0) throw new Error(`git clone: ${cloned.stderr}`)
  const other = await openProject({ name: 'Second project', files: { 'README.md': '# second\n' } }, inst)
  const project = await openProject({ name: 'Conductor copy', path: clone }, inst)
  const view = await page(inst)
  await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'source-control'))
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.delivery))
  await view.locator('.project-row').filter({ hasText: 'Conductor copy' }).first().click()
  const refresh = view.getByRole('button', { name: 'Refresh repository status' })
  await refresh.waitFor({ timeout: 30_000 })
  await poll(() => refresh.isEnabled(), { timeoutMs: 60_000, label: 'Refresh enabled' })

  step('C1: the real IPC time behind Refresh, called without a gesture')
  const timings = []
  for (let i = 0; i < 3; i++) timings.push(await view.evaluate(async id => { const start = performance.now(); await window.conductor.delivery.status(id); return Math.round(performance.now() - start) }, project.id))
  const realMs = [...timings].sort((a, b) => a - b)[1]
  await sleep(1500)
  await busyLogInstall(view)
  const clickAt = await view.evaluate(() => performance.now())
  await refresh.click()
  await sleep(250)
  const during = await view.evaluate(() => { const button = document.querySelector('button[aria-label="Refresh repository status"]'); return { app: document.documentElement.classList.contains('ipc-busy'), cursor: getComputedStyle(document.body).cursor, buttonBusy: button?.hasAttribute('data-ipc-busy') ?? false, ariaBusy: button?.getAttribute('aria-busy') ?? null } })
  const duringShot = await shot('c1-refresh-during', inst)
  await poll(() => refresh.isEnabled(), { timeoutMs: 60_000, label: 'Refresh done' })
  await sleep(realMs + 800)
  const seen = await busyFirstLast(view, clickAt)
  const after = await view.evaluate(() => ({ app: document.documentElement.classList.contains('ipc-busy'), busyControls: document.querySelectorAll('[data-ipc-busy]').length }))
  const slow = realMs > 150, fast = realMs < 100
  const refreshPass = slow
    ? seen.shownAfterMs !== null && seen.cursor === 'progress' && seen.controls.some(label => /Refresh repository status \[aria-busy\]/.test(label)) && !after.app && !after.busyControls
    : fast ? seen.shownAfterMs === null && !seen.controls.length : null
  record('C1-refresh-real-git-status', refreshPass === null ? 'INFO' : refreshPass ? 'PASS' : 'FAIL', { realIpcMs: timings, shownAfterMs: seen.shownAfterMs, clearedAfterMs: seen.clearedAfterMs, cursor: seen.cursor, during, after }, `real delivery.status on a ${'~2.8k-file'} clone, no stub; busy controls seen: ${JSON.stringify(seen.controls)}; ${duringShot}`)

  step('C1: click another project row (real workspace switch)')
  await sleep(1500)
  await busyLogInstall(view)
  const rowAt = await view.evaluate(() => performance.now())
  await view.locator('.project-row').filter({ hasText: 'Second project' }).first().click()
  await view.locator('.project-row.active').filter({ hasText: 'Second project' }).first().waitFor({ timeout: 30_000 })
  const rowReadyMs = Math.round(await view.evaluate(() => performance.now()) - rowAt)
  await sleep(2000)
  const rowSeen = await busyFirstLast(view, rowAt)
  const rowAfter = await view.evaluate(() => document.documentElement.classList.contains('ipc-busy'))
  // A switch that shows is fine; one that shows must clear. Both outcomes are reported with the time.
  record('C1-project-row', rowAfter ? 'FAIL' : 'PASS', { activeAfterMs: rowReadyMs, ...rowSeen }, `project row click (${other.name}); busy must never outlive the work`)

  step('C2 control: real pollers, no click, 30 s')
  await view.locator('.project-row').filter({ hasText: 'Conductor copy' }).first().click()
  await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'backlog'))
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.delivery))
  await view.locator('.project-row').filter({ hasText: 'Conductor copy' }).first().click()
  await openTab({ kind: 'tasks' }, { inst }).catch(error => console.log(`tasks tab: ${error.message.slice(0, 200)}`))
  await sleep(5000)
  await busyLogInstall(view)
  const quietAt = await view.evaluate(() => performance.now())
  await sleep(30_000)
  const quiet = await busyEntries(view, quietAt)
  record('C2-control-no-click', quiet.length ? 'FAIL' : 'PASS', { busyEvents: quiet.length }, `30 s with the Tasks board (real feature-list.md) open twice and no input: ${JSON.stringify(quiet.slice(0, 5))}`)

  step('C2: one click on a control that starts no work, then 30 s hands-off')
  await busyLogInstall(view)
  // A click on empty workspace background: a trusted gesture that starts no work (no control under it).
  const benign = view.locator('.pane-workspace').first()
  const clickedAt = await view.evaluate(() => performance.now())
  await benign.click({ position: { x: 3, y: 3 }, timeout: 10_000 })
  await sleep(30_000)
  const later = await busyEntries(view, clickedAt + 1000)
  const shotAfter = await shot('c2-after-30s', inst)
  record('C2-background-after-click', later.length ? 'FAIL' : 'PASS', { busyEventsAfter1s: later.length }, `real pollers after one click: ${JSON.stringify(later.slice(0, 5))}; ${shotAfter}`)

  step('C2b probe: a background poller every 400 ms whose calls take 150 ms, first one 200 ms after a click')
  const app = inst.app
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('delivery:status')
    ipcMain.handle('delivery:status', async (_event, projectId) => { await new Promise(done => setTimeout(done, 150)); return { projectId, available: false, reason: 'VR7 probe', branch: null, upstream: null, ahead: 0, behind: 0, head: null, headSubject: null, files: [], github: null, releaseWorkflow: false, checkedAt: new Date().toISOString() } })
  })
  await busyLogInstall(view)
  const probeAt = await view.evaluate(() => performance.now())
  await benign.click({ position: { x: 3, y: 3 }, timeout: 10_000 })
  await view.evaluate(id => { window.__probePoll = setTimeout(function tick() { void window.conductor.delivery.status(id); window.__probePoll = setTimeout(tick, 400) }, 200) }, project.id)
  await sleep(8000)
  await view.evaluate(() => clearTimeout(window.__probePoll))
  const chain = await busyEntries(view, probeAt + 3000)
  record('C2b-gesture-chain-probe', 'INFO', { busyEventsAfter3s: chain.length }, chain.length ? `a background poller that fires within 500 ms of a click stays attributed to it: busy state still toggling ${chain.length} times 3-8 s after the click; ${JSON.stringify(chain.slice(0, 3))}` : 'the poller was not attributed past the click window')
} catch (error) { await failed(error, 'cursor') }
await finish()

