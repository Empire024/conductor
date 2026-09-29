// Feature item permission-approval-delivery-classifier, the parts the real-CLI runs could not reach
// (docs/verification/2026-09-29-approvals-residual.md):
//   1. A classifier DENIAL card, replayed from the 2026-09-28 haftheme refusal as claude 2.1.282
//      streamed it (scripts/fixtures/haftheme-denial-2026-09-28.json: system/permission_denied, then
//      the PermissionDenied hook, then the recorded tool_result). R0: the recorded command itself
//      (cd … && ssh … < file | tail) gets a card with no Approve, since no rule can ever match it.
//      R1: the same stream for the command without the cd; the owner approves once while the turn
//      still runs; Conductor interrupts it, the approval arrives as a turn of its own and the call runs.
//   3. The wizard as answerer: a wizard opens coworker W; W's turn is refused and keeps running; the
//      wizard answers W's denial card with permissions.decide; W's turn is interrupted ("A wizard tab
//      approved …"), the approval reaches W as its own turn and the call runs.
//   4. Reconnect without a restart: a pending denial card survives a renderer reload and a runtime
//      respawn (structured.resume: a new CLI process on the same native conversation) and its
//      approval then reaches the new runtime; the session grant is handed to the next respawned
//      runtime with --settings and is still listed after another reload.
// Real Electron main/preload/renderer, parked; only the Claude process is scripts/fixtures/fake-claude.mjs
// (CONDUCTOR_TEST_CLASSIFIER=approval-turn, as 2.1.282 behaved on 2026-09-28), so nothing executes.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-approvals-residual.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js); the fixture
// folder is always this checkout's scripts/fixtures.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BUILD, REPO, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'
import { WIZARD_MODEL, grantHandoff, handoffEnv } from './lib/grant-handoff.mjs'

const OUTPUT = 'artifacts/verification/2026-09-29-approvals-residual'
configure({ name: 'approvals-residual', output: OUTPUT })
watchdog(900)
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['1', '3', '4']
const recorded = JSON.parse(await readFile(resolve(REPO, 'scripts/fixtures/haftheme-denial-2026-09-28.json'), 'utf8'))
const { capture, flagLog, env } = await handoffEnv('approvals-residual', {
  CONDUCTOR_TEST_CLASSIFIER: 'approval-turn', CONDUCTOR_TEST_BUSY_MS: '90000', CONDUCTOR_TEST_UNIQUE_TOOL_IDS: '1',
  CONDUCTOR_TEST_FIXTURE_DIR: resolve(REPO, 'scripts/fixtures')
})
const FIX_RULE = `Bash(${recorded.correctedCommand})`
const files = { 'app/prod/fix-pool.sh': 'echo pool\n' }

try {
  const inst = await launchParked({ mode: 'spawn', build, env })
  await openProject({ name: 'Approvals residual', files })
  const view = await page(inst)
  const g = grantHandoff(view, { capture, flagLog, artifacts: OUTPUT })
  const k = kit(view, g)
  if (parts.includes('1')) await part1(k)
  if (parts.includes('3')) await part3(k)
  if (parts.includes('4')) await part4(k)
} catch (error) { await failed(error, 'approvals-residual') }
await finish()

