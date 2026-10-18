import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The phone's Tabs list with two busy projects, as the phone meets it: the real Electron app serves
// index.html, app.js and app.css over its HTTPS listener and a parked, phone-sized BrowserWindow
// pairs. Then the page's /api/stream and /api/state are stand-ins: a stream the smoke writes
// 'state' frames into (two projects, running tabs, coworkers, the most recent activity flipping
// between the projects on every frame) and a state read that answers with an older picture.
// The list must keep both projects, the same card order and the same card elements throughout.
// Run after `npm.cmd run build`, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-phone-tabs-order.mjs
// Screenshots and report.json go to .conductor-scratch/phone-redesign/tabs-order/.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-tabs-'))
const output = resolve('.conductor-scratch/phone-redesign/tabs-order')
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
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/* Parked left of every display, shown without activation, out of the taskbar (as smoke-phone-shell). */
const openPhone = partition => app.evaluate(({ BrowserWindow, session, screen }, { partition }) => {
  const phoneSession = session.fromPartition(partition)
  phoneSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3))
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, frame: false, skipTaskbar: true, focusable: false, x: area.x - 6000, y: area.y, webPreferences: { partition, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  globalThis.__phoneTabsConsole ??= {}
  const log = globalThis.__phoneTabsConsole[win.id] = []
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
  consoleErrors: () => app.evaluate((_electron, id) => (globalThis.__phoneTabsConsole?.[id] ?? []).slice(), id),
  close: () => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy() }, id)
})

/* Installed in the page after pairing. window.__push(revision, options) writes one 'state' frame;
   /api/state answers window.__stateAnswer (an older revision) after window.__stateDelay ms. */
const STAND_INS = `(() => {
  const projects = [
    { id: 'p-conductor', name: 'conductor', machineId: 'local', workspaces: [{ id: 'w-c1', name: 'Workspace 1' }] },
    { id: 'p-miron', name: 'miron rosin', machineId: 'local', workspaces: [{ id: 'w-m1', name: 'Workspace 1' }] }
  ]
  const base = Date.now() - 3600000
  const tab = (id, projectId, extra) => {
    const project = projects.find(entry => entry.id === projectId)
    return Object.assign({ id: id, title: 'Tab ' + id, projectId: projectId, projectName: project.name, workspaceId: project.workspaces[0].id, workspaceName: 'Workspace 1', tabId: 'tab-' + id, provider: 'claude', model: 'opus', machineId: 'local', machineName: 'MAIN', state: 'working', phase: 'running', updatedAt: new Date(base).toISOString(), turnStartedAt: new Date(base).toISOString(), lastText: 'started', lastRole: 'assistant' }, extra || {})
  }
  const rows = () => [
    tab('wizard', 'p-conductor', { title: 'Wizard: Conductor + miron rosin watch', backgroundTasks: 2 }),
    tab('cw-1', 'p-conductor', { controllerId: 'wizard', title: 'Phone push spam' }),
    tab('cw-2', 'p-conductor', { controllerId: 'wizard', title: 'Phone stale question card' }),
    tab('cw-3', 'p-conductor', { controllerId: 'wizard', title: 'Phone tabs list jumps' }),
    tab('old-wizard', 'p-conductor', { title: 'Wizard: handed off', state: 'done', phase: 'idle' }),
    tab('miron-a', 'p-miron', { title: 'Rosin: watch prices' }),
    tab('miron-b', 'p-miron', { title: 'Rosin: answer mail' }),
    tab('miron-c', 'p-miron', { title: 'Rosin: done earlier', state: 'done', phase: 'idle' })
  ]
  window.__snapshot = (revision, options) => {
    options = options || {}
    const sessions = rows().map((row, index) => {
      // The most recent activity flips between the two projects on every frame.
      const busy = row.state === 'working' && ((row.projectId === 'p-miron') === (revision % 2 === 0) || index % 3 === revision % 3)
      const next = busy ? Object.assign({}, row, { updatedAt: new Date(base + revision * 60000).toISOString(), lastText: 'step ' + revision + ' of ' + row.id }) : row
      return options.attention === row.id ? Object.assign({}, next, { state: 'attention', phase: 'waiting_approval', needs: 'approval', pendingTitle: 'Approve a command?' }) : next
    })
    return { observedAt: new Date().toISOString(), instance: options.instance || 'smoke-run', revision: revision, machineName: 'MAIN', projects: projects, machines: [{ id: 'local', name: 'MAIN', kind: 'local', status: 'online', projectIds: ['p-conductor', 'p-miron'] }], providers: [], sessions: sessions, usage: [], projectTaskMaxLength: 200000, counts: { attention: sessions.filter(row => row.state === 'attention').length, working: sessions.filter(row => row.state === 'working').length } }
  }
  const encoder = new TextEncoder()
  window.__streams = 0
  window.__stateReads = 0
  window.__stateDelay = 0
  window.__stateAnswer = null
  let writer = null
  window.__push = (revision, options) => { if (writer) writer.enqueue(encoder.encode('event: state\\ndata: ' + JSON.stringify(window.__snapshot(revision, options)) + '\\n\\n')) }
  const real = window.fetch.bind(window)
  window.fetch = async (path, init) => {
    const url = String(path)
    if (url === '/api/stream') {
      window.__streams += 1
      let own = null
      const body = new ReadableStream({ start: controller => { own = controller; writer = controller } })
      // An aborted read ends its stream the way a closed connection does; the page's reader holds the lock.
      if (init && init.signal) init.signal.addEventListener('abort', () => { try { own.error(new DOMException('Aborted', 'AbortError')) } catch (error) {} if (writer === own) writer = null })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url === '/api/state' && window.__stateAnswer) {
      window.__stateReads += 1
      const answer = window.__stateAnswer
      await new Promise(resolve => setTimeout(resolve, window.__stateDelay))
      window.__staleAnswered = (window.__staleAnswered || 0) + 1
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return real(path, init)
  }
  return true
})()`

