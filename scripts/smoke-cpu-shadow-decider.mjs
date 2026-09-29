// cpu-shadow-decider (feature-list.md): the CPU decision model (Laya typed-decisions, laya-serve on
// CPU, docs/model-routing.md "CPU decider") runs beside every other model and journals its verdict in
// shadow. One parked launch with the real Electron main/preload/renderer, the production approval gate,
// router, durable decision journal and the real Laya sidecar; only the Claude CLI is an inline synthetic
// fixture (no inference, nothing executed):
//   A. An Ask-mode coworker's approval card is reviewed by the (synthetic) reviewer; the decision is
//      journaled with both verdicts: the reviewer's (decided) and Laya's (system-one, shadow).
//   B. router.dispatch({route}) routes a task; the route decision carries Laya's verdict beside the
//      scorer's, and the dispatch's classify and completion decisions are journaled the same way.
//   C. local.servers lists the decider (CPU, not the GPU server); a GPU model then starts and answers a
//      real turn while the decider stays up with the same pid, and nvidia-smi never shows the decider.
//   D. After the GPU start, another approval is still shadowed by the same decider.
//   E. (--no-gpu) Durable jobs on a loopback stub model (CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT, no llama-server): a
//      failed attempt journals the loop guard's retry verdict, and every completed stage journals the
//      controller's go-on-or-stop answer (escalate), both "continue" and "escalate"; then decisions.list
//      reports the decider for approval, retry, escalate, completion and classify.
// Needs the decider set up (scripts/local-models/setup-decider.ps1) and a built out/ with this change
// (or CONDUCTOR_SMOKE_MAIN=<worktree>/out/main/index.js). CONDUCTOR_TEST_USER_DATA parks the window.
// --no-gpu runs E instead of C (and --restore) while another run holds the GPU: the stub endpoint takes every
// local conversation of the launch, so C's real GPU turn and E never share one. The decider is CPU only.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-cpu-shadow-decider.mjs [--gpu-model local/qwen3.5-9b] [--restore local/dolphin-x1-8b] [--no-gpu]
import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const runLabel = argument('--run', String(Date.now()))
const GPU_MODEL = argument('--gpu-model', 'local/qwen3.5-9b')
const RESTORE = argument('--restore', '')
const NO_GPU = process.argv.includes('--no-gpu')
const JOB_MODEL = argument('--job-model', 'local/qwen3.6-35b-a3b')
const root = await mkdtemp(join(tmpdir(), 'conductor-cpu-decider-'))
const output = resolve('artifacts/cpu-shadow-decider')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project'), fixtures = join(root, 'fixtures')
const capture = join(root, 'last-prompt.txt'), reviewerLog = join(root, 'reviewer.jsonl')
await mkdir(projectPath, { recursive: true }); await mkdir(fixtures, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# CPU shadow decider smoke\n')

// A Claude CLI stand-in: 'SYNTHETIC ASK <command>' asks for one Bash call (can_use_tool) and finishes when
// it is answered; an isolated reviewer prompt gets an Opus-labelled allow for its digest; anything else is
// a short answer.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = 'cpu-decider-' + process.pid
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'opus'
const text = content => { const id = randomUUID(); emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } }); emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }); emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } }); emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }); emit({ type: 'stream_event', event: { type: 'message_stop' } }); emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: content }] } }) }
const finish = usage => emit({ type: 'result', subtype: 'success', is_error: false, usage: usage ?? {} })
let pending, turn = 0
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'opus', displayName: 'Opus', supportsEffort: true }, { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true }, { value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', supportsEffort: true }] } : {}
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
    appendFileSync(${JSON.stringify(reviewerLog)}, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\\n')
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'default' })
    text(JSON.stringify({ digest, decision: 'allow', rationale: 'SYNTHETIC reviewer: a routine workspace test command of the delegated task.' }))
    return finish({ input_tokens: Math.ceil(prompt.length / 4), output_tokens: 40 })
  }
  emit({ type: 'system', subtype: 'init', model, permissionMode: 'default' })
  const ask = /^SYNTHETIC ASK (.+)/.exec(prompt.split('\\n', 1)[0])
  if (ask) {
    turn++
    pending = { request: 'ask-' + turn, tool: 'toolu_cpu_' + process.pid + '_' + turn, command: ask[1].trim() }
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: pending.tool, name: 'Bash', input: { command: pending.command } }] } })
    send({ type: 'control_request', request_id: pending.request, request: { subtype: 'can_use_tool', tool_use_id: pending.tool, tool_name: 'Bash', input: { command: pending.command }, permission_suggestions: [] } })
    return
  }
  text('Reviewed the diff: no findings. Done.'); finish()
})
`)

// E's stand-in local model (OpenAI-compatible, as scripts/smoke-verify-vr3-durable.mjs): the reply is chosen by
// the marker in the stage objective and the attempt. It serves only durable-job stages; the app then starts no
// llama-server. Only with --no-gpu: the override takes every local conversation, which C must not have.
const stubSeen = []
const stub = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
    const send = payload => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.url?.startsWith('/health')) return send({ status: 'ok' })
    if (request.url?.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: JOB_MODEL, object: 'model' }] })
    const messages = Array.isArray(body.messages) ? body.messages : []
    const task = String(messages.find(message => message.role === 'user')?.content ?? '')
    const objective = /THIS STAGE\s*([\s\S]*?)\s*STAGE IS COMPLETE WHEN/.exec(task)?.[1] ?? task
    const marker = /CPU-[A-Z0-9-]+/.exec(objective)?.[0] ?? 'none'
    // A retried attempt is told about the previous one (controller.test.ts, "did not finish").
    const retried = /previous attempt at this stage did not finish/i.test(task)
    stubSeen.push({ at: Date.now(), marker, retried })
    const content =
      // First attempt answers nothing (never a success), the retry reports done.
      marker === 'CPU-RETRY' ? (retried ? 'Wrote nothing new; the step is done.\nJOB STATUS: DONE' : '')
      // An open-ended stage that says neither done nor what comes next: the controller stops for the owner.
      : marker === 'CPU-NOSTATUS' ? 'I looked at the parser and did some things.'
      : 'Nothing to change for this stage.\nJOB STATUS: DONE'
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    setTimeout(() => {
      if (!body.stream) return send({ id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: JOB_MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = payload => response.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: JOB_MODEL, ...payload })}\n\n`)
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      chunk({ choices: [], usage })
      response.end('data: [DONE]\n\n')
    }, 200)
  })
})
await new Promise(done => stub.listen(0, '127.0.0.1', done))

