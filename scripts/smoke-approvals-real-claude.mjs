// Feature item permission-approval-delivery-classifier (Haftheme controller, 2026-09-28) against a
// REAL claude CLI in Auto (sonnet, low effort) in a parked instance:
//   (a) the owner approves a card while the tab's turn is still running (the tab asked with
//       request_permission, then went on to a 60 s step): Conductor interrupts that turn at once, the
//       approval arrives as a turn of its own, and the tab runs exactly the approved call; the card
//       reads "Approved once, and used" (the PostToolUse hook spent the grant).
//   (c) request_permission for a production-shaped command is not itself refused by the classifier,
//       files a card, and an owner approval of it reaches the tab, which runs exactly that call.
// Symptom (b), a session grant beating a later classifier refusal, needs a call the classifier
// refuses on demand; 14 real attempts in four discovery rounds drew none (docs/verification/
// 2026-09-29-approvals-tabs.md), so it is not exercised here.
// Real providers (CONDUCTOR_OFFLINE_TESTS unset); CONDUCTOR_TEST_USER_DATA parks the window. Costs a
// few cents of sonnet/low: gated on CONDUCTOR_REAL_CLAUDE=1.
//   CONDUCTOR_REAL_CLAUDE=1 node scripts/smoke-lock.mjs -- node scripts/smoke-approvals-real-claude.mjs [a] [c]
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
import { resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

if (process.env.CONDUCTOR_REAL_CLAUDE !== '1') { console.log('skipped: set CONDUCTOR_REAL_CLAUDE=1 (spends real Claude usage)'); process.exit(0) }
configure({ name: 'approvals-real-claude', output: 'artifacts/verification/2026-09-29-approvals-tabs/real-claude' })
watchdog(1500)
const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'c']
const TERMINAL = /^(completed|failed|interrupted|idle)$/
// The model sometimes prefixes `cd <project> &&`; the call is the same.
const is = (tool, pattern) => new RegExp(`(^|&& )${pattern}$`).test(tool.command ?? '')
const files = {
  'c.mjs': "console.log('c ran')\n",
  'wait.mjs': "setTimeout(() => console.log('waited'), Number(process.argv[2] ?? 45) * 1000)\n",
  'prod/fix-pool.sh': 'echo pool\n'
}

try {
  const inst = await launchParked({ mode: 'spawn', build, env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  await openProject({ name: 'Real approvals', files })
  const kit = tools(await page(inst))
  if (parts.includes('a')) await partA(kit)
  if (parts.includes('c')) await partC(kit)
} catch (error) { await failed(error, 'approvals-real-claude') }
await finish()

function tools(view) {
  const snap = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
  const items = async id => (await snap(id))?.items ?? []
  const toolCalls = async id => (await items(id)).filter(item => item.data.type === 'tool').map(item => ({ id: item.nativeItemId, name: item.data.name, command: item.data.input?.command, status: item.data.status, output: String(item.data.output ?? '').trim().slice(0, 200) }))
  const denials = async id => (await items(id)).filter(item => item.data.type === 'notice' && item.data.payload?.autoModeDenial).map(item => ({ nativeItemId: item.nativeItemId, rule: item.data.payload.autoModeDenial.request?.rule }))
  const notices = async (id, pattern) => (await items(id)).filter(item => item.data.type === 'notice' && pattern.test(item.data.text ?? item.data.message ?? '')).map(item => item.data.text ?? item.data.message)
  const users = async id => (await items(id)).filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)
  const status = id => call('agents.status', { agentSessionId: id })
  const open = title => openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'auto', exactPermission: true, title })
  const settled = (id, label, timeoutMs = 180_000) => poll(async () => TERMINAL.test((await status(id)).phase) || null, { timeoutMs, intervalMs: 1000, label })
  const started = (id, since, label) => poll(async () => { const now = await status(id); return now.sequence > since && !TERMINAL.test(now.phase) || null }, { timeoutMs: 60_000, intervalMs: 500, label }).catch(() => undefined)
  const request = async (id, pattern) => (await call('permissions.list', { agentSessionId: id })).requests.find(entry => pattern.test(entry.rule ?? ''))
  const card = requestId => view.locator(`article[data-native-item-id="${requestId}"]`)
  const click = async (tabId, requestId, name) => {
    await call('tabs.focus', { tabId })
    await sleep(700)
    const button = card(requestId).getByRole('button', { name, exact: true })
    await button.waitFor({ timeout: 15_000 })
    await button.click()
  }
  return { snap, toolCalls, denials, notices, users, status, open, settled, started, request, card, click }
}

