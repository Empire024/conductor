import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { devLayout, installedUserData, readCredential, userDataFor, validateCredential } from './overseer/credentials.mjs'
import { ControlError, createControlClient } from './overseer/control-client.mjs'
import { loadGoal, normalizeGoal, prepareProjectFolder, validateGoal } from './overseer/goal.mjs'
import { evaluateRun, findValidatedArtifact, projectItems, resolveArtifactOutputs, runOracle } from './overseer/evaluate.mjs'
import { buildFixerPrompt, chooseClaudeModel, dispatchFixer, findMarker, parseMarker } from './overseer/fixer.mjs'
import { waitSettled, LOCAL_SETTLED } from './overseer/agent-wait.mjs'
import { fetchAllHistory, serverLogName, timelineLine, writeEvidence } from './overseer/evidence.mjs'
import { EXIT, runLoop } from './overseer/loop.mjs'
import { countTargets } from './overseer/oracles/faktury.mjs'
import { parseArgs } from './overseer.mjs'

const temp = prefix => mkdtemp(resolve(tmpdir(), `conductor-overseer-${prefix}-`))
const TOKEN = 'ab'.repeat(32)
const credential = (extra = {}) => ({ version: 1, endpoint: 'http://127.0.0.1:45678/control', token: TOKEN, pid: 4242, startedAt: '2026-09-23T10:00:00.000Z', appVersion: '0.1.9', packaged: true, ...extra })

const baseGoal = () => normalizeGoal({
  id: 'synthetic-goal',
  title: 'Synthetic goal',
  project: { name: 'synthetic', path: resolve(tmpdir(), 'synthetic-source'), inputs: ['data2.txt'] },
  worker: { provider: 'local', model: 'local/ornith1.5-9b', permission: 'accept-edits' },
  prompt: 'Find the payments.',
  success: { phases: ['completed'], stopReasons: ['completed'], answerMatches: ['Validated \\d+ targets'], answerRejects: ['Could not complete the task'], requireValidatedArtifact: true, maxLoopWarnings: 2 },
  fixer: { focus: ['src/main/local-models/'], notes: 'Synthetic background note.' }
}, 'synthetic.json')

// ---------------------------------------------------------------- credentials

test('credential locations: installed profile under APPDATA, dev profile inside artifacts/overseer', () => {
  assert.equal(installedUserData({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), join('C:\\Users\\x\\AppData\\Roaming', 'Conductor'))
  assert.throws(() => installedUserData({}), /APPDATA/)
  const layout = devLayout('C:\\checkout')
  assert.equal(layout.userData, resolve('C:\\checkout', 'artifacts', 'overseer', 'profile'))
  assert.equal(layout.projectsRoot, resolve('C:\\checkout', 'artifacts', 'overseer', 'projects'))
  assert.equal(userDataFor('installed', { env: { APPDATA: 'D:\\r' } }), join('D:\\r', 'Conductor'))
  assert.equal(userDataFor('dev', { checkout: 'C:\\checkout' }), layout.userData)
})

test('credential validation rejects wrong shapes and non-loopback endpoints', () => {
  assert.deepEqual(validateCredential(credential()), [])
  assert.match(validateCredential(credential({ version: 2 })).join(), /version/)
  assert.match(validateCredential(credential({ endpoint: 'http://example.com:1/control' })).join(), /endpoint/)
  assert.match(validateCredential(credential({ token: 'not hex!' })).join(), /token/)
  assert.match(validateCredential(credential({ pid: -1 })).join(), /pid/)
  assert.deepEqual(validateCredential([]), ['credential is not a JSON object'])
})

test('reading a credential: missing, corrupt, stale pid, live', async () => {
  const dir = await temp('cred')
  assert.match((await readCredential(dir)).reason, /no credential file/)
  await writeFile(join(dir, 'control-owner.json'), '{nope')
  assert.match((await readCredential(dir)).reason, /not valid JSON/)
  await writeFile(join(dir, 'control-owner.json'), '\uFEFF' + JSON.stringify(credential()))
  const stale = await readCredential(dir, { isAlive: () => false })
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true)
  assert.match(stale.reason, /stale credential: pid 4242/)
  const live = await readCredential(dir, { isAlive: pid => pid === 4242 })
  assert.equal(live.ok, true)
  assert.equal(live.credential.token, TOKEN)
})

// ---------------------------------------------------------------- control client

