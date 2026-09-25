// feature-list.md handoff-stops-background-tasks: a wizard that hands itself on with
// agents.handoff({successor:true}) stops owning its watch loops. Before this, the predecessor's
// turn completed but the three background shells it had armed still counted as background tasks,
// so its read-only tab spun for half an hour. Now they are stopped through the CLI's own stop_task
// control as soon as its step settles, and the successor's own background work is left alone.
//
// Real Electron main/preload/renderer and the real loopback control broker; only the Claude
// process is the synthetic fixture (scripts/fixtures/fake-claude.mjs, SYNTHETIC WATCH LOOPS), so
// no inference happens. CONDUCTOR_TEST_USER_DATA parks the window off every display.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-handoff-stops-background.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-handoff-background-'))
const output = resolve('artifacts/fx26/handoff-stops-background')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt'), stopLog = join(root, 'stop-task.log')
const STEP_MS = 5000
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable',
  CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_STOP_TASK_LOG: stopLog, CONDUCTOR_SMOKE_STEP_MS: String(STEP_MS),
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

// The six sections agents.handoff requires; the SYNTHETIC prefix is what the fixture answers, and
// it arms the successor's own three watch loops so "unaffected" is something that can be seen.
const handoff = 'SYNTHETIC WATCH LOOPS successor: continue the swarm.\n\n' + [
  ['Objective', 'Continue controlling the swarm as the wizard.'],
  ['Constraints', 'Local commits only; the controller publishes once.'],
  ['Owned files', 'None; this tab coordinates.'],
  ['Verified findings', 'Three watch loops were armed by the predecessor.'],
  ['Remaining work', 'Re-arm your own watchers and keep going.'],
  ['Artifact references', 'artifacts/fx26/handoff-stops-background/report.json']
].map(([heading, line]) => heading + '\n- ' + line).join('\n\n')

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const payload = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const stops = async () => (await readFile(stopLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
// Tab rows by exact title: "Claude" is also a prefix of its successor "Claude (continued)".
const tabRow = title => page.locator('.workspace-tab-row').filter({ has: page.getByText(title, { exact: true }) })
const tabActivity = title => tabRow(title).locator('.tab-activity').first().getAttribute('class')
const timings = {}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  await page.evaluate(() => window.conductor.projects.create('Handoff background'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Handoff background' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const callerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  // The wand first, through the same settings call the composer uses; then the step that arms the loops.
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1', effort: 'high' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC WATCH LOOPS arm the watchers, then hand off', settings, [])
  }, callerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const caller = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(caller.endpoint && caller.token, 'The wizard must receive its control credential')
  await expect.poll(async () => (await snapshot(callerId))?.backgroundTasks).toBe(3)
  assert.equal((await snapshot(callerId)).phase, 'running')
  // The launcher's tab reaches the saved layout on the renderer's next save; the broker reads that.
  await expect.poll(async () => (await call(caller, 'app.state').catch(() => null))?.wizard, { timeout: 15000 }).toBe(true)
  check('A wizard tab arms three watch loops in the background and is still inside its step')

  const result = await call(caller, 'agents.handoff', { handoff, successor: true })
  timings.handoffAt = Date.now()
  assert.equal(result.successor, true, JSON.stringify(result))
  assert.equal(result.wizard, true)
  const callerTitle = (await call(caller, 'tabs.list')).find(tab => tab.resourceId === callerId)?.title
  // Mid-step nothing is stopped: the predecessor finishes the step it is in.
  const midStep = await snapshot(callerId)
  assert.equal(midStep.phase, 'running')
  assert.equal(midStep.backgroundTasks, 3)
  assert.deepEqual(await stops(), [])
  check('agents.handoff({successor:true}) hands the wizard on without cutting the step the predecessor is in')

  await expect.poll(async () => (await snapshot(callerId))?.phase, { timeout: STEP_MS + 10000 }).toBe('completed')
  timings.settledAt = Date.now()
  await expect.poll(async () => (await snapshot(callerId))?.backgroundTasks ?? 0, { timeout: 5000, intervals: [100] }).toBe(0)
  timings.drainedAt = Date.now()
  const stopped = await stops()
  assert.equal(stopped.length, 3, JSON.stringify(stopped))
  assert.ok(stopped.every(entry => entry.known), 'Every stop named a task the CLI was running: ' + JSON.stringify(stopped))
  const rows = (await snapshot(callerId)).items.filter(item => item.data.type === 'tool' && String(item.nativeItemId).startsWith('watch-tool-'))
  assert.equal(rows.length, 3)
  assert.ok(rows.every(item => item.data.status === 'interrupted'), 'Each watch loop row reads stopped: ' + JSON.stringify(rows.map(item => item.data.status)))
  await expect.poll(async () => (await call(caller, 'agents.list')).find(agent => agent.agentSessionId === callerId)?.superseded?.by).toBe(result.agentSessionId)
  check(`Once its step settled, the predecessor's three watch loops were stopped with stop_task and its tab settled with 0 background tasks (${timings.drainedAt - timings.settledAt} ms)`)

  // The successor ran its own step and armed its own loops; none of them was touched.
  await expect.poll(async () => (await snapshot(result.agentSessionId))?.phase, { timeout: STEP_MS + 15000 }).toBe('completed')
  await expect.poll(async () => (await snapshot(result.agentSessionId))?.backgroundTasks).toBe(3)
  await page.waitForTimeout(3000)
  const successor = await snapshot(result.agentSessionId)
  assert.equal(successor.backgroundTasks, 3)
  assert.equal(successor.settings.wizard, true)
  assert.equal((await stops()).length, 3, 'No stop reached the successor')
  check('The successor keeps the wizard and its own three background loops, untouched')

  const callerClass = await tabActivity(callerTitle), successorClass = await tabActivity(result.title)
  assert.doesNotMatch(callerClass ?? '', /working|waiting_background/, 'The handed-off tab shows no spinner: ' + callerClass)
  assert.match(successorClass ?? '', /waiting_background/, 'The successor still shows its background work: ' + successorClass)
  await tabRow(callerTitle).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(output, 'handed-off-tab-settled.png') })
  check(`The handed-off tab's indicator is settled (${callerClass}) while the successor's shows its own background work (${successorClass})`)

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw Claude process', callerAgentSessionId: callerId, successorAgentSessionId: result.agentSessionId, stops: stopped, msFromSettleToDrained: timings.drainedAt - timings.settledAt, msFromHandoffToDrained: timings.drainedAt - timings.handoffAt }, null, 2))
  console.log('\nsmoke-handoff-stops-background: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close().catch(() => {})
}
