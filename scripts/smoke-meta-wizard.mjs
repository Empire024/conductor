import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The meta-wizard (docs/meta-wizard.md) for real, on a parked app and a test profile:
//   (b) a waiter declares agents.await on a coworker that then completes without messaging it; the
//       app's own quiet sweep is held off (CONDUCTOR_TEST_AWAIT_SWEEP_MS), so only the meta-wizard
//       can notice, and it steers the waiter with the coworker's state and last answer;
//   (a) the app is killed (taskkill /T /F) while a tab is mid-turn; the meta-wizard starts it again
//       with the launch spec it was given and steers the cut tab to continue.
// Nothing touches the owner's installed app, its profile or its scheduled task; toasts go to
// <profile>/meta-wizard/toasts.jsonl.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-meta-wizard.mjs [--keep]   (after npm run build)

const HARD_TIMEOUT_MS = 8 * 60_000
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-meta-wizard-'))
const output = resolve('artifacts/meta-wizard')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project'), stateDir = join(profile, 'meta-wizard')
await mkdir(projectPath, { recursive: true })
const capture = join(root, 'control-input.txt'), promptLog = join(root, 'prompts.jsonl')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

const fixtures = join(root, 'fixtures')
await mkdir(fixtures, { recursive: true })
// The provider: logs every prompt; a prompt with HOLD never finishes (a turn a crash cuts), any
// other prompt is answered at once.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'meta-wizard-smoke', parent_tool_use_id: null, ...message })
const model = 'claude-fable-5-1'
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
    appendFileSync(process.env.META_WIZARD_PROMPT_LOG, JSON.stringify({ at: new Date().toISOString(), prompt }) + '\\n')
  }
  emit({ type: 'system', subtype: 'init', model })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  if (typeof prompt === 'string' && prompt.includes('HOLD')) return
  const text = typeof prompt === 'string' && prompt.includes('COWORKER TASK') ? 'Coworker result: 42 rows reconciled' : 'ok'
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# Meta-wizard smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const electron = createRequire(import.meta.url)('electron')
const appLog = join(root, 'app.log')
const appEnv = {
  CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable',
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FIXTURE_DIR: fixtures, META_WIZARD_PROMPT_LOG: promptLog, CONDUCTOR_RUNTIME_HOST: '0',
  CONDUCTOR_TEST_PARENT_PID: String(process.pid),
  // Only the meta-wizard may bring the app back or wake the waiter.
  CONDUCTOR_RECOVERY_WATCHDOG: '0', CONDUCTOR_TEST_AWAIT_SWEEP_MS: String(3_600_000)
}
const env = { ...process.env, ...appEnv }
for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_LIVE_TESTS', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_TEST_STOP_DECISION', 'CONDUCTOR_TEST_DIALOGS', 'CONDUCTOR_RECOVERY_REAL_AGENT']) delete env[key]

let owner, projectId
const readOwner = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const call = async (method, args = {}) => { const r = await request(owner, method, args, projectId ? { projectId } : undefined); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const freePort = () => new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
const lines = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const status = id => call('agents.status', { agentSessionId: id })
const journal = () => lines(join(stateDir, 'journal.jsonl'))
const tabCredential = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'tab did not receive an app-control briefing')
  return { endpoint, token }
}