function kit(view, g) {
  const phase = async id => (await g.snap(id))?.phase
  const runtime = async id => (await g.snap(id))?.runtimeId
  const denials = async id => (await g.items(id)).filter(item => item.data.type === 'notice' && item.data.payload?.autoModeDenial)
  const systemNotices = async id => (await g.items(id)).filter(item => item.data.type === 'notice' && item.data.payload?.subtype === 'permission_denied').length
  const notices = async (id, pattern) => (await g.items(id)).filter(item => item.data.type === 'notice' && pattern.test(item.data.text ?? item.data.message ?? '')).map(item => item.data.text ?? item.data.message)
  const open = title => openTab({ provider: 'claude', model: WIZARD_MODEL, permission: 'auto', exactPermission: true, title })
  const tabOf = (opened, title) => ({ id: opened.resourceId, tabId: opened.id, title })
  const ownerList = id => call('permissions.list', { agentSessionId: id })
  const buttons = async (tab, itemId) => (await g.cardView(tab, itemId)).buttons
  /** The whole card as the owner sees it: every button's name, its grant status and its full text. */
  const cardFull = async (tab, itemId) => {
    await g.show(tab)
    const card = g.article(itemId)
    await card.waitFor({ timeout: 5000 }).catch(() => undefined)
    return { names: await card.getByRole('button').allInnerTexts().catch(() => []), status: await card.locator('.sa-grant-card').getAttribute('data-grant-status').catch(() => null), text: (await card.innerText().catch(() => '')).replace(/\s+/g, ' ') }
  }
  /** Waits for the card after the approval: interrupt notice, the approval turn, the call ran. */
  const delivered = async (id, by, since) => {
    const interrupted = await poll(async () => (await notices(id, new RegExp(`^${by} approved .*, so Conductor interrupted the running turn; the retry runs now as a message of its own\\.$`))).at(0) ?? null, { timeoutMs: 15_000, intervalMs: 250, label: 'interrupt notice' }).catch(() => null)
    const noticeMs = Date.now() - since
    const told = await poll(async () => (await g.texts(id, 'user')).find(text => text.startsWith('[Conductor] approved:')) ?? null, { timeoutMs: 30_000, intervalMs: 250, label: 'approval turn' }).catch(() => null)
    const toldMs = Date.now() - since
    const ran = await poll(async () => (await g.ran(id, FIX_RULE)) > 0 || null, { timeoutMs: 30_000, intervalMs: 250, label: 'the approved call runs' }).catch(() => null)
    const ranMs = Date.now() - since
    return { interrupted, noticeMs, told: told?.slice(0, 260), toldMs, ran: Boolean(ran), ranMs }
  }
  return { ...g, phase, runtime, denials, systemNotices, notices, open, tabOf, ownerList, buttons, cardFull, delivered }
}

async function part1(k) {
  step('1/R0 the recorded 2026-09-28 command: a denial card with no rule to grant')
  const a = k.tabOf(await k.open('Residual R0'), 'Residual R0')
  await k.submit(a.id, 'SYNTHETIC CLASSIFIER REPLAY r0', false)
  const [raw] = await poll(async () => { const list = await k.denials(a.id); return list.length ? list : null }, { timeoutMs: 30_000, label: 'R0 denial card' })
  await k.settled(a.id, 'R0 settles')
  const request = raw.data.payload.autoModeDenial.request
  const rawCard = await k.cardFull(a, raw.nativeItemId)
  const approveButtons = rawCard.names.filter(name => /^Approve/.test(name.trim())).length
  await shot('r0-card')
  record('1-r0-no-rule-card', (await k.denials(a.id)).length === 1 && !request.rule && /changes directory \(cd\)/.test(request.refusal ?? '') && approveButtons === 0 && rawCard.names.some(name => name.trim() === 'Deny') && request.category === 'Production Reads' ? 'PASS' : 'FAIL',
    { command: request.resource, category: request.category, class: request.class, rule: request.rule ?? null, refusal: request.refusal, buttons: rawCard.names, cardText: rawCard.text.slice(0, 900), systemPermissionDeniedNotices: await k.systemNotices(a.id), denialItems: (await k.denials(a.id)).length },
    'the replayed 2026-09-28 stream (system/permission_denied, PermissionDenied hook, recorded tool_result) makes exactly one card; the recorded command (cd … && … < file) gets no Approve, with the reason and the form to ask again')

  step('1/R1 the corrected command, refused mid-turn; the owner approves once while the turn still runs')
  const b = k.tabOf(await k.open('Residual R1'), 'Residual R1')
  await k.submit(b.id, 'SYNTHETIC CLASSIFIER BUSY REPLAYFIX r1', false)
  const [denial] = await poll(async () => { const list = await k.denials(b.id); return list.length ? list : null }, { timeoutMs: 30_000, label: 'R1 denial card' })
  const rule = denial.data.payload.autoModeDenial.request.rule
  const phaseAt = await k.phase(b.id)
  const since = Date.now()
  await k.click(b, denial.nativeItemId, 'Approve once')
  const got = await k.delivered(b.id, 'The owner', since)
  await k.settled(b.id, 'R1 settles', 60_000)
  const card = await k.cardFull(b, denial.nativeItemId)
  const flags = await k.flags()
  await shot('r1-after')
  record('1-r1-denial-approved-mid-turn', phaseAt === 'running' && rule === FIX_RULE && got.interrupted && got.told && got.ran && got.ranMs < 30_000 && card.status === 'used' && /Action succeeded/.test(card.text) ? 'PASS' : 'FAIL',
    { rule, phaseAtApproval: phaseAt, ...got, cardStatus: card.status, cardText: card.text.slice(-500), systemPermissionDeniedNotices: await k.systemNotices(b.id), appliedRules: flags.filter(entry => entry.applied?.includes(FIX_RULE)).length },
    'the replayed denial card, approved once while the refused turn kept running (90 s busy): Conductor interrupted the turn, the approval arrived as a turn of its own and the exact call ran; the card reads Action succeeded')
}

