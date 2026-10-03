import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The session composer on a phone: one compact row ([image] [1-5 line field] [mic] [Stop while a
// turn runs] [Steer/Send]), no permanent dictation hint, the tab bar on the home-indicator inset
// once and out of the way while the keyboard is up. The real Electron app serves the phone page
// over its HTTPS listener to a parked, phone-sized BrowserWindow; only the conversation payload,
// the speech engine and (for the keyboard) the visual viewport are stand-ins. Run after
// `npm.cmd run build`, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-composer.mjs [--before]
// --before only takes screenshots (for a build that predates the compact composer).
// Screenshots and report.json go to .conductor-scratch/phone-composer/<after|before>/.
const before = process.argv.includes('--before')
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-composer-'))
const output = resolve('.conductor-scratch/phone-composer', before ? 'before' : 'after')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

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

/* Parked left of every display, shown without activation, out of the taskbar (as smoke-phone-shell). */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneComposerConsole ??= {}
  const log = globalThis.__phoneComposerConsole[win.id] = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') log.push(text)
  })
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return { id: win.id }
}, { partition })

const phone = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  size: (width, height) => app.evaluate(({ BrowserWindow }, { id, width, height }) => BrowserWindow.fromId(id).setContentSize(width, height), { id, width, height }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneComposerConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

/* Installed in the page after pairing: a running conversation that can be steered and take images,
   and a speech engine the smoke can fail on demand. */
const STAND_INS = `(() => {
  window.__phase = 'running'
  const conversation = () => ({
    summary: { id: 'smoke-cmp', title: 'Opus 5.5 root (medium): feature-list to zero', phase: window.__phase, state: window.__phase === 'running' ? 'working' : 'idle', provider: 'claude', model: 'opus', projectName: 'conductor' },
    items: [
      { id: 'u1', sequence: 1, timestamp: new Date().toISOString(), data: { type: 'text', role: 'user', text: 'Find out what it would take to print this asap and what the cost would be, how big it would be, and when I confirm we have Astra design it and we send it to print.' } },
      { id: 'a1', sequence: 2, timestamp: new Date().toISOString(), data: { type: 'text', role: 'assistant', text: 'Looking into the print shop options now.' } }
    ],
    pending: [], queued: [], canSteer: true, canAttachImages: true
  })
  const real = window.fetch.bind(window)
  window.fetch = async (path, init) => {
    const url = String(path)
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/api/sessions/smoke-cmp')) {
      if (init && init.method === 'POST') return json({ ok: true })
      return json(conversation())
    }
    return real(path, init)
  }
  window.__recognition = null
  window.webkitSpeechRecognition = class {
    constructor() { window.__recognition = this }
    start() {}
    stop() { setTimeout(() => this.onend && this.onend(), 0) }
    abort() { setTimeout(() => this.onend && this.onend(), 0) }
  }
  window.SpeechRecognition = undefined
  return true
})()`

/* What the owner sees of the composer: the row, the footer, the nav and the gap under it. */
const MEASURE = `(() => {
  const rect = node => { if (!node || node.hidden || getComputedStyle(node).display === 'none') return null; const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) } }
  const q = selector => document.querySelector(selector)
  const row = ['.composer-attach', '.composer-input', '.composer-mic', '.composer-stop', '.composer-send'].map(selector => ({ selector, rect: rect(q(selector)) }))
  const app = rect(q('#app'))
  return {
    innerHeight: window.innerHeight, innerWidth: window.innerWidth,
    app, footer: rect(q('.footer')), composer: rect(q('.composer')), tabbar: rect(q('.tabbar')),
    row, status: rect(q('.dictation-status')), statusText: q('.dictation-status') ? q('.dictation-status').textContent : null,
    primary: q('.composer-send') && q('.composer-send').textContent,
    keyboardOpen: document.documentElement.classList.contains('keyboard-open'),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }
})()`

const phoneWindows = []
const report = { mode: before ? 'before' : 'after', checks, errors, metrics: {} }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`

  const opened = await openPhone('phone-composer')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('Boolean(document.querySelector(".code-input") && document.querySelector(".code-input").value)'), Boolean, 'the code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')
  await tab.run(STAND_INS)

  const theme = async name => {
    await tab.go('#/more')
    await until(() => tab.run('Boolean(document.querySelector(".appearance-options"))'), Boolean, 'appearance controls')
    await tab.run('document.querySelector(".appearance-options [data-theme=' + name + ']").click(); true')
  }
  const openSession = async label => {
    await tab.go('#/')
    await until(() => tab.run('!document.querySelector(".composer")'), Boolean, 'leaving the session')
    await tab.go('#/session/smoke-cmp')
    await until(() => tab.run('document.querySelector(".composer-send") && document.querySelector(".composer-send").textContent'), text => text === label, 'the ' + label + ' composer')
    await pause(250)
  }
  const measure = async name => { const value = await tab.run(MEASURE); report.metrics[name] = value; return value }
  /* One row: every visible control shares the field's line, nothing above or below it. */
  const assertRow = (m, name, { stop }) => {
    const visible = m.row.filter(entry => entry.rect)
    assert.deepEqual(visible.map(entry => entry.selector), ['.composer-attach', '.composer-input', '.composer-mic', ...(stop ? ['.composer-stop'] : []), '.composer-send'], name + ': controls')
    for (const entry of visible) {
      assert.equal(entry.rect.bottom, m.composer.bottom, name + ': ' + entry.selector + ' sits on the row')
      assert.ok(entry.rect.height >= 44, name + ': ' + entry.selector + ' keeps a 44px target')
    }
    assert.equal(m.composer.height, 44, name + ': a one-line composer is one 44px row')
    assert.ok(visible.find(entry => entry.selector === '.composer-input').rect.width >= 70, name + ': the field keeps usable width')
    assert.equal(m.status, null, name + ': no dictation hint before any attempt')
    assert.equal(m.overflow, false, name + ': no page overflow')
  }
  const assertInsetOnce = (m, name) => {
    assert.equal(m.app.bottom, m.innerHeight, name + ': the shell reaches the bottom of the screen')
    assert.equal(m.tabbar.bottom, m.innerHeight, name + ': the nav sits on the bottom edge, no band under it')
    assert.ok(m.footer.height <= 66, name + ': footer is the row plus its padding (' + m.footer.height + ')')
  }

  for (const [width, height] of [[390, 844], [320, 640]]) {
    await tab.size(width, height)
    for (const name of ['dark', 'light']) {
      await theme(name)
      await openSession('Steer')
      const m = await measure('running-' + width + '-' + name)
      await tab.shot('running-' + width + '-' + name)
      if (!before) { assertRow(m, 'running ' + width + ' ' + name, { stop: true }); assertInsetOnce(m, 'running ' + width + ' ' + name) }
    }
  }
  if (!before) check('A running session shows one 44px row [image][field][mic][Stop][Steer] at 390 and 320px, light and dark, with no hint and the nav on the bottom edge')

  await tab.size(390, 844)
  await theme('dark')
  await tab.run("window.__phase = 'idle'; true")
  for (const width of [390, 320]) {
    await tab.size(width, width === 390 ? 844 : 640)
    await openSession('Send')
    const m = await measure('idle-' + width + '-dark')
    await tab.shot('idle-' + width + '-dark')
    if (!before) assertRow(m, 'idle ' + width, { stop: false })
  }
  if (!before) check('An idle session shows [image][field][mic][Send] in one row without Stop')

  await tab.size(390, 844)
  await tab.run("window.__phase = 'running'; true")
  await openSession('Steer')
  await tab.run(`(() => { const input = document.querySelector('.composer-input'); input.value = Array.from({ length: 9 }, (_, i) => 'Line ' + (i + 1) + ' of a longer steer').join('\\n'); input.dispatchEvent(new Event('input')); return true })()`)
  await pause(150)
  const draft = await measure('draft-390-dark')
  report.metrics.draftField = await tab.run(`(() => { const input = document.querySelector('.composer-input'); return { height: input.getBoundingClientRect().height, overflowY: getComputedStyle(input).overflowY, scrollHeight: input.scrollHeight, clientHeight: input.clientHeight } })()`)
  await tab.shot('draft-390-dark')
  if (!before) {
    const field = report.metrics.draftField
    assert.ok(field.height >= 120 && field.height <= 126, 'a long draft grows to about five lines: ' + field.height)
    assert.equal(field.overflowY, 'auto', 'past five lines the field scrolls')
    const send = draft.row.find(entry => entry.selector === '.composer-send').rect
    assert.equal(send.bottom, draft.composer.bottom, 'the buttons stay on the bottom line of a grown field')
    check('A long draft grows the field to five lines, then it scrolls; the buttons stay on its last line')
  }

  await tab.run(`(() => { const input = document.querySelector('.composer-input'); input.value = ''; input.dispatchEvent(new Event('input')); document.querySelector('.composer-mic').click(); window.__recognition.onerror({ error: 'network' }); return true })()`)
  await pause(200)
  const failed = await measure('dictation-failed-390-dark')
  await tab.shot('dictation-failed-390-dark')
  if (!before) {
    assert.ok(failed.status, 'a failed attempt shows the note')
    assert.match(failed.statusText, /Speech service connection failed/)
    assert.match(failed.statusText, /Use keyboard/)
    assert.ok(failed.status.height <= 46, 'the note is one line: ' + failed.status.height)
    await tab.run(`document.querySelector('.dictation-dismiss').click(); true`)
    assert.equal((await measure('dictation-dismissed-390-dark')).status, null, 'dismissing hides the note')
    check('A failed dictation attempt shows a one-line note with Use keyboard, and it can be dismissed')
  }
  await until(() => tab.run('document.getElementById("toasts").textContent'), text => text === '', 'dictation toast to clear', 30000)

  /* The keyboard: the visual viewport shrinks under a focused field while the layout viewport stays. */
  const keyboard = await tab.run(`(() => {
    const target = new EventTarget()
    const fake = Object.assign(target, { height: window.innerHeight - 336, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 })
    try { Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake }) } catch (error) { return String(error) }
    document.querySelector('.composer-input').focus()
    window.dispatchEvent(new Event('resize'))
    return window.visualViewport === fake ? 'ok' : 'not replaced'
  })()`)
  report.keyboardStandIn = keyboard
  await pause(250)
  const typing = await measure('keyboard-390-dark')
  await tab.shot('keyboard-390-dark')
  if (!before && keyboard === 'ok') {
    assert.equal(typing.keyboardOpen, true, 'the shell knows the keyboard is up')
    assert.equal(typing.app.height, 844 - 336, 'the shell fits the visual viewport above the keyboard')
    assert.equal(typing.tabbar, null, 'the nav steps aside while typing')
    assert.equal(typing.footer.bottom, 844 - 336, 'the composer sits on the keyboard')
    await tab.run(`(() => { window.visualViewport.height = window.innerHeight; document.querySelector('.composer-input').blur(); window.dispatchEvent(new Event('resize')); return true })()`)
    await pause(150)
    const closed = await measure('keyboard-closed-390-dark')
    assert.equal(closed.keyboardOpen, false)
    assertInsetOnce(closed, 'keyboard closed')
    check('With the keyboard up the composer sits on it and the nav steps aside; closing it brings the nav back on the bottom edge')
  }

  const phoneErrors = (await tab.consoleErrors()).filter(text => /Uncaught|Content Security Policy/.test(text))
  assert.deepEqual(phoneErrors, [], 'no uncaught error or CSP violation in the phone window')
  assert.deepEqual(errors, [])
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {})
  for (const id of phoneWindows) await phone(id).close().catch(() => {})
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
