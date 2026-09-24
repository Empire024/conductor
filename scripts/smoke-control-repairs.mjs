import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// Live check of the app-control repairs in a parked Conductor on an isolated profile:
//  catalog — tools.list says git.ship is a local commit unless publish: true, jobs.pause interrupts
//       the running stage at once, agents.steer states its idle/running/interrupted contract, and
//       usage.limits is listed.
//  G1 — usage.limits reads the Claude allowance the (synthetic) runtime reported through the real
//       ClaudeAdapter rate_limit_event parser, zero-turn, with Codex and Grok explicitly unknown,
//       and the record survives a hard restart (read before any conversation reconnects).
//  G7 — agents.steer on an idle coworker starts one turn; on a running one it steers without a new
//       turn; after an interrupt it starts one new turn; nothing is duplicated.
//  G3 — router.dispatch of the running local model with permission read-only (exactPermission)
//       is accepted without an unsupported sandbox mode and the worker leaves the project unchanged.
// Cloud providers are the offline fixtures; the local model is the llama.cpp server that is already
// running. It never starts or stops a model server.
// Usage: node scripts/smoke-control-repairs.mjs [--out=dir] [--model=local/qwen3.5-9b] [--skip-local]
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const output = resolve(arg('out') ?? 'artifacts/control-repairs/live')
const localModel = arg('model') ?? 'local/qwen3.5-9b'
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-control-repairs-'))
const profile = join(root, 'profile')
const projectPath = join(root, 'inventory-project')
await mkdir(join(projectPath, 'src'), { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Inventory fixture\n')
await writeFile(join(projectPath, 'src', 'a.txt'), 'alpha\n')
await writeFile(join(projectPath, 'src', 'b.txt'), 'beta\n')
execFileSync('git', ['init', '-q'], { cwd: projectPath })
execFileSync('git', ['add', '.'], { cwd: projectPath })
execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture'], { cwd: projectPath })
const capture = join(root, 'controller-input.txt')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const llamaServers = () => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split('\n').filter(line => line.includes('llama-server')).length } catch { return -1 } }
const results = { root, projectPath, llamaServersBefore: llamaServers(), checks: [] }
const save = () => writeFile(join(output, 'smoke-results.json'), JSON.stringify(results, null, 2))
let stage = 'launch'
const at = name => { stage = name; process.stderr.write(`[stage] ${name}\n`) }
const watchdog = setTimeout(() => { process.stderr.write(`[timeout] during ${stage}\n`); save().finally(() => process.exit(1)) }, Number(process.env.CONTROL_SMOKE_TIMEOUT_MS ?? 20 * 60_000))

let app, page
const launch = async () => {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
}
const profileProcesses = () => {
  const list = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], { encoding: 'utf8' })
  return list.split(/\r?\n/).filter(line => line.toLowerCase().includes(root.toLowerCase())).map(line => Number(line.split('\t')[0]))
}
const hardStop = async () => {
  const pid = app.process().pid
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'pipe' }) } catch { /* already gone */ }
  await expect.poll(() => profileProcesses().length, { timeout: 30_000 }).toBe(0)
}
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}

