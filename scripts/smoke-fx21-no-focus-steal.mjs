import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// FX21 (feature-list.md dispatch-no-focus-steal): an agent-opened tab never steals the owner's
// focus. The owner types in tab A while a fixture controller dispatches two coworkers: the active
// tab and the caret stay in A, no keystroke is lost, and both coworkers appear with a "new" mark.
// Then the controller opens a tab with focus:true while the owner is still typing: it is brought
// into view only after the typing pause. Real Electron and control broker; only the provider CLI
// is the synthetic fixture. CONDUCTOR_TEST_USER_DATA parks the window.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx21-no-focus-steal.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-fx21-smoke-'))
const output = resolve('.conductor-scratch/fx21')
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
const errors = [], checks = [], evidence = {}
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Native provider must receive the protocol briefing')
  return { endpoint, token }
}
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const payload = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const activeTabId = () => page.evaluate(() => document.querySelector('.pane-tab.active')?.getAttribute('data-control-tab-id') ?? null)
/** Where the caret is: the structured session whose pane holds the focused element, and its tag. */
const caret = () => page.evaluate(() => {
  const element = document.activeElement
  return { session: element?.closest('.structured-agent-pane')?.getAttribute('data-structured-session') ?? null, tag: element?.tagName ?? null, value: element && 'value' in element ? element.value : null }
})
const sleep = ms => new Promise(done => setTimeout(done, ms))

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('FX21 smoke'))
  const git = (...args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' })
  git('init', '-b', 'main'); git('config', 'user.name', 'FX21 Smoke'); git('config', 'user.email', 'smoke@example.invalid')
  await writeFile(join(project.path, 'README.md'), 'SYNTHETIC fx21 smoke\n'); git('add', 'README.md'); git('commit', '-m', 'SYNTHETIC initial')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'FX21 smoke' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const controllerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B the controller that dispatches coworkers', { ...state.settings, model: 'synthetic-claude', effort: 'low' }, [])
  }, controllerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  await expect.poll(async () => (await snapshot(controllerId))?.phase).toBe('completed')
  const controller = await credentials()
  await expect.poll(async () => (await fetch(controller.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + controller.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tabs.list', args: {} }) })).status, { timeout: 15000 }).toBe(200)
  const tabA = (await call(controller, 'tabs.list')).find(tab => tab.resourceId === controllerId)
  assert.equal(await activeTabId(), tabA.id)

  // 1. The owner types in tab A while the controller dispatches two coworkers.
  const composer = page.locator(`.structured-agent-pane[data-structured-session="${controllerId}"]`).getByRole('textbox', { name: 'Message Claude Code', exact: true })
  const sentence = 'The owner keeps typing while two coworkers are dispatched.'
  await composer.click()
  const typing = composer.pressSequentially(sentence, { delay: 45 })
  await sleep(300)
  const dispatched = await call(controller, 'router.dispatch', { tasks: [
    { title: 'FX21 coworker one', prompt: 'SYNTHETIC B FX21 coworker one works', provider: 'claude' },
    { title: 'FX21 coworker two', prompt: 'SYNTHETIC B FX21 coworker two works', provider: 'claude' }
  ] })
  const midTyping = { active: await activeTabId(), caret: await caret() }
  await typing
  const coworkers = dispatched.map(entry => entry.tab ?? entry)
  const coworkerTabIds = (await call(controller, 'tabs.list')).filter(tab => tab.kind === 'agent' && tab.resourceId !== controllerId).map(tab => tab.id)
  assert.equal(coworkerTabIds.length, 2, 'both coworker tabs exist: ' + JSON.stringify(coworkers))
  assert.equal(midTyping.active, tabA.id, 'tab A stayed active while the coworkers opened')
  assert.equal(midTyping.caret.session, controllerId, 'the caret stayed in tab A while the coworkers opened')
  assert.equal(await activeTabId(), tabA.id)
  const after = await caret()
  assert.equal(after.session, controllerId); assert.equal(after.tag, 'TEXTAREA')
  assert.equal(after.value, sentence, 'no keystroke was lost')
  // The coworkers sit collapsed under the controller's chip, which carries the mark for them.
  await expect(page.locator('.coworker-tab-toggle .pane-tab-new-mark')).toBeVisible()
  await page.screenshot({ path: join(output, 'collapsed-new-mark.png') })
  await page.locator('.coworker-tab-toggle').click()
  for (const id of coworkerTabIds) {
    await expect(page.locator(`.pane-tab[data-control-tab-id="${id}"]`)).toHaveClass(/is-new/)
    await expect(page.locator(`.pane-tab[data-control-tab-id="${id}"] .pane-tab-new-mark`)).toBeVisible()
  }
  evidence.dispatch = { tabA: tabA.id, coworkerTabIds, midTyping, after }
  await page.screenshot({ path: join(output, 'dispatch-while-typing.png') })
  check('Owner typing in tab A while two coworkers are dispatched: tab A stays active, the caret stays in its composer, no keystroke is lost, both coworker tabs exist with a "new" mark')

  // 2. focus:true while the owner is still typing waits for the pause.
  const more = ' And a little more, slowly, so the focus request has to wait for the pause.'
  const moreTyping = composer.pressSequentially(more, { delay: 60 })
  await sleep(300)
  const requestedAt = Date.now()
  const wanted = await call(controller, 'tabs.open', { provider: 'claude', title: 'FX21 look here', focus: true })
  const answeredMs = Date.now() - requestedAt
  let movedDuringTyping = false
  let finished = false
  void moreTyping.then(() => { finished = true })
  while (!finished) {
    if (await activeTabId() !== tabA.id) movedDuringTyping = true
    await sleep(150)
  }
  const typingEnded = Date.now()
  assert.equal(movedDuringTyping, false, 'focus:true did not move the owner while they were typing')
  assert.equal((await caret()).value, sentence + more, 'no keystroke was lost to the focus request')
  await expect.poll(activeTabId, { timeout: 20000, intervals: [100] }).toBe(wanted.id)
  const movedAfterMs = Date.now() - typingEnded
  assert.ok(movedAfterMs >= 1000, 'focus waited for the typing pause, moved ' + movedAfterMs + ' ms after the last key')
  await expect(page.locator(`.pane-tab[data-control-tab-id="${wanted.id}"] .pane-tab-new-mark`)).toHaveCount(0)
  evidence.focusTrue = { wanted: wanted.id, answeredMs, typingMs: typingEnded - requestedAt, movedAfterMs }
  await page.screenshot({ path: join(output, 'focus-after-pause.png') })
  check(`focus:true while the owner types: the call answers in ${answeredMs} ms, the tab stays behind for the whole ${typingEnded - requestedAt} ms of typing and comes into view ${movedAfterMs} ms after the last key`)

  // 3. Looking at a coworker clears its mark.
  await page.locator(`.pane-tab[data-control-tab-id="${coworkerTabIds[0]}"]`).click()
  // Back to A the way the owner's own focus does (the controller chip's relationship marker covers A's tab button).
  const sessionId = (await page.evaluate(id => window.conductor.sessions.list(id), project.id))[0].id
  await page.evaluate(value => window.conductor.agentControl.focusTab(value.projectId, value.sessionId, value.tabId), { projectId: project.id, sessionId, tabId: tabA.id })
  await expect.poll(activeTabId).toBe(tabA.id)
  await expect(page.locator(`.pane-tab[data-control-tab-id="${coworkerTabIds[0]}"] .pane-tab-new-mark`)).toHaveCount(0)
  await expect(page.locator(`.pane-tab[data-control-tab-id="${coworkerTabIds[1]}"] .pane-tab-new-mark`)).toBeVisible()
  check('Viewing a new coworker clears its mark; the other keeps it')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, evidence }, null, 2))
  console.log('FX21 smoke passed: ' + checks.length + ' checks; evidence in ' + output)
} finally {
  await app.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