async function fakeServer(handler) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body || '{}')
      requests.push({ headers: request.headers, body: parsed })
      const { status = 200, payload, delay = 0 } = await handler(parsed, request)
      setTimeout(() => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }, delay)
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { endpoint: `http://127.0.0.1:${server.address().port}/control`, requests, close: () => new Promise(done => server.close(done)) }
}

test('control client sends the bearer token, injects scope and maps errors', async () => {
  const server = await fakeServer(body => {
    if (body.method === 'bad.method') return { status: 400, payload: { error: 'Unknown method' } }
    if (body.method === 'soft.error') return { status: 200, payload: { error: 'refused politely' } }
    return { payload: { result: { echo: body } } }
  })
  try {
    const scope = { projectId: 'p1', workspaceId: 'w1' }
    const client = createControlClient({ endpoint: server.endpoint, token: TOKEN, scope })
    const result = await client.call('tools.list')
    assert.deepEqual(result.echo, { method: 'tools.list', args: {}, scope })
    assert.equal(server.requests[0].headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(server.requests[0].headers['content-type'], 'application/json')
    assert.equal((await client.call('x', { a: 1 }, null)).echo.scope, undefined)
    assert.deepEqual((await client.call('x', {}, { projectId: 'p2', workspaceId: 'w2' })).echo.scope, { projectId: 'p2', workspaceId: 'w2' })
    assert.deepEqual((await client.withScope({ projectId: 'p3', workspaceId: 'w3' }).call('x')).echo.scope, { projectId: 'p3', workspaceId: 'w3' })
    await assert.rejects(client.call('bad.method'), error => error instanceof ControlError && error.status === 400 && /Unknown method/.test(error.message))
    await assert.rejects(client.call('soft.error'), /refused politely/)
  } finally { await server.close() }
})

test('control client reports 401 and an unreachable app distinctly', async () => {
  const server = await fakeServer(() => ({ status: 401, payload: { error: 'Unauthorized' } }))
  const endpoint = server.endpoint
  try {
    const client = createControlClient({ endpoint, token: TOKEN })
    await assert.rejects(client.call('tools.list'), error => error.code === 'unauthorized' && /401/.test(error.message))
  } finally { await server.close() }
  const gone = createControlClient({ endpoint, token: TOKEN, timeoutMs: 3000 })
  await assert.rejects(gone.call('tools.list'), error => error.code === 'unreachable' || error.code === 'timeout')
})

test('control client serializes concurrent calls to one app', async () => {
  let active = 0, peak = 0
  const server = await fakeServer(async body => {
    active++; peak = Math.max(peak, active)
    await new Promise(done => setTimeout(done, 30))
    active--
    return { payload: { result: body.args.n } }
  })
  try {
    const client = createControlClient({ endpoint: server.endpoint, token: TOKEN })
    const results = await Promise.all([1, 2, 3, 4].map(n => client.call('agents.status', { n })))
    assert.deepEqual(results, [1, 2, 3, 4])
    assert.equal(peak, 1)
    assert.deepEqual(server.requests.map(request => request.body.args.n), [1, 2, 3, 4])
    // A failing call does not wedge the queue.
    const failing = createControlClient({ endpoint: server.endpoint.replace(/:\d+/, ':1'), token: TOKEN, timeoutMs: 2000 })
    await assert.rejects(failing.call('a'))
    await assert.rejects(failing.call('b'))
  } finally { await server.close() }
})

// ---------------------------------------------------------------- goals

test('goal validation names every problem', () => {
  assert.deepEqual(validateGoal(null), ['goal must be a JSON object'])
  const errors = validateGoal({ id: 'bad id!', project: { name: 'a/b', path: 'relative', inputs: ['../x'] }, worker: { provider: 'local', model: 'm' }, success: { answerMatches: ['('], maxLoopWarnings: -1 }, fixer: { provider: 'codex' } })
  const text = errors.join('\n')
  for (const expected of [/id must be/, /title is required/, /prompt is required/, /project.name/, /project.path must be an absolute/, /\.\.\/x/, /accept-edits/, /invalid pattern/, /maxLoopWarnings/, /fixer.provider/]) assert.match(text, expected)
  const good = baseGoal()
  assert.deepEqual(validateGoal(good), [])
})

test('shipped goal files are valid', async () => {
  for (const name of ['local-qwen-faktury.json', 'local-dolphin-tools.json']) {
    const goal = await loadGoal(resolve('scripts/overseer/goals', name))
    assert.equal(goal.worker.provider, 'local')
    assert.ok(goal.fixer.notes.length > 40)
  }
  await assert.rejects(loadGoal(resolve('scripts/overseer/goals/missing.json')), /file not found/)
})

test('dev project folders are recreated from inputs only, installed uses the real folder', async () => {
  const root = await temp('goal')
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'data2.txt'), 'input')
  await writeFile(join(source, 'secret.txt'), 'not an input')
  const goal = { ...baseGoal(), project: { name: 'synthetic', path: source, inputs: ['data2.txt'] } }
  const projectsRoot = join(root, 'projects')
  await mkdir(join(projectsRoot, 'synthetic', '.conductor-scratch'), { recursive: true })
  await writeFile(join(projectsRoot, 'synthetic', 'leftover.txt'), 'old')
  const folder = await prepareProjectFolder(goal, { target: 'dev', projectsRoot })
  assert.equal(folder, join(projectsRoot, 'synthetic'))
  assert.equal(await readFile(join(folder, 'data2.txt'), 'utf8'), 'input')
  await assert.rejects(readFile(join(folder, 'leftover.txt')))
  await assert.rejects(readFile(join(folder, 'secret.txt')))
  assert.equal(await prepareProjectFolder(goal, { target: 'installed', projectsRoot }), source)
})

