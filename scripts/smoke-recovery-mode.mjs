import { chromium, expect } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Recovery mode (docs/recovery-mode.md), for real on a parked app. The natural relaunch of
// app.restart is switched off (CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH, the failure of 2026-09-25),
// so only the watchdog can bring Conductor back:
//   1. the wizard's app.restart: both relaunch attempts use bogus exes and fail with ENOENT, so the
//      watchdog calls a FAKE recovery agent with the exact error; the fake agent starts the real app;
//      the wizard's continue message carries the recovery report.
//   2. the wizard's app.restart again: attempt 1 bogus, attempt 2 the real electron: relaunched by
//      the watchdog, and the wizard hears which attempt worked.
//   3. a clean quit (WM_CLOSE): the watchdog stands down and nothing comes back.
// Toasts go to <profile>/recovery/toasts.jsonl in a test profile; nothing touches the owner's
// installed app or real Claude CLI.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-recovery-mode.mjs [--keep]

const HARD_TIMEOUT_MS = 9 * 60_000
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-recovery-'))
const output = resolve('artifacts/recovery-mode')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project'), recoveryDir = join(profile, 'recovery')
await mkdir(projectPath, { recursive: true })
const capture = join(root, 'controller-input.txt'), promptLog = join(root, 'prompts.jsonl'), agentLog = join(root, 'agent-calls.jsonl')
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

