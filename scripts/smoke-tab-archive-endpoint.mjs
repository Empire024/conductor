// P0 acceptance for the atomic tab archive (feature-list 4538163d, src/main/tab-archive-eligibility.ts),
// scenario E2: the REAL app-control endpoint `tabs.archive`, in a parked Electron window with a
// synthetic Claude CLI (no inference). The owner credential is the instance's control-owner.json
// (verify-kit `call`); a wizard tab and plain coworkers use the credentials their briefings carry.
//   E2a-coworker-refused     a plain coworker calling tabs.archive is refused (owner/wizard only)
//   E2a-wizard-allowed       a wizard tab may call it (proved in E2b-collected-archived)
//   E2b-uncollected-refused  a finished child whose report waits uncollected in its busy controller
//                            is refused with the exact reason
//   E2b-collected-archived   once the controller's turn ends and the report is delivered as its next
//                            turn, the same call (from the wizard) archives the child
//   E2c-busy-target-refused  the target itself is mid-turn: owner, wizard and UI archives are refused
//                            with the busy reason; the tab stays open and unlatched, the turn is not
//                            interrupted and settles completed with its exact final answer
//   E2c-race-refused         submits and steers fired at the child around the final UI ack are all
//                            refused and never run; the tab stays archived
//   E2d-late-refused         a submit after the successful archive stays refused
//   E2d-reopen-clears        reopening the tab from the archive clears the latch; the submit runs
//   E2-info-agents-submit    (INFO) what app-control agents.submit does to an archived conversation
// Screenshots: artifacts/tab-archive-endpoint/*.png.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-tab-archive-endpoint.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'tab-archive-endpoint', output: 'artifacts/tab-archive-endpoint' })
watchdog(1200)

const capture = join(tmpdir(), `conductor-archive-endpoint-capture-${process.pid}.txt`)
const releases = await mkdtemp(join(tmpdir(), 'conductor-archive-release-'))
// "HOLD <key>" keeps the turn running until the file <releases>/<key> exists, then answers
// "FINAL <key>: the held turn finished intact."; anything else is answered at once. Every prompt
// is written to the capture file (its briefing holds the credential). Like the installed CLI
// (scripts/smoke-v3-s1-s2.mjs, claude.test.ts), input arriving during a held turn is queued: a
// steer (priority 'next') is acknowledged with command_lifecycle 'queued', and after the held
// turn's result each runs as its own native turn ('started', then 'completed'); an interrupt
// cancels the queue and names the cancelled steers in its receipt.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const text = value => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: value }] } })
let holding = null
const queued = []
const answer = (prompt, steer) => {
  if (steer) emit({ type: 'command_lifecycle', command_uuid: steer, state: 'started' })
  emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' })
  text('Done: ' + prompt.split('\\n', 1)[0].slice(0, 60))
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  if (steer) emit({ type: 'command_lifecycle', command_uuid: steer, state: 'completed' })
}
setInterval(() => {
  if (!holding || !existsSync(join(process.env.CONDUCTOR_TEST_ARCHIVE_RELEASES, holding))) return
  const key = holding
  holding = null
  text('FINAL ' + key + ': the held turn finished intact.')
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  for (const next of queued.splice(0)) answer(next.prompt, next.steer)
}, 150)
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const kind = message.request.subtype
    const cancelled = kind === 'interrupt' ? queued.splice(0).map(entry => entry.steer).filter(Boolean) : []
    const response = kind === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'synthetic-claude', displayName: 'Synthetic' }] } : kind === 'interrupt' ? { cancelled } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    if (kind === 'interrupt' && holding) { holding = null; emit({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }) }
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  if (holding) {
    const steer = message.priority === 'next' ? message.uuid : undefined
    queued.push({ prompt, steer })
    if (steer) emit({ type: 'command_lifecycle', command_uuid: steer, state: 'queued' })
    return
  }
  const hold = prompt.match(/HOLD (\\w+)/)
  if (hold) { emit({ type: 'system', subtype: 'init', model: 'claude-fable-5-1' }); holding = hold[1]; text('Working on it.'); return }
  answer(prompt)
})
`

const tabCall = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 800)}`)
  return body.result
}
const refusal = promise => promise.then(result => { throw new Error('expected a refusal, got ' + JSON.stringify(result).slice(0, 300)) }, error => String(error?.message ?? error))
const phaseOf = async id => (await call('agents.status', { agentSessionId: id })).phase
const settled = id => poll(async () => /^(completed|idle)$/.test(await phaseOf(id) ?? ''), { timeoutMs: 45_000, label: `${id} settles` })
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  const result = await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'the tab must receive an app-control briefing')
  return { auth: { endpoint, token }, result }
}
const openIds = async () => (await call('tabs.list')).map(tab => tab.id)

