import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// A question card on the phone follows the request it shows, live: answered on the desktop, it
// leaves the phone without a reload; closed on the desktop (Stop) while the owner is typing an
// answer on the phone, the card stays, marked closed, with the typed text, and "Send as message"
// delivers that answer to the agent as an ordinary message. Real Electron main/renderer, the real
// HTTPS phone listener and the real phone page in a parked phone-sized window; only the provider
// is the synthetic Claude fixture (no inference). Run after `npm.cmd run build`, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-stale-question.mjs
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-stale-question-'))
const output = resolve('.conductor-scratch/phone-stale-question')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [process.env.CONDUCTOR_SMOKE_MAIN ?? resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  let value
  for (;;) {
    value = await read().catch(error => ({ error: String(error) }))
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 600))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/* Parked left of every display, shown without activation, out of the taskbar (as smoke-phone-shell). */
const openPhone = () => app.evaluate(({ BrowserWindow, session, screen }) => {
  const phoneSession = session.fromPartition('phone-stale-question')
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition: 'phone-stale-question', backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneStaleConsole = []
  win.webContents.on('console-message', (event, level, message) => {
    const severity = typeof event?.level === 'string' ? event.level : (level === 3 ? 'error' : 'other')
    if (severity === 'error') globalThis.__phoneStaleConsole.push(typeof event?.message === 'string' ? event.message : String(message ?? ''))
  })
  win.setPosition(area.x - 6000, area.y)
  win.showInactive()
  return win.id
})
const phoneTab = id => ({
  load: url => app.evaluate(async ({ BrowserWindow }, { id, url }) => { try { await BrowserWindow.fromId(id).loadURL(url) } catch (error) { return String(error) } return '' }, { id, url }),
  run: js => app.evaluate(({ BrowserWindow }, { id, js }) => BrowserWindow.fromId(id).webContents.executeJavaScript(js, true), { id, js }),
  go: hash => app.evaluate(({ BrowserWindow }, { id, hash }) => BrowserWindow.fromId(id).webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + '; true', true), { id, hash }),
  shot: async name => {
    const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).webContents.capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(output, name + '.png'), Buffer.from(png, 'base64'))
  },
  consoleErrors: () => app.evaluate(() => (globalThis.__phoneStaleConsole ?? []).slice()),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

