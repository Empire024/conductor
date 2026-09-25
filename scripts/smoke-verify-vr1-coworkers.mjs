// VR1 group coworkers (feature-list.md auto-close-finished-coworkers): finished coworkers close
// themselves and settled tabs release their CLI; the tabs Conductor must never close stay open.
//   A1  six coworkers of one controller, three delivered: those close, every settled CLI is released
//   A2  delivered but protected (unsent draft, running background task, controls a live coworker)
// Real Electron, control broker and local git.ship; the provider CLI is the synthetic fixture.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr1-coworkers.mjs
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, call, configure, descendantsOf, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr1-coworkers', output: 'artifacts/verification/2026-09-25-vr1' })
watchdog(17 * 60)
const TIMEOUT_MS = 4000

try {
  await loadCheck()
  // Each prompt's text (the briefing carries the tab's own control credential) lands here.
  const capture = join(await mkdtemp(join(tmpdir(), 'vr1-capture-')), 'provider-input.txt')
  const inst = await launchParked({ mode: 'playwright', name: 'vr1-coworkers', env: {
    CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
    CONDUCTOR_TEST_FIXTURE_DIR: join(REPO, 'scripts', 'fixtures'), CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_COWORKER_AUTOCLOSE_MS: String(TIMEOUT_MS), CONDUCTOR_SMOKE_BACKGROUND_MS: '600000'
  } })
  const project = await openProject({ name: 'VR1 coworkers', git: true })
  const view = await page()
  const setMinutes = minutes => view.evaluate(value => window.conductor.settings.setCoworkerAutoClose(value), minutes)
  const status = id => call('agents.status', { agentSessionId: id })
  const settled = id => poll(async () => (await status(id)).phase === 'completed', { timeoutMs: 30_000, label: `${id} to complete` })
  const captured = async () => {
    const text = await readFile(capture, 'utf8')
    return { endpoint: text.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: text.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  }
  const as = async (auth, method, args = {}) => {
    const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const body = await response.json()
    if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 600)}`)
    return body.result
  }
  const fixtureClis = async () => { const { list } = await listProcesses(); const tree = descendantsOf(list, [inst.credential.pid]); return list.filter(entry => tree.has(entry.pid) && entry.commandLine.includes('fake-claude.mjs')) }
  const openIds = async () => (await call('tabs.list')).map(tab => tab.id)
  const closedIds = async () => (await view.evaluate(id => window.conductor.sessions.list(id), project.id)).flatMap(session => session.closedTabs.map(tab => tab.id))

  step('controller')
  await setMinutes(0)
  const controllerTab = await openTab({ provider: 'claude', title: 'VR1 controller' })
  await call('agents.submit', { agentSessionId: controllerTab.resourceId, prompt: 'SYNTHETIC B the controller that dispatches coworkers' })
  await settled(controllerTab.resourceId)
  const controller = await captured()
  await poll(async () => (await as(controller, 'tools.list').then(() => true, () => false)), { timeoutMs: 15_000, label: 'controller credential' })
  const dispatch = async (auth, title) => {
    const tab = await as(auth, 'tabs.open', { provider: 'claude', title })
    await as(auth, 'agents.submit', { agentSessionId: tab.resourceId, prompt: `SYNTHETIC B ${title} does its work` })
    await settled(tab.resourceId)
    return { tab, id: tab.resourceId, auth: await captured() }
  }
  const ship = async (worker, file) => {
    await writeFile(join(project.path, file), `SYNTHETIC ${file}\n`)
    let run = await as(worker.auth, 'git.ship', { message: `SYNTHETIC ${worker.tab.title} delivers ${file}`, paths: [file], waitSeconds: 90 })
    while (run.state === 'running') run = await as(worker.auth, 'git.ship.status', { runId: run.id, waitSeconds: 60 })
    if (run.state !== 'delivered') throw new Error(`git.ship for ${file} ended ${run.state}: ${JSON.stringify(run.error ?? run.stages).slice(0, 500)}`)
    return run
  }

  // A1: six coworkers, three delivered.
  step('A1 dispatch six coworkers')
  const workers = []
  for (let index = 1; index <= 6; index++) workers.push(await dispatch(controller, `W${index}`))
  for (const worker of workers.slice(0, 3)) await ship(worker, `${worker.tab.title}.md`)
  const clisOff = (await fixtureClis()).length
  await sleep(TIMEOUT_MS * 3)
  const openOff = await openIds()
  const controlOk = clisOff >= 7 && workers.every(worker => openOff.includes(worker.tab.id))
  step('A1 timer on')
  await setMinutes(10)
  const delivered = workers.slice(0, 3), undelivered = workers.slice(3)
  const closedInS = await poll(async () => { const open = await openIds(); return delivered.every(worker => !open.includes(worker.tab.id)) }, { timeoutMs: 60_000, label: 'delivered coworkers to close' }).then(() => true, () => false)
  const released = await poll(async () => (await fixtureClis()).length === 0, { timeoutMs: 60_000, label: 'settled CLIs to be released' }).then(() => true, () => false)
  const openOn = await openIds(), closed = await closedIds()
  const phases = await Promise.all(undelivered.map(async worker => (await status(worker.id)).phase))
  const a1 = {
    clisWithTimerOff: clisOff, clisAfter: (await fixtureClis()).length, deliveredClosed: delivered.filter(worker => !openOn.includes(worker.tab.id)).length,
    deliveredInClosedTabs: delivered.filter(worker => closed.includes(worker.tab.id)).length, undeliveredOpen: undelivered.filter(worker => openOn.includes(worker.tab.id)).length,
    undeliveredPhases: phases, controllerOpen: openOn.includes(controllerTab.id), controlOk
  }
  const a1Shot = await shot('vr1-A1-after-autoclose')
  record('A1', controlOk && closedInS && released && a1.deliveredInClosedTabs === 3 && a1.undeliveredOpen === 3 && a1.controllerOpen && phases.every(phase => phase === 'completed') ? 'PASS' : 'FAIL', a1, `control: timer Off kept ${clisOff} CLIs and all tabs for ${TIMEOUT_MS * 3} ms; ${a1Shot}`)

  // A2: delivered coworkers Conductor must not close, and one plain delivered control.
  step('A2 protected coworkers')
  await setMinutes(0)
  const draft = await dispatch(controller, 'W7 draft')
  const background = await dispatch(controller, 'W8 background')
  await as(controller, 'agents.submit', { agentSessionId: background.id, prompt: 'SYNTHETIC BASH WAIT: a long render in the background' })
  await poll(async () => { const state = await view.evaluate(id => window.conductor.structured.snapshot(id), background.id); return state?.phase === 'completed' && state.backgroundTasks === 1 }, { timeoutMs: 30_000, label: 'W8 settled with a background task' })
  const parent = await dispatch(controller, 'W9 controller')
  const child = await dispatch(parent.auth, 'W10 child of W9')
  const plain = await dispatch(controller, 'W11 plain')
  for (const [worker, file] of [[draft, 'w7.md'], [background, 'w8.md'], [parent, 'w9.md'], [plain, 'w11.md']]) await ship(worker, file)
  const sessionId = (await view.evaluate(id => window.conductor.sessions.list(id), project.id))[0].id
  await view.evaluate(value => window.conductor.agentControl.focusTab(value.projectId, value.sessionId, value.tabId), { projectId: project.id, sessionId, tabId: draft.tab.id })
  const box = view.locator(`.structured-agent-pane[data-structured-session="${draft.id}"]`).getByRole('textbox', { name: 'Message Claude Code', exact: true })
  await box.fill('VR1 unsent owner words')
  await setMinutes(10)
  const plainClosed = await poll(async () => !(await openIds()).includes(plain.tab.id), { timeoutMs: 60_000, label: 'W11 to close' }).then(() => true, () => false)
  await sleep(TIMEOUT_MS * 3)
  const openA2 = await openIds()
  const a2 = { plainClosed, draftOpen: openA2.includes(draft.tab.id), backgroundOpen: openA2.includes(background.tab.id), controllerOfLiveOpen: openA2.includes(parent.tab.id), childOpen: openA2.includes(child.tab.id), draftText: await box.inputValue().catch(() => null) }
  const a2Shot = await shot('vr1-A2-protected')
  record('A2', plainClosed && a2.draftOpen && a2.backgroundOpen && a2.controllerOfLiveOpen ? 'PASS' : 'FAIL', a2, `control: plain delivered W11 closed (${plainClosed}); ${a2Shot}`)
  await setMinutes(0)
} catch (error) {
  await failed(error, 'vr1-coworkers')
}
await finish()