try {
  await launch()
  at('open project')
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, projectPath)
  const project = await page.evaluate(() => window.conductor.projects.openFolder())
  assert.ok(project?.id, 'the fixture project did not open')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: project.name }).first().click()

  at('controller credentials')
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  const controllerId = await page.locator('.structured-agent-pane').first().getAttribute('data-structured-session')
  await page.evaluate(async id => { await window.conductor.structured.connect(id); const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SYNTHETIC STEER START', state.settings) }, controllerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false), { timeout: 60_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(auth.endpoint && auth.token, 'no app-control briefing')
  const call = async (method, args = {}) => {
    const { status, body } = await request(auth, method, args)
    assert.equal(status, 200, method + ': ' + JSON.stringify(body))
    return body.result
  }
  const snapshot = id => page.evaluate(session => window.conductor.structured.snapshot(session), id)
  const userTexts = async id => (await snapshot(id)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)

  at('catalog')
  const tools = await call('tools.list')
  assert.match(tools['git.ship'], /a local commit/)
  assert.match(tools['git.ship'], /Only publish: true/)
  assert.match(tools['jobs.pause'] ?? '', /interrupts the running stage at once/)
  assert.match(tools['agents.steer'], /idle, finished, failed, disconnected or interrupted it starts a turn/)
  assert.ok(tools['usage.limits'], 'usage.limits is not listed')
  results.catalog = { gitShip: tools['git.ship'], jobsPause: tools['jobs.pause'], agentsSteer: tools['agents.steer'], usageLimits: tools['usage.limits'] }
  results.checks.push('catalog: git.ship local by default, jobs.pause interrupts at once, agents.steer contract, usage.limits listed')

  at('G1 usage.limits')
  // The synthetic Claude runtime reports its allowance while initializing, before any model turn.
  await expect.poll(async () => (await call('usage.limits', { provider: 'claude' })).providers[0].status, { timeout: 30_000 }).toBe('reported')
  const limits = await call('usage.limits')
  const claude = limits.providers.find(entry => entry.provider === 'claude')
  const five = claude.windows.find(window => window.key === 'five_hour'), week = claude.windows.find(window => window.key === 'seven_day'), fable = claude.windows.find(window => window.key === 'seven_day_overage_included')
  assert.equal(five?.usedPercent, 24); assert.equal(week?.usedPercent, 95); assert.equal(fable?.usedPercent, 99)
  assert.deepEqual(fable.models, ['fable'])
  assert.equal(five.source.agentSessionId, controllerId)
  assert.ok(five.resetsAt && five.observedAt && typeof five.ageSeconds === 'number')
  for (const provider of ['codex', 'grok']) assert.equal(limits.providers.find(entry => entry.provider === provider).status, 'unknown')
  assert.match(limits.providers.find(entry => entry.provider === 'grok').unknown.join(' '), /does not report/)
  const refused = await request(auth, 'usage.limits', { provider: 'openai' })
  assert.equal(refused.status, 400)
  results.g1 = { limits, refused: refused.body }
  results.checks.push(`G1: usage.limits reported Claude five_hour ${five.usedPercent}%, seven_day ${week.usedPercent}%, Fable weekly ${fable.usedPercent}% from ${controllerId}; Codex and Grok unknown`)
  await save()

  at('G7 agents.steer')
  const claudeModel = (await call('models.list')).find(entry => entry.provider === 'claude').models[0].id
  const worker = await call('tabs.open', { provider: 'claude', model: claudeModel, title: 'Steer contract' })
  const id = worker.resourceId
  assert.equal((await snapshot(id)).phase, 'idle')
  const idle = await call('agents.steer', { agentSessionId: id, prompt: 'SYNTHETIC B idle start' })
  assert.equal(idle.delivery, 'started')
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: 30_000 }).toBe('completed')
  const started = await call('agents.steer', { agentSessionId: id, prompt: 'SYNTHETIC STEER START' })
  assert.equal(started.delivery, 'started')
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: 30_000 }).toBe('running')
  const into = await call('agents.steer', { agentSessionId: id, prompt: 'SYNTHETIC STEER DATA while running' })
  assert.equal(into.delivery, 'queued')
  await expect.poll(async () => (await snapshot(id)).items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && /Synthetic steering input received/.test(item.data.text)), { timeout: 30_000 }).toBe(true)
  assert.equal((await snapshot(id)).phase, 'running')
  await call('agents.interrupt', { agentSessionId: id })
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: 30_000 }).toBe('interrupted')
  const resumed = await call('agents.steer', { agentSessionId: id, prompt: 'SYNTHETIC B after interrupt' })
  assert.equal(resumed.delivery, 'started')
  await expect.poll(async () => (await snapshot(id)).phase, { timeout: 30_000 }).toBe('completed')
  await new Promise(done => setTimeout(done, 1500))
  const texts = await userTexts(id)
  for (const prompt of ['SYNTHETIC B idle start', 'SYNTHETIC STEER START', 'SYNTHETIC B after interrupt']) assert.equal(texts.filter(text => text.startsWith(prompt)).length, 1, `${prompt} was sent ${texts.filter(text => text.startsWith(prompt)).length} times`)
  const state = await snapshot(id)
  results.g7 = { idle, started, into, resumed, userTexts: texts, finalPhase: state.phase, queued: state.queuedPrompts ?? [], permission: state.settings.permission }
  results.checks.push('G7: agents.steer idle → started, running → queued (steered into the turn), interrupted → started; each prompt sent once')
  await save()

  if (!process.argv.includes('--skip-local')) {
    at('G3 local read-only dispatch')
    const locals = (await call('models.list')).find(entry => entry.provider === 'local')?.models.map(model => model.id) ?? []
    assert.ok(locals.includes(localModel), `${localModel} is not offered (${locals.join(', ') || 'no local models'})`)
    const before = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectPath, encoding: 'utf8' })
    const prompt = 'Read-only inventory probe. List the files in this project with your file tools (at most three tool calls), then answer with the number of files you found and their paths. Do not create, edit or delete anything.'
    const [dispatched] = await call('router.dispatch', { tasks: [{ title: 'G3 read-only inventory', prompt, provider: 'local', model: localModel, permission: 'read-only', exactPermission: true }] })
    results.g3 = { dispatched }
    assert.equal(dispatched.accepted, true, `local read-only dispatch was refused: ${dispatched.error}`)
    const settings = (await snapshot(dispatched.agentSessionId)).settings
    assert.equal(settings.permission, 'read-only')
    assert.equal(settings.sandbox, undefined)
    const startedAt = Date.now()
    await expect.poll(async () => (await snapshot(dispatched.agentSessionId)).phase, { timeout: 10 * 60_000, intervals: [3000] }).toMatch(/completed|failed|interrupted/)
    const local = await snapshot(dispatched.agentSessionId)
    const toolCalls = local.items.filter(item => item.data.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status }))
    const answer = local.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('').slice(-1500)
    const after = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectPath, encoding: 'utf8' })
    Object.assign(results.g3, { settings: { permission: settings.permission, sandbox: settings.sandbox ?? null }, phase: local.phase, elapsedMs: Date.now() - startedAt, toolCalls, answer, projectUnchanged: before === after })
    assert.equal(before, after, 'the read-only local worker changed the project')
    assert.ok(!toolCalls.some(call => ['write_file', 'edit_file', 'apply_edits', 'run_command'].includes(call.name) && call.status === 'completed'), 'a write tool completed in a read-only turn')
    results.checks.push(`G3: local ${localModel} dispatched read-only (no sandbox mode), phase ${local.phase}, ${toolCalls.length} tool calls, project unchanged`)
    await save()
  }

  at('G1 restart')
  const beforeRestart = (await call('usage.limits', { provider: 'claude' })).providers[0]
  await hardStop()
  const restartedAt = new Date().toISOString()
  // The kept record itself, read from the stopped profile's own database (never the owner's).
  const database = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get('usageLimits.latest')
  database.close()
  assert.ok(row?.value, 'usageLimits.latest was not persisted')
  const kept = JSON.parse(row.value)
  results.g1Persisted = Object.fromEntries(Object.entries(kept).map(([provider, buckets]) => [provider, Object.fromEntries(Object.entries(buckets).map(([bucket, value]) => [bucket, { observedAt: value.observedAt, agentSessionId: value.agentSessionId, limits: value.limits }]))]))
  assert.equal(kept.claude?.['window:five_hour']?.limits?.rateLimits?.five_hour?.usedPercent, 24)
  await launch()
  const ownerPath = join(profile, 'control-owner.json')
  await expect.poll(() => existsSync(ownerPath), { timeout: 30_000 }).toBe(true)
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
  const reread = await request(owner, 'usage.limits', { provider: 'claude' }, { projectId: project.id })
  assert.equal(reread.status, 200, JSON.stringify(reread.body))
  const afterRestart = reread.body.result.providers[0]
  const fiveAfter = afterRestart.windows.find(window => window.key === 'five_hour')
  results.g1Restart = { restartedAt, before: beforeRestart.windows.map(window => [window.key, window.usedPercent, window.observedAt]), after: afterRestart.windows.map(window => [window.key, window.usedPercent, window.observedAt]) }
  assert.equal(afterRestart.status, 'reported')
  assert.equal(fiveAfter.usedPercent, 24)
  // A restored Claude tab may reconnect and report again before this read; the persisted row above
  // is the durable evidence either way, and this says which one the first read saw.
  results.g1Restart.firstReadFromKeptRecord = fiveAfter.observedAt < restartedAt
  results.checks.push(`G1: usageLimits.latest persisted across a hard stop; after relaunch usage.limits reports Claude five_hour ${fiveAfter.usedPercent}% observed ${fiveAfter.observedAt} (restart at ${restartedAt})`)

  results.llamaServersAfter = llamaServers()
  assert.ok(results.llamaServersAfter <= Math.max(1, results.llamaServersBefore), 'a second llama.cpp server was started')
  results.pass = true
} catch (error) {
  results.pass = false
  results.error = `${stage}: ${error instanceof Error ? error.stack : String(error)}`
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await save()
  if (app) {
    const pid = app.process().pid
    await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }) } catch { /* already gone */ }
  }
  console.log(JSON.stringify(results, null, 2))
  process.exit(process.exitCode ?? 0)
}