async function partA(k) {
  step('(a) the owner approves while the turn is still running')
  const tab = await k.open('Approvals A')
  const id = tab.resourceId
  await call('agents.submit', { agentSessionId: id, prompt: 'Two steps. 1) Call the conductor request_permission tool once with command `node c.mjs`, reason `approval delivery probe`, rollback `none`. 2) Without waiting for an answer, run `node wait.mjs 60` with Bash in the foreground (not in the background) and wait for it to finish. Then reply with one short sentence.' })
  const asked = await poll(() => k.request(id, /^Bash\(node c\.mjs\)$/), { timeoutMs: 120_000, intervalMs: 500, label: '(a) request filed' })
  const busy = await poll(async () => (await k.toolCalls(id)).find(entry => is(entry, 'node wait\\.mjs 60') && ['preparing', 'running'].includes(entry.status)) ?? null, { timeoutMs: 90_000, intervalMs: 500, label: '(a) the turn runs node wait.mjs 60' })
  const phaseAtApproval = (await k.status(id)).phase
  const clicked = Date.now()
  await k.click(tab.id, asked.id, 'Approve once')
  const interrupted = await poll(async () => (await k.notices(id, /so Conductor interrupted the running turn/)).at(0) ?? null, { timeoutMs: 20_000, intervalMs: 250, label: '(a) interrupt notice' }).catch(() => null)
  const noticeMs = Date.now() - clicked
  const told = await poll(async () => (await k.users(id)).find(text => text.startsWith('[Conductor] approved:')) ?? null, { timeoutMs: 30_000, intervalMs: 250, label: '(a) approval turn' }).catch(() => null)
  const toldMs = Date.now() - clicked
  const ran = await poll(async () => (await k.toolCalls(id)).find(entry => entry.name === 'Bash' && is(entry, 'node c\\.mjs') && entry.status === 'completed') ?? null, { timeoutMs: 90_000, intervalMs: 500, label: '(a) the approved call runs' }).catch(() => null)
  const ranMs = Date.now() - clicked
  await k.settled(id, '(a) settles')
  const wait = (await k.toolCalls(id)).find(entry => entry.id === busy.id)
  const cardText = (await k.card(asked.id).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
  await shot('a-after')
  record('a-approval-delivered', phaseAtApproval === 'running' && interrupted && told && ran && /c ran/.test(ran.output) && ranMs < 60_000 && wait?.status !== 'completed' && /Approved once, and used/.test(cardText) ? 'PASS' : 'FAIL',
    { request: { id: asked.id, rule: asked.rule, class: asked.class }, phaseAtApproval, busyCall: { command: busy.command, statusAfter: wait?.status }, interrupted, noticeMs, told: told?.slice(0, 200), toldMs, ran, ranMs, cardText, denials: await k.denials(id) },
    'approved while node wait.mjs 60 ran: the turn was interrupted at once (the 60 s step never finished), the approval arrived as a turn of its own and the tab ran exactly the approved call; the card reads Approved once, and used')
}

async function partC(k) {
  step('(c) request_permission from the tab')
  const tab = await k.open('Approvals C')
  const id = tab.resourceId
  const command = "ssh -o BatchMode=yes -o ConnectTimeout=3 root@192.0.2.10 'bash -s -- --apply --yes' < prod/fix-pool.sh"
  const since0 = (await k.status(id)).sequence
  await call('agents.submit', { agentSessionId: id, prompt: `Production is root@192.0.2.10. Call the conductor request_permission tool once with command \`${command}\`, reason \`apply the pool fix on production\`, rollback \`run it again with --revert\`. Do not run the command yourself; stop after the tool answers.` })
  await k.started(id, since0, '(c) request turn starts')
  await k.settled(id, '(c) request turn')
  const mcp = (await k.toolCalls(id)).filter(entry => /request_permission/.test(entry.name))
  const asked = await k.request(id, /fix-pool/)
  const refused = await k.denials(id)
  record('c-request-filed', mcp.some(entry => entry.status === 'completed') && refused.length === 0 && asked ? 'PASS' : 'FAIL', { mcp, refused, request: asked && { id: asked.id, rule: asked.rule, status: asked.status, class: asked.class } }, 'request_permission for a production apply was not refused by the classifier and filed a card')
  if (!asked) return
  const since = (await k.status(id)).sequence
  await k.click(tab.id, asked.id, 'Approve once')
  await k.started(id, since, '(c) approval turn starts')
  await k.settled(id, '(c) approval turn settles')
  const ran = (await k.toolCalls(id)).filter(entry => entry.name === 'Bash' && (entry.command === command || entry.command?.endsWith('&& ' + command)))
  const told = (await k.users(id)).filter(text => text.startsWith('[Conductor] approved:'))
  await shot('c-after')
  record('c-approval-works', told.length === 1 && ran.length === 1 && ran[0].status !== 'rejected' && (await k.denials(id)).length === 0 ? 'PASS' : 'FAIL',
    { told: told.map(text => text.slice(0, 200)), ran, denials: await k.denials(id) }, 'the approval reached the tab and it ran exactly the approved call once, unrefused (192.0.2.10 is TEST-NET, so ssh can only time out)')
}
