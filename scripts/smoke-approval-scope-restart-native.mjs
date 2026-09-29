// Native-CLI counterpart of smoke-approval-scope-restart.mjs (reviewer agent_mumilb5c_0ba33es,
// 2026-09-29): with a REAL claude CLI, what does an agents.approve "session" answer outlive, next to a
// permissions.decide session grant, across the owner's app.restart?
//   W: a real Claude tab (sonnet, low effort) on Ask mode, so the CLI asks natively for each call.
//   1. W runs `node a.mjs`; the owner answers its Bash card with agents.approve scope "session". The
//      CLI offers its own session choice for some Bash calls and not for others (seen 2026-09-29: none
//      for a bare `node a.mjs`, one for `cd <project> && node a.mjs`), so the check is that
//      agents.approvals listed what agents.approve then reported, and that the repeat behaves as that
//      scope says: covered without a card for native-session, asked again for once.
//   2. W writes proof.txt; the owner answers its Write card for the session. The CLI offers its own
//      session choice here -> effectiveScope native-session; W's next write needs no card.
//   3. W calls request_permission for `node b.mjs`; the owner answers with permissions.decide
//      approve-session -> "[Conductor] approved ... retry it now" -> W runs it without a native card.
//   4. app.restart (spawn mode: Playwright loses a relaunch).
//   5. The decide grant is still listed and saved, and W's new runtime runs `node b.mjs` without a
//      card (reinstalled with --settings); W's next write asks again: the native session answer ended
//      with its runtime, as its note said.
// Real providers (CONDUCTOR_OFFLINE_TESTS unset); CONDUCTOR_TEST_USER_DATA parks the window. Costs a
// few cents of sonnet/low: gated on CONDUCTOR_REAL_CLAUDE=1.
//   CONDUCTOR_REAL_CLAUDE=1 node scripts/smoke-lock.mjs -- node scripts/smoke-approval-scope-restart-native.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, relaunched, sleep, step, watchdog } from './verify-kit.mjs'

if (process.env.CONDUCTOR_REAL_CLAUDE !== '1') { console.log('skipped: set CONDUCTOR_REAL_CLAUDE=1 (spends real Claude usage)'); process.exit(0) }
const OUTPUT = 'artifacts/verification/2026-09-29-approvals-tabs/scope-restart-native'
configure({ name: 'approval-scope-restart-native', output: OUTPUT })
watchdog(1500)
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
const TERMINAL = /^(completed|failed|interrupted|idle)$/