// ---------------------------------------------------------------- evaluation

const artifactOutput = statuses => JSON.stringify({ result: { outcomes: statuses.map((status, index) => ({ target: index, status })) } })
function syntheticRun({ statuses = ['matched', 'ambiguous', 'not_found', 'matched'], answer = 'Validated 4 targets. Dates: ...', stop = { reason: 'completed', detail: 'done', rounds: 6, hardLimit: 40, loopWarnings: 0 }, phase = 'completed', artifact = true } = {}) {
  const events = [
    { sequence: 1, timestamp: '2026-09-23T10:00:00.000Z', itemId: 'u1', data: { type: 'text', role: 'user', mode: 'snapshot', text: 'Find the payments.' } },
    { sequence: 2, timestamp: '2026-09-23T10:00:01.000Z', itemId: 't1', data: { type: 'tool', name: 'process_files', status: 'running', input: { files: ['data2.txt'] } } },
    { sequence: 3, timestamp: '2026-09-23T10:00:02.000Z', itemId: 't1', data: { type: 'tool', name: 'process_files', status: artifact ? 'completed' : 'failed', output: artifact ? artifactOutput(statuses) : 'error: unrecognized format', outputMode: 'snapshot' } },
    { sequence: 4, timestamp: '2026-09-23T10:00:03.000Z', itemId: 'a1', data: { type: 'text', role: 'assistant', mode: 'delta', text: answer.slice(0, 5) } },
    { sequence: 5, timestamp: '2026-09-23T10:00:03.500Z', itemId: 'a1', data: { type: 'text', role: 'assistant', mode: 'delta', text: answer.slice(5) } },
    { sequence: 6, timestamp: '2026-09-23T10:00:04.000Z', data: { type: 'notice', message: 'Completed', payload: { localStop: stop } } }
  ]
  return { status: { phase, stop, lastAnswer: answer.slice(-600), lastTool: { name: 'process_files', status: 'completed' }, lastError: null, sequence: 6 }, events }
}

test('predicate passes a clean validated run and counts outcomes', () => {
  const { status, events } = syntheticRun()
  const items = projectItems(events)
  assert.equal(items.length, 4)
  assert.equal(items[2].data.text, 'Validated 4 targets. Dates: ...')
  const evaluation = evaluateRun({ goal: baseGoal(), status, events })
  assert.deepEqual(evaluation.failures, [])
  assert.equal(evaluation.pass, true)
  assert.deepEqual(evaluation.counts.outcomes, { total: 4, matched: 2, ambiguous: 1, not_found: 1 })
  assert.equal(evaluation.counts.toolCalls, 1)
})

test('predicate fails on a blocked outcome, a rejected answer, a missing artifact and loop warnings', () => {
  const blocked = syntheticRun({ statuses: ['matched', 'blocked'] })
  assert.match(evaluateRun({ goal: baseGoal(), ...blocked }).failures.join(), /1 blocked outcome/)
  const rejected = syntheticRun({ answer: 'Could not complete the task because the file was odd.' })
  const rejectedFailures = evaluateRun({ goal: baseGoal(), ...rejected }).failures.join('\n')
  assert.match(rejectedFailures, /rejected text/)
  assert.match(rejectedFailures, /does not match/)
  const missing = syntheticRun({ artifact: false })
  assert.match(evaluateRun({ goal: baseGoal(), ...missing }).failures.join(), /no validated process_files artifact/)
  const looping = syntheticRun({ stop: { reason: 'stagnation', detail: 'repeating', rounds: 57, hardLimit: 60, loopWarnings: 5 }, phase: 'failed' })
  const text = evaluateRun({ goal: baseGoal(), ...looping }).failures.join('\n')
  assert.match(text, /phase is "failed"/)
  assert.match(text, /stop reason stagnation \(repeating\)/)
  assert.match(text, /5 loop warnings, at most 2/)
  const noStop = syntheticRun()
  noStop.status.stop = null
  assert.match(evaluateRun({ goal: baseGoal(), ...noStop }).failures.join(), /no local stop report/)
})

