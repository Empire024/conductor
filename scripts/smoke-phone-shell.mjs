import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The phone web app as a phone browser meets it: the real Electron app serves it over its real HTTPS
// listener, and a second, parked BrowserWindow in its own session plays the phone. It checks the
// boot guard, the connection check, the certificate page, the pairing landing in iPhone Safari and
// iPhone Chrome, pairing itself, and what a reload shows once the desktop stops answering. No model
// inference happens. Run after `npm.cmd run build`; screenshots and report.json go to
// artifacts/swarm-2026-09-23/phone-app/.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-shell-'))
const output = resolve('.conductor-scratch/phone-redesign/shell')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1'

/** One HTTPS call that trusts nothing yet, the way a phone first meets the listener. */
const call = (origin, path) => new Promise((resolve, reject) => {
  const url = new URL(path, origin)
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', rejectUnauthorized: false, headers: { host: url.host } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } resolve({ status: response.statusCode, headers: response.headers, text, json }) })
  })
  req.once('error', reject)
  req.end()
})

const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  let value
  for (;;) {
    /* A read during a navigation can fail; that is just not yet. */
    value = await read().catch(() => undefined)
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + String(JSON.stringify(value)).slice(0, 600))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** A fixture AllowanceWeekReport (src/shared/usage-weeks.ts) around `now`: Claude seven_day with a
    current week, a used-up week, a partial 31%-unused week and a stretch without readings; one Codex week. */
const weeklyFixture = now => {
  const DAY = 86_400_000, at = offset => new Date(now + offset).toISOString()
  const base = { scope: 'provider', windowMinutes: 10_080, readings: 24, firstReadingAt: at(-20 * DAY), usedUp: false, usedUpAt: null, unusedPercent: null, coverage: 'complete', notes: [] }
  const claude = { ...base, provider: 'claude', bucket: 'seven_day', label: 'Weekly' }
  const tokens = (processed, costUsd) => ({ models: [{ model: 'claude-opus-5-5', processedTokens: processed, conversations: 6, estimated: true }], processedTokens: processed, totalTokens: processed, costUsd, costEstimated: true, complete: true, notes: [] })
  return {
    generatedAt: at(0),
    recordedSince: at(-31 * DAY),
    unknown: ['Grok reports no weekly allowance.'],
    weeks: [
      { ...claude, status: 'current', startsAt: at(-3 * DAY), endsAt: at(4 * DAY), lastReadingAt: at(-3_600_000), peakPercent: 42, finalPercent: 42, projection: { percentAtReset: 98, usedUpAt: null, basis: '42% in 3 d 0 h' }, tokens: tokens(18_400_000, 21.37) },
      { ...claude, status: 'closed', startsAt: at(-10 * DAY), endsAt: at(-3 * DAY), lastReadingAt: at(-3.1 * DAY), peakPercent: 100, finalPercent: 100, usedUp: true, usedUpAt: at(-4.6 * DAY), unusedPercent: 0, tokens: tokens(52_900_000, 64.8) },
      { ...claude, status: 'closed', startsAt: at(-17 * DAY), endsAt: at(-10 * DAY), lastReadingAt: at(-11.2 * DAY), peakPercent: 69, finalPercent: 69, unusedPercent: 31, coverage: 'partial', notes: ['Last reading 1 d 4 h before the reset; use after it is not known.', 'No readings from ' + at(-15 * DAY) + ' to ' + at(-12.5 * DAY) + '.'], tokens: tokens(30_100_000, 37.05) },
      { ...claude, status: 'no-data', startsAt: at(-24 * DAY), endsAt: at(-17 * DAY), readings: 0, firstReadingAt: null, lastReadingAt: null, peakPercent: null, finalPercent: null, coverage: 'none', notes: ['No readings from ' + at(-24 * DAY) + ' to ' + at(-17 * DAY) + '; use in this stretch is unknown.'] },
      { ...base, provider: 'codex', bucket: 'codex:primary', label: 'Weekly', status: 'closed', startsAt: at(-9 * DAY), endsAt: at(-2 * DAY), lastReadingAt: at(-2.05 * DAY), peakPercent: 88, finalPercent: 88, unusedPercent: 12, tokens: { models: [{ model: 'gpt-6.1-sol', processedTokens: 9_700_000, conversations: 3, estimated: false }], processedTokens: 9_700_000, totalTokens: 9_700_000, costUsd: null, costEstimated: false, complete: true, notes: [] } }
    ]
  }
}

