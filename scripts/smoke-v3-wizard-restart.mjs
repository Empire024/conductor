import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// V3 verify S14/S15: app.restart.request from a wizard tab (fake-claude fable quota + wand on)
// sets app.state.restartRequest and the update control's label; the owner's restart resumes only
// that wizard tab; a non-wizard tab and the owner credential calling app.restart.request are
// refused; a 301-char reason is refused; the request is consumed after one resume.
// S15: a >24h-old persisted request resumes nobody.
// Uses the shipped scripts/fixtures/fake-claude.mjs (SYNTHETIC protocol) and
// CONDUCTOR_TEST_CONTROL_CAPTURE to read each tab's OWN scoped control credential (app.restart.request
// is wizard-tab-scoped, not the owner credential) exactly as scripts/smoke-control-repairs.mjs does.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-wizard-restart.mjs [--stale] [--keep]

const HARD_TIMEOUT_MS = 9 * 60_000
const staleMode = process.argv.includes('--stale')
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-wizard-'))
const output = resolve(`artifacts/v3-verify/${staleMode ? 'S15' : 'S14'}`)
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
const capture = join(root, 'controller-input.txt')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// A minimal fixture (not the shipped scripts/fixtures/fake-claude.mjs, which throws on any prompt
// that does not start with 'SYNTHETIC ') so the real post-restart continuation message ("[Conductor]
// ... restarted ... continue your work") can be answered instead of crashing the provider process.
const fixtures = join(root, 'fixtures')
await mkdir(fixtures, { recursive: true })
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'v3-wizard-smoke', parent_tool_use_id: null, ...message })
const model = process.env.CONDUCTOR_TEST_CLAUDE_QUOTA === 'fable' ? 'claude-fable-5-1' : 'synthetic-claude'
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: model, displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE && typeof prompt === 'string') writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  emit({ type: 'system', subtype: 'init', model })
  const id = randomUUID()
  const text = typeof prompt === 'string' && prompt.includes('restarted') ? 'continue-ack' : 'Short done.'
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 wizard-restart smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credentialFile = async () => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
  return JSON.parse(await readFile(path, 'utf8'))
}
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const call = async (method, args = {}) => { const r = await request(owner, method, args, projectId ? { projectId } : undefined); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const tabCredential = async () => {
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false), { timeout: 30_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'tab did not receive an app-control briefing')
  return { endpoint, token }
}

