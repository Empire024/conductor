// VR1 group board (feature-list.md processes-board-stale-working, token-accounting-repeated-context).
//   B1  settled coworkers never read Working: a detached subagent and a Bash task that never report
//       read Viewing, then "background task stuck" past the Bash task's declared 5 s timeout; a
//       finished coworker whose persisted row still says working (the owner's DB state) reads
//       Finished; a genuinely streaming one reads Working (the control).
//   T1  "61M tokens for one worker": 34 turns x 3 API calls re-reading 600k of cache, sent the way the
//       real CLI sends it (message_start usage, one assistant event per content block repeating the
//       message's usage, a turn result with the aggregate). Headline = processed, not 61M.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr1-board.mjs
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr1-board', output: 'artifacts/verification/2026-09-25-vr1' })
watchdog(15 * 60)
const TURNS = 34, CALLS = 3, CALL = { input: 2000, cacheRead: 600_000, cacheWrite: 3000, output: 1500 }

const fixture = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'vr1-board-' + randomUUID()
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
const CALL = ${JSON.stringify(CALL)}, CALLS = ${CALLS}
const usage = (output) => ({ input_tokens: CALL.input, cache_read_input_tokens: CALL.cacheRead, cache_creation_input_tokens: CALL.cacheWrite, output_tokens: output })
const text = (id, content, withUsage) => emit({ type: 'assistant', message: { id, model: 'synthetic-claude', content: [{ type: 'text', text: content }], ...(withUsage ? { usage: usage(CALL.output) } : {}) } })
const tool = (id, toolId, name, input, withUsage) => emit({ type: 'assistant', message: { id, model: 'synthetic-claude', content: [{ type: 'tool_use', id: toolId, name, input }], ...(withUsage ? { usage: usage(CALL.output) } : {}) } })
const toolResult = (toolId, content) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] } })
const done = (u = {}) => emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: u })
let turn = 0
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic Claude fixture' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : String(blocks)
  turn++
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude', session_id: session })
  if (prompt.startsWith('VR1 USAGE')) {
    for (let call = 0; call < CALLS; call++) {
      const id = 'msg-' + turn + '-' + call
      emit({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'synthetic-claude', usage: usage(1) } } })
      emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: CALL.output } } })
      emit({ type: 'stream_event', event: { type: 'message_stop' } })
      text(id, 'Reading the file again, call ' + call, true)
      if (call < CALLS - 1) { const toolId = 'read-' + turn + '-' + call; tool(id, toolId, 'Read', { file_path: 'big.md' }, true); toolResult(toolId, 'SYNTHETIC file contents') }
    }
    return done({ input_tokens: CALL.input * CALLS, cache_read_input_tokens: CALL.cacheRead * CALLS, cache_creation_input_tokens: CALL.cacheWrite * CALLS, output_tokens: CALL.output * CALLS })
  }
  if (prompt.startsWith('VR1 DETACHED')) {
    tool('m-' + turn, 'agent-1', 'Task', { description: 'Detached subagent', prompt: 'SYNTHETIC', run_in_background: true })
    emit({ type: 'system', subtype: 'task_started', task_id: 'task-agent-1', tool_use_id: 'agent-1', description: 'Detached subagent', is_backgrounded: true, task_type: 'local_agent', status: 'running' })
    tool('m2-' + turn, 'bash-1', 'Bash', { command: 'node render.mjs', description: 'Long render', run_in_background: true, timeout: 5000 })
    emit({ type: 'system', subtype: 'task_started', task_id: 'task-bash-1', tool_use_id: 'bash-1', description: 'Long render', is_backgrounded: true, task_type: 'local_bash', status: 'running' })
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-agent-1', tool_use_id: 'agent-1', task_type: 'local_agent', description: 'Detached subagent' }, { task_id: 'task-bash-1', tool_use_id: 'bash-1', task_type: 'local_bash', description: 'Long render' }] })
    toolResult('agent-1', 'Async agent launched in the background')
    toolResult('bash-1', 'Command running in background with ID: task-bash-1')
    text('m3-' + turn, 'Both are running in the background; they never report.')
    return done({ input_tokens: 100, output_tokens: 20 })
  }
  if (prompt.startsWith('VR1 STREAM')) {
    const id = 'stream-' + turn
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    for (let i = 0; i < 1200; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } }); await wait(250) }
    return
  }
  text('done-' + turn, 'Finished its work.')
  done({ input_tokens: 100, output_tokens: 20 })
})
`

try {
  await loadCheck()
  const inst = await launchParked({ mode: 'playwright', name: 'vr1-board', fixtures: { 'fake-claude.mjs': fixture }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'VR1 board', git: true })
  const view = await page()
  const status = async id => (await call('agents.status', { agentSessionId: id })).phase
  const start = async (title, prompt, settle = true) => {
    const tab = await openTab({ provider: 'claude', title })
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt })
    // agents.status reads 'viewing' for a settled turn with background tasks (displaySessionPhase).
    if (settle) await poll(async () => ['completed', 'viewing'].includes(await status(tab.resourceId)), { timeoutMs: 30_000, label: `${title} to settle` })
    return tab.resourceId
  }
  step('B1 coworkers')
  const viewing = await start('P detached', 'VR1 DETACHED')
  const finishedId = await start('Q finished', 'VR1 DONE')
  step('T1 34 turns')
  const usageId = await start('T worker', 'VR1 USAGE 1')
  for (let index = 2; index <= TURNS; index++) {
    await call('agents.submit', { agentSessionId: usageId, prompt: `VR1 USAGE ${index}` })
    await poll(async () => { const snap = await view.evaluate(id => window.conductor.structured.snapshot(id), usageId); return snap?.phase === 'completed' && snap.items.filter(item => item.data.type === 'usage' && item.data.scope === 'turn').length >= index }, { timeoutMs: 30_000, label: `turn ${index}` })
  }
  const streaming = await start('R streaming', 'VR1 STREAM', false)
  await poll(async () => (await status(streaming)) === 'running', { timeoutMs: 30_000, label: 'R to run' })

  // The owner's database held these rows at 'working' long after the turn ended.
  const db = new DatabaseSync(join(inst.profile, 'conductor.db'))
  const columns = db.prepare('PRAGMA table_info(agent_sessions)').all().map(column => column.name)
  try { db.prepare("UPDATE agent_sessions SET status = 'running', activity_phase = 'working' WHERE id = ?").run(finishedId) } finally { db.close() }

  await view.getByRole('button', { name: 'Processes', exact: true }).click()
  const board = view.locator('.pd-dashboard').first()
  await board.waitFor()
  const row = id => board.locator(`[data-process-id="${id}"]`)
  const stateText = async id => (await row(id).locator('.pd-state').innerText()).replace(/\s+/g, ' ').trim()
  // Two board polls (2.5 s each) past the Bash task's declared 5 s timeout.
  await sleep(9000)
  const states = { P: await stateText(viewing), Q: await stateText(finishedId), T: await stateText(usageId), R: await stateText(streaming) }
  const workingRows = await board.locator('.pd-row.state-working').evaluateAll(rows => rows.map(node => node.getAttribute('data-process-id')))
  const b1Shot = await shot('vr1-B1-board')
  const control = states.R.startsWith('Working')
  record('B1', control && /^Viewing/.test(states.P) && /^Finished .*ago/.test(states.Q) && workingRows.length === 1 && workingRows[0] === streaming ? 'PASS' : 'FAIL',
    { states, workingRows: workingRows.length, agentSessionColumns: columns.filter(name => /status|phase|updated/.test(name)) }, `control: streaming R reads "${states.R}"; ${b1Shot}`)
  // The fixer's claim: stuck "past its declared timeout". P's Bash task declared timeout 5000.
  const snapP = await view.evaluate(id => window.conductor.structured.snapshot(id), viewing)
  const detachedRows = snapP.items.filter(item => item.data.detached).map(item => `${item.data.type}:${item.data.name ?? ''}:${item.data.status}`)
  record('B1-declared', /background task stuck/.test(states.P) ? 'PASS' : 'FAIL', { stateP: states.P, secondsSinceStart: Math.round((Date.now() - Date.parse(snapP.items.find(item => item.data.name === 'Bash')?.timestamp ?? '')) / 1000), detachedRows },
    'pass: "background task stuck" shown once the Bash task is past its declared 5 s timeout; control: B1-stuck (same row, 36 min later)')

  step('T1 read the board row')
  const usage = row(usageId).locator('.pd-usage')
  const headline = (await usage.locator('strong').innerText()).trim()
  const detail = (await usage.locator('small').innerText()).trim()
  const title = await usage.getAttribute('title') ?? ''
  const figure = label => Number((new RegExp(label + ' ([\\d,]+)').exec(title)?.[1] ?? 'NaN').replace(/,/g, ''))
  const shown = { newInput: figure('New input'), cacheWrite: figure('Cache write'), output: figure('Output'), cacheRead: figure('Cache reads'), providerTotal: figure('Provider total') }
  const expected = { processed: TURNS * CALLS * (CALL.input + CALL.cacheWrite + CALL.output), cacheRead: TURNS * CALLS * CALL.cacheRead }
  const processed = shown.newInput + shown.cacheWrite + shown.output
  const headlineValue = (() => { const match = /^([\d.]+)\s*([kM]?)/.exec(headline); return match ? Number(match[1]) * ({ k: 1e3, M: 1e6 }[match[2]] ?? 1) : NaN })()
  const overview = (await board.locator('.pd-overview').innerText()).replace(/\s+/g, ' ')
  const t1Shot = await shot('vr1-T1-board')
  const controlT1 = shown.cacheRead === expected.cacheRead
  record('T1', controlT1 && Math.abs(processed - expected.processed) <= expected.processed * 0.02 && Math.abs(headlineValue - expected.processed) <= expected.processed * 0.02 && headlineValue < 1e6 ? 'PASS' : 'FAIL',
    { headline, detail, shown, processed, expected, overview }, `control: cache reads shown ${shown.cacheRead} = sent ${expected.cacheRead}; ${t1Shot}`)

  // B1-stuck: the owner's "background task stuck 5 h" check. The board ages tasks with the
  // renderer's Date.now(); move it 36 min on (past the 30 min default) and let the board re-render.
  step('B1-stuck: renderer clock +36 min')
  await view.clock.setSystemTime(Date.now() + 36 * 60_000)
  const stuckState = await poll(async () => { const text = await stateText(viewing); return /background task stuck 3\dm/.test(text) ? text : null }, { timeoutMs: 20_000, intervalMs: 1000, label: 'the stuck label' }).catch(() => stateText(viewing))
  const stuckShot = await shot('vr1-B1-stuck')
  record('B1-stuck', /^Viewing background task stuck 3\dm/.test(stuckState) ? 'PASS' : 'FAIL', { stateP: stuckState, stateR: await stateText(streaming) }, `renderer clock moved 36 min with Playwright page.clock.setSystemTime; ${stuckShot}`)
  await call('agents.interrupt', { agentSessionId: streaming }).catch(() => {})
} catch (error) {
  await failed(error, 'vr1-board')
}
await finish()
