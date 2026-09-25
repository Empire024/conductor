// FX34 local-model-swarms: a real local swarm in a parked Conductor. A local controller tab splits
// a small test-writing task between two local coworkers it opens itself (tabs.open through its
// conductor tool), each writes and runs node:test tests for half of a tiny module in a temp
// project and reports back with agents.report; the controller merges their results. Everything
// runs on the one llama.cpp server this machine already runs (never a second one, never stopped
// here); the coworkers' requests queue on it. Records the wall time and the outcome as it is:
// the swarm mechanics (coworkers opened on the same model and no wider grants, reports delivered,
// one server) are asserted; whether the small model's tests pass is reported, and checked by
// running node --test on the host afterwards.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-local-swarm.mjs [--build] [--model local/dolphin-x1-8b]
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback }
const model = flag('model', 'local/dolphin-x1-8b')
const budgetMinutes = Number(flag('minutes', '40'))
if (argv.includes('--build')) {
  const built = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0) throw new Error('electron-vite build failed')
}
const output = resolve('artifacts/local-swarm')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-swarm-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(join(projectPath, 'test'), { recursive: true })
await writeFile(join(projectPath, 'package.json'), JSON.stringify({ name: 'swarm-fixture', private: true, type: 'module' }, null, 2) + '\n')
await writeFile(join(projectPath, 'math.js'), [
  'export function add(a, b) { return a + b }',
  'export function subtract(a, b) { return a - b }',
  'export function multiply(a, b) { return a * b }',
  "export function divide(a, b) { if (b === 0) throw new Error('division by zero'); return a / b }",
  ''
].join('\n'))
await writeFile(join(projectPath, 'README.md'), '# math.js\n\nFour arithmetic functions. Tests go in test/ and run with `node --test`.\n')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const sleep = ms => new Promise(done => setTimeout(done, ms))
const poll = async (read, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const value = await read(); if (value) return value; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }

const coworkerPrompt = (file, functions, extra) => `In this workspace, math.js exports ${functions.join(' and ')}. Write the file ${file} using node:test and node:assert/strict (import { test } from 'node:test'; import assert from 'node:assert/strict'; import { ${functions.join(', ')} } from '../math.js') with at least two tests for each of ${functions.join(' and ')}${extra}. Run it with run_command: node --test ${file}. If it fails, fix ${file} (never change math.js) and run it again. Then call the conductor tool with method "agents.report" and args {"text": "${file}: <how many tests, pass or fail>"}. That report is how your controller learns the result.`
const controllerPrompt = [
  'You are the controller of a small local swarm of coworkers. Use the conductor tool for these steps, in order:',
  `1. Call conductor with method "tabs.open" and args {"title": "add and subtract tests", "prompt": ${JSON.stringify(coworkerPrompt('test/add.test.js', ['add', 'subtract'], ''))}}.`,
  `2. Call conductor with method "tabs.open" and args {"title": "multiply and divide tests", "prompt": ${JSON.stringify(coworkerPrompt('test/multiply.test.js', ['multiply', 'divide'], ', including that divide throws for division by zero'))}}.`,
  '3. Reply "Dispatched two coworkers." and end your turn. Do not write any tests yourself.',
  'Each coworker reports back later as a new message to you. When a report arrives and you have not yet received both, reply "Waiting for the other coworker." When you have both reports, run node --test with run_command and reply with a short merged summary: each test file, its number of tests, and whether the whole suite passes.'
].join('\n')

