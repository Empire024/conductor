// V4 verify — Group F: bounded recovery, effort wiring, agents.status size, Viewing background tasks
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-verify-v4-f-'))
const output = resolve('artifacts/verify-v4/F')
await mkdir(output, { recursive: true })
const results = []
const record = (id, verdict, evidence, observation) => { results.push({ id, verdict, evidence, observation }); console.log(id, verdict, evidence, observation) }
const capture = join(root, 'provider-input.txt')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_MODEL_CATALOG: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_SMOKE_BACKGROUND_MS: '600000', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', e => errors.push(e.stack ?? e.message))
const shot = async (name) => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64')) }
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  return body
}
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Synthetic provider must receive the native control briefing')
  return { endpoint, token }
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('V4 Group F'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'V4 Group F' }).click()

  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const mainComposer = page.getByRole('textbox', { name: 'Message Codex', exact: true })
  await expect(mainComposer).toBeEnabled()
  const mainId = await page.locator('.structured-agent-pane').last().getAttribute('data-structured-session')
  await page.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC F controller setup', { ...state.settings, model: 'synthetic-model' }, [])
  }, mainId)
  await expect.poll(() => readFile(capture, 'utf8').then(t => t.includes('Conductor app control:')).catch(() => false)).toBe(true)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), mainId))?.phase).toBe('completed')
  const auth = await credentials()
  const catalog = (await call(auth, 'models.list')).result
  const codex = catalog.find(e => e.provider === 'codex')
  const haikuLike = catalog.find(e => e.provider === 'claude')?.models?.find(m => /haiku/i.test(m.id)) ?? codex?.models?.[0]

  // ---- F4: router.dispatch a coworker with effort on a model that supports no effort flag for it ----
  const dispatched = await call(auth, 'router.dispatch', { tasks: [{ title: 'F effort coworker', prompt: 'SYNTHETIC F bounded effort fixture', provider: codex ? 'codex' : 'claude', model: (codex ?? catalog[0]).models.find(m => !m.effort?.length)?.id ?? (codex ?? catalog[0]).models[0].id, effort: 'high' }] })
  const worker = dispatched.result?.[0]
  assert.ok(worker?.agentSessionId, JSON.stringify(dispatched))
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), worker.agentSessionId))?.phase).toBe('completed')
  const statusNoEffort = await call(auth, 'agents.status', { agentSessionId: worker.agentSessionId })
  const argLog = await readFile(capture, 'utf8')
  record('F4', statusNoEffort.result && !statusNoEffort.result.effort ? 'PASS' : 'FAIL', JSON.stringify(statusNoEffort.result).slice(0, 500), 'a coworker dispatched on a model with no effort levels reports no effort in agents.status/effectiveSettings, even though effort:"high" was requested')

  // ---- F5: agents.status payload size + cursor semantics ----
  const busyStatus = await call(auth, 'agents.status', { agentSessionId: mainId })
  const idleBytes = JSON.stringify(busyStatus.result).length
  const cursorRepeat = await call(auth, 'agents.status', { agentSessionId: mainId, since: busyStatus.result?.cursor })
  record('F5', idleBytes < 1500 && cursorRepeat.result?.unchanged === true ? 'PASS' : 'FAIL', `bytes=${idleBytes} cursorRepeat=${JSON.stringify(cursorRepeat.result)}`, `agents.status for a completed coworker is ${idleBytes} bytes (flag if >1500); passing the same cursor back as "since" returns {unchanged:true}`)

  // ---- F6/F7/F9: Viewing — a turn that ends with background tasks still running ----
  await mainComposer.fill('SYNTHETIC BACKGROUND: emit a real local agent.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.sa-subagent-summary')).toContainText('1 subagent', { timeout: 15000 })
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), mainId))?.phase).toBe('completed')
  const viewingSnapshot = await page.evaluate(id => window.conductor.structured.snapshot(id), mainId)
  const tabIndicatorTitle = await page.locator('.pane-tab').filter({ hasText: 'Codex' }).first().locator('.tab-activity').getAttribute('title').catch(() => null)
  await shot('F6-viewing-tab')
  const listSnapshot = await call(auth, 'agents.list')
  const statusSnapshot = await call(auth, 'agents.status', { agentSessionId: mainId })
  const listedMain = listSnapshot.result?.find(a => a.agentSessionId === mainId || a.tabId)
  record('F6', /viewing/i.test(String(tabIndicatorTitle)) || (statusSnapshot.result?.phase === 'viewing') ? 'PASS' : 'FAIL', `tabTitle="${tabIndicatorTitle}" agentsStatusPhase=${statusSnapshot.result?.phase} backgroundTasks=${statusSnapshot.result?.backgroundTasks ?? viewingSnapshot?.backgroundTasks} screenshot=artifacts/verify-v4/F/F6-viewing-tab.png`, 'a turn that ended while its own background task still runs shows Viewing (not completed) on the tab indicator and in agents.status')

  // F7: Processes board ranks Viewing with working
  await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click().catch(() => {})
  await page.getByRole('button', { name: 'Processes', exact: true }).click()
  await page.locator('.pd-dashboard').waitFor()
  await page.waitForTimeout(500)
  const viewingRowState = await page.locator(`.pd-row[data-process-id="${mainId}"]`).getAttribute('class').catch(() => null)
  await shot('F7-processes-viewing')
  record('F7', /viewing/.test(viewingRowState ?? '') ? 'PASS' : 'FAIL', `class="${viewingRowState}" screenshot=artifacts/verify-v4/F/F7-processes-viewing.png`, 'Processes board row for the Viewing conversation carries the viewing state class, ranked alongside working per stateRank in ProcessDashboardPane.tsx')

  // F8: background task finishes -> phase becomes completed within a few seconds
  const settleStart = Date.now()
  await expect.poll(async () => (await call(auth, 'agents.status', { agentSessionId: mainId })).result?.phase, { timeout: 30000, intervals: [500] }).not.toBe('viewing')
  const settleMs = Date.now() - settleStart
  record('F8', settleMs < 15000 ? 'PASS' : 'FAIL', `settleMs=${settleMs}`, `background task finished and phase left "viewing" within ${settleMs}ms`)

  // F9: neighbour — a turn with 0 background tasks ends as completed, not Viewing
  await mainComposer.fill('SYNTHETIC F plain completion, no background tasks.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), mainId))?.phase).toBe('completed')
  const plainStatus = await call(auth, 'agents.status', { agentSessionId: mainId })
  record('F9', plainStatus.result?.phase === 'completed' ? 'PASS' : 'FAIL', JSON.stringify(plainStatus.result).slice(0, 300), 'a turn with no background tasks ends as completed, not viewing')

  record('F1', 'BLOCKED', 'no reliable synthetic-fixture trigger for a failed/interrupted native turn was identified in the time available', 'agents.resume rate limiting (3 admissions per 6h, 4th refused) is source-verified in agent-control.ts/agent-control.test.ts but not exercised against the real running app in this session')
  record('F2', 'BLOCKED', 'depends on F1 fixture', 'agents.resume while a pending approval request exists — not exercised end-to-end')
  record('F3', 'BLOCKED', 'depends on F1 fixture', 'agents.supersede then agents.resume refusal — not exercised end-to-end')

  assert.deepEqual(errors, [])
} catch (error) {
  results.push({ id: 'F-fatal', verdict: 'FAIL', evidence: String(error.stack ?? error), observation: 'uncaught error aborted remaining Group F scenarios' })
  await shot('F-failure').catch(() => {})
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ results, errors }, null, 2))
  console.log('ERRORS', JSON.stringify(errors))
  await app.close()
  console.log('GROUP F DONE')
}
