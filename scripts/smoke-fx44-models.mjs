// FX44 Part B: which installed local model is useful for web questions and swarms. The same owner-style
// set as VR9d (5 current questions between 4 plain and 1 history question; a research question and its
// follow-up) and VR9a's timesheet swarm, run on any installed local model in a parked instance, with the
// time per answer. No new downloads; one llama.cpp server at a time: a model other than the running one
// is started through Conductor's own admission path (an idle server this Conductor started gives way),
// and a server this parked instance started is stopped with it at the end.
//   node scripts/smoke-lock.mjs --timeout-min 40 -- node scripts/smoke-fx44-models.mjs --model local/ornith1.5-9b --only A [--label L] [--minutes 35]
// --only takes one of A, R, T (or a comma list). Correctness is graded by the verifier against the truth
// re-checked on the day; this script saves answers, pages read and timings under
// artifacts/verification/2026-09-26-fx44.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, sleep, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const MODEL = arg('--model', 'local/dolphin-x1-8b')
const short = MODEL.replace(/^local\//, '')
const label = arg('--label', short)
const only = arg('--only', 'A').split(',')
const minutes = Number(arg('--minutes', '35'))
configure({ name: `fx44-${label}-${only.join('')}`, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-fx44' })
watchdog(minutes * 60)
await loadCheck()

const C = 'current', P = 'plain', H = 'history', R = 'research'
const conversations = [
  { id: 'A', questions: [
    [P, 'how many feet are in a mile'],
    [C, 'what was the final score of the yankees game last night'],
    [P, "what's the difference between weather and climate, keep it short"],
    [C, 'how much did the nasdaq go up or down yesterday?'],
    [C, 'how much is an ounce of gold going for right now'],
    [H, 'when did the titanic sink and roughly how many people died?'],
    [P, 'convert 5 kilometers to miles'],
    [C, "who's the german chancellor at the moment?"],
    [P, 'why does ice float on water?'],
    [C, "what's the latest version of ios?"]
  ] },
  { id: 'R', questions: [
    [R, 'find what reviewers are saying about the google pixel 10 pro online and sum it up for me, with sources'],
    [R, 'which of those reviews did you actually open, and what was the main complaint in it?']
  ] }
]
const tool = name => String(name ?? '').split('__').at(-1)
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'idle'])
const llama = async () => (await listProcesses()).list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)).map(p => p.pid)
const servers = async () => (await call('local.servers')).map(server => ({ pid: server.pid, model: server.model }))

// VR9a's timesheet task.
const week1 = [['ana', 7.5], ['ben', 8], ['ana', 6.25], ['cara', 9], ['ben', 4.5], ['cara', 3.75], ['ana', 8], ['ben', 7.25]]
const week2 = [['ana', 5], ['ben', 9.5], ['cara', 8.5], ['ana', 7.75], ['cara', 6], ['ben', 3.25], ['ana', 4.5], ['cara', 2.5]]
const csv = rows => 'person,hours\n' + rows.map(([p, h]) => `${p},${h}`).join('\n') + '\n'
const sum = rows => rows.reduce((acc, [p, h]) => ({ ...acc, [p]: (acc[p] ?? 0) + h }), {})
const w1 = sum(week1), w2 = sum(week2)
const both = Object.fromEntries(Object.keys(w1).map(p => [p, w1[p] + w2[p]])) // ana 39, ben 32.5, cara 29.75
const most = Object.keys(both).sort((a, b) => both[b] - both[a])[0]
const named = text => Object.fromEntries([...String(text).matchAll(/\b(ana|ben|cara)\b[^\d\n]{0,30}?(\d+(?:\.\d+)?)/gi)].map(m => [m[1].toLowerCase(), Number(m[2])]))
const score = (text, truth) => { const got = named(text); return Object.keys(truth).filter(p => got[p] === truth[p]).length }
const prose = text => String(text).split(/Computed with calculate/)[0]
const snap = id => call('agents.snapshot', { agentSessionId: id })
const texts = (state, role, afterSeq = 0) => (state.items ?? []).filter(item => item.data?.type === 'text' && item.data.role === role && (item.sequence ?? 0) > afterSeq).map(item => item.data.text)
const toolItems = state => (state.items ?? []).filter(item => item.data?.type === 'tool').map(item => ({ name: tool(item.data.name), input: item.data.input, status: item.data.status }))
async function quiet(ids, { timeoutMs, label: what }) {
  let streak = 0
  await poll(async () => {
    const phases = await Promise.all(ids.map(async id => (await call('agents.status', { agentSessionId: id }).catch(() => ({ phase: 'gone' }))).phase))
    streak = phases.every(phase => SETTLED.has(phase) || phase === 'gone') ? streak + 1 : 0
    return streak >= 3
  }, { timeoutMs, intervalMs: 3000, label: what })
}
async function ask(id, prompt, timeoutMs) {
  const before = (await snap(id)).sequence ?? 0
  const started = Date.now()
  await call('agents.submit', { agentSessionId: id, prompt })
  await poll(async () => Date.now() - started > 4000 && ((await snap(id)).sequence ?? 0) > before, { timeoutMs: 5 * 60_000, label: 'turn start' })
  await quiet([id], { timeoutMs, label: `turn of ${id}` })
  return { before, seconds: Math.round((Date.now() - started) / 1000) }
}
const localTabs = async () => (await call('tabs.list')).filter(tab => tab.kind === 'agent' && tab.state?.provider === 'local')

