// VR9f (verify loop v3) dolphin-useful-like-any-model after FX44 (0d2bfec, 7b7fe31, 341b1af): real local
// model, no research toggle, real web tools (CONDUCTOR_OFFLINE_TESTS unset). NEW owner-style wording, not
// FX40's, VR8c's, VR9a's, VR9d's or FX44's.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9f-dolphin.mjs [--only A,R|M] [--model local/dolphin-x1-8b] [--build <out/main/index.js>] [--label L] [--minutes 19]
// A: one conversation, 5 current questions (last night, yesterday, right now + a price, an office holder,
//    latest) between 4 plain questions and 1 history question. Current ones must use the web and cite;
//    plain and history must use no tool. Correctness is graded by the verifier against the web.
// R: "look it up online and give me a summary with sources" and a follow-up about what it actually opened.
// M: 3 of A's current questions alone, for the model table spot-check on another installed model (its
//    server is started through the parked instance's admission path and stopped with it at teardown).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { visibleTextOffences } from './check-local-visible-text.mjs'
import { call, configure, failed, finish, launchParked, listProcesses, loadCheck, openProject, openTab, outputDir, poll, record, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const MODEL = arg('--model', 'local/dolphin-x1-8b')
const label = arg('--label', MODEL.replace(/^local\//, ''))
const only = arg('--only', 'A,R').split(',')
const build = arg('--build', undefined)
configure({ name: `vr9f-${label}-${only.join('')}`, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr9f' })
watchdog(Number(arg('--minutes', '19')) * 60)
await loadCheck()

const C = 'current', P = 'plain', H = 'history', R = 'research'
const dodgers = [C, 'did the dodgers win last night? what was the score']
const dow = [C, 'where did the dow close yesterday']
const fed = [C, "who's running the federal reserve these days?"]
const conversations = [
  { id: 'A', questions: [
    [P, 'how many ounces are in a pound'],
    dodgers,
    [P, 'what does DNA stand for'],
    dow,
    [C, "what's one ethereum worth right now"],
    [H, 'who was the first person to walk on the moon, and what year was that?'],
    [P, "what's the boiling point of water in fahrenheit"],
    fed,
    [P, 'explain inflation to me in two sentences'],
    [C, "what's the newest android version out?"]
  ] },
  { id: 'R', questions: [
    [R, 'look up online what caused the big blackout in spain and portugal last year and give me a summary with sources'],
    [R, 'which of those pages did you actually open, and what did the official report blame?']
  ] },
  { id: 'M', questions: [dodgers, dow, fed] }
]
const tool = name => String(name ?? '').split('__').at(-1)
const SETTLED = new Set(['completed', 'failed', 'interrupted', 'idle'])
const servers = async () => (await call('local.servers')).map(server => ({ pid: server.pid, model: server.model, startedByConductor: server.startedByConductor }))
const llama = async () => (await listProcesses()).list.filter(p => /^llama-server(\.exe)?$/i.test(p.name)).map(p => p.pid)

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_OFFLINE_TESTS: undefined }, ...(build ? { build } : {}) })
  record('env', 'INFO', { model: MODEL, build: build ?? 'repo out/', servers: await servers(), llamaServers: await llama() }, 'local servers seen by the parked instance')
  await openProject({ name: 'VR9f', files: { 'README.md': '# VR9f notes\n\nA scratch folder.\n' } })
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
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
      // The first turn on a model that is not running yet includes its server start.
      const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return SETTLED.has(s.phase) && Date.now() - started > 3000 && users() > index ? s : null }, { timeoutMs: (index === 0 ? 10 : 5) * 60_000, intervalMs: 2000, label: `${conversation.id} Q${index + 1}` })
      const items = (projection(id).items ?? []).map(item => item.data).filter(Boolean)
      const userAt = items.map((item, at) => item.type === 'text' && item.role === 'user' ? at : -1).filter(at => at >= 0)
      const part = items.slice(userAt[index] + 1, userAt[index + 1] ?? items.length)
      const tools = part.filter(item => item.type === 'tool').map(item => ({ name: tool(item.name), input: item.input ?? {}, status: item.status }))
      const answer = part.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
      const read = tools.filter(t => t.name === 'web_read' && t.status !== 'failed').map(t => String(t.input.url ?? ''))
      const links = [...answer.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map(m => m[0])
      const web = tools.some(t => /^web_/.test(t.name))
      const shape = kind === C || kind === R ? web && links.length > 0 : tools.length === 0
      turns.push({ q: index + 1, kind, prompt, seconds: Math.round((Date.now() - started) / 1000), phase: status.phase, tools: tools.map(t => `${t.name}:${t.status}`), toolInputs: tools.map(t => JSON.stringify(t.input).slice(0, 200)), read, links, shape, answer })
      console.log(`[${conversation.id} Q${index + 1} ${kind}] ${turns.at(-1).seconds}s ${status.phase} shape=${shape} tools=${tools.map(t => t.name).join(',') || '-'}\n  ${answer.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
    const saved = projection(id)
    writeFileSync(join(outputDir(), `${label}-${conversation.id}.projection.json`), JSON.stringify(saved, null, 2))
    writeFileSync(join(outputDir(), `${label}-${conversation.id}.answers.json`), JSON.stringify(turns, null, 2))
    const offences = visibleTextOffences(saved)
    const fake = /\[Conductor/.test(turns.map(t => t.answer).join('\n'))
    const shaped = turns.filter(t => t.shape).length
    record(`${label} ${conversation.id}`, shaped === turns.length && !offences.length && !fake ? 'PASS' : 'FAIL',
      { turns: turns.map(({ answer, prompt, toolInputs, links, ...rest }) => rest), offences: offences.length, fake, shaped: `${shaped}/${turns.length}` },
      `shape only (current/research: web tool + a link; plain/history: no tool); correctness graded by the verifier; ${label}-${conversation.id}.answers.json`)
    await call('tabs.close', { tabId: tab.id }).catch(() => undefined)
  }
  record('env-after', 'INFO', { servers: await servers(), llamaServers: await llama() }, 'local servers after the run')
} catch (error) {
  await failed(error)
}
await finish()
