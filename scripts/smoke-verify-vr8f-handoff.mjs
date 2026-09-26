// VR8f grant-survives-handoff (FX38 d85e749 + 9e20e27), the verifier's own scenarios.
// Owner's case 2026-09-26: the haftheme wizard filed permissions.request (B5, class external), handed
// off with agents.handoff({successor:true}); the successor found permissions.list empty and the
// owner's card gone. One approval must reach the conversation that carries on, and it runs it once.
//   --group s1  the owner's case; the owner closes the superseded tab before approving
//   --group s2  an approved-not-yet-consumed grant and two pending ones through A -> B -> C, a deny
//               on the old id, C closed without a successor
//   --group s3  FX38's declared gaps: a classifier-denial card left at handoff (and its tab closed),
//               and a session rule A's CLI took at launch (CONDUCTOR_TEST_FLAG_SETTINGS_UNSUPPORTED)
// Real Electron main/preload/renderer; only the Claude process is scripts/fixtures/fake-claude.mjs
// (SYNTHETIC CLASSIFIER: nothing executes, no inference). Run from a worktree whose out/ is the build
// under test; --out names the results folder.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8f-handoff.mjs --group s1 --label head --out <dir>
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => { const at = process.argv.indexOf('--' + name); return at > 0 ? process.argv[at + 1] : fallback }
const group = arg('group', 's1'), label = arg('label', 'head')
configure({ name: `vr8f-${group}-${label}`, output: join(arg('out', 'artifacts/verification/2026-09-26-vr8f'), `${group}-${label}`) })
watchdog(480)
const COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=3 root@192.0.2.10 'lswsctrl restart'"
const MODEL = 'claude-fable-5-1' // as smoke-fx38: the offline models.list offers the wizard's model with CONDUCTOR_TEST_CLAUDE_QUOTA=fable
const side = await mkdtemp(join(tmpdir(), 'conductor-vr8f-side-'))
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
const tabRow = title => view.locator('.workspace-tab-row').filter({ has: view.getByText(title, { exact: true }) }).first()
const article = requestId => view.locator(`article[data-native-item-id="${requestId}"]`)
/** The owner's click: select the tab, then the button in the card. */
const click = async (title, requestId, name) => {
  await tabRow(title).click()
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

try {
  await loadCheck()
  await launchParked({ env: { ...env, ...(group === 's3b' ? { CONDUCTOR_TEST_FLAG_SETTINGS_UNSUPPORTED: '1' } : {}) } })
  view = await page()
  await openProject({ name: `VR8f ${group}` })
  if (group === 's1') await s1()
  else if (group === 's2') await s2()
  else if (group === 's3') await s3()
  else if (group === 's3b') await s3b()
  else throw new Error('unknown group ' + group)
} catch (error) { await failed(error, `${group}-error`) }
await finish()

async function s1() {
  step('S1: wizard A files the B5 stand-in (external)')
  const a = await wizard('VR8f S1 wizard A', 'SYNTHETIC CLASSIFIER PLAN OTHER vr8f-s1-A')
  const asked = await a.as('permissions.request', { command: COMMAND, reason: 'B5 lsphp pool fix (stand-in for grant:51bfd32e)', rollback: 'none: the fixture never runs it' })
  await poll(async () => (await grantCard(a.id, asked.requestId))?.status === 'pending', { timeoutMs: 10_000, label: "A's pending card" })
  record('S1-filed', asked.status === 'pending' && asked.class === 'external' && asked.rule ? 'PASS' : 'FAIL', { requestId: asked.requestId, class: asked.class, rule: asked.rule }, 'A filed one external request and its card is pending')

  step('S1: A hands off; B reads permissions.list the moment its CLI has its prompt')
  await rm(capture, { force: true })
  const handing = a.as('agents.handoff', { handoff: handoffText('SYNTHETIC CLASSIFIER PLAN OTHER successor vr8f-s1-B'), successor: true })
  const asB = await Promise.race([credentialOf('vr8f-s1-B', 20), handing.then(() => new Promise(() => {}))])
  const firstList = await asB('permissions.list').catch(error => ({ error: errorText(error) }))
  const result = await handing
  const b = { id: result.agentSessionId, title: result.title, as: asB }
  await settled(b.id, 'B settles')
  record('S1-first-instant', 'INFO', { requestsAtPrompt: firstList.requests?.length ?? firstList.error, handoffReturned: Boolean(result) }, "B's list read as soon as B's CLI received the handoff prompt (the real model needs seconds before its first call)")
  await check('S1-B-holds', async () => {
    const listA = await a.as('permissions.list'), listB = await b.as('permissions.list')
    const held = (await grantsState()).requests.find(entry => entry.id === asked.requestId)
    const entry = listB.requests.find(item => item.id === asked.requestId)
    const ok = result.permissions?.requests === 1 && listA.requests.length === 0 && entry?.status === 'pending' && entry?.holder?.agentSessionId === b.id && held?.agentSessionId === b.id
    record('S1-B-holds', ok ? 'PASS' : 'FAIL', { handoffPermissions: result.permissions ?? null, listA: listA.requests.length, listB: listB.requests.map(item => ({ id: item.id, status: item.status, holder: item.holder?.title })), ownerStateHolder: held?.agentSessionId === b.id ? 'B' : held?.agentSessionId ?? null }, 'the successor lists the request, the owner state names it, A lists nothing')
  })
  await check('S1-cards', async () => {
    await tabRow(b.title).click()
    const live = article(asked.requestId)
    await live.getByRole('button', { name: 'Approve once', exact: true }).waitFor({ timeout: 15_000 })
    const liveText = await live.innerText()
    const bShot = await shot('s1-b-card')
    await tabRow(a.title).click()
    await article(asked.requestId).waitFor({ timeout: 15_000 })
    const oldText = await article(asked.requestId).innerText()
    const oldButtons = await article(asked.requestId).getByRole('button').count()
    const aShot = await shot('s1-a-card')
    record('S1-cards', /Holder/.test(liveText) && liveText.includes(b.title) && /Moved to/.test(oldText) && oldText.includes(b.title) && oldButtons === 0 ? 'PASS' : 'FAIL', { live: liveText.replace(/\s+/g, ' ').slice(0, 300), old: oldText.replace(/\s+/g, ' ').slice(0, 300), oldButtons }, `${bShot}, ${aShot}`)
  })

  step('S1: the owner closes the superseded tab A, then approves once in B')
  await check('S1-after-close', async () => {
    await call('tabs.close', { tabId: a.tab.id })
    await sleep(5000)
    const held = (await grantsState()).requests.find(entry => entry.id === asked.requestId)
    record('S1-after-close', held?.agentSessionId === b.id && held?.status === 'pending' ? 'PASS' : 'FAIL', { held: held ? { holder: held.agentSessionId === b.id ? 'B' : held.agentSessionId, status: held.status } : null }, 'closing the predecessor (5 s = 5 sweeps) leaves the request pending on B')
  })
  await check('S1-approve', async () => {
    await click(b.title, asked.requestId, 'Approve once')
    await poll(async () => await told(b.id, '[Conductor] approved: ' + asked.rule) === 1, { timeoutMs: 15_000, label: 'B told approved' })
    await poll(async () => await ran(b.id, asked.rule) === 1, { timeoutMs: 20_000, label: 'B ran it' })
    await settled(b.id, 'B settles after its retry')
    await poll(async () => (await grantsState()).grants.length === 0, { timeoutMs: 10_000, label: 'grant spent' })
    const spent = (await grantsState()).requests.find(entry => entry.id === asked.requestId)
    record('S1-approve', spent?.status === 'used' && spent.agentSessionId === b.id && await ran(b.id, asked.rule) === 1 ? 'PASS' : 'FAIL', { status: spent?.status, holder: spent?.agentSessionId === b.id ? 'B' : spent?.agentSessionId, runs: await ran(b.id, asked.rule) }, "one click in B's card: B told, B ran it once, approve-once spent")
  })
  await check('S1-once', async () => {
    await submit(b.id, `[Conductor] approved: ${asked.rule} (once); retry it now.`, false)
    await settled(b.id, 'B second retry settles')
    const last = (await texts(b.id, 'assistant')).at(-1) ?? ''
    record('S1-once', await ran(b.id, asked.rule) === 1 && /SYNTHETIC classifier refused Bash/.test(last) ? 'PASS' : 'FAIL', { runs: await ran(b.id, asked.rule), last: last.slice(0, 160) }, 'a second retry is refused: consumed exactly once')
  })
}

async function s2() {
  step('S2: wizard A files R1 (external), R2 (write), R3 (url); the owner approves R1 once, A has not retried yet')
  const a = await wizard('VR8f S2 wizard A', 'SYNTHETIC CLASSIFIER PLAN HOLD vr8f-s2-A')
  const r1 = await a.as('permissions.request', { command: COMMAND, reason: 'B5 pool fix' })
  const r2 = await a.as('permissions.request', { path: 'C:/ProgramData/vr8f/pool-fix.sh', reason: 'write the fix script' })
  const r3 = await a.as('permissions.request', { url: 'https://example.com/vr8f-docs', reason: 'read the pool docs' })
  await click(a.title, r1.requestId, 'Approve once')
  await poll(async () => (await texts(a.id, 'assistant')).includes('SYNTHETIC: approval noted; the retry waits.'), { timeoutMs: 15_000, label: 'A noted the approval' })
  await settled(a.id, 'A settles after the note')
  const grantA = (await grantsState()).grants.find(grant => grant.requestId === r1.requestId)
  const applied = (await flags()).filter(entry => entry.applied?.includes(r1.rule))
  const pidA = applied.at(-1)?.pid
  record('S2-approved-A', grantA?.agentSessionId === a.id && grantA.delivery === 'live' && pidA ? 'PASS' : 'FAIL', { delivery: grantA?.delivery, pidA, ran: await ran(a.id, r1.rule) }, 'R1 approved once, live in A\'s CLI, not yet run')

  step('S2: A -> B -> C')
  const b = await handOff(a, 'SYNTHETIC CLASSIFIER PLAN HOLD successor vr8f-s2-B')
  await poll(async () => await told(b.id, '[Conductor] approved: ' + r1.rule) >= 1, { timeoutMs: 15_000, label: 'B told it holds R1' }).catch(() => undefined)
  await settled(b.id, 'B settles after being told')
  const pidB = (await flags()).filter(entry => entry.applied?.includes(r1.rule) && entry.pid !== pidA).at(-1)?.pid
  await rewizard(b.id)
  await poll(async () => (await b.as('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: 'B is the wizard' })
  record('S2-A-to-B', b.result.permissions?.requests === 2 && b.result.permissions?.grants === 1 && pidB ? 'PASS' : 'FAIL', { permissions: b.result.permissions ?? null, pidB, bTold: await told(b.id, '[Conductor] approved: ' + r1.rule) }, 'A->B moved 2 pending and 1 approved grant; B\'s CLI got the rule')
  const c = await handOff(b, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr8f-s2-C')
  await check('S2-C-runs', async () => {
    await poll(async () => await ran(c.id, r1.rule) === 1, { timeoutMs: 20_000, label: 'C ran R1' })
    await settled(c.id, 'C settles')
    await poll(async () => !(await grantsState()).grants.length, { timeoutMs: 10_000, label: 'R1 spent' })
    const spent = (await grantsState()).requests.find(entry => entry.id === r1.requestId)
    record('S2-C-runs', c.result.permissions?.grants === 1 && spent?.status === 'used' && spent.agentSessionId === c.id ? 'PASS' : 'FAIL', { permissions: c.result.permissions ?? null, status: spent?.status, holder: spent?.agentSessionId === c.id ? 'C' : spent?.agentSessionId, runsC: await ran(c.id, r1.rule), cTold: await told(c.id, '[Conductor] approved: ' + r1.rule) }, 'the approved grant reached the third tab, which ran it once')
  })
  await check('S2-A-B-cannot', async () => {
    const log = await flags()
    const lastOf = pid => log.filter(entry => entry.pid === pid && (entry.applied || entry.launch)).at(-1)
    const aHolds = (lastOf(pidA)?.applied ?? lastOf(pidA)?.launch ?? []).includes(r1.rule), bHolds = (lastOf(pidB)?.applied ?? lastOf(pidB)?.launch ?? []).includes(r1.rule)
    const tries = {}
    for (const [name, tab] of [['B', b], ['A', a]]) {
      try { await submit(tab.id, `SYNTHETIC CLASSIFIER OTHER vr8f-s2-${name}-try`, false); await settled(tab.id, `${name} try settles`); tries[name] = /refused/.test((await texts(tab.id, 'assistant')).at(-1) ?? '') ? 'refused' : 'other' } catch (error) { tries[name] = 'submit refused: ' + errorText(error).slice(0, 120) }
    }
    const runs = { A: await ran(a.id, r1.rule), B: await ran(b.id, r1.rule), C: await ran(c.id, r1.rule) }
    record('S2-A-B-cannot', !aHolds && !bHolds && runs.A === 0 && runs.B === 0 && runs.C === 1 ? 'PASS' : 'FAIL', { aHolds, bHolds, tries, runs }, 'the rule was taken out of A\'s and B\'s CLIs; neither ran it; total runs 1')
  })
  await check('S2-chain-cards', async () => {
    const st = (await grantsState()).requests
    const held = id => { const entry = st.find(item => item.id === id); return entry ? (entry.agentSessionId === c.id ? 'C' : entry.agentSessionId === b.id ? 'B' : entry.agentSessionId === a.id ? 'A' : entry.agentSessionId) + ':' + entry.status : null }
    const cards = {}
    for (const [name, tab] of [['A', a], ['B', b], ['C', c]]) for (const [rid, req] of [['R2', r2], ['R3', r3]]) { const card = await grantCard(tab.id, req.requestId); cards[`${name}.${rid}`] = card ? `${card.status}${card.holder ? '>' + card.holder.title : ''}` : null }
    const ok = held(r2.requestId) === 'C:pending' && held(r3.requestId) === 'C:pending' && /^moved>/.test(cards['A.R2']) && /^moved>/.test(cards['B.R2']) && cards['B.R2'].includes(c.title) && cards['C.R2'] === `pending>${c.title}`
    record('S2-chain-cards', ok ? 'PASS' : 'FAIL', { R2: held(r2.requestId), R3: held(r3.requestId), cards }, 'pending requests walked A->B->C; each old card names where it moved')
  })
  await check('S2-deny-old-id', async () => {
    const answer = await view.evaluate(([id, rid]) => window.conductor.permissionGrants.decide(id, rid, 'deny'), [a.id, r2.requestId])
    await poll(async () => await told(c.id, '[Conductor] the owner denied') >= 1, { timeoutMs: 15_000, label: 'C told denied' })
    const where = { A: await told(a.id, '[Conductor] the owner denied'), B: await told(b.id, '[Conductor] the owner denied'), C: await told(c.id, '[Conductor] the owner denied') }
    const entry = (await grantsState()).requests.find(item => item.id === r2.requestId)
    record('S2-deny-old-id', where.C === 1 && where.A === 0 && where.B === 0 && entry?.status === 'denied' ? 'PASS' : 'FAIL', { answer: answer?.status, where, status: entry?.status }, "a decision on A's old request id reached the holder two hops on")
  })
  await check('S2-close-withdraws', async () => {
    await settled(c.id, 'C settles before close')
    await call('tabs.close', { tabId: c.tabId })
    await poll(async () => !(await grantsState()).requests.some(item => item.id === r3.requestId), { timeoutMs: 15_000, label: 'R3 withdrawn' })
    const card = await grantCard(c.id, r3.requestId)
    record('S2-close-withdraws', card?.status === 'expired' ? 'PASS' : 'FAIL', { cCard: card?.status ?? null, left: (await grantsState()).requests.length }, "C closed without a successor: its waiting R3 card is Expired and the owner's state holds nothing")
  })
}

async function s3() {
  step('S3 neighbour: a denial card answered with no handoff runs in its own tab')
  const n = await wizard('VR8f S3 neighbour', 'SYNTHETIC CLASSIFIER OTHER vr8f-s3-N')
  const nDenial = await poll(async () => (await denialIds(n.id))[0], { timeoutMs: 10_000, label: 'neighbour denial card' })
  await click(n.title, nDenial, 'Approve once')
  await poll(async () => (await texts(n.id, 'assistant')).some(text => text.startsWith('SYNTHETIC classified call ran:')), { timeoutMs: 20_000, label: 'neighbour ran' })
  record('S3-neighbour', 'PASS', { denial: nDenial }, 'harness drives a denial card: approve once, the same tab runs it')

  step('S3 gap 1: a denial card unanswered at handoff, answered after it')
  const a = await wizard('VR8f S3 wizard A', 'SYNTHETIC CLASSIFIER OTHER vr8f-s3-A')
  const denial = await poll(async () => (await denialIds(a.id))[0], { timeoutMs: 10_000, label: "A's denial card" })
  const b = await handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr8f-s3-B')
  const listB = await b.as('permissions.list')
  await tabRow(a.title).click()
  const aButtons = await article(denial).getByRole('button', { name: 'Approve once', exact: true }).count()
  const bHasCard = (await denialIds(b.id)).length
  if (aButtons) await click(a.title, denial, 'Approve once')
  await sleep(8000)
  const who = { aTold: await told(a.id, '[Conductor] approved:'), bTold: await told(b.id, '[Conductor] approved:'), aRan: (await texts(a.id, 'assistant')).filter(text => text.startsWith('SYNTHETIC classified call ran:')).length, bRan: (await texts(b.id, 'assistant')).filter(text => text.startsWith('SYNTHETIC classified call ran:')).length }
  // A denial's id is per CLI process (auto-denial:classified-N), so match the tab too.
  const holder = (await grantsState()).requests.find(item => item.id === denial && (item.agentSessionId === a.id || item.agentSessionId === b.id))
  record('S3-gap1-open', who.bRan === 1 ? 'PASS' : 'FAIL', { handoffPermissions: b.result.permissions ?? null, listB: listB.requests.length, bHasCard, aButtons, ...who, holder: holder ? (holder.agentSessionId === a.id ? 'A' : 'B') + ':' + holder.status : null }, 'owner case holds only if the successor is told and runs it; else the predecessor ran it / nobody did')

  step('S3 gap 1b: the owner closes the superseded tab before answering')
  const a2 = await wizard('VR8f S3 wizard A2', 'SYNTHETIC CLASSIFIER OTHER vr8f-s3-A2')
  const denial2 = await poll(async () => (await denialIds(a2.id))[0], { timeoutMs: 10_000, label: "A2's denial card" })
  const b2 = await handOff(a2, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr8f-s3-B2')
  await call('tabs.close', { tabId: a2.tab.id })
  await sleep(4000)
  const list2 = await b2.as('permissions.list')
  const inState = (await grantsState()).requests.filter(item => item.id === denial2 && (item.agentSessionId === a2.id || item.agentSessionId === b2.id)).length
  const b2Cards = (await denialIds(b2.id)).length
  record('S3-gap1-closed', list2.requests.length || b2Cards ? 'PASS' : 'FAIL', { listB2: list2.requests.length, ownerState: inState, b2Cards }, 'after the owner closes the predecessor, is there any card left to approve and does the successor know? (FAIL = the owner-case symptom: list empty, card gone)')
}

async function s3b() {
  step('S3 gap 2 (CLI takes no live rules): A holds a session rule from launch, then hands off')
  const a = await wizard('VR8f S3b wizard A', 'SYNTHETIC CLASSIFIER PLAN HOLD vr8f-s3b-A')
  const asked = await a.as('permissions.request', { command: COMMAND, reason: 'B5 pool fix' })
  await click(a.title, asked.requestId, 'Approve for this session')
  const launchA = await poll(async () => (await flags()).find(entry => entry.launch?.includes(asked.rule)), { timeoutMs: 40_000, label: "A's CLI relaunched with the rule" })
  // The restarted CLI is a new fixture process: told to retry, it runs the call under its launch rule.
  await poll(async () => await told(a.id, '[Conductor] approved: ' + asked.rule) >= 1, { timeoutMs: 20_000, label: 'A told after its restart' })
  await settled(a.id, 'A settles')
  const aRanBefore = await ran(a.id, asked.rule)
  await rewizard(a.id)
  await poll(async () => (await a.as('app.state').catch(() => null))?.wizard === true, { timeoutMs: 15_000, label: 'A is the wizard again' })
  const b = await handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr8f-s3b-B')
  await check('S3-gap2-B-runs', async () => {
    await poll(async () => await ran(b.id, asked.rule) >= 1, { timeoutMs: 60_000, label: 'B ran it after its restart' })
    const launchB = (await flags()).filter(entry => entry.launch?.includes(asked.rule) && entry.pid !== launchA.pid).length
    record('S3-gap2-B-runs', 'PASS', { permissions: b.result.permissions ?? null, bRuns: await ran(b.id, asked.rule), launchB, bTold: await told(b.id, '[Conductor] approved: ' + asked.rule) }, 'owner case: the successor restarts with the moved rule and runs it after the one approval')
  })
  await check('S3-gap2-A-keeps', async () => {
    let aTry
    try { await submit(a.id, 'SYNTHETIC CLASSIFIER OTHER vr8f-s3b-A-try', false); await settled(a.id, 'A try settles'); aTry = (await texts(a.id, 'assistant')).at(-1) ?? '' } catch (error) { aTry = 'submit refused: ' + errorText(error) }
    const aRan = await ran(a.id, asked.rule)
    const st = await grantsState()
    record('S3-gap2-A-keeps', 'INFO', { aRanBefore, aRan, aTry: aTry.slice(0, 140), grants: st.grants.map(grant => ({ holder: grant.agentSessionId === b.id ? 'B' : grant.agentSessionId === a.id ? 'A' : grant.agentSessionId, scope: grant.scope, delivery: grant.delivery })) }, "declared gap 2: the predecessor's launch rule stays until its runtime ends (aRan 1 = leak confirmed)")
  })
}
