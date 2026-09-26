// VR8g (verify loop v3): agent-roster-lists-agents after FX39 (9219ae3, 9e20e27, 55e1931). Owner: "Agent roster
// should contain agents btw" ... "agents that we're using (i meant in loops etc and like reviewer updater etc loop
// improver all that we've used even swarm controller) all that would be smart to add".
//   G1 the real brief files: every owner-named role and every `role:` of every .conductor/loops/*.md has a card with
//      model, effort, mode, brief and when; each roster model id is in the owner's models.list (read in planning,
//      .conductor-scratch/vr8g/roster-vs-models.json); the Verifier runner effort is the one verifier-brief.md uses.
//   G2 with a wizard tab open, Start Code reviewer and Verifier runner: settings and the CLI argv.
//   G3 the Approval reviewer opened as a wizard would (roster Start; tabs.open read-only + exactPermission from the
//      wizard) runs 8 tool calls through a stand-in that follows plan-mode protocol (reads run with no request,
//      writes raise can_use_tool): --permission-mode plan, 0 stronger-model reviews, 0 cards for reads, no write
//      allowed. Control: the wizard's coworker on Ask raising two writes gets a review.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8g-roster.mjs [--label L] [--keep]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, REPO, shot, sleep, step, watchdog } from './verify-kit.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'G'
configure({ name: 'vr8g-roster-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8g' })
watchdog(15 * 60)
await loadCheck()

