// VR4 L1 (docs/verification/2026-09-25-vr4.md), logic-loops refinement. The item: "Agents may auto-apply
// model/threshold/wording refinements backed by metrics, and changes that make runs worse are reverted
// automatically; budget, review and ship steps need the owner." A copy of the repo's real .conductor/loops;
// the agent is a fixture Claude coworker calling app control with its own credential.
//   L1a  the coworker's budget change is refused, the owner's applies
//   L1b  the coworker's step-model change applies (version +1, Run log line); two worse runs on tokens
//        revert it (new higher version, proposal "reverted"). Control: a second change on the same loop, one worse run
//        then one better run leaves the change in place.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr4-loops.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, callRaw, configure, failed, finish, launchParked, loadCheck, openProject, openTab, poll, record, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr4-loops', output: 'C:/Claude/conductor/artifacts/verification/2026-09-25-vr4' })
watchdog(12 * 60)
await loadCheck()
const capture = join(tmpdir(), `vr4-loops-capture-${process.pid}.txt`)
const loopsDir = join(process.cwd(), '.conductor', 'loops')
const files = Object.fromEntries(readdirSync(loopsDir).map(name => [`.conductor/loops/${name}`, readFileSync(join(loopsDir, name), 'utf8')]))

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  const project = await openProject({ name: 'VR4 loops', git: true, files })
  const tab = await openTab({ provider: 'claude', title: 'VR4 loop coworker' })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'SYNTHETIC B the loop coworker' })
  const briefing = await poll(() => { try { const text = readFileSync(capture, 'utf8'); return text.includes('Conductor app control:') ? text : null } catch { return null } }, { timeoutMs: 60_000, label: 'coworker briefing' })
  const coworker = { endpoint: /POST (http:\/\/127\.0\.0\.1:\d+\/control)/.exec(briefing)[1], token: /Bearer ([a-f0-9]{64})/.exec(briefing)[1] }
  const asCoworker = async (method, args) => {
    const response = await fetch(coworker.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${coworker.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30_000) })
    const body = await response.json()
    return { status: response.status, result: body.result, error: body.error }
  }
  const must = async (method, args) => { const answer = await asCoworker(method, args); if (answer.status !== 200 || answer.error) throw new Error(`${method} as coworker -> ${answer.status} ${JSON.stringify(answer.error)}`); return answer.result }
  const loopText = id => readFileSync(join(project.path, '.conductor', 'loops', `${id}.md`), 'utf8')
  const version = id => Number(/^version:\s*(\d+)/m.exec(loopText(id))[1])
  /** One loops.run plus a recorded step per step of the loop, `total` tokens spread over them. */
  const runWith = async (id, total) => {
    const run = await must('loops.run', { id, inputs: {} })
    const at = Date.now()
    for (const [index, entry] of run.steps.entries()) await must('loops.record', { runId: run.runId, stepId: entry.id, model: entry.model ?? 'claude:sonnet', startedAt: new Date(at + index * 1000).toISOString(), finishedAt: new Date(at + index * 1000 + 500).toISOString(), outcome: 'ok', tokens: { total: Math.round(total / run.steps.length) } })
    return run.runId
  }
  /** The loop text with its first model: line changed (a step-model refinement). */
  const modelChange = id => { const text = loopText(id); const [line, model] = /^\s+model:\s*(\S+)\s*$/m.exec(text); return { text: text.replace(line, line.replace(model, model === 'claude:haiku' ? 'claude:sonnet' : 'claude:haiku')), from: model } }

  // ---- L1a
  try {
    step('L1a budget change: coworker refused, owner applies')
    const before = loopText('task-triage')
    const change = before.replace(/claudeWeeklyMax:\s*75/, 'claudeWeeklyMax: 85')
    const proposal = await must('loops.propose', { id: 'task-triage', change, evidence: 'VR4: budget change for the owner to decide' })
    const refused = await asCoworker('loops.apply', { proposalId: proposal.id })
    const unchanged = loopText('task-triage') === before
    const applied = await call('loops.apply', { proposalId: proposal.id })
    const pass = (refused.status !== 200 || Boolean(refused.error)) && unchanged && version('task-triage') === 2 && /claudeWeeklyMax:\s*85/.test(loopText('task-triage'))
    record('L1a', pass ? 'PASS' : 'FAIL', { coworkerStatus: refused.status, ownerApplied: applied?.status ?? applied?.proposal?.status ?? 'ok', version: version('task-triage') }, `coworker: ${JSON.stringify(refused.error ?? refused.result).slice(0, 300)}`)
  } catch (error) { await failed(error, 'L1a') }

  // ---- L1b
  try {
    step('L1b model change applied by the coworker, then two worse runs')
    await runWith('task-triage', 1000)
    const { text, from } = modelChange('task-triage')
    const proposal = await must('loops.propose', { id: 'task-triage', change: text, evidence: 'VR4: cheaper model for the first step, 1000 tokens baseline', metric: 'tokens' })
    const applied = await asCoworker('loops.apply', { proposalId: proposal.id })
    const appliedVersion = version('task-triage')
    const runLog = /auto|proposal|v3/i.test(loopText('task-triage').split('## Run log')[1] ?? '')
    await runWith('task-triage', 2000)
    await runWith('task-triage', 2600)
    const after = loopText('task-triage')
    const proposals = await must('loops.proposals', { id: 'task-triage' })
    const status = proposals.find(entry => entry.id === proposal.id)?.status
    const reverted = new RegExp(`model:\\s*${from.replace(/[[\]().:]/g, '\\$&')}\\s*$`, 'm').test(after)
    const pass = applied.status === 200 && !applied.error && appliedVersion === 3 && runLog && status === 'reverted' && version('task-triage') === 4 && reverted
    record('L1b', pass ? 'PASS' : 'FAIL', { coworkerApply: applied.status, appliedVersion, runLogLine: runLog, finalVersion: version('task-triage'), proposalStatus: status, modelBack: reverted, from }, `run log: ${(after.split('## Run log')[1] ?? '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 400)}`)

    step('L1b control: one worse, one better run keeps the change')
    // The same loop again (batch-delivery and verify need run inputs): baseline is the last run, 2600.
    const control = modelChange('task-triage')
    const controlProposal = await must('loops.propose', { id: 'task-triage', change: control.text, evidence: 'VR4 control', metric: 'tokens' })
    await must('loops.apply', { proposalId: controlProposal.id })
    const controlVersion = version('task-triage')
    await runWith('task-triage', 3000)
    await runWith('task-triage', 1000)
    const controlStatus = (await must('loops.proposals', { id: 'task-triage' })).find(entry => entry.id === controlProposal.id)?.status
    record('L1b control', controlStatus === 'applied' && version('task-triage') === controlVersion ? 'PASS' : 'FAIL', { status: controlStatus, version: version('task-triage') }, 'worse then better: no revert')
  } catch (error) { await failed(error, 'L1b') }
  void callRaw
} catch (error) { await failed(error, 'L-setup') }
await finish()
