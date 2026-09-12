import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Live check of the Local provider against the real app and the real llama.cpp servers: both
// Qwen models open as ordinary Conductor tabs from the ordinary launcher, stream an answer,
// run the sandboxed coding tools, stop on request, stay independent of each other, and never
// hand the renderer the local API key. Nothing here is synthetic; there is no offline flag.
const root = await mkdtemp(join(tmpdir(), 'conductor-local-'))
const output = resolve('artifacts/local-models')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
delete env.CONDUCTOR_OFFLINE_TESTS
const TURN_TIMEOUT = 600_000

// --cold stops the model servers first, so the run proves Conductor starts them itself.
if (process.argv.includes('--cold')) {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/local-models/cli.ts', 'stop'], { stdio: 'inherit' })
}
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
const results = { root, checks: [], screenshots: [] }
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
  results.screenshots.push('artifacts/local-models/qwen-9b.png')

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
  results.screenshots.push('artifacts/local-models/both-tabs.png')

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
  results.screenshots.push('artifacts/local-models/coding-harness.png')

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

  assert.deepEqual(errors, [])
} finally {
  at('shutdown')
  // The window is already gone by the time the checks finish, and Playwright's graceful
  // close then waits on a connection nobody is left holding. Bounded, then killed.
  await Promise.race([app.close().catch(() => { /* already gone */ }), new Promise(done => setTimeout(done, 20_000))])
  try { app.process().kill() } catch { /* exited on its own */ }
  clearTimeout(watchdog)
}
console.log(JSON.stringify(results, null, 2))
