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

// V3 verify S1/S2 (runtime host, CONDUCTOR_RUNTIME_HOST=1): 2 fake-claude + 1 custom codex-fixture
// tabs each stream w001..w120 at ~250ms; an owner app.restart{force:true} lands at about w030;
// all 3 must reattach and complete with the exact numbered sequence, no gap or duplicate.
// --queued adds S2: 5 prompts steered into one fake-claude tab within 1s just before the restart,
// each expected answered exactly once, in order, after reattach.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v3-s1-s2.mjs [--queued] [--keep]

const WORDS = 120
const DELAY_MS = 250
const queuedSubmit = process.argv.includes('--queued-submit')
const queuedMode = process.argv.includes('--queued') || queuedSubmit
const keep = process.argv.includes('--keep')
const scenario = queuedMode ? 'S2' : 'S1'
const HARD_TIMEOUT_MS = 13 * 60_000
const root = await mkdtemp(join(tmpdir(), 'conductor-v3-s1s2-'))
const output = resolve(`artifacts/v3-verify/${scenario}`)
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true }); await mkdir(projectPath, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// fake-claude: streams w001..w120 on the first turn; any prompt arriving while busy is queued and
// answered (a short distinct ack) in arrival order once the current turn finishes.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'v3-s1s2-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
const words = Array.from({ length: ${WORDS} }, (_, i) => 'w' + String(i + 1).padStart(3, '0') + ' ')
let busy = false
const queued = []
const stream = async (text, ackId) => {
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const chunk of text) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } }); await wait(${DELAY_MS}) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  const full = Array.isArray(text) ? text.join('') : text
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: full }] } })
}
const turn = async first => {
  busy = true
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (first) await stream(words)
  else await stream(['ack:' + first])
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  busy = false
  if (queued.length) { const next = queued.shift(); void turn(next) }
}
let turnCount = 0
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (busy) { queued.push(prompt); return }
  turnCount++
  void turn(turnCount === 1 ? true : prompt)
})
`)

// Codex App Server fixture: a full copy of scripts/fixtures/codex-app-server.mjs (handshake,
// --version, model/list, etc.) plus one added scenario for this test; see the copy's header.
// The provider factory (src/main/providers/factory.ts) always loads `fake-${provider}.mjs`, which
// for codex is scripts/fixtures/fake-codex.mjs, a one-line re-export of codex-app-server.mjs.
await writeFile(join(fixtures, 'codex-app-server.mjs'), await readFile(resolve('scripts/fixtures/v3-codex-app-server.mjs'), 'utf8'))
await writeFile(join(fixtures, 'fake-codex.mjs'), "import './codex-app-server.mjs'\n")

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# V3 S1/S2 smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_RUNTIME_HOST_IDLE_MS: '20000', V3_STREAM_WORDS: String(WORDS), V3_STREAM_DELAY_MS: String(DELAY_MS) }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let owner, projectId
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const call = async (method, args = {}) => { const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) }); const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result }
const hostLock = () => { try { return JSON.parse(readFileSync(join(profile, 'runtime-host', 'host.json'), 'utf8')) } catch { return null } }
const hostRequest = (lock, request) => new Promise((res, rej) => {
  const socket = connect(lock.pipe)
  let buffer = ''
  const timer = setTimeout(() => { socket.destroy(); rej(new Error('runtime host did not answer')) }, 5000)
  socket.on('error', e => { clearTimeout(timer); rej(e) })
  socket.on('connect', () => socket.write(JSON.stringify({ op: 'hello', id: 1, secret: lock.secret, protocol: lock.protocol }) + '\n' + JSON.stringify({ ...request, id: 2 }) + '\n'))
  socket.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\n').slice(0, -1)) { const m = JSON.parse(line); if (m.op === 'result' && m.id === 2) { clearTimeout(timer); socket.end(); m.ok ? res(m.value) : rej(new Error(m.error)) } }; buffer = buffer.slice(buffer.lastIndexOf('\n') + 1) })
})
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
  const port = await new Promise(done => { const p = createNetServer().listen(0, '127.0.0.1', () => { const f = p.address().port; p.close(() => done(f)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  firstPid = child.pid
  observe('app launched (parked)', { pid: firstPid, scenario })
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === firstPid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await credential()
  await expect.poll(() => hostLock()?.pid ?? null, { timeout: 30_000 }).not.toBe(null)
  const lock = hostLock()
  projectId = (await call('projects.open', { path: projectPath, name: 'V3 S1S2' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'V3 S1S2' }).first().click()
  await page.waitForTimeout(500)
  observe('project selected')

  const catalog = await call('models.list')
  const claudeModel = catalog.find(p => p.provider === 'claude')?.models[0]?.id
  const codexModel = catalog.find(p => p.provider === 'codex')?.models[0]?.id
  observe('models.list resolved', { claudeModel, codexModel })
  const claude1 = await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, title: 'Claude A' })
  const claude2 = await call('tabs.open', { kind: 'agent', provider: 'claude', model: claudeModel, title: 'Claude B' })
  const codex1 = await call('tabs.open', { kind: 'agent', provider: 'codex', model: codexModel, title: 'Codex A' })
  const ids = { claude1: claude1.resourceId, claude2: claude2.resourceId, codex1: codex1.resourceId }
  await call('agents.submit', { agentSessionId: ids.claude1, prompt: 'stream the numbered words' })
  await call('agents.submit', { agentSessionId: ids.claude2, prompt: 'stream the numbered words' })
  await call('agents.submit', { agentSessionId: ids.codex1, prompt: 'synthetic:numbered-stream' })
  observe('3 tabs submitted', ids)

  // Wait until about w030 (30 * 250ms = 7.5s in).
  await new Promise(r => setTimeout(r, 30 * DELAY_MS))
  const before = await hostRequest(lock, { op: 'list' })
  observe('turns under way; runtime host snapshot before restart', { count: before.length })

  if (queuedMode) {
    // 5 prompts queued into claude1 within 1s just before the restart: either via agents.steer
    // ("steers into the turn where the provider can, else queues it behind") or via plain
    // agents.submit, which a busy tab is documented to queue behind as well.
    const method = queuedSubmit ? 'agents.submit' : 'agents.steer'
    for (let i = 0; i < 5; i++) { await call(method, { agentSessionId: ids.claude1, prompt: `queued-${i}` }); await new Promise(r => setTimeout(r, 150)) }
    observe(`5 prompts queued into Claude A via ${method} just before the restart`)
  }

  await call('app.restart', { force: true })
  observe('app.restart requested')
  await expect.poll(() => alive(firstPid), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid !== firstPid && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await credential()
  relaunchedPid = owner.pid
  observe('app relaunched', { pid: relaunchedPid })

  const after = await hostRequest(hostLock(), { op: 'list' }).catch(() => [])
  observe('runtime host snapshot after relaunch', { count: after.length, sameHostPid: hostLock()?.pid === lock.pid })
  assert.equal(hostLock()?.pid, lock.pid, 'the relaunched app should attach to the same runtime host process')

  for (const [name, id] of Object.entries(ids)) {
    try {
      await expect.poll(async () => { try { return (await call('agents.status', { agentSessionId: id })).phase } catch { return null } }, { timeout: 150_000, intervals: [1000] }).toBe('completed')
    } catch (error) {
      const status = await call('agents.status', { agentSessionId: id }).catch(e => ({ error: e.message }))
      const snapshot = await call('agents.snapshot', { agentSessionId: id }).catch(e => ({ error: e.message }))
      const proj = projection(id)
      const lastItems = (proj.items ?? []).slice(-10).map(item => ({ sequence: item.sequence, type: item.data?.type, role: item.data?.role, textLength: item.data?.text?.length, status: item.data?.status }))
      summary.frozenTab = { name, id, status, snapshot, lastItems }
      observe(`${name} did not reach completed`, { status, lastItems })
      throw error
    }
  }
  await new Promise(r => setTimeout(r, 1500))

  const expectedWords = Array.from({ length: WORDS }, (_, i) => 'w' + String(i + 1).padStart(3, '0') + ' ').join('')
  const perTab = {}
  for (const [name, id] of Object.entries(ids)) {
    const proj = projection(id)
    const items = proj.items ?? []
    const assistantTexts = items.filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
    const sequences = items.map(item => item.sequence)
    const strictlyIncreasing = sequences.every((s, i) => i === 0 || s > sequences[i - 1])
    const noDuplicates = new Set(sequences).size === sequences.length
    perTab[name] = { assistantTextCount: assistantTexts.length, firstMatchesExpected: assistantTexts[0] === expectedWords, strictlyIncreasing, noDuplicates, sequenceCount: sequences.length }
    assert.ok(assistantTexts.some(t => t === expectedWords), `${name}: expected assistant text to contain exactly w001..w${WORDS} once in order; got lengths ${assistantTexts.map(t => t.length)}`)
    assert.ok(strictlyIncreasing, `${name}: DB event sequences not strictly increasing`)
    assert.ok(noDuplicates, `${name}: DB event sequences had duplicates`)
  }
  summary.perTab = perTab
  observe('all 3 tabs completed with exact numbered sequence, sequences verified', perTab)

  if (queuedMode) {
    const proj = projection(ids.claude1)
    const assistantTexts = (proj.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
    const acks = assistantTexts.filter(t => t.startsWith('ack:queued-'))
    summary.queuedAcks = acks
    observe('queued prompts answered', { acks })
    assert.equal(acks.length, 5, `expected 5 queued acks, got ${acks.length}`)
    assert.deepEqual(acks, Array.from({ length: 5 }, (_, i) => `ack:queued-${i}`), 'queued prompts were not answered exactly once, in order')
  }

  await page.screenshot({ path: join(output, `${scenario}-tabs-completed.png`) }).catch(() => {})
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  for (const pid of [firstPid, relaunchedPid, owner?.pid]) if (pid && alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /runtime host|reattach|Error|error/i.test(line)).slice(-40) } catch { /* no log */ }
  const lock = hostLock()
  if (lock) await hostRequest(lock, { op: 'shutdown' }).catch(() => {})
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
await writeFile(join(output, `${scenario}-summary.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
