import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// FX8 `auto-close-finished-coworkers`: finished coworker tabs close themselves and give their CLI
// process back. Real Electron main/preload/renderer, the real loopback control broker and a real
// local git.ship; only the provider CLI is the synthetic fixture, so no inference happens.
// CONDUCTOR_TEST_USER_DATA parks the window off every display. Run through the smoke lock:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-coworker-autoclose.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-autoclose-smoke-'))
const output = resolve('artifacts/fx8-coworker-autoclose')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures'),
  // The owner's minutes become seconds for this launch only (index.ts honours it for test profiles).
  CONDUCTOR_TEST_COWORKER_AUTOCLOSE_MS: '4000'
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
  return { endpoint, token, briefing }
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
const setMinutes = minutes => page.evaluate(value => window.conductor.settings.setCoworkerAutoClose(value), minutes)

/** The fixture CLI processes this launch owns: every descendant of its main process running fake-claude.mjs. */
const mainPid = app.process().pid
const fixtureProcesses = () => {
  const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const all = JSON.parse(json), children = new Map()
  for (const entry of all) children.set(entry.ParentProcessId, [...(children.get(entry.ParentProcessId) ?? []), entry])
  const found = [], queue = [mainPid], seen = new Set()
  while (queue.length) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of children.get(pid) ?? []) { queue.push(child.ProcessId); if (String(child.CommandLine ?? '').includes('fake-claude.mjs')) found.push(child) }
  }
  return found
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  const project = await page.evaluate(() => window.conductor.projects.create('Autoclose smoke'))
  // A plain local repository with no package scripts: git.ship commits locally, with nothing to test or build.
  const git = (...args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Autoclose Smoke'); git('config', 'user.email', 'smoke@example.invalid')
  await writeFile(join(project.path, 'README.md'), 'SYNTHETIC autoclose smoke\n'); git('add', 'README.md'); git('commit', '-m', 'SYNTHETIC initial')
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Autoclose smoke' }).click()
  // Off while the explicit routes are exercised, so the timer cannot act first.
  assert.equal(await setMinutes(0), 0)
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
  // The launcher's layout save can trail the first turn; the tab must be saved before it can call.
  await expect.poll(async () => (await raw(controller, 'tools.list')).status, { timeout: 15000 }).toBe(200)
  assert.ok((await call(controller, 'tools.list'))['agents.finish'], 'agents.finish must be discoverable')
  assert.ok(!controller.briefing.includes('agents.finish({}) so your tab'), 'The owner’s own tab is not told to finish itself')
  check('The controller discovers agents.finish and, being the owner’s own tab, is not told to finish itself')

  const dispatch = async title => {
    const tab = await call(controller, 'tabs.open', { provider: 'claude', title })
    await call(controller, 'agents.submit', { agentSessionId: tab.resourceId, prompt: 'SYNTHETIC B ' + title + ' does its work' })
    await expect.poll(async () => (await snapshot(tab.resourceId))?.phase, { timeout: 20000 }).toBe('completed')
    return { tab, id: tab.resourceId, auth: await credentials() }
  }
  const open = async () => (await call(controller, 'tabs.list')).map(tab => tab.id)
  const closedTabs = async () => (await page.evaluate(id => window.conductor.sessions.list(id), project.id)).flatMap(session => session.closedTabs.map(tab => tab.id))

  // 1. The controller finishes a settled coworker: gone at once, history kept, CLI released.
  const a = await dispatch('Coworker A')
  assert.ok(a.auth.briefing.includes('When your work is delivered and reported, end with agents.finish({}) so your tab and CLI are released.'), 'A coworker is told to finish itself')
  const before = fixtureProcesses().length
  assert.ok(before >= 2, 'The controller and its coworker each run a fixture CLI: ' + before)
  const finished = await call(controller, 'agents.finish', { agentSessionId: a.id })
  assert.equal(finished.finished, true)
  assert.ok(!(await open()).includes(a.tab.id), 'The finished coworker’s tab is closed')
  assert.ok((await closedTabs()).includes(a.tab.id), 'Its tab is kept in the workspace’s closed tabs, reopenable with its history')
  assert.ok((await snapshot(a.id)).items.length > 0, 'Its conversation history is kept')
  await expect(page.locator(`[data-structured-session="${a.id}"]`)).toHaveCount(0)
  await expect.poll(() => fixtureProcesses().length, { timeout: 15000 }).toBe(before - 1)
  check('agents.finish from the controller closes a settled coworker at once, keeps its history and ends its CLI process')

  // 2. A coworker finishes itself as its last act.
  const b = await dispatch('Coworker B')
  const beforeSelf = fixtureProcesses().length
  const self = await call(b.auth, 'agents.finish', {})
  assert.equal(self.finished, false)
  assert.match(self.note, /as soon as this turn settles/)
  await expect.poll(async () => (await open()).includes(b.tab.id), { timeout: 15000 }).toBe(false)
  assert.ok((await closedTabs()).includes(b.tab.id))
  await expect.poll(() => fixtureProcesses().length, { timeout: 15000 }).toBe(beforeSelf - 1)
  check('agents.finish({}) from a coworker closes its own tab and ends its CLI once its turn has settled')

  // 3. The timer: a coworker whose git.ship was delivered closes after the idle timeout; an
  // undelivered one stays open but its idle CLI is released, and the next message brings it back.
  const c = await dispatch('Coworker C')
  const d = await dispatch('Coworker D')
  await writeFile(join(project.path, 'note.md'), 'SYNTHETIC delivered by coworker C\n')
  let run = await call(c.auth, 'git.ship', { message: 'SYNTHETIC coworker C delivers its note', paths: ['note.md'], waitSeconds: 90 })
  while (run.state === 'running') run = await call(c.auth, 'git.ship.status', { runId: run.id, waitSeconds: 60 })
  assert.equal(run.state, 'delivered', JSON.stringify(run.error ?? run.stages))
  assert.equal(run.requestedBy.agentSessionId, c.id)
  assert.match(git('log', '-1', '--format=%s'), /coworker C delivers/)
  assert.ok((await open()).includes(c.tab.id), 'Nothing closes while the timer is Off')
  check('A coworker’s real local git.ship ends delivered, and with the timer Off its tab stays open')

  assert.equal(await setMinutes(10), 10)
  await expect.poll(async () => (await open()).includes(c.tab.id), { timeout: 30000 }).toBe(false)
  assert.ok((await closedTabs()).includes(c.tab.id), 'The auto-closed tab is kept in the closed tabs')
  const stillOpen = await open()
  assert.ok(stillOpen.includes(d.tab.id), 'An undelivered coworker stays open')
  const controllerTab = (await call(controller, 'tabs.list')).find(tab => tab.resourceId === controllerId)
  assert.ok(controllerTab && stillOpen.includes(controllerTab.id), 'The owner’s own tab stays open')
  check('After the idle timeout the delivered coworker closes by itself; the undelivered coworker and the owner’s tab stay')

  await expect.poll(() => fixtureProcesses().length, { timeout: 30000 }).toBe(0)
  assert.equal((await snapshot(d.id)).phase, 'completed', 'A released conversation keeps its settled phase')
  await expect(page.locator(`[data-structured-session="${d.id}"]`)).toHaveCount(1)
  check('Every settled CLI idle past the timeout is released while the tabs keep their settled state')

  assert.equal(await setMinutes(0), 0)
  const items = (await snapshot(d.id)).items.length
  await call(controller, 'agents.submit', { agentSessionId: d.id, prompt: 'SYNTHETIC B Coworker D continues after its CLI was released' })
  await expect.poll(async () => { const state = await snapshot(d.id); return state.phase === 'completed' && state.items.length > items }, { timeout: 20000 }).toBe(true)
  const resumed = fixtureProcesses()
  assert.equal(resumed.length, 1, 'Only the conversation that was messaged starts a CLI again')
  assert.match(String(resumed[0].CommandLine), /--resume/, 'The restarted CLI resumes the same native conversation')
  check('The next message restarts the released CLI lazily and resumes the same native conversation')

  // The owner's control: Settings > Usage > "Close finished coworkers after", default 10 min, with Off.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true })
  await panel.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Usage', exact: true }).click()
  const picker = panel.getByRole('combobox', { name: 'Close finished coworkers after' })
  await expect(picker).toHaveValue('0')
  await picker.selectOption('30')
  await expect.poll(() => page.evaluate(() => window.conductor.settings.coworkerAutoClose())).toBe(30)
  await expect(picker.locator('option')).toHaveText(['5 minutes', '10 minutes', '20 minutes', '30 minutes', '1 hour', 'Off'])
  await page.screenshot({ path: join(output, 'coworker-autoclose-setting.png') })
  await picker.selectOption('0')
  await expect.poll(() => page.evaluate(() => window.conductor.settings.coworkerAutoClose())).toBe(0)
  await page.keyboard.press('Escape')
  check('Settings > Usage offers “Close finished coworkers after” with Off, and a choice there is saved')

  await page.screenshot({ path: join(output, 'coworker-autoclose.png') })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process', controllerId, coworkers: { finishedByController: a.id, finishedItself: b.id, autoClosed: c.id, released: d.id }, delivery: { runId: run.id, commit: run.commit } }, null, 2))
  console.log('\nsmoke-coworker-autoclose: ' + checks.length + ' checks passed')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
