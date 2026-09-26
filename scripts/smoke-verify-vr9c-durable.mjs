// VR9c (verify loop v3) durable-jobs-verification, day part: the stub loop and stall faults with
// strict pass rules, each next to a known-good neighbour that must NOT block, so a guard that blocks
// everything (or any slow call) fails here. Stub model only: no llama-server, no GPU.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9c-durable.mjs [--label L]
// C-LOOP  six different reads, then DONE          -> completed, 0 loop-detected events
// LOOP    the same read_file README.md forever     -> blocked on a loop, exactly 1 replan before the block
// C-STALL silent 100 s (under the 180 s stall window), then DONE -> completed, no watchdog interrupt
// STALL   never answers, maxStageAttempts 1       -> blocked "no progress for N s ... not processing", N >= 180, 180-300 s
import { createServer } from 'node:http'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, poll, record, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
configure({ name: 'vr9c-durable' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr9c' })
watchdog(18 * 60)
await loadCheck()

const MODEL = 'local/qwen3.6-35b-a3b'
const SLOW_MS = 100_000
const FILES = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`f${n}.txt`, `file ${n}: token VR9C-${n * 7919}\n`]))

// --- Stub model (same wire shape as scripts/smoke-durable-jobs.mjs), scripted by prompt markers ---
const held = []
const requests = { LOOP: 0, VARIED: 0, SLOW: 0, STALL: 0 }
const stub = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
    const send = payload => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.url?.startsWith('/health')) return send({ status: 'ok' })
    if (request.url?.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
    const messages = Array.isArray(body.messages) ? body.messages : []
    const prompt = JSON.stringify(messages)
    const marker = Object.keys(requests).find(key => prompt.includes(`VR9C-${key}-CASE`))
    if (marker) requests[marker]++
    if (marker === 'STALL') { held.push(response); return }
    const toolCall = (name, args) => ({ tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    const toolResults = messages.filter(message => message.role === 'tool').length
    const reply = marker === 'LOOP' ? toolCall('read_file', { path: 'README.md' })
      : marker === 'VARIED' ? (toolResults < 6 ? toolCall('read_file', { path: `f${toolResults + 1}.txt` }) : { content: 'Read f1.txt to f6.txt, one token each.\nJOB STATUS: DONE' })
      : marker === 'SLOW' ? { content: 'Answered after a long think.\nJOB STATUS: DONE' }
      : { content: 'Nothing to do for this stage.\nJOB STATUS: DONE' }
    const finish = reply.tool_calls ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    setTimeout(() => {
      if (!body.stream) return send({ id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map(({ index: _index, ...rest }) => rest) } : {}) }, finish_reason: finish }], usage })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = payload => response.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL, ...payload })}\n\n`)
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', ...reply }, finish_reason: null }] })
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })
      chunk({ choices: [], usage })
      response.end('data: [DONE]\n\n')
    }, marker === 'SLOW' && toolResults === 0 ? SLOW_MS : 2000)
  })
})
await new Promise(done => stub.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${stub.address().port}`

const events = async jobId => { const all = []; for (let after; ;) { const page = await call('jobs.events', { jobId, limit: 200, ...(after ? { afterId: after } : {}) }); all.push(...page); if (page.length < 200) return all; after = page.at(-1).id } }
async function runJob(key, { budgets, timeoutMs }) {
  step(`${key}: create`)
  const started = Date.now()
  const job = await call('jobs.create', { title: `VR9c ${key}`, model: MODEL, objective: `VR9C-${key}-CASE: follow the stage.`, ...(budgets ? { budgets } : {}), stages: [{ title: key, objective: `VR9C-${key}-CASE: do the scripted step`, completionCriteria: ['The scripted step is done'] }] })
  const settled = await poll(async () => { const s = await call('jobs.status', { jobId: job.id }); return ['completed', 'blocked', 'failed', 'cancelled'].includes(s.status) ? s : null }, { timeoutMs, intervalMs: 1000, label: `${key} job to settle` })
  const seconds = Math.round((Date.now() - started) / 1000)
  const all = await events(job.id)
  return { job, settled, seconds, all }
}

