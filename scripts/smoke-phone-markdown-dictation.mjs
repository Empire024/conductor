import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Agent markdown and composer dictation in the phone web app, as the phone meets them: the real
// Electron app serves index.html, markdown.js, app.js and app.css over its HTTPS listener, and a
// parked, phone-sized BrowserWindow pairs and opens a conversation. Only the conversation payload
// and the speech engine are stand-ins: the page's fetch answers /api/sessions/smoke-md itself, and
// a scripted webkitSpeechRecognition says what was "heard" (no microphone, no speech service, no
// inference). Run after `npm.cmd run build`, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-markdown-dictation.mjs
// Screenshots and report.json go to .conductor-scratch/phone-redesign/markdown-dictation/.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-md-'))
const output = resolve('.conductor-scratch/phone-redesign/markdown-dictation')
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

/* Parked left of every display, shown without activation, out of the taskbar (as smoke-phone-shell). */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneMdConsole ??= {}
  const log = globalThis.__phoneMdConsole[win.id] = []
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
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneMdConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

const REPLY = [
  '## Fixed the build',
  '',
  'The **root cause** was a stale `out/` bundle; see [the docs](https://example.com/docs) and ignore [this](javascript:alert(1)).',
  '',
  '- removed the cache',
  '- [x] reran the tests',
  '  1. unit',
  '  2. smoke',
  '',
  '> quoted note',
  '',
  '| File | Lines |',
  '| :--- | ---: |',
  '| src/phone/app.js | 4400 |',
  '',
  '```js',
  'const html = "<b>not bold</b>"',
  '```',
  '',
  '<img src=x onerror="window.__owned = true"> stays text'
].join('\n')

/* Installed in the page after pairing: the conversation, the message endpoint and the speech engine. */
const STAND_INS = `(() => {
  const conversation = {
    summary: { id: 'smoke-md', title: 'Markdown smoke', phase: 'idle', state: 'idle', provider: 'claude', model: 'opus', projectName: 'Smoke' },
    items: [
      { id: 'u1', sequence: 1, timestamp: new Date().toISOString(), data: { type: 'text', role: 'user', text: 'fix **it** please' } },
      { id: 'a1', sequence: 2, timestamp: new Date().toISOString(), data: { type: 'text', role: 'assistant', text: ${JSON.stringify(REPLY)} } }
    ],
    pending: [], queued: []
  }
  const real = window.fetch.bind(window)
  window.__posts = []
  window.fetch = async (path, init) => {
    const url = String(path)
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/usage') return json({ providers: ['claude', 'codex'].map(provider => ({ provider, windows: [{ kind: 'weekly', scope: 'provider', label: 'Weekly', usedPercent: 42, state: 'current', observedAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 86400000).toISOString() }] })), allowance: ['claude', 'codex'].map(provider => ({ provider, weekly: { label: 'Weekly', points: [[0, 12], [.3, 24], [.7, 31], [1, 42]] } })) })
    if (url === '/api/activity') return json({ since: new Date(Date.now() - 604800000).toISOString(), hasMore: false, items: [{ id: 'smoke-receipt', kind: 'email', title: 'Sent email to Print Spot', detail: 'Smoke fixture: confirmed SMTP receipt', at: new Date().toISOString(), projectId: 'smoke', projectName: 'Conductor', sessionId: 'smoke-md', tabTitle: 'Print order' }] })
    if (url.startsWith('/api/sessions/smoke-md')) {
      const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (init && init.method === 'POST') { window.__posts.push({ path: url, body: init.body ? JSON.parse(init.body) : null }); return json({ ok: true }) }
      return json(conversation)
    }
    return real(path, init)
  }
  window.__nativeSpeech = typeof window.webkitSpeechRecognition === 'function' || typeof window.SpeechRecognition === 'function'
  window.__recognition = null
  window.webkitSpeechRecognition = class {
    constructor() { window.__recognition = this; this.started = false; this.stopped = false; this.aborted = false }
    start() { this.started = true }
    stop() { this.stopped = true; setTimeout(() => this.onend && this.onend(), 0) }
    abort() { this.aborted = true; setTimeout(() => this.onend && this.onend(), 0) }
  }
  window.SpeechRecognition = undefined
  window.__hear = parts => {
    const results = parts.map(([transcript, isFinal]) => Object.assign([{ transcript: transcript, confidence: 0.9 }], { isFinal: isFinal }))
    window.__recognition.onresult({ resultIndex: 0, results: results })
  }
  return window.__nativeSpeech
})()`

