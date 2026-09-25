// VR3 group V (docs/verification/2026-09-25-vr3.md), on the stock fake Claude CLI:
//   V1  viewing-background-tasks: a turn that ended with its own background Bash still running reads
//       "viewing" in agents.status/list, the tab indicator and the Processes board, then completed.
//   M1  main-brain-succession: a wizard with two coworkers calls agents.handoff({successor:true}); the
//       successor is a wizard that steers both coworkers, the old tab cannot, and shows "Continued in".
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr3-agents.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, callRaw, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr3-agents', output: process.env.VR3_OUT ?? 'artifacts/verification/2026-09-25-vr3' })
watchdog(15 * 60)
await loadCheck()

const BACKGROUND_MS = 25_000
// agents.handoff takes 200-12000 characters; the stock fixture only answers prompts starting SYNTHETIC.
const HANDOFF = `SYNTHETIC LONG 2 VR3 handoff.

Objective
- Finish the VR3 batch: steer coworker 2 once, then report.

Constraints
- Parked profile only; the smoke lock is shared with VR2.

Owned files
- None.

Verified findings
- Coworker 1 and coworker 2 are open and idle; the fixture turns ran.

Remaining work
- Steer coworker 2, then report to the owner.

Artifact references
- artifacts/verification/2026-09-25-vr3/results.md`
const settle = (id, label, timeoutMs = 60_000) => poll(async () => { const status = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted', 'idle'].includes(status.phase) ? status : null }, { timeoutMs, label })

try {
  const root = await import('node:os').then(os => os.tmpdir())
  const capture = join(root, `vr3-capture-${process.pid}.txt`)
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_SMOKE_BACKGROUND_MS: BACKGROUND_MS } })
  await openProject({ name: 'VR3 agents', git: true })
  const view = await page(inst)
  const model = 'claude-fable-5-1'

  // ---- V1
  try {
    step('V1 background Bash outlives the turn')
    const tab = await openTab({ provider: 'claude', model, title: 'VR3 viewing' })
    const id = tab.resourceId
    const neighbourTab = await openTab({ provider: 'claude', model, title: 'VR3 no background' })
    const started = Date.now()
    await call('agents.submit', { agentSessionId: id, prompt: 'SYNTHETIC BASH WAIT' })
    await call('agents.submit', { agentSessionId: neighbourTab.resourceId, prompt: 'SYNTHETIC BASH BACKGROUND' })
    const phases = [], neighbourPhases = []
    const viewing = await poll(async () => {
      const status = await call('agents.status', { agentSessionId: id })
      phases.push(status.phase)
      neighbourPhases.push((await call('agents.status', { agentSessionId: neighbourTab.resourceId })).phase)
      return status.phase === 'viewing' ? status : null
    }, { timeoutMs: 15_000, intervalMs: 300, label: 'phase viewing' })
    const listed = (await call('agents.list')).find(entry => entry.agentSessionId === id)
    const indicator = await poll(async () => view.locator('.tab-activity').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? '').find(label => /VR3 viewing: /.test(label)) ?? null), { timeoutMs: 10_000, label: 'the tab indicator of VR3 viewing' })
    const tooltip = await view.locator('.tab-activity').evaluateAll(nodes => nodes.map(node => node.getAttribute('title') ?? '').find(title => /Viewing/.test(title)) ?? null)
    await view.locator('.activity-rail').getByRole('button', { name: 'Processes', exact: true }).first().click()
    const board = await poll(async () => /Viewing/.test(await view.locator('body').innerText()) ? true : null, { timeoutMs: 10_000, label: 'Viewing on the Processes board' }).catch(() => false)
    const v1Shot = await shot('V1-viewing')
    await view.locator('.activity-rail').getByRole('button', { name: 'Processes', exact: true }).first().click()
    const done = await poll(async () => { const status = await call('agents.status', { agentSessionId: id }); phases.push(status.phase); return status.phase === 'completed' && !(status.backgroundTasks > 0) ? status : null }, { timeoutMs: BACKGROUND_MS + 30_000, intervalMs: 500, label: 'completed after the background task' })
    const neighbour = await settle(neighbourTab.resourceId, 'the neighbour turn')
    const ok = viewing.backgroundTasks === 1 && listed?.phase === 'viewing' && listed?.backgroundTasks === 1 && /: Viewing$/.test(indicator) && board === true && done.phase === 'completed' && !neighbourPhases.includes('viewing') && neighbour.phase === 'completed'
    record('V1', ok ? 'PASS' : 'FAIL', { viewingAfterS: Math.round((Date.now() - started) / 1000), statusBackgroundTasks: viewing.backgroundTasks, listPhase: listed?.phase, listBackgroundTasks: listed?.backgroundTasks, indicator, board, finalPhase: done.phase, phaseTrail: [...new Set(phases)], neighbourTrail: [...new Set(neighbourPhases)] }, `${v1Shot}; tooltip: ${tooltip}; control: SYNTHETIC BASH BACKGROUND (task finishes in the turn) never reads viewing`)
  } catch (error) { await failed(error, 'V1') }

  // ---- M1
  try {
    step('M1 make a wizard tab')
    const tokenFrom = text => ({ endpoint: /POST (http:\/\/127\.0\.0\.1:\d+\/control)/.exec(text)?.[1], token: /Bearer ([a-f0-9]{64})/.exec(text)?.[1] })
    const readCapture = () => { try { return readFileSync(capture, 'utf8') } catch { return '' } }
    const as = async (auth, method, args = {}) => { const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }); return { status: response.status, body: await response.json().catch(() => ({})) } }
    const wizardTab = await openTab({ provider: 'claude', model, title: 'VR3 wizard' })
    const wizardId = wizardTab.resourceId
    await view.evaluate(async id => {
      const state = await window.conductor.structured.snapshot(id)
      const settings = { ...state.settings, wizard: true, model: 'claude-fable-5-1', permission: 'auto' }
      await window.conductor.structured.saveSettings(id, settings)
      await window.conductor.structured.submit(id, 'SYNTHETIC LONG 1', settings)
    }, wizardId)
    const wizard = await poll(() => { const found = tokenFrom(readCapture()); return found.token ? found : null }, { timeoutMs: 30_000, label: 'the wizard tab credential' })
    await settle(wizardId, 'the wizard turn')
    step('M1 the wizard opens two coworkers')
    const open = async title => { const reply = await as(wizard, 'tabs.open', { kind: 'agent', provider: 'claude', model, title }); if (reply.status !== 200) throw new Error(`wizard tabs.open ${title}: ${reply.status} ${JSON.stringify(reply.body)}`); return reply.body.result.resourceId }
    const c1 = await open('VR3 coworker 1'), c2 = await open('VR3 coworker 2')
    await sleep(2000)
    const beforeSteer = await as(wizard, 'agents.submit', { agentSessionId: c1, prompt: 'SYNTHETIC LONG 1' })
    await settle(c1, 'coworker 1 turn')
    step('M1 handoff successor:true')
    // Every fixture prompt overwrites the capture; the successor's is the one carrying the handoff.
    writeFileSync(capture, '')
    const handoff = await as(wizard, 'agents.handoff', { handoff: HANDOFF, successor: true })
    if (handoff.status !== 200) throw new Error(`agents.handoff: ${handoff.status} ${JSON.stringify(handoff.body)}`)
    const result = handoff.body.result
    const successor = await poll(() => { const text = readCapture(); const found = tokenFrom(text); return found.token && text.includes('VR3 handoff') ? found : null }, { timeoutMs: 45_000, label: 'the successor credential' })
    await settle(result.agentSessionId, 'the successor first turn')
    const fromSuccessor = await as(successor, 'agents.submit', { agentSessionId: c2, prompt: 'SYNTHETIC LONG 1' })
    await settle(c2, 'coworker 2 turn')
    const fromOld = await as(wizard, 'agents.submit', { agentSessionId: c1, prompt: 'SYNTHETIC LONG 1' })
    const settings = await view.evaluate(async ({ old, next }) => ({ old: (await window.conductor.structured.snapshot(old)).settings?.wizard ?? false, next: (await window.conductor.structured.snapshot(next)).settings?.wizard ?? false }), { old: wizardId, next: result.agentSessionId })
    const listedOld = (await call('agents.list')).find(entry => entry.agentSessionId === wizardId)
    await call('tabs.focus', { tabId: wizardTab.tabId ?? wizardTab.id }).catch(() => view.locator('[role="tab"], .workspace-tab').filter({ hasText: 'VR3 wizard' }).first().click())
    const banner = await poll(async () => (await view.locator('.sa-runtime-succeeded').first().textContent().catch(() => null)) || null, { timeoutMs: 15_000, label: 'the Continued in banner' }).catch(() => null)
    const placeholder = await view.locator('textarea').evaluateAll(areas => areas.map(area => area.getAttribute('placeholder') ?? '').find(text => /Continued in/.test(text)) ?? null)
    const m1Shot = await shot('M1-old-wizard')
    const ok = beforeSteer.status === 200 && result.successor === true && result.wizard === true && [c1, c2].every(id => result.coworkers?.includes(id)) && fromSuccessor.status === 200 && fromOld.status !== 200 && settings.next === true && settings.old === false && Boolean(listedOld?.superseded) && /Continued in/.test(banner ?? '')
    record('M1', ok ? 'PASS' : 'FAIL', { beforeHandoffSteer: beforeSteer.status, resultWizard: result.wizard, resultCoworkers: result.coworkers, resultController: result.controller ?? null, successorSteer: fromSuccessor.status, successorSteerError: fromSuccessor.body?.error ?? null, oldSteer: fromOld.status, wizardFlags: settings, superseded: listedOld?.superseded ?? null, banner: banner?.slice(0, 160), placeholder }, `${m1Shot}; old tab refused: ${JSON.stringify(fromOld.body?.error ?? '').slice(0, 160)}; control: the same agents.submit from the wizard succeeded (${beforeSteer.status}) before the handoff`)
  } catch (error) { await failed(error, 'M1') }
} catch (error) { await failed(error) }
await finish()
