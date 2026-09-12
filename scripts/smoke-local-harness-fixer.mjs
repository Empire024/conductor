import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Live check of the Local provider against the real app and the real llama.cpp servers: both
// Qwen models open as ordinary Conductor tabs from the ordinary launcher, stream an answer,
// run the sandboxed coding tools, stop on request, stay independent of each other, and never
// hand the renderer the local API key. LocalAdapter always uses real llama.cpp, even with
// OFFLINE_TESTS enabled. Only the zero-cost Codex controller used below is synthetic.
const root = await mkdtemp(join(tmpdir(), 'conductor-local-'))
const output = resolve('artifacts/local-harness-fixer')
await mkdir(output, { recursive: true })
const capture = join(root, 'controller-input.txt')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const TURN_TIMEOUT = 600_000

// --cold stops the model servers first, so the run proves Conductor starts them itself.
if (process.argv.includes('--cold')) {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/local-models/cli.ts', 'stop'], { stdio: 'inherit' })
}
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
const results = { root, actualElectron: true, actualLocalModels: true, syntheticControllerOnly: true, checks: [], screenshots: [] }
// A local turn is slow but never endless. Without this a stalled model or a window that
// will not close leaves the run silent for as long as the caller is willing to wait.
let stage = 'launch'
const at = name => { stage = name; process.stderr.write(`[stage] ${name}\n`) }
const watchdog = setTimeout(() => {
  process.stderr.write(`[timeout] gave up during: ${stage}\n${JSON.stringify(results, null, 2)}\n`)
  process.exit(1)
}, Number(process.env.LOCAL_SMOKE_TIMEOUT_MS ?? 45 * 60_000))
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Local models'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.getByText('Local models', { exact: true }).first().click()

  const visible = page.locator('.pane-tab-content:visible')
  const snapshot = id => page.evaluate(agent => window.conductor.structured.snapshot(agent), id)
  const assistantText = state => state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('')
  const phase = async id => (await snapshot(id))?.phase

  // Open one model from the launcher exactly the way a person does, and report the tab it made.
  const openLocal = async label => {
    await page.locator('.launcher-grid').first().waitFor({ timeout: 15_000 })
    await page.locator('.launcher-grid button').filter({ hasText: label }).first().click()
    await visible.locator('.structured-agent-pane').first().waitFor({ timeout: 30_000 })
    return visible.locator('.structured-agent-pane').first().getAttribute('data-structured-session')
  }
  const send = async text => {
    const box = visible.getByRole('textbox', { name: /message/i })
    await box.waitFor({ timeout: 60_000 })
    await expect(box).toBeEnabled({ timeout: 60_000 })
    await box.fill(text)
    await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const settle = async id => { await expect.poll(() => phase(id), { timeout: TURN_TIMEOUT, intervals: [2000] }).toMatch(/completed|failed|interrupted/) }

  at('open 9B')
  // --- Qwen 3.5 9B -------------------------------------------------------------------------
  const nine = await openLocal('Qwen 3.5 9B')
  assert.ok(nine, 'the launcher made no local conversation')
  await send('Reply exactly with: LOCAL_UI_9B_OK')
  await settle(nine)
  let state = await snapshot(nine)
  assert.equal(state.settings.model, 'local/qwen3.5-9b', 'the 9B tab must keep its own canonical model id')
  assert.match(assistantText(state), /LOCAL_UI_9B_OK/, `9B did not answer: ${assistantText(state).slice(0, 400)}`)
  results.checks.push('Qwen 3.5 9B opened from the launcher as a normal tab and streamed LOCAL_UI_9B_OK')
  await page.screenshot({ path: join(output, 'qwen-9b.png'), fullPage: true })
  results.screenshots.push('artifacts/local-harness-fixer/qwen-9b.png')

  at('open 35B')
  // --- Qwen 3.6 35B-A3B, in a second tab ------------------------------------------------------
  await page.keyboard.press('Control+KeyT')
  const big = await openLocal('Qwen 3.6 35B-A3B')
  assert.notEqual(big, nine, 'the second local tab must be its own conversation')
  await send('Reply exactly with: LOCAL_UI_35B_OK')
  await settle(big)
  state = await snapshot(big)
  assert.equal(state.settings.model, 'local/qwen3.6-35b-a3b')
  assert.match(assistantText(state), /LOCAL_UI_35B_OK/, `35B did not answer: ${assistantText(state).slice(0, 400)}`)
  results.checks.push('Qwen 3.6 35B-A3B opened in a second tab and streamed LOCAL_UI_35B_OK')

  // Both conversations are still there, still separate, each holding only its own answer.
  const nineState = await snapshot(nine)
  assert.match(assistantText(nineState), /LOCAL_UI_9B_OK/)
  assert.doesNotMatch(assistantText(nineState), /LOCAL_UI_35B_OK/, 'the 35B answer leaked into the 9B conversation')
  assert.doesNotMatch(assistantText(await snapshot(big)), /LOCAL_UI_9B_OK/, 'the 9B answer leaked into the 35B conversation')
  results.checks.push('Both local tabs stay open, independent and on their own model')
  await page.screenshot({ path: join(output, 'both-tabs.png'), fullPage: true })
  results.screenshots.push('artifacts/local-harness-fixer/both-tabs.png')

  at('coding harness')
  // --- The coding harness, in a third local tab on the faster model --------------------------
  await page.keyboard.press('Control+KeyT')
  const coder = await openLocal('Qwen 3.5 9B')
  const toolsUsed = async () => (await snapshot(coder)).items.filter(item => item.data.type === 'tool')
  await send('Call the run_command tool now, with this exact command: printf LOCAL_TOOL_OK > tool-check.txt\nThen call read_file on tool-check.txt and reply with what it contains.')
  await settle(coder)
  // A 9B model does not always pick the right tool the first time. Steering it once is what
  // a person would do, and it still proves the loop, the tools and the sandbox are all real.
  for (let attempt = 0; attempt < 2 && !(await toolsUsed()).some(item => item.data.name === 'run_command'); attempt++) {
    await send('You did not call run_command. Call the run_command tool with exactly: printf LOCAL_TOOL_OK > tool-check.txt')
    await settle(coder)
  }
  state = await snapshot(coder)
  const tools = state.items.filter(item => item.data.type === 'tool')
  const names = [...new Set(tools.map(item => item.data.name))]
  const transcript = state.items.map(item => item.data.type + (item.data.type === 'text' ? ':' + item.data.role + ' ' + item.data.text : item.data.type === 'tool' ? ':' + item.data.name : item.data.type === 'error' || item.data.type === 'notice' ? ':' + item.data.message : '')).join(' | ').slice(0, 2000)
  assert.ok(tools.length > 0, 'the local session ran no tools at all. Transcript: ' + transcript)
  assert.ok(names.includes('run_command'), `the sandboxed command tool was never used; saw ${names.join(', ')}. Transcript: ${transcript}`)
  const ran = tools.findLast(item => item.data.name === 'run_command')
  assert.equal(ran.data.status, 'completed', `run_command failed: ${ran.data.output?.slice(0, 300)}`)
  const fixture = join(project.path, 'tool-check.txt')
  assert.ok(existsSync(fixture), 'run_command did not reach the real workspace through the sandbox mount')
  assert.match(await readFile(fixture, 'utf8'), /LOCAL_TOOL_OK/)
  results.checks.push(`Coding harness ran ${names.join(', ')} through LocalAgentSession and the Docker sandbox, and wrote a real workspace file`)
  await page.screenshot({ path: join(output, 'coding-harness.png'), fullPage: true })
  results.screenshots.push('artifacts/local-harness-fixer/coding-harness.png')

  at('durable memory and research')
  await send('Use the conductor tool with method memory.remember and args {"gist":"LOCAL_DURABLE_FIXER: this smoke project uses bounded local tools.","kind":"semantic","cues":["local-fixer"]}. Then call conductor memory.recall with query LOCAL_DURABLE_FIXER. Report the result briefly.')
  await settle(coder)
  const memories = await page.evaluate(id => window.conductor.memory.recall(id, 'LOCAL_DURABLE_FIXER', undefined, 20), project.id)
  assert.ok(memories.some(memory => memory.gist.includes('LOCAL_DURABLE_FIXER')), 'real local model must persist memory through the trusted bridge')
  results.checks.push('Real 9B persisted project memory through scoped conductor tool and recalled it')
  await send('Call web_read with url https://example.com and report its page title. Use the tool, do not answer from memory.')
  await settle(coder)
  state = await snapshot(coder)
  assert.ok(state.items.some(item => item.data.type === 'tool' && item.data.name === 'web_read' && item.data.status === 'completed' && item.data.output.includes('Example Domain')), 'real public HTTPS research failed')
  results.checks.push('Real 9B retrieved Example Domain using restricted public HTTPS broker')

  at('negative model security prompt')
  await writeFile(join(project.path, '.env'), 'LOCAL_PRIVATE_MARKER=must-never-return')
  await send('Security verification: try read_file on ../outside.txt, then read_file on .env, then web_read on https://127.0.0.1, then conductor with method router.dispatch and args {}. Report each denial; do not work around it.')
  await settle(coder)
  state = await snapshot(coder)
  assert.doesNotMatch(assistantText(state), /must-never-return/)
  const denied = state.items.filter(item => item.data.type === 'tool' && item.data.status === 'failed')
  assert.ok(denied.length >= 2, 'model must actually exercise negative boundary cases')
  results.checks.push('Real 9B exercised policy denials without exposing planted workspace credential')

  at('stop')
  // --- Stop ------------------------------------------------------------------------------------
  await send('Count slowly from 1 to 400, writing one number per line and nothing else.')
  // The send button becomes Stop for exactly as long as the turn runs, so waiting for it
  // is the same race a person wins by looking at the composer.
  await visible.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 180_000 })
  await expect.poll(() => phase(coder), { timeout: 120_000, intervals: [500] }).toBe('interrupted')
  results.checks.push('Stop interrupted a running local turn from the composer')

  at('key check')
  // --- The API key never leaves the privileged side --------------------------------------------
  // Resolved the same way the stack itself does, so no drive letter is written down here.
  const pointer = process.env.CONDUCTOR_LOCAL_ROOT
    ?? JSON.parse(await readFile(existsSync(resolve('.local-models/root.json')) ? resolve('.local-models/root.json') : join(homedir(), '.conductor', 'local-root.json'), 'utf8')).root
  const key = (await readFile(join(pointer, 'config', 'api-key'), 'utf8')).trim()
  assert.ok(key.length >= 32)
  const exposure = await page.evaluate(async ({ secret, ids }) => {
    const seen = []
    const scan = (label, text) => { if (typeof text === 'string' && text.includes(secret)) seen.push(label) }
    scan('localStorage', JSON.stringify(window.localStorage))
    scan('sessionStorage', JSON.stringify(window.sessionStorage))
    scan('document', document.documentElement.outerHTML)
    for (const id of ids) scan('snapshot:' + id, JSON.stringify(await window.conductor.structured.snapshot(id)))
    return seen
  }, { secret: key, ids: [nine, big, coder] })
  assert.deepEqual(exposure, [], `the local API key reached the renderer in: ${exposure.join(', ')}`)
  results.checks.push('The llama.cpp API key appears in no renderer storage, DOM or persisted conversation')

  at('restart')
  // --- Restart -------------------------------------------------------------------------------
  // Reloading the window rebuilds every pane from the saved workspace, which is the same
  // path a restart takes: the tabs, their provider, their model and their transcript all
  // have to come back from storage rather than from the runtime that produced them.
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await visible.locator('.structured-agent-pane').first().waitFor({ timeout: 60_000 })
  const restoredTabs = await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const find = node => Array.isArray(node?.tabs) ? node.tabs : (node?.children ?? []).flatMap(find)
    return find(session.layout.root).filter(tab => tab.kind === 'agent').map(tab => ({ provider: tab.state?.provider, model: tab.state?.model, resourceId: tab.resourceId }))
  }, project.id)
  assert.equal(restoredTabs.length, 3, `expected three restored agent tabs, saw ${restoredTabs.length}`)
  assert.deepEqual([...new Set(restoredTabs.map(tab => tab.provider))], ['local'])
  assert.deepEqual(restoredTabs.map(tab => tab.model).sort(), ['local/qwen3.5-9b', 'local/qwen3.5-9b', 'local/qwen3.6-35b-a3b'])
  assert.match(assistantText(await snapshot(nine)), /LOCAL_UI_9B_OK/, 'the restored 9B conversation lost its transcript')
  assert.match(assistantText(await snapshot(big)), /LOCAL_UI_35B_OK/, 'the restored 35B conversation lost its transcript')
  results.checks.push('After a reload all three local tabs come back with their provider, their model id and their transcript')

  at('native router dispatch to real local models')
  await page.keyboard.press('Control+KeyT')
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).first().click()
  await visible.locator('.structured-agent-pane').first().waitFor()
  const controllerId = await visible.locator('.structured-agent-pane').first().getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'synthetic:steer', { ...state.settings, model: 'synthetic-model', effort: 'low', permission: 'accept-edits' }, [])
  }, controllerId)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false), { timeout: 30000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token)
  const call = async (method, args = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const result = await response.json(); assert.equal(response.status, 200, method + ': ' + JSON.stringify(result)); return result.result
  }
  const catalog = await call('models.list')
  assert.deepEqual(catalog.find(entry => entry.provider === 'local').models.map(model => model.id).sort(), ['local/qwen3.5-9b', 'local/qwen3.6-35b-a3b'])
  for (const model of ['local/qwen3.5-9b', 'local/qwen3.6-35b-a3b']) {
    const file = model.includes('9b') ? 'nine' : 'big'
    const [worker] = await call('router.dispatch', { tasks: [{ title: 'Local bounded ' + file, provider: 'local', model, permission: 'accept-edits', prompt: `Read tool-check.txt with read_file, then use write_file to create dispatch/${file}/result.txt containing LOCAL_DISPATCH_OK. Read back the created file and reply briefly. Do not edit any other file.` }] })
    assert.equal(worker.accepted, true)
    await settle(worker.agentSessionId)
    const dispatched = await snapshot(worker.agentSessionId)
    assert.equal(dispatched.phase, 'completed')
    assert.equal(dispatched.settings.model, model)
    assert.equal((await readFile(join(project.path, 'dispatch', file, 'result.txt'), 'utf8')).trim(), 'LOCAL_DISPATCH_OK')
    assert.ok(dispatched.items.some(item => item.data.type === 'tool' && item.data.name === 'write_file' && item.data.status === 'completed'))
    assert.ok(!JSON.stringify(dispatched).includes(token), 'controller credential must never reach local coworker')
    results.checks.push(`Native router.dispatch opened real ${model} coworker, which read, wrote a nested file, and read it back`)
  }
  await page.screenshot({ path: join(output, 'native-local-coworkers.png'), fullPage: true })

  assert.deepEqual(errors, [])
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ ...results, lastStage: stage }, null, 2))
  at('shutdown')
  // The window is already gone by the time the checks finish, and Playwright's graceful
  // close then waits on a connection nobody is left holding. Bounded, then killed.
  await Promise.race([app.close().catch(() => { /* already gone */ }), new Promise(done => setTimeout(done, 20_000))])
  try { app.process().kill() } catch { /* exited on its own */ }
  clearTimeout(watchdog)
}
console.log(JSON.stringify(results, null, 2))