const fixtures = join(root, 'fixtures')
await mkdir(fixtures, { recursive: true })
// The provider: answers every prompt at once and logs it, so the smoke reads the continue messages.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'recovery-smoke', parent_tool_use_id: null, ...message })
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
    if (process.env.RECOVERY_PROMPT_LOG) appendFileSync(process.env.RECOVERY_PROMPT_LOG, JSON.stringify({ at: new Date().toISOString(), prompt }) + '\\n')
  }
  emit({ type: 'system', subtype: 'init', model })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'ok' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`)
// The recovery agent: records what it was given, starts the real app the way the prompt says, and
// replies with a diagnosis. The next launch's first attempt stays bogus and its second is real.
const fakeAgent = join(fixtures, 'fake-recovery-agent.mjs')
await writeFile(fakeAgent, `
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync } from 'node:fs'
const prompt = readFileSync(0, 'utf8')
const launch = JSON.parse(process.env.CONDUCTOR_RECOVERY_LAUNCH)
appendFileSync(process.env.RECOVERY_AGENT_LOG, JSON.stringify({ at: new Date().toISOString(), argv: process.argv.slice(2), cwd: process.cwd(), diagnosis: process.env.CONDUCTOR_RECOVERY_DIAGNOSIS, prompt }) + '\\n')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.CONDUCTOR_RECOVERY_TEST_EXES = process.env.RECOVERY_NEXT_EXES
const out = openSync(process.env.RECOVERY_APP_LOG, 'a')
const child = spawn(launch.exe, launch.args, { cwd: launch.cwd, env, detached: true, stdio: ['ignore', out, out] })
child.unref()
console.log('**Cause**: synthetic: the relaunch executables did not exist (ENOENT).\\n\\n**What I did**: started ' + launch.exe + ' as pid ' + child.pid + '.\\n\\n**Is Conductor up now**: starting.')
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# Recovery mode smoke\n')
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const electron = createRequire(import.meta.url)('electron')
const bogus1 = join(root, 'missing', 'Conductor-bogus-1.exe'), bogus2 = join(root, 'missing', 'Conductor-bogus-2.exe')
const appLog = join(root, 'app.log')
const env = {
  ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable',
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FIXTURE_DIR: fixtures, RECOVERY_PROMPT_LOG: promptLog, CONDUCTOR_RUNTIME_HOST: '0',
  CONDUCTOR_TEST_PARENT_PID: String(process.pid),
  CONDUCTOR_RECOVERY_WATCHDOG: '1',
  CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH: '1',
  CONDUCTOR_RECOVERY_TEST_EXES: JSON.stringify([bogus1, bogus2]),
  CONDUCTOR_RECOVERY_TIMINGS: JSON.stringify({ pollMs: 500, restartWaitMs: 8000, crashWaitMs: 4000, attemptWaitMs: 45_000, backoffMs: [500, 1000], afterAgentWaitMs: 90_000 }),
  CONDUCTOR_RECOVERY_AGENT_COMMAND: JSON.stringify([process.execPath, fakeAgent]),
  RECOVERY_AGENT_LOG: agentLog, RECOVERY_APP_LOG: appLog, RECOVERY_NEXT_EXES: JSON.stringify([bogus1, electron])
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS; delete env.CONDUCTOR_TEST_STOP_DECISION; delete env.CONDUCTOR_TEST_DIALOGS; delete env.CONDUCTOR_RECOVERY_REAL_AGENT

let owner, projectId
const readOwner = async () => JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const call = async (method, args = {}) => { const r = await request(owner, method, args, projectId ? { projectId } : undefined); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const freePort = () => new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
const lines = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const status = id => call('agents.status', { agentSessionId: id })
const watchdogLog = async () => readFile(join(recoveryDir, 'watchdog.log'), 'utf8').catch(() => '')
const tabCredential = async () => {
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false), { timeout: 30_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'tab did not receive an app-control briefing')
  return { endpoint, token }
}
const watchdogFor = async appPid => {
  await expect.poll(async () => { try { const lock = await readJson(join(recoveryDir, 'watchdog.json')); return lock.appPid === appPid && alive(lock.pid) ? lock.pid : null } catch { return null } }, { timeout: 30_000, intervals: [500] }).not.toBe(null)
  return (await readJson(join(recoveryDir, 'watchdog.json'))).pid
}
/** The app the watchdog (or its agent) brought back: a new pid in control-owner.json that answers. */
const cameBack = async (pidBefore, timeout) => {
  await expect.poll(async () => { try { const next = await readOwner(); if (next.pid === pidBefore || !alive(next.pid)) return null; const r = await request(next, 'tools.list'); return r.status === 200 ? next.pid : null } catch { return null } }, { timeout, intervals: [1000] }).not.toBe(null)
  owner = await readOwner()
}
/** One continue message to the wizard after this point, carrying the recovery note. */
const continueMessage = async before => {
  await expect.poll(async () => (await lines(promptLog)).slice(before).find(p => p.prompt.includes('This wizard tab was brought back'))?.prompt ?? null, { timeout: 45_000, intervals: [500] }).not.toBe(null)
  return (await lines(promptLog)).slice(before).find(p => p.prompt.includes('This wizard tab was brought back')).prompt
}
const pendingReportGone = () => expect.poll(() => existsSync(join(recoveryDir, 'pending-report.json')), { timeout: 30_000, intervals: [500] }).toBe(false)
const reportsOnDisk = async () => (await readdir(recoveryDir)).filter(name => /^recovery-.*\.json$/.test(name)).sort()

const summary = { root, profile, build: resolve('out/main/index.js') }
const hard = setTimeout(() => { observe('hard timeout: giving up'); console.log(JSON.stringify({ ...summary, observations }, null, 2)); process.exit(1) }, HARD_TIMEOUT_MS)
let failed = null, browser
const watchdogs = new Set()
try {
  assert.ok(existsSync(resolve('out/main/recovery-watchdog.js')), 'out/main/recovery-watchdog.js is missing: run npm run build first')
  const port = await freePort()
  const log = openSync(appLog, 'a')
  const first = spawn(electron, [`--remote-debugging-port=${port}`, resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  await expect.poll(async () => { try { return (await readOwner()).pid === first.pid } catch { return false } }, { timeout: 60_000, intervals: [500] }).toBe(true)
  owner = await readOwner()
  observe('app launched (parked)', { pid: first.pid })
  watchdogs.add(await watchdogFor(first.pid))
  const armed = await readJson(join(recoveryDir, 'armed.json'))
  assert.equal(armed.kind, 'running'); assert.equal(armed.appPid, first.pid)
  assert.equal(armed.launch.exe, electron)
  observe('watchdog armed', { watchdog: [...watchdogs], launch: armed.launch })

  projectId = (await call('projects.open', { path: projectPath, name: 'Recovery smoke' })).id
  await expect.poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true } catch { return false } }, { timeout: 30_000, intervals: [500] }).toBe(true)
  const page = browser.contexts().flatMap(c => c.pages()).find(c => c.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Recovery smoke' }).first().click()
  await page.waitForTimeout(500)
  const wizardTab = await call('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Wizard' })
  const wizard = wizardTab.resourceId ?? wizardTab.agentSessionId
  await page.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC WIZARD START', settings)
  }, wizard)
  let wizardAuth = await tabCredential()
  await expect.poll(async () => (await status(wizard)).phase, { timeout: 20_000, intervals: [250] }).toBe('completed')
  await browser.close().catch(() => {}); browser = null
  observe('wizard ready', { wizard })

  // 1. Relaunch fails twice -> the fake agent is called with the error and brings Conductor back.
  let before = (await lines(promptLog)).length
  const pid1 = owner.pid
  await request(wizardAuth, 'app.restart', {}).catch(error => observe('app.restart transport ended', { error: String(error) }))
  await expect.poll(() => alive(pid1), { timeout: 60_000 }).toBe(false)
  observe('old app exited; no natural relaunch', { pid: pid1 })
  await cameBack(pid1, 150_000)
  observe('Conductor is back (agent)', { pid: owner.pid })
  const agentCalls = await lines(agentLog)
  assert.equal(agentCalls.length, 1, `the recovery agent was called ${agentCalls.length} times`)
  const agentCall = agentCalls[0]
  assert.match(agentCall.prompt, /## The exact error/)
  assert.ok(agentCall.prompt.includes(`#1 ${bogus1}: spawn ${bogus1} ENOENT`), 'the agent prompt lacks attempt 1 error')
  assert.ok(agentCall.prompt.includes(`#2 ${bogus2}: spawn ${bogus2} ENOENT`), 'the agent prompt lacks attempt 2 error')
  assert.ok(agentCall.prompt.includes('after app.restart no new Conductor answered app control'), 'the agent prompt lacks the reason')
  assert.ok(agentCall.argv.includes('-p') && agentCall.argv.includes('--disallowedTools'), 'the agent was not called with the headless allowlist arguments')
  const message1 = await continueMessage(before)
  observe('wizard continue message (agent recovery)', { message: message1 })
  assert.match(message1, /Conductor restarted \(app\.restart by this wizard/)
  assert.match(message1, /Conductor did not come back by itself after this stop \(after app\.restart no new Conductor answered app control within \d+ s of pid \d+ exiting\); recovery mode's relaunch failed 2 times and the recovery agent brought it back\. Recovery report: .*recovery-.*\.md\./)
  await pendingReportGone()
  const [report1Name] = await reportsOnDisk()
  const report1 = await readJson(join(recoveryDir, report1Name))
  assert.equal(report1.outcome, 'agent-recovered'); assert.equal(report1.readyPid, owner.pid); assert.equal(report1.attempts.length, 2)
  assert.deepEqual(report1.attempts.map(a => a.error), [`spawn ${bogus1} ENOENT`, `spawn ${bogus2} ENOENT`])
  const markdown1 = await readFile(report1.reportPath, 'utf8')
  assert.match(markdown1, /# Recovery agent diagnosis[\s\S]*synthetic: the relaunch executables did not exist[\s\S]*# Conductor recovery/)
  const toasts1 = await lines(join(recoveryDir, 'toasts.jsonl'))
  assert.deepEqual(toasts1.map(t => t.title), ['Conductor is down', 'Conductor was brought back'])
  summary.agentRecovery = { report: report1, message: message1, toasts: toasts1, agentPromptHead: agentCall.prompt.slice(0, 1500) }
  watchdogs.add(await watchdogFor(owner.pid))

  // 2. Attempt 1 bogus, attempt 2 the real electron: the watchdog itself brings it back.
  await expect.poll(async () => (await status(wizard)).phase, { timeout: 30_000, intervals: [500] }).toBe('completed')
  before = (await lines(promptLog)).length
  const pid2 = owner.pid
  // The relaunched app briefs the resumed wizard with its own control endpoint.
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes(owner.endpoint)).catch(() => false), { timeout: 30_000, intervals: [500] }).toBe(true)
  wizardAuth = await tabCredential()
  await request(wizardAuth, 'app.restart', {}).catch(error => observe('app.restart transport ended', { error: String(error) }))
  await expect.poll(() => alive(pid2), { timeout: 60_000 }).toBe(false)
  await cameBack(pid2, 120_000)
  observe('Conductor is back (watchdog relaunch)', { pid: owner.pid })
  const message2 = await continueMessage(before)
  observe('wizard continue message (relaunch)', { message: message2 })
  assert.match(message2, /recovery mode relaunched it \(attempt 2\)\. Recovery report: /)
  assert.equal((await lines(agentLog)).length, 1, 'the agent was called although the relaunch worked')
  await pendingReportGone()
  const report2 = await readJson(join(recoveryDir, (await reportsOnDisk()).at(-1)))
  assert.equal(report2.outcome, 'relaunched')
  assert.deepEqual(report2.attempts.map(a => a.ready), [false, true])
  assert.equal(report2.attempts[1].exe, electron)
  summary.relaunch = { report: report2, message: message2 }
  const watchdog3 = await watchdogFor(owner.pid)
  watchdogs.add(watchdog3)

  // 3. Clean quit: the watchdog stands down, nothing comes back.
  const pid3 = owner.pid, toastsBefore = (await lines(join(recoveryDir, 'toasts.jsonl'))).length
  execFileSync('taskkill.exe', ['/pid', String(pid3)], { stdio: 'ignore' })
  await expect.poll(() => alive(pid3), { timeout: 60_000 }).toBe(false)
  await expect.poll(async () => (await readJson(join(recoveryDir, 'armed.json'))).kind, { timeout: 5000 }).toBe('quit')
  await expect.poll(() => alive(watchdog3), { timeout: 15_000 }).toBe(false)
  await new Promise(r => setTimeout(r, 15_000))
  // A clean quit removes control-owner.json; a relaunch would have written a new one.
  const afterQuit = await readOwner().catch(() => null)
  assert.ok(!afterQuit || afterQuit.pid === pid3 || !alive(afterQuit.pid), `something relaunched Conductor after a clean quit (pid ${afterQuit?.pid})`)
  assert.match(await watchdogLog(), new RegExp(`\\[${watchdog3} watching ${pid3}\\] done: clean-quit`))
  assert.equal((await lines(join(recoveryDir, 'toasts.jsonl'))).length, toastsBefore, 'a clean quit raised a toast')
  assert.equal((await reportsOnDisk()).length, 2)
  observe('clean quit: watchdog stood down', { watchdog: watchdog3 })
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  clearTimeout(hard)
  if (browser) await browser.close().catch(() => {})
  try { const last = await readOwner(); if (last.pid !== undefined && alive(last.pid)) execFileSync('taskkill.exe', ['/pid', String(last.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  for (const pid of watchdogs) if (alive(pid)) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  summary.watchdogLog = (await watchdogLog()).split('\n').slice(-60)
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /recovery|watchdog|restart|Error/i.test(line)).slice(-40) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await writeFile(join(output, `recovery-mode-${stamp}.json`), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ result: result.result, evidence: join(output, `recovery-mode-${stamp}.json`) }))
if (!keep && !failed) { await new Promise(r => setTimeout(r, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