const summary = { root, profile, build: resolve('out/main/index.js') }
let failed = null, browser, metaWizard
const hard = setTimeout(() => { observe('hard timeout: giving up'); failed = new Error('hard timeout'); void finish() }, HARD_TIMEOUT_MS)
try {
  const port = await freePort()
  const log = openSync(appLog, 'a')
  const first = spawn(electron, [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  await expect.poll(async () => { try { return (await readOwner()).pid === first.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await readOwner()
  observe('app launched (parked)', { pid: first.pid })
  projectId = (await call('projects.open', { path: projectPath, name: 'Meta-wizard smoke' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Meta-wizard smoke' }).first().click()
  await page.waitForTimeout(500)
  const submit = (id, prompt) => page.evaluate(async ([id, prompt]) => {
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, model: 'claude-fable-5-1' }
    await window.conductor.structured.submit(id, prompt, settings)
  }, [id, prompt])
  const open = async title => { const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title, focus: false }); return tab.resourceId ?? tab.agentSessionId }

  // The waiter: its first prompt carries its own app-control credential, so it can declare a wait.
  const waiter = await open('Waiter')
  await submit(waiter, 'WAITER START')
  await expect.poll(async () => (await status(waiter)).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  const waiterAuth = await tabCredential()
  const coworker = await open('Quiet coworker')
  const declared = await request(waiterAuth, 'agents.await', { agents: [coworker], reason: 'the reconciliation result', timeoutMinutes: 600 })
  assert.equal(declared.status, 200, JSON.stringify(declared.body))
  await submit(coworker, 'COWORKER TASK: reconcile, then stop without messaging anyone')
  await expect.poll(async () => (await status(coworker)).phase, { timeout: 30_000, intervals: [250] }).toBe('completed')
  observe('waiter awaits a coworker that completed without messaging', { waiter, coworker })
  // The cut tab for (a): its turn never finishes on its own.
  const cut = await open('Mid-turn')
  await submit(cut, 'HOLD this turn until Conductor dies')
  await expect.poll(async () => (await status(cut)).phase, { timeout: 30_000, intervals: [250] }).toBe('running')
  await browser.close().catch(() => {}); browser = null
  observe('mid-turn tab running', { cut })

  // The meta-wizard, as the scheduled task would run it, on the test profile with fast timings.
  const timings = { tickMs: 3000, recheckMs: 2000, awaitQuietMs: 6000, crashGraceMs: 4000, resumeDelayMs: 8000, startWaitMs: 120_000, probeTimeoutMs: 10_000 }
  const launch = { exe: electron, args: [resolve('out/main/index.js')], cwd: resolve('.') }
  const metaLog = openSync(join(root, 'meta-wizard.log'), 'a')
  metaWizard = spawn(process.execPath, [resolve('scripts/meta-wizard.mjs'), 'run', '--user-data', profile, '--timings', JSON.stringify(timings), '--launch', JSON.stringify(launch), '--launch-env', JSON.stringify(appEnv)], { stdio: ['ignore', metaLog, metaLog], windowsHide: true })
  closeSync(metaLog)
  observe('meta-wizard started', { pid: metaWizard.pid })

  // (b) The waiter is steered with the coworker's state and last answer.
  const steered = async (id, pattern, timeout) => {
    await expect.poll(async () => (await journal()).some(entry => entry.event === 'steer' && entry.agentSessionId === id && pattern.test(entry.prompt)), { timeout, intervals: [1000] }).toBe(true)
    return (await journal()).find(entry => entry.event === 'steer' && entry.agentSessionId === id && pattern.test(entry.prompt))
  }
  const quiet = await steered(waiter, /gone quiet without messaging you/, 60_000)
  assert.equal(quiet.kind, 'await-quiet')
  assert.match(quiet.prompt, new RegExp(`"Quiet coworker" \\(${coworker}\\).*: completed; last answer: "Coworker result: 42 rows reconciled"`))
  await expect.poll(async () => (await lines(promptLog)).some(entry => entry.prompt.includes('[Meta-wizard]') && entry.prompt.includes('Coworker result: 42 rows reconciled')), { timeout: 30_000, intervals: [500] }).toBe(true)
  observe('(b) waiter steered', { delivery: quiet.delivery })
  summary.quietSteer = quiet

  // (a) Kill the app mid-turn; the meta-wizard starts it and resumes the cut tab.
  await expect.poll(async () => (JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8').catch(() => '{}')).working ?? []).some(tab => tab.agentSessionId === cut), { timeout: 30_000, intervals: [500] }).toBe(true)
  const pid1 = owner.pid
  execFileSync('taskkill.exe', ['/pid', String(pid1), '/T', '/F'], { stdio: 'ignore' })
  await expect.poll(() => alive(pid1), { timeout: 30_000 }).toBe(false)
  observe('(a) app killed', { pid: pid1 })
  await expect.poll(async () => { try { const next = await readOwner(); if (next.pid === pid1 || !alive(next.pid)) return null; return (await request(next, 'tools.list')).status === 200 ? next.pid : null } catch { return null } }, { timeout: 150_000, intervals: [1000] }).not.toBe(null)
  owner = await readOwner()
  // The meta-wizard polls every 2 s for the app it started; the smoke may see it answer first.
  await expect.poll(async () => (await journal()).some(entry => entry.event === 'started' && entry.pid === owner.pid), { timeout: 30_000, intervals: [500] }).toBe(true)
  assert.ok((await journal()).some(entry => entry.event === 'start' && entry.exe === electron), 'the meta-wizard did not start the app')
  observe('(a) app is back, started by the meta-wizard', { pid: owner.pid })
  const resume = await steered(cut, /Conductor restarted .* and your turn was cut while it was running/, 90_000)
  assert.equal(resume.kind, 'resume')
  await expect.poll(async () => (await lines(promptLog)).some(entry => entry.prompt.includes('[Meta-wizard] Conductor restarted')), { timeout: 30_000, intervals: [500] }).toBe(true)
  await expect.poll(async () => (await status(cut)).phase, { timeout: 30_000, intervals: [500] }).toBe('completed')
  observe('(a) cut tab resumed', { delivery: resume.delivery })
  summary.resumeSteer = resume
  const toasts = await lines(join(stateDir, 'toasts.jsonl'))
  assert.ok(toasts.some(toast => toast.title === 'Conductor was brought back'), `toasts: ${JSON.stringify(toasts)}`)
  const statusOut = JSON.parse(execFileSync(process.execPath, [resolve('scripts/meta-wizard.mjs'), 'status', '--json', '--user-data', profile], { encoding: 'utf8' }))
  assert.equal(statusOut.supervisor.running, true)
  assert.equal(statusOut.conductor.pid, owner.pid)
  summary.status = { ...statusOut, recent: statusOut.recent.map(entry => ({ at: entry.at, event: entry.event })) }
  const allText = await readFile(join(stateDir, 'journal.jsonl'), 'utf8')
  assert.ok(!allText.includes(owner.token), 'the journal holds the owner token')
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
}
await finish()

async function finish() {
  clearTimeout(hard)
  if (browser) await browser.close().catch(() => {})
  if (metaWizard?.pid && alive(metaWizard.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(metaWizard.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { const last = await readOwner(); if (alive(last.pid)) execFileSync('taskkill.exe', ['/pid', String(last.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  summary.journal = (await journal()).map(entry => ({ at: entry.at, event: entry.event, kind: entry.kind, agentSessionId: entry.agentSessionId, reason: entry.reason, action: entry.action, error: entry.error }))
  try { summary.metaWizardLog = readFileSync(join(root, 'meta-wizard.log'), 'utf8').split('\n').slice(-30) } catch { /* none */ }
  const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFile(join(output, `meta-wizard-${stamp}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ result: result.result, evidence: join(output, `meta-wizard-${stamp}.json`) }))
  if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
  process.exit(failed ? 1 : 0)
}