test('oracle: missing module is skipped, faktury oracle compares target lines with outcomes', async () => {
  const skipped = await runOracle({ ...baseGoal(), success: { oracle: 'scripts/overseer/oracles/nope.mjs' } }, {})
  assert.equal(skipped.skipped, true)
  assert.match(skipped.notes[0], /not found/)
  assert.equal(countTargets('a\tb\tc\td\tx\r\nZobrazit PDF\r\na\tb\tc\td\r\n\r\nshort\tline\n'), 2)
  const dir = await temp('oracle')
  await writeFile(join(dir, 'data2.txt'), '1\t2026-09-22\tA s.r.o.\t72000.00 CZK\tx\r\nZobrazit PDF\r\n2\t2026-08-26\tB s.r.o.\t74000.00 CZK\tx\r\n')
  const goal = { ...baseGoal(), success: { oracle: 'scripts/overseer/oracles/faktury.mjs' } }
  const pass = await runOracle(goal, { projectPath: dir, artifact: { outcomes: [{}, {}] } })
  assert.equal(pass.pass, true)
  const fail = await runOracle(goal, { projectPath: dir, artifact: { outcomes: [{}] } })
  assert.equal(fail.pass, false)
  assert.match(fail.notes.join(), /2 target line/)
  const { status, events } = syntheticRun()
  assert.match(evaluateRun({ goal: baseGoal(), status, events, oracle: fail }).failures.join(), /oracle failed/)
})

// ---------------------------------------------------------------- evidence

