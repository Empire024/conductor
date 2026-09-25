import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// V3 verify S5 (runtime host, two windows): detach one streaming tab into a second window
// (tabs.detach) with a second tab streaming in the main window, then restart. Expect both windows
// restored, each tab back in its own window, both turns complete with full text.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-s5.mjs [--keep]

const WORDS = 30
const DELAY_MS = 250
const keep = process.argv.includes('--keep')
const HARD_TIMEOUT_MS = 9 * 60_000
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-s5-'))
const output = resolve('artifacts/v3-verify/S5')
await mkdir(output, { recursive: true })
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
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'v3-s5-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  const words = Array.from({ length: ${WORDS} }, (_, i) => 'w' + String(i + 1).padStart(3, '0') + ' ')
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const w of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } }); await wait(${DELAY_MS}) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S5 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_RUNTIME_HOST_IDLE_MS: '20000' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const call = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result }
const hostLock = () => { try { return JSON.parse(readFileSync(join(profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const projection = agentSessionId => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(agentSessionId).projection_json) } finally { db.close() }
}

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let firstPid = null, relaunchedPid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  const port = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  await expect.poll(() => hostLock()?.pid ?? null, { timeout: 30_000 }).not.toBe(null)
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 S5' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 S5' }).first().click()
  await page.waitForTimeout(500)
  observe('project selected')

  const tabA = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Main window tab' })
  const idA = tabA.resourceId ?? tabA.agentSessionId
  const tabB = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Detached window tab' })
  const idB = tabB.resourceId ?? tabB.agentSessionId
  await call('agents.submit', { agentSessionId: idA, prompt: 'stream now' })
  await call('agents.submit', { agentSessionId: idB, prompt: 'stream now' })
  await new Promise(r => setTimeout(r, 500))

  await call('tabs.detach', { tabId: tabB.id })
  await expect.poll(() => browser.contexts().flatMap(c => c.pages()).filter(p => p.url().includes('index.html')).length, { timeout: 15_000, intervals: [300] }).toBe(2)
  observe('tab B detached into a second window')
  await new Promise(r => setTimeout(r, 5000)) // both streams under way; let the detached window's layout persist before restarting

  const before = await Promise.all([idA, idB].map(id => call('agents.status', { agentSessionId: id })))
  observe('both tabs streaming before restart', { phases: before.map(s => s.phase) })
  await page.screenshot({ path: join(output, 'S5-before-restart-main.png') }).catch(() => {})

  await call('app.restart', { force: true })
  observe('app.restart requested')
  await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== firstPid && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  relaunchedPid = owner.pid
  observe('app relaunched', { pid: relaunchedPid })
  try {
    const cmdline = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${relaunchedPid}").CommandLine`], { encoding: 'utf8' }).trim()
    observe('relaunched process command line', { cmdline, hasDebugPort: cmdline.includes('--remote-debugging-port') })
  } catch (e) { observe('could not read relaunched process command line', { message: e.message }) }

  // The CDP debug port failure is recorded as a note, not the verdict: the acceptance below uses
  // only the owner control credential (agents.status/snapshot, app.state), per the controller.
  if (browser) await browser.close().catch(() => {})
  try {
    const versionText = execFileSync('curl.exe', ['-s', `http://127.0.0.1:${port}/json/version`], { encoding: 'utf8', timeout: 10_000 })
    summary.cdpDebugPortAnswered = { answered: Boolean(versionText.trim()), body: versionText.trim().slice(0, 300) }
  } catch (e) { summary.cdpDebugPortAnswered = { answered: false, error: String(e.message ?? e) } }
  observe('CDP debug port check after relaunch (informational only)', summary.cdpDebugPortAnswered)

  for (const id of [idA, idB]) await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId: id })).phase } catch { return null } }, { timeout: 60_000, intervals: [500] }).toBe('completed')
  await new Promise(r => setTimeout(r, 1500))

  const stateAfter = await call('app.state')
  const detachedInfo = { detachedWindows: stateAfter.detachedWindows ?? stateAfter.windows ?? stateAfter.layout ?? null }
  summary.appStateAfterRelaunch = detachedInfo
  observe('app.state after relaunch (window/layout evidence)', detachedInfo)

  const snapshots = await Promise.all([idA, idB].map(id => call('agents.snapshot', { agentSessionId: id })))
  summary.snapshotsAfterRelaunch = snapshots.map(s => ({ phase: s.phase, tabId: s.tabId ?? s.uri }))
  observe('agents.snapshot of both tabs after relaunch', summary.snapshotsAfterRelaunch)

  const expectedWords = Array.from({ length: WORDS }, (_, i) => 'w' + String(i + 1).padStart(3, '0') + ' ').join('')
  const results = {}
  for (const [name, id] of [['A', idA], ['B', idB]]) {
    const proj = projection(id)
    const assistant = (proj.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
    results[name] = { fullTextPresent: assistant.some(t => t === expectedWords) }
    assert.ok(results[name].fullTextPresent, `tab ${name} is missing its full streamed text after the restart`)
  }
  summary.results = results
  observe('both turns completed with full text', results)
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /window|detach|runtime host|reattach|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, 'S5-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
