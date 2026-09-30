// One authority on both approval paths, and what a session answer really outlives (reviewer findings
// H13 and scope/lifetime, 2026-09-29). A wizard Wz controls a coworker W on ask mode:
//   both APIs (agents.approve for W's native card, permissions.decide for W's permission request)
//   refuse an ordinary tab P and the (non-wizard) coworker itself; Wz answers
//   W's native "SYNTHETIC PERMISSION SCOPED" card for the session -> effectiveScope native-session with
//   the runtime's stated lifetime, and W's REPEAT is covered without a card; a REQUIRED card offers
//   no session choice -> effectiveScope once, truthfully; W's external permissions.request approved
//   for the session with permissions.decide -> the owner's app.restart -> that grant is still listed
//   and saved, while W's REPEAT asks again: the native session approval ended with its runtime, as
//   the answer said.
// Real Electron main/preload/renderer; only the Claude process is the synthetic fixture
// (scripts/fixtures/fake-claude.mjs: SYNTHETIC PERMISSION keeps native session rules per process, as
// the CLI does), so nothing is executed. CONDUCTOR_TEST_USER_DATA parks the window; spawn mode,
// since Playwright loses a relaunch.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-approval-scope-restart.mjs
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, relaunched, step, watchdog } from './verify-kit.mjs'
import { B5_COMMAND, errorText, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const OUTPUT = 'artifacts/verification/2026-09-29-approval-scope'
configure({ name: 'approval-scope-restart', output: OUTPUT })
watchdog(900)
const { capture, flagLog, env } = await handoffEnv('approval-scope')
try {
  const inst = await launchParked({ mode: 'spawn', env })
  await scenario(inst)
} catch (error) { await failed(error, 'approval-scope') }
await finish()

async function scenario(inst) {
  let view = await page(inst)
  await openProject({ name: 'Approval scope restart' })
  let g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  const saved = async () => JSON.parse(await readFile(join(inst.profile, 'permission-grants.json'), 'utf8').catch(() => 'null'))
  const refusal = async work => { try { await work(); return 'ALLOWED' } catch (error) { return errorText(error) } }
  const assistant = async id => (await g.texts(id, 'assistant')).at(-1) ?? ''
  const pendingCard = async (as, id) => (await as('agents.approvals', { agentSessionId: id })).approvals[0]

  step('wizard Wz opens coworker W on ask mode; an ordinary tab P looks on')
  const wz = await g.wizard('Scope wizard Wz', 'SYNTHETIC CLASSIFIER LOCAL scopewz')
  const opened = await wz.as('tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Scope coworker W', permission: 'default', exactPermission: true })
  const w = { id: opened.resourceId, tabId: opened.id, title: 'Scope coworker W' }
  await poll(() => call('agents.status', { agentSessionId: w.id }), { timeoutMs: 30_000, label: 'W mounted' })
  const pTab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Scope plain P' })
  await rm(capture, { force: true })
  await g.submit(pTab.resourceId, 'SYNTHETIC CLASSIFIER LOCAL scopep', false)
  const p = { id: pTab.resourceId, as: await g.credentialOf('scopep') }
  await g.settled(p.id, 'P settles')

  step("W's native card: both APIs refuse the ordinary and the self answer")
  await rm(capture, { force: true })
  await g.submit(w.id, 'SYNTHETIC PERMISSION SCOPED scopew', false)
  w.as = await g.credentialOf('scopew')
  const card = await poll(async () => await pendingCard(wz.as, w.id) ?? null, { timeoutMs: 20_000, label: "W's native card" })
  const asked = await w.as('permissions.request', { command: B5_COMMAND, reason: 'external call for the parity check (never run)', rollback: 'none: the fixture never runs it' })
  const approve = (as, decision = 'allow') => as('agents.approve', { agentSessionId: w.id, requestId: card.requestId, decision, scope: 'session', reason: 'parity check' })
  const decide = as => as('permissions.decide', { agentSessionId: w.id, requestId: asked.requestId, decision: 'approve-session' })
  const refused = {
    ordinary: { approve: await refusal(() => approve(p.as)), decide: await refusal(() => decide(p.as)) },
    self: { approve: await refusal(() => w.as('agents.approve', { agentSessionId: w.id, requestId: card.requestId, decision: 'allow', reason: 'self' })), decide: await refusal(() => w.as('permissions.decide', { agentSessionId: w.id, requestId: asked.requestId, decision: 'approve-once' })) }
  }
  const still = await pendingCard(wz.as, w.id)
  record('parity-refusals', Object.values(refused).every(pair => pair.approve !== 'ALLOWED' && pair.decide !== 'ALLOWED') && still?.requestId === card.requestId ? 'PASS' : 'FAIL',
    refused, 'the ordinary tab and W itself (not a wizard) are refused on agents.approve and permissions.decide alike; the card is still pending')

  step('Wz allows the native card for the session: the runtime\'s own session choice, and W\'s repeat needs no card')
  const nativeAnswer = await approve(wz.as)
  await g.settled(w.id, 'W settles after the session answer')
  await rm(capture, { force: true })
  await g.submit(w.id, 'SYNTHETIC PERMISSION REPEAT scopew2', false)
  await g.settled(w.id, 'W repeat settles')
  const reused = await assistant(w.id)
  record('native-session', card.sessionScope === 'native-session' && card.sessionClass === null && nativeAnswer.answered === 'allow-session' && nativeAnswer.effectiveScope === 'native-session' && /Only this running Claude session; cleared when it restarts or resumes/.test(nativeAnswer.note ?? '') && /native session grant reused/.test(reused) ? 'PASS' : 'FAIL',
    { listed: { sessionScope: card.sessionScope, sessionClass: card.sessionClass }, answered: nativeAnswer.answered, effectiveScope: nativeAnswer.effectiveScope, note: nativeAnswer.note, repeat: reused }, 'the answer names the runtime\'s session choice and its lifetime; the same action again is covered by the CLI without a card')

  step('a card with no session choice: agents.approve says it was allowed once')
  await g.submit(w.id, 'SYNTHETIC PERMISSION REQUIRED scopew3', false)
  const required = await poll(async () => await pendingCard(wz.as, w.id) ?? null, { timeoutMs: 20_000, label: "W's REQUIRED card" })
  const fallback = await wz.as('agents.approve', { agentSessionId: w.id, requestId: required.requestId, decision: 'allow', scope: 'session', reason: 'fallback check' })
  await g.settled(w.id, 'W settles after the fallback')
  const appRule = fallback.effectiveScope === 'once+app-rule'
  record('fallback-scope', fallback.answered === 'allow' && required.sessionScope === fallback.effectiveScope && (required.sessionClass ?? null) === (fallback.sessionRule ?? null) && (appRule ? /answers later approvals of that class under this conversation's stronger review while this runtime runs/.test(fallback.note ?? '') : fallback.effectiveScope === 'once') ? 'PASS' : 'FAIL',
    { choices: required.choices, listed: { sessionScope: required.sessionScope, sessionClass: required.sessionClass }, answered: fallback.answered, effectiveScope: fallback.effectiveScope, sessionRule: fallback.sessionRule ?? null, note: fallback.note }, 'the runtime offered no session answer: agents.approvals listed, and agents.approve reported, the same scope and rule (once and none for an owner ask rule under review)')
  // The claim is checked, not trusted: the same action again is answered by the rule (no card) only if the response said so.
  await g.submit(w.id, 'SYNTHETIC PERMISSION REQUIRED scopew3b', false)
  const repeatCard = await poll(async () => await pendingCard(wz.as, w.id) ?? null, { timeoutMs: 12_000, label: "W's second REQUIRED card" }).catch(() => null)
  if (repeatCard) await wz.as('agents.approve', { agentSessionId: w.id, requestId: repeatCard.requestId, decision: 'deny', reason: 'claim check done' }).catch(() => undefined)
  await g.settled(w.id, 'W settles after the second REQUIRED')
  const repeatText = await assistant(w.id)
  record('fallback-claim-holds', (appRule ? !repeatCard && /permission result: allow/.test(repeatText) : Boolean(repeatCard)) ? 'PASS' : 'FAIL',
    { effectiveScope: fallback.effectiveScope, cardAgain: Boolean(repeatCard), last: repeatText.slice(0, 160) }, appRule ? 'the app-side rule answered the same action again without a card, as the response said' : 'the same action asked again, as "once" said')

  step("Wz approves W's external permission request for the session with permissions.decide")
  const decided = await decide(wz.as)
  await g.settled(w.id, 'W notes the approval')
  const before = (await w.as('permissions.list')).grants.filter(grant => grant.requestId === asked.requestId)
  record('decide-session', decided.status === 'approved-session' && before.length === 1 && before[0].scope === 'session' ? 'PASS' : 'FAIL',
    { status: decided.status, grants: before.map(grant => ({ rule: grant.rule, scope: grant.scope, decidedBy: grant.decidedBy })) }, 'the controlling wizard answers an external request on permissions.decide, as on agents.approve')

  step("the owner's app.restart")
  const firstPid = inst.credential.pid
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, firstPid, { timeoutMs: 90_000 })
  view = await page(inst)
  g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  record('restart', 'INFO', { seconds }, 'relaunched by app.restart')

  step('after the restart: the permissions.decide session grant is still there; the native session approval is not')
  const file = await saved()
  let after
  try { after = (await w.as('permissions.list')).grants.filter(grant => grant.requestId === asked.requestId) } catch (error) { after = { error: errorText(error) } }
  record('grant-survives', Array.isArray(after) && after.length === 1 && after[0].scope === 'session' && file?.grants?.some(grant => grant.requestId === asked.requestId && grant.scope === 'session') ? 'PASS' : 'FAIL',
    { listed: after, saved: file?.grants?.map(grant => ({ rule: grant.rule, scope: grant.scope })) }, 'permission-grants.json kept the session grant and W lists it after the restart')
  const runtimeBefore = (await g.snap(w.id))?.runtimeId
  await g.submit(w.id, 'SYNTHETIC PERMISSION REPEAT scopew4', false)
  const again = await poll(async () => await pendingCard(wz.as, w.id) ?? null, { timeoutMs: 30_000, label: "W's repeat card after the restart" }).catch(() => null)
  const runtimeAfter = (await g.snap(w.id))?.runtimeId
  record('native-session-ends', again && runtimeAfter !== runtimeBefore ? 'PASS' : 'FAIL',
    { card: again && { requestId: again.requestId, tool: again.tool, input: again.input, choices: again.choices }, runtimeChanged: runtimeAfter !== runtimeBefore }, "the same REPEAT action asks again in W's new runtime: the native session approval ended with the runtime, as its answer said")
  if (again) await wz.as('agents.approve', { agentSessionId: w.id, requestId: again.requestId, decision: 'deny', reason: 'probe done' }).catch(() => undefined)
  await g.settled(w.id, 'W settles after the denied repeat')
  await g.submit(w.id, 'SYNTHETIC PERMISSION REQUIRED scopew5', false)
  const requiredAgain = await poll(async () => await pendingCard(wz.as, w.id) ?? null, { timeoutMs: 20_000, label: "W's REQUIRED card after the restart" }).catch(() => null)
  record('required-asks-after-restart', requiredAgain ? 'PASS' : 'FAIL', { card: requiredAgain && { requestId: requiredAgain.requestId, input: requiredAgain.input } }, 'after the restart the owner-ask-rule action asks again: no answer given before the restart covers it')
  if (requiredAgain) await wz.as('agents.approve', { agentSessionId: w.id, requestId: requiredAgain.requestId, decision: 'deny', reason: 'probe done' }).catch(() => undefined)
}
