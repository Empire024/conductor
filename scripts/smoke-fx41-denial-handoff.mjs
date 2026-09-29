// FX41: a classifier-denial approval card follows agents.handoff({successor:true}) (VR8f gap 1,
// docs/verification/2026-09-26-vr8f.md S3). The card is a pending request from the moment it is shown,
// so the handoff moves it: B lists it with holder B, A's card says Moved to <B title · id> with no
// buttons, one Approve once in B tells B and B runs it once, A never does; closing A first keeps it on
// B; a tab closed without a successor turns its denial card Expired. Helpers are VR8f's
// (scripts/smoke-verify-vr8f-handoff.mjs); only the Claude process is scripts/fixtures/fake-claude.mjs.
// Run from a worktree whose out/ is the build under test:
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-fx41-denial-handoff.mjs --label head-r1
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => { const at = process.argv.indexOf('--' + name); return at > 0 ? process.argv[at + 1] : fallback }
const label = arg('label', 'head')
configure({ name: `fx41-${label}`, output: join(arg('out', 'artifacts/verification/2026-09-26-fx41'), label) })
watchdog(480)
const COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=3 root@192.0.2.10 'lswsctrl restart'"
const MODEL = 'claude-fable-5-1' // as smoke-fx38: the offline models.list offers the wizard's model with CONDUCTOR_TEST_CLAUDE_QUOTA=fable
const side = await mkdtemp(join(tmpdir(), 'conductor-fx41-side-'))
const capture = join(side, 'provider-input.txt'), flagLog = join(side, 'flag-settings.log')
const env = { CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_CONTROL_CAPTURE_APPEND: '1', CONDUCTOR_TEST_FLAG_SETTINGS_LOG: flagLog }
const errorText = error => (error instanceof Error ? error.message : String(error)).slice(0, 400)
/** A check that records FAIL with its error instead of ending the run (a pre-fix build fails early). */
const check = async (id, work) => { try { await work() } catch (error) { record(id, 'FAIL', { error: errorText(error) }, 'check threw') } }

