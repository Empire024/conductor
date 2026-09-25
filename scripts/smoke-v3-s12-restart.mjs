import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// V3 S12 regression (19c298e4): an owner app.restart{force:false} never promises a restart and
// then waits on the "Work is still running" dialog.
//   A. 10 idle tabs + 1 tab stopped mid-turn that still holds a steered prompt (its provider
//      ignores the interrupt and keeps streaming, the slowest a stop can be): the reply is
//      restarting:true, no dialog opens, and the app relaunches within 20 s.
//   B. 1 streaming tab: the reply says confirmationPending and names it, the dialog is open; the
//      owner then stops that tab, and the dialog closes itself and the app relaunches.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-s12-restart.mjs [--keep]

const keep = process.argv.includes('--keep')
const HARD_TIMEOUT_MS = 6 * 60_000
const output = resolve('artifacts/v3-verify/S12')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-s12-'))
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// A Claude stand-in that steers like the installed CLI (input sent while a turn runs is queued,
// acknowledged with command_lifecycle, and cancelled by an interrupt with cancel_queued) but is
// as slow to stop as a provider can be: it acknowledges the interrupt and keeps streaming.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'v3-s12-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
let busy = false
let held = []
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    let response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    if (message.request.subtype === 'interrupt' && message.request.cancel_queued) { response = { cancelled: held }; held = [] }
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  if (busy) { held.push(message.uuid); emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' }); return }
  busy = true
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
  busy = false
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S12 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const readOwner = async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }
const post = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); return { status: r.status, body: await r.json() } }
const call = async (method, args = {}) => { const { status, body } = await post(method, args); assert.equal(status, 200, `${method}: ${JSON.stringify(body)}`); return body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
/** Waits for the process to exit and a new one to write its credential; returns the seconds taken. */
const relaunched = async (pid, timeout) => {
  const started = Date.now()
  await expect.poll(() => alive(pid), { timeout, intervals: [250] }).toBe(false)
  await expect.poll(async () => { const next = await readOwner(); return next && next.pid !== pid && alive(next.pid) ? next.pid : null }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await readOwner()
  return (Date.now() - started) / 1000
}

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); writeFile(join(output, 'S12-restart-summary.json'), JSON.stringify({ result: 'FAIL', ...summary, observations }, null, 2)).finally(() => process.exit(1)) }, HARD_TIMEOUT_MS)
let failed = null, browser
const pids = []
const appLog = join(root, 'app.log')
try {
  const cdpPort = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${cdpPort}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  pids.push(child.pid)
  observe('app launched (parked)', { pid: child.pid })
  await expect.poll(async () => (await readOwner())?.pid === child.pid, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await readOwner()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 S12' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 S12' }).first().click()
  await page.waitForTimeout(500)
  await browser.close().catch(() => {}); browser = undefined

  // --- A. 10 idle + 1 stopped with a steered prompt, no running turn.
  const idleIds = []
  for (let i = 0; i < 10; i++) {
    const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: `Idle ${i}` })
    idleIds.push(tab.resourceId)
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt: `short ${i}` })
  }
  for (const id of idleIds) await expect.poll(async () => (await call('agents.status', { agentSessionId: id })).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  const stopped = (await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Stopped with queued' })).resourceId
  await call('agents.submit', { agentSessionId: stopped, prompt: 'stream slowly' })
  await expect.poll(async () => (await call('agents.status', { agentSessionId: stopped })).phase, { timeout: 10_000, intervals: [250] }).toBe('running')
  await call('agents.steer', { agentSessionId: stopped, prompt: 'queued while stopping' })
  await call('agents.interrupt', { agentSessionId: stopped })
  await new Promise(r => setTimeout(r, 1000))
  const stoppedStatus = await call('agents.status', { agentSessionId: stopped })
  summary.stoppedTab = { phase: stoppedStatus.phase, waitingPrompts: stoppedStatus.waitingPrompts }
  observe('A: 10 idle + 1 stopped tab ready', summary.stoppedTab)
  assert.equal(stoppedStatus.phase, 'interrupting', 'A: the stopped tab should still be winding its turn down')
  assert.equal(stoppedStatus.waitingPrompts, 1, 'A: the stopped tab should still hold its steered prompt')

  const firstPid = owner.pid
  const restartA = await call('app.restart', { force: false })
  observe('A: app.restart{force:false}', { reply: restartA })
  assert.equal(restartA.restarting, true, `A: expected restarting:true with no running work, got ${JSON.stringify(restartA)}`)
  const secondsA = await relaunched(firstPid, 20_000)
  pids.push(owner.pid)
  summary.A = { reply: restartA, relaunchSeconds: secondsA }
  observe('A: relaunched without a dialog', summary.A)
  await new Promise(r => setTimeout(r, 1500))

  // --- B. A streaming turn: the reply names the dialog; stopping the turn lets the restart go on.
  const streaming = (await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Streaming for dialog' })).resourceId
  await call('agents.submit', { agentSessionId: streaming, prompt: 'stream slowly' })
  await expect.poll(async () => (await call('agents.status', { agentSessionId: streaming })).phase, { timeout: 10_000, intervals: [250] }).toBe('running')
  const secondPid = owner.pid
  const restartB = await call('app.restart', { force: false })
  observe('B: app.restart{force:false} with a streaming turn', { reply: restartB })
  assert.equal(restartB.restarting, false, 'B: a restart that waits on the owner must not answer restarting:true')
  assert.equal(restartB.confirmationPending, true)
  assert.deepEqual(restartB.running.map(entry => entry.id), [streaming])
  await expect.poll(async () => (await call('app.state')).pendingQuitConfirmation?.running?.map(entry => entry.id) ?? null, { timeout: 5_000, intervals: [100] }).toEqual([streaming])
  observe('B: dialog open, naming exactly the streaming tab')
  await new Promise(r => setTimeout(r, 2000))
  assert.ok(alive(secondPid), 'B: the app must wait for the owner while the turn runs')
  await call('agents.interrupt', { agentSessionId: streaming })
  observe('B: streaming tab stopped by the owner')
  const secondsB = await relaunched(secondPid, 20_000)
  pids.push(owner.pid)
  summary.B = { reply: restartB, relaunchSecondsAfterStop: secondsB }
  observe('B: dialog closed itself and the app relaunched', summary.B)
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  for (const pid of new Set([...pids, owner?.pid])) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, 'S12-restart-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