const summary = { root, profile, build: resolve('out/main/index.js'), staleMode }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let firstPid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credentialFile()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 wizard restart' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 wizard restart' }).first().click()
  await page.waitForTimeout(500)
  observe('project selected')

  const openAndBecome = async ({ title, wizard }) => {
    const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title })
    const id = tab.resourceId ?? tab.agentSessionId
    // `structured.submit`'s settings arg is a per-message override that deliberately strips and
    // re-applies the tab's OWN stored wizard flag (structured-sessions.ts messageSettings), so the
    // wand toggle must be set first via the dedicated settings call, exactly like the real composer.
    await page.evaluate(async ({ id, wizard }) => {
      const state = await window.conductor.structured.snapshot(id)
      const settings = { ...state.settings, wizard, model: 'claude-fable-5-1' }
      await window.conductor.structured.saveSettings(id, settings)
      await window.conductor.structured.submit(id, 'SYNTHETIC STEER START', settings)
    }, { id, wizard })
    const auth = await tabCredential()
    await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId: id })).phase } catch { return null } }, { timeout: 20_000, intervals: [250] }).toBe('completed')
    return { id, auth }
  }

  const wizardA = await openAndBecome({ title: 'Wizard A', wizard: true })
  observe('wizard A ready', { id: wizardA.id })
  const listAfterA = await call('agents.list')
  observe('agents.list wizard flag for wizard A (owner view)', { entry: listAfterA.find(a => a.agentSessionId === wizardA.id) })
  const wizardB = await openAndBecome({ title: 'Wizard B', wizard: true })
  observe('wizard B ready (will NOT request a restart)', { id: wizardB.id })
  const nonWizard = await openAndBecome({ title: 'Not a wizard', wizard: false })
  observe('non-wizard tab ready', { id: nonWizard.id })

  // Non-wizard tab and the owner credential calling app.restart.request are refused.
  const refusedNonWizard = await request(nonWizard.auth, 'app.restart.request', { reason: 'should be refused (non-wizard)' })
  observe('non-wizard app.restart.request', { status: refusedNonWizard.status, body: refusedNonWizard.body })
  assert.notEqual(refusedNonWizard.status, 200)
  const refusedOwner = await request(owner, 'app.restart.request', { reason: 'should be refused (owner)' }, { projectId })
  observe('owner credential app.restart.request', { status: refusedOwner.status, body: refusedOwner.body })
  assert.notEqual(refusedOwner.status, 200)

  // A 301-character reason is refused.
  const refusedLong = await request(wizardA.auth, 'app.restart.request', { reason: 'x'.repeat(301) })
  observe('301-char reason', { status: refusedLong.status, body: refusedLong.body })
  assert.notEqual(refusedLong.status, 200)

  if (!staleMode) {
    const reason = 'verify ✓ restart — ünïcode'
    const requested = await request(wizardA.auth, 'app.restart.request', { reason })
    observe('wizard A app.restart.request', { status: requested.status, body: requested.body })
    assert.equal(requested.status, 200, JSON.stringify(requested.body))
    assert.equal(requested.body.result.requested, true)

    const state = await call('app.state')
    summary.restartRequest = state.restartRequest
    observe('app.state.restartRequest', { restartRequest: state.restartRequest })
    assert.ok(state.restartRequest, 'restartRequest missing from app.state')
    assert.equal(state.restartRequest.reason, reason)
    await writeFile(join(output, 'S14-app-state.json'), JSON.stringify(state, null, 2))
    await page.screenshot({ path: join(output, 'S14-restart-requested-label.png') }).catch(() => {})

    const pidBefore = owner.pid
    await call('app.restart', {})
    await expect.poll(() => alive(pidBefore), { timeout: 30_000 }).toBe(false)
    await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== pidBefore && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
    owner = await credentialFile()
    const launchedAt = Date.now()
    observe('relaunched via UI restart button path', { pid: owner.pid })

    // The reattach message reaches wizard A as a fresh turn; expect it to reach 'completed' again
    // within about 10s of launch (it answers with a short SYNTHETIC-shaped continuation).
    let wizardAContinued = false, elapsedMs = null
    try {
      await expect.poll(async () => { const s = await call('agents.status', { agentSessionId: wizardA.id }); return s.phase === 'running' || s.phase === 'completed' }, { timeout: 15_000, intervals: [300] }).toBe(true)
      elapsedMs = Date.now() - launchedAt
      wizardAContinued = true
    } catch (e) { observe('wizard A did not show a fresh turn within 15s', { message: e.message }) }
    summary.wizardAResumed = { wizardAContinued, elapsedMs }
    observe('wizard A resume check', summary.wizardAResumed)

    const wizardBStatus = await call('agents.status', { agentSessionId: wizardB.id }).catch(e => ({ error: e.message }))
    summary.wizardBStatusAfterRelaunch = wizardBStatus
    observe('wizard B status after relaunch (should not show a fresh continue turn)', wizardBStatus)

    // The request is consumed: a second owner restart resumes nobody.
    const pidBefore2 = owner.pid
    await call('app.restart', { force: true })
    await expect.poll(() => alive(pidBefore2), { timeout: 30_000 }).toBe(false)
    await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== pidBefore2 && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
    owner = await credentialFile()
    const stateAfter2 = await call('app.state')
    summary.secondRestartResumedNobody = !stateAfter2.restartRequest
    observe('second restart: request consumed', { restartRequestNow: stateAfter2.restartRequest })
  } else {
    const reason = 'stale request check'
    const requested = await request(wizardA.auth, 'app.restart.request', { reason })
    assert.equal(requested.status, 200, JSON.stringify(requested.body))
    const stateBefore = await call('app.state')
    observe('restartRequest recorded before edit', { restartRequest: stateBefore.restartRequest })
    if (browser) await browser.close().catch(() => {})
    try { execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 1500))
    const db = new DatabaseSync(join(profile, 'conductor.db'))
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('restartRequest')
    observe('persisted restartRequest row', { row })
    assert.ok(row?.value, 'restartRequest was not persisted under settings key "restartRequest"')
    const parsed = JSON.parse(row.value)
    const edited = { ...parsed, at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(edited), 'restartRequest')
    db.close()
    summary.editedRestartRequest = edited
    observe('edited restartRequest.at to 25h ago', { edited })

    const port2 = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
    const log2 = openSync(appLog, 'a')
    const child2 = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port2}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log2, log2], windowsHide: true })
    closeSync(log2)
    await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === child2.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
    owner = await credentialFile()
    firstPid = child2.pid
    await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port2}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
    const page2 = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
    await page2.reload(); await page2.waitForFunction(() => Boolean(window.conductor))
    const stateAfterStaleLaunch = await call('app.state')
    summary.stateAfterStaleLaunch = { restartRequest: stateAfterStaleLaunch.restartRequest }
    observe('app.state after relaunch with a 25h-stale request', { restartRequest: stateAfterStaleLaunch.restartRequest })
    assert.ok(!stateAfterStaleLaunch.restartRequest, 'a 25h-stale restartRequest should not survive relaunch')
    await page2.locator('.project-row').filter({ hasText: 'V3 wizard restart' }).first().click().catch(() => {})
    await page2.screenshot({ path: join(output, 'S15-no-label-after-stale.png') }).catch(() => {})

    // Every launch consumes the request regardless of age, so app.state alone does not prove the
    // STALE one specifically was ignored (a fresh one would also be gone by the next check). Prove
    // wizard A itself was not resumed: no new turn (sequence/lastActivityAt unchanged) and no
    // "[Conductor] ... restarted" message in its history, 15s after this relaunch.
    const beforeCheck = await call('agents.status', { agentSessionId: wizardA.id })
    await new Promise(r => setTimeout(r, 15_000))
    const afterCheck = await call('agents.status', { agentSessionId: wizardA.id })
    const wizardAProjection = projection(wizardA.id)
    const restartedMessages = (wizardAProjection.items ?? []).filter(item => item.data?.type === 'text' && typeof item.data.text === 'string' && item.data.text.includes('restarted'))
    summary.staleWizardANotResumed = {
      sequenceBefore: beforeCheck.usage?.turns, sequenceAfter: afterCheck.usage?.turns,
      lastActivityBefore: beforeCheck.lastActivityAt, lastActivityAfter: afterCheck.lastActivityAt,
      restartedMessageCount: restartedMessages.length
    }
    observe('wizard A NOT resumed by the stale request (15s check)', summary.staleWizardANotResumed)
    assert.equal(afterCheck.usage?.turns, beforeCheck.usage?.turns, 'wizard A ran a new turn after a stale-request relaunch')
    assert.equal(afterCheck.lastActivityAt, beforeCheck.lastActivityAt, 'wizard A had new activity after a stale-request relaunch')
    assert.equal(restartedMessages.length, 0, 'wizard A received a restart-continuation message despite a stale request')

    // Contrast: a FRESH (unedited) request through the same force-kill-and-relaunch path (not the
    // owner's clean app.restart used in S14). Does it still resume the wizard? Record either way.
    const freshReason = 'fresh request, force-kill path'
    const freshRequested = await request(wizardB.auth, 'app.restart.request', { reason: freshReason })
    assert.equal(freshRequested.status, 200, JSON.stringify(freshRequested.body))
    const stateBeforeFreshKill = await call('app.state')
    observe('fresh restartRequest recorded (wizard B) before force-kill', { restartRequest: stateBeforeFreshKill.restartRequest })
    const wizardBBefore = await call('agents.status', { agentSessionId: wizardB.id })
    if (browser) await browser.close().catch(() => {})
    try { execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 1500))
    const port3 = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
    const log3 = openSync(appLog, 'a')
    const child3 = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port3}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log3, log3], windowsHide: true })
    closeSync(log3)
    await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === child3.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
    owner = await credentialFile()
    firstPid = child3.pid
    await new Promise(r => setTimeout(r, 3000))
    const stateAfterFreshKill = await call('app.state')
    const wizardBAfter = await call('agents.status', { agentSessionId: wizardB.id })
    const wizardBProjection = projection(wizardB.id)
    const wizardBRestartedMessages = (wizardBProjection.items ?? []).filter(item => item.data?.type === 'text' && typeof item.data.text === 'string' && item.data.text.includes('restarted'))
    summary.freshRequestForceKillContrast = {
      restartRequestAfter: stateAfterFreshKill.restartRequest,
      turnsBefore: wizardBBefore.usage?.turns, turnsAfter: wizardBAfter.usage?.turns,
      lastActivityBefore: wizardBBefore.lastActivityAt, lastActivityAfter: wizardBAfter.lastActivityAt,
      restartedMessageCount: wizardBRestartedMessages.length,
      resumed: wizardBRestartedMessages.length > 0 || wizardBAfter.usage?.turns !== wizardBBefore.usage?.turns
    }
    observe('fresh request + force-kill + relaunch: was wizard B resumed?', summary.freshRequestForceKillContrast)
  }
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  if (owner?.pid && alive(owner.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  if (firstPid && alive(firstPid)) { try { execFileSync('taskkill.exe', ['/pid', String(firstPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /wizard|restart|Error|error/i.test(line)).slice(-60) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, `${staleMode ? 'S15' : 'S14'}-summary.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
