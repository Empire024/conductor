// FX37 review-cost-bounded: VR8a's A3 and A4 against the real Opus reviewer, plus a risky control.
//   node scripts/smoke-lock.mjs --timeout-min 25 -- node scripts/smoke-fx37-routine-review.mjs [--runs 2]
// The harness (synthetic Claude worker on the real can_use_tool wire, wizard + Ask-mode coworker,
// reviewer log, journal reader) is scripts/smoke-verify-vr8a-approvals.mjs's, unchanged.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, safeClose, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx37-routine-review', output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-fx37' })
watchdog(19 * 60)
await loadCheck()

const claudeExe = (spawnSync('where.exe', ['claude'], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/).find(line => /claude(\.exe)?$/i.test(line.trim()))?.trim()

const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
const log = entry => appendFileSync(process.env.VR8A_REVIEWER_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + '\\n')
const reviewerArgv = process.argv.includes('--strict-mcp-config')
if (reviewerArgv && process.env.VR8A_REAL_REVIEWER) {
  // The isolated reviewer, handed to the real CLI with exactly the argv Conductor built.
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_OFFLINE_TESTS
  const child = spawn(process.env.VR8A_REAL_REVIEWER, process.argv.slice(2), { env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  log({ kind: 'spawn', argv: process.argv.slice(2) })
  child.stderr.on('data', chunk => log({ kind: 'stderr', text: String(chunk).slice(0, 500) }))
  readline.createInterface({ input: process.stdin }).on('line', line => {
    try { const m = JSON.parse(line); if (m.type === 'user') { const c = m.message.content; const p = Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('') : c; log({ kind: 'prompt', chars: p.length, reused: p.includes('The rules of your first message') }) } } catch {}
    child.stdin.write(line + '\\n')
  })
  process.stdin.on('end', () => child.stdin.end())
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try {
      const m = JSON.parse(line)
      if (m.type === 'system' && m.subtype === 'init') log({ kind: 'init', model: m.model })
      if (m.type === 'assistant') log({ kind: 'assistant', model: m.message?.model, text: (m.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 400) })
      if (m.type === 'result') log({ kind: 'result', is_error: m.is_error, subtype: m.subtype, text: String(m.result ?? '').slice(0, 400), usage: m.usage, cost: m.total_cost_usd })
    } catch {}
    process.stdout.write(line + '\\n')
  })
  child.on('exit', code => { log({ kind: 'exit', code }); process.exit(code ?? 0) })
} else {
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = 'vr8a-' + process.pid
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'claude-fable-5-1'
const text = content => { const id = randomUUID(); emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } }); emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } }); emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }); emit({ type: 'stream_event', event: { type: 'message_stop' } }); emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: content }] } }) }
const finish = usage => emit({ type: 'result', subtype: 'success', is_error: false, usage: usage ?? {} })
let pending, turn = 0
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'opus', displayName: 'Opus' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type === 'control_response') {
    const answer = message.response?.response ?? {}
    if (!pending || message.response?.request_id !== pending.request) return
    const allowed = answer.behavior === 'allow'
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: pending.tool, content: allowed ? 'SYNTHETIC ran' : 'SYNTHETIC denied: ' + (answer.message ?? ''), is_error: !allowed }] } })
    text(allowed ? 'SYNTHETIC ask allowed' : 'SYNTHETIC ask denied')
    pending = undefined; finish(); return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (typeof prompt !== 'string') return
  if (prompt.includes('Conductor app control:')) writeFileSync(process.env.VR8A_CAPTURE, prompt)
  if (reviewerArgv || prompt.startsWith('You are an isolated approval reviewer')) {
    const digest = /"digest":"([0-9a-f]+)"/.exec(prompt)?.[1]
    let action = {}; try { action = JSON.parse(prompt.split('Exact host-bound action:').at(-1).trim()) } catch {}
    const decision = String(action.arguments?.command ?? '').includes('ESCALATE-ME') ? 'escalate' : 'allow'
    log({ kind: 'prompt', chars: prompt.length, reused: prompt.includes('The rules of your first message'), decision })
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'default' })
    text(JSON.stringify({ digest, decision, rationale: 'SYNTHETIC reviewer ' + decision }))
    return finish({ input_tokens: Math.ceil(prompt.length / 4), output_tokens: 40 })
  }
  emit({ type: 'system', subtype: 'init', model, permissionMode: 'default' })
  const ask = /^SYNTHETIC ASK (.+)/s.exec(prompt.split('\\n\\n', 1)[0])
  if (ask) {
    turn++
    const body = ask[1].trim()
    const { tool, input } = body.startsWith('{') ? JSON.parse(body) : { tool: 'Bash', input: { command: body } }
    pending = { request: 'ask-' + turn, tool: 'toolu_vr8a_' + process.pid + '_' + turn }
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: pending.tool, name: tool, input }] } })
    send({ type: 'control_request', request_id: pending.request, request: { subtype: 'can_use_tool', tool_use_id: pending.tool, tool_name: tool, input, permission_suggestions: [] } })
    return
  }
  text('Short done.'); finish()
})
}
`

const snapshot = async id => (await page()).evaluate(value => window.conductor.structured.snapshot(value), id)
const pendingApproval = state => state.items.filter(item => item.runtimeId === state.runtimeId && item.data.type === 'interaction' && item.data.interaction.kind === 'approval' && item.data.interaction.status === 'pending').at(-1)
const answers = state => state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant' && /^SYNTHETIC ask (allowed|denied)$/.test(item.data.text)).map(item => item.data.text)
const told = async id => (await snapshot(id)).items.some(item => item.data.type === 'notice' && /Approval review budget reached/.test(item.data.message))
const direct = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000) })
  return { status: response.status, body: await response.json() }
}
const ok = async (auth, method, args) => { const r = await direct(auth, method, args); if (r.status !== 200 || r.body.error) throw new Error(`${method} -> ${r.status} ${JSON.stringify(r.body).slice(0, 800)}`); return r.body.result }

async function setup(inst, { ownerMessage }) {
  const capture = inst.env.VR8A_CAPTURE, reviewerLog = inst.env.VR8A_REVIEWER_LOG
  await writeFile(reviewerLog, '')
  await openProject({ name: 'VR8a approvals', git: true, files: { 'package.json': '{"name":"vr8a","scripts":{"test":"node --test","lint":"node scripts/check.mjs"}}\n', 'scripts/check.mjs': 'console.log("ok")\n', 'README.md': '# VR8a\n\nTeh project.\n' } }, inst)
  const view = await page(inst)
  /** A tab opened by the owner, wand set as asked, one owner message, then its own control credential. */
  const conversation = async (title, wizard) => {
    const tab = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title }, { inst })
    const id = tab.resourceId
    await writeFile(capture, '')
    await view.evaluate(async ({ id, wizard, message }) => {
      await window.conductor.structured.connect(id)
      const state = await window.conductor.structured.snapshot(id)
      const settings = { ...state.settings, wizard, model: 'claude-fable-5-1' }
      await window.conductor.structured.saveSettings(id, settings)
      await window.conductor.structured.submit(id, message, settings, [])
    }, { id, wizard, message: ownerMessage })
    const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') && text }, { timeoutMs: 45_000, label: `${title} app-control briefing` })
    const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
    if (!auth.endpoint || !auth.token) throw new Error(title + ' got no credential')
    await poll(async () => /^(completed|idle)$/.test((await snapshot(id)).phase), { timeoutMs: 30_000, label: title + ' first turn' })
    return { id, tabId: tab.id ?? tab.tabId, auth }
  }
  const wizard = await conversation('Wizard', true)
  const opened = await ok(wizard.auth, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Coworker (Ask)', permission: 'default', exactPermission: true })
  const coworker = opened.resourceId ?? opened.agentSessionId
  await poll(async () => (await snapshot(coworker))?.settings?.permission === 'default', { timeoutMs: 30_000, label: 'coworker in Ask mode' })
  const reviewerTurns = async () => (await readFile(reviewerLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  /** One coworker request: 'done' when its turn answered, 'owner' when it waits on the owner/wizard. */
  const ask = async (body, timeoutMs = 150_000) => {
    const before = answers(await snapshot(coworker)).length
    await ok(wizard.auth, 'agents.submit', { agentSessionId: coworker, prompt: 'SYNTHETIC ASK ' + body })
    let seen
    return poll(async () => {
      const state = await snapshot(coworker), open = pendingApproval(state)
      if (answers(state).length > before) return { outcome: 'done', answer: answers(state).at(-1), state }
      if (open && ['paused', 'owner', 'blocked', 'denied', 'failed'].includes(open.data.interaction.review?.phase)) return { outcome: 'owner', card: open.data.interaction, state }
      // A card no review ever bound to is the owner's too (after a grace period for the gate).
      if (open && !open.data.interaction.review) { seen ??= Date.now(); if (Date.now() - seen > 8000) return { outcome: 'owner', card: open.data.interaction, state } }
      return null
    }, { timeoutMs, intervalMs: 250, label: 'coworker request ' + body.slice(0, 60) })
  }
  return { wizard, coworker, coworkerTabId: opened.id ?? opened.tabId, conversation, ask, reviewerTurns, view }
}

const readJournal = profile => {
  const file = [join(profile, 'conductor.db'), ...readdirSync(profile).filter(name => name.endsWith('.db')).map(name => join(profile, name))].find(existsSync)
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare("SELECT value FROM settings WHERE key LIKE 'approval-review:v1:%'").all().flatMap(row => JSON.parse(row.value)) } finally { db.close() }
}
const chipText = async (ctx, inst) => {
  await call('tabs.focus', { tabId: ctx.coworkerTabId }, { inst })
  const chip = ctx.view.locator(`.structured-agent-pane[data-structured-session="${ctx.coworker}"] .sa-review-usage`)
  await chip.waitFor({ timeout: 20_000 })
  return (await chip.textContent())?.trim()
}

// ------------------------------------------------------------------ launches
const OWNER = 'SYNTHETIC HELLO: Owner task for this project: have one coworker run the project checks (npm test, npm run lint, npx tsc --noEmit, git diff, git log, node scripts/*.mjs) and fix the typos in README.md and notes/ inside this workspace. No pushes, no releases.'
async function launch(name, extraEnv) {
  const logs = await mkdtemp(join(tmpdir(), 'vr8a-logs-'))
  return launchParked({ mode: 'playwright', name, fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', VR8A_CAPTURE: join(logs, 'capture.txt'), VR8A_REVIEWER_LOG: join(logs, 'reviewer.jsonl'), ...extraEnv } })
}
/** The class my own reading of the contract gives a request (program + subcommand, or any workspace edit). */
const classOf = body => body.startsWith('{') ? 'edit' : /^npm run \S+/.exec(body)?.[0] ?? body.split(/\s+/).slice(0, 2).join(' ')
const edit = (file, from, to) => JSON.stringify({ tool: 'Edit', input: { file_path: file, old_string: from, new_string: to } })
const write = (file, content) => JSON.stringify({ tool: 'Write', input: { file_path: file, content } })
/** Asks one request and returns its outcome with the reviewer prompts it caused. */
async function measured(ctx, body) {
  const before = (await ctx.reviewerTurns()).filter(entry => entry.kind === 'prompt').length
  step('ask ' + body.slice(0, 70))
  const result = await ctx.ask(body)
  const after = (await ctx.reviewerTurns()).filter(entry => entry.kind === 'prompt').length
  return { body, class: classOf(body), outcome: result.outcome === 'done' ? result.answer.replace('SYNTHETIC ask ', '') : 'owner', reviews: after - before, phase: result.card?.review?.phase, rationale: result.card?.review?.rationale?.slice(0, 240), card: result.card }
}
async function denyAsOwner(inst, ctx, card, reason) {
  const before = answers(await snapshot(ctx.coworker)).length
  await call('agents.approve', { agentSessionId: ctx.coworker, requestId: card.id, decision: 'deny', reason }, { inst })
  await poll(async () => answers(await snapshot(ctx.coworker)).length > before, { timeoutMs: 30_000, label: 'coworker after the deny' })
}
const OUT = 'C:/Claude/conductor/artifacts/verification/2026-09-26-fx37'

// ------------------------------------------------------------------ FX37 scenario
// Every run hands the isolated reviewer to the REAL claude CLI (Opus on the owner's login), so a
// review that should not happen would cost real credits and show in the reviewer log. Routine
// in-workspace actions (A3) and writes into folders that do not exist yet (A4) must cost 0
// reviews; a genuinely risky call (git push) and an ordinary non-routine one (node <script>)
// must still reach the reviewer. About two real reviews per run.
const runs = Number(process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 2)
for (let run = 1; run <= runs; run++) {
  try {
    if (!claudeExe) throw new Error('claude CLI not found on PATH')
    const inst = await launch('fx37-real-' + run, { VR8A_REAL_REVIEWER: claudeExe })
    const ctx = await setup(inst, { ownerMessage: OWNER })
    const readme = join(inst.projectPath, 'README.md')
    step(`run ${run}: A3 first routine in-workspace actions`)
    const first = []
    for (const body of ['npm test', edit(readme, 'Teh', 'The'), 'git diff --stat', 'npm run lint', 'git log --oneline -3']) first.push(await measured(ctx, body))
    step(`run ${run}: A4 writes into folders that do not exist yet`)
    const fresh = []
    for (const body of [write(join(inst.projectPath, 'notes', 'todo.md'), '# Todo\n'), write('docs-new/deep/plan.md', '# Plan\n')]) {
      const entry = await measured(ctx, body)
      if (entry.outcome === 'owner') await denyAsOwner(inst, ctx, entry.card, 'FX37 A4: unblocking')
      fresh.push(entry)
    }
    step(`run ${run}: calls that must still be reviewed`)
    const reviewed = []
    for (const body of ['git push origin main', 'node scripts/check.mjs']) {
      const entry = await measured(ctx, body)
      if (entry.outcome === 'owner') await denyAsOwner(inst, ctx, entry.card, 'FX37: owner keeps this')
      reviewed.push(entry)
    }
    const journal = readJournal(inst.profile).filter(item => item.workerId === ctx.coworker)
    const routineRecords = journal.filter(item => String(item.coveredBy ?? '').startsWith('routine:'))
    const log = await ctx.reviewerTurns()
    const results = log.filter(entry => entry.kind === 'result')
    const summary = entries => entries.map(entry => ({ body: entry.body.slice(0, 80), reviews: entry.reviews, outcome: entry.outcome, phase: entry.phase, rationale: entry.rationale }))
    await writeFile(join(OUT, `run${run}-calls.json`), JSON.stringify({ first: summary(first), fresh: summary(fresh), reviewed: summary(reviewed), journal: journal.map(item => ({ phase: item.phase, coveredBy: item.coveredBy, reviewerModel: item.reviewerModel, rationale: item.rationale })), log }, null, 2))
    for (const entry of [...first, ...fresh, ...reviewed]) { delete entry.card; console.log('[call]', JSON.stringify(entry)) }
    record(`A3-run${run}`, first.every(entry => entry.reviews === 0 && entry.outcome === 'allowed') ? 'PASS' : 'FAIL', { firstOfClass: summary(first) }, 'routine in-workspace actions an Auto worker would run never reach review')
    record(`A4-run${run}`, fresh.every(entry => entry.reviews === 0 && entry.outcome === 'allowed' && !/ENOENT/.test(entry.rationale ?? '')) ? 'PASS' : 'FAIL', { newFolders: summary(fresh) }, 'a Write into a folder that does not exist yet is not paused on realpath')
    record(`journal-run${run}`, routineRecords.length === first.length + fresh.length && routineRecords.every(item => ['executed', 'responded', 'approved'].includes(item.phase) && !item.reviewerModel) ? 'PASS' : 'FAIL', { routineRecords: routineRecords.map(item => ({ phase: item.phase, coveredBy: item.coveredBy })) }, 'routine allows are journaled as automatic allows')
    record(`risky-run${run}`, reviewed.every(entry => entry.reviews >= 1) && reviewed[0].outcome !== 'allowed' && results.length >= 2 && results.every(entry => !entry.is_error) ? 'PASS' : 'FAIL', { reviewed: summary(reviewed), realReviews: results.length, costUsd: Math.max(0, ...results.map(entry => entry.cost ?? 0)) }, 'a risky or unlisted call still costs a real review')
    await safeClose(inst)
  } catch (error) { await failed(error, 'run' + run) }
}
await finish()
