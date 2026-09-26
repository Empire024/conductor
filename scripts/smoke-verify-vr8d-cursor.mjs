// VR8d (verify loop v3): 1fca9e10 loading cursor after bffb010 (a background poller can no longer chain itself
// to a click). Owner: "add loading cursor state (sometime sthings load and idk if i clicked..". Nothing on the
// click path is stubbed: every ipcMain invoke handler is wrapped only to time it, so "the click's own work" is
// measured in main, not guessed.
//   K1 a real slow click (Source control Refresh, real git status on a ~2.8k-file clone of this repository)
//      shows the progress cursor and aria-busy on Refresh until the work ends, and clears right after it.
//   K2 a fast click shows nothing: Refresh on a one-file repository whose delivery:status answers from its
//      previous real result (git status alone is ~170 ms on this machine, so no real refresh is under 100 ms).
//   K3 the K1 click with pollers around it: the real Tasks board (HEAD's feature-list.md, drawer + tab) and a
//      controlled poller every 400 ms whose calls take 150 ms, the first 200 ms after the click (VR7 C2b).
//      The cursor must be back within ~250 ms of the click's own work and never busy again 3-10 s after it.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8d-cursor.mjs [--label L] [--keep]
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { configure, current, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, REPO, shot, sleep, step, watchdog } from './verify-kit.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'K'
configure({ name: 'vr8d-cursor-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8d' })
watchdog(12 * 60)
await loadCheck()

