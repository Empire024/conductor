// FX33 (feature-list.md: a restart never breaks a running agent). With the runtime host on, a
// wizard and three coworkers are mid-turn when the owner restarts the app, and the relaunched
// app's main thread is stalled for 30 s right after it reattached them (the test hook
// CONDUCTOR_TEST_STARTUP_BLOCK_MS; 71 s on the owner's machine on 2026-09-25).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx33-restart-stall.mjs [--runs 2] [--stall-ms 30000]
//
// S1 reattach-through-stall   every kept runtime reattaches (no "did not answer attach"), keeps its
//                             pid and finishes its kept turn in its tab.
// S2 message-after-restart    a message sent to each afterwards reaches the same process and is answered.
// S3 control-endpoint-stable  control-owner.json names the same endpoint and token after the restart,
//                             and each conversation's pre-restart credential still works.
// S4 control-during-restart   every app-control call a kept turn made while the app restarted and
//                             stalled was answered 200 (held by the runtime host, then by the new
//                             app), none refused.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, safeClose, step, watchdog } from './verify-kit.mjs'

const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback }
const runs = Number(argument('--runs', '1'))
const stallMs = Number(argument('--stall-ms', '30000'))
configure({ name: 'fx33-restart-stall' })
watchdog(8 * 60 * runs)
await loadCheck()

// A Claude stand-in. "FX33 LONG <name>" streams for ~45 s and, while it does, calls app control
// once a second with the endpoint and credential from its briefing, logging each answer; "FX33 AFTER
// <name>" answers at once. Every prompt, and the pid that got it, is logged too.
const FIXTURE = String.raw`
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.CONDUCTOR_TEST_FIXTURE_DIR
const log = (file, entry) => appendFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'fx33-native-' + process.pid, parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let control = null, name = '?', busy = false
const queued = []
const calls = async until => {
  while (Date.now() < until) {
    if (control) {
      const started = Date.now()
      try {
        const response = await fetch(control.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'agents.list', args: {} }), signal: AbortSignal.timeout(120000) })
        log('calls.jsonl', { name, status: response.status, ms: Date.now() - started })
      } catch (error) { log('calls.jsonl', { name, status: 0, ms: Date.now() - started, error: String(error.cause?.code ?? error.message) }) }
    }
    await wait(1000)
  }
}
const stream = async (words, delay) => {
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const word of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } }); await wait(delay) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
}
const turn = async prompt => {
  busy = true
  log('prompts.jsonl', { name, prompt: prompt.slice(0, 600) })
  const endpoint = /POST (http:\/\/127\.0\.0\.1:\d+\/control)/.exec(prompt)?.[1], token = /Bearer ([a-f0-9]{64})/.exec(prompt)?.[1]
  if (endpoint && token) control = { endpoint, token }
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const long = /FX33 LONG (\S+)/.exec(prompt), after = /FX33 AFTER (\S+)/.exec(prompt)
  if (long) {
    name = long[1]
    const words = Array.from({ length: 150 }, (_, i) => 'w' + i + ' ')
    await Promise.all([stream([...words, 'long-done:' + name], 300), calls(Date.now() + 150 * 300)])
  } else if (after) await stream(['after-ack:' + after[1] + ' pid ' + process.pid], 10)
  else await stream(['noted'], 10)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  busy = false
  if (queued.length) void turn(queued.shift())
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const content = message.message.content
  const prompt = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : String(content)
  if (busy) queued.push(prompt); else void turn(prompt)
})
`

const lines = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const names = ['wizard', 'coworker-a', 'coworker-b', 'coworker-c']
const summary = []

