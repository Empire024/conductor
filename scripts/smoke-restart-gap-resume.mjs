// restart-resume-finished-gap (feature-list.md). With the runtime host on, a wizard restarts
// Conductor from inside its turn and that turn ends while no app is running (2026-09-28: the wizard
// that ran app.update.install was never told to continue). A second wizard's turn is still running
// when the new app reattaches it.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-restart-gap-resume.mjs
//
// S1 gap-wizard-resumed       the wizard whose kept turn ended during the restart gets the resume
//                             message exactly once, in the same kept process (nothing respawned).
// S2 running-wizard-steered   the wizard whose kept turn still ran is told once, by the reattach
//                             steer, and is not sent the resume message as well.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, safeClose, step, watchdog } from './verify-kit.mjs'

configure({ name: 'restart-gap-resume' })
watchdog(8 * 60)
await loadCheck()

// A Claude stand-in. "GAP <name>" restarts Conductor through app control with the credential from
// its briefing, then ends its turn as soon as app control stops answering (the app is gone and the
// runtime host holds the port). "LONG <name>" streams for ~45 s. Every prompt and its pid is logged.
const FIXTURE = String.raw`
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.CONDUCTOR_TEST_FIXTURE_DIR
const log = (file, entry) => appendFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'gap-native-' + process.pid, parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let control = null, name = '?', busy = false
const queued = []
const post = (method, args, timeoutMs) => fetch(control.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(timeoutMs) })
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
  const gap = /^GAP (\S+)/.exec(prompt), long = /^LONG (\S+)/.exec(prompt)
  if (gap && control) {
    name = gap[1]
    await stream(['restarting '], 10)
    const restart = await post('app.restart', { force: true }, 10000).then(response => response.json()).catch(error => ({ error: String(error) }))
    log('events.jsonl', { name, event: 'restart', restart })
    for (let tries = 0; tries < 240; tries++) {
      const started = Date.now()
      const ok = await post('agents.list', {}, 1500).then(response => response.ok, () => false)
      if (!ok) { log('events.jsonl', { name, event: 'app-gone', ms: Date.now() - started }); break }
      await wait(250)
    }
    await stream(['gap-done:' + name], 10)
  } else if (long) {
    name = long[1]
    await stream([...Array.from({ length: 150 }, (_, i) => 'w' + i + ' '), 'long-done:' + name], 300)
  } else await stream(['noted'], 10)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  log('events.jsonl', { name, event: 'turn-end' })
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

try {
  const inst = await launchParked({ mode: 'spawn', name: 'restart-gap', env: { CONDUCTOR_RUNTIME_HOST: '1' }, fixtures: { 'fake-claude.mjs': FIXTURE } })
  const fixtures = join(inst.root, 'fixtures')
  const prompts = () => lines(join(fixtures, 'prompts.jsonl')), events = () => lines(join(fixtures, 'events.jsonl'))
  await page(inst)
  await openProject({ name: 'Restart gap resume', git: true })
  const gap = (await openTab({ provider: 'claude', title: 'gap wizard' })).resourceId
  const steady = (await openTab({ provider: 'claude', title: 'steady wizard' })).resourceId
  const view = await page(inst)
  for (const id of [gap, steady]) await view.evaluate(async id => {
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.saveSettings(id, { ...state.settings, wizard: true })
  }, id)

  step('the steady wizard streams, then the gap wizard restarts Conductor from its turn')
  await call('agents.submit', { agentSessionId: steady, prompt: 'LONG steady' })
  await poll(() => prompts().some(entry => entry.prompt.startsWith('LONG steady')), { timeoutMs: 60_000, label: 'the steady turn to start' })
  const credentialBefore = inst.credential
  await call('agents.submit', { agentSessionId: gap, prompt: 'GAP gap' })
  const seconds = await relaunched(inst, credentialBefore.pid, { timeoutMs: 90_000 })
  step(`relaunched in ${seconds.toFixed(1)} s`)
  const pidOf = name => prompts().find(entry => entry.name === '?' && entry.prompt.startsWith(name === 'gap' ? 'GAP gap' : 'LONG steady'))?.pid
  const gapPid = pidOf('gap'), steadyPid = pidOf('steady')

  step('S1 the gap wizard is brought back')
  await poll(() => prompts().some(entry => /This wizard tab was brought back/.test(entry.prompt) && entry.name === 'gap'), { timeoutMs: 90_000, intervalMs: 1000, label: 'the gap wizard to get the resume message' })
  // Give a second, wrongly-sent message time to arrive before counting.
  await poll(() => events().some(entry => entry.name === 'steady' && entry.event === 'turn-end'), { timeoutMs: 120_000, intervalMs: 1000, label: 'the steady turn to end' })
  await new Promise(resolve => setTimeout(resolve, 8000))
  const gapEvents = events().filter(entry => entry.name === 'gap')
  const endedInGap = gapEvents.findIndex(entry => entry.event === 'app-gone') >= 0 && gapEvents.findIndex(entry => entry.event === 'app-gone') < gapEvents.findIndex(entry => entry.event === 'turn-end')
  const gapResumes = prompts().filter(entry => /This wizard tab was brought back/.test(entry.prompt) && entry.pid === gapPid)
  const gapConductor = prompts().filter(entry => entry.pid === gapPid && /\[Conductor\] Conductor restarted/.test(entry.prompt))
  const gapPids = new Set(prompts().filter(entry => entry.name === 'gap' || entry.prompt.startsWith('GAP')).map(entry => entry.pid))
  record('S1-gap-wizard-resumed', endedInGap && gapResumes.length === 1 && gapConductor.length === 1 && gapPids.size === 1 ? 'PASS' : 'FAIL',
    { endedInGap, resumes: gapResumes.length, conductorMessages: gapConductor.length, processes: gapPids.size, relaunchSeconds: seconds },
    JSON.stringify({ gapEvents, resume: gapResumes[0]?.prompt.slice(0, 300) }))

  step('S2 the running wizard is told once, by the reattach steer')
  const steadyConductor = prompts().filter(entry => entry.pid === steadyPid && /\[Conductor\] Conductor restarted/.test(entry.prompt))
  const steered = steadyConductor.filter(entry => /kept running; continue/.test(entry.prompt))
  const resumedToo = steadyConductor.filter(entry => /brought back/.test(entry.prompt))
  const snapshot = JSON.stringify(await call('agents.snapshot', { agentSessionId: steady }))
  record('S2-running-wizard-steered', steered.length === 1 && resumedToo.length === 0 && snapshot.includes('long-done:steady') ? 'PASS' : 'FAIL',
    { steered: steered.length, resumeMessages: resumedToo.length },
    JSON.stringify(steadyConductor.map(entry => entry.prompt.slice(0, 200))))

  const close = await safeClose(inst)
  record('restart-gap-close', close.leftovers.length === 0 ? 'PASS' : 'FAIL', { killed: close.killed.length, leftovers: close.leftovers.length })
} catch (error) {
  await failed(error, 'restart-gap')
}
await finish()