try {
  const inst = await launchParked({ mode: 'playwright', env: only.some(id => id !== 'T') ? { CONDUCTOR_OFFLINE_TESTS: undefined } : {} })
  record('env', 'INFO', { model: MODEL, servers: await servers(), llamaServers: await llama() }, 'local servers before the run')
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  await openProject({ name: `FX44 ${short}`, files: { 'README.md': '# FX44 notes\n\nA scratch folder.\n', 'week1.csv': csv(week1), 'week2.csv': csv(week2) } })
  for (const conversation of conversations.filter(entry => only.includes(entry.id))) {
    step(`${conversation.id}: open`)
    const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: conversation.id })
    const id = tab.resourceId
    const turns = []
    for (const [index, [kind, prompt]] of conversation.questions.entries()) {
      step(`${conversation.id} Q${index + 1} (${kind})`)
      const started = Date.now()
      await call('agents.submit', { agentSessionId: id, prompt })
      const users = () => (projection(id).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
      // The first turn of a model that is not running yet includes its server start.
      const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return SETTLED.has(s.phase) && Date.now() - started > 3000 && users() > index ? s : null }, { timeoutMs: 12 * 60_000, intervalMs: 2000, label: `${conversation.id} Q${index + 1}` })
      const items = (projection(id).items ?? []).map(item => item.data).filter(Boolean)
      const userAt = items.map((item, at) => item.type === 'text' && item.role === 'user' ? at : -1).filter(at => at >= 0)
      const part = items.slice(userAt[index] + 1, userAt[index + 1] ?? items.length)
      const tools = part.filter(item => item.type === 'tool').map(item => ({ name: tool(item.name), input: item.input ?? {}, status: item.status }))
      const answer = part.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
      const read = tools.filter(t => t.name === 'web_read' && t.status !== 'failed').map(t => String(t.input.url ?? ''))
      const links = [...answer.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map(m => m[0])
      const web = tools.some(t => /^web_/.test(t.name))
      const shape = kind === C || kind === R ? web && links.length > 0 : tools.length === 0
      turns.push({ q: index + 1, kind, prompt, seconds: Math.round((Date.now() - started) / 1000), phase: status.phase, tools: tools.map(t => `${t.name}:${t.status}`), read, links, shape, answer })
      console.log(`[${conversation.id} Q${index + 1} ${kind}] ${turns.at(-1).seconds}s ${status.phase} shape=${shape} tools=${tools.map(t => t.name).join(',') || '-'}\n  ${answer.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
    writeFileSync(join(outputDir(), `${label}-${conversation.id}.projection.json`), JSON.stringify(projection(id), null, 2))
    writeFileSync(join(outputDir(), `${label}-${conversation.id}.answers.json`), JSON.stringify(turns, null, 2))
    record(`${label} ${conversation.id}`, turns.every(t => t.shape) ? 'PASS' : 'FAIL', { turns: turns.map(({ answer, prompt, ...rest }) => rest), servers: await servers() }, `shape only; correctness graded by the verifier; ${label}-${conversation.id}.answers.json`)
    await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
  if (only.includes('T')) {
    step('T: owner asks for a swarm')
    const known = new Set((await localTabs()).map(tab => tab.resourceId))
    const controller = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'Timesheets' })
    const ctl = controller.resourceId
    known.add(ctl)
    const first = await ask(ctl, 'I have two timesheets, week1.csv and week2.csv. Open one coworker of yourself per file to add up the hours per person and report back to you. When both have reported, tell me how many hours each person worked over the two weeks together, and who worked the most.', 12 * 60_000)
    const coworkers = (await localTabs()).filter(tab => !known.has(tab.resourceId))
    const t0 = Date.now()
    await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 10 * 60_000, label: 'swarm to settle' })
    await sleep(8000)
    await quiet([ctl, ...coworkers.map(tab => tab.resourceId)], { timeoutMs: 5 * 60_000, label: 'swarm to settle after reports' })
    let state = await snap(ctl)
    let answer = texts(state, 'assistant', first.before).at(-1) ?? ''
    let followUp = null
    if (score(prose(answer), both) < 3) {
      step('T: owner asks for the totals')
      followUp = await ask(ctl, 'so, how many hours did each person work over both weeks, and who worked the most?', 8 * 60_000)
      state = await snap(ctl)
      answer = texts(state, 'assistant', followUp.before).join('\n')
    }
    const co = await Promise.all(coworkers.map(async tab => {
      const s = await snap(tab.resourceId)
      return { title: tab.title, model: s.settings?.model ?? tab.state?.model, tools: toolItems(s).map(t => `${t.name}:${t.status}`) }
    }))
    const result = {
      seconds: Math.round((Date.now() - t0) / 1000) + first.seconds, firstTurnSeconds: first.seconds, followUpSeconds: followUp?.seconds ?? null, coworkers: co, neededFollowUp: Boolean(followUp),
      proseRight: `${score(prose(answer), both)}/3`, withBlockRight: `${score(answer, both)}/3`, mostInProse: new RegExp(`\\b${most}\\b[^.\\n]*(most|highest)|(most|highest)[^.\\n]*\\b${most}\\b`, 'i').test(prose(answer)),
      hasBlock: /Computed with calculate/.test(answer), llamaServers: await llama()
    }
    writeFileSync(join(outputDir(), `${label}-T.json`), JSON.stringify({ expected: { w1, w2, both, most }, result, answer, controllerItems: state.items?.map(item => item.data) }, null, 2))
    record(`${label} T`, co.length === 2 && result.proseRight === '3/3' && result.mostInProse ? 'PASS' : 'FAIL', result, `answer: ${answer.replace(/\s+/g, ' ').slice(0, 500)}`)
    for (const tab of [...coworkers, controller]) await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
  record('env-after', 'INFO', { servers: await servers(), llamaServers: await llama() }, 'local servers after the run')
} catch (error) {
  await failed(error)
}
await finish()