const phoneWindows = []
const report = { checks, errors }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`

  const opened = await openPhone('phone-md')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('Boolean(document.querySelector(".code-input") && document.querySelector(".code-input").value)'), Boolean, 'the code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')
  assert.equal(await tab.run('typeof window.ConductorMarkdown === "object" && typeof window.ConductorMarkdown.render === "function"'), true, 'markdown.js loaded before app.js')
  check('The paired phone loads the served markdown.js next to app.js')

  report.nativeSpeechRecognition = await tab.run(STAND_INS)
  await tab.go('#/session/smoke-md')
  await until(() => tab.run('Boolean(document.querySelector(".bubble.assistant .md-h2"))'), Boolean, 'the rendered reply')

  // ------------------------------------------------------------------ markdown
  const rendered = await tab.run(`(() => {
    const bubble = document.querySelector('.bubble.assistant .bubble-body')
    const q = selector => Array.from(bubble.querySelectorAll(selector))
    return {
      heading: q('.md-h2').map(node => node.textContent),
      strong: q('strong').map(node => node.textContent),
      inlineCode: q('code.md-code').map(node => node.textContent),
      links: q('a').map(node => ({ href: node.getAttribute('href'), text: node.textContent, rel: node.getAttribute('rel') })),
      items: q('.md-list > li').length,
      nestedOrdered: q('li ol > li').map(node => node.textContent),
      task: q('.md-check').map(node => node.textContent),
      quote: q('blockquote').map(node => node.textContent.trim()),
      cells: q('td, th').map(node => node.textContent),
      rightAligned: getComputedStyle(q('td')[1]).textAlign,
      tableScroll: getComputedStyle(q('.md-table-wrap')[0]).overflowX,
      codeBlock: q('pre.code-block code').map(node => node.textContent),
      images: q('img').length,
      scripts: q('script').length,
      bTags: q('b').length,
      text: bubble.textContent,
      owned: window.__owned === true,
      userStrong: document.querySelector('.bubble.user').querySelectorAll('strong').length,
      userText: document.querySelector('.bubble.user .bubble-body').textContent,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })()`)
  report.rendered = rendered
  assert.deepEqual(rendered.heading, ['Fixed the build'])
  assert.deepEqual(rendered.strong, ['root cause'])
  assert.deepEqual(rendered.inlineCode, ['out/'])
  assert.deepEqual(rendered.links, [{ href: 'https://example.com/docs', text: 'the docs', rel: 'noopener noreferrer' }])
  assert.ok(rendered.text.includes('ignore this.'), 'the javascript: link keeps only its label')
  assert.deepEqual(rendered.nestedOrdered, ['unit', 'smoke'])
  assert.deepEqual(rendered.task, ['☑'])
  assert.deepEqual(rendered.quote, ['quoted note'])
  assert.deepEqual(rendered.cells, ['File', 'Lines', 'src/phone/app.js', '4400'])
  assert.equal(rendered.rightAligned, 'right')
  assert.equal(rendered.tableScroll, 'auto')
  assert.deepEqual(rendered.codeBlock, ['const html = "<b>not bold</b>"'])
  assert.equal(rendered.images + rendered.scripts + rendered.bTags, 0, 'no HTML from the reply became an element')
  assert.ok(rendered.text.includes('<img src=x onerror="window.__owned = true"> stays text'))
  assert.equal(rendered.owned, false)
  assert.equal(rendered.userStrong, 0)
  assert.ok(rendered.userText.includes('fix **it** please'), 'the owner text stays as typed')
  assert.equal(rendered.overflow, false, 'nothing widens the page past the phone')
  await tab.shot('markdown-reply')
  check('An agent reply renders headings, strong, code, lists with tasks and nesting, quote, a scrolling table and a fenced block; only the https link is live; raw HTML stays text; the owner bubble stays plain')

  // ------------------------------------------------------------------ dictation
  const mic = await tab.run(`(() => { const node = document.querySelector('.composer-mic'); return node && { label: node.getAttribute('aria-label'), unsupported: node.classList.contains('unsupported') } })()`)
  assert.deepEqual(mic, { label: 'Dictate', unsupported: false })
  await tab.run(`(() => { const input = document.querySelector('.composer-input'); input.value = 'Also'; input.dispatchEvent(new Event('input')); return true })()`)
  await tab.run(`document.querySelector('.composer-mic').click(); true`)
  const listening = await tab.run(`(() => ({ started: window.__recognition.started, continuous: window.__recognition.continuous, interim: window.__recognition.interimResults, lang: window.__recognition.lang, pressed: document.querySelector('.composer-mic').getAttribute('aria-pressed'), cls: document.querySelector('.composer-mic').className }))()`)
  assert.equal(listening.started, true)
  assert.equal(listening.continuous, true)
  assert.equal(listening.interim, true)
  assert.ok(listening.lang, 'a recognition language is set')
  assert.equal(listening.pressed, 'true')
  assert.match(listening.cls, /listening/)
  await tab.run(`window.__hear([['check the', false]]); true`)
  assert.equal(await tab.run(`document.querySelector('.composer-input').value`), 'Also check the')
  await tab.run(`window.__hear([['check the', true], [' phone smoke', false]]); true`)
  assert.equal(await tab.run(`document.querySelector('.composer-input').value`), 'Also check the phone smoke')
  assert.equal(await tab.run(`document.querySelector('.composer-send').disabled`), false)
  await tab.shot('dictation-listening')
  await tab.run(`document.querySelector('.composer-send').click(); true`)
  const posts = await until(() => tab.run('window.__posts'), value => Array.isArray(value) && value.length > 0, 'the message post')
  assert.equal(posts[0].path, '/api/sessions/smoke-md/message')
  assert.equal(posts[0].body.text, 'Also check the phone smoke')
  assert.equal(await tab.run('window.__recognition.aborted'), true, 'sending drops the dictation still in flight')
  await until(() => tab.run(`document.querySelector('.composer-mic').getAttribute('aria-pressed')`), value => value === 'false', 'the mic to stop')
  check('The mic dictates into the composer after the typed text (interim then final, no doubled words), and Send posts it and stops listening')

  // ------------------------------------------------------------------ no speech recognition
  await tab.run('window.webkitSpeechRecognition = undefined; window.SpeechRecognition = undefined; true')
  await tab.go('#/')
  await until(() => tab.run('!document.querySelector(".composer-mic")'), Boolean, 'the session list')
  await tab.go('#/session/smoke-md')
  await until(() => tab.run('Boolean(document.querySelector(".composer-mic"))'), Boolean, 'the composer again')
  const fallback = await tab.run(`(() => { const node = document.querySelector('.composer-mic'); return { unsupported: node.classList.contains('unsupported'), label: node.getAttribute('aria-label') } })()`)
  assert.equal(fallback.unsupported, true)
  assert.match(fallback.label, /[Dd]ictation/)
  await tab.run(`document.querySelector('.composer-mic').click(); true`)
  const toast = await until(() => tab.run(`document.body.innerText`), text => typeof text === 'string' && /keyboard.*microphone|microphone.*keyboard/i.test(text), 'the persistent fallback note')
  assert.match(toast, /keyboard/i)
  await tab.shot('dictation-unsupported')
  check('Without speech recognition the mic is dimmed and a tap says to use the keyboard microphone key')

  await until(() => tab.run('document.getElementById("toasts").textContent'), text => text === '', 'dictation toast to clear')
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setContentSize(320, 740), opened.id)
  for (const theme of ['dark', 'light']) {
    await tab.go('#/more')
    await until(() => tab.run('Boolean(document.querySelector(".appearance-options"))'), Boolean, 'appearance controls')
    await tab.run('document.querySelector(".appearance-options [data-theme=' + theme + ']").click(); true')
    for (const [route, ready] of [['#/', '.home-hero'], ['#/new', '.new-task-prompt'], ['#/usage', '.sparkline'], ['#/activity', '.activity-card'], ['#/session/smoke-md', '.composer']]) {
      await tab.go(route)
      await until(() => tab.run('Boolean(document.querySelector(' + JSON.stringify(ready) + '))'), Boolean, route + ' content')
      assert.equal(await tab.run('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false, '320px overflow: ' + route)
      assert.equal(await tab.run('document.querySelector(".tabbar").hidden'), false)
      await new Promise(resolve => setTimeout(resolve, 220))
      await tab.shot(theme + '-' + (route === '#/' ? 'home' : route.split('/')[1]) + '-320')
    }
  }
  check('Real served Home, New task, Usage graphs, Activity and conversation render in both themes at 320px with persistent navigation and no page overflow')

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
