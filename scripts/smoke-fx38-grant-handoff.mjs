// FX38 grant-survives-handoff. Real case 2026-09-26: the haftheme wizard filed permissions.request,
// then handed itself on (agents.handoff successor:true); the successor's permissions.list was empty
// and the owner's card was gone, so it filed the same request again. Here:
//   wizard A files a request -> A hands off to B -> B's permissions.list holds it and B's tab shows the
//   card with holder B (A's card says where it moved) -> the owner clicks Approve once in B's card ->
//   B is told "[Conductor] approved: <rule>; retry it now", its retry runs once and the grant is spent;
//   a second retry is refused again -> A holds nothing, is never told, and its runtime still refuses
//   the call -> a plain tab P that files a request and is closed without a successor withdraws its card.
// Real Electron main/preload/renderer; only the Claude process is the synthetic fixture
// (scripts/fixtures/fake-claude.mjs, SYNTHETIC CLASSIFIER), so nothing is executed and no inference
// happens. CONDUCTOR_TEST_USER_DATA parks the window.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx38-grant-handoff.mjs
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx38-grant-handoff', output: 'artifacts/verification/2026-09-26-fx38' })
watchdog(480)
const side = await mkdtemp(join(tmpdir(), 'conductor-fx38-side-'))
const capture = join(side, 'provider-input.txt'), flagLog = join(side, 'flag-settings.log')
// The fixture's OTHER call (an ssh to a documentation address); it is never executed.
const COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=3 root@192.0.2.10 'lswsctrl restart'"
try {
  const inst = await launchParked({ env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_FLAG_SETTINGS_LOG: flagLog } })
  await scenario(inst)
} catch (error) { await failed(error, 'FX38') }
await finish()