// Offline: the Claude CLI is the fixture above. The local provider talks to llama.cpp as always, except durable-job stages (the stub).
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  CONDUCTOR_TEST_FIXTURE_DIR: fixtures, CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_DECIDER: '1',
  ...(NO_GPU ? { CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: `http://127.0.0.1:${stub.address().port}` } : {}) }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

const checks = [], evidence = {}
const check = label => { checks.push(label); console.log('PASS ' + label) }
const request = async (auth, method, args = {}, scope) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
  return { status: response.status, body: await response.json() }
}
const ok = async (auth, method, args = {}, scope) => { const r = await request(auth, method, args, scope); assert.equal(r.status, 200, `${method}: ${JSON.stringify(r.body)}`); return r.body.result }
/** Every process nvidia-smi says uses the GPU (graphics or compute). */
const gpuPids = () => { try { return execFileSync('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader'], { encoding: 'utf8' }).split(/\r?\n/).map(Number).filter(Boolean) } catch { return null } }
/** The decider's interpreter: the venv launcher's child process. */
const childPids = pid => execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: 'utf8' }).trim().split(',').map(Number).filter(Boolean)
const workingSetMb = pid => Math.round(Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' }).trim()) / 2 ** 20)

const app = await electron.launch({ args: [process.env.CONDUCTOR_SMOKE_MAIN ?? resolve('out/main/index.js')], env, timeout: 30000 })
// The main process's decider and model-intelligence lines, kept with the run.
const mainLines = []
for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', chunk => { for (const line of String(chunk).split(/\r?\n/)) if (/\[decider\]|\[model-intelligence\]/.test(line)) mainLines.push(line.slice(0, 400)) })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
let failed
try {
  await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30000 }).toBe(true)
  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const project = await ok(owner, 'projects.open', { path: projectPath, name: 'CPU shadow decider' })
  const scope = { projectId: project.id }
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'CPU shadow decider' }).first().click()

  const before = (await ok(owner, 'local.servers', {}, scope)).find(server => server.role === 'decider')
  assert.ok(before, 'local.servers lists the decider')
  assert.deepEqual({ device: before.device, gpu: before.gpu, threads: before.threads }, { device: 'cpu', gpu: false, threads: 4 })
  evidence.deciderBefore = before
  check(`local.servers lists the decider "${before.label}" (CPU, 4 threads, gpu:false), ${before.state} before its first decision`)

  // A wizard (owner authority) and an Ask-mode coworker whose approvals go to the reviewer.
  const wizardTab = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'opus', title: 'Wizard' }, scope)
  const wizardId = wizardTab.resourceId ?? wizardTab.agentSessionId
  await writeFile(capture, '')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    const settings = { ...state.settings, wizard: true, model: 'opus' }
    await window.conductor.structured.saveSettings(id, settings)
    await window.conductor.structured.submit(id, 'SYNTHETIC HELLO: owner asks for a coworker to run the checks', settings, [])
  }, wizardId)
  await expect.poll(async () => (await readFile(capture, 'utf8').catch(() => '')).includes('Conductor app control:'), { timeout: 30000 }).toBe(true)
  const briefing = await readFile(capture, 'utf8')
  const wizard = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  assert.ok(wizard.endpoint && wizard.token, 'the wizard received an app-control briefing')
  await expect.poll(async () => (await snapshot(wizardId)).phase, { timeout: 20000 }).toMatch(/^(completed|idle)$/)
  const opened = await ok(wizard, 'tabs.open', { kind: 'agent', provider: 'claude', model: 'opus', title: 'Coworker (Ask)', permission: 'default', exactPermission: true })
  const coworker = opened.resourceId ?? opened.agentSessionId
  const asked = state => state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant' && /^SYNTHETIC ask (allowed|denied)$/.test(item.data.text)).length
  const ask = async command => {
    const count = asked(await snapshot(coworker))
    await ok(wizard, 'agents.submit', { agentSessionId: coworker, prompt: 'SYNTHETIC ASK ' + command })
    await expect.poll(async () => asked(await snapshot(coworker)) > count ? (await snapshot(coworker)).phase : 'waiting', { timeout: 60000, intervals: [200, 500, 1000] }).toBe('completed')
  }
  /** The newest journaled decision of a kind that satisfies `test`, polled until the shadow is in. */
  const journaled = async (kind, test, timeout = 240000) => {
    let found
    await expect.poll(async () => {
      const listed = await ok(owner, 'decisions.list', { kind, since: new Date(Date.now() - 86_400_000).toISOString(), limit: 50 }, scope)
      found = listed.decisions.find(test)
      return Boolean(found)
    }, { timeout, intervals: [1000, 2000, 3000] }).toBe(true)
    return found
  }

  // A. An approval card, reviewed; both verdicts journaled.
  const startedA = Date.now()
  await ask('npm test -- --run src/parse.test.ts')
  const approval = await journaled('approval', record => record.systemOne?.decider?.startsWith('laya:') && record.agentSessionId === coworker)
  const approvalRecord = (await ok(owner, 'decisions.get', { decisionId: approval.id }, scope)).decision
  assert.match(approvalRecord.decidedBy, /^approval-reviewer/)
  assert.equal(approvalRecord.choice, 'allow')
  const layaVerdict = approvalRecord.verdicts.find(verdict => verdict.decider?.startsWith('laya:'))
  assert.ok(layaVerdict && !layaVerdict.failed, 'Laya answered the approval')
  evidence.approval = { id: approval.id, decidedBy: approvalRecord.decidedBy, choice: approvalRecord.choice, laya: { choice: approvalRecord.systemOne.choice, confidence: approvalRecord.systemOne.confidence, probabilities: layaVerdict.probabilities, elapsedMs: layaVerdict.elapsedMs }, journaledAfterMs: Date.now() - startedA }
  check(`Approval review journaled with both verdicts: ${approvalRecord.decidedBy} chose ${approvalRecord.choice}, Laya (shadow) ${approvalRecord.systemOne.choice} at ${approvalRecord.systemOne.confidence.toFixed(2)} in ${layaVerdict.elapsedMs} ms`)

  const running = (await ok(owner, 'local.servers', {}, scope)).find(server => server.role === 'decider')
  assert.equal(running.state, 'running'); assert.ok(running.pid, 'the decider has a pid')
  const interpreters = childPids(running.pid)
  evidence.decider = { pid: running.pid, port: running.port, interpreters, workingSetMb: interpreters.map(workingSetMb) }
  const onGpu = gpuPids()
  if (onGpu) assert.ok(![running.pid, ...interpreters].some(pid => onGpu.includes(pid)), 'the decider never appears on the GPU')
  check(`The decider runs on CPU as pid ${running.pid} (interpreter ${interpreters.join(', ')}, ${evidence.decider.workingSetMb.join(', ')} MB) on 127.0.0.1:${running.port}; nvidia-smi does not list it`)

  // B. A routed dispatch: the route decision carries Laya's verdict beside the scorer's. Only the Claude CLI
  // is a fixture here, so the route is kept to Claude and the routed turn really runs and settles.
  const dispatched = await ok(wizard, 'router.dispatch', { tasks: [{ title: 'Routed review', prompt: 'Review the parse module diff for correctness and report findings.', route: { features: { category: 'review', complexity: 2, risk: 'low' }, constraints: { excludeProviders: ['local', 'codex', 'grok'] } } }] })
  const task = dispatched.tasks?.[0] ?? dispatched[0] ?? dispatched
  const decisionId = task.decisionId
  assert.ok(decisionId, `router.dispatch returned a decisionId: ${JSON.stringify(dispatched).slice(0, 400)}`)
  let route
  await expect.poll(async () => { route = (await ok(owner, 'decisions.get', { decisionId }, scope)); return Boolean(route.decision.shadow) }, { timeout: 120000, intervals: [1000, 2000] }).toBe(true)
  assert.equal(route.decision.kind, 'route')
  assert.ok(!route.decision.decidedBy.startsWith('laya'), 'the route was decided by the router, not the decision model')
  assert.ok(route.decision.shadow.decider.startsWith('laya:') && !route.decision.shadow.failed, `Laya answered the route: ${JSON.stringify(route.decision.shadow)}`)
  assert.match(route.explanation, /Shadow \(laya:typed-decisions, journaled only\)/)
  assert.ok(route.decision.route?.fallback !== undefined && route.decision.route.reasons.length, 'decisions.get keeps the route reasons and fallback')
  evidence.route = { id: decisionId, choice: route.decision.choice, decidedBy: route.decision.decidedBy, shadow: route.decision.shadow, reasons: route.decision.route.reasons.length, fallback: route.decision.route.fallback?.key ?? null }
  check(`router.dispatch route journaled with both verdicts: ${route.decision.decidedBy} chose ${route.decision.choice}, Laya (shadow) ${route.decision.shadow.choice} (${route.decision.shadow.choice === route.decision.choice ? 'agrees' : 'disagrees'}) in ${route.decision.shadow.elapsedMs} ms`)
  const classify = await journaled('classify', record => record.requester === 'dispatch' && record.systemOne?.decider?.startsWith('laya:'), 120000)
  const completion = await journaled('completion', record => record.requester === 'turn-capture' && record.systemOne?.decider?.startsWith('laya:'), 120000)
  evidence.classify = { id: classify.id, choice: classify.choice, laya: classify.systemOne }
  evidence.completion = { id: completion.id, choice: completion.choice, laya: completion.systemOne }
  check(`The dispatch also journaled classify (${classify.choice} vs Laya ${classify.systemOne.choice}) and the routed turn's completion (${completion.choice} vs Laya ${completion.systemOne.choice}), all in shadow`)

  if (!NO_GPU) {
    // C. A GPU model starts and answers while the decider stays up.
    const servers = await ok(owner, 'local.servers', {}, scope)
    evidence.gpuBefore = servers.filter(server => server.role !== 'decider').map(server => ({ model: server.model, pid: server.pid }))
    const local = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'local', model: GPU_MODEL, title: 'GPU beside the decider' }, scope)
    const localId = local.resourceId ?? local.agentSessionId
    const startedC = Date.now()
    await ok(owner, 'agents.submit', { agentSessionId: localId, prompt: 'Reply with exactly one word: ready' })
    await expect.poll(async () => (await snapshot(localId))?.phase, { timeout: 300000, intervals: [1000, 2000, 5000] }).toBe('completed')
    const localState = await snapshot(localId)
    const reply = localState.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join(' ')
    assert.match(reply, /ready/i, `the GPU model answered: ${reply.slice(0, 200)}`)
    const after = await ok(owner, 'local.servers', {}, scope)
    const gpuServer = after.find(server => server.model === GPU_MODEL)
    const deciderAfter = after.find(server => server.role === 'decider')
    assert.ok(gpuServer?.pid, `${GPU_MODEL} is running`)
    assert.equal(deciderAfter.state, 'running'); assert.equal(deciderAfter.pid, running.pid, 'the decider kept its process through the GPU start')
    const gpuNow = gpuPids()
    if (gpuNow) { assert.ok(gpuNow.includes(gpuServer.pid), 'the GPU model is on the GPU'); assert.ok(![running.pid, ...interpreters].some(pid => gpuNow.includes(pid)), 'the decider is still not on the GPU') }
    evidence.gpu = { model: GPU_MODEL, pid: gpuServer.pid, turnMs: Date.now() - startedC, reply: reply.slice(0, 80), deciderPid: deciderAfter.pid }
    check(`${GPU_MODEL} started (pid ${gpuServer.pid}) and answered "${reply.trim().slice(0, 40)}" in ${Math.round(evidence.gpu.turnMs / 1000)} s while the decider stayed up as pid ${deciderAfter.pid}`)
  } else console.log('SKIP C (--no-gpu): no GPU model is started')

  // D. The decider keeps deciding (with the GPU model loaded, unless --no-gpu).
  await ask('npx tsc --noEmit')
  const second = await journaled('approval', record => record.id !== approval.id && record.systemOne?.decider?.startsWith('laya:') && record.agentSessionId === coworker && !record.systemOne.failed)
  evidence.secondApproval = { id: second.id, laya: second.systemOne }
  check(`${NO_GPU ? 'Later' : `With ${GPU_MODEL} loaded`}, the next approval is shadowed by the same decider (Laya ${second.systemOne.choice} at ${second.systemOne.confidence.toFixed(2)})`)

  if (NO_GPU) {
    // E. Durable jobs on the stub: retry (loop guard after a failed attempt) and escalate (the controller's answer
    // after every completed stage), each journaled beside Laya's verdict.
    const settledJob = async jobId => { let status; await expect.poll(async () => { status = await ok(owner, 'jobs.status', { jobId }, scope); return ['completed', 'failed', 'cancelled', 'blocked'].includes(status.status) ? status.status : 'running' }, { timeout: 180000, intervals: [500, 1000, 2000] }).not.toBe('running'); return status }
    const create = args => ok(owner, 'jobs.create', { model: JOB_MODEL, isolateWorktree: false, ...args }, scope)
    const planned = await create({ title: 'CPU decider planned', objective: 'Two planned steps, the first retried once', budgets: { maxStageAttempts: 3 }, stages: [
      { title: 'Retried step', objective: 'CPU-RETRY: tidy the README heading', completionCriteria: ['the stage reports done'] },
      { title: 'Second step', objective: 'CPU-DONE: confirm nothing else changed', completionCriteria: ['the stage reports done'] }] })
    const plannedStatus = await settledJob(planned.id ?? planned.jobId)
    assert.equal(plannedStatus.status, 'completed', `the planned job completed: ${JSON.stringify(plannedStatus).slice(0, 400)}`)
    const open = await create({ title: 'CPU decider open-ended', objective: 'CPU-NOSTATUS: look at the parser' })
    const openStatus = await settledJob(open.id ?? open.jobId)
    assert.equal(openStatus.status, 'blocked', `the open-ended job stopped for the owner: ${JSON.stringify(openStatus).slice(0, 400)}`)
    evidence.jobs = { planned: { id: planned.id ?? planned.jobId, status: plannedStatus.status }, open: { id: open.id ?? open.jobId, status: openStatus.status, reason: openStatus.statusReason ?? null }, stubRequests: stubSeen.length, stubRetried: stubSeen.filter(entry => entry.retried).length }
    const layaOf = record => record.systemOne?.decider?.startsWith('laya:') && !record.systemOne.failed
    const retry = await journaled('retry', record => record.requester === 'durable-jobs' && layaOf(record), 120000)
    assert.equal(retry.choice, 'retry', 'the loop guard chose to retry the empty first attempt')
    const escalated = await journaled('escalate', record => record.requester === 'durable-jobs' && record.choice === 'escalate' && layaOf(record), 120000)
    const wentOn = await journaled('escalate', record => record.requester === 'durable-jobs' && record.choice === 'continue' && layaOf(record), 120000)
    const escalateAll = (await ok(owner, 'decisions.list', { kind: 'escalate', since: new Date(Date.now() - 86_400_000).toISOString(), limit: 50 }, scope)).decisions.filter(record => record.requester === 'durable-jobs')
    // Two completed planned stages (go on, then done) and the open-ended stage (stop for the owner).
    assert.equal(escalateAll.length, 3, `one escalate decision per completed stage: ${JSON.stringify(escalateAll.map(record => record.choice))}`)
    evidence.retry = { id: retry.id, choice: retry.choice, decidedBy: retry.decidedBy, laya: retry.systemOne }
    evidence.escalate = escalateAll.map(record => ({ id: record.id, choice: record.choice, decidedBy: record.decidedBy, laya: record.systemOne }))
    check(`Durable jobs on the stub: the failed attempt journaled retry (${retry.decidedBy} ${retry.choice} vs Laya ${retry.systemOne.choice}); every completed stage journaled escalate: ${escalateAll.map(record => `${record.choice} vs Laya ${record.systemOne?.choice}`).join(', ')} (${escalated.decidedBy}; ${wentOn.decidedBy})`)
  }

  const listed = await ok(owner, 'decisions.list', { since: new Date(Date.now() - 86_400_000).toISOString(), limit: 50 }, scope)
  evidence.agreement = listed.decider
  assert.ok(Array.isArray(listed.decider) && listed.decider.some(entry => entry.asked > 0), 'decisions.list reports the decider per kind')
  const shadowKinds = NO_GPU ? ['approval', 'retry', 'escalate', 'completion', 'classify'] : ['approval', 'completion', 'classify']
  const unasked = shadowKinds.filter(kind => !listed.decider.some(entry => entry.kind === kind && entry.asked > 0))
  assert.deepEqual(unasked, [], `decisions.list shows the decider asked for every kind: ${JSON.stringify(listed.decider)}`)
  check(`decisions.list reports the decider per kind: ${listed.decider.filter(entry => entry.asked).map(entry => `${entry.kind} asked ${entry.asked}, ${entry.agreed}/${entry.cases} (median ${entry.medianMs} ms)`).join(', ')}`)

  if (RESTORE && !NO_GPU) {
    const restore = await ok(owner, 'tabs.open', { kind: 'agent', provider: 'local', model: RESTORE, title: 'Restore' }, scope)
    const restoreId = restore.resourceId ?? restore.agentSessionId
    await ok(owner, 'agents.submit', { agentSessionId: restoreId, prompt: 'Reply with exactly one word: ready' })
    await expect.poll(async () => (await snapshot(restoreId))?.phase, { timeout: 300000, intervals: [1000, 2000, 5000] }).toBe('completed')
    const restored = (await ok(owner, 'local.servers', {}, scope)).find(server => server.model === RESTORE)
    evidence.restored = { model: RESTORE, pid: restored?.pid ?? null }
    check(`Restored ${RESTORE} (pid ${restored?.pid}) for the owner's app`)
  }
  assert.deepEqual(errors, [])
} catch (error) {
  failed = error
  console.error('FAIL', error)
  await page.screenshot({ path: join(output, `failure-${runLabel}.png`) }).catch(() => undefined)
} finally {
  await appendFile(join(output, 'runs.jsonl'), JSON.stringify({ run: runLabel, at: new Date().toISOString(), ok: !failed, checks, evidence, error: failed ? String(failed.message ?? failed) : undefined }) + '\n')
  // Bounded: a close whose Electron already exited can leave the promise unsettled and hold the smoke lock.
  await Promise.race([app.close().catch(() => undefined), new Promise(done => setTimeout(done, 20_000))])
  await writeFile(join(output, `main-${runLabel}.log`), mainLines.join('\n'))
  stub.close()
}
console.log(JSON.stringify({ ok: !failed, checks: checks.length, evidence }, null, 2))
process.exit(failed ? 1 : 0)