for (let run = 1; run <= runs; run++) {
  try {
    const inst = await launchParked({ mode: 'spawn', name: `fx33-run${run}`, env: { CONDUCTOR_RUNTIME_HOST: '1', CONDUCTOR_TEST_STARTUP_BLOCK_MS: stallMs }, fixtures: { 'fake-claude.mjs': FIXTURE } })
    const fixtures = join(inst.root, 'fixtures')
    await page(inst)
    await openProject({ name: `FX33 restart ${run}`, git: true })
    const tabs = {}
    for (const name of names) tabs[name] = (await openTab({ provider: 'claude', title: name })).resourceId
    const view = await page(inst)
    await view.evaluate(async id => {
      const state = await window.conductor.structured.snapshot(id)
      await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true })
    }, tabs.wizard)

    step(`run ${run}: four turns under way, then the owner restarts`)
    for (const name of names) await call('agents.submit', { agentSessionId: tabs[name], prompt: `FX33 LONG ${name}` })
    await poll(() => names.every(name => lines(join(fixtures, 'calls.jsonl')).some(entry => entry.name === name && entry.status === 200)), { timeoutMs: 60_000, intervalMs: 500, label: 'every turn to stream and call app control' })
    const pidsBefore = Object.fromEntries(names.map(name => [name, lines(join(fixtures, 'prompts.jsonl')).find(entry => entry.prompt.startsWith(`FX33 LONG ${name}`))?.pid]))
    const credentialBefore = inst.credential
    const restartAt = new Date().toISOString()
    await call('app.restart', { force: true })
    const seconds = await relaunched(inst, credentialBefore.pid, { timeoutMs: 90_000 })
    step(`run ${run}: relaunched in ${seconds.toFixed(1)} s; waiting out the ${stallMs} ms stall`)

    step(`run ${run}: S1 every kept turn finishes in its tab`)
    const finished = await poll(async () => {
      const states = await Promise.all(names.map(name => call('agents.status', { agentSessionId: tabs[name] }, { timeoutMs: 90_000 })))
      return states.every(state => state.phase === 'completed') ? states : null
    }, { timeoutMs: 180_000, intervalMs: 2000, label: 'the kept turns to complete' })
    const histories = Object.fromEntries(await Promise.all(names.map(async name => [name, JSON.stringify(await call('agents.snapshot', { agentSessionId: tabs[name] }))])))
    const attachErrors = names.filter(name => /did not answer attach|could not be reattached|Runtime host did not answer/.test(histories[name]))
    const longDone = names.filter(name => histories[name].includes(`long-done:${name}`))
    const reattached = names.filter(name => /kept running; it is reattached/.test(histories[name]))
    record(`S1-reattach-through-stall-run${run}`, !attachErrors.length && longDone.length === 4 && reattached.length === 4 ? 'PASS' : 'FAIL',
      { reattached: reattached.length, finished: longDone.length, attachErrors: attachErrors.length, relaunchSeconds: seconds },
      JSON.stringify({ phases: finished.map(state => state.phase), attachErrors, longDone, reattached }))

    step(`run ${run}: S2 a message to each reaches the same process`)
    for (const name of names) await call('agents.submit', { agentSessionId: tabs[name], prompt: `FX33 AFTER ${name}` })
    await poll(async () => {
      const texts = await Promise.all(names.map(async name => JSON.stringify(await call('agents.snapshot', { agentSessionId: tabs[name] }))))
      return texts.every((text, index) => text.includes(`after-ack:${names[index]}`))
    }, { timeoutMs: 60_000, intervalMs: 1000, label: 'every conversation to answer after the restart' })
    const afterPrompts = lines(join(fixtures, 'prompts.jsonl')).filter(entry => /FX33 AFTER/.test(entry.prompt))
    const samePid = names.filter(name => afterPrompts.some(entry => entry.prompt.includes(`FX33 AFTER ${name}`) && entry.pid === pidsBefore[name]))
    record(`S2-message-after-restart-run${run}`, samePid.length === 4 ? 'PASS' : 'FAIL', { answered: afterPrompts.length, samePid: samePid.length }, JSON.stringify({ pidsBefore, after: afterPrompts.map(entry => ({ pid: entry.pid, prompt: entry.prompt.slice(0, 40) })) }))

    step(`run ${run}: S3 the control endpoint and credentials did not change`)
    const credentialAfter = inst.credential
    const restartBrief = lines(join(fixtures, 'prompts.jsonl')).filter(entry => /\[Conductor\].*kept running/.test(entry.prompt))
    // Each conversation's own pre-restart credential, used by its kept turn after the restart.
    const lastCalls = names.map(name => lines(join(fixtures, 'calls.jsonl')).filter(entry => entry.name === name).at(-1))
    const endpointSame = credentialAfter.endpoint === credentialBefore.endpoint && credentialAfter.token === credentialBefore.token
    const briefSaysSame = restartBrief.length > 0 && restartBrief.every(entry => /keeps the same endpoint and credential/.test(entry.prompt) && !/Bearer/.test(entry.prompt))
    record(`S3-control-endpoint-stable-run${run}`, endpointSame && briefSaysSame && lastCalls.every(entry => entry?.status === 200) ? 'PASS' : 'FAIL',
      { endpointSame, restartBriefs: restartBrief.length, briefSaysSame },
      JSON.stringify({ before: credentialBefore.endpoint, after: credentialAfter.endpoint, lastCalls, brief: restartBrief[0]?.prompt.slice(0, 300) }))

    step(`run ${run}: S4 app control answered every call made during the restart`)
    const during = lines(join(fixtures, 'calls.jsonl')).filter(entry => entry.at >= restartAt)
    const refused = during.filter(entry => entry.status !== 200)
    const slowest = Math.max(0, ...during.map(entry => entry.ms))
    record(`S4-control-during-restart-run${run}`, during.length >= 8 && !refused.length && slowest >= Math.min(stallMs, 10_000) / 2 ? 'PASS' : 'FAIL',
      { calls: during.length, refused: refused.length, slowestMs: slowest },
      JSON.stringify({ refused: refused.slice(0, 8), sample: during.slice(0, 6) }))
    summary.push({ run, root: inst.root })

    const close = await safeClose(inst)
    record(`fx33-close-run${run}`, close.leftovers.length === 0 ? 'PASS' : 'FAIL', { killed: close.killed.length, leftovers: close.leftovers.length })
  } catch (error) {
    await failed(error, `run${run}`)
  }
}
console.log(JSON.stringify(summary))
await finish()