const verdicts = []
const judge = (id, ok, numbers, evidence) => { verdicts.push(ok); record(id, ok ? 'PASS' : 'FAIL', numbers, evidence) }
try {
  await launchParked({ mode: 'playwright', env: { CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: endpoint, CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_OFFLINE_TESTS: undefined } })
  await openProject({ name: 'VR9c durable', git: true, files: { 'README.md': '# VR9c durable\n', 'notes.txt': 'first line\n', ...FILES } })
  const tools = await call('tools.list')
  if (!tools['jobs.create']) throw new Error('jobs.* not listed')
  const locals = (await call('models.list')).find(entry => entry.provider === 'local')?.models.map(entry => entry.id) ?? []
  if (!locals.includes(MODEL)) throw new Error(`${MODEL} not in local models.list: ${locals.join(', ')}`)
  record('env', 'INFO', { endpoint, model: MODEL }, 'stub endpoint; no llama-server started by this run')

  const loopish = list => list.filter(event => event.kind === 'loop-detected')
  const interrupts = list => list.filter(event => /interrupt|stalled|no progress|Watchdog/i.test(event.message))

  // Neighbour first: distinct reads that each teach something new must never trip the guard.
  const cLoop = await runJob('VARIED', { timeoutMs: 3 * 60_000 })
  judge('D2 C-LOOP varied reads complete', cLoop.settled.status === 'completed' && loopish(cLoop.all).length === 0 && requests.VARIED >= 7,
    { status: cLoop.settled.status, reason: cLoop.settled.statusReason ?? null, loopEvents: loopish(cLoop.all).length, stubRequests: requests.VARIED, seconds: cLoop.seconds }, `job ${cLoop.job.id}`)

  const loop = await runJob('LOOP', { timeoutMs: 6 * 60_000 })
  const loopEvents = loopish(loop.all)
  const replans = loopEvents.filter(event => typeof event.data?.replan === 'number')
  const blockEvent = loopEvents.find(event => event.data?.blocked)
  judge('D2 LOOP blocks after one replan', loop.settled.status === 'blocked' && /loop/i.test(loop.settled.statusReason ?? '') && replans.length === 1 && Boolean(blockEvent) && loopEvents.indexOf(replans[0]) < loopEvents.indexOf(blockEvent) && loop.seconds < 240,
    { status: loop.settled.status, seconds: loop.seconds, replans: replans.length, blockEvent: Boolean(blockEvent), attempt: loop.settled.currentStage?.attempt ?? null, stubRequests: requests.LOOP, reason: String(loop.settled.statusReason ?? '').slice(0, 300) },
    `job ${loop.job.id}; events: ${loopEvents.map(event => event.message.slice(0, 160)).join(' | ')}`)
  await call('jobs.cancel', { jobId: loop.job.id, reason: 'VR9c done' }).catch(() => {})

  const cStall = await runJob('SLOW', { budgets: { maxStageAttempts: 1 }, timeoutMs: 5 * 60_000 })
  judge('D2 C-STALL 100 s silence completes', cStall.settled.status === 'completed' && interrupts(cStall.all).length === 0 && cStall.seconds >= SLOW_MS / 1000,
    { status: cStall.settled.status, seconds: cStall.seconds, interrupts: interrupts(cStall.all).length, reason: cStall.settled.statusReason ?? null }, `job ${cStall.job.id}`)

  const stall = await runJob('STALL', { budgets: { maxStageAttempts: 1 }, timeoutMs: 8 * 60_000 })
  const quietFor = Number(/no progress for (\d+)\s*s/i.exec(stall.settled.statusReason ?? '')?.[1] ?? /no progress for (\d+)\s*s/i.exec(interrupts(stall.all).map(event => event.message).join(' '))?.[1] ?? NaN)
  judge('D2 STALL blocks on the watchdog', stall.settled.status === 'blocked' && /not processing/i.test(`${stall.settled.statusReason} ${interrupts(stall.all).map(event => event.message).join(' ')}`) && quietFor >= 180 && stall.seconds >= 180 && stall.seconds <= 300,
    { status: stall.settled.status, seconds: stall.seconds, quietForS: quietFor, stubRequests: requests.STALL, reason: String(stall.settled.statusReason ?? '').slice(0, 300) },
    `job ${stall.job.id}; interrupts: ${interrupts(stall.all).map(event => event.message.slice(0, 160)).join(' | ')}`)
  await call('jobs.cancel', { jobId: stall.job.id, reason: 'VR9c done' }).catch(() => {})
} catch (error) {
  await failed(error, 'D2 error')
} finally {
  for (const response of held) { try { response.destroy() } catch { /* gone */ } }
  stub.close()
}
await finish({ code: verdicts.length === 4 && verdicts.every(Boolean) ? 0 : 1 })
