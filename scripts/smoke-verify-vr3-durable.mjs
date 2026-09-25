// VR3 group D (docs/verification/2026-09-25-vr3.md): durable jobs on a stub local model.
//   B1  durable-jobs-as-local-option: the durable toggle sits on the local model the owner picks.
//   D1  durable-jobs-verification D5: a stage that says "done" without meeting its criteria is not completed.
//   D2  durable-jobs-verification D1: benign not-found reads do not trip the loop guard.
// The stub answers from a marker in the stage objective, like scripts/smoke-durable-jobs.mjs, so no
// llama-server is started (CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT, unpackaged build only).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr3-durable.mjs
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr3-durable', output: process.env.VR3_OUT ?? 'artifacts/verification/2026-09-25-vr3' })
watchdog(17 * 60)
await loadCheck()

// ---- stub model: the reply is chosen by the marker in the stage objective and the tool results so far
const MODEL = 'local/qwen3.6-35b-a3b'
const hundredLines = Array.from({ length: 100 }, (_, i) => `log line ${i + 1}`).join('\n') + '\n'
const seen = []
const stub = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
    const send = payload => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.url?.startsWith('/health')) return send({ status: 'ok' })
    if (request.url?.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
    const messages = Array.isArray(body.messages) ? body.messages : []
    const task = String(messages.find(message => message.role === 'user')?.content ?? '')
    const objective = /THIS STAGE\s*([\s\S]*?)\s*STAGE IS COMPLETE WHEN/.exec(task)?.[1] ?? task
    const tools = messages.filter(message => message.role === 'tool').length
    const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call_${seen.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    const done = text => ({ content: `${text}\nJOB STATUS: DONE` })
    const marker = /VR3-[A-Z0-9-]+/.exec(objective)?.[0] ?? 'none'
    seen.push({ at: Date.now(), marker, tools })
    const reply =
      // D1 case: claims done at once, never writes LOG.md.
      marker === 'VR3-D5-UNMET' ? done('LOG.md now has 100 lines.')
      // D1 neighbour: writes the 100 lines, then says done.
      : marker === 'VR3-D5-MET' ? (tools === 0 ? call('write_file', { path: 'LOG.md', content: hundredLines }) : done('LOG.md has 100 lines.'))
      // D2 case: reads INDEX.md before it exists five times (identical failing reads), then creates it.
      : marker === 'VR3-D1-NOTFOUND' ? (tools < 5 ? call('read_file', { path: 'INDEX.md' }) : tools === 5 ? call('write_file', { path: 'INDEX.md', content: '1. first\n' }) : done('INDEX.md exists.'))
      // D2 neighbour: the same five identical reads of a file that exists still trip the guard.
      : marker === 'VR3-D1-IDENTICAL' ? (tools < 12 ? call('read_file', { path: 'README.md' }) : done('Read it.'))
      : done('Nothing to do for this stage.')
    const finishReason = reply.tool_calls ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    setTimeout(() => {
      if (!body.stream) return send({ id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map(({ index: _index, ...rest }) => rest) } : {}) }, finish_reason: finishReason }], usage })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = payload => response.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL, ...payload })}\n\n`)
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', ...reply }, finish_reason: null }] })
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
      chunk({ choices: [], usage })
      response.end('data: [DONE]\n\n')
    }, 300)
  })
})
await new Promise(done => stub.listen(0, '127.0.0.1', done))

const SETTLED = new Set(['completed', 'failed', 'cancelled', 'blocked'])
const settle = async (jobId, label) => poll(async () => { const status = await call('jobs.status', { jobId }); return SETTLED.has(status.status) ? status : null }, { timeoutMs: 180_000, intervalMs: 1000, label })
const allEvents = async jobId => {
  const events = []
  let afterId
  for (let i = 0; i < 20; i++) {
    const page = await call('jobs.events', { jobId, limit: 200, ...(afterId != null ? { afterId } : {}) })
    const list = Array.isArray(page) ? page : page.events ?? []
    events.push(...list)
    if (list.length < 200) break
    afterId = list.at(-1).id
  }
  return events
}
const jobsList = async () => { const r = await call('jobs.list', {}); return Array.isArray(r) ? r : r.jobs ?? [] }
const text = events => JSON.stringify(events)
const job = (marker, criteria, title) => call('jobs.create', { objective: `VR3 ${title}`, title, model: MODEL, isolateWorktree: false, stages: [{ title, objective: `${marker}: ${title}`, completionCriteria: criteria }] })

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT: `http://127.0.0.1:${stub.address().port}` } })
  const project = await openProject({ name: 'VR3 durable', git: true, files: { 'README.md': '# VR3 durable\n' } })
  const view = await page(inst)

  // ---- B1: the owner picks Qwen 3.6 35B-A3B (the model loaded on MAIN) and turns durable on for it.
  try {
    step('B1 launcher')
    await view.locator('.launcher-grid').first().waitFor({ timeout: 30_000 })
    const rail = await view.locator('.activity-rail button').evaluateAll(buttons => buttons.map(button => (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim()))
    const qwen = view.locator('.launcher-tile').filter({ hasText: 'Qwen 3.6 35B-A3B' }).first()
    const ornith = view.locator('.launcher-tile').filter({ hasText: 'Ornith' }).first()
    await ornith.locator('.launcher-tile-durable-toggle').click()
    const neighbour = (await view.locator('.launcher-durable-option .durable-job-launcher-form strong').first().textContent())?.trim()
    await qwen.locator('.launcher-tile-durable-toggle').click()
    await view.waitForTimeout(300)
    const form = view.locator('.launcher-durable-option .durable-job-launcher-form').first()
    const formModel = (await form.locator('strong').first().textContent())?.trim()
    const forms = await view.locator('.launcher-durable-option .durable-job-launcher-form').count()
    const selects = await view.locator('.launcher-durable-option select').count()
    const bodyText = await view.locator('body').innerText()
    const secondPicker = /local model for durable work/i.test(bodyText)
    const pressed = await qwen.locator('.launcher-tile-durable-toggle').getAttribute('aria-pressed')
    const b1Shot = await shot('B1-qwen-toggle')
    await form.getByLabel('Job objective').fill('VR3-B1 launcher job: nothing to do, report done.')
    const before = (await jobsList()).length
    await form.getByRole('button', { name: 'Start durable job' }).click()
    const created = await poll(async () => { const list = await jobsList(); return list.length > before ? list : null }, { timeoutMs: 30_000, label: 'the launcher job in jobs.list' })
    const launched = created.find(entry => /VR3-B1|launcher job/i.test(JSON.stringify(entry))) ?? created.at(-1)
    await view.waitForTimeout(1500)
    const jobTab = await view.getByRole('button', { name: /^(Pause|Cancel)/ }).count()
    const b1Shot2 = await shot('B1-job-tab')
    const durableRail = rail.filter(name => /durable/i.test(name))
    const ok = formModel?.startsWith('Qwen 3.6 35B-A3B') && neighbour?.startsWith('Ornith') && forms === 1 && selects === 0 && !secondPicker && pressed === 'true' && launched?.model === MODEL && durableRail.length === 0
    record('B1', ok ? 'PASS' : 'FAIL', { formModel, neighbour, forms, selects, secondPicker, pressed, jobModel: launched?.model, jobControlsInTab: jobTab, durableRail: durableRail.length, rail }, `${b1Shot}, ${b1Shot2}; control: the Ornith toggle gave "${neighbour}"`)
  } catch (error) { await failed(error, 'B1') }

  // ---- D1: completion criteria are checked before a stage is done (RV1 D5).
  try {
    step('D1 unmet criteria')
    const unmet = await job('VR3-D5-UNMET', ['LOG.md has 100 lines'], 'Write 100 log lines')
    const unmetStatus = await settle(unmet.id ?? unmet.jobId, 'the unmet-criteria job to settle')
    const unmetEvents = await allEvents(unmet.id ?? unmet.jobId)
    const notMet = (text(unmetEvents).match(/Completion criteria not met/g) ?? []).length
    const everyStage = /Every stage completed/.test(text(unmetEvents)) || /Every stage completed/.test(String(unmetStatus.statusReason ?? ''))
    const logExists = existsSync(join(project.path, 'LOG.md'))
    step('D1 control: met criteria')
    const met = await job('VR3-D5-MET', ['LOG.md has 100 lines'], 'Write 100 log lines (met)')
    const metStatus = await settle(met.id ?? met.jobId, 'the met-criteria job to settle')
    const lines = existsSync(join(project.path, 'LOG.md')) ? readFileSync(join(project.path, 'LOG.md'), 'utf8').split('\n').filter(Boolean).length : 0
    const ok = unmetStatus.status !== 'completed' && notMet >= 1 && !everyStage && !logExists && metStatus.status === 'completed' && lines === 100
    record('D1', ok ? 'PASS' : 'FAIL', { unmetStatus: unmetStatus.status, notMetEvents: notMet, everyStageCompleted: everyStage, stubCalls: seen.filter(entry => entry.marker === 'VR3-D5-UNMET').length, controlStatus: metStatus.status, controlLines: lines }, `unmet reason: ${String(unmetStatus.statusReason ?? '').slice(0, 300)}; control reason: ${String(metStatus.statusReason ?? '').slice(0, 160)}`)
  } catch (error) { await failed(error, 'D1') }

  // ---- D2: the loop guard does not block on benign not-found reads (RV1 D1 run 2).
  try {
    step('D2 not-found reads')
    const reads = await job('VR3-D1-NOTFOUND', ['INDEX.md exists'], 'Build INDEX.md')
    const readsStatus = await settle(reads.id ?? reads.jobId, 'the not-found job to settle')
    const readsEvents = text(await allEvents(reads.id ?? reads.jobId))
    const loopBlock = /Loop detected|loop guard|identical/i.test(readsEvents) && readsStatus.status !== 'completed'
    step('D2 control: identical reads of an existing file')
    const identical = await job('VR3-D1-IDENTICAL', ['README.md exists'], 'Read the readme')
    const identicalStatus = await settle(identical.id ?? identical.jobId, 'the identical-reads job to settle')
    const identicalEvents = text(await allEvents(identical.id ?? identical.jobId))
    const guardFired = /Loop detected|loop guard|identical|same call/i.test(identicalEvents)
    const ok = readsStatus.status === 'completed' && !loopBlock && existsSync(join(project.path, 'INDEX.md')) && guardFired
    record('D2', ok ? 'PASS' : 'FAIL', { status: readsStatus.status, notFoundReads: seen.filter(entry => entry.marker === 'VR3-D1-NOTFOUND' && entry.tools < 5).length, controlStatus: identicalStatus.status, controlGuardFired: guardFired }, `reason: ${String(readsStatus.statusReason ?? '').slice(0, 200)}; control reason: ${String(identicalStatus.statusReason ?? '').slice(0, 300)}`)
  } catch (error) { await failed(error, 'D2') }
} catch (error) { await failed(error) }
stub.close()
await finish()
