// VR8d (verify loop v3): agent-roster-lists-agents (FX36 f18f8bc + da1f650). Owner: "Agent roster should contain
// agents btw" ... "agents that we're using (i meant in loops etc and like reviewer updater etc loop improver all
// that we've used even swarm controller) all that would be smart to add".
//   R1 a project holding the REAL brief files (copied from this checkout) lists every role with model, effort,
//      mode, brief and when to use; control: the built-in Auto Fixer is listed and a project without the
//      briefs gets none of the Conductor roles.
//   R2 with a wizard tab open in the project, Start "Verifier" with a goal: claude / opus[1m] / high / Auto in the
//      tab's settings AND in the argv the CLI was spawned with; not a coworker of the wizard; first message
//      names its briefs and the goal.
//   R3 Start "Fixer" with a goal (a second Claude role in one run), then "Approval reviewer": record its mode and
//      whether anything routes its approvals to a review (review churn judgement).
// The Claude stand-in reports the model list the real CLI offers (default, opus[1m], sonnet, haiku, Fable) and
// logs the argv each process was started with and every prompt it receives.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8d-roster.mjs [--label L] [--keep]
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, REPO, shot, sleep, step, watchdog } from './verify-kit.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'R'
configure({ name: 'vr8d-roster-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8d' })
watchdog(12 * 60)
await loadCheck()

