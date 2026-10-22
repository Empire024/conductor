// Phone navigation across projects (docs/phone-navigation.md; owner, 2026-10-22: "the tab I just
// sent messages should be prioritized ... I open it up and I'm just lost when I have 2-3 projects
// at once"). Parked Electron window, synthetic Claude CLI (no inference), three projects:
//   Conductor   a wizard (running) with a running and a finished coworker
//   Miron rosin a wizard (idle) with a running coworker, and Notes, where the owner writes last
//   Haftheme    a coordinator (not a wizard) whose coworker waits on an approval card
// Then the phone (WebKit and Chromium, phone viewport):
//   N1 Tabs: Now on top lists Notes first ("Last sent"), then the approval, then running work, each
//      with its project; project heads carry their status line; each wizard is marked and first;
//   N2 Home: Now first, project cards with their status line;
//   N3 a cold launch on #/ lands on Notes, and Back is the overview.
//   node scripts/smoke-lock.mjs --timeout-min 10 -- node scripts/smoke-phone-navigation.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, configure, failed, finish, launchParked, openProject, openTab, outputDir, page, poll, record, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'phone-navigation', output: '.conductor-scratch/phone-navigation' })
watchdog(540)

const capture = join(tmpdir(), `conductor-phone-nav-capture-${process.pid}.txt`)
// HOLD keeps a turn running for the whole check; ASK waits on a Bash approval; anything else is short.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
let chain = Promise.resolve()
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
  chain = chain.then(async () => {
    if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
    emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' })
    if (prompt.includes('ASK')) {
      const tool = 'toolu_nav_' + process.pid
      emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'npm publish' } }] } })
      send({ type: 'control_request', request_id: 'ask-' + process.pid, request: { subtype: 'can_use_tool', tool_use_id: tool, tool_name: 'Bash', input: { command: 'npm publish' }, permission_suggestions: [] } })
      await new Promise(() => {})
    }
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Working on: ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
    if (prompt.includes('HOLD')) await new Promise(done => setTimeout(done, 240000))
    emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
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
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}
// From the window: a coworker's tab answers agents.status only to its controller.
let viewForPhase = null
const phaseOf = async id => (await viewForPhase.evaluate(id => window.conductor.structured.snapshot(id), id))?.phase
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
  step('launch')
  const inst = await launchParked({ fixtures: { 'fake-claude.mjs': FIXTURE }, build, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  let view = null
  const ids = {}
  const submit = (id, text) => view.evaluate(async ([id, text]) => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, text, state.settings, []) }, [id, text])
  const lead = async (key, title, wizard, prompt) => {
    const tab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title })
    ids[key] = tab.resourceId
    if (wizard) await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'claude-fable-5-1' }) }, tab.resourceId)
    return credentialAfter(() => submit(tab.resourceId, prompt))
  }
  const coworker = async (auth, key, title, prompt) => {
    const tab = await tabCall(auth, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title, prompt })
    ids[key] = tab.resourceId ?? tab.agentSessionId
    assert.ok(ids[key], 'tabs.open names the coworker: ' + JSON.stringify(tab))
  }

  await openProject({ name: 'Conductor', git: true })
  view = await page(inst)
  viewForPhase = view
  assert.equal(await view.evaluate(() => window.conductor.settings.setFinishedTabSweep(0)), 0)
  assert.equal(await view.evaluate(() => window.conductor.settings.setCoworkerAutoClose(0)), 0)
  const wizardA = await lead('wizardA', 'Wizard: Conductor', true, 'HOLD plan the batch')
  await coworker(wizardA, 'a1', 'Fix sticky bar', 'HOLD fix it')
  await coworker(wizardA, 'a2', 'Review phone list', 'quick review')

  await openProject({ name: 'Miron rosin', git: true })
  const wizardB = await lead('wizardB', 'Wizard: Miron', true, 'set up the watch')
  await coworker(wizardB, 'b1', 'Scrape prices', 'HOLD scrape')
  ids.notes = (await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Notes' })).resourceId

  await openProject({ name: 'Haftheme', git: true })
  const coordC = await lead('coordC', 'Haftheme coordinator', false, 'split the theme work')
  await coworker(coordC, 'c1', 'Publish theme', 'ASK publish it')
  await poll(async () => await phaseOf(ids.c1) === 'waiting_approval', { timeoutMs: 30_000, label: 'Publish theme waits on its approval' })

  // The owner writes last in Miron rosin's Notes tab, a project that is not the wizard's.
  step('the owner writes in Notes')
  await submit(ids.notes, 'remember to check the rosin price')
  await poll(async () => await phaseOf(ids.notes) === 'completed', { timeoutMs: 30_000, label: 'Notes completed' })
  for (const key of ['wizardA', 'a1', 'b1']) assert.equal(await phaseOf(ids[key]), 'running', key + ' is running')

  step('pair a phone')
  const desktop = await view.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = (await https(origin, '/ca.crt')).text
  const pairing = await view.evaluate(() => window.conductor.phone.pair())
  const paired = await https(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Navigation phone' } })
  assert.equal(paired.status, 200, paired.text)
  const token = paired.json.token
  const state = (await https(origin, '/api/state', { ca, token })).json
  const byId = Object.fromEntries((state?.sessions ?? []).map(session => [session.id, session]))
  assert.ok(byId[ids.notes]?.lastOwnerMessageAt, 'Notes has lastOwnerMessageAt: ' + JSON.stringify(byId[ids.notes] ?? state).slice(0, 400))
  assert.equal(byId[ids.wizardA]?.wizard, true)
  assert.equal(byId[ids.coordC]?.wizard, undefined)
  assert.equal(byId[ids.c1]?.lastOwnerMessageAt, undefined, 'a coworker prompt is not the owner writing')

  const { chromium, webkit } = await import('@playwright/test')
  const engines = { chromium, webkit }
  const shots = []
  for (const engine of ['webkit', 'chromium']) {
    const browser = await engines[engine].launch({ headless: true, ...playwrightBuild(engines, engine) })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === 'chromium', serviceWorkers: 'block' })
      await context.addInitScript(value => { window.localStorage.setItem('conductor.phone.token', value) }, token)
      const phone = await context.newPage()
      const problems = []
      phone.on('pageerror', error => problems.push(error.message))

      // ------------------------------------------------------------------ N1
      step(`N1 ${engine}: Tabs has Now across projects above the project groups`)
      await phone.goto(origin + '/#/tabs')
      const now = phone.locator('.now-group .session')
      await now.first().waitFor({ timeout: 20_000 })
      await poll(async () => await now.count() >= 4 ? true : null, { timeoutMs: 15_000, label: 'Now rows' })
      const nowIds = await now.evaluateAll(nodes => nodes.map(node => node.dataset.sessionId))
      assert.equal(nowIds[0], ids.notes, 'Notes first: ' + JSON.stringify(nowIds))
      assert.match(await now.first().innerText(), /Last sent/)
      assert.match(await now.first().innerText(), /Miron rosin/)
      assert.equal(nowIds[1], ids.c1, 'the approval second: ' + JSON.stringify(nowIds))
      assert.ok(nowIds.includes(ids.wizardA) && nowIds.includes(ids.wizardB), 'both wizards in Now (wizardB through its running coworker): ' + JSON.stringify(nowIds))
      assert.ok(!nowIds.includes(ids.a1) && !nowIds.includes(ids.b1), 'running coworkers are carried by their controller')
      assert.match(await phone.locator(`.now-group .session[data-session-id="${ids.wizardA}"]`).innerText(), /Wizard[\s\S]*1 coworker working/)
      const heads = await phone.locator('.project-head').allInnerTexts()
      assert.equal(heads.length, 3, JSON.stringify(heads))
      // In the computer's project order, whatever it is; each head says what its project does.
      const head = name => heads.find(text => text.startsWith(name)) ?? ''
      assert.match(head('Conductor'), /Wizard running · 2 running/)
      assert.match(head('Miron rosin'), /Wizard (done|waiting)[\s\S]*1 running/)
      assert.match(head('Haftheme'), /Coordinator[\s\S]*1 need you/)
      const firstInGroup = await phone.locator('.group[data-project-id]').evaluateAll(groups => groups.map(group => group.querySelector('.session')?.dataset.sessionId))
      assert.deepEqual([...firstInGroup].sort(), [ids.wizardA, ids.wizardB, ids.coordC].sort())
      const tabsShot = join(outputDir(), `n1-${engine}-tabs.png`)
      await phone.screenshot({ path: tabsShot })
      await phone.locator('.group[data-project-id]').first().scrollIntoViewIfNeeded()
      const groupsShot = join(outputDir(), `n1-${engine}-groups.png`)
      await phone.screenshot({ path: groupsShot })
      shots.push(tabsShot, groupsShot)
      record(`N1-${engine}`, 'PASS', { now: nowIds.length }, `Now ${nowIds.map(id => Object.keys(ids).find(key => ids[key] === id)).join(', ')}; heads ${heads.map(text => text.replace(/\s+/g, ' ')).join(' | ')}`)

      // ------------------------------------------------------------------ N2
      step(`N2 ${engine}: Home leads with Now and project status lines`)
      await phone.goto(origin + '/#/')
      await phone.locator('.home-now .session').first().waitFor({ timeout: 20_000 })
      assert.match(await phone.locator('.home-now .session').first().innerText(), /Notes[\s\S]*Last sent/)
      const cards = await phone.locator('.project-card').allInnerTexts()
      assert.match(cards.join(' | '), /Wizard running/)
      const homeShot = join(outputDir(), `n2-${engine}-home.png`)
      await phone.screenshot({ path: homeShot })
      shots.push(homeShot)
      record(`N2-${engine}`, 'PASS', {}, cards.map(text => text.replace(/\s+/g, ' ')).join(' | '))

      // ------------------------------------------------------------------ N3
      step(`N3 ${engine}: a cold launch lands on the tab last used, Back is the overview`)
      const fresh = await context.newPage()
      fresh.on('pageerror', error => problems.push(error.message))
      await fresh.goto(origin + '/')
      await fresh.waitForFunction(id => decodeURIComponent(location.hash) === '#/session/' + id, ids.notes, { timeout: 15_000 })
      await fresh.locator('.bubble').filter({ hasText: 'remember to check the rosin price' }).first().waitFor({ timeout: 15_000 })
      await fresh.goBack()
      await fresh.waitForFunction(() => location.hash === '#/' || location.hash === '', null, { timeout: 10_000 })
      await fresh.locator('.home-now').waitFor({ timeout: 10_000 })
      // A reload keeps the page it is on.
      await fresh.goto(origin + '/#/tabs')
      await fresh.reload()
      await fresh.locator('.now-group').waitFor({ timeout: 15_000 })
      assert.equal(await fresh.evaluate(() => location.hash), '#/tabs')
      record(`N3-${engine}`, 'PASS', {}, 'landed on #/session/<Notes>; Back to Home; reload stays on #/tabs')
      assert.deepEqual(problems, [], engine + ' page errors')
    } finally { await browser.close() }
  }
  record('shots', 'INFO', {}, shots.join('; '))
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
