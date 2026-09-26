// VR8g (verify loop v3): 1fca9e10 loading cursor after FX39 (9219ae3, causal chain links in src/preload/busy-work.ts).
// Owner: "add loading cursor state (sometime sthings load and idk if i clicked..". VR8d's
// smoke-verify-vr8d-cursor.mjs covers the real slow/fast Refresh and the 400 ms poller; this adds the click whose
// own work is a chain: the handler awaits call A, then its continuation starts B, then a render it scheduled
// (a posted MessageChannel task, as React's scheduler does) starts C. Each call takes 300 ms in main; a poller
// every 400 ms (150 ms per call) runs throughout. Nothing on the call path is stubbed except those delays.
//   K4  the cursor is on from ~100 ms after the click until C ends, off within 250 ms of it, no busy 3-10 s later;
//       off-periods while A-C are still running are reported (a flicker between chained calls).
//   K4c control: 5 s of the poller alone with no click moves nothing.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8g-cursor.mjs [--label L] [--keep]
import { configure, failed, finish, launchParked, loadCheck, openProject, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'K'
configure({ name: 'vr8g-cursor-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8g' })
watchdog(10 * 60)
await loadCheck()

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  step('time every ipcMain invoke handler; delay delivery:status only for the two probe projects')
  const wrapped = await inst.app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!handlers || typeof handlers.entries !== 'function') return -1
    globalThis.__vr8gCalls = []
    globalThis.__vr8gSlow = null
    globalThis.__vr8gPoll = null
    for (const [channel, handler] of [...handlers.entries()]) {
      handlers.set(channel, async (event, ...args) => {
        const kind = channel !== 'delivery:status' ? 'other' : args[0] === globalThis.__vr8gSlow ? 'own' : args[0] === globalThis.__vr8gPoll ? 'poll' : 'other'
        const call = { channel, kind, start: Date.now(), end: null }
        globalThis.__vr8gCalls.push(call)
        try {
          if (kind !== 'other') await new Promise(done => setTimeout(done, kind === 'own' ? 300 : 150))
          return await handler(event, ...args)
        } finally { call.end = Date.now() }
      })
    }
    return handlers.size
  })
  if (wrapped < 1) throw new Error('ipcMain._invokeHandlers is not available: cannot time the IPC work')
  const calls = () => inst.app.evaluate(() => globalThis.__vr8gCalls.slice())
  const slow = await openProject({ name: 'Chain repo', git: true })
  const polled = await openProject({ name: 'Polled repo', git: true })
  await inst.app.evaluate((_electron, ids) => { globalThis.__vr8gSlow = ids.slow; globalThis.__vr8gPoll = ids.polled }, { slow: slow.id, polled: polled.id })
  const view = await page()

  step('install the chained-work button, the busy log and the poller')
  await view.evaluate(ids => {
    window.__busyLog = []
    const rec = () => window.__busyLog.push({ at: Date.now(), app: document.documentElement.classList.contains('ipc-busy'), cursor: getComputedStyle(document.body).cursor, marked: Boolean(document.querySelector('#vr8g-chain[data-ipc-busy]')) })
    new MutationObserver(rec).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'data-ipc-busy'] })
    const button = document.createElement('button')
    button.id = 'vr8g-chain'
    button.textContent = 'VR8g chain'
    button.style.cssText = 'position:fixed;left:40px;top:40px;z-index:99999'
    window.__chain = []
    button.addEventListener('click', async () => {
      window.__chain.push({ step: 'click', at: Date.now() })
      await window.conductor.delivery.status(ids.slow)
      window.__chain.push({ step: 'A settled', at: Date.now() })
      await window.conductor.delivery.status(ids.slow)
      window.__chain.push({ step: 'B settled', at: Date.now() })
      // A render the handler scheduled: React posts it as a MessageChannel task.
      const channel = new MessageChannel()
      channel.port1.onmessage = async () => { await window.conductor.delivery.status(ids.slow); window.__chain.push({ step: 'C settled', at: Date.now() }) }
      channel.port2.postMessage(null)
    })
    document.body.appendChild(button)
    window.__startPoll = () => { window.__poll = setTimeout(function tick() { void window.conductor.delivery.status(ids.polled); window.__poll = setTimeout(tick, 400) }, 200) }
  }, { slow: slow.id, polled: polled.id })
  const transitions = (log, since, until = Infinity) => {
    const out = []
    let last = false
    for (const entry of log.filter(item => item.at >= since && item.at <= until)) if (entry.app !== last) { out.push({ at: entry.at, app: entry.app, cursor: entry.cursor, marked: entry.marked }); last = entry.app }
    return out
  }

  step('K4c control: the poller alone for 5 s')
  await sleep(1000)
  const controlFrom = await view.evaluate(() => { window.__startPoll(); return Date.now() })
  await sleep(5000)
  const controlLog = await view.evaluate(() => window.__busyLog.slice())
  const controlTrans = transitions(controlLog, controlFrom)
  const controlPolls = (await calls()).filter(call => call.kind === 'poll' && call.start >= controlFrom).length
  record(label + '4c', controlPolls < 8 ? 'NOT RUN (harness: the poller did not run)' : controlTrans.length === 0 ? 'PASS' : 'FAIL', { pollCalls: controlPolls, busyTransitions: controlTrans.length }, 'a 400 ms poller alone never moves the cursor')

  step('K4: click the chain button with the poller running')
  const clickAt = await view.evaluate(() => Date.now())
  await view.locator('#vr8g-chain').click()
  await poll(() => view.evaluate(() => window.__chain.some(entry => entry.step === 'C settled')), { timeoutMs: 20_000, label: 'C settled' })
  await sleep(Math.max(0, clickAt + 10_000 - Date.now()))
  await view.evaluate(() => clearTimeout(window.__poll))
  const log = await view.evaluate(() => window.__busyLog.slice())
  const chain = await view.evaluate(() => window.__chain.slice())
  const own = (await calls()).filter(call => call.kind === 'own' && call.start >= clickAt - 20)
  const polls = (await calls()).filter(call => call.kind === 'poll' && call.start >= clickAt)
  const trans = transitions(log, clickAt)
  const on = trans.find(entry => entry.app), off = trans.filter(entry => !entry.app).at(-1)
  const workEnd = own.length === 3 ? Math.max(...own.map(call => call.end)) : null
  // Off-periods that start and end while the chain's own work is still running (a flicker mid-chain).
  const gaps = []
  for (let i = 0; i < trans.length - 1; i++) if (!trans[i].app && trans[i + 1].app && workEnd && trans[i].at < workEnd) gaps.push(trans[i + 1].at - trans[i].at)
  const late = trans.filter(entry => entry.at >= clickAt + 3000)
  const numbers = {
    ownCalls: own.map(call => `${call.start - clickAt}-${call.end - clickAt}`), chain: chain.map(entry => `${entry.step}@${entry.at - clickAt}`),
    shownAfterMs: on ? on.at - clickAt : null, cursor: on?.cursor ?? null, buttonMarked: log.some(entry => entry.at >= clickAt && entry.marked),
    workEndAfterMs: workEnd === null ? null : workEnd - clickAt, lastOffAfterMs: off ? off.at - clickAt : null, tailAfterWorkMs: off && workEnd ? off.at - workEnd : null,
    toggles: trans.length, gapsMidChainMs: gaps, transitionsAfter3s: late.length, stillBusy: log.at(-1)?.app ?? false, pollCalls: polls.length
  }
  const k4Shot = await shot(`${label}4-after-10s`)
  const core = on && on.cursor === 'progress' && numbers.tailAfterWorkMs !== null && numbers.tailAfterWorkMs <= 250 && late.length === 0 && !numbers.stillBusy
  record(label + '4', own.length !== 3 || polls.length < 15 ? `NOT RUN (harness: own ${own.length}/3 calls, ${polls.length} polls)` : core && !gaps.length ? 'PASS' : core ? 'INFO' : 'FAIL', numbers,
    `transitions ${JSON.stringify(trans.map(entry => ({ t: entry.at - clickAt, app: entry.app })))}; INFO = cursor right at both ends but off between chained calls; ${k4Shot}`)
} catch (error) { await failed(error, label + '-error') }
await finish()
