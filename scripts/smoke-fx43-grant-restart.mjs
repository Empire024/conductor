// FX43 grant-survives-restart. Real case 2026-09-26: the haftheme wizard's permission request (B5,
// grant:632b2e2a) waited on the owner while the controller held an app update, because a restart
// dropped every waiting card and every approved grant not yet used (they lived in memory only). Here:
//   wizard W files permissions.request; plain tab H has one approved once but holds its retry
//   (fixture PLAN HOLD) -> the owner's app.restart (the quit path an update install takes) -> W's card
//   is live again (buttons), W's permissions.list and the owner's state hold it, H's grant is still
//   there -> a renderer reload keeps W's card live -> the app is killed (taskkill /F, a crash) and
//   started again -> the same holds -> H retries: its resumed CLI runs the call once and the grant is
//   spent; a second try is refused -> the owner approves W once in its card: W is told "[Conductor]
//   approved: <rule>; retry it now", runs it once, a second retry is refused -> one more restart
//   brings back nothing spent, and the used card stays answered.
// Real Electron main/preload/renderer; only the Claude process is the synthetic fixture
// (scripts/fixtures/fake-claude.mjs, SYNTHETIC CLASSIFIER), so nothing is executed and no inference
// happens. CONDUCTOR_TEST_USER_DATA parks the window; spawn mode, since Playwright loses a relaunch.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx43-grant-restart.mjs
import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, relaunched, relaunchParked, shot, step, watchdog } from './verify-kit.mjs'
import { B5_COMMAND, errorText, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const OUTPUT = 'artifacts/verification/2026-09-26-fx43'
configure({ name: 'fx43-grant-restart', output: OUTPUT })
watchdog(900)
const { capture, flagLog, env } = await handoffEnv('fx43')
try {
  const inst = await launchParked({ mode: 'spawn', env })
  await scenario(inst)
} catch (error) { await failed(error, 'FX43') }
await finish()

async function scenario(inst) {
  let view = await page(inst)
  await openProject({ name: 'FX43 grant restart' })
  let g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  const rebind = async () => { view = await page(inst); g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT }) }
  const saved = async () => JSON.parse(await readFile(join(inst.profile, 'permission-grants.json'), 'utf8').catch(() => 'null'))
  const grantStatus = async (id, requestId) => (await g.notice(id, requestId))?.payload?.permissionGrant?.status

  step('wizard W files a permission request')
  const w = await g.wizard('FX43 wizard W', 'SYNTHETIC CLASSIFIER PLAN OTHER fx43wizard')
  const asked = await w.as('permissions.request', { command: B5_COMMAND, reason: 'B5 lsphp pool fix (stand-in)', rollback: 'none: the fixture never runs it' })
  const rule = asked.rule
  await poll(async () => await grantStatus(w.id, asked.requestId) === 'pending', { timeoutMs: 10_000, label: "W's pending card" })
  record('W-files', asked.status === 'pending' && rule ? 'PASS' : 'FAIL', { requestId: asked.requestId, class: asked.class, rule }, 'W has one pending request and its card')

  step('plain tab H has a request approved once, and holds its retry')
  const hTab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'FX43 holder H' })
  const h = { id: hTab.resourceId, tabId: hTab.id, title: 'FX43 holder H' }
  await rm(capture, { force: true })
  await g.submit(h.id, 'SYNTHETIC CLASSIFIER PLAN HOLD fx43holder', false)
  h.as = await g.credentialOf('fx43holder')
  await g.settled(h.id, 'H settles')
  const held = await h.as('permissions.request', { command: B5_COMMAND, reason: 'approved before the restart, retried after it' })
  await g.click(h, held.requestId, 'Approve once')
  await poll(async () => await g.told(h.id) === 1, { timeoutMs: 15_000, label: 'H told approved' })
  await g.settled(h.id, 'H notes the approval')
  const before = await g.grantsState(), file = await saved()
  record('H-held', before.grants.length === 1 && before.grants[0].agentSessionId === h.id && await g.ran(h.id) === 0 ? 'PASS' : 'FAIL',
    { grants: before.grants.map(grant => ({ holder: grant.agentSessionId === h.id ? 'H' : grant.agentSessionId, scope: grant.scope, delivery: grant.delivery })), ranH: await g.ran(h.id) }, 'H holds one approved-once grant it has not used')
  record('saved-before-restart', file?.requests?.length === 2 && file.grants?.length === 1 ? 'PASS' : 'FAIL',
    { requests: file?.requests?.map(entry => ({ id: entry.id, status: entry.status, holder: entry.agentSessionId === w.id ? 'W' : entry.agentSessionId === h.id ? 'H' : entry.agentSessionId })), grants: file?.grants?.length }, 'permission-grants.json in the profile holds W\'s waiting request and H\'s unspent grant')

  /** What survived, from the owner's state, W's own list and both cards in the window. */
  const survived = async label => {
    const state = await g.grantsState()
    const waiting = state.requests.find(entry => entry.id === asked.requestId)
    const grant = state.grants.find(entry => entry.agentSessionId === h.id)
    let listW
    try { listW = await w.as('permissions.list') } catch (error) { listW = { error: errorText(error) } }
    const cardW = await g.cardView(w, asked.requestId), cardH = await g.cardView(h, held.requestId)
    cardH.status = await g.article(held.requestId).locator('.sa-grant-card').getAttribute('data-grant-status').catch(() => null)
    const shotPath = await shot(`${label}-w-card`)
    const numbers = { owner: waiting && { status: waiting.status, holder: waiting.agentSessionId === w.id ? 'W' : waiting.agentSessionId }, listW: listW.error ?? listW.requests?.map(entry => ({ id: entry.id, status: entry.status })), cardW, grantH: grant && { rule: grant.rule, delivery: grant.delivery }, cardH }
    record(`${label}-W-live`, waiting?.status === 'pending' && waiting.agentSessionId === w.id && cardW.buttons === 3 && Array.isArray(listW.requests) && listW.requests.some(entry => entry.id === asked.requestId && entry.status === 'pending') ? 'PASS' : 'FAIL', numbers, `W's card is live again (${cardW.buttons} buttons), W's permissions.list and the owner's state hold it; ${shotPath}`)
    record(`${label}-H-grant`, grant?.rule === rule && cardH.buttons === 0 && cardH.status === 'approved-once' ? 'PASS' : 'FAIL', { grantH: numbers.grantH, cardH }, "H's approved-once grant is still held and its card says so")
  }

  step("the owner's app.restart (the quit path an update install takes)")
  const firstPid = inst.credential.pid
  await call('app.restart', { force: true })
  const restartSeconds = await relaunched(inst, firstPid, { timeoutMs: 90_000 })
  await rebind()
  record('restart', 'INFO', { seconds: restartSeconds }, 'relaunched by app.restart')
  await survived('restart')

  step('a renderer reload keeps the card live')
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 })
  const reloaded = await g.cardView(w, asked.requestId)
  record('reload-W-live', reloaded.buttons === 3 ? 'PASS' : 'FAIL', reloaded, "after a renderer reload W's card still offers its answers")

  step('the app crashes (taskkill /F) and is started again')
  execFileSync('taskkill.exe', ['/pid', String(inst.credential.pid), '/T', '/F'], { stdio: 'ignore' })
  await relaunchParked(inst)
  await rebind()
  // A relaunch after a crash opens no workspace by itself: select the project as the owner would.
  await openProject({ name: 'FX43 grant restart', path: inst.projectPath })
  await survived('crash')

  step("W's CLI reconnects under a new runtime: the restored card stays live")
  // The pane offers answers only on the current runtime's items; a card drawn before the restart
  // belongs to the old runtime once the holder's CLI is started again.
  const runtimeBefore = (await g.snap(w.id))?.runtimeId
  await view.evaluate(value => window.conductor.structured.connect(value), w.id)
  const runtimeChanged = await poll(async () => (await g.snap(w.id))?.runtimeId !== runtimeBefore, { timeoutMs: 20_000, label: "W's new runtime" }).then(() => true, () => false)
  const reconnected = await g.cardView(w, asked.requestId)
  record('reconnect-W-live', runtimeChanged && reconnected.buttons === 3 ? 'PASS' : 'FAIL', { runtimeChanged, buttons: reconnected.buttons }, await shot('reconnect-w-card'))

  step("H retries after the restarts: its resumed CLI runs the call once, then the grant is spent")
  await g.submit(h.id, 'SYNTHETIC CLASSIFIER OTHER retry after the restarts', false)
  await g.settled(h.id, 'H retry settles')
  await poll(async () => !(await g.grantsState()).grants.some(grant => grant.agentSessionId === h.id), { timeoutMs: 15_000, label: "H's grant spent" })
  const ranH = await g.ran(h.id, rule)
  await g.submit(h.id, 'SYNTHETIC CLASSIFIER OTHER a second try', false)
  await g.settled(h.id, 'H second try settles')
  const lastH = (await g.texts(h.id, 'assistant')).at(-1) ?? ''
  const spentH = (await g.grantsState()).requests.find(entry => entry.id === held.requestId)
  record('H-consumes-once', ranH === 1 && await g.ran(h.id, rule) === 1 && /SYNTHETIC classifier refused Bash/.test(lastH) && spentH?.status === 'used' ? 'PASS' : 'FAIL',
    { ranFirst: ranH, ranAfterSecond: await g.ran(h.id, rule), last: lastH.slice(0, 160), status: spentH?.status, launches: (await g.flags()).filter(entry => entry.launch?.includes(rule)).length }, 'the grant approved before two restarts ran once in the resumed CLI and was spent; the second try was refused')

  step("the owner approves W once in its card, after both restarts")
  await g.click(w, asked.requestId, 'Approve once')
  await poll(async () => await g.told(w.id) === 1, { timeoutMs: 15_000, label: 'W told approved' })
  await poll(async () => await g.ran(w.id, rule) === 1, { timeoutMs: 30_000, label: 'W retry ran' })
  await g.settled(w.id, 'W settles after its retry')
  await poll(async () => (await g.grantsState()).grants.length === 0, { timeoutMs: 10_000, label: "W's grant spent" })
  const toldText = (await g.texts(w.id, 'user')).filter(text => text.startsWith('[Conductor] approved:'))
  await g.submit(w.id, `[Conductor] approved: ${rule} (once); retry it now.`, false)
  await g.settled(w.id, 'W second retry settles')
  const lastW = (await g.texts(w.id, 'assistant')).at(-1) ?? ''
  const spentW = (await g.grantsState()).requests.find(entry => entry.id === asked.requestId)
  record('W-approve-once', toldText.length === 1 && toldText[0].startsWith(`[Conductor] approved: ${rule} (once); retry it now`) && await g.ran(w.id, rule) === 1 && /SYNTHETIC classifier refused Bash/.test(lastW) && spentW?.status === 'used' ? 'PASS' : 'FAIL',
    { told: toldText.map(text => text.slice(0, 160)), ran: await g.ran(w.id, rule), last: lastW.slice(0, 160), status: spentW?.status }, 'one click: W was told once, ran the call once, the grant was spent, and a second retry was refused')

  // Each refused second try showed a classifier denial card: a new pending request of its own.
  const denials = (await g.grantsState()).requests.filter(entry => entry.source === 'denial' && entry.status === 'pending')
  const denialW = denials.find(entry => entry.agentSessionId === w.id)

  step('one more restart brings back nothing spent, and the denial cards still waiting')
  const secondPid = inst.credential.pid
  await call('app.restart', { force: true })
  await relaunched(inst, secondPid, { timeoutMs: 90_000 })
  await rebind()
  const after = await g.grantsState(), fileAfter = await saved()
  const cardAfter = await g.cardView(w, asked.requestId)
  // The timeline is windowed: the old card may be out of the rendered slice, so its recorded answer
  // (what the card shows once the main process no longer holds the request) is read too.
  cardAfter.status = await g.article(asked.requestId).locator('.sa-grant-card').getAttribute('data-grant-status', { timeout: 2000 }).catch(() => null)
  cardAfter.recorded = await grantStatus(w.id, asked.requestId)
  let listAfter
  try { listAfter = await w.as('permissions.list') } catch (error) { listAfter = { error: errorText(error) } }
  const spentIds = [asked.requestId, held.requestId]
  record('spent-not-restored', !after.requests.some(entry => spentIds.includes(entry.id)) && after.grants.length === 0 && !fileAfter?.requests?.some(entry => spentIds.includes(entry.id)) && fileAfter?.grants?.length === 0 && cardAfter.buttons === 0 && (cardAfter.status ?? 'used') === 'used' && cardAfter.recorded === 'used' && after.settled?.some(entry => entry.id === asked.requestId && entry.status === 'used') && Array.isArray(listAfter.requests) && !listAfter.requests.some(entry => spentIds.includes(entry.id)) ? 'PASS' : 'FAIL',
    { state: { requests: after.requests.map(entry => ({ id: entry.id, status: entry.status })), grants: after.grants.length, settled: after.settled }, file: { requests: fileAfter?.requests?.map(entry => entry.id), grants: fileAfter?.grants?.length, settled: fileAfter?.settled }, cardAfter, listW: listAfter.error ?? listAfter.requests?.map(entry => entry.id) }, await shot('after-used-restart'))
  const denialCard = denialW ? await g.cardView(w, denialW.id) : null
  record('denial-restored', denials.length === 2 && denials.every(entry => after.requests.some(kept => kept.id === entry.id && kept.agentSessionId === entry.agentSessionId && kept.status === 'pending')) && denialCard?.buttons === 3 ? 'PASS' : 'FAIL',
    { before: denials.map(entry => ({ id: entry.id, holder: entry.agentSessionId === w.id ? 'W' : 'H' })), after: after.requests.filter(entry => entry.source === 'denial').map(entry => ({ id: entry.id, status: entry.status })), denialCard }, "the classifier denial cards still waiting came back pending, and W's is live")

  step('first launch of this build: a waiting card an older build left in the timeline comes back')
  // An older build kept requests in memory only, and its quit wrote no card, so the timeline still
  // shows the request waiting while no permission-grants.json exists yet.
  const legacy = await w.as('permissions.request', { command: 'bash app/prod/legacy-card.sh', reason: 'filed under a build that kept grants in memory only' })
  await poll(async () => await grantStatus(w.id, legacy.requestId) === 'pending', { timeoutMs: 10_000, label: "W's legacy card" })
  const crashedPid = inst.credential.pid
  execFileSync('taskkill.exe', ['/pid', String(crashedPid), '/T', '/F'], { stdio: 'ignore' })
  await poll(() => { try { process.kill(crashedPid, 0); return false } catch { return true } }, { timeoutMs: 30_000, label: 'the crashed app to exit' })
  await rm(join(inst.profile, 'permission-grants.json'), { force: true })
  await relaunchParked(inst)
  await rebind()
  await openProject({ name: 'FX43 grant restart', path: inst.projectPath })
  const recovered = await g.grantsState(), legacyCard = await g.cardView(w, legacy.requestId)
  let legacyList
  try { legacyList = await w.as('permissions.list') } catch (error) { legacyList = { error: errorText(error) } }
  record('legacy-recovered', recovered.requests.some(entry => entry.id === legacy.requestId && entry.agentSessionId === w.id && entry.status === 'pending') && !recovered.requests.some(entry => spentIds.includes(entry.id)) && legacyCard.buttons === 3 && legacyList.requests?.some(entry => entry.id === legacy.requestId) && (await saved())?.requests?.some(entry => entry.id === legacy.requestId) ? 'PASS' : 'FAIL',
    { state: recovered.requests.map(entry => ({ id: entry.id, source: entry.source, status: entry.status })), legacyCard, listW: legacyList.error ?? legacyList.requests?.map(entry => entry.id) }, await shot('legacy-recovered'))
  record('legacy-denials', 'INFO', { recoveredDenials: recovered.requests.filter(entry => entry.source === 'denial').length }, 'the one-time recovery takes agent requests only; a denial card still answers through the timeline (lazy path) but is not listed until it is shown again')
  record('flag-settings', 'INFO', { entries: (await g.flags()).length, launchesWithRule: (await g.flags()).filter(entry => entry.launch?.includes(rule)).length, applied: (await g.flags()).filter(entry => entry.applied).map(entry => entry.applied) }, 'rules handed to the fixture processes (all tabs share one log)')
}