test('history pages until a short page and evidence files are written', async () => {
  const all = Array.from({ length: 230 }, (_, index) => ({ sequence: index + 1, timestamp: '2026-09-23T10:00:00.000Z', data: { type: 'text', role: 'assistant', mode: 'delta', text: 'x' } }))
  const calls = []
  const call = async (method, args) => { calls.push(args.afterSequence); return all.filter(event => event.sequence > args.afterSequence).slice(0, 100) }
  const events = await fetchAllHistory(call, 's1')
  assert.equal(events.length, 230)
  assert.deepEqual(calls, [0, 100, 200])
  assert.equal(serverLogName('local/ornith1.5-9b'), 'local_ornith1.5-9b.log')
  const line = timelineLine({ sequence: 3, timestamp: '2026-09-23T10:00:02.000Z', data: { type: 'tool', name: 'run_command', status: 'failed', input: { command: 'x'.repeat(1000) }, output: 'y'.repeat(5000) } })
  assert.match(line, /^10:00:02 #3 tool run_command \[failed\]/)
  assert.ok(line.length < 2000)
  const root = await temp('evidence')
  await mkdir(join(root, 'local', 'logs'), { recursive: true })
  await writeFile(join(root, 'local', 'logs', 'local_ornith1.5-9b.log'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'))
  const { status, events: runEvents } = syntheticRun()
  const files = await writeEvidence(join(root, 'out'), { status, events: runEvents, answer: 'A', evaluation: { pass: true }, modelId: 'local/ornith1.5-9b', env: { CONDUCTOR_LOCAL_ROOT: join(root, 'local') } })
  assert.equal((await readFile(files.events, 'utf8')).trim().split('\n').length, runEvents.length)
  const tail = (await readFile(files.serverLog, 'utf8')).trim().split('\n')
  assert.equal(tail.length, 200)
  assert.equal(tail.at(-1), 'line 299')
  assert.match(await readFile(files.timeline, 'utf8'), /process_files \[completed\]/)
})

// ---------------------------------------------------------------- fixer

test('fixer prompt carries the goal, the failures, the evidence paths and the contract', () => {
  const { status } = syntheticRun({ stop: { reason: 'round_limit', detail: '57 rounds', rounds: 57, hardLimit: 57, loopWarnings: 3, compactions: 2, context: { usedTokens: 30000, capacityTokens: 31000 } }, answer: 'I could not parse data.csv' })
  status.lastError = 'run_command refused command with runtime'
  const prompt = buildFixerPrompt({
    goal: baseGoal(), iteration: 2, iterations: 5, checkout: 'C:\\Claude\\conductor',
    result: { status, failures: ['stop reason round_limit'], evidenceDir: 'D:\\run\\iteration-2\\synthetic-goal', evidenceFiles: { timeline: 'D:\\run\\timeline.md', serverLog: 'D:\\run\\server-log-tail.txt' }, evaluation: { oracle: { notes: ['data2.txt has 4 target lines'] } } }
  })
  for (const expected of ['autonomous fixer dispatched by the Conductor overseer', 'iteration 2 of 5', 'Synthetic goal', 'Find the payments.', 'local/ornith1.5-9b', 'stop reason round_limit', 'round_limit: 57 rounds', 'loop warnings 3', 'run_command refused command with runtime', 'I could not parse data.csv', 'D:\\run\\timeline.md', 'server-log-tail.txt', 'data2.txt has 4 target lines', 'AGENTS.md', 'docs/overseer.md', 'npm run dev', 'git.ship({message, paths:', 'git.ship.status', 'Never publish', 'src/main/local-models/', 'Synthetic background note.', 'OVERSEER_RESULT: fixed', 'OVERSEER_RESULT: blocked', 'OVERSEER_RESULT: no-change']) assert.ok(prompt.includes(expected), `prompt lacks ${expected}`)
})

test('marker parsing: fixed, blocked, no-change, last one wins, history fallback', () => {
  assert.deepEqual(parseMarker('Done.\nOVERSEER_RESULT: fixed parser accepts quoted semicolons (abc123)'), { result: 'fixed', summary: 'parser accepts quoted semicolons (abc123)' })
  assert.deepEqual(parseMarker('**OVERSEER_RESULT: blocked** needs the owner to pick a model'), { result: 'blocked', summary: 'needs the owner to pick a model' })
  assert.deepEqual(parseMarker('`OVERSEER_RESULT: no-change` flaky run'), { result: 'no-change', summary: 'flaky run' })
  assert.equal(parseMarker('I will end with OVERSEER_RESULT later'), null)
  assert.equal(parseMarker('no marker here'), null)
  assert.equal(parseMarker('OVERSEER_RESULT: maybe'), null)
  assert.equal(parseMarker('OVERSEER_RESULT: blocked x\nlater\nOVERSEER_RESULT: fixed y').result, 'fixed')
  const events = [
    { sequence: 1, itemId: 'a', data: { type: 'text', role: 'assistant', mode: 'snapshot', text: 'Working.\nOVERSEER_RESULT: fixed committed 1234' } },
    { sequence: 2, itemId: 'b', data: { type: 'text', role: 'assistant', mode: 'snapshot', text: 'Shipped; the delivery settled.' } }
  ]
  assert.deepEqual(findMarker({ lastAnswer: 'Shipped; the delivery settled.' }, events), { result: 'fixed', summary: 'committed 1234', source: 'history' })
  assert.equal(findMarker({ lastAnswer: 'OVERSEER_RESULT: blocked owner' }, events).source, 'lastAnswer')
})

test('fixer model choice prefers the exact id, then any opus, then the default', () => {
  const catalog = [{ provider: 'codex', models: [{ id: 'opus-lookalike' }] }, { provider: 'claude', available: true, models: [{ id: 'sonnet', isDefault: true }, { id: 'claude-opus-5-5' }, { id: 'opus' }] }]
  assert.equal(chooseClaudeModel(catalog, 'opus'), 'opus')
  assert.equal(chooseClaudeModel(catalog, 'missing'), 'claude-opus-5-5')
  assert.equal(chooseClaudeModel([{ provider: 'claude', models: [{ id: 'haiku' }, { id: 'sonnet', isDefault: true }] }], 'opus'), 'sonnet')
})

function fakeFixerApp({ answers, commit = true }) {
  const calls = []
  let phase = 'idle', sequence = 1, polls = 0
  const state = { head: 'aaa' }
  const call = async (method, args) => {
    calls.push(method)
    if (method === 'models.list') return [{ provider: 'claude', models: [{ id: 'opus' }] }]
    if (method === 'tabs.open') return { id: 'tab-f', resourceId: 'fix-1' }
    if (method === 'agents.submit') { phase = 'running'; sequence++; return {} }
    if (method === 'agents.status') {
      if (phase === 'running' && ++polls >= 2) { phase = 'completed'; sequence++; if (commit) state.head = 'bbb' }
      return { phase, sequence, lastAnswer: phase === 'completed' ? answers.lastAnswer : null }
    }
    if (method === 'agents.history') return answers.history ?? []
    if (method === 'agents.interrupt') return {}
    throw new Error('unexpected ' + method)
  }
  return { app: { call, scope: { projectId: 'p', workspaceId: 'w' } }, calls, head: () => state.head }
}

test('fixer dispatch waits, reads the marker, and demotes a fixed claim when HEAD did not move', async () => {
  const noSleep = async () => {}
  const moved = fakeFixerApp({ answers: { lastAnswer: 'OVERSEER_RESULT: fixed tightened the parser' } })
  const verdict = await dispatchFixer({ app: moved.app, goal: baseGoal(), iteration: 1, iterations: 5, result: {}, checkout: 'C:\\c', head: moved.head, sleep: noSleep })
  assert.equal(verdict.result, 'fixed')
  assert.equal(verdict.headBefore, 'aaa')
  assert.equal(verdict.headAfter, 'bbb')
  assert.equal(verdict.model, 'opus')
  const still = fakeFixerApp({ answers: { lastAnswer: 'OVERSEER_RESULT: fixed but forgot to ship' }, commit: false })
  const demoted = await dispatchFixer({ app: still.app, goal: baseGoal(), iteration: 1, iterations: 5, result: {}, checkout: 'C:\\c', head: still.head, sleep: noSleep })
  assert.equal(demoted.result, 'no-change')
  assert.match(demoted.summary, /HEAD did not move/)
  const fromHistory = fakeFixerApp({ answers: { lastAnswer: 'Done.', history: [{ sequence: 3, itemId: 'x', data: { type: 'text', role: 'assistant', mode: 'snapshot', text: 'OVERSEER_RESULT: blocked needs a GPU decision' } }] } })
  const blocked = await dispatchFixer({ app: fromHistory.app, goal: baseGoal(), iteration: 1, iterations: 5, result: {}, checkout: 'C:\\c', head: fromHistory.head, sleep: noSleep })
  assert.equal(blocked.result, 'blocked')
  assert.ok(fromHistory.calls.includes('agents.history'))
})

test('waiting treats idle before the turn starts as not settled and times out', async () => {
  let clock = 0
  const phases = ['idle', 'idle', 'running', 'running', 'completed']
  let index = 0
  const call = async () => ({ phase: phases[Math.min(index++, phases.length - 1)], sequence: index > 2 ? 5 : 1 })
  const done = await waitSettled({ call, agentSessionId: 's', settled: new Set(['completed', 'idle']), baselineSequence: 1, pollMs: 1, timeoutMs: 1e9, now: () => clock, sleep: async () => { clock += 1 } })
  assert.equal(done.status.phase, 'completed')
  assert.equal(done.timedOut, false)
  const forever = await waitSettled({ call: async () => ({ phase: 'running', sequence: 2 }), agentSessionId: 's', settled: LOCAL_SETTLED, pollMs: 1000, timeoutMs: 5000, now: () => clock, sleep: async ms => { clock += ms } })
  assert.equal(forever.timedOut, true)
})

// ---------------------------------------------------------------- loop

function fakeLoop({ outcomes, fixerVerdicts = [], buildOk = true }) {
  const log = []
  const trace = []
  const runs = { ...outcomes }
  let writes = 0, lastState = null
  const deps = {
    log: message => log.push(message),
    writeRun: async state => { writes++; lastState = JSON.parse(JSON.stringify(state)) },
    ensureTarget: async () => { trace.push('ensure') },
    runGoal: async (goal, n) => {
      trace.push(`run:${goal.id}:${n}`)
      const pass = runs[goal.id].shift()
      return { goalId: goal.id, pass, failures: pass ? [] : ['stop reason round_limit'], evidenceDir: `run/iteration-${n}/${goal.id}`, agentSessionId: `s-${goal.id}-${n}`, tabId: `t-${n}`, status: { phase: pass ? 'completed' : 'failed' }, evaluation: null }
    },
    dispatchFixer: async (goal, n) => { trace.push(`fix:${goal.id}:${n}`); return { goalId: goal.id, ...fixerVerdicts.shift() } },
    build: async n => { trace.push(`build:${n}`); return { ok: buildOk, exitCode: buildOk ? 0 : 1, tail: buildOk ? '' : 'tsc error', logPath: 'build.log' } },
    reloadTarget: async n => { trace.push(`reload:${n}`); return { ok: true } },
    deliver: async () => { trace.push('deliver'); return { ok: true, stage: 'published' } }
  }
  return { deps, log, trace, state: () => lastState, writes: () => writes }
}
const goalA = { ...baseGoal(), id: 'goal-a' }
const goalB = { ...baseGoal(), id: 'goal-b' }

test('loop: passes on the first try without fixers, and delivers when asked', async () => {
  const fake = fakeLoop({ outcomes: { 'goal-a': [true] } })
  const outcome = await runLoop({ goals: [goalA], options: { deliver: true }, deps: fake.deps })
  assert.equal(outcome.exitCode, EXIT.pass)
  assert.deepEqual(fake.trace, ['ensure', 'run:goal-a:1', 'deliver'])
  assert.equal(fake.state().outcome, 'pass')
  assert.equal(fake.state().iterations[0].results['goal-a'].pass, true)
})

test('loop: fail -> fixer fixed -> build -> relaunch -> retest only the failed goal -> pass', async () => {
  const fake = fakeLoop({ outcomes: { 'goal-a': [true], 'goal-b': [false, true] }, fixerVerdicts: [{ result: 'fixed', summary: 'parser fixed', headBefore: 'a', headAfter: 'b' }] })
  const outcome = await runLoop({ goals: [goalA, goalB], options: {}, deps: fake.deps })
  assert.equal(outcome.exitCode, EXIT.pass)
  assert.deepEqual(fake.trace, ['ensure', 'run:goal-a:1', 'run:goal-b:1', 'fix:goal-b:1', 'build:1', 'reload:1', 'run:goal-b:2'])
  const state = fake.state()
  assert.equal(state.iterations.length, 2)
  assert.equal(state.iterations[0].fixers[0].result, 'fixed')
  assert.equal(state.iterations[0].build.ok, true)
  assert.deepEqual(Object.keys(state.iterations[1].results), ['goal-b'])
  assert.ok(fake.writes() >= 6)
})

test('loop: a blocked fixer stops with exit 2', async () => {
  const fake = fakeLoop({ outcomes: { 'goal-a': [false] }, fixerVerdicts: [{ result: 'blocked', summary: 'owner must choose a model' }] })
  const outcome = await runLoop({ goals: [goalA], options: {}, deps: fake.deps })
  assert.equal(outcome.exitCode, EXIT.blocked)
  assert.equal(outcome.outcome, 'blocked')
  assert.match(outcome.summary, /owner must choose a model/)
  assert.ok(!fake.trace.includes('build:1'))
})

test('loop: the iteration budget runs out with exit 2; --no-fix fails with exit 1', async () => {
  const fake = fakeLoop({ outcomes: { 'goal-a': [false, false] }, fixerVerdicts: [{ result: 'fixed', summary: 'try 1' }] })
  const outcome = await runLoop({ goals: [goalA], options: { iterations: 2 }, deps: fake.deps })
  assert.equal(outcome.exitCode, EXIT.blocked)
  assert.equal(outcome.outcome, 'exhausted')
  assert.deepEqual(fake.trace, ['ensure', 'run:goal-a:1', 'fix:goal-a:1', 'build:1', 'reload:1', 'run:goal-a:2'])
  const noFix = fakeLoop({ outcomes: { 'goal-a': [false] } })
  const failed = await runLoop({ goals: [goalA], options: { noFix: true }, deps: noFix.deps })
  assert.equal(failed.exitCode, EXIT.fail)
  assert.deepEqual(noFix.trace, ['ensure', 'run:goal-a:1'])
})

test('loop: a failed build becomes the next iteration\'s failure for the fixer; crashes still write run.json', async () => {
  const fake = fakeLoop({ outcomes: { 'goal-a': [false, true] }, fixerVerdicts: [{ result: 'fixed', summary: 'x' }, { result: 'fixed', summary: 'build fixed' }], buildOk: false })
  let builds = 0
  const build = fake.deps.build
  fake.deps.build = async n => { builds++; return builds === 1 ? build(n) : { ok: true, exitCode: 0 } }
  const outcome = await runLoop({ goals: [goalA], options: {}, deps: fake.deps })
  assert.equal(outcome.exitCode, EXIT.pass)
  assert.deepEqual(fake.trace, ['ensure', 'run:goal-a:1', 'fix:goal-a:1', 'build:1', 'fix:goal-a:2', 'reload:2', 'run:goal-a:3'])
  assert.match(fake.state().iterations[1].results['goal-a'].failures[0], /build failed \(exit 1\): tsc error/)

  const crash = fakeLoop({ outcomes: { 'goal-a': [false] } })
  crash.deps.dispatchFixer = async () => ({ goalId: 'goal-a', result: 'fixed' })
  crash.deps.build = async () => { throw new Error('disk full') }
  const crashed = await runLoop({ goals: [goalA], options: {}, deps: crash.deps })
  assert.equal(crashed.outcome, 'error')
  assert.equal(crash.state().outcome, 'error')
  assert.match(crash.state().error, /disk full/)

  const down = fakeLoop({ outcomes: {} })
  down.deps.ensureTarget = async () => { throw new Error('no credential file') }
  const unreachable = await runLoop({ goals: [goalA], options: {}, deps: down.deps })
  assert.equal(unreachable.exitCode, EXIT.blocked)
  assert.equal(unreachable.outcome, 'unreachable')
})

test('loop: fixers run in parallel up to --fixers', async () => {
  const fake = fakeLoop({ outcomes: { 'goal-a': [false, true], 'goal-b': [false, true] } })
  let active = 0, peak = 0
  fake.deps.dispatchFixer = async goal => { active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 20)); active--; return { goalId: goal.id, result: 'fixed', summary: 'ok' } }
  await runLoop({ goals: [goalA, goalB], options: { fixers: 4 }, deps: fake.deps })
  assert.equal(peak, 2)
  const serial = fakeLoop({ outcomes: { 'goal-a': [false, true], 'goal-b': [false, true] } })
  active = 0; peak = 0
  serial.deps.dispatchFixer = fake.deps.dispatchFixer
  await runLoop({ goals: [goalA, goalB], options: { fixers: 1 }, deps: serial.deps })
  assert.equal(peak, 1)
})

// ---------------------------------------------------------------- CLI

test('CLI arguments: repeated goals, defaults and validation', () => {
  const args = parseArgs(['run', '--goal', 'a.json', '--goal=b.json', '--iterations', '3', '--no-fix', '--target', 'installed'])
  assert.deepEqual(args.goals, ['a.json', 'b.json'])
  assert.equal(args.iterations, 3)
  assert.equal(args.fixers, 4)
  assert.equal(args.noFix, true)
  assert.equal(args.target, 'installed')
  assert.equal(args.fixerTarget, 'auto')
  assert.equal(parseArgs(['app', 'start']).sub, 'start')
  assert.throws(() => parseArgs(['run', '--target', 'cloud']), /--target/)
  assert.throws(() => parseArgs(['run', '--iterations', '0']), /--iterations/)
  assert.throws(() => parseArgs(['run', '--goal']), /needs a value/)
})

test('a process_files output the history only holds a tail of is fetched in full through agents.artifact before the predicate reads it', async () => {
  const full = JSON.stringify({ validation: 'passed', result: { outcomes: [{ targetId: 'a', status: 'matched', candidates: [] }, { targetId: 'b', status: 'not_found', candidates: [] }] } }, null, 2)
  const events = [
    { sequence: 1, timestamp: 't', itemId: 'pf', data: { type: 'tool', name: 'process_files', status: 'running', input: { target: 'x', source: 'y' } } },
    { sequence: 2, timestamp: 't', itemId: 'pf', data: { type: 'tool', name: 'process_files', status: 'completed', output: full.slice(-40), outputMode: 'snapshot', outputArtifactId: 'art-1' } }
  ]
  const calls = []
  const call = async (method, args) => { calls.push([method, args]); return { agentSessionId: 'agent-1', artifactId: args.artifactId, content: full, truncated: false } }
  const tail = projectItems(events)
  assert.equal(findValidatedArtifact(tail), null)
  const items = await resolveArtifactOutputs(tail, call, 'agent-1')
  assert.deepEqual(calls, [['agents.artifact', { agentSessionId: 'agent-1', artifactId: 'art-1' }]])
  assert.equal(findValidatedArtifact(items)?.result.outcomes.length, 2)
  const evaluation = evaluateRun({ goal: { ...baseGoal(), success: { requireValidatedArtifact: true } }, status: { phase: 'completed' }, events, items })
  assert.equal(evaluation.pass, true)
  assert.deepEqual(evaluation.counts.outcomes, { total: 2, matched: 1, not_found: 1 })
  // A fetch that fails leaves the tail, and the predicate says the artifact is missing.
  const stubborn = await resolveArtifactOutputs(projectItems(events), async () => { throw new Error('gone') }, 'agent-1')
  assert.equal(findValidatedArtifact(stubborn), null)
})