let view
const snap = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
const grantsState = () => view.evaluate(() => window.conductor.permissionGrants.state())
const submit = (id, prompt, wizard) => view.evaluate(async ([value, text, wand, model]) => {
  await window.conductor.structured.connect(value)
  const state = await window.conductor.structured.snapshot(value)
  const settings = { ...state.settings, ...(wand ? { wizard: true, model, effort: 'high' } : {}) }
  await window.conductor.structured.saveSettings(value, settings)
  await window.conductor.structured.submit(value, text, settings, [])
}, [id, prompt, wizard, MODEL])
// The fixture's init reports model synthetic-claude; the wand needs a frontier model, so set it again.
const rewizard = id => view.evaluate(async ([value, model]) => { const state = await window.conductor.structured.snapshot(value); await window.conductor.structured.saveSettings(value, { ...state.settings, wizard: true, model, effort: 'high' }) }, [id, MODEL])
const settled = (id, what) => poll(async () => /^(completed|idle)$/.test((await snap(id))?.phase ?? ''), { timeoutMs: 30_000, label: what })
const texts = async (id, role) => ((await snap(id))?.items ?? []).filter(item => item.data.type === 'text' && item.data.role === role).map(item => item.data.text)
const ran = async (id, rule) => (await texts(id, 'assistant')).filter(text => text === 'SYNTHETIC classified call ran: ' + rule).length
const told = async (id, prefix) => (await texts(id, 'user')).filter(text => text.startsWith(prefix)).length
const cardOf = async (id, requestId) => ((await snap(id))?.items ?? []).filter(item => item.data.type === 'notice' && (item.data.payload?.permissionGrant?.id === requestId || item.id === requestId || item.nativeItemId === requestId)).at(-1)?.data.payload
const grantCard = async (id, requestId) => (await cardOf(id, requestId))?.permissionGrant
const denialIds = async id => ((await snap(id))?.items ?? []).filter(item => item.data.type === 'notice' && item.data.payload?.autoModeDenial?.toolUseId).map(item => 'auto-denial:' + item.data.payload.autoModeDenial.toolUseId).filter((value, index, all) => all.indexOf(value) === index)
const flags = async () => (await readFile(flagLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
/** Each tab's own control credential, from the briefing its first prompt carried (every prompt is appended to capture). */
const credentialOf = async (marker, intervalMs = 250) => {
  const briefing = await poll(async () => (await readFile(capture, 'utf8').catch(() => '')).split('\u0000').find(text => text.includes(marker) && text.includes('Conductor app control:')) ?? null, { timeoutMs: 30_000, intervalMs, label: `control briefing (${marker})` })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  return async (method, args = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const body = await response.json()
    if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 400)}`)
    return body.result
  }
}
// Rows show short labels ("…A (continued)") and a superseded tab sits under a collapsed Done, so tabs are
// brought forward by id, as scripts/lib/grant-handoff.mjs show() does.
const show = async tabId => { await call('tabs.focus', { tabId }); await sleep(700) }
const article = requestId => view.locator(`article[data-native-item-id="${requestId}"]`)
/** The owner's click: select the tab, then the button in the card. */
const click = async (tabId, requestId, name) => {
  await show(tabId)
  const button = article(requestId).getByRole('button', { name, exact: true })
  await button.waitFor({ timeout: 15_000 })
  await button.click()
}
const handoffText = first => first + '\n\n' + [['Objective', 'Continue as the wizard; the pool fix waits on the owner.'], ['Constraints', 'Local commits only.'], ['Owned files', 'None.'], ['Verified findings', 'A permission request for the B5 pool fix is waiting on the owner.'], ['Remaining work', 'Run the pool fix once it is approved.'], ['Artifact references', 'artifacts/verification/2026-09-26-vr8f']].map(([h, l]) => h + '\n- ' + l).join('\n\n')
/** A wizard tab that has run one first turn; returns its id, tab and control caller. */
const wizard = async (title, first) => {
  const tab = await openTab({ provider: 'claude', model: MODEL, title })
  await rm(capture, { force: true })
  await submit(tab.resourceId, first, true)
  const as = await credentialOf(first.split(' ').at(-1))
  await settled(tab.resourceId, `${title} settles`)
  await rewizard(tab.resourceId)
  await poll(async () => (await as('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: `${title} is the wizard` })
  return { id: tab.resourceId, tab, title, as }
}
const handOff = async (from, first) => {
  await rm(capture, { force: true })
  const handing = from.as('agents.handoff', { handoff: handoffText(first), successor: true })
  const as = await Promise.race([credentialOf(first.split(' ').at(-1)), handing.then(() => new Promise(() => {}))])
  const result = await handing
  await settled(result.agentSessionId, `${result.title} settles`)
  return { id: result.agentSessionId, title: result.title, tabId: result.tabId, as, result }
}

const deniedCard = async (id, denialId) => ((await snap(id))?.items ?? []).filter(item => item.data.type === 'notice' && item.nativeItemId === denialId && item.data.payload?.autoModeDenial).at(-1)?.data.payload
const ranAny = async id => (await texts(id, 'assistant')).filter(text => text.startsWith('SYNTHETIC classified call ran:')).length
const heldBy = async (denialId, ids) => (await grantsState()).requests.find(item => item.id === denialId && ids.includes(item.agentSessionId))

try {
  await loadCheck()
  await launchParked({ env })
  view = await page()
  await openProject({ name: `FX41 ${label}` })
  await gap1()
  await gap1Closed()
  await noSuccessor()
} catch (error) { await failed(error, 'fx41-error') }
await finish()

async function gap1() {
  step('G1: A\'s classifier denies a call; A hands off with its card unanswered')
  const a = await wizard('FX41 wizard A', 'SYNTHETIC CLASSIFIER OTHER fx41-g1-A')
  const denial = await poll(async () => (await denialIds(a.id))[0], { timeoutMs: 10_000, label: "A's denial card" })
  const listedA = (await a.as('permissions.list')).requests.filter(item => item.id === denial).length
  record('G1-shown-is-pending', listedA === 1 ? 'PASS' : 'FAIL', { listedA }, 'the denial card is a pending request before anyone answers it')
  const b = await handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor fx41-g1-B')
  const listB = (await b.as('permissions.list')).requests.filter(item => item.id === denial)
  const held = await heldBy(denial, [a.id, b.id])
  record('G1-moved', b.result.permissions?.requests === 1 && listB[0]?.status === 'pending' && listB[0]?.holder?.agentSessionId === b.id && held?.agentSessionId === b.id ? 'PASS' : 'FAIL', { handoffPermissions: b.result.permissions ?? null, listB: listB.map(item => ({ status: item.status, holder: item.holder?.title })), ownerState: held ? (held.agentSessionId === b.id ? 'B' : 'A') : null }, 'the handoff moves the denial: B lists it pending with holder B, and so does the owner state')

  await show(a.tab.id)
  const aButtons = await article(denial).getByRole('button', { name: 'Approve once', exact: true }).count()
  const aText = (await article(denial).innerText().catch(() => '')).replace(/\s+/g, ' ')
  const aShot = await shot('g1-a-card')
  const aPayload = await deniedCard(a.id, denial)
  await show(b.tabId)
  await article(denial).getByRole('button', { name: 'Approve once', exact: true }).waitFor({ timeout: 15_000 }).catch(() => undefined)
  const bButtons = await article(denial).getByRole('button', { name: 'Approve once', exact: true }).count()
  const bText = (await article(denial).innerText().catch(() => '')).replace(/\s+/g, ' ')
  const bShot = await shot('g1-b-card')
  const holderLabel = b.title + ' · '
  record('G1-cards', aButtons === 0 && /Moved to/.test(aText) && aText.includes(holderLabel) && aPayload?.grantStatus === 'moved' && bButtons === 1 && /Holder/.test(bText) && bText.includes(holderLabel) ? 'PASS' : 'FAIL', { aButtons, aStatus: aPayload?.grantStatus ?? null, a: aText.slice(0, 260), bButtons, b: bText.slice(0, 260) }, `${aShot}, ${bShot}; A says Moved to <B title · id>, no buttons; B's card is live and names its holder`)

  await click(b.tabId, denial, 'Approve once')
  await poll(async () => await ranAny(b.id) >= 1, { timeoutMs: 20_000, label: 'B ran it' }).catch(() => undefined)
  await sleep(4000)
  const who = { aTold: await told(a.id, '[Conductor] approved:'), bTold: await told(b.id, '[Conductor] approved:'), aRan: await ranAny(a.id), bRan: await ranAny(b.id) }
  const spent = await heldBy(denial, [a.id, b.id])
  record('G1-approve-in-B', who.bTold === 1 && who.bRan === 1 && who.aTold === 0 && who.aRan === 0 && spent?.status === 'used' && spent.agentSessionId === b.id ? 'PASS' : 'FAIL', { ...who, status: spent?.status ?? null, holder: spent ? (spent.agentSessionId === b.id ? 'B' : 'A') : null }, 'one Approve once in B: B told, B runs it once and spends it; the superseded A is never told and never runs it')
  const again = await a.as('permissions.list').catch(error => ({ error: errorText(error) }))
  record('G1-A-holds-nothing', !again.error && !again.requests.some(item => item.id === denial) && !again.grants.length ? 'PASS' : 'FAIL', { a: again.error ?? { requests: again.requests.length, grants: again.grants.length } }, 'A holds neither the request nor a grant')
}

async function gap1Closed() {
  step('G2: the owner closes the superseded tab before answering')
  const a = await wizard('FX41 wizard A2', 'SYNTHETIC CLASSIFIER OTHER fx41-g2-A')
  const denial = await poll(async () => (await denialIds(a.id))[0], { timeoutMs: 10_000, label: "A2's denial card" })
  const b = await handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor fx41-g2-B')
  await call('tabs.close', { tabId: a.tab.id })
  await sleep(4000)
  const list = (await b.as('permissions.list')).requests.filter(item => item.id === denial)
  const held = await heldBy(denial, [a.id, b.id])
  record('G2-survives-close', list.length === 1 && held?.agentSessionId === b.id && held.status === 'pending' ? 'PASS' : 'FAIL', { listB: list.length, ownerState: held ? `${held.agentSessionId === b.id ? 'B' : 'A'}:${held.status}` : null }, 'after A is closed (4 s = 4 sweeps) the request is still pending on B')
  await click(b.tabId, denial, 'Approve once')
  await poll(async () => await ranAny(b.id) >= 1, { timeoutMs: 20_000, label: 'B2 ran it' }).catch(() => undefined)
  const shotB = await shot('g2-b-after')
  record('G2-approve-in-B', await ranAny(b.id) === 1 && await told(b.id, '[Conductor] approved:') === 1 ? 'PASS' : 'FAIL', { bTold: await told(b.id, '[Conductor] approved:'), bRan: await ranAny(b.id), status: (await heldBy(denial, [b.id]))?.status ?? null }, `${shotB}; the approval reaches B and B runs it once`)
}

async function noSuccessor() {
  step('G3: a denial card of a tab closed without a successor stops asking')
  const a = await wizard('FX41 plain A3', 'SYNTHETIC CLASSIFIER OTHER fx41-g3-A')
  const denial = await poll(async () => (await denialIds(a.id))[0], { timeoutMs: 10_000, label: "A3's denial card" })
  const before = await heldBy(denial, [a.id])
  await call('tabs.close', { tabId: a.tab.id })
  await poll(async () => !(await heldBy(denial, [a.id])), { timeoutMs: 15_000, label: 'A3 request withdrawn' }).catch(() => undefined)
  const card = await deniedCard(a.id, denial)
  record('G3-close-withdraws', before?.status === 'pending' && !(await heldBy(denial, [a.id])) && card?.grantStatus === 'expired' ? 'PASS' : 'FAIL', { before: before?.status ?? null, after: (await heldBy(denial, [a.id]))?.status ?? null, card: card?.grantStatus ?? null }, 'closed without a successor: the owner state drops it and its card turns Expired')
}
