// grant-cards-lost-at-handoff. Real case 2026-09-29 (Haftheme): a wizard filed four request_permission
// cards, handed itself on (agents.handoff successor:true) and Conductor restarted for an update. The
// requests stayed pending with the successor as holder, and its timeline held the four cards, but as
// its first items: 300 items later the pane's 60-item window had paged them out, nothing pinned them,
// and a conductor:// link the successor gave the owner named the tab already on screen, so clicking it
// changed nothing. The successor wizard then ran the steps by hand. Here:
//   wizard W files two requests -> hands off to S -> S produces a long conversation and replies with a
//   conductor:// link to its own tab -> app.restart -> in S's tab the cards are out of the timeline
//   window, yet the dock above the composer shows both with their buttons -> Needs attention lists S
//   as permission with the call -> the link, clicked with the timeline scrolled up, brings the live end
//   and the dock into view (S's wand switched off: the dock is for tabs that are not wizards) -> with
//   the wand back on the dock is gone, and S, a wizard, answers both cards itself (permissions.decide,
//   by its own id and by its predecessor's), each recorded as answered by a wizard tab, and is told
//   to retry (wizard-means-wizard, owner 2026-09-30).
// Real Electron main/preload/renderer; only the Claude process is the synthetic fixture
// (scripts/fixtures/fake-claude.mjs, SYNTHETIC CLASSIFIER / LONG / FILELINKS), so nothing is executed
// and no inference happens. CONDUCTOR_TEST_USER_DATA parks the window; spawn mode survives the restart.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-grant-cards-handoff.mjs
// CONDUCTOR_SMOKE_MAIN=<worktree>/out/main/index.js runs another build (a worktree of one change).
import { BUILD, call, configure, failed, finish, launchParked, openProject, page, poll, record, relaunched, shot, step, watchdog } from './verify-kit.mjs'
import { B5_COMMAND, errorText, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const OUTPUT = 'artifacts/verification/2026-09-30-grant-cards-handoff'
configure({ name: 'grant-cards-handoff', output: OUTPUT })
watchdog(600)
const { capture, flagLog, env } = await handoffEnv('grantcards')
try {
  const inst = await launchParked({ mode: 'spawn', env, build: process.env.CONDUCTOR_SMOKE_MAIN || BUILD })
  await scenario(inst)
} catch (error) { await failed(error, 'grant-cards-handoff') }
await finish()

async function scenario(inst) {
  let view = await page(inst)
  await openProject({ name: 'Grant cards handoff' })
  let g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  const rebind = async () => { view = await page(inst); g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT }) }

  step('wizard W files two permission requests')
  const w = await g.wizard('Cards wizard W', 'SYNTHETIC CLASSIFIER PLAN OTHER cardsW')
  const first = await w.as('permissions.request', { command: B5_COMMAND, reason: 'launch step 1 (the owner said go in chat)', rollback: 'none: the fixture never runs it' })
  const second = await w.as('permissions.request', { command: 'bash .conductor-scratch/controller/prod-step2.sh', reason: 'launch step 2' })
  record('W-files', first.status === 'pending' && second.status === 'pending' ? 'PASS' : 'FAIL', { first: first.requestId, second: second.requestId }, 'W holds two pending requests')

  step('W hands itself on to S')
  const s = await g.handOff(w, 'SYNTHETIC CLASSIFIER PLAN OTHER successor cardsS')
  const moved = (await g.grantsState()).requests.filter(entry => entry.agentSessionId === s.id && entry.status === 'pending').map(entry => entry.id)
  record('moved', moved.includes(first.requestId) && moved.includes(second.requestId) ? 'PASS' : 'FAIL', { successor: s.id, moved, handoff: s.result.permissions }, 'both requests are pending with the successor as holder')

  step('S works on: a long conversation, then a conductor:// link to its own tab')
  await g.submit(s.id, 'SYNTHETIC LONG 240', false)
  await g.settled(s.id, 'S long turn settles', 90_000)
  await g.submit(s.id, `SYNTHETIC FILELINKS <<<The production cards are in this tab: ${s.result.uri}. Please click them in order.>>>`, false)
  await g.settled(s.id, 'S link reply settles')
  const items = (await g.snap(s.id)).items.length
  record('S-long', items > 120 ? 'INFO' : 'FAIL', { items }, 'the successor has far more items than the 60-item live window')

  step('the owner restarts the app (the quit path an update install takes)')
  const pid = inst.credential.pid
  await call('app.restart', { force: true })
  record('restart', 'INFO', { seconds: await relaunched(inst, pid, { timeoutMs: 90_000 }) }, 'relaunched by app.restart')
  await rebind()
  await g.show({ tabId: s.tabId }, 1500)

  step("S's tab, wand off: the cards are out of the timeline window, and the dock shows them live")
  const wand = view.locator('.structured-agent-pane .wizard-toggle')
  const setWand = async on => { if ((await wand.getAttribute('aria-pressed')) !== String(on)) await wand.click(); await poll(async () => (await wand.getAttribute('aria-pressed')) === String(on), { timeoutMs: 5000, label: `wand ${on ? 'on' : 'off'}` }) }
  const wizardDock = await view.locator('[data-grant-dock]').count()
  await setWand(false)
  const inTimeline = await view.locator(`.sa-timeline article[data-native-item-id="${first.requestId}"]`).count()
  const dock = view.locator('[data-grant-dock]')
  await dock.waitFor({ timeout: 10_000 }).catch(() => undefined)
  const dockCards = await dock.locator('.sa-grant-card').count()
  const dockButtons = await dock.getByRole('button', { name: /^(Approve once|Approve for this session|Deny)$/ }).count()
  record('dock-after-restart', inTimeline === 0 && dockCards === 2 && dockButtons === 6 ? 'PASS' : 'FAIL', { inTimeline, dockCards, dockButtons, dockText: (await dock.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240) }, await shot('dock-after-restart'))

  step('Needs attention lists S as a permission, naming the call')
  const row = view.locator(`[data-attention-tab="${s.tabId}"]`)
  await row.waitFor({ timeout: 20_000 }).catch(() => undefined)
  const reason = await row.getAttribute('data-attention-reason').catch(() => null), title = await row.getAttribute('title').catch(() => '')
  record('needs-attention', reason === 'permission' && title.includes(B5_COMMAND) ? 'PASS' : 'FAIL', { reason, title: title?.slice(0, 240) }, 'the global list names the tab and the waiting call')

  step("the link to S's own tab, clicked with the timeline scrolled up, brings the dock into view")
  const timeline = view.locator('.sa-timeline').first()
  const link = view.locator('.sa-timeline a.sa-conversation-ref').last()
  await link.waitFor({ timeout: 10_000 })
  await timeline.evaluate(element => { element.scrollTop = 0 })
  await link.evaluate(element => element.scrollIntoView({ block: 'end' }))
  await link.click()
  const pulsed = await poll(async () => await view.locator('.sa-grant-dock-pulse').count() > 0, { timeoutMs: 3000, intervalMs: 50, label: 'dock pulse' }).then(() => true, () => false)
  const atEnd = await poll(() => timeline.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 40), { timeoutMs: 3000, label: 'timeline at its live end' }).then(() => true, () => false)
  record('link-reveals', pulsed && atEnd ? 'PASS' : 'FAIL', { href: await link.getAttribute('href'), pulsed, atEnd }, await shot('link-reveals'))

  step("wand back on: no dock in the wizard tab, and S answers its own and its predecessor's card itself")
  await setWand(true)
  const dockWithWand = await poll(async () => await view.locator('[data-grant-dock]').count() === 0 ? 'hidden' : null, { timeoutMs: 5000, label: 'dock hidden in the wizard tab' }).catch(() => 'shown')
  record('wizard-no-dock', wizardDock === 0 && dockWithWand === 'hidden' ? 'PASS' : 'FAIL', { beforeWandOff: wizardDock, afterWandOn: dockWithWand }, await shot('wizard-no-dock'))
  const answer = async (agentSessionId, requestId) => { try { return await s.as('permissions.decide', { agentSessionId, requestId, decision: 'approve-once' }) } catch (error) { return { error: errorText(error) } } }
  const own = await answer(s.id, first.requestId)
  await poll(async () => await g.told(s.id) >= 1, { timeoutMs: 15_000, label: 'S told approved' }).catch(() => undefined)
  const viaPredecessor = await answer(w.id, second.requestId)
  const after = (await g.grantsState()).requests
  const decided = [first, second].map(entry => after.find(request => request.id === entry.requestId))
  record('wizard-answers-own', decided.every(entry => entry && ['approved-once', 'used'].includes(entry.status) && entry.decidedBy === 'wizard') && !own.error && !viaPredecessor.error ? 'PASS' : 'FAIL', { own: own.error ?? own.status, viaPredecessor: viaPredecessor.error ?? viaPredecessor.status, decided: decided.map(entry => ({ status: entry?.status, decidedBy: entry?.decidedBy })), told: await g.told(s.id) }, await shot('after-wizard-approves'))
}