async function part3(k) {
  step('3 the wizard answers its coworker\'s denial card while the coworker\'s turn runs')
  const wz = await k.wizard('Residual wizard', 'SYNTHETIC CLASSIFIER LOCAL reswz')
  const opened = await wz.as('tabs.open', { kind: 'agent', provider: 'claude', model: WIZARD_MODEL, title: 'Residual coworker W', permission: 'auto' })
  const w = k.tabOf(opened, 'Residual coworker W')
  await poll(() => call('agents.status', { agentSessionId: w.id }), { timeoutMs: 30_000, label: 'W mounted' })
  await k.submit(w.id, 'SYNTHETIC CLASSIFIER BUSY REPLAYFIX w1', false)
  await poll(async () => (await k.denials(w.id)).length || null, { timeoutMs: 30_000, label: 'W denial card' })
  const listed = await poll(async () => (await wz.as('permissions.list', { agentSessionId: w.id })).requests?.find(entry => entry.rule === FIX_RULE && entry.status === 'pending') ?? null, { timeoutMs: 15_000, label: 'the wizard sees W\'s request' })
  const phaseAt = await k.phase(w.id)
  const since = Date.now()
  const decided = await wz.as('permissions.decide', { agentSessionId: w.id, requestId: listed.id, decision: 'approve-once' })
  const got = await k.delivered(w.id, 'A wizard tab', since)
  await k.settled(w.id, 'W settles', 60_000)
  const told = (await k.texts(w.id, 'user')).find(text => text.startsWith('[Conductor] approved:')) ?? ''
  const card = await k.cardView(w, `auto-denial:${(await k.denials(w.id))[0].data.payload.autoModeDenial.toolUseId}`)
  await shot('w-after')
  record('3-wizard-answers-running-coworker', phaseAt === 'running' && decided.status === 'approved-once' && got.interrupted && got.ran && got.ranMs < 30_000 && /approved by a wizard tab/.test(told) ? 'PASS' : 'FAIL',
    { request: { id: listed.id, rule: listed.rule, class: listed.class }, phaseAtDecision: phaseAt, decided: decided.status, ...got, toldEnds: told.slice(-160), cardText: card.text },
    'the wizard answered W\'s denial card over app control while W\'s turn ran: W\'s turn was interrupted ("A wizard tab approved …"), the approval reached W as a turn of its own naming the wizard, and W ran exactly the call')
}

