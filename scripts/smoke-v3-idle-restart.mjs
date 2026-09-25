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

// V3 verify S10/S11: 10 idle completed fake-claude tabs (S11: 9 idle + 1 streaming) survive an
// owner app.restart without going `disconnected`. Usage:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-idle-restart.mjs [--host] [--mixed] [--keep]
// --host enables CONDUCTOR_RUNTIME_HOST=1 (S10 also runs with host OFF, the default).
// --mixed runs S11: 9 idle + 1 tab left streaming when the restart lands (host OFF only).

const HARD_TIMEOUT_MS = 9 * 60_000
const host = process.argv.includes('--host')
const mixed = process.argv.includes('--mixed')
const keep = process.argv.includes('--keep')
const scenario = mixed ? 'S11' : (host ? 'S10-host' : 'S10-nohost')
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-idle-'))
const output = resolve(`artifacts/v3-verify/${mixed ? 'S11' : 'S10'}`)
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// fake-claude: a short turn that completes quickly, or (STREAM_SLOW=1) streams slowly so a
// restart can land mid-turn for the S11 mixed case.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'v3-idle-smoke', parent_tool_use_id: null, ...message })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const promptText = JSON.stringify(message)
  const slow = promptText.includes('stream slowly')
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  if (slow) {
    for (let i = 0; i < 200; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) }
  } else {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: slow ? 'slow-done' : 'Short done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 idle-restart smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
if (host) env.CONDUCTOR_RUNTIME_HOST = '1'
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
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const projection = agentSessionId => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() }
}

const summary = { scenario, root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let firstPid = null, relaunchedPid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid, host, mixed })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 idle restart' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 idle restart' }).first().click()
  await page.waitForTimeout(500)
  observe('project selected in the parked window')

  // Open 9 (mixed) or 10 (plain) tabs, submit a short turn, wait for completed.
  const idleCount = mixed ? 9 : 10
  const idleIds = []
  for (let i = 0; i < idleCount; i++) {
    const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: `Idle ${i}` })
    const id = tab.resourceId ?? tab.agentSessionId
    idleIds.push(id)
    await call('agents.submit', { agentSessionId: id, prompt: `short turn ${i}` })
  }
  for (const id of idleIds) {
    await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId: id })).phase } catch { return null } }, { timeout: 30_000, intervals: [250] }).toBe('completed')
  }
  observe('idle tabs completed', { count: idleIds.length })

  let streamId = null
  if (mixed) {
    const streamTab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Streaming' })
    streamId = streamTab.resourceId ?? streamTab.agentSessionId
    await call('agents.submit', { agentSessionId: streamId, prompt: 'stream slowly' })
    await new Promise(r => setTimeout(r, 1000))
  }

  const before = {}
  for (const id of [...idleIds, ...(streamId ? [streamId] : [])]) before[id] = (await call('agents.status', { agentSessionId: id })).phase
  await page.screenshot({ path: join(output, `${scenario}-before-restart.png`) }).catch(() => {})

  await call('app.restart', { force: true })
  observe('app.restart requested')
  await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== firstPid && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  relaunchedPid = owner.pid
  observe('app relaunched', { pid: relaunchedPid })
  await new Promise(r => setTimeout(r, 2000))

  const after = {}
  for (const id of [...idleIds, ...(streamId ? [streamId] : [])]) { try { after[id] = (await call('agents.status', { agentSessionId: id })).phase } catch (e) { after[id] = 'ERROR:' + e.message } }
  summary.before = before; summary.after = after
  observe('agents.list after relaunch', { before, after })

  const idleBroke = idleIds.filter(id => after[id] === 'disconnected' || after[id] !== 'completed')
  assert.deepEqual(idleBroke, [], `idle tabs should stay completed, got: ${JSON.stringify(idleBroke.map(id => ({ id, phase: after[id] })))}`)
  if (mixed && streamId) observe('streaming tab phase after restart (informational)', { phase: after[streamId] })

  // Reconnect 3 of the idle tabs lazily by submitting into them again.
  const reconnectTargets = idleIds.slice(0, 3)
  for (const id of reconnectTargets) await call('agents.submit', { agentSessionId: id, prompt: 'reconnect check' })
  for (const id of reconnectTargets) await expect.poll(async () => (await call('agents.status', { agentSessionId: id })).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  observe('3 idle tabs reconnected lazily and completed', { reconnectTargets })
  await page.screenshot({ path: join(output, `${scenario}-tabstrip.png`) }).catch(() => {})
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1200) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /disconnected|reattach|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, `${scenario}-summary.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
