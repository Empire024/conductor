// Messages from agents never look like the owner's own (owner, 2026-10-22: "messsages coming in
// from agents must be diffeerentiated completely in the ui from my own messages. absolutely
// completely not liek a queued message"). Parked Electron window, synthetic Claude CLI (no
// inference): a Controller tab opens a Worker coworker through app control; while the owner's slow
// turn runs, the Worker reports (agents.report) and the owner queues a follow-up.
//   L1 above the composer the report is an incoming card (badge, "from Worker"), not "Queued", and
//      the owner's queue holds only the owner's message;
//   L2 once the turn ends both are delivered as separate turns: the report as an incoming card in
//      the timeline (never "You"), the owner's message as "You";
//   L3 the sender's name opens the Worker tab;
//   P1 the phone (WebKit and Chromium, phone viewport) draws the report as a left-hand incoming
//      bubble with its sender header, the owner's messages as the owner's bubbles, a report waiting
//      behind a running turn under "Incoming" rather than "queued", and the sender opens the Worker.
//   node scripts/smoke-lock.mjs --timeout-min 10 -- node scripts/smoke-incoming-agent-messages.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, outputDir, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'incoming-agent-messages', output: '.conductor-scratch/incoming-agent-messages' })
watchdog(540)

const capture = join(tmpdir(), `conductor-incoming-capture-${process.pid}.txt`)
// Turns run one at a time; a prompt containing SLOW takes 15 s, so messages arrive mid-turn.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
let chain = Promise.resolve(), active = false
const held = []
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  // A steer (priority next) mid-turn is acknowledged the way the Claude CLI does and taken in at the
  // end of the turn (no tool use comes first), so it waits visibly above the composer meanwhile.
  if (message.priority === 'next' && active) {
    emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' })
    held.push(message.uuid)
    return
  }
  chain = chain.then(async () => {
    active = true
    if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
    emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
    if (prompt.includes('SLOW')) await new Promise(done => setTimeout(done, 15000))
    for (const uuid of held.splice(0)) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Done: ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
    active = false
  })
})
`

const tabCall = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 800)}`)
  return body.result
}
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  const result = await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { auth: { endpoint, token }, result }
}
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
const https = (origin, path, { token, body, ca } = {}) => new Promise((done, fail) => {
  const url = new URL(path, origin)
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname, method: payload ? 'POST' : 'GET', ca, rejectUnauthorized: Boolean(ca), headers: { host: url.host, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } done({ status: response.statusCode, text, json }) })
  })
  req.once('error', fail)
  req.end(payload)
})

