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

// FX25 resume-after-any-restart: a restart the wizard did NOT start brings the wizard back with
// "Conductor restarted (<reason>, <old> -> <new>); continue." and resumes its coworker whose turn
// the restart cut. A parked app (fake Claude, wand on) with an idle wizard waiting on a coworker
// whose turn is running goes through three restarts:
//   1. crash relaunch: taskkill /F, then a plain relaunch of the parked app;
//   2. the owner credential's app.restart({force:true}) (no runtime host in a test profile, so the
//      coworker's turn is cut);
//   3. the owner credential's app.restart({force:false}) with running work: the quit dialog is answered
//      "Stop work" (a test profile's headless answer), so nobody is resumed.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx25-any-restart.mjs [--keep]

const HARD_TIMEOUT_MS = 9 * 60_000
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-fx25-'))
const output = resolve('artifacts/fx25')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
const capture = join(root, 'controller-input.txt'), promptLog = join(root, 'prompts.jsonl')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// Answers every prompt at once, except one containing HANG, whose turn stays running until the
// process dies. Every prompt is logged, so the smoke sees exactly what each restart sent.
const fixtures = join(root, 'fixtures')
await mkdir(fixtures, { recursive: true })
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'fx25-smoke', parent_tool_use_id: null, ...message })
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
  if (typeof prompt === 'string') {
    if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
    if (process.env.FX25_PROMPT_LOG) appendFileSync(process.env.FX25_PROMPT_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, prompt }) + '\\n')
  }
  emit({ type: 'system', subtype: 'init', model })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  if (typeof prompt === 'string' && prompt.includes('HANG') && !prompt.includes('restarted')) return
  const text = typeof prompt === 'string' && prompt.includes('restarted') ? 'continue-ack' : 'Short done.'
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# FX25 any-restart smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FIXTURE_DIR: fixtures, FX25_PROMPT_LOG: promptLog, CONDUCTOR_RUNTIME_HOST: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS; delete env.CONDUCTOR_TEST_STOP_DECISION; delete env.CONDUCTOR_TEST_DIALOGS

