// An owner's message steered into a running turn ends as a normal delivered message (owner,
// 2026-10-22: "the last message I sent I see still here in chat as last message as steered").
// Parked Electron window, synthetic Claude CLI (no inference) that acknowledges a steer the way the
// Claude CLI does (command_lifecycle queued) and takes it in at the end of the turn (started).
//   D1 desktop: the owner steers mid-turn from the composer (Ctrl+Enter); the steer waits above the
//      composer as "Received"; once the turn ends no steering row is left and the message is an
//      ordinary "You" message in the timeline;
//   P1 phone (Chromium, phone viewport): the owner steers mid-turn from the phone; the bubble reads
//      "Steered" while the turn runs, and once the turn ends it is the timeline's own message marked
//      "Delivered", drawn once, with no optimistic "Steered" bubble left at the bottom.
//   node scripts/smoke-lock.mjs --timeout-min 10 -- node scripts/smoke-owner-steer-delivered.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, outputDir, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'owner-steer-delivered', output: '.conductor-scratch/owner-steer-delivered' })
watchdog(420)

// Turns run one at a time; a prompt containing SLOW takes 12 s, so the owner steers mid-turn.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
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
  if (message.priority === 'next' && active) {
    emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' })
    held.push(message.uuid)
    return
  }
  chain = chain.then(async () => {
    active = true
    emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
    if (prompt.includes('SLOW')) await new Promise(done => setTimeout(done, 12000))
    for (const uuid of held.splice(0)) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Done: ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
    active = false
  })
})
`

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
  const inst = await launchParked({ fixtures: { 'fake-claude.mjs': FIXTURE }, build })
  await openProject({ name: 'Owner steer', git: true })
  const view = await page(inst)
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  const tab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Owner steer' })
  const id = tab.resourceId
  const pane = view.locator(`.structured-agent-pane[data-structured-session="${id}"]`)
  await pane.waitFor()
  const composer = pane.getByRole('textbox', { name: /^Message / })
  await composer.fill('Owner hello')
  await composer.press('Enter')
  await settled(id, 'first turn')

  // ------------------------------------------------------------------ D1
  step('D1 desktop: a steer the turn took is an ordinary "You" message once the turn ends')
  await composer.fill('SLOW owner turn')
  await composer.press('Enter')
  await poll(async () => await phaseOf(id) === 'running', { timeoutMs: 20_000, label: 'running' })
  await poll(async () => (await view.evaluate(sid => window.conductor.structured.snapshot(sid), id)).capabilities?.steering === true, { timeoutMs: 10_000, label: 'steering capability' })
  await composer.fill('DESKTOP steer words')
  await composer.press('Control+Enter')
  const steeringRow = pane.locator('.sa-steering-prompt').filter({ hasText: 'DESKTOP steer words' })
  await steeringRow.first().waitFor({ timeout: 10_000 })
  const midTurn = (await steeringRow.first().innerText()).replace(/\s+/g, ' ')
  assert.match(midTurn, /Received|Sending/)
  const midShot = await shot('d1-mid-turn')
  await settled(id, 'steered turn')
  await poll(async () => await pane.locator('.sa-steering-prompt').count() === 0, { timeoutMs: 10_000, label: 'steering row cleared' })
  const own = pane.locator('article.sa-user').filter({ hasText: 'DESKTOP steer words' })
  await own.first().waitFor({ timeout: 10_000 })
  assert.equal(await own.count(), 1)
  assert.match(await own.first().innerText(), /You/)
  const desktopState = await view.evaluate(sid => window.conductor.structured.snapshot(sid), id)
  assert.deepEqual(desktopState.pendingSteering ?? [], [])
  record('D1', 'PASS', {}, `mid-turn "${midTurn.slice(0, 120)}" (${midShot}); after the turn no steering row, one "You" message; ${await shot('d1-after-turn')}`)

  // ------------------------------------------------------------------ P1
  step('P1 phone: a steer from the phone ends as the delivered timeline message, drawn once')
  const desktop = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = (await https(origin, '/ca.crt')).text
  const pairing = await view.evaluate(() => window.conductor.phone.pair())
  const paired = await https(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Steer phone' } })
  assert.equal(paired.status, 200, paired.text)
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true, ...playwrightBuild({ chromium }, 'chromium') })
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    await context.addInitScript(value => { window.localStorage.setItem('conductor.phone.token', value) }, paired.json.token)
    const phone = await context.newPage()
    const problems = []
    phone.on('pageerror', error => problems.push(error.message))
    await phone.goto(origin + '/#/session/' + encodeURIComponent(id))
    await phone.locator('.bubble.user').filter({ hasText: 'DESKTOP steer words' }).first().waitFor({ timeout: 20_000 })
    await view.evaluate(async sid => { const state = await window.conductor.structured.snapshot(sid); await window.conductor.structured.submit(sid, 'SLOW second owner turn', state.settings, []) }, id)
    await poll(async () => await phaseOf(id) === 'running', { timeoutMs: 20_000, label: 'running again' })
    await phone.locator('.composer-send', { hasText: 'Steer' }).waitFor({ timeout: 15_000 })
    await phone.locator('.composer-input').fill('PHONE steer words')
    await phone.locator('.composer-send').click()
    const bubbles = phone.locator('.bubble.user').filter({ hasText: 'PHONE steer words' })
    await bubbles.locator('.message-status.steered').first().waitFor({ timeout: 15_000 })
    const phoneMid = join(outputDir(), 'p1-phone-mid-turn.png')
    await phone.screenshot({ path: phoneMid })
    await settled(id, 'phone-steered turn')
    await poll(async () => await phone.locator('.optimistic-message').count() === 0 && await bubbles.count() === 1 && await bubbles.locator('.message-status.delivered').count() === 1 ? true : null, { timeoutMs: 20_000, label: 'phone steer drawn once as Delivered' })
    assert.equal(await phone.locator('.message-status.steered').count(), 0, 'a "Steered" label is left after the turn ended')
    const state = await view.evaluate(sid => window.conductor.structured.snapshot(sid), id)
    const delivered = state.items.filter(item => item.data.type === 'text' && item.data.role === 'user' && item.data.text === 'PHONE steer words')
    assert.equal(delivered.length, 1, 'the steer is one user message in the timeline')
    const last = await phone.locator('.bubble.user').last().innerText()
    assert.match(last, /PHONE steer words/)
    assert.match(last, /Delivered/)
    const phoneAfter = join(outputDir(), 'p1-phone-after-turn.png')
    await phone.screenshot({ path: phoneAfter })
    assert.deepEqual(problems, [], 'phone page errors')
    record('P1', 'PASS', {}, `Steered mid-turn (${phoneMid}); after the turn one bubble "${last.replace(/\s+/g, ' ').slice(0, 80)}", no optimistic bubble (${phoneAfter})`)
  } finally { await browser.close() }
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