async function scenario(inst) {
  const view = await page(inst)
  await openProject({ name: 'FX38 grant handoff' })
  const snap = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const grantsState = () => view.evaluate(() => window.conductor.permissionGrants.state())
  const submit = (id, prompt, wizard) => view.evaluate(async ([value, text, wand]) => {
    await window.conductor.structured.connect(value)
    const state = await window.conductor.structured.snapshot(value)
    const settings = { ...state.settings, ...(wand === null ? {} : { wizard: wand, model: 'claude-fable-5-1', effort: 'high' }) }
    await window.conductor.structured.saveSettings(value, settings)
    await window.conductor.structured.submit(value, text, settings, [])
  }, [id, prompt, wizard])
  const settled = (id, label) => poll(async () => /^(completed|idle)$/.test((await snap(id))?.phase ?? ''), { timeoutMs: 20_000, label })
  const texts = async (id, role) => (await snap(id)).items.filter(item => item.data.type === 'text' && item.data.role === role).map(item => item.data.text)
  const grantNotice = async (id, requestId) => (await snap(id)).items.filter(item => item.data.type === 'notice' && item.data.payload?.permissionGrant?.id === requestId).at(-1)?.data.payload.permissionGrant
  // Each tab's own control credential, from the briefing its first prompt carried.
  const credentialOf = async marker => {
    const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes(marker) && text.includes('Conductor app control:') ? text : null }, { timeoutMs: 20_000, label: `control briefing (${marker})` })
    const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
    return async (method, args = {}) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
      const body = await response.json()
      if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 500)}`)
      return body.result
    }
  }
  // Rows show short labels ("…A (continued)") and a superseded tab sits under a collapsed Done, so tabs are
  // brought forward by id, as scripts/lib/grant-handoff.mjs show() does.
  const show = async tabId => { await call('tabs.focus', { tabId }); await new Promise(done => setTimeout(done, 700)) }
  const card = requestId => view.locator(`article[data-native-item-id="${requestId}"] .sa-grant-card`)

  step('wizard A files a permission request')
  const aTab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'FX38 wizard A' })
  const a = aTab.resourceId
  await rm(capture, { force: true })
  await submit(a, 'SYNTHETIC CLASSIFIER LOCAL note before asking', true)
  const asA = await credentialOf('SYNTHETIC CLASSIFIER LOCAL')
  await settled(a, 'A settles')
  // The fixture's init reports model synthetic-claude; the wand needs a frontier model, so set it again.
  await view.evaluate(async value => { const state = await window.conductor.structured.snapshot(value); await window.conductor.structured.saveSettings(value, { ...state.settings, wizard: true, model: 'claude-fable-5-1', effort: 'high' }) }, a)
  await poll(async () => (await asA('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: 'A is the wizard' })
  const asked = await asA('permissions.request', { command: COMMAND, reason: 'B5 lsphp pool fix (stand-in)', rollback: 'none: the fixture never runs it' })
  const filed = await asA('permissions.list')
  await poll(async () => (await grantNotice(a, asked.requestId))?.status === 'pending', { timeoutMs: 10_000, label: "A's pending card" })
  record('A-files', asked.status === 'pending' && asked.rule && filed.requests.length === 1 ? 'PASS' : 'FAIL', { requestId: asked.requestId, class: asked.class, rule: asked.rule, listed: filed.requests.length }, 'A has one pending request and its card')

  step('A hands off to successor B')
  await rm(capture, { force: true })
  const handoff = 'SYNTHETIC CLASSIFIER OTHER successor: continue as the wizard.\n\n' + [['Objective', 'Continue as the wizard; the pool fix waits on the owner.'], ['Constraints', 'Local commits only.'], ['Owned files', 'None.'], ['Verified findings', 'A filed one permission request for the pool fix.'], ['Remaining work', 'Run the pool fix once it is approved.'], ['Artifact references', 'artifacts/verification/2026-09-26-fx38']].map(([h, l]) => h + '\n- ' + l).join('\n\n')
  const result = await asA('agents.handoff', { handoff, successor: true })
  const b = result.agentSessionId
  const asB = await credentialOf('SYNTHETIC CLASSIFIER OTHER successor')
  await settled(b, "B's first turn settles")
  const listA = await asA('permissions.list'), listB = await asB('permissions.list')
  const state = await grantsState()
  const moved = state.requests.find(entry => entry.id === asked.requestId)
  const oldCard = await grantNotice(a, asked.requestId), newCard = await grantNotice(b, asked.requestId)
  const numbers = { handoffPermissions: result.permissions, listA: listA.requests.length, listB: listB.requests.map(entry => ({ id: entry.id, status: entry.status, holder: entry.holder })), stateHolder: moved?.agentSessionId === b, oldCard: oldCard && { status: oldCard.status, holder: oldCard.holder }, newCard: newCard && { status: newCard.status, holder: newCard.holder } }
  record('B-holds', result.permissions?.requests === 1 && listA.requests.length === 0 && listB.requests.length === 1 && listB.requests[0].id === asked.requestId && listB.requests[0].status === 'pending' && listB.requests[0].holder?.agentSessionId === b && moved?.agentSessionId === b && oldCard?.status === 'moved' && newCard?.status === 'pending' ? 'PASS' : 'FAIL', numbers, 'the request moved to B: B lists it, the service state names B, A lists nothing and A\'s card says moved')
  const again = await asB('permissions.request', { command: COMMAND, reason: 're-filed by the successor' })
  record('B-no-duplicate', again.requestId === asked.requestId && (await grantsState()).requests.filter(entry => entry.status === 'pending' && entry.resource === moved?.resource).length === 1 ? 'PASS' : 'FAIL', { again: again.requestId }, 'the successor re-filing the same call gets the moved request, not a second card')

  step("the owner's card in B's tab shows the holder")
  await show(result.tabId)
  const liveCard = card(asked.requestId)
  await liveCard.waitFor({ timeout: 15_000 })
  const cardText = await liveCard.innerText()
  const cardShot = await shot('b-card-holder')
  record('card-holder', /Holder/.test(cardText) && cardText.includes(result.title) && await liveCard.getByRole('button', { name: 'Approve once' }).isEnabled() ? 'PASS' : 'FAIL', { cardText: cardText.slice(0, 600) }, cardShot)
  await show(aTab.id)
  const aCard = card(asked.requestId)
  await aCard.waitFor({ timeout: 15_000 })
  const aText = await aCard.innerText()
  const aButtons = await aCard.getByRole('button').count()
  record('old-card-moved', /Moved to/.test(aText) && aText.includes(result.title) && aButtons === 0 ? 'PASS' : 'FAIL', { aText: aText.slice(0, 600), aButtons }, await shot('a-card-moved'))

  step('the owner approves once in B\'s card')
  await show(result.tabId)
  await card(asked.requestId).getByRole('button', { name: 'Approve once' }).click()
  const rule = asked.rule
  await poll(async () => (await texts(b, 'user')).some(text => text.startsWith('[Conductor] approved: ' + rule)), { timeoutMs: 15_000, label: 'B told approved' })
  await poll(async () => (await texts(b, 'assistant')).includes('SYNTHETIC classified call ran: ' + rule), { timeoutMs: 20_000, label: 'B retry ran' })
  await settled(b, 'B settles after its retry')
  await poll(async () => (await grantsState()).grants.length === 0, { timeoutMs: 10_000, label: 'grant spent' })
  const spent = (await grantsState()).requests.find(entry => entry.id === asked.requestId)
  record('B-consumes', spent?.status === 'used' && spent?.agentSessionId === b ? 'PASS' : 'FAIL', { status: spent?.status, holder: spent?.agentSessionId === b ? 'B' : spent?.agentSessionId }, 'B was told, retried once, and the approve-once grant was spent')

  step('a second retry by B is refused; A never got the rule')
  const ranBefore = (await texts(b, 'assistant')).filter(text => text === 'SYNTHETIC classified call ran: ' + rule).length
  await submit(b, `[Conductor] approved: ${rule} (once); retry it now.`, null)
  await settled(b, 'B second retry settles')
  const ranAfter = (await texts(b, 'assistant')).filter(text => text === 'SYNTHETIC classified call ran: ' + rule).length
  const refusedAgain = (await texts(b, 'assistant')).at(-1)
  record('consume-once', ranBefore === 1 && ranAfter === 1 && /SYNTHETIC classifier refused Bash/.test(refusedAgain ?? '') ? 'PASS' : 'FAIL', { ranBefore, ranAfter, last: refusedAgain }, 'the same retry a second time is refused: the grant was used exactly once')
  const aTold = (await texts(a, 'user')).filter(text => text.startsWith('[Conductor] approved:')).length
  const aList = await asA('permissions.list')
  let aRun = 'not attempted'
  try {
    await submit(a, 'SYNTHETIC CLASSIFIER OTHER the predecessor tries the call itself', null)
    await settled(a, 'A attempt settles')
    const last = (await texts(a, 'assistant')).at(-1) ?? ''
    aRun = /SYNTHETIC classifier refused Bash/.test(last) ? 'refused' : /classified call ran/.test(last) ? 'RAN' : last
  } catch (error) { aRun = 'submit refused: ' + (error instanceof Error ? error.message : String(error)).slice(0, 200) }
  record('A-cannot', aTold === 0 && aList.requests.length === 0 && aList.grants.length === 0 && aRun !== 'RAN' ? 'PASS' : 'FAIL', { aTold, aRequests: aList.requests.length, aGrants: aList.grants.length, aRun }, 'A was never told, holds nothing, and its runtime does not hold the rule')

  step('a plain tab closed without a successor withdraws its card')
  const p = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'FX38 plain P' })
  await rm(capture, { force: true })
  await submit(p.resourceId, 'SYNTHETIC CLASSIFIER LOCAL plain tab note', false)
  const asP = await credentialOf('SYNTHETIC CLASSIFIER LOCAL plain tab note')
  await settled(p.resourceId, 'P settles')
  const pAsked = await asP('permissions.request', { command: COMMAND, reason: 'plain tab asks, then is closed' })
  await poll(async () => (await grantsState()).requests.some(entry => entry.id === pAsked.requestId && entry.status === 'pending'), { timeoutMs: 10_000, label: "P's request pending" })
  await call('tabs.close', { tabId: p.id })
  await poll(async () => !(await grantsState()).requests.some(entry => entry.id === pAsked.requestId), { timeoutMs: 15_000, label: "P's request withdrawn" })
  const pCard = await grantNotice(p.resourceId, pAsked.requestId)
  record('closed-withdraws', pCard?.status === 'expired' ? 'PASS' : 'FAIL', { cardStatus: pCard?.status ?? null }, "P's pending card became Expired in its history, and the request left the owner's state")
  const flags = (await readFile(flagLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  record('flag-settings', 'INFO', { entries: flags.length, applied: flags.filter(entry => entry.applied).map(entry => entry.applied) }, 'rules handed to the fixture processes (all tabs share one log)')
}
