import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Two phone bugs (owner, 2026-10-23, conductor-task:phone-succeeded-tab-1023 and
// conductor-task:phone-bottom-cutoff-1023), on the real phone page served by a parked Electron
// app over its HTTPS listener to a parked iPhone-15-sized window (393x852):
//   S1 a succeeded wizard tab shows "Continued in <successor>" instead of the composer, takes no
//      typing, sends nothing, and its button opens the successor with the unsent draft;
//   B1 with iPhone 15 safe-area insets simulated (top 59, bottom 34: every env(safe-area-inset-*)
//      in the stylesheet is rewritten to that length), on Home, Tabs, a conversation, More, New task
//      and the succeeded tab, the shell ends on the screen's bottom edge and nothing the owner reads
//      or taps lies in the bottom 34 px (the home indicator) or below the screen;
//   B2 Safari reporting a visible area shorter than the CSS viewport (its toolbar over the page):
//      the shell follows the visible height, so the bottom bar stays in sight.
// Only the conversation payloads are stand-ins. Run after `npm.cmd run build`, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-succession-bottom.mjs [--before]
// --before only takes screenshots and measures. Output: .conductor-scratch/phone-bottom/<after|before>/.
const before = process.argv.includes('--before')
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-bottom-'))
const output = resolve('.conductor-scratch/phone-bottom', before ? 'before' : 'after')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN || 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const WIDTH = 393, HEIGHT = 852, TOP = 59, BOTTOM = 34

const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  let value
  for (;;) {
    value = await read().catch(() => undefined)
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 600))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/* Parked left of every display, shown without activation, out of the taskbar (as smoke-phone-composer). */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition, width, height }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneBottomConsole ??= {}
  const log = globalThis.__phoneBottomConsole[win.id] = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') log.push(text)
  })
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return { id: win.id }
}, { partition, width: WIDTH, height: HEIGHT })

const phone = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneBottomConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

/* Two conversations: the old wizard (succeeded once window.__succeeded is set, through a middle
   successor that itself handed on, as the server reports the newest) and its successor. */
const STAND_INS = `(() => {
  window.__succeeded = false
  window.__posted = []
  const item = (id, role, text) => ({ id, sequence: 1, timestamp: new Date().toISOString(), data: { type: 'text', role, text } })
  const conversation = (id, title, items, extra) => Object.assign({
    summary: { id, title, phase: 'idle', state: 'idle', provider: 'claude', model: 'opus', projectName: 'haf-stuff' },
    sequence: 3, items, pending: [], queued: [], canSteer: true, canAttachImages: true, needsResume: false
  }, extra || {})
  const old = () => conversation('smoke-old', 'Wizard: haf-stuff', Array.from({ length: 14 }, (_, i) => item('o' + i, i % 2 ? 'assistant' : 'user', i % 2 ? 'Reply ' + i + ': the step is done, the next one is queued and the coworkers are idle now.' : 'Owner message ' + i)),
    window.__succeeded ? { succession: { id: 'smoke-new', title: 'Wizard: haf-stuff (continued 2)', open: true } } : {})
  const fresh = () => conversation('smoke-new', 'Wizard: haf-stuff (continued 2)', [item('n1', 'assistant', 'Continuing the handed-on work.')])
  const real = window.fetch.bind(window)
  /* Once switched on, the next stream connection carries the computer's state and then every
     notification pushed onto window.__notes (only the newest connection takes them), as the desktop sends them while agents work. */
  window.__liveStream = false
  window.__notes = []
  window.__streams = 0
  const liveStream = async init => {
    const generation = window.__streams += 1
    const state = await (await real('/api/state', { headers: init && init.headers })).json()
    const encoder = new TextEncoder()
    let timer = null
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: state\\ndata: ' + JSON.stringify(state) + '\\n\\n'))
        timer = setInterval(() => { while (generation === window.__streams && window.__notes.length) controller.enqueue(encoder.encode('event: notification\\ndata: ' + JSON.stringify(window.__notes.shift()) + '\\n\\n')) }, 100)
        if (init && init.signal) init.signal.addEventListener('abort', () => { clearInterval(timer); try { controller.close() } catch (error) { /* closed */ } })
      },
      cancel() { clearInterval(timer) }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  window.fetch = async (path, init) => {
    const url = String(path)
    if (url === '/api/stream' && window.__liveStream) return liveStream(init)
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    for (const [id, make] of [['smoke-old', old], ['smoke-new', fresh]]) {
      if (!url.startsWith('/api/sessions/' + id)) continue
      if (init && init.method === 'POST') { window.__posted.push({ url, body: init.body }); return json({ ok: true, mode: 'submit', phase: 'idle' }) }
      return json(make())
    }
    return real(path, init)
  }
  return true
})()`