let view
const snap = async name => { const file = join('artifacts', 'tab-archive-endpoint', name + '.png'); await view.screenshot({ path: file }); return file.split('\\').join('/') }
try {
  step('launch and open the project')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_ARCHIVE_RELEASES: releases } })
  await openProject({ name: 'tab archive endpoint', git: true })
  view = await page(inst)
  await view.evaluate(() => Promise.all([window.conductor.settings.setFinishedTabSweep(0), window.conductor.settings.setCoworkerAutoClose(0)]))
  const projectId = inst.projectId, sessionId = inst.workspaceId
  const archivedIds = async () => (await view.evaluate(id => window.conductor.tabArchive.list(id, '', 500), sessionId)).tabs.map(entry => entry.tab.id)
  const userTexts = async id => (await view.evaluate(value => window.conductor.structured.snapshot(value), id)).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)

  step('a wizard tab, a controller and its coworkers')
  const wizard = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Archive wizard' })
  const { auth: wizardAuth } = await credentialAfter(() => call('agents.submit', { agentSessionId: wizard.resourceId, prompt: 'ARCHIVE take the wand' }))
  await settled(wizard.resourceId)
  await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'claude-fable-5-1' }) }, wizard.resourceId)
  await poll(async () => (await tabCall(wizardAuth, 'app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: 'the wizard holds the wand' })
  const boss = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Archive boss' })
  const { auth: bossAuth } = await credentialAfter(() => call('agents.submit', { agentSessionId: boss.resourceId, prompt: 'ARCHIVE plan the batch' }))
  await settled(boss.resourceId)
  const opened = async title => {
    const { auth, result } = await credentialAfter(() => tabCall(bossAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title, prompt: 'ARCHIVE ' + title }))
    await settled(result.resourceId)
    return { tab: result, auth }
  }
  const reporter = await opened('Coworker: reporter')
  const racer = await opened('Coworker: racer')

  // ------------------------------------------------------------------ E2a
  step('E2a a plain coworker may not call tabs.archive')
  const coworkerRefusal = await refusal(tabCall(racer.auth, 'tabs.archive', { tabIds: [reporter.tab.id] }))
  assert.match(coworkerRefusal, /tabs\.archive answers only the owner's own control credential/)
  assert.ok((await openIds()).includes(reporter.tab.id), 'nothing was archived')
  record('E2a-coworker-refused', 'PASS', { refusal: coworkerRefusal.slice(0, 300) }, 'a plain coworker calling tabs.archive over app control is refused and nothing closes')
  assert.ok(Object.keys(await tabCall(wizardAuth, 'tools.list')).includes('tabs.archive'), 'the wizard is offered tabs.archive')

  // ------------------------------------------------------------------ E2b
  step('E2b a finished child whose report waits uncollected in its busy controller')
  await call('agents.submit', { agentSessionId: boss.resourceId, prompt: 'ARCHIVE HOLD boss1 while the batch runs' })
  await poll(async () => await phaseOf(boss.resourceId) === 'running', { timeoutMs: 30_000, label: 'controller busy' })
  const report = await tabCall(reporter.auth, 'agents.report', { text: 'REPORT from the reporter: strip selection done.' })
  const held = await view.evaluate(id => window.conductor.structured.snapshot(id), boss.resourceId)
  const waiting = [...(held.queuedPrompts ?? (held.queued ? [held.queued] : [])), ...(held.pendingSteering ?? [])].filter(input => input.origin?.agentSessionId === reporter.tab.resourceId).map(input => ('status' in input ? `steer:${input.status}` : 'queued'))
  const refused = await call('tabs.archive', { tabIds: [reporter.tab.id] })
  assert.deepEqual(refused, { archived: [], refused: [{ tabId: reporter.tab.id, title: 'Coworker: reporter', reason: 'its report to Archive boss has not been collected yet', message: '“Coworker: reporter” was not archived: its report to Archive boss has not been collected yet.' }] }, JSON.stringify({ refused, report, waiting }))
  assert.ok((await openIds()).includes(reporter.tab.id))
  record('E2b-uncollected-refused', 'PASS', { delivery: report.delivery, waiting, refused }, 'owner tabs.archive refused the finished reporter: its report waits undelivered in the busy controller')
  await snap('e2b-uncollected')
  await writeFile(join(releases, 'boss1'), '')
  await poll(async () => (await userTexts(boss.resourceId)).some(text => text.includes('REPORT from the reporter')), { timeoutMs: 45_000, label: 'the controller receives the report as a turn' })
  await settled(boss.resourceId)
  const collected = await tabCall(wizardAuth, 'tabs.archive', { tabIds: [reporter.tab.id] })
  assert.deepEqual(collected, { archived: [{ tabId: reporter.tab.id, title: 'Coworker: reporter' }], refused: [] }, JSON.stringify(collected))
  await poll(async () => !(await openIds()).includes(reporter.tab.id) && (await archivedIds()).includes(reporter.tab.id), { timeoutMs: 15_000, label: 'reporter archived' })
  record('E2b-collected-archived', 'PASS', collected, 'after the controller\'s turn ended and the report arrived as its next turn, the same call (from the wizard tab) archived the reporter')
  record('E2a-wizard-allowed', 'PASS', {}, 'the wizard tab\'s own credential called tabs.archive and it ran')

  // ------------------------------------------------------------------ E2c busy target
  step('E2c-busy the target tab itself is mid-turn')
  const busyTab = await tabCall(bossAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'Coworker: busy', prompt: 'ARCHIVE Coworker: busy HOLD busy1' })
  await poll(async () => await phaseOf(busyTab.resourceId) === 'running', { timeoutMs: 30_000, label: 'the busy target is mid-turn' })
  const busyRefusal = { tabId: busyTab.id, title: 'Coworker: busy', reason: 'its turn is still running', message: '“Coworker: busy” was not archived: its turn is still running.' }
  const busyAttempts = {
    owner: await call('tabs.archive', { tabIds: [busyTab.id] }),
    wizard: await tabCall(wizardAuth, 'tabs.archive', { tabIds: [busyTab.id] }),
    ui: await view.evaluate(({ projectId, sessionId, tabId }) => window.conductor.tabArchive.archive(projectId, sessionId, [tabId]), { projectId, sessionId, tabId: busyTab.id })
  }
  for (const [who, result] of Object.entries(busyAttempts)) assert.deepEqual(result, { archived: [], refused: [busyRefusal] }, `${who}: ${JSON.stringify(result)}`)
  await new Promise(done => setTimeout(done, 1500))
  assert.equal(await phaseOf(busyTab.resourceId), 'running', 'the refused archive did not interrupt the turn')
  assert.ok((await openIds()).includes(busyTab.id) && !(await archivedIds()).includes(busyTab.id), 'the busy tab stays open and out of the archive')
  await snap('e2c-busy-refused')
  await writeFile(join(releases, 'busy1'), '')
  await settled(busyTab.resourceId)
  const busyPhase = await phaseOf(busyTab.resourceId)
  const assistantTexts = (await view.evaluate(value => window.conductor.structured.snapshot(value), busyTab.resourceId)).items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text)
  const finalAnswer = assistantTexts.at(-1)
  assert.equal(busyPhase, 'completed', 'the held turn settled completed, not interrupted: ' + busyPhase)
  assert.equal(finalAnswer, 'FINAL busy1: the held turn finished intact.', JSON.stringify(assistantTexts))
  // Not latched: the refused archive left no latch behind, so the next submit runs as a turn.
  const unlatched = await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); try { await window.conductor.structured.submit(id, 'BUSY follow-up', state.settings, []); return { ok: true } } catch (error) { return { ok: false, error: String(error?.message ?? error) } } }, busyTab.resourceId)
  assert.deepEqual(unlatched, { ok: true }, 'the refused archive left no latch: ' + JSON.stringify(unlatched))
  await settled(busyTab.resourceId)
  assert.ok((await userTexts(busyTab.resourceId)).includes('BUSY follow-up'))
  assert.ok((await openIds()).includes(busyTab.id))
  record('E2c-busy-target-refused', 'PASS', { refusal: busyAttempts.owner.refused[0].message, callers: Object.keys(busyAttempts), heldPhaseAfterRefusals: 'running', finalPhase: busyPhase, finalAnswer, assistantTexts, followUp: unlatched }, 'owner, wizard and UI tabs.archive of a mid-turn target were refused with the busy reason; the tab stayed open and unlatched, the turn was not interrupted and settled completed with its exact final answer')

  // ------------------------------------------------------------------ E2c
  step('E2c submits and steers fired around the final UI ack are refused and never run')
  const before = await userTexts(racer.tab.resourceId)
  const race = await view.evaluate(async ({ projectId, sessionId, tabId, id }) => {
    const state = await window.conductor.structured.snapshot(id)
    const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message ?? error) }))
    // The archive request goes first; main latches the conversation before it reads its next IPC.
    const archiving = settle(window.conductor.tabArchive.archive(projectId, sessionId, [tabId]))
    const shots = []
    for (const delay of [0, 2, 5, 10, 20, 40, 80, 160]) {
      await new Promise(done => setTimeout(done, delay))
      shots.push(settle(window.conductor.structured.submit(id, 'RACE submit +' + delay, state.settings, [])).then(result => ({ kind: 'submit', delay, ...result })))
      shots.push(settle(window.conductor.structured.steer(id, 'RACE steer +' + delay, state.settings, [])).then(result => ({ kind: 'steer', delay, ...result })))
    }
    return { archive: await archiving, shots: await Promise.all(shots) }
  }, { projectId, sessionId, tabId: racer.tab.id, id: racer.tab.resourceId })
  assert.equal(race.archive.ok, true, JSON.stringify(race.archive))
  assert.deepEqual(race.archive.value, { archived: [{ tabId: racer.tab.id, title: 'Coworker: racer' }], refused: [] })
  assert.deepEqual(race.shots.filter(shot => shot.ok), [], 'no submit or steer went through: ' + JSON.stringify(race.shots))
  assert.ok(race.shots.filter(shot => shot.delay === 0).every(shot => /being archived/.test(shot.error)), 'the first shots meet the latch: ' + JSON.stringify(race.shots.slice(0, 2)))
  await new Promise(done => setTimeout(done, 1500))
  assert.deepEqual(await userTexts(racer.tab.resourceId), before, 'nothing reached the conversation')
  // agents.status answers only conversations with a visible tab; an archived one is read from the snapshot.
  assert.ok(!/^(running|starting)$/.test((await view.evaluate(id => window.conductor.structured.snapshot(id), racer.tab.resourceId)).phase ?? ''), 'no turn started')
  assert.ok(!(await openIds()).includes(racer.tab.id) && (await archivedIds()).includes(racer.tab.id), 'the tab stays archived')
  record('E2c-race-refused', 'PASS', { shots: race.shots.map(shot => `${shot.kind}+${shot.delay}: ${shot.error}`) }, '16 submits and steers fired from 0 to 160 ms around the archive were all refused; no user message, no turn, the tab stayed archived')

  // ------------------------------------------------------------------ E2d
  step('E2d a late submit stays refused until the tab is reopened from the archive')
  const late = await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); try { await window.conductor.structured.submit(id, 'LATE submit', state.settings, []); return { ok: true } } catch (error) { return { ok: false, error: String(error?.message ?? error) } } }, racer.tab.resourceId)
  assert.equal(late.ok, false)
  assert.match(late.error, /being archived/)
  assert.deepEqual(await userTexts(racer.tab.resourceId), before)
  record('E2d-late-refused', 'PASS', late, 'a submit well after the successful archive is still refused by the latch')
  await view.evaluate(({ sessionId, tabId }) => window.conductor.tabArchive.reopen(sessionId, [tabId]), { sessionId, tabId: racer.tab.id })
  await poll(async () => (await openIds()).includes(racer.tab.id), { timeoutMs: 15_000, label: 'racer reopened' })
  const after = await poll(async () => view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); try { await window.conductor.structured.submit(id, 'AFTER reopen', state.settings, []); return { ok: true } } catch (error) { return /being archived/.test(String(error?.message ?? error)) ? { ok: false, latched: true, error: String(error.message) } : null } }, racer.tab.resourceId), { timeoutMs: 20_000, label: 'a submit after reopening' })
  assert.deepEqual(after, { ok: true }, 'reopening cleared the latch: ' + JSON.stringify(after))
  await settled(racer.tab.resourceId)
  assert.ok((await userTexts(racer.tab.resourceId)).includes('AFTER reopen'))
  record('E2d-reopen-clears', 'PASS', {}, 'reopening from the archive cleared the latch; the next submit ran as a turn')
  await snap('e2d-reopened')

  // ------------------------------------------------------------------ INFO
  step('E2-info app-control agents.submit to an archived conversation')
  const again = await call('tabs.archive', { tabIds: [racer.tab.id] })
  const submitted = await call('agents.submit', { agentSessionId: racer.tab.resourceId, prompt: 'INFO owner follow-up' }).then(result => ({ ok: true, result }), error => ({ ok: false, error: String(error?.message ?? error) }))
  record('E2-info-agents-submit', 'INFO', { archive: again, submitted }, 'agents.submit (owner) to a conversation whose tab is archived: by agent-control design it reopens the tab, which clears the latch, then submits')

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await rm(releases, { recursive: true, force: true }).catch(() => {})
await finish()
