// VR8a (verify loop v3): review-cost-bounded + wizard-answers-approvals on the named build.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8a-approvals.mjs [--only real|synthetic] [--keep]
// The worker is a synthetic Claude CLI that asks one tool per "SYNTHETIC ASK" prompt through the
// real can_use_tool wire (as scripts/smoke-approval-review-cost.mjs). Launch "real" (A1) hands every
// isolated reviewer to the REAL claude CLI with Conductor's exact reviewer argv, so each review is a
// real Opus turn on the owner's login (owner 2026-09-26: reviews cost credits, keep it to ~20-25
// calls). Launch "synthetic" (A2, A3, B1-B3) keeps the reviewer synthetic and the default budget.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, safeClose, shot, sleep, step, watchdog } from './verify-kit.mjs'

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
configure({ name: 'vr8a-approvals' + (only ? '-' + only : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8a' })
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
const OUT = 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8a'

if (!only || only === 'real') {
  const REAL_BUDGET = 6
  try {
    if (!claudeExe) throw new Error('claude CLI not found on PATH')
    const inst = await launch('vr8a-real', { CONDUCTOR_TEST_REVIEW_BUDGET: String(REAL_BUDGET), VR8A_REAL_REVIEWER: claudeExe })
    const ctx = await setup(inst, { ownerMessage: OWNER })
    const readme = join(inst.projectPath, 'README.md')
    const sequence = [
      'npm test', edit(readme, 'Teh', 'The'), 'git diff --stat', 'npx tsc --noEmit', 'node scripts/check.mjs',
      'npm test -- --test-reporter=spec', write(join(inst.projectPath, 'notes', 'todo.md'), '# Todo\n'), 'git diff README.md', 'npx tsc --noEmit -p tsconfig.json', 'node scripts/check.mjs --fast',
      'npm test', edit(readme, 'project.', 'project!'), 'git diff', 'npx tsc --noEmit', 'node scripts/check.mjs --all',
      'npm test -- --run', write(join(inst.projectPath, 'notes', 'later.md'), '# Later\n'), 'git diff --cached', 'git log --oneline -3', 'git log -1',
      'node scripts/check.mjs', 'npm run lint'
    ]
    const calls = [], allowed = new Set()
    for (const body of sequence) {
      const entry = await measured(ctx, body)
      entry.reReviewedAllowedClass = entry.reviews > 0 && allowed.has(entry.class)
      if (entry.outcome === 'allowed' && entry.reviews > 0) allowed.add(entry.class)
      calls.push(entry)
      if (entry.outcome === 'owner') {
        entry.toldWizard = await poll(() => told(ctx.wizard.id), { timeoutMs: 5000 }).catch(() => false)
        entry.toldWorker = await poll(() => told(ctx.coworker), { timeoutMs: 5000 }).catch(() => false)
        await denyAsOwner(inst, ctx, entry.card, 'VR8a: unblocking the coworker')
      }
      delete entry.card
      console.log('[call]', JSON.stringify(entry))
    }
    const log = await ctx.reviewerTurns()
    const prompts = log.filter(entry => entry.kind === 'prompt'), spawns = log.filter(entry => entry.kind === 'spawn'), results = log.filter(entry => entry.kind === 'result'), inits = log.filter(entry => entry.kind === 'init')
    const tokens = result => ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (result.usage?.[key] ?? 0), 0)
    const notLoggedIn = log.some(entry => /not logged in/i.test(entry.text ?? ''))
    const state = await call('app.state', {}, { inst })
    const reviewerTabs = state.tabs.filter(tab => /approval review/i.test(tab.title ?? '')).length
    const status = await call('agents.status', { agentSessionId: ctx.coworker }, { inst })
    const chip = await chipText(ctx, inst).catch(error => 'no chip: ' + error.message)
    const screenshot = await shot('A1-usage-line', inst)
    const budgetCall = calls.at(-1)
    await writeFile(join(OUT, 'A1-calls.json'), JSON.stringify({ calls, log, reviewerUsage: status.usage?.reviewer ?? null, chip, reviewerTabs }, null, 2))
    const numbers = { calls: calls.length, reviews: prompts.length, reviewerProcesses: spawns.length, reviewerTabs, results: results.length, errors: results.filter(entry => entry.is_error).length, notLoggedIn, models: [...new Set(inits.map(entry => entry.model))], tokensPerReview: results.map(tokens), costUsd: results.reduce((sum, entry) => sum + (entry.cost ?? 0), 0), covered: status.usage?.reviewer?.covered ?? null, reReviewedAllowed: calls.filter(entry => entry.reReviewedAllowedClass).length, owner: calls.filter(entry => entry.outcome === 'owner').map(entry => entry.body) }
    const real = results.length === prompts.length && prompts.length > 0 && !numbers.errors && !notLoggedIn && results.every(entry => tokens(entry) > 0) && inits.every(entry => /opus/i.test(entry.model ?? ''))
    record('A1', spawns.length === 1 && reviewerTabs <= 1 && real && prompts.length <= REAL_BUDGET && numbers.reReviewedAllowed === 0 ? 'PASS' : 'FAIL', numbers, `chip "${chip}"; ${screenshot}; ${OUT}/A1-calls.json`)
    record('A1-budget', budgetCall.outcome === 'owner' && budgetCall.phase === 'paused' && /budget/i.test(budgetCall.rationale ?? '') && budgetCall.reviews === 0 && budgetCall.toldWizard && budgetCall.toldWorker ? 'PASS' : 'FAIL', { cap: REAL_BUDGET, phase: budgetCall.phase, reviews: budgetCall.reviews, toldWizard: budgetCall.toldWizard, toldWorker: budgetCall.toldWorker }, budgetCall.rationale)
    const routineFirst = calls.filter(entry => ['npm test', 'edit', 'git diff'].includes(entry.class)).filter((entry, index, list) => list.findIndex(other => other.class === entry.class) === index)
    record('A3-real', routineFirst.every(entry => entry.reviews === 0) ? 'PASS' : 'FAIL', { firstOfClass: routineFirst.map(entry => ({ class: entry.class, reviews: entry.reviews, outcome: entry.outcome })) }, 'contract: routine in-workspace actions an Auto worker would run never reach review')
    await safeClose(inst)
  } catch (error) { await failed(error, 'A1') }
}

if (!only || only === 'synthetic') {
  try {
    const inst = await launch('vr8a-synthetic', {})
    const ctx = await setup(inst, { ownerMessage: OWNER })
    const readme = join(inst.projectPath, 'README.md')
    step('A3: first routine in-workspace actions')
    const first = []
    for (const body of ['npm test', edit(readme, 'Teh', 'The'), 'git diff --stat']) first.push(await measured(ctx, body))
    record('A3-synthetic', first.every(entry => entry.reviews === 0) ? 'PASS' : 'FAIL', { firstOfClass: first.map(entry => ({ class: entry.class, reviews: entry.reviews, outcome: entry.outcome })) }, 'contract: routine in-workspace actions an Auto worker would run never reach review')
    const control = await measured(ctx, 'npm test -- --watch=false')
    record('A3-control', control.reviews === 0 && control.outcome === 'allowed' ? 'PASS' : 'FAIL', { class: control.class, reviews: control.reviews, outcome: control.outcome }, 'neighbour: a repeat of an allowed class is answered by the session rule')

    step('A4: a routine Write of a new file in a folder that does not exist yet')
    const newFolder = await measured(ctx, write(join(inst.projectPath, 'docs-new', 'plan.md'), '# Plan\n'))
    if (newFolder.outcome === 'owner') await denyAsOwner(inst, ctx, newFolder.card, 'VR8a A4: unblocking')
    const existingFolder = await measured(ctx, write(join(inst.projectPath, 'scripts', 'new-check.mjs'), 'console.log(1)\n'))
    record('A4', newFolder.outcome === 'allowed' ? 'PASS' : 'FAIL', { newFolder: { outcome: newFolder.outcome, phase: newFolder.phase, reviews: newFolder.reviews }, controlExistingFolder: { outcome: existingFolder.outcome, reviews: existingFolder.reviews } }, newFolder.rationale ?? '')

    step('B1: the reviewer escalates; the wizard answers once over app control')
    const escalated = await measured(ctx, 'node scripts/ESCALATE-ME.mjs')
    if (escalated.outcome !== 'owner') throw new Error('the escalate fixture was not left for the owner: ' + JSON.stringify({ ...escalated, card: undefined }))
    const card = escalated.card
    const ownerList = await call('agents.approvals', {}, { inst })
    const listed = await ok(ctx.wizard.auth, 'agents.approvals', {})
    const entry = listed.approvals.find(item => item.requestId === card.id)
    const answer = await ok(ctx.wizard.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: card.id, decision: 'allow', scope: 'once', reason: 'VR8a B1: the checks script is part of the delegated task' })
    const proceeded = await poll(async () => { const state = await snapshot(ctx.coworker); return answers(state).at(-1) === 'SYNTHETIC ask allowed' && state.phase === 'completed' }, { timeoutMs: 30_000, label: 'coworker proceeds' }).catch(() => false)
    const journaled = readJournal(inst.profile).find(item => item.requestId === card.id)
    const wizardCards = (await snapshot(ctx.wizard.id)).items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending').length
    record('B1', entry && entry.input === '{"command":"node scripts/ESCALATE-ME.mjs"}' && entry.mayAllow === true && ownerList.approvals.some(item => item.requestId === card.id) && proceeded && journaled && /Wizard/.test(journaled.answeredBy ?? '') ? 'PASS' : 'FAIL',
      { reviewPhase: escalated.phase, listedByWizard: Boolean(entry), input: entry?.input, mayAllow: entry?.mayAllow, listedByOwner: ownerList.approvals.some(item => item.requestId === card.id), answered: answer.answered, proceeded, journalPhase: journaled?.phase, answeredBy: journaled?.answeredBy, pendingCardsInWizardTab: wizardCards }, `journal record ${journaled?.id}: ${String(journaled?.rationale ?? '').slice(0, 200)}`)

    step('A2: the default budget (no test override)')
    const cap = Number(/REVIEWS_PER_OWNER_TASK = (\d+)/.exec(await readFile(join(REPO, 'src', 'main', 'approval-review-routing.ts'), 'utf8'))?.[1])
    let paused, sent = 0
    for (let n = 1; n <= 25 && !paused; n++) {
      const result = await measured(ctx, `node scripts/s${String(n).padStart(2, '0')}.mjs`)
      sent++
      if (result.outcome === 'owner') paused = result
    }
    const reviewsAtPause = (await ctx.reviewerTurns()).filter(item => item.kind === 'prompt').length
    const toldWizard = await poll(() => told(ctx.wizard.id), { timeoutMs: 10_000 }).catch(() => false)
    const toldWorker = await poll(() => told(ctx.coworker), { timeoutMs: 10_000 }).catch(() => false)
    const chip = await chipText(ctx, inst).catch(error => 'no chip: ' + error.message)
    const chipShot = await shot('A2-usage-line', inst)
    const status = await call('agents.status', { agentSessionId: ctx.coworker }, { inst })
    record('A2', paused && reviewsAtPause === 20 && paused.phase === 'paused' && /budget/i.test(paused.rationale ?? '') && toldWizard && toldWorker && /20\/20/.test(chip ?? '') ? 'PASS' : 'FAIL',
      { newClassesSent: sent, reviewsAtPause, phase: paused?.phase, toldWizard, toldWorker, chip, reviewerUsage: status.usage?.reviewer ?? null, sourceCap: cap }, `${chipShot}; ${paused?.rationale ?? 'never paused'}`)
    if (!paused) throw new Error('A2 never reached the budget; B1b-B3 need a paused request')

    step('B1b: the wizard allows the budget-paused request for the session')
    const sessionAnswer = await ok(ctx.wizard.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: paused.card.id, decision: 'allow', scope: 'session', reason: 'VR8a B1b: numbered check scripts are the task' })
    await poll(async () => { const state = await snapshot(ctx.coworker); return state.phase === 'completed' && !pendingApproval(state) }, { timeoutMs: 30_000, label: 'coworker after the session answer' })
    const again = await measured(ctx, paused.body + ' --again')
    record('B1b', sessionAnswer.sessionRule && again.outcome === 'allowed' && again.reviews === 0 ? 'PASS' : 'FAIL', { sessionRule: sessionAnswer.sessionRule, againOutcome: again.outcome, againReviews: again.reviews }, 'scope "session" covers the same class afterwards with no review and no owner card')

    step('B2: a plain tab and a wizard that does not control the coworker')
    const target = await measured(ctx, 'node other/u1.mjs')
    if (target.outcome !== 'owner') throw new Error('B2 target was answered without the wizard: ' + target.outcome)
    const plain = await ctx.conversation('Plain', false)
    const wizard2 = await ctx.conversation('Wizard 2', true)
    const plainList = await direct(plain.auth, 'agents.approvals', {})
    const plainApprove = await direct(plain.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: target.card.id, decision: 'allow', reason: 'not mine' })
    const otherList = await direct(wizard2.auth, 'agents.approvals', {})
    const otherApprove = await direct(wizard2.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: target.card.id, decision: 'allow', reason: 'not mine' })
    const stillPending = pendingApproval(await snapshot(ctx.coworker))?.data.interaction.id === target.card.id
    const controlDeny = await direct(ctx.wizard.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: target.card.id, decision: 'deny', reason: 'VR8a B2 cleanup' })
    await poll(async () => answers(await snapshot(ctx.coworker)).at(-1) === 'SYNTHETIC ask denied', { timeoutMs: 30_000, label: 'deny delivered' })
    const otherSees = otherList.status === 200 && (otherList.body.result?.approvals ?? []).some(item => item.agentSessionId === ctx.coworker)
    record('B2', plainList.status !== 200 && plainApprove.status !== 200 && /only a wizard/i.test(JSON.stringify(plainApprove.body)) && !otherSees && otherApprove.status !== 200 && stillPending && controlDeny.status === 200 ? 'PASS' : 'FAIL',
      { plainList: plainList.status, plainApprove: [plainApprove.status, String(plainApprove.body.error ?? '').slice(0, 120)], otherList: [otherList.status, otherList.body.result?.approvals?.length ?? otherList.body.error], otherApprove: [otherApprove.status, String(otherApprove.body.error ?? '').slice(0, 120)], stillPendingAfterRefusals: stillPending, controllingWizardDeny: controlDeny.status }, 'refusals leave the request pending; the controlling wizard can still answer it')

    step("B3: production/external/credentialed actions stay the owner's")
    const outside = join(inst.root, 'outside', 'x.txt')
    const cases = { push: 'git push origin main', credential: 'cat ~/.ssh/id_rsa', outsideWrite: write(outside, 'x'), release: 'gh release create v9.9.9' }
    const b3 = {}
    for (const [label, body] of Object.entries(cases)) {
      const result = await measured(ctx, body)
      if (result.outcome !== 'owner') { b3[label] = { autoAnswered: result.outcome, reviews: result.reviews }; continue }
      const allow = await direct(ctx.wizard.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: result.card.id, decision: 'allow', scope: 'once', reason: 'VR8a B3 probe' })
      const deny = await direct(ctx.wizard.auth, 'agents.approve', { agentSessionId: ctx.coworker, requestId: result.card.id, decision: 'deny', reason: 'VR8a B3: owner-only action' })
      const denied = await poll(async () => { const state = await snapshot(ctx.coworker); return answers(state).at(-1) === 'SYNTHETIC ask denied' && state.phase === 'completed' }, { timeoutMs: 30_000 }).catch(() => false)
      b3[label] = { allow: allow.status, allowError: String(allow.body.error ?? '').slice(0, 140), deny: deny.status, denied }
    }
    record('B3', Object.values(b3).every(entry => entry.allow === 400 && entry.deny === 200 && entry.denied) ? 'PASS' : 'FAIL', b3, 'allow refused over app control, deny accepted, coworker carries on')
    await safeClose(inst)
  } catch (error) { await failed(error, 'synthetic') }
}
await finish()