/* iPhone 15 portrait: Chromium has no notch, so every env(safe-area-inset-*) the stylesheet uses
   becomes the iPhone's length. */
const SAFE_AREA = `(async () => { try {
  const lengths = { top: '${TOP}px', bottom: '${BOTTOM}px', left: '0px', right: '0px' }
  /* CSSOM loses env() inside shorthands, so the whole stylesheet text is rewritten and adopted in
     place of the linked one. */
  const link = document.querySelector('link[rel=stylesheet][href="/app.css"]')
  const text = await (await fetch('/app.css', { cache: 'no-store' })).text()
  let rewritten = 0
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(text.replace(/env\\(\\s*safe-area-inset-(top|bottom|left|right)\\s*\\)/g, (_, side) => { rewritten++; return lengths[side] }))
  document.adoptedStyleSheets = [sheet]
  link.sheet.disabled = true
  return rewritten
} catch (error) { return String(error && error.stack || error) } })()`

/* Everything visible the owner reads or taps: where its bottom sits against the screen. */
const MEASURE = `(() => {
  const rect = node => { if (!node || node.hidden || getComputedStyle(node).display === 'none') return null; const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } }
  const height = window.innerHeight
  const visible = node => { const style = getComputedStyle(node); if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false; const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  /* Leaves inside a scroller may scroll out of sight; only fixed chrome and the scroller's own box count. */
  const inScroller = node => { for (let p = node.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) return true } return false }
  const offenders = []
  for (const node of document.querySelectorAll('#app button, #app a, #app input, #app textarea, #app .tab-label, #app p, #app h1, #app h2, #app h3, #app strong, #app small')) {
    if (!visible(node) || inScroller(node)) continue
    const r = node.getBoundingClientRect()
    if (r.bottom > height - ${BOTTOM} + 0.5) offenders.push({ what: node.tagName.toLowerCase() + '.' + String(node.className).split(' ').join('.'), text: (node.textContent || '').trim().slice(0, 40), bottom: Math.round(r.bottom) })
  }
  /* The scroller's last child, scrolled to the end, must also clear the indicator. */
  const scrollers = [...document.querySelectorAll('#app .scroll')].filter(visible)
  let lastContent = null
  for (const scroller of scrollers) {
    scroller.scrollTop = scroller.scrollHeight
    const last = scroller.lastElementChild
    if (!last) continue
    const box = last.getBoundingClientRect()
    lastContent = Math.max(lastContent || 0, Math.round(Math.min(box.bottom, scroller.getBoundingClientRect().bottom)))
    if (box.bottom > height - ${BOTTOM} + 0.5 && box.top < height) offenders.push({ what: 'scroll-end ' + String(last.className), bottom: Math.round(box.bottom) })
  }
  return { innerHeight: height, app: rect(document.getElementById('app')), tabbar: rect(document.querySelector('.tabbar')), footer: rect(document.querySelector('.footer')), lastContent, offenders }
})()`