const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const log = entry => appendFileSync(process.env.VR8D_CLAUDE_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + '\\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = 'vr8d-r-' + process.pid
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
log({ kind: 'spawn', model: flag('--model'), permissionMode: flag('--permission-mode'), effort: flag('--effort'), argv: argv.filter(a => !/^\\{/.test(a)).join(' ').slice(0, 800) })
const text = content => { const id = randomUUID(); emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } }); emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } }); emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }); emit({ type: 'stream_event', event: { type: 'message_stop' } }); emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: content }] } }) }
const efforts = ['low', 'medium', 'high']
const models = [
  { value: 'default', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: efforts, isDefault: true },
  { value: 'opus[1m]', displayName: 'Opus (1M context)', supportsEffort: true, supportedEffortLevels: efforts, defaultEffort: 'high' },
  { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: efforts },
  { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', supportsEffort: true, supportedEffortLevels: efforts }
]
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models, commands: [] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  if (typeof prompt !== 'string') return
  log({ kind: 'prompt', prompt })
  emit({ type: 'system', subtype: 'init', model: flag('--model') ?? 'opus[1m]', permissionMode: flag('--permission-mode') ?? 'default' })
  text('ok')
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const source = readFileSync(join(REPO, 'src/shared/agent-roster.ts'), 'utf8')
const roles = [...source.matchAll(/name: '([^']+)', role: '([^']+)', provider: '([^']+)', model: '([^']+)'(?:, effort: '([^']+)')?, permission: '([^']+)'[^\n]*\n\s*briefs: \[([^\]]+)\]/g)]
  .map(match => ({ name: match[1], role: match[2], provider: match[3], model: match[4], effort: match[5] ?? null, permission: match[6], briefs: [...match[7].matchAll(/'([^']+)'/g)].map(entry => entry[1]) }))
if (roles.length < 14) throw new Error(`parsed only ${roles.length} roles from agent-roster.ts`)
// The owner's words, each mapped to the role key that must answer it.
const OWNER_NAMED = { 'swarm controller': 'swarm-orchestrator', reviewer: 'approval-reviewer', updater: 'updater', 'loop (runner)': 'loop-runner', 'loop improver': 'loop-improver', verifier: 'verifier', fixer: 'swarm-fixer', overseer: 'overseer' }
const briefFiles = Object.fromEntries(roles.flatMap(role => role.briefs).map(path => [path, readFileSync(join(REPO, path), 'utf8')]))

const logs = await mkdtemp(join(tmpdir(), 'vr8d-roster-'))
const claudeLog = join(logs, 'claude.jsonl')
const claudeEntries = async () => (await readFile(claudeLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))

try {
  const inst = await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', VR8D_CLAUDE_LOG: claudeLog } })
  const plain = await openProject({ name: 'Website without briefs', files: { 'index.html': '<h1>site</h1>\n' } })
  const plainId = plain.id
  const project = await openProject({ name: 'Roster project', git: true, files: briefFiles })
  const view = await page()
  const setting = key => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null } finally { db.close() } }
  /** The controller review routing reads (agent-control.ts linkFor: settings agentControlParent:<id>). */
  const controllerOf = id => { const raw = setting('agentControlParent:' + id); try { return raw ? JSON.parse(raw).controllerAgentSessionId ?? 'unparsed' : null } catch { return 'unparsed' } }
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id)?.projection_json ?? 'null') } finally { db.close() } }
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

  step('R1 control: a project without the briefs')
  await openAgents('Website without briefs')
  const plainCards = await cardsNow()
  step('R1: the roster project')
  await openAgents('Roster project')
  const cards = await cardsNow()
  const r1Shot = await shot(`${label}1-roster`)
  const sane = roles.map(role => {
    const card = cards.find(entry => entry.role === role.role)
    const missing = !card ? ['card'] : [role.name, role.model, role.briefs[0], ...(role.effort ? [role.effort] : [])].filter(part => !card.text.includes(part))
    return { role: role.role, missing, mode: card ? (/\b(Auto|Ask|Edit|Read only)\b/.exec(card.text)?.[1] ?? null) : null, whenToUse: card ? card.text.length > role.name.length + 60 : false }
  })
  const bad = sane.filter(entry => entry.missing.length || !entry.mode || !entry.whenToUse)
  const ownerMissing = Object.entries(OWNER_NAMED).filter(([, key]) => !cards.some(card => card.role === key)).map(([words]) => words)
  const conductorRolesInPlain = plainCards.filter(card => roles.some(role => role.role === card.role)).map(card => card.role)
  record(label + '1', !bad.length && !ownerMissing.length && cards.some(card => card.role === 'auto-fixer') && plainCards.some(card => card.role === 'auto-fixer') && !conductorRolesInPlain.length ? 'PASS' : 'FAIL',
    { roles: roles.length, cards: cards.length, ownerMissing: ownerMissing.join(',') || 'none', bad: bad.map(entry => `${entry.role}:${entry.missing.join('+') || ''}${entry.mode ? '' : ' no-mode'}${entry.whenToUse ? '' : ' no-when'}`).join('; ') || 'none', modes: Object.fromEntries(sane.map(entry => [entry.role, entry.mode])), plainProjectCards: plainCards.map(card => card.role).join(',') },
    `real brief files from the checkout; ${r1Shot}`)

  // "agents that we're using (i meant in loops etc and like reviewer ...)": every role a saved loop runs
  // (.conductor/loops/*.md steps) should have a roster entry that does that job.
  const LOOP_ROLE_TO_ROSTER = { implementer: 'swarm-fixer', churn: 'local-helper', verifier: 'verifier', controller: 'swarm-orchestrator', architect: 'architect', reviewer: 'code-reviewer' }
  const loopRoles = {}
  for (const file of ['batch-delivery', 'task-triage', 'update-readback', 'verify']) {
    const text = readFileSync(join(REPO, '.conductor/loops', file + '.md'), 'utf8').split(/\n---/)[0]
    for (const match of text.matchAll(/^\s+role: (\w[\w-]*)/gm)) (loopRoles[match[1]] ??= new Set()).add(file)
  }
  const uncovered = Object.keys(loopRoles).filter(role => !cards.some(card => card.role === (LOOP_ROLE_TO_ROSTER[role] ?? role)))
  record(label + '1b', uncovered.length ? 'FAIL' : 'PASS', { loopRoles: Object.fromEntries(Object.entries(loopRoles).map(([role, files]) => [role, [...files].join('+')])), uncovered: uncovered.join(',') || 'none' },
    'loop step roles vs roster cards; the Approval reviewer answers held tool approvals, it is not the batch-delivery diff reviewer')

  step('a wizard tab in the roster project (the owner\'s usual state)')
  const wizardTab = await openTab({ provider: 'claude', model: 'opus[1m]', title: 'Wizard' })
  const wizardId = wizardTab.resourceId
  await view.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true, model: 'opus[1m]' })
  }, wizardId)
  const wizardOn = (await view.evaluate(id => window.conductor.structured.snapshot(id), wizardId)).settings?.wizard === true
  // Control for the controller reading: a coworker the wizard opens itself, with its own credential.
  await view.evaluate(async id => { const state = await window.conductor.structured.snapshot(id); await window.conductor.structured.submit(id, 'VR8d wizard: hello', state.settings, []) }, wizardId)
  const briefing = await poll(async () => (await claudeEntries()).find(entry => entry.kind === 'prompt' && entry.prompt.includes('VR8d wizard: hello') && /Bearer [a-f0-9]{64}/.test(entry.prompt))?.prompt ?? null, { timeoutMs: 45_000, label: 'wizard app-control briefing' })
  const wizardAuth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  const wizardCall = async (method, args) => { const response = await fetch(wizardAuth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + wizardAuth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }); const body = await response.json(); if (response.status !== 200 || body.error) throw new Error(method + ' as wizard: ' + JSON.stringify(body.error ?? body).slice(0, 300)); return body.result }
  const wizardCoworker = await wizardCall('tabs.open', { kind: 'agent', provider: 'claude', model: 'sonnet', title: 'Wizard coworker' })
  const controlController = await poll(() => controllerOf(wizardCoworker.resourceId), { timeoutMs: 15_000, label: 'wizard coworker link' }).catch(() => null)

  const start = async (roleId, goal) => {
    await openAgents('Roster project')
    const card = view.locator(`.orchestration-agent-card[data-role="${roleId}"]`)
    const before = new Set((await call('tabs.list', {})).map(tab => tab.id))
    await card.locator('button.orchestration-start-agent').click()
    if (goal) await card.getByRole('textbox').fill(goal)
    await card.locator('.orchestration-agent-start button').click()
    const tab = await poll(async () => (await call('tabs.list', {})).find(entry => !before.has(entry.id) && entry.kind === 'agent') ?? null, { timeoutMs: 30_000, label: `${roleId} tab` }).catch(async error => { const shown = await view.locator('.orchestration-error').textContent().catch(() => null); throw new Error(`${error.message}; roster error: ${shown}`) })
    const prompt = await poll(() => (projection(tab.resourceId)?.items ?? []).map(item => item.data).find(item => item?.type === 'text' && item.role === 'user')?.text ?? null, { timeoutMs: 30_000, label: `${roleId} first message` })
    const spawnEntry = await poll(async () => {
      const entries = await claudeEntries()
      const prompted = entries.find(entry => entry.kind === 'prompt' && entry.prompt.includes(prompt.slice(0, 60)))
      return prompted ? entries.find(entry => entry.kind === 'spawn' && entry.pid === prompted.pid) ?? null : null
    }, { timeoutMs: 30_000, label: `${roleId} CLI spawn` }).catch(() => null)
    const snap = projection(tab.resourceId)
    const listed = (await call('agents.list', {})).find(entry => entry.agentSessionId === tab.resourceId) ?? null
    return { tab, prompt, settings: snap?.settings ?? {}, effective: snap?.capabilities?.effectiveSettings ?? null, spawn: spawnEntry, listed }
  }
  const summary = (result, role) => ({ title: result.tab.title, provider: result.tab.state?.provider ?? null, model: result.settings.model ?? null, effort: result.settings.effort ?? null, permission: result.settings.permission ?? null, cliModel: result.spawn?.model ?? null, cliPermissionMode: result.spawn?.permissionMode ?? null, cliEffort: result.spawn?.effort ?? null, effective: result.effective ? JSON.stringify(result.effective).slice(0, 200) : null, controller: controllerOf(result.tab.resourceId), markedApprovalReviewer: setting('approval-reviewer:' + result.tab.resourceId), briefsInPrompt: role.briefs.every(path => result.prompt.includes(path)) })
  const autoOk = result => result.settings.permission === 'auto' && result.spawn?.permissionMode === 'auto'

  step('R2: Start Verifier with a goal')
  const verifier = roles.find(role => role.role === 'verifier')
  const goal2 = 'VR8d goal: verify item 3477066e'
  const r2 = await start('verifier', goal2)
  const r2Sum = summary(r2, verifier)
  const r2Shot = await shot(`${label}2-verifier-started`)
  record(label + '2', wizardOn && r2.tab.state?.provider === 'claude' && r2.settings.model === 'opus[1m]' && r2.settings.effort === 'high' && autoOk(r2) && r2Sum.briefsInPrompt && r2.prompt.includes(`Goal: ${goal2}`) && r2Sum.controller === null && controlController === wizardId ? 'PASS' : 'FAIL',
    { wizardOn, ...r2Sum, controlCoworkerController: controlController === wizardId ? 'wizard' : controlController }, `first message: "${r2.prompt.replace(/\s+/g, ' ').slice(0, 400)}"; argv ${r2.spawn?.argv?.slice(0, 300) ?? 'n/a'}; ${r2Shot}`)

  step('R3: Start Fixer with a goal, then the Approval reviewer')
  const fixer = roles.find(role => role.role === 'swarm-fixer')
  const goal3 = 'VR8d goal: fix nothing, report the roster'
  const r3 = await start('swarm-fixer', goal3)
  const r3Sum = summary(r3, fixer)
  const reviewerRole = roles.find(role => role.role === 'approval-reviewer')
  const r3b = await start('approval-reviewer', 'VR8d goal: re-review nothing')
  const r3bSum = summary(r3b, reviewerRole)
  const r3Shot = await shot(`${label}3-fixer-and-reviewer`)
  record(label + '3', r3.settings.model === 'opus[1m]' && r3.settings.effort === 'high' && autoOk(r3) && r3Sum.briefsInPrompt && r3.prompt.includes(`Goal: ${goal3}`) ? 'PASS' : 'FAIL',
    { fixer: r3Sum, approvalReviewer: r3bSum }, `fixer first message: "${r3.prompt.replace(/\s+/g, ' ').slice(0, 300)}"; reviewer argv ${r3b.spawn?.argv?.slice(0, 300) ?? 'n/a'}; ${r3Shot}`)
  console.log(`project ${project.id}, plain ${plainId}`)
} catch (error) { await failed(error, label + '-error') }
await finish()
