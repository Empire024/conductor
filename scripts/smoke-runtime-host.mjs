import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// e1610f01 acceptance (docs/runtime-host.md): a Claude turn keeps running through a Conductor
// restart and finishes in its tab with every event. The built app runs parked under
// CONDUCTOR_TEST_USER_DATA with the runtime host on and an offline Claude fixture that streams a
// long turn. The owner credential opens a conversation, starts the turn and calls app.restart
// mid-turn (an owner restart keeps work running without asking). The relaunched app must reattach
// the same provider process and finish the turn: every streamed word in one assistant message.
//
//   node scripts/smoke-lock.mjs -- node scripts/smoke-runtime-host.mjs [--keep]

const WORDS = 30
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-runtime-host-'))
const output = resolve('artifacts/runtime-host')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// The Claude stand-in: stream-json on stdin/stdout, one slow turn; a message that arrives while the
// turn runs (Conductor's reattach briefing) is answered after it.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const session = 'runtime-host-smoke-native'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const stream = async (words, delay) => {
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const word of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } }); await wait(delay) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
}
let busy = false
const queued = []
const turn = async first => {
  busy = true
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (first) await stream(Array.from({ length: ${WORDS} }, (_, i) => 'word' + i + ' '), 250)
  else await stream(['Briefing ', 'noted.'], 10)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  busy = false
  if (queued.length) { queued.shift(); void turn(false) }
}
let turns = 0
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  if (busy) { queued.push(message); return }
  void turn(turns++ === 0)
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# Runtime host smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_RUNTIME_HOST_IDLE_MS: '5000' }
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
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const hostLock = () => { try { return JSON.parse(readFileSync(join(profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
/** One request to the runtime host over its pipe, with the secret from its lock file. */
const hostRequest = (lock, request) => new Promise((resolveRequest, reject) => {
  const socket = connect(lock.pipe)
  let buffer = ''
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('runtime host did not answer')) }, 5000)
  socket.on('error', error => { clearTimeout(timer); reject(error) })
  socket.on('connect', () => socket.write(JSON.stringify({ op: 'hello', id: 1, secret: lock.secret, protocol: lock.protocol }) + '\n' + JSON.stringify({ ...request, id: 2 }) + '\n'))
  socket.on('data', chunk => {
    buffer += chunk
    for (const line of buffer.split('\n').slice(0, -1)) {
      const message = JSON.parse(line)
      if (message.op === 'result' && message.id === 2) { clearTimeout(timer); socket.end(); message.ok ? resolveRequest(message.value) : reject(new Error(message.error)) }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
  })
})
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const projection = agentSessionId => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() }
}

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, 6 * 60_000)
let app, relaunchedPid = null, failed = null
const appLog = join(root, 'app.log')
try {
  // The app is launched with its output in a file, not through Playwright's pipes: the instance
  // app.restart starts inherits these handles, and a pipe to this script would close under it.
  // The window is driven over CDP.
  const port = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
  const log = openSync(appLog, 'a')
  const electronPath = createRequire(import.meta.url)('electron')
  const child = spawn(electronPath, [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  const firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  await expect.poll(() => hostLock()?.pid ?? null, { timeout: 30_000 }).not.toBe(null)
  const lock = hostLock()
  observe('runtime host running', { pid: lock.pid })
  projectId = (await call('projects.open', { path: projectPath, name: 'Runtime host smoke' })).id
  let browser
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Runtime host smoke' }).first().click()
  observe('project selected in the parked window')
  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Kept turn' })
  const agentSessionId = tab.resourceId ?? tab.agentSessionId
  summary.agentSessionId = agentSessionId
  await call('agents.submit', { agentSessionId, prompt: 'Stream the long synthetic answer.' })
  await expect.poll(() => { try { return (projection(agentSessionId).items ?? []).some(item => item.data?.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('word3 ')) } catch { return false } }, { timeout: 30_000, intervals: [250] }).toBe(true)
  const [before] = await hostRequest(lock, { op: 'list' })
  observe('turn under way; runtime held by the host', { runtimeId: before.runtimeId, pid: before.pid, attached: before.attached })
  assert.equal(before.attached, true)

  await browser.close().catch(() => {})
  await call('app.restart', { force: true })
  observe('app.restart requested')
  await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
  observe('first process exited', { pid: firstPid })
  // The relaunched process writes a fresh credential naming itself.
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== firstPid && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  relaunchedPid = owner.pid
  observe('app relaunched', { pid: relaunchedPid })

  const [after] = await hostRequest(lock, { op: 'list' })
  observe('runtime after relaunch', { runtimeId: after?.runtimeId, pid: after?.pid, attached: after?.attached })
  assert.equal(after.runtimeId, before.runtimeId, 'the relaunched app is not attached to the same provider process')
  assert.equal(after.pid, before.pid)
  await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId })).phase } catch { return null } }, { timeout: 60_000, intervals: [500] }).toBe('completed')
  const texts = (await (async () => { await new Promise(done => setTimeout(done, 1500)); return projection(agentSessionId).items })()).filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
  summary.assistant = texts
  observe('turn completed after the restart', { texts })
  assert.equal(texts[0], Array.from({ length: WORDS }, (_, i) => `word${i} `).join(''))
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1200) })
} finally {
  clearTimeout(watchdog)
  if (app) { await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 10_000))]); try { app.process().kill() } catch { /* exited */ } }
  for (const pid of [owner?.pid, relaunchedPid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /runtime host|reattach|Kept|kept|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
  if (relaunchedPid && alive(relaunchedPid)) { try { execFileSync('taskkill.exe', ['/pid', String(relaunchedPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  const lock = hostLock()
  if (lock) await hostRequest(lock, { op: 'shutdown' }).catch(() => {})
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, 'smoke-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(done => setTimeout(done, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
if (failed) process.exit(1)