const phoneWindows = []
const report = { mode: before ? 'before' : 'after', checks, errors, metrics: {} }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const opened = await openPhone('phone-bottom')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('Boolean(document.querySelector(".code-input") && document.querySelector(".code-input").value)'), Boolean, 'the code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')
  await tab.run(STAND_INS)
  report.safeAreaRules = await tab.run(SAFE_AREA)
  assert.ok(typeof report.safeAreaRules === 'number' && report.safeAreaRules > 5, 'the stylesheet uses safe-area insets: ' + report.safeAreaRules)

  const leave = async () => { await tab.go('#/more'); await until(() => tab.run('!document.querySelector(".composer")'), Boolean, 'leaving the session') }
  const openSession = async (id, ready) => {
    await leave()
    await tab.go('#/session/' + id)
    await until(() => tab.run(ready), Boolean, 'session ' + id)
    await pause(300)
  }

  /* B1: every main screen with the iPhone's insets. */
  const screens = [
    ['home', '#/', 'Boolean(document.querySelector(".home-hero"))'],
    ['tabs', '#/tabs', 'Boolean(document.querySelector(".tabbar .tab.active[data-tab=tabs]"))'],
    ['more', '#/more', 'Boolean(document.querySelector(".appearance-options"))'],
    ['new-task', '#/new', 'Boolean(document.querySelector(".tabbar .tab.active[data-tab=new]"))']
  ]
  const assertBottom = (m, name) => {
    report.metrics[name] = m
    if (before) return
    assert.equal(m.app.bottom, m.innerHeight, name + ': the shell ends on the screen edge')
    if (m.tabbar) assert.equal(m.tabbar.bottom, m.innerHeight, name + ': the tab bar sits on the bottom edge')
    assert.deepEqual(m.offenders, [], name + ': nothing to read or tap under the home indicator')
  }
  for (const [name, hash, ready] of screens) {
    await tab.go(hash)
    await until(() => tab.run(ready), Boolean, name)
    await pause(250)
    await tab.shot('inset-' + name)
    assertBottom(await tab.run(MEASURE), name)
  }
  await openSession('smoke-old', 'Boolean(document.querySelector(".composer-input"))')
  await tab.shot('inset-conversation')
  assertBottom(await tab.run(MEASURE), 'conversation')
  if (!before) check('With iPhone 15 insets (59/34) Home, Tabs, More, New task and a conversation end on the screen edge with nothing under the home indicator')

  /* S1: the owner types, then the tab hands on. */
  await tab.run(`(() => { const input = document.querySelector('.composer-input'); input.value = 'half-typed for the wizard'; input.dispatchEvent(new Event('input')); return true })()`)
  await tab.run('window.__succeeded = true; true')
  await openSession('smoke-old', before ? 'Boolean(document.querySelector(".composer-input"))' : 'Boolean(document.querySelector(".succession-host .succession-open"))')
  await tab.shot('succeeded')
  const succeeded = await tab.run(`(() => {
    const input = document.querySelector('.composer-input'), send = document.querySelector('.composer-send'), host = document.querySelector('.succession-host')
    const shown = node => Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0
    return { inputShown: shown(input), inputDisabled: input ? input.disabled : null, sendShown: shown(send), banner: host ? host.textContent : '', draft: input ? input.value : '' }
  })()`)
  report.metrics.succeeded = succeeded
  assertBottom(await tab.run(MEASURE), 'succeeded')
  if (!before) {
    assert.match(succeeded.banner, /Continued in Wizard: haf-stuff \(continued 2\)/)
    assert.equal(succeeded.inputShown, false, 'no composer field on a succeeded tab')
    assert.equal(succeeded.inputDisabled, true, 'the field takes no typing')
    assert.equal(succeeded.sendShown, false, 'no Send on a succeeded tab')
    await tab.run(`(() => { const input = document.querySelector('.composer-input'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    await pause(200)
    assert.deepEqual(await tab.run('window.__posted'), [], 'nothing was posted to the old tab')
    await tab.run('document.querySelector(".succession-open").click(); true')
    await until(() => tab.run('location.hash'), hash => hash === '#/session/smoke-new', 'the successor opened')
    await until(() => tab.run('document.querySelector(".composer-input") && document.querySelector(".composer-input").value'), value => value === 'half-typed for the wizard', 'the draft in the successor')
    await tab.shot('successor')
    check('A succeeded tab shows "Continued in <successor>" instead of the composer, sends nothing, and its button opens the newest successor with the unsent draft')
  }

  /* T1: notifications while typing wait behind a count chip and come once the field lets go. */
  await openSession('smoke-new', 'Boolean(document.querySelector(".composer-input"))')
  await tab.run("window.__liveStream = true; window.dispatchEvent(new Event('online')); true")
  await until(() => tab.run('window.__streams'), count => count >= 1, 'the stand-in stream connected')
  await pause(2000)
  await tab.run("document.querySelector('.composer-input').focus(); window.__notes.push({ kind: 'done', title: 'Coworker finished', body: 'Fix the login bug: done', url: '#/' }, { kind: 'attention', title: 'Approval needed', body: 'npm publish', url: '#/attention' }); true")
  const held = await until(() => tab.run(`(() => { const chip = document.getElementById('held-toasts'); return { exists: Boolean(chip), notesLeft: window.__notes.length, streams: window.__streams, chip: chip && !chip.hidden ? chip.textContent : '', toasts: document.querySelectorAll('#toasts .toast').length, focused: document.activeElement === document.querySelector('.composer-input') } })()`), value => before ? true : value && value.chip === '2', 'the held count', 10000).catch(error => ({ error: String(error) }))
  report.metrics.typingHeld = held
  await tab.shot('typing-held')
  if (!before) {
    assert.equal(held.toasts, 0, 'no toast while typing')
    assert.equal(held.focused, true, 'the composer kept focus')
    const chipBox = await tab.run("(() => { const r = document.getElementById('held-toasts').getBoundingClientRect(), c = document.querySelector('.composer').getBoundingClientRect(), t = document.querySelector('.timeline').getBoundingClientRect(); const chip = document.getElementById('held-toasts'); const overlaps = [...chip.parentNode.children].filter(node => node !== chip).map(node => node.getBoundingClientRect()).filter(o => o.width && o.left < r.right - 0.5 && o.right > r.left + 0.5 && o.top < r.bottom - 0.5 && o.bottom > r.top + 0.5).length; return { bottom: r.bottom, composerTop: c.top, timelineTop: t.top, height: r.height, inHeader: Boolean(chip.closest('.topbar')), overlaps } })()")
    report.metrics.heldChip = chipBox
    assert.ok(chipBox.bottom <= chipBox.timelineTop + 1, 'the chip stays in the header, off the conversation: ' + JSON.stringify(chipBox))
    assert.equal(chipBox.inHeader, true, 'the chip is part of the header row')
    assert.equal(chipBox.overlaps, 0, 'the chip covers nothing in the header')
    await tab.run("document.querySelector('.composer-input').blur(); true")
    const released = await until(() => tab.run("({ chip: document.getElementById('held-toasts').hidden, toasts: document.querySelector('#toasts').textContent })"), value => value && value.chip && /Coworker finished/.test(value.toasts) && /Approval needed/.test(value.toasts), 'the toasts after blur', 5000)
    report.metrics.typingReleased = released
    await tab.shot('typing-released')
    check('While the composer has focus notifications wait behind a "2" chip in the header row, covering nothing; they show once it blurs')
  }

  /* B2: Safari's toolbar over the page: the visible area is 80 px short of the CSS viewport. */
  await openSession('smoke-new', 'Boolean(document.querySelector(".composer-input"))')
  const toolbar = await tab.run(`(() => {
    const target = new EventTarget()
    const fake = Object.assign(target, { height: window.innerHeight - 80, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 })
    try { Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake }) } catch (error) { return String(error) }
    window.dispatchEvent(new Event('resize'))
    return 'ok'
  })()`)
  await pause(250)
  const covered = await tab.run(`(() => { const app = document.getElementById('app').getBoundingClientRect(), bar = document.querySelector('.tabbar').getBoundingClientRect(); return { visible: window.visualViewport.height, app: Math.round(app.bottom), tabbar: Math.round(bar.bottom) } })()`)
  report.metrics.toolbar = { toolbar, ...covered }
  await tab.shot('toolbar-over-page')
  if (!before) {
    assert.equal(covered.app, covered.visible, 'the shell follows the visible height')
    assert.equal(covered.tabbar, covered.visible, 'the tab bar stays above the browser toolbar')
    check('When Safari reports a visible area shorter than the CSS viewport, the shell and its tab bar follow the visible height')
  }

  const phoneErrors = (await tab.consoleErrors()).filter(text => /Uncaught|Content Security Policy/.test(text))
  assert.deepEqual(phoneErrors, [], 'no uncaught error or CSP violation in the phone window')
  assert.deepEqual(errors, [])
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {})
  for (const id of phoneWindows) await phone(id).close().catch(() => {})
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await Promise.race([app.close(), pause(15000)])
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