// Claude stand-in. Every process logs its argv; a prompt tagged VR8G-TOOLS runs 5 reads (hooks only, as the CLI
// does for allowed calls) and 3 writes (can_use_tool, as the CLI does when a plan-mode model insists on one);
// VR8G-CONTROL raises two non-routine writes; a stronger-model review prompt is logged and answered "deny".
const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const log = entry => appendFileSync(process.env.VR8G_CLAUDE_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + '\\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = 'vr8g-' + process.pid
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const mode = flag('--permission-mode')
log({ kind: 'spawn', model: flag('--model'), permissionMode: mode, effort: flag('--effort'), argv: argv.filter(a => !/^\\{/.test(a)).join(' ').slice(0, 800) })
const text = content => { const id = randomUUID(); emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } }); emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } }); emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }); emit({ type: 'stream_event', event: { type: 'message_stop' } }); emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: content }] } }) }
const efforts = ['low', 'medium', 'high']
const models = [
  { value: 'default', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: efforts, isDefault: true },
  { value: 'opus[1m]', displayName: 'Opus (1M context)', supportsEffort: true, supportedEffortLevels: efforts, defaultEffort: 'high' },
  { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: efforts },
  { value: 'haiku', displayName: 'Haiku', supportsEffort: false }
]
const waiting = new Map()
let seq = 0
const ask = (request, ms) => new Promise(resolve => {
  const id = 'vr8g-' + process.pid + '-' + (++seq)
  const timer = setTimeout(() => { waiting.delete(id); resolve({ id, timeout: true }) }, ms)
  waiting.set(id, answer => { clearTimeout(timer); waiting.delete(id); resolve({ id, ...answer }) })
  send({ type: 'control_request', request_id: id, request })
})
const declare = (id, name, input) => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id, name, input }] } })
const result = (id, content, isError = false) => emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
const hook = (callback, event, id, name, input, response) => ask({ subtype: 'hook_callback', callback_id: callback, tool_use_id: id, input: { hook_event_name: event, tool_use_id: id, tool_name: name, tool_input: input, ...(response ? { tool_response: response } : {}) } }, 15000)
const READS = [['Read', { file_path: 'README.md' }], ['Grep', { pattern: 'roster' }], ['Glob', { pattern: '**/*.md' }], ['Bash', { command: 'git status --short', description: 'Show status' }], ['Bash', { command: 'git log --oneline -3', description: 'Recent commits' }]]
const WRITES = [['Write', { file_path: 'vr8g-write.txt', content: 'VR8g write' }], ['Edit', { file_path: 'README.md', old_string: '#', new_string: '##' }], ['Bash', { command: 'rm -rf docs', description: 'Delete docs' }]]
const CONTROL = [['Bash', { command: 'git push origin main', description: 'Push' }], ['Write', { file_path: '../vr8g-outside.txt', content: 'outside' }]]
const run = async (tag, name, input, write, waitMs) => {
  const id = 'toolu_vr8g_' + process.pid + '_' + (++seq)
  const started = Date.now()
  declare(id, name, input)
  const before = await hook('conductor_before', 'PreToolUse', id, name, input)
  const hookDenied = before.response?.hookSpecificOutput?.permissionDecision === 'deny'
  let permission = 'none', answer = null
  if (!hookDenied && write) {
    answer = await ask({ subtype: 'can_use_tool', tool_name: name, tool_use_id: id, input }, waitMs)
    permission = answer.timeout ? 'held' : answer.error ? 'error' : answer.response?.behavior ?? 'unknown'
    if (answer.timeout) send({ type: 'control_cancel_request', request_id: answer.id })
  }
  const ran = !hookDenied && (!write || permission === 'allow')
  if (ran) { await hook('conductor_after', 'PostToolUse', id, name, input, { stdout: 'VR8g synthetic output', exitCode: 0 }); result(id, 'VR8g synthetic output') }
  else result(id, hookDenied ? 'Denied by hook' : 'Permission ' + permission, true)
  log({ kind: 'tool', tag, tool: name, input: JSON.stringify(input).slice(0, 120), write, hook: before.timeout ? 'timeout' : hookDenied ? 'deny' : 'ok', permission, ran, ms: Date.now() - started, message: answer?.response?.message ?? answer?.error ?? null })
}
const handle = async prompt => {
  log({ kind: 'prompt', prompt })
  emit({ type: 'system', subtype: 'init', model: flag('--model') ?? 'opus[1m]', permissionMode: mode ?? 'default', claude_code_version: '2.1.282', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'] })
  const review = /Exact host-bound action/.test(prompt)
  const tag = /VR8G-(TOOLS|CONTROL) ([\\w-]+)/.exec(prompt)
  if (review) {
    const digest = /"digest":"([a-f0-9]{64})"/.exec(prompt)?.[1] ?? ''
    log({ kind: 'review', workerId: /"workerId":"([^"]+)"/.exec(prompt)?.[1] ?? null, tool: /"tool":"([^"]+)"/.exec(prompt)?.[1] ?? null })
    text(JSON.stringify({ digest, decision: 'deny', rationale: 'VR8g control reviewer' }))
  } else if (tag) {
    const control = tag[1] === 'CONTROL'
    if (!control) for (const [name, input] of READS) await run(tag[2], name, input, false, 0)
    for (const [name, input] of control ? CONTROL : WRITES) await run(tag[2], name, input, true, control ? 60000 : 10000)
    text('VR8g tools done')
    log({ kind: 'done', tag: tag[2] })
  } else text('ok')
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
}
let chain = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_response') { const id = message.response?.request_id; const done = waiting.get(id); if (done) done(message.response.subtype === 'success' ? { response: message.response.response ?? {} } : { error: message.response.error ?? 'error' }); return }
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models, commands: [] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (typeof prompt !== 'string') return
  chain = chain.then(() => handle(prompt)).catch(error => log({ kind: 'error', error: String(error) }))
})
`

const source = readFileSync(join(REPO, 'src/shared/agent-roster.ts'), 'utf8')
const roles = [...source.matchAll(/name: '([^']+)', role: '([^']+)', provider: '([^']+)', model: '([^']+)'(?:, effort: '([^']+)')?, permission: '([^']+)'[^\n]*\n\s*briefs: \[([^\]]+)\]/g)]
  .map(match => ({ name: match[1], role: match[2], provider: match[3], model: match[4], effort: match[5] ?? null, permission: match[6], briefs: [...match[7].matchAll(/'([^']+)'/g)].map(entry => entry[1]) }))
if (roles.length < 14) throw new Error(`parsed only ${roles.length} roles from agent-roster.ts`)
const OWNER_NAMED = { 'swarm controller': 'swarm-orchestrator', reviewer: 'approval-reviewer', updater: 'updater', 'loop (runner)': 'loop-runner', 'loop improver': 'loop-improver', verifier: 'verifier', fixer: 'swarm-fixer', overseer: 'overseer' }
// A loop step's role -> the roster entry that does that job (the same map as agent-roster.test.ts's intent).
const LOOP_ROLE_TO_ROSTER = { implementer: 'swarm-fixer', churn: 'local-helper', verifier: 'verifier', controller: 'swarm-orchestrator', architect: 'architect', reviewer: 'code-reviewer' }
const briefFiles = Object.fromEntries(roles.flatMap(role => role.briefs).filter(path => existsSync(join(REPO, path))).map(path => [path, readFileSync(join(REPO, path), 'utf8')]))

const logs = await mkdtemp(join(tmpdir(), 'vr8g-roster-'))
const claudeLog = join(logs, 'claude.jsonl')
const entries = async () => (await readFile(claudeLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))

try {
  const inst = await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', VR8G_CLAUDE_LOG: claudeLog } })
  const plain = await openProject({ name: 'Website without briefs', files: { 'index.html': '<h1>site</h1>\n' } })
  const project = await openProject({ name: 'Roster project', git: true, files: briefFiles })
  const view = await page()
  const db = () => new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true })
  const setting = key => { const handle = db(); try { return handle.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null } finally { handle.close() } }
  const controllerOf = id => { const raw = setting('agentControlParent:' + id); try { return raw ? JSON.parse(raw).controllerAgentSessionId ?? 'unparsed' : null } catch { return 'unparsed' } }
  const projection = id => { const handle = db(); try { return JSON.parse(handle.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id)?.projection_json ?? 'null') } finally { handle.close() } }
  /** Approval-review journal records (approval-review.ts, settings approval-review:v1:*) of one worker. */
  const journal = workerId => { const handle = db(); try { return handle.prepare("SELECT value FROM settings WHERE key LIKE 'approval-review:v1:%'").all().flatMap(row => { try { return JSON.parse(row.value) } catch { return [] } }).filter(entry => entry.workerId === workerId) } finally { handle.close() } }
  const openAgents = async name => {
    await view.evaluate(() => localStorage.setItem('conductor.utilityPanel', 'agents'))
    await view.reload()
    await view.waitForFunction(() => Boolean(window.conductor))
    await view.locator('.project-row').filter({ hasText: name }).first().click()
    await view.locator('.project-row.active').filter({ hasText: name }).first().waitFor({ timeout: 30_000 })
    await view.locator('.orchestration-agent-card').first().waitFor({ timeout: 30_000 })
    await sleep(1000)
  }
  const cardsNow = () => view.locator('.orchestration-agent-card').evaluateAll(nodes => nodes.map(node => ({ role: node.getAttribute('data-role'), text: (node.textContent ?? '').replace(/\s+/g, ' ') })))

  step('G1: the roster against the owner\'s words and every saved loop')
  await openAgents('Website without briefs')
  const plainCards = await cardsNow()
  await openAgents('Roster project')
  const cards = await cardsNow()
  const g1Shot = await shot(`${label}1-roster`)
  const sane = roles.map(role => {
    const card = cards.find(entry => entry.role === role.role)
    const missing = !card ? ['card'] : [role.name, role.model, role.briefs[0], ...(role.effort ? [role.effort] : [])].filter(part => !card.text.includes(part))
    return { role: role.role, missing, mode: card ? (/\b(Auto|Ask|Edit|Read only)\b/.exec(card.text)?.[1] ?? null) : null, whenToUse: card ? card.text.length > role.name.length + 60 : false }
  })
  const bad = sane.filter(entry => entry.missing.length || !entry.mode || !entry.whenToUse)
  const ownerMissing = Object.entries(OWNER_NAMED).filter(([, key]) => !cards.some(card => card.role === key)).map(([words]) => words)
  const loopRoles = {}
  for (const file of readdirSync(join(REPO, '.conductor/loops')).filter(name => name.endsWith('.md'))) {
    const head = readFileSync(join(REPO, '.conductor/loops', file), 'utf8').split(/\n---/)[0]
    for (const match of head.matchAll(/^\s+role: (\w[\w-]*)/gm)) (loopRoles[match[1]] ??= new Set()).add(file.replace(/\.md$/, ''))
  }
  const uncovered = Object.keys(loopRoles).filter(role => !cards.some(card => card.role === (LOOP_ROLE_TO_ROSTER[role] ?? role)))
  const modelsFile = 'C:/Claude/conductor/.conductor-scratch/vr8g/roster-vs-models.json'
  const modelCheck = existsSync(modelsFile) ? JSON.parse(readFileSync(modelsFile, 'utf8')) : null
  // The cloud coworker's model is listed under the cloud provider (models.list provider "cloud").
  const modelMissing = modelCheck ? modelCheck.filter(entry => !entry.exists && entry.role !== 'cloud-coworker').map(entry => entry.role + ':' + entry.model) : ['models file missing']
  const runner = roles.find(role => role.role === 'verifier-runner')
  const brief = readFileSync(join(REPO, 'docs/verification/verifier-brief.md'), 'utf8')
  const briefRunnerEffort = /runner', model:'sonnet', effort:'(\w+)'/.exec(brief)?.[1] ?? null
  const g1Pass = !bad.length && !ownerMissing.length && !uncovered.length && !modelMissing.length && runner?.effort === briefRunnerEffort
    && cards.some(card => card.role === 'auto-fixer') && !plainCards.some(card => roles.some(role => role.role === card.role))
  record(label + '1', g1Pass ? 'PASS' : 'FAIL', {
    roles: roles.length, cards: cards.length, ownerMissing: ownerMissing.join(',') || 'none',
    loopRoles: Object.fromEntries(Object.entries(loopRoles).map(([role, files]) => [role, [...files].join('+')])), uncovered: uncovered.join(',') || 'none',
    bad: bad.map(entry => `${entry.role}:${entry.missing.join('+')}${entry.mode ? '' : ' no-mode'}${entry.whenToUse ? '' : ' no-when'}`).join('; ') || 'none',
    modes: Object.fromEntries(sane.map(entry => [entry.role, entry.mode])), modelIdsMissing: modelMissing.join(',') || 'none',
    runnerEffort: runner?.effort, briefRunnerEffort, plainProjectConductorRoles: plainCards.filter(card => roles.some(role => role.role === card.role)).length
  }, `real brief files; owner models.list ${modelsFile}; ${g1Shot}`)

  step('a wizard tab in the roster project')
  const wizardTab = await openTab({ provider: 'claude', model: 'opus[1m]', title: 'Wizard' })
  const wizardId = wizardTab.resourceId
  await view.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'opus[1m]' })
  }, wizardId)
  const wizardOn = (await view.evaluate(id => window.conductor.structured.snapshot(id), wizardId)).settings?.wizard === true
  await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'VR8g wizard: verify the roster', state.settings, []) }, wizardId)
  const briefing = await poll(async () => (await entries()).find(entry => entry.kind === 'prompt' && entry.prompt.includes('VR8g wizard: verify the roster') && /Bearer [a-f0-9]{64}/.test(entry.prompt))?.prompt ?? null, { timeoutMs: 45_000, label: 'wizard app-control briefing' })
  const wizardAuth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  const wizardCall = async (method, args) => { const response = await fetch(wizardAuth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + wizardAuth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }); const body = await response.json(); if (response.status !== 200 || body.error) throw new Error(method + ' as wizard: ' + JSON.stringify(body.error ?? body).slice(0, 300)); return body.result }

  /** The CLI process that received a prompt containing `needle`, with its spawn entry. */
  const cliFor = needle => poll(async () => {
    const all = await entries()
    const prompted = all.find(entry => entry.kind === 'prompt' && entry.prompt.includes(needle))
    return prompted ? all.find(entry => entry.kind === 'spawn' && entry.pid === prompted.pid) ?? null : null
  }, { timeoutMs: 45_000, label: `CLI for "${needle.slice(0, 40)}"` }).catch(() => null)
  const start = async (roleId, goal) => {
    await openAgents('Roster project')
    const card = view.locator(`.orchestration-agent-card[data-role="${roleId}"]`)
    if (!await card.count()) throw new Error(`no ${roleId} card`)
    const before = new Set((await call('tabs.list', {})).map(tab => tab.id))
    await card.locator('button.orchestration-start-agent').click()
    if (goal) await card.getByRole('textbox').fill(goal)
    await card.locator('.orchestration-agent-start button').click()
    const tab = await poll(async () => (await call('tabs.list', {})).find(entry => !before.has(entry.id) && entry.kind === 'agent') ?? null, { timeoutMs: 30_000, label: `${roleId} tab` })
    const prompt = await poll(() => (projection(tab.resourceId)?.items ?? []).map(item => item.data).find(item => item?.type === 'text' && item.role === 'user')?.text ?? null, { timeoutMs: 30_000, label: `${roleId} first message` })
    const spawn = await cliFor(prompt.slice(0, 60))
    const settings = projection(tab.resourceId)?.settings ?? {}
    return { tab, id: tab.resourceId, prompt, settings, spawn, controller: controllerOf(tab.resourceId) }
  }
  const summary = started => ({ model: started.settings.model ?? null, effort: started.settings.effort ?? null, permission: started.settings.permission ?? null, plan: started.settings.plan ?? null, cliModel: started.spawn?.model ?? null, cliPermissionMode: started.spawn?.permissionMode ?? null, cliEffort: started.spawn?.effort ?? null, controller: started.controller })

  step('G2: Start Code reviewer and Verifier runner')
  const g2 = {}
  for (const [roleId, model, effort] of [['code-reviewer', 'opus[1m]', 'high'], ['verifier-runner', 'sonnet', 'low']]) {
    try {
      const role = roles.find(entry => entry.role === roleId)
      const goal = `VR8g goal: ${roleId} smoke`
      const started = await start(roleId, goal)
      const sum = summary(started)
      g2[roleId] = { ...sum, briefsInPrompt: role.briefs.every(path => started.prompt.includes(path)), goalInPrompt: started.prompt.includes(`Goal: ${goal}`),
        ok: sum.model === model && sum.effort === effort && sum.permission === 'auto' && sum.cliModel === model && sum.cliEffort === effort && sum.cliPermissionMode === 'auto' && sum.controller === null }
      g2[roleId].ok &&= g2[roleId].briefsInPrompt && g2[roleId].goalInPrompt
    } catch (error) { g2[roleId] = { ok: false, error: error.message.slice(0, 200) } }
  }
  const g2Shot = await shot(`${label}2-started`)
  record(label + '2', wizardOn && Object.values(g2).every(entry => entry.ok) ? 'PASS' : 'FAIL', { wizardOn, ...g2 }, g2Shot)

  step('G3: the Approval reviewer, as a wizard would open it, runs 8 tool calls')
  const toolsOf = async tag => (await entries()).filter(entry => entry.kind === 'tool' && entry.tag === tag)
  const waitDone = tag => poll(async () => (await entries()).some(entry => entry.kind === 'done' && entry.tag === tag) || null, { timeoutMs: 150_000, label: `${tag} tool calls done` })
  const measure = async (tag, id, spawn) => {
    await waitDone(tag)
    await sleep(2000)
    const tools = await toolsOf(tag)
    const reviews = (await entries()).filter(entry => entry.kind === 'review' && entry.workerId === id)
    const records = journal(id)
    const cards = (projection(id)?.items ?? []).map(item => item.data).filter(data => data?.type === 'interaction').map(data => ({ title: data.interaction?.title, status: data.interaction?.status, review: data.interaction?.review?.phase ?? null, rationale: (data.interaction?.review?.rationale ?? '').slice(0, 90), input: JSON.stringify(data.interaction?.input ?? {}).slice(0, 80) }))
    const readCards = cards.filter(card => /Allow (Read|Grep|Glob)\?/.test(card.title ?? '') || /git (status|log)/.test(card.input))
    return {
      cliPermissionMode: spawn?.permissionMode ?? null, calls: tools.length,
      reads: tools.filter(tool => !tool.write).map(tool => `${tool.tool}:${tool.permission}/${tool.ran ? 'ran' : 'blocked'}`).join(','),
      writes: tools.filter(tool => tool.write).map(tool => `${tool.tool}:${tool.permission}`).join(','),
      reviewerTurns: reviews.length, journalReviewed: records.filter(entry => entry.reviewerId && !entry.coveredBy).length, journal: records.map(entry => entry.phase).join(',') || 'none',
      cards: cards.length, readCards: readCards.length, cardDetail: cards.map(card => `${card.title}|${card.status}|${card.review ?? '-'}`).join('; '),
      writesAllowed: tools.filter(tool => tool.write && tool.permission === 'allow').length, readsRan: tools.filter(tool => !tool.write && tool.ran).length
    }
  }
  const g3Pass = numbers => numbers.cliPermissionMode === 'plan' && numbers.calls === 8 && numbers.readsRan === 5 && numbers.readCards === 0 && numbers.reviewerTurns === 0 && numbers.journalReviewed === 0 && numbers.writesAllowed === 0
  const g3 = {}
  try {
    const started = await start('approval-reviewer', 'VR8G-TOOLS roster-start')
    g3.roster = { ...summary(started), ...await measure('roster-start', started.id, started.spawn) }
  } catch (error) { g3.roster = { error: error.message.slice(0, 300) } }
  try {
    const opened = await wizardCall('tabs.open', { kind: 'agent', provider: 'claude', model: 'opus[1m]', effort: 'high', permission: 'read-only', exactPermission: true, title: 'Approval reviewer (wizard)' })
    await poll(() => call('agents.status', { agentSessionId: opened.resourceId }), { timeoutMs: 30_000, label: 'wizard reviewer status' })
    await wizardCall('agents.submit', { agentSessionId: opened.resourceId, prompt: 'VR8G-TOOLS wizard-open' })
    const spawn = await cliFor('VR8G-TOOLS wizard-open')
    const settings = projection(opened.resourceId)?.settings ?? {}
    g3.wizard = { permission: settings.permission ?? null, plan: settings.plan ?? null, controller: controllerOf(opened.resourceId) === wizardId ? 'wizard' : controllerOf(opened.resourceId), ...await measure('wizard-open', opened.resourceId, spawn) }
  } catch (error) { g3.wizard = { error: error.message.slice(0, 300) } }
  try {
    const opened = await wizardCall('tabs.open', { kind: 'agent', provider: 'claude', model: 'sonnet', permission: 'default', exactPermission: true, title: 'Ask coworker (control)' })
    await poll(() => call('agents.status', { agentSessionId: opened.resourceId }), { timeoutMs: 30_000, label: 'control coworker status' })
    await wizardCall('agents.submit', { agentSessionId: opened.resourceId, prompt: 'VR8G-CONTROL ask-coworker' })
    const spawn = await cliFor('VR8G-CONTROL ask-coworker')
    g3.control = { controller: controllerOf(opened.resourceId) === wizardId ? 'wizard' : controllerOf(opened.resourceId), ...await measure('ask-coworker', opened.resourceId, spawn) }
  } catch (error) { g3.control = { error: error.message.slice(0, 300) } }
  const g3Shot = await shot(`${label}3-approval-reviewer`)
  const controlOk = (g3.control?.reviewerTurns ?? 0) >= 1
  record(label + '3', !controlOk ? 'NOT RUN (harness: the Ask control got no review, so 0 reviews proves nothing)' : g3Pass(g3.roster ?? {}) && g3Pass(g3.wizard ?? {}) ? 'PASS' : 'FAIL', g3, g3Shot)
  console.log(`project ${project.id}, plain ${plain.id}, log ${claudeLog}`)
} catch (error) { await failed(error, label + '-error') }
await finish()
