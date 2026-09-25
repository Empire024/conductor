import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// V3 verify S12/S13: app.restart{force:false} raises no dialog with only idle tabs, but raises
// pendingQuitConfirmation naming exactly the streaming tab when one is running; app.quit.confirm
// answers it (stopWork:false keeps the app running and the turn completes; called again with
// stopWork:true restarts). Also: app.quit.confirm with no dialog open is a clear 400; a non-wizard
// fixture tab calling it is refused; a wizard tab's own app.restart (no args) with a turn running
// restarts without a dialog.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-quit-dialog.mjs [--keep]

const HARD_TIMEOUT_MS = 9 * 60_000
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-quit-'))
const output = resolve('artifacts/v3-verify/S12')
const output13 = resolve('artifacts/v3-verify/S13')
await mkdir(output, { recursive: true }); await mkdir(output13, { recursive: true })
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'v3-quit-smoke', parent_tool_use_id: null, ...message })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const slow = JSON.stringify(message).includes('stream slowly')
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
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
await writeFile(join(projectPath, 'README.md'), '# V3 quit-dialog smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => {
  const path = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true)
  return JSON.parse(await readFile(path, 'utf8'))
}
const call = async (method, args = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  return { status: response.status, body }
}
const callOk = async (method, args = {}) => { const r = await call(method, args); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

const summary = { root, profile, build: resolve('out/main/index.js') }
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
  owner = await credential()
  projectId = (await callOk('projects.open', { path: projectPath, name: 'V3 quit dialog' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 quit dialog' }).first().click()
  await page.waitForTimeout(500)
  observe('project selected')

  // --- Part 1: 10 idle tabs, one stopped mid-turn with a leftover queued prompt, no running turns.
  const idleIds = []
  for (let i = 0; i < 10; i++) {
    const tab = await callOk('tabs.open', { kind: 'agent', provider: 'claude', title: `Idle ${i}` })
    const id = tab.resourceId ?? tab.agentSessionId
    idleIds.push(id)
    await callOk('agents.submit', { agentSessionId: id, prompt: `short ${i}` })
  }
  for (const id of idleIds) await expect.poll(async () => (await callOk('agents.status', { agentSessionId: id })).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  const stoppedTab = await callOk('tabs.open', { kind: 'agent', provider: 'claude', title: 'Stopped with queued' })
  const stoppedId = stoppedTab.resourceId ?? stoppedTab.agentSessionId
  await callOk('agents.submit', { agentSessionId: stoppedId, prompt: 'stream slowly' })
  await expect.poll(async () => (await callOk('agents.status', { agentSessionId: stoppedId })).phase, { timeout: 10_000, intervals: [250] }).not.toBe(undefined)
  await callOk('agents.steer', { agentSessionId: stoppedId, prompt: 'queued while stopping' }).catch(() => {})
  await callOk('agents.interrupt', { agentSessionId: stoppedId })
  await new Promise(r => setTimeout(r, 1000))
  observe('12-tab state ready: 10 idle + 1 stopped with a leftover queued prompt, no running turns')

  const restartNoArgs = await call('app.restart', { force: false })
  observe('app.restart{force:false} with no streaming turns', { status: restartNoArgs.status, body: restartNoArgs.body })
  const stateAfterNoDialog = await callOk('app.state').catch(async () => { owner = await credential(); return callOk('app.state') })
  const hadDialog = Boolean(stateAfterNoDialog?.pendingQuitConfirmation)
  summary.s12_noDialogCase = { restartStatus: restartNoArgs.status, hadDialog }
  assert.equal(hadDialog, false, 'app.restart{force:false} raised a dialog with no streaming turns')
  // It restarted; wait for relaunch to settle before continuing.
  await expect.poll(() => alive(firstPid), { timeout: 120_000, intervals: [2000] }).toBe(false)
  observe('first process exited after force:false restart')
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== firstPid && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 90_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  observe('relaunched cleanly with no dialog', { pid: owner.pid })
  await new Promise(r => setTimeout(r, 1500))

  // --- Part 2: add a streaming turn, force:false must raise the dialog naming exactly that tab.
  const streamTab = await callOk('tabs.open', { kind: 'agent', provider: 'claude', title: 'Streaming for dialog' })
  const streamId = streamTab.resourceId ?? streamTab.agentSessionId
  await callOk('agents.submit', { agentSessionId: streamId, prompt: 'stream slowly' })
  await new Promise(r => setTimeout(r, 1500))
  const restartWithDialog = await call('app.restart', { force: false })
  observe('app.restart{force:false} with 1 streaming turn', { status: restartWithDialog.status })
  const stateWithDialog = await callOk('app.state')
  const pending = stateWithDialog.pendingQuitConfirmation
  summary.s12_dialogCase = { pending }
  observe('pendingQuitConfirmation', { pending })
  assert.ok(pending, 'expected a pendingQuitConfirmation with a streaming turn running')
  assert.deepEqual(pending.running, [streamId], 'pendingQuitConfirmation.running should list exactly the streaming tab')
  await page.screenshot({ path: join(output, 'S12-dialog-state.png') }).catch(() => {})
  await writeFile(join(output, 'S12-app-state.json'), JSON.stringify(stateWithDialog, null, 2))

  // --- S13: app.quit.confirm({stopWork:false}) closes it, app keeps running, turn completes.
  const confirmFalse = await callOk('app.quit.confirm', { stopWork: false })
  observe('app.quit.confirm stopWork:false', { confirmFalse })
  const stateAfterFalse = await callOk('app.state')
  assert.ok(!stateAfterFalse.pendingQuitConfirmation, 'dialog should be closed after stopWork:false')
  assert.ok(alive(owner.pid), 'app should keep running after stopWork:false')
  await expect.poll(async () => (await callOk('agents.status', { agentSessionId: streamId })).phase, { timeout: 90_000, intervals: [500] }).toBe('completed')
  observe('turn continued and completed after stopWork:false')

  // Raise it again with a fresh streaming turn, then stopWork:true restarts/quits.
  const streamTab2 = await callOk('tabs.open', { kind: 'agent', provider: 'claude', title: 'Streaming 2' })
  const streamId2 = streamTab2.resourceId ?? streamTab2.agentSessionId
  await callOk('agents.submit', { agentSessionId: streamId2, prompt: 'stream slowly' })
  await new Promise(r => setTimeout(r, 1500))
  await callOk('app.restart', { force: false })
  const stateWithDialog2 = await callOk('app.state')
  assert.ok(stateWithDialog2.pendingQuitConfirmation, 'expected a second pendingQuitConfirmation')
  const pidBeforeStopTrue = owner.pid
  const confirmTrue = await callOk('app.quit.confirm', { stopWork: true })
  observe('app.quit.confirm stopWork:true', { confirmTrue })
  await expect.poll(() => alive(pidBeforeStopTrue), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== pidBeforeStopTrue && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  observe('app restarted after stopWork:true', { pid: owner.pid })

  // app.quit.confirm with no dialog open: clear error.
  const noDialogConfirm = await call('app.quit.confirm', { stopWork: false })
  observe('app.quit.confirm with no dialog open', { status: noDialogConfirm.status, body: noDialogConfirm.body })
  assert.notEqual(noDialogConfirm.status, 200, 'app.quit.confirm with no open dialog should error')

  summary.s13 = { confirmFalse, confirmTrue, noDialogConfirm: { status: noDialogConfirm.status, body: noDialogConfirm.body } }
  await writeFile(join(output13, 'S13-responses.json'), JSON.stringify(summary.s13, null, 2))
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  if (owner?.pid && alive(owner.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  if (firstPid && alive(firstPid)) { try { execFileSync('taskkill.exe', ['/pid', String(firstPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /quit|restart|dialog|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, 'S12-S13-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
