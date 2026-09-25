// VR1 group control (feature-list.md 44a4ba26): show, Conductor-side and without tokens, when an agent
// uses Conductor and what it did. F-fx15 covers open / prompt / steer / rename / git.ship; this adds
//   C1  interrupt, a failed mutation, close, an app-wide action (app.update from an Auto coworker):
//       chips on the controller, "Interrupted by" / "Closed by" on the coworker, the status-bar history
//   C2  none of it reaches a model: the controller's next prompt and agents.history leave it out
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr1-control.mjs
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'vr1-control', output: 'artifacts/verification/2026-09-25-vr1' })
watchdog(12 * 60)

try {
  await loadCheck()
  const capture = join(await mkdtemp(join(tmpdir(), 'vr1-capture-')), 'provider-input.txt')
  await launchParked({ mode: 'playwright', name: 'vr1-control', env: { CONDUCTOR_TEST_FIXTURE_DIR: join(REPO, 'scripts', 'fixtures'), CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  // Checkout-shaped stubs so app.update gets past LocalUpdateBuilder.unsupported; the stub build exits 1.
  const project = await openProject({ name: 'VR1 control', git: true, files: { 'package.json': '{"name":"conductor-desktop","private":true}\n', 'node_modules/electron-builder/cli.js': '// VR1 stub\n', 'scripts/build-local-update.mjs': "console.log('VR1 stub build: nothing is built'); process.exit(1)\n" } })
  const view = await page()
  const snapshot = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const phase = async id => (await snapshot(id))?.phase
  const captured = async () => { const text = await readFile(capture, 'utf8'); return { text, endpoint: text.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: text.match(/Bearer ([a-f0-9]{64})/)?.[1] } }
  const raw = async (auth, method, args = {}) => { const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000) }); return { status: response.status, body: await response.json() } }
  const as = async (auth, method, args = {}) => { const { status, body } = await raw(auth, method, args); if (status !== 200 || body.error) throw new Error(`${method} -> ${status} ${JSON.stringify(body.error ?? body).slice(0, 500)}`); return body.result }
  const notices = async (id, key) => ((await snapshot(id))?.items ?? []).filter(item => item.data.type === 'notice' && item.data.payload && key in item.data.payload)

  step('controller turn 1')
  const controllerTab = await openTab({ provider: 'claude', title: 'VR1 controller' })
  const controllerId = controllerTab.resourceId
  await call('agents.submit', { agentSessionId: controllerId, prompt: 'SYNTHETIC B the controller, turn one' })
  await poll(async () => (await phase(controllerId)) === 'completed', { timeoutMs: 30_000, label: 'controller turn 1' })
  const controller = await captured()
  await poll(() => as(controller, 'tools.list').then(() => true, () => false), { timeoutMs: 15_000, label: 'controller credential' })
  const controllerTitle = (await call('tabs.list')).find(tab => tab.resourceId === controllerId).title

  step('C1 interrupt, failed mutation, app-wide action, close')
  const tab = await as(controller, 'tabs.open', { provider: 'claude', title: 'VR1 coworker' })
  const coworkerId = tab.resourceId
  await as(controller, 'agents.submit', { agentSessionId: coworkerId, prompt: 'SYNTHETIC STREAM 10 300' })
  await poll(async () => (await phase(coworkerId)) === 'running', { timeoutMs: 30_000, label: 'coworker streaming' })
  const coworker = await captured()
  await as(controller, 'agents.interrupt', { agentSessionId: coworkerId })
  await poll(async () => !['running', 'starting', 'interrupting'].includes(await phase(coworkerId)), { timeoutMs: 30_000, label: 'coworker interrupted' })
  const failedRename = await raw(controller, 'tabs.rename', { tabId: 'tab_does_not_exist', title: 'nope' })
  // app.update from the Auto coworker: app-wide, recorded in the status-bar history. The tiny
  // project has no build, so the build itself fails at once; the call is what is recorded.
  const update = await withDeadline(raw(coworker, 'app.update'), 30_000)
  await as(controller, 'tabs.close', { tabId: tab.id })
  await sleep(6000)
  const rows = await notices(controllerId, 'controlActivity')
  const actions = rows.at(-1)?.data.payload.controlActivity.actions ?? []
  const methods = actions.map(action => `${action.method}${action.failed ? '!' : ''}`)
  const driven = (await notices(coworkerId, 'controlledBy')).map(item => `${item.data.payload.controlledBy.verb} by ${item.data.payload.controlledBy.title}`)
  const sessionId = (await view.evaluate(id => window.conductor.sessions.list(id), project.id))[0].id
  await view.evaluate(value => window.conductor.agentControl.focusTab(value.projectId, value.sessionId, value.tabId), { projectId: project.id, sessionId, tabId: controllerTab.id })
  const pane = view.locator(`.structured-agent-pane[data-structured-session="${controllerId}"]`)
  await pane.locator('.control-activity').first().waitFor({ timeout: 15_000 }).catch(() => {})
  const chips = await pane.locator('.control-activity .control-chip').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent.trim(), cls: node.className })))
  // The status bar re-reads the app history every 30 s (ControlActivity.tsx), so wait 2x that.
  const appEntries = await view.evaluate(() => window.conductor.agentControl.appActivity())
  const historyStarted = Date.now()
  const history = await poll(() => view.locator('.app-control-history .statusbar-link').first().getAttribute('title', { timeout: 1000 }).catch(() => null), { timeoutMs: 70_000, intervalMs: 1000, label: 'the status-bar app history' }).catch(() => null)
  const historySeconds = history ? Math.round((Date.now() - historyStarted) / 1000) : null
  const c1Shot = await shot('vr1-C1-controller-chips')
  const c1 = { rows: rows.length, methods, driven, chips, failedRename: failedRename.status, update: update.ok ? { status: update.value.status, authorizedBy: update.value.body?.result?.authorizedBy, error: update.value.body?.error } : 'timeout', history, historySeconds, appEntries: appEntries.map(entry => `${entry.label} by ${entry.by?.title}`) }
  const control = methods.includes('tabs.open') && chips.some(chip => chip.text.startsWith('Opened'))
  const want = ['agents.interrupt', 'tabs.rename!', 'tabs.close']
  record('C1', control && rows.length === 1 && want.every(method => methods.includes(method)) && chips.some(chip => /failed/.test(chip.cls)) &&
    driven.includes(`Interrupted by ${controllerTitle}`) && driven.includes(`Closed by ${controllerTitle}`) && /Built a local update by VR1 coworker/.test(history ?? '') ? 'PASS' : 'FAIL',
    c1, `control: the Opened chip in the same row (${control}); ${c1Shot}`)

  step('C2 the next prompt carries none of it')
  await call('agents.submit', { agentSessionId: controllerId, prompt: 'SYNTHETIC B the controller, turn two' })
  await poll(async () => (await phase(controllerId)) === 'completed' && (await captured()).text.includes('turn two'), { timeoutMs: 30_000, label: 'controller turn 2' })
  const prompt = (await captured()).text
  const leaks = ['controlActivity', 'controlledBy', 'Opened VR1', 'Interrupted VR1', 'Closed VR1', 'control-chip', 'Built a local update', 'read 1 time', 'tab_does_not_exist'].filter(needle => prompt.includes(needle))
  const historyItems = await call('agents.history', { agentSessionId: controllerId }).catch(error => ({ error: String(error.message) }))
  const historyText = JSON.stringify(historyItems)
  const historyLeaks = ['controlActivity', 'controlledBy'].filter(needle => historyText.includes(needle))
  record('C2', prompt.includes('turn two') && leaks.length === 0 && historyLeaks.length === 0 && !historyItems.error ? 'PASS' : 'FAIL',
    { promptChars: prompt.length, leaks, historyLeaks, historyError: historyItems.error ?? null }, `control: the captured prompt holds this turn's own words (${prompt.includes('turn two')}); capture ${capture}`)
} catch (error) {
  await failed(error, 'vr1-control')
}
await finish()