// Renderer: every busy-state change with Date.now(), so it lines up with main's IPC timings.
const busyLogInstall = view => view.evaluate(() => {
  window.__busyLog = []
  const rec = () => window.__busyLog.push({ at: Date.now(), app: document.documentElement.classList.contains('ipc-busy'), cursor: getComputedStyle(document.body).cursor, controls: [...document.querySelectorAll('[data-ipc-busy]')].map(node => (node.getAttribute('aria-label') || node.textContent || node.className).trim().slice(0, 40) + (node.getAttribute('aria-busy') === 'true' ? ' [aria-busy]' : '')) })
  window.__busyObserver?.disconnect()
  window.__busyObserver = new MutationObserver(rec)
  window.__busyObserver.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'data-ipc-busy'] })
})
const busyLog = view => view.evaluate(() => window.__busyLog)
/** Transitions of html.ipc-busy (on/off) after `since`. */
const transitions = (log, since) => {
  const out = []
  let last = false
  for (const entry of log.filter(item => item.at >= since)) if (entry.app !== last) { out.push({ at: entry.at, app: entry.app, cursor: entry.cursor, controls: entry.controls }); last = entry.app }
  return out
}

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  step('time every ipcMain invoke handler (no behaviour change; a 150 ms delay only for the probe project)')
  const wrapped = await inst.app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!handlers || typeof handlers.entries !== 'function') return -1
    globalThis.__vr8dCalls = []
    globalThis.__vr8dProbe = null
    let count = 0
    for (const [channel, handler] of [...handlers.entries()]) {
      handlers.set(channel, async (event, ...args) => {
        const call = { channel, start: Date.now(), end: null, probe: channel === 'delivery:status' && args[0] === globalThis.__vr8dProbe, fast: channel === 'delivery:status' && args[0] === globalThis.__vr8dFast }
        globalThis.__vr8dCalls.push(call)
        try {
          if (call.probe) await new Promise(done => setTimeout(done, 150))
          // K2: the same project's last real answer, at once (git status is never under 100 ms here).
          if (call.fast && globalThis.__vr8dCache) return globalThis.__vr8dCache
          if (call.fast) return (globalThis.__vr8dCache = await handler(event, ...args))
          return await handler(event, ...args)
        } finally { call.end = Date.now() }
      })
      count++
    }
    return count
  })
  if (wrapped < 1) throw new Error('ipcMain._invokeHandlers is not available in this Electron: cannot time the IPC work')
  const calls = () => inst.app.evaluate(() => globalThis.__vr8dCalls.slice())

  step('clone this repository (read-only for the source) as the owner-sized project')
  const clone = join(inst.root, 'src', 'conductor-copy')
  const cloned = spawnSync('git', ['clone', '-q', '--local', REPO, clone], { encoding: 'utf8' })
  if (cloned.status !== 0) throw new Error(`git clone: ${cloned.stderr}`)
  const tiny = await openProject({ name: 'Tiny repo', git: true })
  const project = await openProject({ name: 'Conductor copy', path: clone })
  const view = await page()
  await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'source-control'))
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.delivery))
  const refreshOf = async name => {
    await view.locator('.project-row').filter({ hasText: name }).first().click()
    await view.locator('.project-row.active').filter({ hasText: name }).first().waitFor({ timeout: 30_000 })
    const refresh = view.getByRole('button', { name: 'Refresh repository status' })
    await refresh.waitFor({ timeout: 30_000 })
    await poll(() => refresh.isEnabled(), { timeoutMs: 60_000, label: `Refresh enabled (${name})` })
    return refresh
  }
  const ipcMs = async id => { const all = []; for (let i = 0; i < 3; i++) all.push(await view.evaluate(async value => { const start = performance.now(); await window.conductor.delivery.status(value); return Math.round(performance.now() - start) }, id)); return all }
  /** Clicks `button`, waits for the work and `tailMs`, and returns the click's own IPC calls and the busy log. */
  const clickAndMeasure = async (button, tailMs, during) => {
    await sleep(1500)
    await busyLogInstall(view)
    const clickAt = await view.evaluate(() => Date.now())
    await button.click()
    if (during) await during(clickAt)
    await poll(() => button.isEnabled(), { timeoutMs: 60_000, label: 'work done' })
    await sleep(tailMs)
    const log = await busyLog(view)
    const all = await calls()
    const own = all.filter(call => !call.probe && call.start >= clickAt - 20 && call.start <= clickAt + 500)
    const workEnd = own.length ? Math.max(...own.map(call => call.end ?? Infinity)) : null
    return { clickAt, log, all, own, workEnd, trans: transitions(log, clickAt) }
  }

  step('K1: slow click - Refresh on the clone (real git status)')
  let refresh = await refreshOf('Conductor copy')
  const slowMs = await ipcMs(project.id)
  const k1 = await clickAndMeasure(refresh, 2500)
  const on = k1.trans.find(entry => entry.app), off = k1.trans.filter(entry => !entry.app).at(-1)
  const k1Numbers = { realIpcMs: slowMs, ownCalls: k1.own.map(call => `${call.channel}:${call.end - call.start}`), shownAfterMs: on ? on.at - k1.clickAt : null, cursor: on?.cursor ?? null, ariaBusyOnRefresh: k1.log.some(entry => entry.controls.some(text => /Refresh repository status \[aria-busy\]/.test(text))), workEndAfterMs: k1.workEnd - k1.clickAt, clearedAfterWorkMs: off && k1.workEnd ? off.at - k1.workEnd : null, toggles: k1.trans.length, stillBusy: k1.log.at(-1)?.app ?? false }
  const k1Slow = k1.workEnd - k1.clickAt > 150
  record(label + '1', !k1Slow ? 'NOT RUN (harness: the clone refresh was not slow)' : on && on.cursor === 'progress' && k1Numbers.ariaBusyOnRefresh && k1Numbers.clearedAfterWorkMs !== null && k1Numbers.clearedAfterWorkMs <= 400 && !k1Numbers.stillBusy ? 'PASS' : 'FAIL', k1Numbers, 'real delivery.status on a ~2.8k-file clone; timings from main')

  step('K2: fast click - Refresh on a one-file repository')
  refresh = await refreshOf('Tiny repo')
  await inst.app.evaluate((_electron, id) => { globalThis.__vr8dFast = id; globalThis.__vr8dCache = null }, tiny.id)
  const fastMs = await ipcMs(tiny.id)
  const k2 = await clickAndMeasure(refresh, 1500)
  await inst.app.evaluate(() => { globalThis.__vr8dFast = null })
  // Fast = every call the click started settled in under 100 ms (their start can lag the click itself).
  const k2Fast = k2.own.length > 0 && k2.own.every(call => call.end !== null && call.end - call.start < 100)
  record(label + '2', !k2Fast ? 'INFO' : k2.trans.length === 0 && !k2.log.some(entry => entry.controls.length) ? 'PASS' : 'FAIL', { realIpcMs: fastMs, ownCalls: k2.own.map(call => `${call.channel}:${call.end - call.start}`), workEndAfterMs: k2.workEnd === null ? null : k2.workEnd - k2.clickAt, busyTransitions: k2.trans.length }, k2Fast ? 'work under 100 ms must show nothing' : 'a call of the click took 100 ms or more on this run; reported, not judged')

  step('K3: real Tasks board pollers + a 400 ms poller around the slow click')
  await view.locator('.project-row').filter({ hasText: 'Conductor copy' }).first().click()
  await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'backlog'))
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.delivery))
  await view.locator('.project-row').filter({ hasText: 'Conductor copy' }).first().click()
  await openTab({ kind: 'tasks' }, { inst: current() }).catch(error => console.log(`tasks tab: ${error.message.slice(0, 200)}`))
  await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'source-control'))
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.delivery))
  refresh = await refreshOf('Conductor copy')
  await inst.app.evaluate((_electron, id) => { globalThis.__vr8dProbe = id }, tiny.id)
  const k3 = await clickAndMeasure(refresh, 0, async () => {
    await view.evaluate(id => { window.__probePoll = setTimeout(function tick() { void window.conductor.delivery.status(id); window.__probePoll = setTimeout(tick, 400) }, 200) }, tiny.id)
  })
  await sleep(Math.max(0, k3.clickAt + 10_000 - Date.now()))
  await view.evaluate(() => clearTimeout(window.__probePoll))
  const k3Log = await busyLog(view)
  const k3Trans = transitions(k3Log, k3.clickAt)
  const k3Off = k3Trans.filter(entry => !entry.app).at(-1)
  const late = k3Trans.filter(entry => entry.at >= k3.clickAt + 3000)
  const probes = (await calls()).filter(call => call.probe && call.start >= k3.clickAt)
  const k3Shot = await shot(`${label}3-after-10s`)
  const k3Numbers = { ownCalls: k3.own.map(call => `${call.channel}:${call.end - call.start}`), workEndAfterMs: k3.workEnd - k3.clickAt, lastOffAfterMs: k3Off ? k3Off.at - k3.clickAt : null, tailAfterWorkMs: k3Off ? k3Off.at - k3.workEnd : null, toggles: k3Trans.length, transitionsAfter3s: late.length, probeCalls: probes.length, probeMs: probes.slice(0, 3).map(call => call.end - call.start), stillBusy: k3Log.at(-1)?.app ?? false }
  record(label + '3', probes.length < 15 ? 'NOT RUN (harness: the probe poller did not run)' : late.length === 0 && !k3Numbers.stillBusy && k3Numbers.tailAfterWorkMs !== null && k3Numbers.tailAfterWorkMs <= 400 ? 'PASS' : 'FAIL', k3Numbers, `transitions: ${JSON.stringify(k3Trans.map(entry => ({ t: entry.at - k3.clickAt, app: entry.app })).slice(0, 30))}; ${k3Shot}`)
  // The same run judged only on "no endless busy cursor" (VR7 C2b: still toggling 3-8 s after the click).
  record(label + '3-bounded', probes.length < 15 ? 'NOT RUN (harness: the probe poller did not run)' : late.length === 0 && !k3Numbers.stillBusy ? 'PASS' : 'FAIL', { transitionsAfter3s: late.length, stillBusy: k3Numbers.stillBusy, lastOffAfterMs: k3Numbers.lastOffAfterMs }, 'no busy state 3-10 s after the click')
} catch (error) { await failed(error, label + '-error') }
await finish()