try {
  const inst = await launchParked({ mode: 'spawn', build, env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  await scenario(inst)
} catch (error) { await failed(error, 'scope-restart-native') }
await finish()

async function scenario(inst) {
  await openProject({ name: 'Native approval scope', files: { 'a.mjs': "console.log('a ran')\n", 'b.mjs': "console.log('b ran')\n" } })
  const tab = await openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'default', exactPermission: true, title: 'Native scope W' })
  const w = tab.resourceId
  let view = await page(inst)
  const snap = async () => view.evaluate(id => window.conductor.structured.snapshot(id), w)
  const tools = async () => (await snap()).items.filter(item => item.data.type === 'tool').map(item => ({ id: item.nativeItemId, name: item.data.name, command: item.data.input?.command, path: item.data.input?.file_path, status: item.data.status, output: String(item.data.output ?? '').trim().slice(0, 120) }))
  const userTexts = async () => (await snap()).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)
  const seen = new Set()
  /** One turn: submit, answer each new native card with onCard, wait until it settles. */
  const turn = async (label, prompt, onCard = async () => undefined, { submit = true, since } = {}) => {
    step(label)
    const before = since ?? (await call('agents.status', { agentSessionId: w })).sequence
    if (submit) await call('agents.submit', { agentSessionId: w, prompt })
    const cards = []
    let moved = false
    await poll(async () => {
      const status = await call('agents.status', { agentSessionId: w })
      moved ||= status.sequence > before && !TERMINAL.test(status.phase)
      for (const card of (await call('agents.approvals', { agentSessionId: w })).approvals ?? []) {
        if (seen.has(card.requestId)) continue
        seen.add(card.requestId)
        cards.push(card)
        card.answer = await onCard(card)
      }
      return moved && TERMINAL.test(status.phase) ? true : null
    }, { timeoutMs: 180_000, intervalMs: 1000, label })
    return cards
  }
  const last = async match => (await tools()).filter(match).at(-1)
  // The model sometimes prefixes `cd <project> &&`; the call is the same.
  const runs = file => tool => tool.name === 'Bash' && new RegExp(`(^|&& )node ${file}$`).test(tool.command ?? '')
  const bashA = runs('a\\.mjs'), bashB = runs('b\\.mjs'), write = tool => tool.name === 'Write' && /proof\.txt$/i.test(tool.path ?? '')
  const approve = (card, scope, decision = 'allow') => call('agents.approve', { agentSessionId: w, requestId: card.requestId, decision, scope, reason: 'native scope probe' })
  const cardView = card => ({ tool: card.tool, input: card.input, choices: card.choices?.map(choice => choice.id ?? choice), listed: { sessionScope: card.sessionScope, sessionClass: card.sessionClass }, answered: card.answer?.answered, effectiveScope: card.answer?.effectiveScope, sessionRule: card.answer?.sessionRule ?? null, note: card.answer?.note })
  const RUN_A = 'Use Bash to run exactly `node a.mjs` once, then reply with its output only.'
  const RUN_B = 'Use Bash to run exactly `node b.mjs` once, then reply with its output only.'
  const WRITE = word => `Use the Write tool once to write proof.txt containing exactly ${word} and a newline, then reply "done".`

  // 1. Bash: the CLI has no session choice, so "session" is truthfully "once".
  const bash = await turn('W runs node a.mjs; the owner asks agents.approve for the session', RUN_A, card => approve(card, 'session'))
  const ranA1 = await last(bashA)
  const bashScope = bash[0]?.answer?.effectiveScope
  record('bash-session-truthful', bash.length === 1 && ['native-session', 'once'].includes(bashScope) && bash[0].sessionScope === bashScope && ranA1?.status === 'completed' && /a ran/.test(ranA1.output) ? 'PASS' : 'FAIL',
    { card: bash[0] && cardView(bash[0]), ran: ranA1 }, `agents.approvals listed and agents.approve reported the same scope (${bashScope}) for the real CLI's Bash card; the call ran`)
  const bashAgain = await turn('W runs node a.mjs again', RUN_A, card => approve(card, 'once'))
  const ranA2 = await last(bashA)
  record('bash-repeat-as-reported', (bashScope === 'native-session' ? bashAgain.length === 0 : bashAgain.length === 1) && ranA2?.status === 'completed' && ranA2.id !== ranA1?.id ? 'PASS' : 'FAIL',
    { effectiveScope: bashScope, cards: bashAgain.map(cardView), ran: ranA2 }, bashScope === 'native-session' ? 'the repeat was covered without a card, as native-session said' : 'the repeat asked again, as "once" said')

  // 2. Write: the CLI's own session choice.
  const writes = await turn('W writes proof.txt; the owner answers its card for the session', WRITE('first'), card => approve(card, 'session'))
  const wrote1 = await last(write)
  const settingsAfter = (await snap()).settings
  record('write-native-session', writes.length === 1 && writes[0].sessionScope === 'native-session' && writes[0].answer?.effectiveScope === 'native-session' && wrote1?.status === 'completed' ? 'PASS' : 'FAIL',
    { card: writes[0] && cardView(writes[0]), ran: wrote1, permission: settingsAfter.permission, temporaryPermission: settingsAfter.temporaryPermission ?? null }, 'agents.approvals listed native-session and agents.approve answered with the CLI\'s own session choice; the write ran')
  const writeAgain = await turn('W writes proof.txt again', WRITE('second'), card => approve(card, 'once', 'deny'))
  const wrote2 = await last(write)
  record('write-native-session-reused', writeAgain.length === 0 && wrote2?.status === 'completed' && wrote2.id !== wrote1?.id ? 'PASS' : 'FAIL',
    { cards: writeAgain.map(cardView), ran: wrote2, file: await readFile(join(inst.projectPath, 'proof.txt'), 'utf8').catch(() => null) }, 'no card: the CLI\'s session answer covered the next write inside the same runtime')

  // 3. request_permission, answered with permissions.decide approve-session.
  const mcpCards = await turn('W files request_permission for node b.mjs', 'Call the conductor request_permission tool once with command `node b.mjs`, reason `native scope probe`, rollback `none`. Do not run the command yourself; stop after the tool answers.', card => approve(card, 'once'))
  const request = (await call('permissions.list', { agentSessionId: w })).requests.find(entry => entry.rule === 'Bash(node b.mjs)' && /^(pending|waiting)$/.test(entry.status))
  record('request-filed', request ? 'PASS' : 'FAIL', { mcpNativeCards: mcpCards.map(cardView), request: request && { id: request.id, rule: request.rule, status: request.status, class: request.class } }, 'request_permission reached Conductor and filed a card (on Ask mode the MCP call itself first asks natively)')
  if (!request) throw new Error('no permission request to decide')
  const since = (await call('agents.status', { agentSessionId: w })).sequence
  const decided = await call('permissions.decide', { agentSessionId: w, requestId: request.id, decision: 'approve-session' })
  const retryCards = await turn('the approval turn runs node b.mjs', '', card => approve(card, 'once', 'deny'), { submit: false, since })
  const ranB1 = await last(bashB)
  const told = (await userTexts()).filter(text => text.startsWith('[Conductor] approved:'))
  record('decide-session', decided.status === 'approved-session' && told.length >= 1 && retryCards.length === 0 && ranB1?.status === 'completed' && /b ran/.test(ranB1.output) ? 'PASS' : 'FAIL',
    { status: decided.status, told: told.map(text => text.slice(0, 200)), nativeCards: retryCards.map(cardView), ran: ranB1 }, 'the retry turn arrived and the CLI ran the call on the installed rule, without a native card')

  // 4. The owner's app.restart.
  const runtimeBefore = (await snap())?.runtimeId
  const firstPid = inst.credential.pid
  await call('app.restart', { force: true })
  const seconds = await relaunched(inst, firstPid, { timeoutMs: 90_000 })
  view = await page(inst)
  record('restart', 'INFO', { seconds }, 'relaunched by app.restart')
  await poll(() => call('agents.status', { agentSessionId: w }).catch(() => null), { timeoutMs: 60_000, label: 'W after the restart' })
  await sleep(5000)

  // 5. After the restart.
  const saved = JSON.parse(await readFile(join(inst.profile, 'permission-grants.json'), 'utf8').catch(() => 'null'))
  const listed = (await call('permissions.list', { agentSessionId: w })).grants.filter(grant => grant.requestId === request.id)
  record('decide-grant-survives', listed.length === 1 && listed[0].scope === 'session' && saved?.grants?.some(grant => grant.requestId === request.id && grant.scope === 'session') ? 'PASS' : 'FAIL',
    { listed: listed.map(grant => ({ rule: grant.rule, scope: grant.scope, nativeRules: grant.nativeRules, installedIn: grant.installedIn })), saved: saved?.grants?.map(grant => ({ rule: grant.rule, scope: grant.scope })) }, 'permission-grants.json kept the permissions.decide session grant and W lists it after the restart')
  const afterB = await turn('after the restart W runs node b.mjs', RUN_B, card => approve(card, 'once', 'deny'))
  const ranB2 = await last(bashB)
  const runtimeAfter = (await snap())?.runtimeId
  record('decide-grant-honoured-after-restart', afterB.length === 0 && ranB2?.status === 'completed' && ranB2.id !== ranB1?.id && runtimeAfter !== runtimeBefore ? 'PASS' : 'FAIL',
    { runtimeChanged: runtimeAfter !== runtimeBefore, nativeCards: afterB.map(cardView), ran: ranB2 }, 'the new runtime ran the decide-granted call without a card: the grant was installed again at launch')
  const settingsRestart = (await snap()).settings
  const afterWrite = await turn('after the restart W writes proof.txt', WRITE('third'), card => approve(card, 'once', 'deny'))
  record('native-session-ends', afterWrite.length >= 1 && (await last(write))?.status !== 'completed' ? 'PASS' : 'FAIL',
    { cards: afterWrite.map(cardView), last: await last(write), permissionAfterRestart: settingsRestart.permission, temporaryPermission: settingsRestart.temporaryPermission ?? null }, 'the next write asks again in the new runtime: the native session answer ended with its runtime, as its note said (denied here)')
}
