// VR9b grant-survives-handoff (FX38 d85e749 + 9e20e27, FX41 f565bad), the verifier's own scenarios.
// Owner's case 2026-09-26: the haftheme wizard filed permissions.request (B5, class external), handed
// off with agents.handoff({successor:true}); the successor found permissions.list empty and the
// owner's card gone. One approval must reach the conversation that carries on, and it runs it once.
// Tool ids are unique per CLI process here (CONDUCTOR_TEST_UNIQUE_TOOL_IDS), as the real CLI's are, so
// a successor that hits the same denial takes the path a real one takes (FX41's smoke reused ids).
//   --group v1  the owner's case in its real order: A is denied the B5 call, then files
//               permissions.request for it; A hands off, the owner closes A, B retries it itself,
//               one Approve once in B
//   --group v2  a denial card unanswered at handoff through A -> B -> C, with B and the superseded A
//               hitting the same denial again; C closed without a successor
//   --group v3  gap 2 with a CLI that takes no live rules: a denial approved for the session after
//               the handoff (a), and before it (b)
// Run from a worktree whose out/ is the build under test; --out names the results folder.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9b-handoff.mjs --group v1 --label head-r1 --out <dir>
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'
import { B5_COMMAND, errorText, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const arg = (name, fallback) => { const at = process.argv.indexOf('--' + name); return at > 0 ? process.argv[at + 1] : fallback }
const group = arg('group', 'v1'), label = arg('label', 'head')
configure({ name: `vr9b-${group}-${label}`, output: join(arg('out', 'artifacts/verification/2026-09-26-vr9b'), `${group}-${label}`) })
watchdog(540)
const side = await handoffEnv('vr9b', { CONDUCTOR_TEST_UNIQUE_TOOL_IDS: '1', ...(group === 'v3' ? { CONDUCTOR_TEST_FLAG_SETTINGS_UNSUPPORTED: '1' } : {}) })
/** A check that records FAIL with its error instead of ending the run (a pre-fix build fails early). */
const check = async (id, work) => { try { await work() } catch (error) { record(id, 'FAIL', { error: errorText(error) }, 'check threw') } }
const ok = value => value ? 'PASS' : 'FAIL'
let h
const pendingOf = async ids => (await h.grantsState()).requests.filter(item => item.status === 'pending' && ids.includes(item.agentSessionId))
const newCard = async (id, before) => poll(async () => (await h.denialCards(id)).find(item => !before.includes(item)), { timeoutMs: 10_000, label: 'a new denial card' })
const who = async tabs => Object.fromEntries(await Promise.all(Object.entries(tabs).flatMap(([name, tab]) => [
  h.told(tab.id).then(count => [name + 'Told', count]).catch(() => [name + 'Told', 'gone']),
  h.ran(tab.id).then(count => [name + 'Ran', count]).catch(() => [name + 'Ran', 'gone'])
])))

try {
  await loadCheck()
  await launchParked({ env: side.env })
  h = grantHandoff(await page(), { ...side, artifacts: 'artifacts/verification/2026-09-26-vr9b' })
  await openProject({ name: `VR9b ${group}` })
  if (group === 'v1') await v1()
  else if (group === 'v2') await v2()
  else if (group === 'v3') await v3()
  else throw new Error('unknown group ' + group)
} catch (error) { await failed(error, `${group}-error`) }
await finish()

async function v1() {
  step("V1: A's classifier denies the B5 call; A then files permissions.request for the same call")
  const a = await h.wizard('VR9b V1 wizard A', 'SYNTHETIC CLASSIFIER OTHER vr9b-v1-A')
  const x = await poll(async () => (await h.denialCards(a.id))[0], { timeoutMs: 10_000, label: "A's denial card" })
  const asked = await a.as('permissions.request', { command: B5_COMMAND, reason: 'B5 lsphp pool fix (stand-in for grant:51bfd32e)', rollback: 'none: the fixture never runs it' })
  const listA = (await a.as('permissions.list')).requests.filter(item => item.status === 'pending')
  record('V1-one-ask', ok(asked.requestId === x && asked.class === 'external' && listA.length === 1), { denial: x, asked: asked.requestId, class: asked.class, pendingA: listA.length }, 'the agent asking for a call its classifier already refused is the same one request, not a second card')

  step('V1: A hands off; B reads permissions.list the instant its CLI has its prompt')
  const b = await h.handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr9b-v1-B', { onPrompt: as => as('permissions.list') })
  const target = asked.requestId
  await check('V1-B-holds', async () => {
    const entry = (await b.as('permissions.list')).requests.find(item => item.id === target)
    const pending = await pendingOf([a.id, b.id])
    const firstIds = b.atPrompt?.requests?.map(item => item.id) ?? b.atPrompt
    record('V1-B-holds', ok(Array.isArray(firstIds) && firstIds.includes(target) && b.result.permissions?.requests === 1 && entry?.status === 'pending' && entry.holder?.agentSessionId === b.id && pending.length === 1 && pending[0].agentSessionId === b.id), { atPrompt: firstIds, handoff: b.result.permissions ?? null, entry: entry ? `${entry.status}>${entry.holder?.title}` : null, pending: pending.map(item => `${item.id === target ? 'target' : item.id}@${item.agentSessionId === b.id ? 'B' : 'A'}`) }, "B's list holds it from its first prompt; the owner's state names B as the one holder")
  })
  await check('V1-cards', async () => {
    const aViews = await Promise.all([...new Set([x, target])].map(id => h.cardView(a, id)))
    const aShot = await shot('v1-a-cards')
    const bView = await h.cardView(b, target)
    const bShot = await shot('v1-b-card')
    const holder = h.holderLabel(b)
    record('V1-cards', ok(aViews.every(view => view.buttons === 0) && /Moved to/.test(aViews[0].text) && aViews[0].text.includes(holder) && bView.buttons > 0 && /Holder/.test(bView.text) && bView.text.includes(holder)), { aButtons: aViews.map(view => view.buttons), a: aViews[0].text.slice(0, 200), bButtons: bView.buttons, b: bView.text.slice(0, 200) }, `${aShot}, ${bShot}`)
  })

  step('V1: the owner closes the superseded A; B retries the call itself before the owner answers')
  await call('tabs.close', { tabId: a.tabId })
  await sleep(5000)
  await check('V1-after-close', async () => {
    const pending = await pendingOf([a.id, b.id])
    record('V1-after-close', ok(pending.length === 1 && pending[0].id === target && pending[0].agentSessionId === b.id), { pending: pending.map(item => `${item.agentSessionId === b.id ? 'B' : 'A'}:${item.status}`) }, 'closing the predecessor (5 s) leaves the one request pending on B')
  })
  let y
  await check('V1-rehit', async () => {
    const before = await h.denialCards(b.id)
    await h.submit(b.id, 'SYNTHETIC CLASSIFIER RETRY vr9b-v1-B-rehit', false)
    await h.settled(b.id, 'B re-hit settles')
    y = await newCard(b.id, before)
    await sleep(1500)
    const pending = await pendingOf([a.id, b.id])
    const yView = await h.cardView(b, y)
    record('V1-rehit', ok(pending.length === 1 && pending[0].id === target), { y, pending: pending.length, yButtons: yView.buttons, yText: yView.text.slice(0, 200) }, "B's own refusal of the same call is a view of the moved request, not a second request")
  })

  step('V1: one Approve once in B')
  await check('V1-approve', async () => {
    const via = y && (await h.cardView(b, y)).buttons ? y : target
    await h.click(b, via, 'Approve once')
    await poll(async () => await h.ran(b.id) >= 1, { timeoutMs: 20_000, label: 'B ran it' }).catch(() => undefined)
    await sleep(3000)
    await h.settled(b.id, 'B settles after the retry')
    const spent = (await h.grantsState()).requests.find(item => item.id === target)
    const views = { x: (await h.cardView(b, target)).buttons, y: y ? (await h.cardView(b, y)).buttons : null }
    const shotB = await shot('v1-b-after')
    const tally = await who({ a, b })
    record('V1-approve', ok(tally.bTold === 1 && tally.bRan === 1 && spent?.status === 'used' && spent.agentSessionId === b.id && views.x === 0 && !views.y), { via: via === y ? 'rehit card' : 'moved card', ...tally, status: spent?.status ?? null, liveButtonsAfter: views }, `${shotB}; one click: B told once, runs once, the approve-once is spent, no card left asking`)
    const rule = spent?.rule ?? asked.rule
    await h.submit(b.id, `[Conductor] approved: ${rule} (once); retry it now.`, false)
    await h.settled(b.id, 'B second retry settles')
    const last = (await h.texts(b.id, 'assistant')).at(-1) ?? ''
    record('V1-once', ok(await h.ran(b.id) === 1 && /SYNTHETIC classifier refused Bash/.test(last)), { runs: await h.ran(b.id), last: last.slice(0, 140) }, 'a second retry is refused: consumed exactly once')
  })
}

async function v2() {
  step("V2: A's classifier denial is unanswered at A -> B")
  const a = await h.wizard('VR9b V2 wizard A', 'SYNTHETIC CLASSIFIER OTHER vr9b-v2-A')
  const x = await poll(async () => (await h.denialCards(a.id))[0], { timeoutMs: 10_000, label: "A's denial card" })
  const b = await h.handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr9b-v2-B')
  await check('V2-moved', async () => {
    const entry = (await b.as('permissions.list')).requests.find(item => item.id === x)
    const aX = await h.cardView(a, x), bX = await h.cardView(b, x)
    record('V2-moved', ok(b.result.permissions?.requests === 1 && entry?.status === 'pending' && entry.holder?.agentSessionId === b.id && aX.buttons === 0 && /Moved to/.test(aX.text) && bX.buttons > 0), { handoff: b.result.permissions ?? null, entry: entry ? `${entry.status}>${entry.holder?.title}` : null, aButtons: aX.buttons, bButtons: bX.buttons, a: aX.text.slice(0, 160) }, 'the unanswered denial card moved to B')
  })

  step('V2: B hits the same denial itself; the superseded A hits it too')
  let y, z
  await check('V2-rehits', async () => {
    const beforeB = await h.denialCards(b.id)
    await h.submit(b.id, 'SYNTHETIC CLASSIFIER RETRY vr9b-v2-B-rehit', false)
    await h.settled(b.id, 'B re-hit settles')
    y = await newCard(b.id, beforeB)
    let aTry = 'ran'
    try {
      const beforeA = await h.denialCards(a.id)
      await h.submit(a.id, 'SYNTHETIC CLASSIFIER RETRY vr9b-v2-A-late', false)
      await h.settled(a.id, 'A late re-hit settles')
      z = await newCard(a.id, beforeA)
    } catch (error) { aTry = 'refused: ' + errorText(error).slice(0, 120) }
    await sleep(1500)
    const pending = await pendingOf([a.id, b.id])
    const yView = await h.cardView(b, y), zView = z ? await h.cardView(a, z) : null
    record('V2-rehits', ok(pending.length === 1 && pending[0].id === x && pending[0].agentSessionId === b.id && (!z || zView.buttons === 0)), { pending: pending.map(item => `${item.id === x ? 'x' : item.id}@${item.agentSessionId === b.id ? 'B' : 'A'}`), yButtons: yView.buttons, yText: yView.text.slice(0, 160), aTry, zButtons: zView?.buttons ?? null, zText: zView?.text.slice(0, 160) ?? null }, 'still one request, held by B; A re-hitting it gets no live card of its own')
  })

  step('V2: B -> C')
  await h.wizardAgain(b)
  const c = await h.handOff(b, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr9b-v2-C')
  await check('V2-B-to-C', async () => {
    const listC = (await c.as('permissions.list')).requests.filter(item => item.status === 'pending')
    const bX = await h.cardView(b, x), bY = y ? await h.cardView(b, y) : null, aX = await h.cardView(a, x)
    const cX = await h.cardView(c, x)
    const shotC = await shot('v2-c-card')
    const pending = await pendingOf([a.id, b.id, c.id])
    record('V2-B-to-C', ok(c.result.permissions?.requests === 1 && listC.length === 1 && listC[0].id === x && listC[0].holder?.agentSessionId === c.id && pending.length === 1 && bX.buttons === 0 && (!bY || bY.buttons === 0) && aX.buttons === 0 && /Moved to/.test(bX.text) && bX.text.includes(h.holderLabel(c)) && cX.buttons > 0), { handoff: c.result.permissions ?? null, listC: listC.map(item => `${item.id === x ? 'x' : item.id}>${item.holder?.title}`), pending: pending.length, buttons: { aX: aX.buttons, bX: bX.buttons, bY: bY?.buttons ?? null, cX: cX.buttons }, bX: bX.text.slice(0, 160) }, `${shotC}; one request walks on to C; every older view names where it went and asks nothing`)
  })

  step('V2: one Approve once in C')
  await check('V2-approve-in-C', async () => {
    await h.click(c, x, 'Approve once')
    await poll(async () => await h.ran(c.id) >= 1, { timeoutMs: 20_000, label: 'C ran it' }).catch(() => undefined)
    await sleep(4000)
    const spent = (await h.grantsState()).requests.find(item => item.id === x)
    const tally = await who({ a, b, c })
    record('V2-approve-in-C', ok(tally.cTold === 1 && tally.cRan === 1 && tally.aTold === 0 && tally.aRan === 0 && tally.bTold === 0 && tally.bRan === 0 && spent?.status === 'used' && spent.agentSessionId === c.id), { ...tally, status: spent?.status ?? null }, 'two hops on, the approval reaches C only and C runs it once')
  })

  step('V2: C is denied another call and is closed without a successor')
  await check('V2-close-expires', async () => {
    const before = await h.denialCards(c.id)
    await h.settled(c.id, 'C settles')
    await h.submit(c.id, 'SYNTHETIC CLASSIFIER WRITE vr9b-v2-C-write', false)
    await h.settled(c.id, 'C write settles')
    const w = await newCard(c.id, before)
    const was = (await h.grantsState()).requests.find(item => item.id === w)
    await call('tabs.close', { tabId: c.tabId })
    await poll(async () => !(await h.grantsState()).requests.some(item => item.id === w), { timeoutMs: 15_000, label: "C's request withdrawn" }).catch(() => undefined)
    const card = await h.notice(c.id, w).catch(() => null)
    const left = await pendingOf([a.id, b.id, c.id])
    record('V2-close-expires', ok(was?.status === 'pending' && !(await h.grantsState()).requests.some(item => item.id === w) && card?.payload?.grantStatus === 'expired' && left.length === 0), { before: was?.status ?? null, card: card?.payload?.grantStatus ?? null, left: left.length }, 'closed without a successor: the owner state drops it and its card turns Expired')
  })
}

async function v3() {
  step('V3a (CLI takes no live rules): a denial unanswered at A -> B, approved for this session in B')
  const a = await h.wizard('VR9b V3a wizard A', 'SYNTHETIC CLASSIFIER OTHER vr9b-v3a-A')
  const x = await poll(async () => (await h.denialCards(a.id))[0], { timeoutMs: 10_000, label: "A's denial card" })
  const b = await h.handOff(a, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr9b-v3a-B')
  await check('V3a-B-runs', async () => {
    await h.click(b, x, 'Approve for this session')
    await poll(async () => await h.ran(b.id) >= 1, { timeoutMs: 60_000, label: 'B ran it after its restart' }).catch(() => undefined)
    await sleep(3000)
    const entry = (await h.grantsState()).requests.find(item => item.id === x)
    const rule = entry?.rule
    const launches = rule ? (await h.flags()).filter(line => line.launch?.includes(rule)).length : null
    const tally = await who({ a, b })
    record('V3a-B-runs', ok(tally.bRan >= 1 && tally.bTold >= 1 && tally.aRan === 0 && tally.aTold === 0 && launches === 1), { ...tally, launchesWithRule: launches, status: entry?.status ?? null, holder: entry ? (entry.agentSessionId === b.id ? 'B' : 'A') : null }, "one approval after the handoff: only B's CLI is relaunched with the rule, B runs it, A never holds it")
  })

  step('V3b: a denial approved for this session in A (A relaunches with the rule and runs it), then A -> B')
  const a2 = await h.wizard('VR9b V3b wizard A', 'SYNTHETIC CLASSIFIER OTHER vr9b-v3b-A')
  const x2 = await poll(async () => (await h.denialCards(a2.id))[0], { timeoutMs: 10_000, label: "A2's denial card" })
  await h.click(a2, x2, 'Approve for this session')
  await poll(async () => await h.ran(a2.id) >= 1, { timeoutMs: 60_000, label: 'A2 ran it after its restart' })
  await h.settled(a2.id, 'A2 settles')
  const aRanBefore = await h.ran(a2.id)
  await h.wizardAgain(a2)
  const b2 = await h.handOff(a2, 'SYNTHETIC CLASSIFIER PLAN OTHER successor vr9b-v3b-B')
  await check('V3b-B-runs', async () => {
    await poll(async () => await h.ran(b2.id) >= 1, { timeoutMs: 60_000, label: 'B2 ran it after its restart' })
    const tally = await who({ b: b2 })
    record('V3b-B-runs', ok(tally.bRan >= 1), { handoff: b2.result.permissions ?? null, ...tally }, 'owner case under gap 2: the successor runs the approved call with no second approval')
  })
  await check('V3b-A-keeps', async () => {
    let aTry
    try { await h.submit(a2.id, 'SYNTHETIC CLASSIFIER OTHER vr9b-v3b-A-try', false); await h.settled(a2.id, 'A2 try settles'); aTry = (await h.texts(a2.id, 'assistant')).at(-1) ?? '' } catch (error) { aTry = 'submit refused: ' + errorText(error) }
    const grants = (await h.grantsState()).grants.map(grant => `${grant.agentSessionId === b2.id ? 'B' : grant.agentSessionId === a2.id ? 'A' : '?'}:${grant.scope}:${grant.delivery}`)
    record('V3b-A-keeps', 'INFO', { aRanBefore, aRanAfter: await h.ran(a2.id), aTry: aTry.slice(0, 140), grants }, "declared gap 2: the superseded A's launch rule stays until its runtime ends (aRanAfter > aRanBefore = leak)")
  })
}
