// FX35: approvals under a wizard are cheap and answerable (feature-list.md review-cost-bounded,
// wizard-answers-approvals). One parked launch, two scenarios, real Electron main/preload/renderer
// and the production review gate, routing and app control; only the Claude CLI is an inline
// synthetic fixture (no inference, nothing executed):
//   A. An Ask-mode coworker under a wizard raises the same 24-request sequence FX32 paid 24 fresh
//      reviewer tabs for: one reviewer conversation answers it, each class of action is reviewed
//      once and its repeats are answered by the worker's session rule; the next new class meets the
//      (test-lowered) task budget, and the owner notice fires in the wizard's and the worker's tab.
//   B. The wizard answers that paused approval itself over app control (agents.approvals /
//      agents.approve) and the coworker proceeds; "for this session" covers the class afterwards;
//      an external action cannot be allowed through app control but can be denied; a non-wizard
//      tab is refused both methods.
// CONDUCTOR_TEST_USER_DATA parks the window.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-approval-review-cost.mjs [--run N]
import { _electron as electron, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const runLabel = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : String(Date.now())
const BUDGET = 4
const root = await mkdtemp(join(tmpdir(), 'conductor-review-cost-'))
const output = resolve('artifacts/fx35/approval-review-cost')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project'), fixtures = join(root, 'fixtures')
const capture = join(root, 'last-prompt.txt'), reviewerLog = join(root, 'reviewer.jsonl')
await mkdir(projectPath, { recursive: true }); await mkdir(fixtures, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# FX35 review cost smoke\n')

// A Claude CLI stand-in: 'SYNTHETIC ASK <command>' asks for one Bash call (can_use_tool) and
// finishes when it is answered; an isolated reviewer prompt gets an Opus-labelled allow for the
// digest it was given; anything else is a short answer.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = 'fx35-' + process.pid
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
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: pending.tool, content: allowed ? 'SYNTHETIC ran: ' + pending.command : 'SYNTHETIC denied: ' + (answer.message ?? ''), is_error: !allowed }] } })
    text(allowed ? 'SYNTHETIC ask allowed' : 'SYNTHETIC ask denied')
    pending = undefined; finish(); return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (typeof prompt !== 'string') return
  if (prompt.includes('Conductor app control:')) writeFileSync(${JSON.stringify(capture)}, prompt)
  if (prompt.startsWith('You are an isolated approval reviewer')) {
    const digest = /"digest":"([0-9a-f]+)"/.exec(prompt)?.[1]
    appendFileSync(${JSON.stringify(reviewerLog)}, JSON.stringify({ pid: process.pid, chars: prompt.length, reused: prompt.includes('The rules of your first message'), at: Date.now() }) + '\\n')
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'default' })
    text(JSON.stringify({ digest, decision: 'allow', rationale: 'SYNTHETIC reviewer: a routine workspace command of the delegated task.' }))
    return finish({ input_tokens: Math.ceil(prompt.length / 4), output_tokens: 40 })
  }
  emit({ type: 'system', subtype: 'init', model, permissionMode: 'default' })
  const ask = /^SYNTHETIC ASK (.+)/.exec(prompt.split('\\n', 1)[0])
  if (ask) {
    turn++
    pending = { request: 'ask-' + turn, tool: 'toolu_fx35_' + process.pid + '_' + turn, command: ask[1].trim() }
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: pending.tool, name: 'Bash', input: { command: pending.command } }] } })
    send({ type: 'control_request', request_id: pending.request, request: { subtype: 'can_use_tool', tool_use_id: pending.tool, tool_name: 'Bash', input: { command: pending.command }, permission_suggestions: [] } })
    return
  }
  text('Short done.'); finish()
})
`)

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_REVIEW_BUDGET: String(BUDGET), CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const checks = [], evidence = {}
const check = label => { checks.push(label); console.log('PASS ' + label) }
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const ok = async (auth, method, args = {}, scope) => { const r = await request(auth, method, args, scope); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
const reviewerTurns = async () => (await readFile(reviewerLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const pendingApproval = state => state.items.filter(item => item.runtimeId === state.runtimeId && item.data.type === 'interaction' && item.data.interaction.kind === 'approval' && item.data.interaction.status === 'pending').at(-1)
let failed
try {
  await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30000 }).toBe(true)
  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const project = await ok(owner, 'projects.open', { path: projectPath, name: 'FX35 review cost' })
  const scope = { projectId: project.id }
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'FX35 review cost' }).first().click()

  /** Opens a tab as the owner, sets the wand, sends one owner message and reads its own credential. */
  const openTab = async (title, wizard) => {
    const tab = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title }, scope)
    const id = tab.resourceId ?? tab.agentSessionId
    await writeFile(capture, '')
    await page.evaluate(async ({ id, wizard }) => {
      await window.conductor.structured.connect(id)
      const state = await window.conductor.structured.snapshot(id)
      const settings = { ...state.settings, wizard, model: 'claude-fable-5-1' }
      await window.conductor.structured.saveSettings(id, settings)
      await window.conductor.structured.submit(id, 'SYNTHETIC HELLO: owner asks for the checks to be run by a coworker', settings, [])
    }, { id, wizard })
    await expect.poll(async () => (await readFile(capture, 'utf8').catch(() => '')).includes('Conductor app control:'), { timeout: 30000 }).toBe(true)
    const briefing = await readFile(capture, 'utf8')
    const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
    assert.ok(auth.endpoint && auth.token, title + ' did not receive an app-control briefing')
    await expect.poll(async () => (await snapshot(id)).phase, { timeout: 20000 }).toMatch(/^(completed|idle)$/)
    return { id, tabId: tab.id ?? tab.tabId, auth }
  }
  const wizard = await openTab('Wizard', true)
  const plain = await openTab('Plain', false)
  const tools = await ok(wizard.auth, 'tools.list')
  assert.ok(tools['agents.approvals'] && tools['agents.approve'], 'a wizard is offered agents.approvals/approve')
  assert.ok(!(await ok(plain.auth, 'tools.list'))['agents.approve'], 'an ordinary tab is not offered agents.approve')
  const opened = await ok(wizard.auth, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'claude-fable-5-1', title: 'Coworker (Ask)', permission: 'default', exactPermission: true })
  const coworker = opened.resourceId ?? opened.agentSessionId
  await expect.poll(async () => (await snapshot(coworker))?.settings?.permission, { timeout: 20000 }).toBe('default')
  check('A wizard opened an Ask-mode coworker; only the wizard is offered agents.approvals/approve')

  /** One request of the coworker: settled when its turn completed, or when it waits on the owner. */
  const answers = state => state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant' && /^SYNTHETIC ask (allowed|denied)$/.test(item.data.text)).length
  const ask = async (command, settle = 'completed') => {
    const before = answers(await snapshot(coworker))
    await ok(wizard.auth, 'agents.submit', { agentSessionId: coworker, prompt: 'SYNTHETIC ASK ' + command })
    await expect.poll(async () => {
      const state = await snapshot(coworker), open = pendingApproval(state)
      if (settle === 'owner') return open && ['paused', 'owner', 'blocked'].includes(open.data.interaction.review?.phase) ? 'owner' : state.phase
      return answers(state) > before ? state.phase : 'waiting for this turn'
    }, { timeout: 30000, intervals: [100, 200, 400] }).toBe(settle)
    return snapshot(coworker)
  }

  // A. The 24-request sequence: four classes of action, each repeated or varied.
  const sequence = [
    'npm test', 'npx tsc --noEmit', 'git status', 'node scripts/check.mjs',
    'npm test -- --run src/a.test.ts', 'npx tsc --noEmit -p tsconfig.json', 'git status --short', 'node scripts/check.mjs --fast',
    'npm test', 'npx tsc --noEmit', 'git status', 'node scripts/check.mjs',
    'npm test -- --run src/b.test.ts', 'npx tsc --noEmit -p tsconfig.node.json', 'git status -uno', 'node scripts/check.mjs --all',
    'npm test', 'npx tsc --noEmit', 'git status', 'node scripts/check.mjs',
    'npm test -- --run src/c.test.ts', 'npx tsc --noEmit --pretty false', 'git status --porcelain', 'node scripts/check.mjs --quiet'
  ]
  const started = Date.now()
  for (const command of sequence) await ask(command)
  const sequenceMs = Date.now() - started
  const afterSequence = await snapshot(coworker)
  const results = afterSequence.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant' && /^SYNTHETIC ask (allowed|denied)$/.test(item.data.text)).map(item => item.data.text)
  assert.equal(results.length, 24); assert.ok(results.every(text => text === 'SYNTHETIC ask allowed'), 'every request of the sequence was allowed')
  const turns = await reviewerTurns()
  assert.equal(turns.length, 4, `four classes, four reviews (got ${turns.length})`)
  assert.equal(new Set(turns.map(entry => entry.pid)).size, 1, 'one reviewer conversation')
  assert.deepEqual(turns.map(entry => entry.reused), [false, true, true, true])
  const state = await ok(owner, 'app.state', {}, scope)
  const reviewerTabs = state.tabs.filter(tab => tab.title === 'Stronger approval review')
  assert.equal(reviewerTabs.length, 1, 'one reviewer tab stays for the worker')
  const status = await ok(wizard.auth, 'agents.status', { agentSessionId: coworker })
  assert.equal(status.usage.reviewer.reviews, 4)
  evidence.sequence = { requests: sequence.length, reviews: turns.length, reviewerConversations: new Set(turns.map(entry => entry.pid)).size, reviewerPromptChars: turns.map(entry => entry.chars), wallMs: sequenceMs, reviewerUsage: status.usage.reviewer }
  check(`24 Ask-mode requests under a wizard: 4 reviews in 1 reviewer conversation, 20 answered by session rules (${sequenceMs} ms)`)

  // The budget: a fifth class meets the (test-lowered) cap and the owner is told, once, in both tabs.
  const paused = await ask('node scripts/other.mjs', 'owner')
  const card = pendingApproval(paused).data.interaction
  assert.equal(card.review.phase, 'paused'); assert.match(card.review.rationale, /budget/)
  assert.equal((await reviewerTurns()).length, 4, 'no review past the budget')
  const told = async id => (await snapshot(id)).items.some(item => item.data.type === 'notice' && /Approval review budget reached/.test(item.data.message))
  await expect.poll(() => told(wizard.id), { timeout: 10000 }).toBe(true)
  await expect.poll(() => told(coworker), { timeout: 10000 }).toBe(true)
  const usage = paused.items.filter(item => item.data.type === 'notice' && item.data.payload?.approvalReviews).at(-1)?.data.payload.approvalReviews
  assert.deepEqual({ reviews: usage.reviews, covered: usage.covered, rules: usage.rules, budget: usage.budget }, { reviews: 4, covered: 20, rules: 4, budget: { used: BUDGET, cap: BUDGET } })
  await ok(owner, 'tabs.focus', { tabId: opened.id ?? opened.tabId }, scope)
  const chip = page.locator(`.structured-agent-pane[data-structured-session="${coworker}"] .sa-review-usage`)
  await expect(chip).toContainText('Reviews 4', { timeout: 20000 })
  await expect(chip).toContainText(`${BUDGET}/${BUDGET}`)
  evidence.usageLine = await chip.textContent()
  await page.screenshot({ path: join(output, `usage-line-${runLabel}.png`) })
  check(`At the ${BUDGET}-review task budget the next class goes to the owner with a notice in the wizard and worker tabs; the usage line reads "${evidence.usageLine}"`)

  // B. A non-wizard is refused; the wizard answers the paused approval and the coworker proceeds.
  for (const method of ['agents.approvals', 'agents.approve']) {
    const refused = await request(plain.auth, method, method === 'agents.approve' ? { agentSessionId: coworker, requestId: card.id, decision: 'allow', reason: 'not mine' } : {})
    assert.equal(refused.status, 400); assert.match(refused.body.error, /only a wizard tab/)
  }
  check('A non-wizard tab is refused agents.approvals and agents.approve')
  const listed = await ok(wizard.auth, 'agents.approvals', {})
  const entry = listed.approvals.find(item => item.requestId === card.id)
  assert.ok(entry, 'the paused approval is listed'); assert.equal(entry.agentSessionId, coworker); assert.equal(entry.input, '{"command":"node scripts/other.mjs"}'); assert.equal(entry.mayAllow, true); assert.equal(entry.review.phase, 'paused')
  const answer = await ok(wizard.auth, 'agents.approve', { agentSessionId: coworker, requestId: card.id, decision: 'allow', scope: 'session', reason: 'The checks script is part of the delegated task' })
  assert.equal(answer.sessionRule, 'Bash:node scripts/other.mjs')
  await expect.poll(async () => (await snapshot(coworker)).phase, { timeout: 20000 }).toBe('completed')
  const answered = (await snapshot(coworker)).items.filter(item => item.data.type === 'interaction' && item.data.interaction.id === card.id).at(-1).data.interaction
  assert.equal(answered.status, 'resolved'); assert.match(answered.review.rationale, /Wizard/)
  assert.equal((await snapshot(coworker)).items.filter(item => item.data.type === 'text' && item.data.text === 'SYNTHETIC ask allowed').length, 25)
  check('The wizard listed the paused approval with its exact action, allowed it for the session over app control, and the coworker proceeded; the journal names the wizard')
  await ask('node scripts/other.mjs --again')
  assert.equal((await reviewerTurns()).length, 4)
  check('The wizard\'s "for this session" answer covers the same class afterwards, with no review and no budget stop')

  const external = await ask('git push origin main', 'owner')
  const push = pendingApproval(external).data.interaction
  const refusedAllow = await request(wizard.auth, 'agents.approve', { agentSessionId: coworker, requestId: push.id, decision: 'allow', reason: 'ship it' })
  assert.equal(refusedAllow.status, 400); assert.match(refusedAllow.body.error, /external/)
  await ok(wizard.auth, 'agents.approve', { agentSessionId: coworker, requestId: push.id, decision: 'deny', reason: 'No pushes in this task' })
  await expect.poll(async () => (await snapshot(coworker)).phase, { timeout: 20000 }).toBe('completed')
  assert.ok((await snapshot(coworker)).items.some(item => item.data.type === 'text' && item.data.text === 'SYNTHETIC ask denied'))
  check('An external push cannot be allowed through app control; the wizard denied it and the coworker carried on')
  assert.deepEqual(errors, [])
} catch (error) {
  failed = error
  console.error('FAIL', error)
  await page.screenshot({ path: join(output, `failure-${runLabel}.png`) }).catch(() => undefined)
} finally {
  await appendFile(join(output, 'runs.jsonl'), JSON.stringify({ run: runLabel, at: new Date().toISOString(), ok: !failed, checks, evidence, error: failed ? String(failed.message ?? failed) : undefined }) + '\n')
  await app.close().catch(() => undefined)
}
console.log(JSON.stringify({ ok: !failed, checks: checks.length, evidence }, null, 2))
process.exit(failed ? 1 : 0)
