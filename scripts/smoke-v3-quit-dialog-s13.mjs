import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// V3 verify S13, fresh instance (S12's dialog-raising half is not blocked; only its no-running-work
// half hangs, diagnosed separately by scripts/smoke-v3-quit-dialog-hang.mjs). With 1 streaming turn,
// app.restart{force:false} must raise pendingQuitConfirmation naming exactly that tab; then
// app.quit.confirm(stopWork:false) closes it and the turn completes, raised again stopWork:true
// restarts, app.quit.confirm with no dialog open is a clear error, a non-wizard tab calling it is
// refused, and a wizard tab's own app.restart (no args) with a turn running restarts without a
// dialog.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-quit-dialog-s13.mjs [--keep]

const HARD_TIMEOUT_MS = 9 * 60_000
const keep = process.argv.includes('--keep')
const output = resolve('artifacts/v3-verify/S13')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-s13-'))
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const capture = join(root, 'controller-input.txt')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// Custom fixture (not scripts/fixtures/fake-claude.mjs, which refuses non-SYNTHETIC prompts and
// would crash on the wizard-restart continuation message): reports the fable model when asked,
// captures every prompt it receives, streams slowly on request.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'v3-s13-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
const model = process.env.CONDUCTOR_TEST_CLAUDE_QUOTA === 'fable' ? 'claude-fable-5-1' : 'synthetic-claude'
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: model, displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE && typeof prompt === 'string') writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  const slow = typeof prompt === 'string' && prompt.includes('stream slowly')
  emit({ type: 'system', subtype: 'init', model })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  if (slow) { for (let i = 0; i < 200; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) } }
  else emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: slow ? 'slow-done' : 'Short done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S13 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credentialFile = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const request = async (auth, method, args = {}, scope) => { const r = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) }); return { status: r.status, body: await r.json() } }
