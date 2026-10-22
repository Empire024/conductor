// Typing never moves the conversation (owner, 2026-10-22, conductor-task:typing-jump-1022: "As I'm
// typing this the whole web app is jumping up with every written letter"). Parked Electron window,
// synthetic Claude CLI (no inference): a few long answers fill the timeline, then text is typed one
// key at a time, with newlines so the composer grows, while every key's layout is recorded.
//   D1 desktop pane at the live end: the timeline stays at the bottom and the sticky bar keeps its
//      message (no re-pick, no slide-in) on every key;
//   D2 desktop pane scrolled up: scrollTop and the sticky bar never change while typing;
//   P1 phone (WebKit and Chromium, phone viewport shrunk as by a keyboard) at the live end: no
//      scrollIntoView, the page and the top bar never move, the timeline stays at the bottom;
//   P2 phone scrolled up: the timeline's scrollTop never changes while typing.
//   node scripts/smoke-lock.mjs --timeout-min 10 -- node scripts/smoke-typing-stable.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, outputDir, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'typing-stable', output: '.conductor-scratch/typing-stable' })
watchdog(480)

// Every prompt gets a 40-line answer, so three turns overflow the timeline.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' })
  const lines = Array.from({ length: 40 }, (_, index) => 'Line ' + (index + 1) + ' of the answer to ' + prompt.split('\\n', 1)[0].slice(0, 40))
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: lines.join('\\n\\n') }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`
// About 70 keys with three newlines, so the composer grows to four lines on the way.
const TYPED = 'Please look at this\nthe page should not move\nwhile I keep typing\nletters'

const phaseOf = async id => (await call('agents.status', { agentSessionId: id })).phase
const settled = (id, label) => poll(async () => await phaseOf(id) === 'completed', { timeoutMs: 60_000, label: `${label} completed` })
const playwrightBuild = (engines, engine) => {
  if (existsSync(engines[engine].executablePath())) return {}
  const folder = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const builds = existsSync(folder) ? readdirSync(folder).filter(name => new RegExp('^' + engine + '-\\d+$').test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : []
  const executable = builds.map(name => join(folder, name, engine === 'webkit' ? 'Playwright.exe' : 'chrome-win/chrome.exe')).find(path => existsSync(path))
  if (!executable) throw new Error(`No ${engine} build is installed for Playwright`)
  return { executablePath: executable }
}
const https = (origin, path, { body, ca } = {}) => new Promise((done, fail) => {
  const url = new URL(path, origin)
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname, method: payload ? 'POST' : 'GET', ca, rejectUnauthorized: Boolean(ca), headers: { host: url.host, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } done({ status: response.statusCode, text, json }) })
  })
  req.once('error', fail)
  req.end(payload)
})

// Types TYPED one key at a time and returns one sample per key, taken after the frame (and the
// phone's 60 ms caret timer) settled.
const typeAndSample = async (target, keyboard, sample, { newline, arg }) => {
  const samples = [await target.evaluate(sample, arg)]
  for (const char of TYPED) {
    if (char === '\n') await keyboard.press(newline)
    else await keyboard.type(char)
    await target.evaluate(() => new Promise(done => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 90)))
    samples.push(await target.evaluate(sample, arg))
  }
  return samples
}
const spread = values => Math.max(...values) - Math.min(...values)

try {
  step('launch and fill a conversation')
  const inst = await launchParked({ fixtures: { 'fake-claude.mjs': FIXTURE }, build })
  await openProject({ name: 'Typing stable', git: true })
  const view = await page(inst)
  const tab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Typing' })
  const id = tab.resourceId
  const pane = view.locator(`.structured-agent-pane[data-structured-session="${id}"]`)
  await pane.waitFor()
  const composer = pane.getByRole('textbox', { name: /^Message / })
  for (const prompt of ['First question', 'Second question', 'Third question']) {
    await composer.fill(prompt)
    await composer.press('Enter')
    await poll(async () => (await phaseOf(id)) !== 'idle', { timeoutMs: 20_000, label: prompt + ' started' }).catch(() => undefined)
    await settled(id, prompt)
  }
  await pane.locator('.sa-timeline').getByText('Line 40 of the answer to Third question').waitFor({ timeout: 15_000 })

  const desktopSample = paneId => {
    const pane = document.querySelector(`.structured-agent-pane[data-structured-session="${paneId}"]`)
    const timeline = pane.querySelector('.sa-timeline')
    const sticky = pane.querySelector('.sa-pinned-prompt')
    if (sticky && !sticky.dataset.probe) sticky.dataset.probe = String(Math.random())
    const field = pane.querySelector('textarea')
    return { top: timeline.scrollTop, fromBottom: Math.round(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight), sticky: sticky ? sticky.textContent : null, stickyElement: sticky ? sticky.dataset.probe : null, animating: Boolean(sticky?.classList.contains('sa-pinned-changed')), composer: field ? Math.round(field.getBoundingClientRect().height) : 0, paneTop: Math.round(pane.getBoundingClientRect().top) }
  }

  // ------------------------------------------------------------------ D1
  step('D1 desktop at the live end: typing keeps the timeline at the bottom and the sticky bar still')
  await composer.click()
  await view.waitForTimeout(400)
  const d1 = await typeAndSample(view, view.keyboard, desktopSample, { newline: 'Shift+Enter', arg: id })
  assert.ok(d1[d1.length - 1].composer > d1[0].composer, 'the composer grew while typing: ' + JSON.stringify([d1[0].composer, d1[d1.length - 1].composer]))
  const d1Off = d1.filter(entry => entry.fromBottom > 2)
  assert.deepEqual(d1Off, [], 'the timeline left the bottom while typing')
  assert.equal(new Set(d1.map(entry => entry.sticky)).size, 1, 'the sticky bar changed message while typing: ' + JSON.stringify([...new Set(d1.map(entry => entry.sticky))]))
  assert.equal(new Set(d1.map(entry => entry.stickyElement)).size, 1, 'the sticky bar was redrawn while typing')
  assert.equal(spread(d1.map(entry => entry.paneTop)), 0, 'the pane moved')
  record('D1', 'PASS', { keys: d1.length - 1, composer: [d1[0].composer, d1[d1.length - 1].composer], sticky: d1[0].sticky?.slice(0, 40) }, await shot('d1-typed-at-bottom'))

  // ------------------------------------------------------------------ D2
  step('D2 desktop scrolled up: typing never changes scrollTop or the sticky bar')
  await composer.fill('')
  await view.waitForTimeout(300)
  const timeline = pane.locator('.sa-timeline')
  await timeline.hover()
  await view.mouse.wheel(0, -900)
  await view.waitForTimeout(600)
  await composer.click()
  await view.waitForTimeout(300)
  const d2 = await typeAndSample(view, view.keyboard, desktopSample, { newline: 'Shift+Enter', arg: id })
  assert.ok(d2[0].fromBottom > 200, 'the timeline was scrolled up: ' + d2[0].fromBottom)
  assert.equal(spread(d2.map(entry => entry.top)), 0, 'scrollTop moved while typing: ' + JSON.stringify(d2.map(entry => entry.top)))
  assert.equal(new Set(d2.map(entry => entry.sticky)).size, 1, 'the sticky bar changed message while typing')
  assert.equal(new Set(d2.map(entry => entry.stickyElement)).size, 1, 'the sticky bar was redrawn while typing')
  assert.ok(!d2.slice(1).some(entry => entry.animating && !d2[0].animating), 'the sticky bar slid in while typing')
  record('D2', 'PASS', { keys: d2.length - 1, scrollTop: d2[0].top }, await shot('d2-typed-scrolled-up'))
  await composer.fill('')

  // ------------------------------------------------------------------ P1 / P2
  step('P1/P2 phone: typing never scrolls the page or the timeline')
  const desktop = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = (await https(origin, '/ca.crt')).text
  const pairing = await view.evaluate(() => window.conductor.phone.pair())
  const paired = await https(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Typing phone' } })
  assert.equal(paired.status, 200, paired.text)
  const token = paired.json.token
  const { chromium, webkit } = await import('@playwright/test')
  const engines = { chromium, webkit }
  const phoneSample = () => {
    const timeline = document.querySelector('.timeline')
    const bar = document.querySelector('.conversation-bar')
    const field = document.querySelector('.composer-input')
    return { top: Math.round(timeline.scrollTop), fromBottom: Math.round(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight), page: Math.round(window.scrollY), viewport: Math.round(window.visualViewport ? window.visualViewport.offsetTop : 0), bar: Math.round(bar.getBoundingClientRect().top), composer: Math.round(field.getBoundingClientRect().height), intoView: window.__intoView || 0 }
  }
  const phoneNotes = {}
  for (const engine of ['webkit', 'chromium']) {
    const browser = await engines[engine].launch({ headless: true, ...playwrightBuild(engines, engine) })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === 'chromium', serviceWorkers: 'block' })
      await context.addInitScript(value => {
        window.localStorage.setItem('conductor.phone.token', value)
        const original = Element.prototype.scrollIntoView
        Element.prototype.scrollIntoView = function (...args) { window.__intoView = (window.__intoView || 0) + 1; return original.apply(this, args) }
      }, token)
      const phone = await context.newPage()
      const problems = []
      phone.on('pageerror', error => problems.push(error.message))
      await phone.goto(origin + '/#/session/' + encodeURIComponent(id))
      await phone.locator('.timeline').getByText('Line 40 of the answer to Third question').waitFor({ timeout: 20_000 })
      const field = phone.locator('.composer-input')
      await field.click()
      // The on-screen keyboard takes the lower part of the screen.
      await phone.setViewportSize({ width: 390, height: 470 })
      await phone.waitForTimeout(500)
      await phone.evaluate(() => { const timeline = document.querySelector('.timeline'); timeline.scrollTop = timeline.scrollHeight; window.__intoView = 0 })
      await phone.waitForTimeout(200)
      const p1 = await typeAndSample(phone, phone.keyboard, phoneSample, { newline: 'Enter' })
      assert.ok(p1[p1.length - 1].composer > p1[0].composer, engine + ': the composer grew while typing')
      assert.equal(p1[p1.length - 1].intoView, 0, engine + ': scrollIntoView ran while typing a visible field')
      assert.equal(spread(p1.map(entry => entry.page)), 0, engine + ': the page scrolled while typing')
      assert.equal(spread(p1.map(entry => entry.viewport)), 0, engine + ': the visual viewport moved while typing')
      assert.equal(spread(p1.map(entry => entry.bar)), 0, engine + ': the top bar moved while typing')
      assert.deepEqual(p1.filter(entry => entry.fromBottom > 2), [], engine + ': the timeline left the bottom while typing')
      await phone.screenshot({ path: join(outputDir(), `p1-${engine}.png`) })

      await field.fill('')
      await phone.waitForTimeout(200)
      await phone.evaluate(() => { const timeline = document.querySelector('.timeline'); timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight - 600) })
      await phone.waitForTimeout(300)
      const p2 = await typeAndSample(phone, phone.keyboard, phoneSample, { newline: 'Enter' })
      assert.ok(p2[0].fromBottom > 200, engine + ': the timeline was scrolled up: ' + p2[0].fromBottom)
      assert.equal(spread(p2.map(entry => entry.top)), 0, engine + ': the timeline scrolled while typing: ' + JSON.stringify(p2.map(entry => entry.top)))
      assert.equal(spread(p2.map(entry => entry.bar)), 0, engine + ': the top bar moved while typing')
      await phone.screenshot({ path: join(outputDir(), `p2-${engine}.png`) })
      assert.deepEqual(problems, [], engine + ' page errors')
      phoneNotes[engine] = { keys: p1.length - 1, composer: [p1[0].composer, p1[p1.length - 1].composer], scrolledUpTop: p2[0].top }
    } finally { await browser.close() }
  }
  record('P1', 'PASS', phoneNotes, 'phone at the live end: no scrollIntoView, page, viewport and top bar fixed, timeline pinned')
  record('P2', 'PASS', {}, 'phone scrolled up: timeline scrollTop fixed on every key')
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
