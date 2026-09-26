// VR9d (verify loop v3) dolphin-useful-like-any-model after FX42 (557e32f): real Dolphin on the running
// server, no research toggle, real web tools (CONDUCTOR_OFFLINE_TESTS unset). NEW owner-style wording,
// not FX40's, VR8c's, VR9a's or FX42's.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9d-dolphin.mjs [--only A,R] [--label L]
// A: one conversation, 5 current questions (last night, yesterday, right now + a price, an office holder
//    with a loose time word, latest) between 4 plain questions and 1 history question. Current ones must
//    use the web and cite; plain and history must use no tool. Correctness is graded by the verifier
//    against the web, and every miss is classified from the saved projection (which pages were read and
//    what they said).
// R: "find X online and sum it up with sources" and a follow-up about what it actually opened, fresh tab.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { visibleTextOffences } from './check-local-visible-text.mjs'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, outputDir, poll, record, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
const only = arg('--only', 'A,R').split(',')
configure({ name: 'vr9d-dolphin' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr9d' })
watchdog(19 * 60)
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
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

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  record('env', 'INFO', { servers: (await call('local.servers')).map(server => ({ pid: server.pid, model: server.model })) }, 'local.servers seen by the parked instance')
  await openProject({ name: 'VR9d dolphin', files: { 'README.md': '# VR9d dolphin notes\n\nA scratch folder.\n' } })
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
      const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted', 'idle'].includes(s.phase) && Date.now() - started > 3000 && users() > index ? s : null }, { timeoutMs: 5 * 60_000, intervalMs: 2000, label: `${conversation.id} Q${index + 1}` })
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
    writeFileSync(join(outputDir(), `${label}${conversation.id}.projection.json`), JSON.stringify(saved, null, 2))
    writeFileSync(join(outputDir(), `${label}${conversation.id}.answers.json`), JSON.stringify(turns, null, 2))
    const offences = visibleTextOffences(saved)
    const fake = /\[Conductor/.test(turns.map(t => t.answer).join('\n'))
    const shaped = turns.filter(t => t.shape).length
    record(`${label}${conversation.id}`, shaped === turns.length && !offences.length && !fake ? 'PASS' : 'FAIL',
      { turns: turns.map(({ answer, prompt, toolInputs, links, ...rest }) => rest), offences: offences.length, fake, shaped: `${shaped}/${turns.length}` },
      `shape only (current/research: web tool + a link; plain/history: no tool); correctness graded by the verifier; ${label}${conversation.id}.answers.json`)
  }
} catch (error) {
  await failed(error)
}
await finish()