/* What the list shows: card ids in order, project groups, whether each card is the element first seen. */
const READ_LIST = `(() => {
  const cards = Array.from(document.querySelectorAll('.screen .session'))
  const groups = Array.from(document.querySelectorAll('.screen .group[data-project-id]'))
  return {
    order: cards.map(node => node.dataset.sessionId),
    marked: cards.map(node => node.__smokeMark === node.dataset.sessionId),
    groups: groups.map(node => ({ id: node.dataset.projectId, title: (node.querySelector('.group-title') || {}).textContent, height: node.offsetHeight })),
    text: cards.map(node => node.textContent).join(' | '),
    attention: (document.querySelector('.count.tone-attention') || {}).textContent
  }
})()`

const phoneWindows = []
const report = { checks, errors, frames: [] }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  let desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`

  const opened = await openPhone('phone-tabs')
  phoneWindows.push(opened.id)
  const tab = phone(opened.id)
  desktop = await page.evaluate(() => window.conductor.phone.pair())
  await tab.load(origin + '/#pair=' + desktop.pairing.code)
  await until(() => tab.run('Boolean(document.querySelector(".code-input") && document.querySelector(".code-input").value)'), Boolean, 'the code filled in')
  await tab.run('document.querySelector("form.pair-form").requestSubmit()')
  await until(() => tab.run('Boolean(document.querySelector(".home-hero") && document.querySelector(".connection-banner")?.hidden)'), Boolean, 'the connected Home screen')
  await tab.go('#/tabs')
  await until(() => tab.run('Boolean(document.querySelector(".chips"))'), Boolean, 'the Tabs screen')

  // The stand-ins take over the stream; a refresh (as when the phone comes back to the screen)
  // reconnects to them, while the state read answers late with an older picture.
  await tab.run(STAND_INS)
  await tab.run(`window.__stateAnswer = window.__snapshot(1); window.__stateDelay = 1500; true`)
  await tab.run(`document.dispatchEvent(new Event('visibilitychange')); true`)
  await until(() => tab.run('window.__streams'), value => value >= 1, 'the stand-in stream')
  await tab.run(`window.__push(2); true`)
  await until(() => tab.run('document.querySelectorAll(".screen .session").length'), value => value >= 5, 'the two projects')
  await tab.run(`(() => { const all = Array.from(document.querySelectorAll('.chip')).find(node => node.textContent === 'All'); if (all && all.getAttribute('aria-pressed') !== 'true') all.click(); return true })()`)
  await tab.run(`document.querySelector('.coworker-toggle').click(); true`)
  await until(() => tab.run('document.querySelectorAll(".screen .session").length'), value => value === 8, 'the expanded coworkers')
  await tab.run(`document.querySelectorAll('.screen .session').forEach(node => { node.__smokeMark = node.dataset.sessionId }); true`)
  const first = await tab.run(READ_LIST)
  report.first = first
  assert.deepEqual(first.order, ['wizard', 'cw-1', 'cw-2', 'cw-3', 'old-wizard', 'miron-a', 'miron-b', 'miron-c'])
  assert.deepEqual(first.groups.map(group => group.id), ['p-conductor', 'p-miron'])
  await tab.shot('tabs-first')

  for (let revision = 3; revision <= 22; revision++) {
    await tab.run(`window.__push(${revision}); true`)
    const seen = await until(() => tab.run(READ_LIST), value => value && value.text.includes('step ' + revision + ' of '), 'frame ' + revision)
    report.frames.push({ revision, order: seen.order, groups: seen.groups.map(group => group.id) })
    assert.deepEqual(seen.order, first.order, 'card order after frame ' + revision)
    assert.ok(seen.marked.every(Boolean), 'every card is the element first drawn, after frame ' + revision)
    assert.deepEqual(seen.groups.map(group => group.id), ['p-conductor', 'p-miron'], 'both projects after frame ' + revision)
    assert.ok(seen.groups.every(group => group.height > 0), 'both projects are laid out after frame ' + revision)
  }
  await tab.shot('tabs-after-20-frames')
  check('20 stream frames with the latest activity flipping between two projects keep both projects, the same card order and the same card elements')

  // The late state read (revision 1) lands after all of that and changes nothing.
  await until(() => tab.run('window.__staleAnswered || 0'), value => value >= 1, 'the late state read')
  await new Promise(resolve => setTimeout(resolve, 300))
  let after = await tab.run(READ_LIST)
  assert.ok(after.text.includes('step 22 of '), 'the newest frame stays on screen')
  assert.deepEqual(after.order, first.order)

  // A refresh whose stream says nothing new and whose state read is older is dropped too.
  await tab.run(`window.__stateAnswer = window.__snapshot(4); window.__stateDelay = 0; window.__staleAnswered = 0; true`)
  await tab.run(`document.dispatchEvent(new Event('visibilitychange')); true`)
  await until(() => tab.run('window.__staleAnswered || 0'), value => value >= 1, 'the second stale state read')
  await new Promise(resolve => setTimeout(resolve, 300))
  after = await tab.run(READ_LIST)
  assert.ok(after.text.includes('step 22 of '), 'an older /api/state answer is not shown')
  assert.ok(after.marked.every(Boolean))
  check('An /api/state answer older than the stream picture is dropped, during the frames and on its own')

  // A tab that needs the owner is surfaced by the filter, not by moving it in All.
  await until(() => tab.run('window.__streams'), value => value >= 2, 'the reconnected stand-in stream')
  await tab.run(`window.__push(23, { attention: 'miron-b' }); true`)
  const asked = await until(() => tab.run(READ_LIST), value => value && value.attention === '1 need you', 'the attention frame')
  assert.deepEqual(asked.order, first.order, 'All keeps its order when a tab needs the owner')
  assert.ok(asked.marked.every(Boolean))
  await tab.run(`Array.from(document.querySelectorAll('.chip')).find(node => node.textContent === 'Needs attention').click(); true`)
  const filtered = await until(() => tab.run(READ_LIST), value => value && value.order.length === 1, 'the Needs attention filter')
  assert.deepEqual(filtered.order, ['miron-b'])
  await tab.shot('tabs-needs-attention')
  await tab.run(`Array.from(document.querySelectorAll('.chip')).find(node => node.textContent === 'All').click(); true`)
  check('A tab that needs the owner keeps its place in All and is listed alone under Needs attention')

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
