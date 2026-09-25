import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// FX15 (feature-list.md 44a4ba26-0ec7-4d40-a1d9-c2634b3b7206): show, Conductor-side, when an agent
// uses Conductor. A fixture controller opens a coworker, prompts, steers and renames it, reads a few
// times and ships a local commit; its own timeline must show one chip row for the turn, the coworker
// must show who opened and renamed it, its tab entries a "Controlled by" badge, and the Processes
// board the latest control action. Real Electron, control broker and git.ship; only the provider CLI
// is the synthetic fixture, so no inference happens. CONDUCTOR_TEST_USER_DATA parks the window.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx15-control-activity.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-fx15-smoke-'))
const output = resolve('.conductor-scratch/fx15')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Native provider must receive the protocol briefing')
  return { endpoint, token }
}
const raw = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { status: response.status, payload: await response.json() }
}
const call = async (auth, method, args = {}) => {
  const { status, payload } = await raw(auth, method, args)
  assert.equal(status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const notices = async (id, key) => (await snapshot(id)).items.filter(item => item.data.type === 'notice' && item.data.payload && key in item.data.payload)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('FX15 smoke'))
  const git = (...args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' })
  git('init', '-b', 'main'); git('config', 'user.name', 'FX15 Smoke'); git('config', 'user.email', 'smoke@example.invalid')
  await writeFile(join(project.path, 'README.md'), 'SYNTHETIC fx15 smoke\n'); git('add', 'README.md'); git('commit', '-m', 'SYNTHETIC initial')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'FX15 smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const controllerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B the controller that drives a coworker', { ...state.settings, model: 'synthetic-claude', effort: 'low' }, [])
  }, controllerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  await expect.poll(async () => (await snapshot(controllerId))?.phase).toBe('completed')
  const controller = await credentials()
  await expect.poll(async () => (await raw(controller, 'tools.list')).status, { timeout: 15000 }).toBe(200)
  const controllerTitle = (await call(controller, 'tabs.list')).find(tab => tab.resourceId === controllerId).title

  // The controller drives a coworker the way a swarm controller does.
  const tab = await call(controller, 'tabs.open', { provider: 'claude', title: 'FX15 coworker' })
  const coworkerId = tab.resourceId
  await call(controller, 'agents.submit', { agentSessionId: coworkerId, prompt: 'SYNTHETIC B FX15 coworker does its work' })
  await expect.poll(async () => (await snapshot(coworkerId))?.phase, { timeout: 20000 }).toBe('completed')
  await call(controller, 'agents.steer', { agentSessionId: coworkerId, prompt: 'SYNTHETIC B FX15 coworker takes a steer' })
  await expect.poll(async () => (await snapshot(coworkerId))?.phase, { timeout: 20000 }).toBe('completed')
  await call(controller, 'tabs.rename', { tabId: tab.id, title: 'FX15 renamed coworker' })
  for (let index = 0; index < 4; index++) await call(controller, index % 2 ? 'agents.snapshot' : 'tabs.list', index % 2 ? { agentSessionId: coworkerId } : {})
  await writeFile(join(project.path, 'note.md'), 'SYNTHETIC delivered by the FX15 controller\n')
  let run = await call(controller, 'git.ship', { message: 'SYNTHETIC FX15 controller ships its note', paths: ['note.md'], waitSeconds: 90 })
  while (run.state === 'running') run = await call(controller, 'git.ship.status', { runId: run.id, waitSeconds: 60 })
  assert.equal(run.state, 'delivered', JSON.stringify(run.error ?? run.stages))
  await call(controller, 'git.ship.status', { runId: run.id })

  // 1. The controller's timeline: one chip row for the turn, reads collapsed, the commit on the ship.
  await expect.poll(async () => (await notices(controllerId, 'controlActivity')).length).toBe(1)
  const row = (await notices(controllerId, 'controlActivity'))[0].data.payload.controlActivity
  assert.deepEqual(row.actions.map(action => action.method), ['tabs.open', 'agents.submit', 'agents.steer', 'tabs.rename', 'git.ship'])
  assert.equal(row.actions.at(-1).commit, run.commit)
  assert.ok(row.reads >= 5, 'reads are counted: ' + row.reads)
  check('The controller gets one chip row for its turn: open, prompt, steer, rename, git.ship with its commit, reads counted')

  // A controller polling its coworker pays no tokens for these records.
  const polled = await call(controller, 'agents.snapshot', { agentSessionId: coworkerId })
  assert.ok(!polled.items.some(item => item.data.type === 'notice' && item.data.payload && ('controlledBy' in item.data.payload || 'controlActivity' in item.data.payload)), 'agents.snapshot leaves control records out')
  check('agents.snapshot leaves control records out of what a controller reads')
  const controllerTab = (await call(controller, 'tabs.list')).find(entry => entry.resourceId === controllerId)
  const sessionId = (await page.evaluate(id => window.conductor.sessions.list(id), project.id))[0].id
  const focus = tabId => page.evaluate(async value => window.conductor.agentControl.focusTab(value.projectId, value.sessionId, value.tabId), { projectId: project.id, sessionId, tabId })
  await focus(controllerTab.id)
  const controllerPane = page.locator(`.structured-agent-pane[data-structured-session="${controllerId}"]`)
  const chips = controllerPane.locator('.control-activity').first()
  await expect(chips).toBeVisible()
  await expect(chips.locator('.control-chip')).toContainText(['Opened FX15 coworker', 'Prompted', 'Steered', 'Renamed', 'git.ship → ' + run.commit.slice(0, 7), /^read \d+ times$/])
  await chips.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'controller-chips.png') })
  check('The controller tab shows the chip row, with the commit and one "read N times" chip')

  // 2. The coworker's timeline and tab entries name who drove it.
  const driven = (await notices(coworkerId, 'controlledBy')).map(item => item.data.payload.controlledBy)
  assert.deepEqual(driven.map(entry => [entry.verb, entry.title]), [['Opened', controllerTitle], ['Renamed', controllerTitle]])
  await focus(tab.id)
  const coworkerPane = page.locator(`.structured-agent-pane[data-structured-session="${coworkerId}"]`)
  await expect(coworkerPane.locator('.controlled-by-notice')).toHaveCount(2)
  await expect(coworkerPane.locator('.controlled-by-notice').first()).toContainText('Opened by ' + controllerTitle)
  await expect(page.locator(`.pane-tab[data-control-tab-id="${tab.id}"] .controlled-by-badge`)).toHaveAttribute('aria-label', 'Controlled by ' + controllerTitle)
  await page.screenshot({ path: join(output, 'coworker-controlled-by.png') })
  check('The coworker shows "Opened by" and "Renamed by" notices, and its tab a "Controlled by" badge')

  // Clicking the opener's name leads back to the controller.
  await coworkerPane.locator('.controlled-by-notice button').first().click()
  await expect(controllerPane).toBeVisible()
  check('The name in "Opened by" is one click back to the controller')

  // 3. The Processes board names the latest control action.
  await page.getByRole('button', { name: 'Processes', exact: true }).click()
  const board = page.locator('.pd-dashboard').first()
  await board.waitFor()
  await expect(board.locator(`[data-process-id="${controllerId}"] .pd-control-action`)).toHaveText('git.ship → ' + run.commit.slice(0, 7), { timeout: 15000 })
  await expect(board.locator(`[data-process-id="${coworkerId}"] .pd-control-action`)).toHaveText('Renamed by ' + controllerTitle)
  await page.screenshot({ path: join(output, 'processes-board.png') })
  check('The Processes board shows the latest control action per conversation')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', controllerId, coworkerId, commit: run.commit, row }, null, 2))
  console.log('\nsmoke-fx15-control-activity: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