async function part4(k) {
  step('4a a pending denial card survives a renderer reload and a runtime respawn; its approval reaches the new runtime')
  const r = k.tabOf(await k.open('Residual R'), 'Residual R')
  await k.submit(r.id, 'SYNTHETIC CLASSIFIER REPLAYFIX rr1', false)
  const [denial] = await poll(async () => { const list = await k.denials(r.id); return list.length ? list : null }, { timeoutMs: 30_000, label: 'R denial card' })
  await k.settled(r.id, 'R settles')
  const runtime0 = await k.runtime(r.id)
  const view = await page()
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.permissionGrants))
  await sleep(1500)
  const afterReload = await k.buttons(r, denial.nativeItemId)
  await view.evaluate(id => window.conductor.structured.resume(id), r.id)
  const runtime1 = await poll(async () => { const now = await k.runtime(r.id); return now && now !== runtime0 ? now : null }, { timeoutMs: 30_000, label: 'a new runtime' }).catch(() => null)
  await sleep(1000)
  const afterRespawn = await k.buttons(r, denial.nativeItemId)
  const since = Date.now()
  await k.click(r, denial.nativeItemId, 'Approve for this session')
  const told = await poll(async () => (await k.texts(r.id, 'user')).find(text => text.startsWith('[Conductor] approved:')) ?? null, { timeoutMs: 30_000, label: 'R approval turn' }).catch(() => null)
  const ran = await poll(async () => (await k.ran(r.id, FIX_RULE)) > 0 || null, { timeoutMs: 30_000, label: 'R call runs' }).catch(() => null)
  const ranMs = Date.now() - since
  await k.settled(r.id, 'R settles after the approval')
  const runtimeAtRun = await k.runtime(r.id)
  await shot('r4a-after')
  record('4a-card-survives-reload-and-respawn', afterReload === 3 && runtime1 && afterRespawn === 3 && told && ran && runtimeAtRun === runtime1 ? 'PASS' : 'FAIL',
    { runtime0, runtime1, runtimeAtRun, buttonsAfterReload: afterReload, buttonsAfterRespawn: afterRespawn, told: told?.slice(0, 200), ran: Boolean(ran), ranMs },
    'the refused call\'s card kept Approve once / Approve for this session / Deny after a renderer reload and after structured.resume replaced the CLI (new runtimeId, same native conversation); Approve for this session then reached the new runtime as its own turn and the call ran')

  step('4b the session grant is handed to the next respawned runtime with --settings and is still listed after a reload')
  const before = (await k.ownerList(r.id)).grants.filter(grant => grant.rule === FIX_RULE)
  const launchesBefore = (await k.flags()).filter(entry => entry.launch).length
  await view.evaluate(id => window.conductor.structured.resume(id), r.id)
  const runtime2 = await poll(async () => { const now = await k.runtime(r.id); return now && now !== runtimeAtRun ? now : null }, { timeoutMs: 30_000, label: 'another new runtime' }).catch(() => null)
  const launch = await poll(async () => (await k.flags()).filter(entry => entry.launch).slice(launchesBefore).find(entry => entry.launch.includes(FIX_RULE)) ?? null, { timeoutMs: 20_000, label: 'the respawned CLI starts with the rule' }).catch(() => null)
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor?.permissionGrants))
  await sleep(1500)
  const after = (await k.ownerList(r.id)).grants.filter(grant => grant.rule === FIX_RULE)
  const card = await k.cardView(r, denial.nativeItemId)
  await shot('r4b-after')
  record('4b-session-grant-survives-respawn', before.length === 1 && before[0].scope === 'session' && runtime2 && launch && after.length === 1 && after[0].scope === 'session' ? 'PASS' : 'FAIL',
    { before: before.map(grant => ({ scope: grant.scope, nativeRules: grant.nativeRules, installedIn: grant.installedIn })), runtime2, launchRules: launch?.launch, launchPid: launch?.pid, after: after.map(grant => ({ scope: grant.scope, nativeRules: grant.nativeRules, installedIn: grant.installedIn })), cardText: card.text },
    'without an app restart, the respawned CLI process was launched with the session grant\'s exact rules (--settings), and after a further renderer reload the grant is still listed for the conversation')
}