try {
  step('launch and open the project')
  const inst = await launchParked({ fixtures: { 'fake-claude.mjs': FIXTURE }, build, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  await openProject({ name: 'Incoming messages', git: true })
  const view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)

  const controller = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Controller' })
  const controllerId = controller.resourceId
  const pane = view.locator(`.structured-agent-pane[data-structured-session="${controllerId}"]`)
  await pane.waitFor()
  const composer = pane.getByRole('textbox', { name: /^Message / })
  const { auth: controllerAuth } = await credentialAfter(async () => { await composer.fill('Owner hello'); await composer.press('Enter') })
  await settled(controllerId, 'controller first turn')
  const { auth: workerAuth, result: worker } = await credentialAfter(() => tabCall(controllerAuth, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Worker', prompt: 'WORKER start' }))
  const workerId = worker.resourceId ?? worker.agentSessionId
  assert.ok(workerId, 'tabs.open names the worker: ' + JSON.stringify(worker))
  await settled(workerId, 'worker first turn')
  await view.evaluate(id => window.conductor.agentControl.focusOrigin(id), controllerId).catch(() => undefined)
  await view.locator('.tab').filter({ hasText: 'Controller' }).first().click().catch(() => undefined)
  await pane.waitFor({ state: 'visible' })

  // ------------------------------------------------------------------ L1
  step('L1 a report arriving mid-turn is an incoming card, not one of the owner\'s queued messages')
  await composer.fill('SLOW owner turn')
  await composer.press('Enter')
  await poll(async () => await phaseOf(controllerId) === 'running', { timeoutMs: 20_000, label: 'controller running' })
  await tabCall(workerAuth, 'agents.report', { text: 'REPORT from worker: shipped abc123, all tests pass' })
  // The owner's own follow-up waits in the owner's queue (the composer's queue path).
  await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.queue(id, 'owner follow-up', state.settings, []) }, controllerId)
  const incoming = pane.locator('.sa-incoming-list .sa-incoming-pending')
  await incoming.first().waitFor({ timeout: 10_000 })
  assert.equal(await incoming.count(), 1)
  assert.equal(await incoming.getAttribute('data-sender-kind'), 'agent')
  const incomingText = await incoming.innerText()
  assert.match(incomingText, /Agent message/i)
  assert.match(incomingText, /Worker/)
  assert.match(incomingText, /REPORT from worker/)
  assert.doesNotMatch(incomingText, /Queued/)
  const ownQueue = pane.locator('.sa-queue-list[aria-label="Queued messages"]')
  await ownQueue.waitFor({ timeout: 10_000 })
  const ownText = await ownQueue.innerText()
  assert.match(ownText, /Queued 1/)
  assert.match(ownText, /owner follow-up/)
  assert.doesNotMatch(ownText, /REPORT|Queued 2/)
  const colours = await view.evaluate(() => ({ incoming: getComputedStyle(document.querySelector('.sa-incoming-pending')).borderLeftColor, own: getComputedStyle(document.querySelector('.sa-queue')).backgroundColor }))
  record('L1', 'PASS', colours, `incoming card "${incomingText.replace(/\s+/g, ' ').slice(0, 160)}" apart from the owner queue "${ownText.replace(/\s+/g, ' ')}"; ${await shot('l1-incoming-mid-turn')}`)

  // ------------------------------------------------------------------ L2
  step('L2 delivered as separate turns: the report is an incoming card in the timeline, the owner is "You"')
  await poll(async () => {
    const texts = (await view.evaluate(id => window.conductor.structured.snapshot(id), controllerId)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => [item.data.text, item.data.origin?.label ?? null])
    return texts.some(([text]) => text === 'owner follow-up') && texts.some(([text, label]) => text.includes('REPORT from worker') && label) ? texts : null
  }, { timeoutMs: 60_000, label: 'both delivered' })
  await settled(controllerId, 'controller after deliveries')
  const users = (await view.evaluate(id => window.conductor.structured.snapshot(id), controllerId)).items.filter(item => item.data.type === 'text' && item.data.role === 'user')
  const fused = users.find(item => item.data.text.includes('owner follow-up') && item.data.text.includes('REPORT'))
  assert.equal(fused, undefined, 'the owner message and the report were fused into one turn')
  const card = pane.locator('article.sa-incoming.sa-incoming-agent').filter({ hasText: 'REPORT from worker' })
  await card.first().waitFor({ timeout: 10_000 })
  const cardText = await card.first().innerText()
  assert.match(cardText, /Agent message/i)
  assert.match(cardText, /Worker/)
  assert.doesNotMatch(cardText, /^You\b/m)
  const own = pane.locator('article.sa-user').filter({ hasText: 'owner follow-up' })
  await own.first().waitFor({ timeout: 10_000 })
  assert.match(await own.first().innerText(), /You/)
  assert.equal(await pane.locator('article.sa-user').filter({ hasText: 'REPORT from worker' }).count(), 0, 'no report drawn as the owner')
  await card.first().scrollIntoViewIfNeeded()
  record('L2', 'PASS', { userTurns: users.length }, `report card "${cardText.replace(/\s+/g, ' ').slice(0, 160)}"; ${await shot('l2-timeline')}`)

  // ------------------------------------------------------------------ L3
  step('L3 the sender name opens the Worker tab')
  await card.first().locator('button.sa-conversation-link').first().click()
  await view.locator(`.structured-agent-pane[data-structured-session="${workerId}"]`).waitFor({ state: 'visible', timeout: 10_000 })
  record('L3', 'PASS', {}, `Worker pane visible after the click; ${await shot('l3-opened-worker')}`)

  // ------------------------------------------------------------------ P1
  step('P1 the phone draws the report apart from the owner\'s messages')
  const desktop = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = (await https(origin, '/ca.crt')).text
  const pairing = await view.evaluate(() => window.conductor.phone.pair())
  const paired = await https(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Incoming phone' } })
  assert.equal(paired.status, 200, paired.text)
  const token = paired.json.token
  // Per engine, a second report waits behind another slow owner turn, for the phone's queue.
  const { chromium, webkit } = await import('@playwright/test')
  const engines = { chromium, webkit }
  const phoneNotes = []
  for (const engine of ['webkit', 'chromium']) {
    await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SLOW second owner turn', state.settings, []) }, controllerId)
    await poll(async () => await phaseOf(controllerId) === 'running', { timeoutMs: 20_000, label: 'controller running again' })
    await tabCall(workerAuth, 'agents.report', { text: `SECOND REPORT ${engine}: waiting behind the turn` })
    const browser = await engines[engine].launch({ headless: true, ...playwrightBuild(engines, engine) })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === 'chromium', serviceWorkers: 'block' })
      await context.addInitScript(value => { window.localStorage.setItem('conductor.phone.token', value) }, token)
      const phone = await context.newPage()
      const problems = []
      phone.on('pageerror', error => problems.push(error.message))
      await phone.goto(origin + '/#/session/' + encodeURIComponent(controllerId))
      const bubble = phone.locator('.bubble.incoming.incoming-agent').filter({ hasText: 'REPORT from worker' })
      await bubble.first().waitFor({ timeout: 20_000 })
      const head = await bubble.first().locator('.sender-head').innerText()
      assert.match(head, /Agent message/i)
      assert.match(head, /Worker/)
      assert.equal(await phone.locator('.bubble.user').filter({ hasText: 'REPORT from worker' }).count(), 0)
      await phone.locator('.bubble.user').filter({ hasText: 'owner follow-up' }).first().waitFor()
      const sides = await phone.evaluate(() => ({ incoming: getComputedStyle(document.querySelector('.bubble.incoming')).alignSelf, own: getComputedStyle(document.querySelector('.bubble.user')).alignSelf }))
      assert.deepEqual(sides, { incoming: 'flex-start', own: 'flex-end' })
      const waiting = phone.locator('.incoming-queue .incoming-queued').filter({ hasText: `SECOND REPORT ${engine}` })
      await waiting.first().waitFor({ timeout: 15_000 })
      assert.match(await phone.locator('.incoming-queue').innerText(), /Incoming/)
      assert.doesNotMatch(await phone.locator('.queued-host').innerText(), /message(s)? queued/)
      await bubble.first().scrollIntoViewIfNeeded()
      const shotPath = join(outputDir(), `p1-${engine}-phone.png`)
      await phone.screenshot({ path: shotPath })
      phoneNotes.push(shotPath)
      const link = bubble.first().locator('button.sender-link')
      if (await link.count()) {
        await link.click()
        await phone.waitForFunction(id => decodeURIComponent(location.hash).includes(id), workerId, { timeout: 10_000 })
        phoneNotes.push(engine + ': sender link opened #/session/' + workerId)
      } else phoneNotes.push(engine + ': Worker not in the phone session list, name shown as text')
      assert.deepEqual(problems, [], engine + ' page errors')
    } finally { await browser.close() }
    await settled(controllerId, 'controller after the phone check')
  }
  record('P1', 'PASS', {}, phoneNotes.join('; '))
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