const formatCode = raw => { const letters = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, ''); return letters.length > 4 ? letters.slice(0, 4) + '-' + letters.slice(4) : letters }

/* A phone-sized window in its own session, parked left of every display like the app's own windows
   under CONDUCTOR_TEST_USER_DATA: shown without activation so it paints and reports itself visible,
   never over the owner's screen, never in the taskbar. The session trusts only the listener's
   loopback certificate, which also makes it a secure context where the service worker can run. */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneShellConsole ??= {}
  const log = globalThis.__phoneShellConsole[win.id] = []
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') log.push(text)
  })
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return { id: win.id, userAgent: win.webContents.getUserAgent() }
}, { partition })

const phone = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  /* A hash change is a same-document navigation, which loadURL is not the tool for. */
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  reload: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).webContents.reload() }, id),
  text: () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript('document.body ? document.body.innerText : ""', true), id),
  userAgent: ua => app.evaluate(({ BrowserWindow }, { id, ua }) => BrowserWindow.fromId(id).webContents.setUserAgent(ua), { id, ua }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneShellConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

const phoneWindows = []
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const port = new URL(desktop.primaryEndpoint).port
  const origin = `https://127.0.0.1:${port}`

  // ------------------------------------------------------------------ HTTP level
  const index = await call(origin, '/')
  assert.equal(index.status, 200)
  const bootAt = index.text.indexOf('<script src="/boot.js"></script>')
  assert.ok(bootAt > 0 && index.text.indexOf('<script src="/app.js" defer></script>') > bootAt, 'boot.js loads, blocking, before the deferred app.js')
  const boot = await call(origin, '/boot.js')
  assert.equal(boot.status, 200)
  assert.match(boot.headers['content-type'], /^text\/javascript/)
  assert.ok(boot.text.includes('ConductorBoot'), 'the real boot guard is served, not the placeholder')
  const worker = await call(origin, '/sw.js')
  assert.ok(worker.text.includes("'conductor-phone-v4'") && worker.text.includes("'/boot.js'") && worker.text.includes("'/markdown.js'"))
  const markdown = await call(origin, '/markdown.js')
  assert.equal(markdown.status, 200)
  assert.ok(markdown.text.includes('ConductorMarkdown'), 'the markdown renderer is served')
  const health = await call(origin, '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  check('The listener serves the boot guard before app.js, markdown.js, the v4 worker precaching them, and an unauthenticated /api/health')

  // ------------------------------------------------------------------ the phone, unpaired
  const opened = await openPhone('phone-shell')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  await tab.load(origin + '/')
  await until(() => tab.run('window.__conductorBooted === true'), Boolean, 'the app to boot')
  assert.match(await tab.text(), /pairing code/i)
  assert.equal(await tab.run('document.querySelector("[data-boot]") === null'), true, 'the boot placeholder is gone')
  await tab.shot('smoke-pair')
  check('The served app boots in a phone-sized window, sets __conductorBooted and clears the boot placeholder')

  await tab.go('#diagnose')
  const diagnose = await until(() => tab.text(), text => text.includes('Reached Conductor'), 'the connection check')
  assert.ok(diagnose.includes('Reached Conductor ' + health.json.version), diagnose)
  assert.match(diagnose, /not paired yet/)
  await tab.shot('smoke-diagnose')
  check('#diagnose reports what /api/health answered, with no token')

  await tab.go('#trust')
  await until(() => tab.text(), text => text.includes('Trust this computer'), 'the certificate page')
  assert.equal(await tab.run('Boolean(document.querySelector(\'a[href="/ca.crt"]\'))'), true)
  await tab.shot('smoke-trust')
  check('#trust renders and links /ca.crt')

  // ------------------------------------------------------------------ the pairing landing
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  const code = formatCode(desktop.pairing.code)

  await tab.userAgent(IPHONE_CHROME)
  await tab.load('about:blank')
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('window.__conductorBooted === true'), Boolean, 'the app to boot in iPhone Chrome')
  assert.equal(await tab.run('location.hash'), '#/', 'the secret fragment is dropped at once')
  assert.equal(await tab.run('document.querySelector(".pair-code").textContent'), code)
  const handoff = await tab.run('Array.from(document.querySelectorAll("a")).find(a => a.textContent === "Open in Safari").getAttribute("href")')
  assert.equal(handoff, `x-safari-https://127.0.0.1:${port}/#pair=${encodeURIComponent(code)}`)
  assert.match(await tab.text(), /Already have Conductor on your Home Screen/)
  await tab.shot('smoke-pair-ios-chrome')
  check('iPhone Chrome: the landing hands off to Safari with #pair= kept and shows the code large')

  await tab.userAgent(IPHONE_SAFARI)
  await tab.load('about:blank')
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('window.__conductorBooted === true'), Boolean, 'the app to boot in iPhone Safari')
  assert.match(await tab.text(), /Add to Home Screen, then Add/)
  assert.equal(await tab.run('document.querySelector(".code-input").value'), code)
  await tab.shot('smoke-pair-ios-safari')
  await tab.go('#trust')
  await until(() => tab.text(), text => text.includes('Certificate Trust Settings'), 'the iPhone Safari certificate steps')
  await tab.shot('smoke-trust-ios-safari')
  check('iPhone Safari: the landing explains the Home Screen storage and keeps the form; #trust lists the profile steps')

  // ------------------------------------------------------------------ pairing for real
  await tab.userAgent(opened.userAgent)
  await tab.load('about:blank')
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('document.querySelector(".code-input") && document.querySelector(".code-input").value'), value => value === code, 'the code filled in')
  await tab.shot('smoke-pair-filled')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')
  desktop = await page.evaluate(() => window.conductor.phone.state())
  assert.equal(desktop.devices.length, 1)
  await tab.shot('smoke-sessions')
  check('#pair=CODE fills the code and pairing from the phone window reaches the live session list')

  for (const hash of ['#/tabs', '#/attention', '#/new', '#/more', '#/usage', '#/activity', '#/ideas/list', '#/phone', '#diagnose']) {
    await tab.go(hash)
    await until(() => tab.run('location.hash'), value => value === hash, 'route ' + hash)
    assert.equal(await tab.run('document.querySelector(".tabbar").hidden'), false, 'persistent Home on ' + hash)
    assert.deepEqual(await tab.run('Array.from(document.querySelectorAll(".tabbar .tab-label")).map(n => n.textContent)'), ['Home', 'Tabs', 'Attention', 'New task', 'More'])
    await tab.run('document.querySelector(".tabbar [data-tab=home]").click(); true')
    await until(() => tab.run('location.hash'), value => value === '#/', 'Home from ' + hash)
  }
  check('Five persistent destinations and one-tap Home work across all primary and secondary screens')
  await tab.run('history.back(); true')
  await until(() => tab.run('history.state?.conductorPhone?.depth'), value => value === 0, 'native Back at Home to stay inside the app')
  assert.equal(await tab.run('location.hash'), '#/')
  await tab.go('#/more')
  await until(() => tab.run('Boolean(document.querySelector(".appearance-options"))'), Boolean, 'More before native Back')
  await tab.run('history.back(); true')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero"))'), Boolean, 'native Back to pop one app screen')
  check('Native Back pops an app screen and the Home boundary stays inside the phone app')

  // ------------------------------------------------------------------ Usage: the weekly allowance report
  /* The offline profile has no allowance readings, so the phone's own fetch answers
     /api/usage/weekly with a fixture AllowanceWeekReport; /api/usage stays the real one. */
  const weeklyOutput = resolve('.conductor-scratch/usage-weekly')
  await mkdir(weeklyOutput, { recursive: true })
  await tab.run(`(() => {
    const fixture = ${JSON.stringify(weeklyFixture(Date.now()))}
    window.__smokeRealFetch = window.__smokeRealFetch || window.fetch
    window.fetch = (path, options) => path === '/api/usage/weekly'
      ? Promise.resolve(new Response(JSON.stringify(fixture), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : window.__smokeRealFetch(path, options)
    return true
  })()`)
  const savedTheme = await tab.run('document.documentElement.getAttribute("data-theme")')
  const sizePhone = (width, height) => app.evaluate(({ BrowserWindow }, { id, width, height }) => { BrowserWindow.fromId(id).setContentSize(width, height) }, { id: opened.id, width, height })
  await tab.go('#/usage')
  await until(() => tab.run('document.querySelectorAll(".weekly-card").length'), value => value === 2, 'the weekly allowance cards')
  const weeklyText = await tab.text()
  for (const expected of ['Claude · Weekly', 'Codex · Weekly', 'This week', '42% so far', 'on pace', 'Used up on', '31% left unused (last reading', '12% left unused', 'No readings', '≈ $', 'Cost is the provider CLI', 'Recorded since']) assert.ok(weeklyText.includes(expected), 'weekly report shows ' + expected)
  for (const [width, height] of [[390, 1500], [320, 1700]]) {
    await sizePhone(width, height)
    for (const theme of ['dark', 'light']) {
      await tab.run(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); Array.from(document.querySelectorAll('.section-head')).find(node => node.textContent.trim() === 'Weekly').scrollIntoView(); true`)
      await new Promise(resolve => setTimeout(resolve, 300))
      const overflow = await tab.run(`(() => { const scroll = document.querySelector('.weekly-card').closest('.scroll') || document.scrollingElement; return { inner: innerWidth, scroll: scroll.scrollWidth - scroll.clientWidth, cards: Array.from(document.querySelectorAll('.weekly-card, .weekly-row')).filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > innerWidth + 1).length } })()`)
      assert.equal(overflow.inner, width, 'phone window is ' + width + ' px wide')
      assert.ok(overflow.scroll <= 1 && overflow.cards === 0, 'no horizontal overflow at ' + width + ' px: ' + JSON.stringify(overflow))
      const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), opened.id)
      await writeFile(join(weeklyOutput, `phone-weekly-${theme}${width === 320 ? '-320' : ''}.png`), Buffer.from(png, 'base64'))
    }
  }
  await tab.run(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(savedTheme || 'system')}); window.fetch = window.__smokeRealFetch; true`)
  await sizePhone(390, 844)
  check('Usage shows the weekly allowance report (used up, left unused, projection, no readings, cost) without horizontal overflow at 390 and 320 px, light and dark')

  await tab.go('#/phone')
  await until(() => tab.text(), text => text.includes('Connection check'), 'the Phone screen')
  await tab.shot('smoke-phone')
  await tab.go('#diagnose')
  const paired = await until(() => tab.text(), text => text.includes('Paired as'), 'the paired connection check')
  assert.match(paired, /Live connection\s+Open/)
  await tab.shot('smoke-diagnose-paired')
  check('The Phone screen links the connection check, which reports the pairing and the open stream')
  const controlled = await until(() => tab.run('navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))'), Boolean, 'the service worker to control the page', 15000).catch(() => false)

  // ------------------------------------------------------------------ app.js cannot load
  const brokenOpened = await openPhone('phone-shell-broken')
  phoneWindows.push(brokenOpened.id)
  await app.evaluate(({ session }) => {
    session.fromPartition('phone-shell-broken').webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).pathname === '/app.js' }))
  })
  const broken = phone(brokenOpened.id)
  await broken.load(origin + '/')
  const card = await until(() => broken.text(), text => text.includes('did not start'), 'the boot card', 10000)
  assert.match(card, /could not be loaded/)
  await broken.shot('smoke-boot-card')
  await broken.close()
  check('With app.js blocked, the boot guard shows "did not start" with the address and the facts instead of a blank page')

  // ------------------------------------------------------------------ the computer stops answering
  desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: false }))
  assert.equal(desktop.listening, false)
  /* A paired list says so after 20 seconds of the owner looking at it. A parked window that
     Windows counts as occluded reports itself hidden and never "looks", so there the token goes and
     the reload lands on the pairing screen, whose own health check says the same thing at once. */
  const visibility = await tab.run('document.visibilityState')
  if (visibility !== 'visible') await tab.run('localStorage.removeItem("conductor.phone.token"); true')
  await tab.go('#/')
  await tab.reload()
  const offline = await until(() => tab.text(), text => /not answering|did not start|Cannot check this phone/.test(text), 'the phone to explain the unavailable computer', 45000)
  assert.ok(offline.trim().length > 0)
  assert.equal(await tab.run('Boolean(document.querySelector(".skeleton") || document.querySelector(".pair-form") || document.querySelector(".boot-card"))'), true, 'offline reload retains a safe recovery screen')
  await tab.shot('smoke-offline')
  check('After the desktop stops listening, reload shows an explained connection failure and safe recovery screen; service worker in control: ' + controlled)

  const phoneErrors = (await tab.consoleErrors()).filter(text => /Uncaught/.test(text))
  assert.deepEqual(phoneErrors, [], 'no uncaught error in the phone window')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'smoke-report.json'), JSON.stringify({ checks, errors, phoneConsoleErrors: await tab.consoleErrors(), serviceWorkerControlled: controlled, offlinePath: visibility === 'visible' ? 'session list banner' : 'pairing screen note', inference: 'none' }, null, 2))
} finally {
  for (const id of phoneWindows) await phone(id).close().catch(() => {})
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