let owner, projectId
const readOwner = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const call = async (method, args = {}) => { const r = await request(owner, method, args, projectId ? { projectId } : undefined); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const as = async (auth, method, args = {}) => { const r = await request(auth, method, args); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const freePort = () => new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
const prompts = async () => (await readFile(promptLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const status = id => call('agents.status', { agentSessionId: id })
const tabCredential = async () => {
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false), { timeout: 30_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'tab did not receive an app-control briefing')
  return { endpoint, token }
}
const appLog = join(root, 'app.log')
const launch = async () => {
  const port = await freePort()
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  await expect.poll(async () => { try { return (await readOwner()).pid === child.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await readOwner()
  return { pid: child.pid, port }
}
/** Waits for the process that app.restart relaunched. */
const relaunched = async pidBefore => {
  await expect.poll(() => alive(pidBefore), { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => { try { const next = await readOwner(); return next.pid !== pidBefore && alive(next.pid) ? next.pid : null } catch { return null } }, { timeout: 60_000, intervals: [500] }).not.toBe(null)
  owner = await readOwner()
}
const restartIntentRow = () => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get('restartIntent')?.value ?? null } finally { db.close() }
}

const summary = { root, profile, build: resolve('out/main/index.js') }
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let failed = null, browser
try {
  const first = await launch()
  observe('app launched (parked)', { pid: first.pid })
  projectId = (await call('projects.open', { path: projectPath, name: 'FX25 any restart' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${first.port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'FX25 any restart' }).first().click()
  await page.waitForTimeout(500)

  // The wizard: wand on, one settled turn, its own scoped credential.
  const wizardTab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Wizard' })
  const wizard = wizardTab.resourceId ?? wizardTab.agentSessionId
  await page.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC WIZARD START', settings)
  }, wizard)
  const wizardAuth = await tabCredential()
  await expect.poll(async () => (await status(wizard)).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
  observe('wizard ready', { wizard })

  // Its coworker, dispatched by the wizard (so the control link names it), with a turn that hangs.
  const workerTab = await as(wizardAuth, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Coworker', focus: false })
  const worker = workerTab.resourceId ?? workerTab.agentSessionId
  const hang = async () => {
    await call('agents.submit', { agentSessionId: worker, prompt: 'SYNTHETIC HANG until the restart' })
    await expect.poll(async () => (await status(worker)).phase, { timeout: 20_000, intervals: [250] }).toBe('running')
    await expect.poll(async () => (await status(wizard)).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
  }
  await hang()
  observe('coworker running, wizard idle waiting on it', { worker })

  /** One restart kind: the wizard gets exactly one continue message naming the reason, the coworker is resumed. */
  const expectResumed = async (label, reason) => {
    const before = (await prompts()).length
    await expect.poll(async () => {
      const sent = (await prompts()).slice(before)
      return sent.some(p => p.prompt.includes('This wizard tab was brought back')) && sent.some(p => p.prompt.includes('The restart cut your turn'))
    }, { timeout: 30_000, intervals: [500] }).toBe(true)
    await new Promise(r => setTimeout(r, 3000))
    const sent = (await prompts()).slice(before)
    const toWizard = sent.filter(p => p.prompt.includes('This wizard tab was brought back'))
    const toWorker = sent.filter(p => p.prompt.includes('The restart cut your turn'))
    observe(`${label}: messages`, { toWizard: toWizard.map(p => p.prompt.slice(0, 400)), toWorker: toWorker.map(p => p.prompt.slice(0, 400)) })
    assert.equal(toWizard.length, 1, `${label}: the wizard got ${toWizard.length} continue messages`)
    assert.equal(toWorker.length, 1, `${label}: the coworker got ${toWorker.length} resume messages`)
    assert.match(toWizard[0].prompt, new RegExp(`\\[Conductor\\] Conductor restarted \\(${reason}.*, \\d+\\.\\d+\\.\\d+\\S* -> \\d+\\.\\d+\\.\\d+\\S*\\); continue\\.`))
    assert.match(toWizard[0].prompt, /and 1 coworker whose turn was cut was resumed too/)
    await expect.poll(async () => (await status(wizard)).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
    await expect.poll(async () => (await status(worker)).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
    summary[label] = { wizardMessage: toWizard[0].prompt.slice(0, 400), workerMessage: toWorker[0].prompt.slice(0, 400) }
  }

  // 1. Crash relaunch.
  await expect.poll(() => { const row = restartIntentRow(); return row ? JSON.parse(row) : null }, { timeout: 15_000, intervals: [500] })
    .toMatchObject({ kind: 'running', wizards: [wizard], coworkers: [worker] })
  summary.liveRecordBeforeCrash = JSON.parse(restartIntentRow())
  observe('live restart record before the crash', summary.liveRecordBeforeCrash)
  await browser.close().catch(() => {}); browser = null
  execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' })
  await expect.poll(() => alive(owner.pid), { timeout: 15_000 }).toBe(false)
  await new Promise(r => setTimeout(r, 1500))
  const second = await launch()
  observe('relaunched after the crash', { pid: second.pid })
  await expectResumed('crash', 'crash relaunch')

  // 2. The owner credential's forced restart (not the wizard's): the cut coworker is resumed too.
  await hang()
  await new Promise(r => setTimeout(r, 1000))
  const pidBeforeForce = owner.pid
  await call('app.restart', { force: true })
  await relaunched(pidBeforeForce)
  observe('relaunched by the owner credential app.restart({force:true})', { pid: owner.pid })
  await expectResumed('ownerRestart', 'restart')

  // 3. The owner's restart answered "Stop work": nobody is resumed.
  await hang()
  const before = (await prompts()).length
  const pidBeforeStop = owner.pid
  await call('app.restart', { force: false })
  await relaunched(pidBeforeStop)
  observe('relaunched by the owner restart answered "Stop work"', { pid: owner.pid })
  await new Promise(r => setTimeout(r, 12_000))
  const afterStop = (await prompts()).slice(before)
  summary.stopWork = { promptsAfterRestart: afterStop.map(p => p.prompt.slice(0, 400)), wizard: (await status(wizard)).phase, worker: (await status(worker)).phase }
  observe('"Stop work": prompts after the restart', summary.stopWork)
  assert.equal(afterStop.filter(p => p.prompt.includes('restarted')).length, 0, '"Stop work" still resumed a conversation')
  assert.equal(restartIntentRow() && JSON.parse(restartIntentRow()).kind, 'running', 'the launch did not consume the restart record')
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.close().catch(() => {})
  if (owner?.pid && alive(owner.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(owner.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /wizard|restart|resumed|Coworker|Error|error/i.test(line)).slice(-60) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await writeFile(join(output, `any-restart-${stamp}.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ result: result.result, evidence: join(output, `any-restart-${stamp}.json`) }))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