const call = async (method, args = {}) => { const r = await request(owner, method, args, projectId ? { projectId } : undefined); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const tabCredential = async () => {
  await expect.poll(async () => readFile(capture, 'utf8').then(t => t.includes('Conductor app control:')).catch(() => false), { timeout: 30_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  return { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
}

const summary = { root, profile, build: resolve('out/main/index.js'), s13: {} }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let firstPid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credentialFile()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 S13' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  let page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 S13' }).first().click()
  await page.waitForTimeout(500)
  observe('project selected')

  // 1 streaming turn, force:false must raise the dialog naming exactly that tab.
  const streamTab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Streaming for dialog' })
  const streamId = streamTab.resourceId ?? streamTab.agentSessionId
  await call('agents.submit', { agentSessionId: streamId, prompt: 'stream slowly' })
  await new Promise(r => setTimeout(r, 1500))
  const restartWithDialog = await request(owner, 'app.restart', { force: false }, { projectId })
  observe('app.restart{force:false} with 1 streaming turn', { status: restartWithDialog.status, body: restartWithDialog.body })
  // The 200 {restarting:true} response is immediate; whether a dialog is needed is decided shortly
  // after (see S12's finding), so poll for it rather than reading app.state right away.
  await expect.poll(async () => (await call('app.state')).pendingQuitConfirmation !== null, { timeout: 20_000, intervals: [500] }).toBe(true)
  const stateWithDialog = await call('app.state')
  const pending = stateWithDialog.pendingQuitConfirmation
  summary.s13.dialogRaised = { status: restartWithDialog.status, pending }
  observe('pendingQuitConfirmation', { pending })
  assert.ok(pending, 'expected a pendingQuitConfirmation with a streaming turn running')
  assert.deepEqual(pending.running.map(r => r.id ?? r), [streamId], 'pendingQuitConfirmation.running should list exactly the streaming tab')
  await page.screenshot({ path: join(output, 'S13-dialog-state.png') }).catch(() => {})
  await writeFile(join(output, 'S13-app-state-dialog.json'), JSON.stringify(stateWithDialog, null, 2))

  // Non-wizard tab calling app.quit.confirm is refused (grab its own scoped credential first).
  const plainTab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Plain tab' })
  const plainId = plainTab.resourceId ?? plainTab.agentSessionId
  await call('agents.submit', { agentSessionId: plainId, prompt: 'hello' })
  const plainAuth = await tabCredential()
  await expect.poll(async () => (await call('agents.status', { agentSessionId: plainId })).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
  const plainConfirmAttempt = await request(plainAuth, 'app.quit.confirm', { stopWork: false })
  summary.s13.nonWizardConfirmRefused = { status: plainConfirmAttempt.status, body: plainConfirmAttempt.body }
  observe('non-wizard tab app.quit.confirm', summary.s13.nonWizardConfirmRefused)
  assert.notEqual(plainConfirmAttempt.status, 200, 'a non-wizard tab should be refused app.quit.confirm')
  // The dialog must still be open (the refused call must not have answered it).
  const stateStillPending = await call('app.state')
  assert.ok(stateStillPending.pendingQuitConfirmation, 'the refused non-wizard confirm should not have closed the dialog')

  // app.quit.confirm({stopWork:false}) (owner) closes it, app keeps running, turn completes.
  const confirmFalse = await call('app.quit.confirm', { stopWork: false })
  observe('app.quit.confirm stopWork:false', { confirmFalse })
  const stateAfterFalse = await call('app.state')
  assert.ok(!stateAfterFalse.pendingQuitConfirmation, 'dialog should be closed after stopWork:false')
  assert.ok(alive(owner.pid), 'app should keep running after stopWork:false')
  await expect.poll(async () => (await call('agents.status', { agentSessionId: streamId })).phase, { timeout: 90_000, intervals: [500] }).toBe('completed')
  summary.s13.stopWorkFalse = { confirmFalse, turnCompleted: true }
  observe('turn continued and completed after stopWork:false')

  // Raise it again, then stopWork:true restarts.
  const streamTab2 = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Streaming 2' })
  const streamId2 = streamTab2.resourceId ?? streamTab2.agentSessionId
  await call('agents.submit', { agentSessionId: streamId2, prompt: 'stream slowly' })
  await new Promise(r => setTimeout(r, 1500))
  await request(owner, 'app.restart', { force: false }, { projectId })
  await expect.poll(async () => (await call('app.state')).pendingQuitConfirmation !== null, { timeout: 20_000, intervals: [500] }).toBe(true)
  const stateWithDialog2 = await call('app.state')
  assert.ok(stateWithDialog2.pendingQuitConfirmation, 'expected a second pendingQuitConfirmation')
  const pidBeforeStopTrue = owner.pid
  const confirmTrue = await call('app.quit.confirm', { stopWork: true })
  observe('app.quit.confirm stopWork:true', { confirmTrue })
  await expect.poll(() => alive(pidBeforeStopTrue), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== pidBeforeStopTrue && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credentialFile()
  summary.s13.stopWorkTrue = { confirmTrue, relaunchedPid: owner.pid }
  observe('app restarted after stopWork:true', { pid: owner.pid })
  // The relaunched process reuses the same --remote-debugging-port; reconnect for the wizard step.
  if (browser) await browser.close().catch(() => {})
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 S13' }).first().click()
  await page.waitForTimeout(500)
  observe('reconnected to the relaunched window')

  // app.quit.confirm with no dialog open: clear error.
  const noDialogConfirm = await request(owner, 'app.quit.confirm', { stopWork: false }, { projectId })
  summary.s13.noDialogOpen = { status: noDialogConfirm.status, body: noDialogConfirm.body }
  observe('app.quit.confirm with no dialog open', summary.s13.noDialogOpen)
  assert.notEqual(noDialogConfirm.status, 200, 'app.quit.confirm with no open dialog should error')

  // A wizard tab's own app.restart (no args) with a turn running restarts without a dialog.
  const wizardTab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Wizard' })
  const wizardId = wizardTab.resourceId ?? wizardTab.agentSessionId
  await page.evaluate(async ({ id }) => {
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'become wizard', settings)
  }, { id: wizardId })
  const wizardAuth = await tabCredential()
  await expect.poll(async () => (await call('agents.status', { agentSessionId: wizardId })).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
  await call('agents.submit', { agentSessionId: wizardId, prompt: 'stream slowly' })
  await new Promise(r => setTimeout(r, 1500))
  const pidBeforeWizardRestart = owner.pid
  const wizardRestart = await request(wizardAuth, 'app.restart', {})
  observe('wizard app.restart (no args) with its own turn running', { status: wizardRestart.status, body: wizardRestart.body })
  summary.s13.wizardSelfRestart = { status: wizardRestart.status, body: wizardRestart.body }
  assert.equal(wizardRestart.status, 200, JSON.stringify(wizardRestart.body))
  await expect.poll(() => alive(pidBeforeWizardRestart), { timeout: 30_000 }).toBe(false)
  observe('app restarted without a dialog despite the wizard turn running')

  await writeFile(join(output, 'S13-responses.json'), JSON.stringify(summary.s13, null, 2))
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  if (owner?.pid && alive(owner.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  if (firstPid && alive(firstPid)) { try { execFileSync('taskkill.exe', ['/pid', String(firstPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /quit|restart|dialog|wizard|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, 'S13-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exit(failed ? 1 : 0)