/* The desktop's own view of a conversation, through the same preload bridge its panes use. */
const desktopSnapshot = id => page.evaluate(id => window.conductor.structured.snapshot(id), id)
const pendingOnDesktop = snapshot => (snapshot?.items ?? []).find(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending')
const cardState = `(() => {
  const card = document.querySelector('.pending-host .pending')
  if (!card) return { card: false }
  const input = card.querySelector('input.input')
  return { card: true, closed: card.classList.contains('pending-closed'), kind: card.querySelector('.pending-kind')?.textContent, typed: input ? input.value : null,
    send: Array.from(card.querySelectorAll('button')).map(node => node.textContent), error: card.querySelector('.pending-error:not([hidden])')?.textContent || '' }
})()`

let tab
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  const project = await page.evaluate(() => window.conductor.projects.create('Phone stale question'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Phone stale question' }).click()
  await expect(launcherTile(page, 'Claude')).toBeVisible()
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`

  tab = phoneTab(await openPhone())
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('Boolean(document.querySelector(".code-input") && document.querySelector(".code-input").value)'), Boolean, 'the code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')
  check('The parked phone window pairs with the real HTTPS listener')

  /* Both conversations are opened from the phone page itself, with its stored token. */
  const openTask = title => tab.run(`(async () => {
    const token = localStorage.getItem('conductor.phone.token')
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token }
    const state = await (await fetch('/api/state', { headers })).json()
    const project = state.projects.find(entry => entry.id === ${JSON.stringify(project.id)})
    const claude = state.providers.find(entry => entry.id === 'claude')
    const reply = await fetch('/api/tabs/open', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, workspaceId: project.workspaces[0].id, machineId: project.machineId, provider: 'claude', model: claude.models[0].id, title: ${JSON.stringify(title)}, prompt: 'SYNTHETIC QUESTION ' + ${JSON.stringify(title)} }) })
    return await reply.json()
  })()`)
  const first = await openTask('Answered on the desktop')
  assert.ok(first.sessionId, 'tab opened from the phone: ' + JSON.stringify(first))

  // ---------------------------------------------------------------- answered on the desktop
  await tab.go('#/session/' + encodeURIComponent(first.sessionId))
  await until(() => tab.run(cardState), state => state.card && !state.closed, 'the question card on the phone', 30000)
  await tab.run('window.__sameDocument = true; true')
  await tab.shot('1-question-open')
  const asked = pendingOnDesktop(await until(() => desktopSnapshot(first.sessionId), pendingOnDesktop, 'the question on the desktop'))
  await page.evaluate(({ sessionId, item }) => window.conductor.structured.respond({ sessionId, runtimeId: item.runtimeId, requestId: item.data.interaction.id, answers: { [item.data.interaction.questions[0].id]: ['Day'] } }), { sessionId: first.sessionId, item: asked })
  await until(() => tab.run(cardState), state => state.card === false, 'the phone card to leave once the desktop answered')
  assert.equal(await tab.run('window.__sameDocument === true'), true, 'no reload')
  await tab.shot('2-answered-on-desktop')
  check('A question answered on the desktop leaves the phone live, without a reload')

  // ---------------------------------------------------------------- closed while typing on the phone
  const second = await openTask('Closed while typing')
  await tab.go('#/session/' + encodeURIComponent(second.sessionId))
  await until(() => tab.run(cardState), state => state.card && !state.closed, 'the second question card', 30000)
  await tab.run(`(() => {
    document.querySelector('.pending-host .option.option-custom').click()
    const input = document.querySelector('.pending-host input.input')
    input.value = 'Typed on the phone after it closed'
    input.dispatchEvent(new Event('input'))
    return true
  })()`)
  await until(() => desktopSnapshot(second.sessionId), pendingOnDesktop, 'the second question on the desktop')
  await page.evaluate(id => window.conductor.structured.interrupt(id, false), second.sessionId)
  const closed = await until(() => tab.run(cardState), state => state.card && state.closed, 'the phone card to turn closed after Stop on the desktop')
  assert.equal(closed.kind, 'Question closed')
  assert.equal(closed.typed, 'Typed on the phone after it closed', 'typed answer kept')
  assert.ok(closed.send.includes('Send as message') && closed.send.includes('Discard'), JSON.stringify(closed.send))
  await tab.shot('3-closed-with-typed-answer')
  check('A question closed on the desktop while an answer is typed keeps its card, marked closed, with the typed text')

  await tab.run(`Array.from(document.querySelectorAll('.pending-host .pending button')).find(node => node.textContent === 'Send as message').click(); true`)
  await until(() => tab.run('Array.from(document.querySelectorAll(".toast")).map(node => node.textContent).join(" | ")'), text => /Sent as a message/.test(text), 'the sent-as-message toast')
  await until(() => tab.run(cardState), state => state.card === false, 'the closed card to leave once sent')
  const delivered = await until(() => desktopSnapshot(second.sessionId), snapshot => (snapshot?.items ?? []).some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes('Typed on the phone after it closed')), 'the late answer as a user message')
  const message = delivered.items.find(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text.includes('Typed on the phone after it closed'))
  assert.match(message.data.text, /question had closed before the answer was submitted/)
  assert.match(message.data.text, /Which theme should this workspace use\?\nAnswer: Typed on the phone after it closed/)
  assert.equal(await tab.run('window.__sameDocument === true'), true, 'no reload')
  await tab.shot('4-sent-as-message')
  // The fixture acknowledges Conductor's late-answer message and ends the turn.
  await until(() => desktopSnapshot(second.sessionId), snapshot => (snapshot?.items ?? []).some(item => item.sequence > message.sequence && item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('late answer received')), 'the agent to take the late answer as a turn').catch(async error => { await writeFile(join(output, 'late-snapshot-timeout.json'), JSON.stringify(await desktopSnapshot(second.sessionId), null, 1)); throw error })
  check('"Send as message" delivers the late answer to the agent as an ordinary message with a note, and the agent takes it as a turn')
  // Leave nothing running for the quit (the first conversation goes on to ask for an edit).
  const busy = ['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting']
  for (const id of [first.sessionId, second.sessionId]) {
    if (busy.includes((await desktopSnapshot(id))?.phase)) await page.evaluate(id => window.conductor.structured.interrupt(id, false), id)
    await until(() => desktopSnapshot(id), snapshot => !busy.includes(snapshot?.phase), 'every turn to stop')
  }

  assert.deepEqual(errors, [])
  assert.deepEqual(await tab.consoleErrors(), [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  await tab?.close().catch(() => {})
  // An open phone stream keeps the HTTPS listener (and so the quit) waiting; turn phone access off first.
  await page.evaluate(() => window.conductor.phone.setSettings({ enabled: false })).catch(() => {})
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  // A quit that still waits on something must not hold the smoke lock forever.
  const closed = await Promise.race([app.close().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30000))])
  if (!closed) { console.log('app.close timed out; killing the parked app'); app.process().kill(); process.exitCode = 1; setTimeout(() => process.exit(1), 5000).unref() }
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
