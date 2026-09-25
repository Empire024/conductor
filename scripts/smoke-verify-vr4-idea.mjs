// VR4 I2 (docs/verification/2026-09-25-vr4.md), idea-autopilot deny path and authority. Owner: "if you need
// me for any step ... pause your work and holler at me". A harmless dry-run idea on fixture agents (never
// the owner's idea_mugx6gkj). A coworker starts the run through app control (Conductor doing it "by itself,
// using agents"), but may not approve the plan or answer a checkpoint; the owner denies the publish
// checkpoint. Checked: the refusals, the phone-notification record, the denial reaching the stage agent,
// nothing recorded as approved, the timeline, and the owner's active tab never moving while stage agents open.
// Control: the fixer's smoke-idea-autopilot.mjs (approve path) on the same build.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr4-idea.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr4-idea', output: 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4' })
watchdog(15 * 60)
await loadCheck()
const fence = (name, value) => '```' + name + '\n' + JSON.stringify(value, null, 1) + '\n```'
const budget = { maxMinutes: 30, maxTurns: 3, maxEur: 0 }
const scenario = {
  PLAN: 'Plan below.\n' + fence('idea-run-plan', { summary: 'Dry run: research, check the name, then post one photo.', weeklyCaps: { claude: 85, codex: 95 }, stages: [
    { id: 'research', title: 'Research paper-mask makers', kind: 'research', goal: 'List three makers', doneCriteria: ['Three makers listed'], agent: { provider: 'claude', model: 'opus[1m]' }, budget },
    { id: 'brand-check', title: 'Check the club name', kind: 'brand-check', goal: 'Check the name is free and AI labels stay on', doneCriteria: ['No conflict found'], agent: { provider: 'claude', model: 'opus[1m]' }, budget },
    { id: 'daily-post', title: 'Post a photo a day', kind: 'public', goal: 'Post one photo, measure, adjust', doneCriteria: ['Photo posted with its AI label'], generatesMedia: true, agent: { provider: 'claude', model: 'opus[1m]' }, budget: { ...budget, maxTurns: 4 }, checkpoints: ['publish'],
      recurrence: { everyMinutes: 1440, times: 1, loop: { title: 'Post, measure, adjust', steps: [{ id: 'post', role: 'publisher', model: 'claude:sonnet', done: 'posted' }, { id: 'measure', role: 'analyst', model: 'claude:haiku', done: 'noted' }] } } }
  ] }),
  'STAGE research': fence('idea-run-report', { status: 'done', summary: 'Three makers found (synthetic).' }),
  'STAGE brand-check': fence('idea-run-report', { status: 'done', summary: 'No conflict (synthetic); AI labels stay on.' }),
  'OCCURRENCE daily-post': fence('idea-run-report', { status: 'continue', summary: 'Drafted photo 1.', actions: [{ type: 'publish', summary: 'Post photo 1 to the test account', detail: 'Image: photo-1.png (AI label on)\nCaption: "VR4 deny-path photo #madewithai"', target: 'instagram.com/vr4.test (dry run)' }] }),
  'DECISIONS daily-post': fence('idea-run-report', { status: 'done', summary: 'Did not post photo 1: the owner denied it.', loop: { steps: [{ id: 'post', outcome: 'skipped', note: 'denied by the owner' }, { id: 'measure', outcome: 'skipped', note: 'nothing posted' }] } })
}
const scenarioPath = join(tmpdir(), `vr4-idea-scenario-${process.pid}.json`)
writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2))
const capture = join(tmpdir(), `vr4-idea-capture-${process.pid}.txt`)

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_IDEA_RUN_SCENARIO: scenarioPath, CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_LOCAL_ROOT: join(tmpdir(), 'vr4-no-local-models') } })
  const project = await openProject({ name: 'VR4 idea dry run', git: true })
  const view = await page(inst)
  const coworkerTab = await openTab({ provider: 'claude', title: 'VR4 idea coworker' })
  await call('agents.submit', { agentSessionId: coworkerTab.resourceId, prompt: 'SYNTHETIC B the idea coworker' })
  const briefing = await poll(() => { try { const text = readFileSync(capture, 'utf8'); return text.includes('Conductor app control:') ? text : null } catch { return null } }, { timeoutMs: 60_000, label: 'coworker briefing' })
  const coworker = { endpoint: /POST (http:\/\/127\.0\.0\.1:\d+\/control)/.exec(briefing)[1], token: /Bearer ([a-f0-9]{64})/.exec(briefing)[1] }
  const asCoworker = async (method, args) => {
    const response = await fetch(coworker.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${coworker.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000) })
    const body = await response.json()
    return { status: response.status, result: body.result, error: body.error }
  }
  const activeTab = () => view.evaluate(() => document.querySelector('.pane-tab.active')?.getAttribute('data-control-tab-id') ?? null)
  await view.locator(`.pane-tab[data-control-tab-id="${coworkerTab.id}"]`).click()
  await poll(async () => (await activeTab()) === coworkerTab.id, { timeoutMs: 15_000, label: 'the owner tab is active' })
  const ownerTab = coworkerTab.id
  const moves = []
  const watcher = setInterval(() => { void activeTab().then(id => { if (id !== ownerTab) moves.push({ at: new Date().toISOString(), id }) }).catch(() => {}) }, 250)

  try {
    step('I2 a coworker starts the run; approve and decide are the owner\'s')
    const idea = await call('ideas.capture', { text: 'VR4 deny-path dry run\nA harmless hobby page: research makers, check the name, post one photo.' })
    const ideaId = idea.id ?? idea.ideaId
    const started = await asCoworker('ideas.run', { ideaId, dryRun: true })
    if (started.status !== 200) throw new Error(`coworker ideas.run -> ${started.status} ${JSON.stringify(started.error)}`)
    const runId = started.result.id
    const listRun = () => call('ideas.runs', { runId })
    await poll(async () => (await listRun()).status === 'awaiting-approval', { timeoutMs: 90_000, label: 'plan awaiting approval' })
    const approveRefused = await asCoworker('ideas.run.approve', { runId })
    await call('ideas.run.approve', { runId })
    await poll(async () => (await listRun()).stages.map(stage => stage.status).join() === 'done,done,recurring', { timeoutMs: 120_000, intervalMs: 1000, label: 'stages done,done,recurring' })
    const schedules = await view.evaluate(projectId => window.conductor.orchestration.schedules.snapshot(projectId), project.id)
    const task = schedules.schedules.find(entry => entry.kind === 'idea-run')
    await view.evaluate(({ projectId, scheduleId }) => window.conductor.orchestration.schedules.runNow(projectId, scheduleId), { projectId: project.id, scheduleId: task.id })
    await poll(async () => (await listRun()).status === 'waiting-owner', { timeoutMs: 90_000, label: 'checkpoint waiting for the owner' })
    const checkpoint = (await listRun()).checkpoints.find(entry => entry.status === 'pending')
    const decideRefused = await asCoworker('ideas.run.decide', { checkpointId: checkpoint.id, decision: 'approve' })
    step('I2 the owner denies the publish checkpoint')
    await call('ideas.run.decide', { checkpointId: checkpoint.id, decision: 'deny', note: 'Not this photo.' })
    const final = await poll(async () => { const run = await listRun(); return ['completed', 'blocked', 'stopped', 'failed'].includes(run.status) ? run : null }, { timeoutMs: 90_000, label: 'run settles after the denial' })
    const stage = final.stages.find(entry => entry.id === 'daily-post')
    const transcript = await view.evaluate(id => window.conductor.conversationHistory.transcript(id), stage.agentSessionId)
    const told = /DECISIONS daily-post[\s\S]*deni/i.test(transcript.markdown)
    const detail = await view.evaluate(id => window.conductor.ideas.get(id), ideaId)
    const messages = detail.events.map(event => event.message)
    const notified = detail.events.find(event => /Phone notification: Approve\?/.test(event.message))
    const deniedLine = messages.find(message => /^Denied by /.test(message) && /Post photo 1/.test(message)) ?? null
    const denied = Boolean(deniedLine)
    const approved = messages.some(message => /Approved by .*Post photo 1/.test(message))
    const decided = final.checkpoints.find(entry => entry.id === checkpoint.id)
    await shot('I2-after-deny')
    const titles = Object.fromEntries((await call('tabs.list', {})).map(tab => [tab.id, tab.title]))
    const movedTo = [...new Set(moves.map(move => move.id))].map(id => ({ id, title: titles[id] ?? null, first: moves.find(move => move.id === id).at, samples: moves.filter(move => move.id === id).length }))
    writeFileSync('C:/Claude/conductor/artifacts/verification/2026-09-25-vr4/I2-evidence-' + process.pid + '.json', JSON.stringify({ ownerTab, movedTo, messages, stages: final.stages.map(entry => ({ id: entry.id, agent: entry.agentSessionId, status: entry.status })) }, null, 2))
    clearInterval(watcher)
    const pass = approveRefused.status !== 200 && decideRefused.status !== 200 && decided.status === 'denied' && told && denied && !approved && Boolean(notified) && moves.length === 0
    record('I2', pass ? 'PASS' : 'FAIL', { runStatus: final.status, coworkerApprove: approveRefused.status, coworkerDecide: decideRefused.status, checkpoint: decided.status, agentToldDenied: told, timelineDenied: denied, timelineApproved: approved, notification: notified?.data?.notification?.outcome ?? (notified ? 'recorded' : null), activeTabMoves: moves.length, movedTo, deniedLine, stageAgents: final.stages.map(entry => entry.agentSessionId).filter(Boolean).length }, `coworker approve: ${JSON.stringify(approveRefused.error).slice(0, 160)}; timeline: ${messages.slice(0, 30).join(' | ').slice(0, 900)}`)
  } catch (error) { clearInterval(watcher); await failed(error, 'I2') }
} catch (error) { await failed(error, 'I-setup') }
await finish()
