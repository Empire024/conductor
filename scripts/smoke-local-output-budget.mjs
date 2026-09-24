import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Live check of G4 and G5 in a parked Conductor on an isolated profile:
//  G4 — files.list({query:'usage'}) through real app control, on this checkout, ranks
//       src/shared/usage-accounting.ts ahead of every artifacts/ copy.
//  G5 — a bounded, report-only Qwen 3.5 9B coworker dispatched through app control is asked
//       for one oversized write_file; the runtime repairs once and, if the model cuts the same
//       call again, stops the turn with the output-budget loop instead of retrying.
// Uses the llama.cpp server that is already running; it never starts or stops one.
// Usage: node scripts/smoke-local-output-budget.mjs --project=C:\path\to\checkout [--out=dir] [--skip-local]
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const projectPath = resolve(arg('project') ?? '.')
const output = resolve(arg('out') ?? 'artifacts/local-output-budget')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-output-budget-'))
const capture = join(root, 'controller-input.txt')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const llamaServers = () => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split('\n').filter(line => line.includes('llama-server')).length } catch { return -1 } }
const results = { root, projectPath, llamaServersBefore: llamaServers(), checks: [] }
const save = () => writeFile(join(output, 'smoke-results.json'), JSON.stringify(results, null, 2))
let stage = 'launch'
const at = name => { stage = name; process.stderr.write(`[stage] ${name}\n`) }
const watchdog = setTimeout(() => { process.stderr.write(`[timeout] during ${stage}\n`); save().finally(() => process.exit(1)) }, Number(process.env.LOCAL_SMOKE_TIMEOUT_MS ?? 25 * 60_000))

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  at('open project')
  // The folder picker is the only way to open an existing folder; answer it with the checkout.
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, projectPath)
  const project = await page.evaluate(() => window.conductor.projects.openFolder())
  assert.ok(project?.id, 'the checkout did not open as a project')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: project.name }).first().click()

  at('controller credentials')
  // A synthetic Claude tab (OFFLINE_TESTS) receives the real app-control briefing.
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  const controllerId = await page.locator('.structured-agent-pane').first().getAttribute('data-structured-session')
  await page.evaluate(async id => { await window.conductor.structured.connect(id); const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'SYNTHETIC STEER START', { ...state.settings, model: 'synthetic-claude', effort: 'low' }, []) }, controllerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false), { timeout: 60_000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(auth.endpoint && auth.token, 'no app-control briefing')
  const call = async (method, args = {}) => {
    const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const body = await response.json()
    assert.equal(response.status, 200, method + ': ' + JSON.stringify(body))
    return body.result
  }

  at('G4 files.list')
  const files = await call('files.list', { query: 'usage' })
  const source = files.findIndex(file => file.path === 'src/shared/usage-accounting.ts')
  const firstArtifact = files.findIndex(file => file.path.startsWith('artifacts/'))
  const firstCopy = files.findIndex(file => file.copy)
  results.g4 = { count: files.length, sourceIndex: source, firstArtifactIndex: firstArtifact, firstCopyIndex: firstCopy, top: files.slice(0, 12).map(file => file.path + (file.copy ? ' [copy]' : '')) }
  assert.ok(source >= 0, 'src/shared/usage-accounting.ts is not in the first 100 results')
  assert.ok(firstArtifact < 0 || source < firstArtifact, `an artifacts/ copy (${firstArtifact}) ranks before the source (${source})`)
  results.checks.push(`G4: files.list usage ranks src/shared/usage-accounting.ts at ${source}, first artifacts/ copy at ${firstArtifact}`)
  const exact = await call('files.list', { query: 'src/shared/usage-accounting.ts' })
  assert.equal(exact[0]?.path, 'src/shared/usage-accounting.ts')
  results.checks.push('G4: an exact-path query returns the source file first')
  await save()

  if (!process.argv.includes('--skip-local')) {
    at('G5 dispatch')
    const target = 'artifacts/autopilot/g4g5/live/local-report.md'
    const prompt = [
      'Bounded report-only probe. Do not read or search any files.',
      `Write a report to ${target} with EXACTLY ONE write_file call, never append, never split it.`,
      'The content must be at least 14000 characters: a heading, then 160 numbered lines, each a full sentence of about 90 characters describing an imaginary subsystem.',
      'Put the whole report in that single call. Then answer "done".'
    ].join('\n')
    const [worker] = await call('router.dispatch', { tasks: [{ title: 'G5 output-budget probe', prompt, provider: 'local', model: 'local/qwen3.5-9b', contract: { allowedPaths: [target] } }] })
    assert.ok(worker?.agentSessionId, 'no local coworker was opened')
    const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), worker.agentSessionId)
    const started = Date.now()
    await expect.poll(async () => (await snapshot())?.phase, { timeout: 20 * 60_000, intervals: [5000] }).toMatch(/completed|failed|interrupted/)
    const state = await snapshot()
    const tools = state.items.filter(item => item.data.type === 'tool')
    const writes = tools.filter(item => item.data.name === 'write_file')
    const stop = state.items.map(item => item.data?.payload?.localStop ?? item.data?.localStop).filter(Boolean).at(-1)
    const notices = state.items.filter(item => item.data.type === 'notice' || item.data.type === 'error').map(item => item.data.message ?? item.data.text ?? '')
    const answer = state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('')
    results.g5 = {
      phase: state.phase, elapsedMs: Date.now() - started, model: state.settings?.model,
      writeCalls: writes.map(item => ({ status: item.data.status, inputChars: String(item.data.input ?? '').length, output: String(item.data.output ?? '').slice(0, 400) })),
      stopReason: stop?.reason, stopDetail: stop?.detail, requests: stop?.task?.requests, rounds: stop?.rounds,
      notices: notices.slice(-8).map(text => String(text).slice(0, 400)),
      answerTail: answer.slice(-2500), reportExists: existsSync(join(projectPath, target))
    }
    const cut = writes.filter(item => /cut off at the local output limit/.test(String(item.data.output ?? '')))
    results.g5.cutWrites = cut.length
    results.g5.stoppedAfterExactlyOneRetry = stop?.reason === 'output_budget_loop' && cut.length === 2
    results.checks.push(`G5: phase ${state.phase}, stop ${stop?.reason}, ${writes.length} write_file calls (${cut.length} cut), ${Math.round(results.g5.elapsedMs / 1000)} s`)
    // No stop report means the model never ran (no server, refused admission): not a G5 result.
    assert.ok(stop, `the local turn produced no stop report: ${notices.at(-1) ?? 'no notice'}`)
    // Either the model followed the one repair, or it stopped after exactly one retry; never more cuts.
    assert.ok(cut.length <= 2 && (stop.reason !== 'output_budget_loop' || cut.length === 2), `unbounded output-budget retries: ${cut.length} cut calls, stop ${stop.reason}`)
  }
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
  // A close that hangs on a running local turn must not leave the parked window behind.
  const pid = app.process().pid
  await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000))])
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }) } catch { /* already gone */ }
  console.log(JSON.stringify(results, null, 2))
  process.exit(process.exitCode ?? 0)
}