let app
const killElectron = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else app.process().kill('SIGKILL') } catch { /* already gone */ } }
const watchdog = setTimeout(() => { console.error(`FAIL smoke-local-swarm exceeded ${budgetMinutes + 5} min`); killElectron(); process.exit(1) }, (budgetMinutes + 5) * 60_000)
watchdog.unref()
const checks = []
const check = label => { checks.push(label); console.log('PASS ' + label) }
let failed = false
const report = { at: new Date().toISOString(), model, project: projectPath }
const started = Date.now()
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  const page = await app.firstWindow()
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 90_000)
  const call = async (method, args = {}, projectId) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }), signal: AbortSignal.timeout(60_000) })
    const body = await response.json(); if (response.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  report.serversBefore = await call('local.servers').catch(() => null)
  console.log('local servers:', JSON.stringify(report.serversBefore))
  const project = await call('projects.open', { path: projectPath, name: 'Swarm smoke' })
  await page.locator('.project-row').filter({ hasText: 'Swarm smoke' }).first().click().catch(error => console.log('project row:', error.message))
  const args = { kind: 'agent', provider: 'local', model, permission: 'accept-edits', exactPermission: true, title: 'Swarm controller' }
  const controllerTab = await call('tabs.open', args, project.id).catch(async error => {
    if (!/did not acknowledge/.test(String(error))) throw error
    await sleep(10_000)
    return call('tabs.open', args, project.id)
  })
  const controller = controllerTab.resourceId
  report.controller = controller
  await call('agents.submit', { agentSessionId: controller, prompt: controllerPrompt })
  const snapshot = id => call('agents.snapshot', { agentSessionId: id })
  const texts = (items, role) => (items ?? []).filter(item => item.data?.type === 'text' && item.data.role === role).map(item => item.data.text)
  const coworkersOf = async () => (await call('agents.list', {}, project.id)).filter(entry => entry.provider === 'local' && entry.agentSessionId !== controller)
  const deadline = budgetMinutes * 60_000
  // The coworkers appear, opened by the controller itself.
  const coworkers = await poll(async () => { const found = await coworkersOf(); return found.length >= 2 ? found : null }, 12 * 60_000, 5000).catch(async error => {
    const state = await snapshot(controller)
    report.controllerAnswer = texts(state.items, 'assistant').join('\n').slice(0, 2000)
    report.controllerTools = (state.items ?? []).filter(item => item.data?.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status, input: JSON.stringify(item.data.input ?? null).slice(0, 300), output: String(item.data.output ?? '').slice(0, 300) }))
    throw new Error(`the controller did not open two coworkers (${error.message}); it answered: ${report.controllerAnswer.slice(0, 400)}`)
  })
  report.coworkersOpenedAfterSeconds = Math.round((Date.now() - started) / 1000)
  report.coworkers = coworkers.map(entry => ({ agentSessionId: entry.agentSessionId, title: entry.title }))
  check(`The local controller opened ${coworkers.length} local coworkers itself after ${report.coworkersOpenedAfterSeconds} s: ${coworkers.map(entry => entry.title).join(', ')}`)
  for (const entry of coworkers) {
    const state = await snapshot(entry.agentSessionId)
    assert.equal(state.settings.model, model, 'a coworker runs on its opener\'s model')
    assert.ok(['accept-edits', 'read-only'].includes(state.settings.permission), 'no wider than its opener')
    assert.ok(!state.settings.localGit && !state.settings.localResearch, 'no grant its opener lacks')
  }
  check(`Each coworker runs on ${model}, at the opener's permission or less, with no grant the opener lacks`)
  const serversDuring = await call('local.servers').catch(() => [])
  report.serversDuring = serversDuring
  assert.equal(serversDuring.length, 1, 'one model server for the whole swarm')
  const onServer = new Set((serversDuring[0]?.conversations ?? []).map(conversation => conversation.agentSessionId))
  assert.ok([controller, ...coworkers.map(entry => entry.agentSessionId)].every(id => onServer.has(id)), 'controller and coworkers share it')
  check('Controller and both coworkers share the one running llama.cpp server')

  // Both reports reach the controller and it merges them.
  const settled = phase => ['completed', 'failed', 'interrupted', 'idle'].includes(phase)
  const final = await poll(async () => {
    const state = await snapshot(controller)
    const users = (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user')
    const reports = users.filter(item => item.data.origin && item.data.origin.agentSessionId !== controller && coworkers.some(entry => entry.agentSessionId === item.data.origin.agentSessionId))
    const idle = await Promise.all(coworkers.map(entry => call('agents.status', { agentSessionId: entry.agentSessionId }).then(status => settled(status.phase))))
    report.progress = { reports: reports.length, controllerPhase: state.phase, coworkersSettled: idle.filter(Boolean).length, minutes: Math.round((Date.now() - started) / 60_000) }
    if (reports.length >= 2 && settled(state.phase) && !(state.queuedPrompts?.length)) return { state, reports }
    // A coworker that settled without reporting leaves nothing to wait for.
    if (idle.every(Boolean) && reports.length < 2 && settled(state.phase) && Date.now() - started > 60_000) return { state, reports, missing: true }
    return null
  }, deadline, 10_000)
  report.wallSeconds = Math.round((Date.now() - started) / 1000)
  report.reports = final.reports.map(item => ({ from: item.data.origin?.label, text: item.data.text.slice(0, 500) }))
  report.controllerAnswers = texts(final.state.items, 'assistant').map(text => text.slice(0, 1500))
  for (const entry of coworkers) {
    const state = await snapshot(entry.agentSessionId)
    entry.answer = texts(state.items, 'assistant').join('\n').slice(-800)
    entry.tools = (state.items ?? []).filter(item => item.data?.type === 'tool').map(item => `${item.data.name}:${item.data.status}${item.data.exitCode !== undefined ? '(' + item.data.exitCode + ')' : ''}`)
  }
  report.coworkerRuns = coworkers.map(entry => ({ title: entry.title, tools: entry.tools, answer: entry.answer }))
  console.log('reports:', JSON.stringify(report.reports, null, 1))
  console.log('controller answers:', JSON.stringify(report.controllerAnswers.slice(-2), null, 1))
  if (final.missing) console.log(`NOTE only ${final.reports.length} of 2 coworkers reported`)
  assert.ok(final.reports.length >= 1, 'at least one coworker report reached the controller')
  check(`${final.reports.length} coworker report(s) reached the controller as messages; the swarm settled after ${report.wallSeconds} s`)

  // The merged result, checked independently on the host.
  const files = existsSync(join(projectPath, 'test')) ? (await readdir(join(projectPath, 'test'))).filter(name => name.endsWith('.js')) : []
  report.testFiles = files
  const run = spawnSync(process.execPath, ['--test', ...files.map(name => join('test', name))], { cwd: projectPath, encoding: 'utf8', timeout: 60_000 })
  const summary = (run.stdout + run.stderr).split(/\r?\n/).filter(line => /^# (tests|pass|fail)/.test(line))
  report.hostTestRun = { exitCode: run.status, summary }
  console.log('host node --test:', JSON.stringify(report.hostTestRun))
  if (files.length === 2 && run.status === 0) check(`The merged result holds: ${files.join(' and ')} pass on the host (${summary.join(', ')})`)
  else console.log(`NOTE merged result incomplete: files ${JSON.stringify(files)}, node --test exit ${run.status}`)
  report.outcome = files.length === 2 && run.status === 0 && final.reports.length === 2 ? 'complete' : 'partial'
} catch (error) {
  failed = true
  report.error = String(error?.message ?? error)
  console.error('FAIL', error?.stack ?? error)
} finally {
  killElectron()
  report.wallSeconds ??= Math.round((Date.now() - started) / 1000)
  await writeFile(join(output, 'result.json'), JSON.stringify({ ...report, checks, pass: !failed }, null, 2))
  console.log(failed ? 'FAIL' : `PASS ${checks.length} checks (${report.outcome})`, output, `wall ${report.wallSeconds} s`)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  process.exit(failed ? 1 : 0)
}
