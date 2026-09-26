// VR9a (verify loop v3) dolphin-useful-like-any-model after FX40 (8174e69): real Dolphin on the running
// server, no research toggle, real web tools (CONDUCTOR_OFFLINE_TESTS unset). New owner-style wording,
// not FX40's or VR8c's.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr9a-dolphin.mjs [--only Q1,Q2,Q3] [--label L]
// Q1: one conversation: 5 current questions (last night, yesterday, right now + a price, an office
//     holder with no time word, latest) between 4 plain questions and 1 history question. Current ones
//     must use the web and cite; plain and history must use no tool. Correctness is graded by the verifier.
// Q2: "find X online and summarize with sources" and a follow-up, fresh tab.
// Q3: budget: a turn made to stagnate (the same list_files call over and over), then an owner message
//     that needs a tool. The stop reports' cumulative rounds must restart on the second message
//     (pre-fix 3a66883 keeps counting: the VR8c "cumulative limit of 72 tool rounds" path). Q3b: the same
//     with a polling task. N: FX40's pole question, the known-good neighbour for the harness.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { visibleTextOffences } from './check-local-visible-text.mjs'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, outputDir, poll, record, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
const only = arg('--only', 'Q1,Q2,Q3,Q3b').split(',')
configure({ name: 'vr9a-dolphin' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr9a' })
watchdog(19 * 60)
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const C = 'current', P = 'plain', H = 'history', R = 'research', W = 'workspace', S = 'stagnate'
const conversations = [
  { id: 'Q1', questions: [
    [P, 'how many ounces are in a pound?'],
    [C, 'did the dodgers win last night?'],
    [P, 'tcp vs udp, whats the difference in a couple of lines'],
    [C, 'how did the s&p 500 close yesterday?'],
    [C, 'whats bitcoin trading at right now?'],
    [H, 'who was president of the united states when the berlin wall fell?'],
    [P, 'what is 72 fahrenheit in celsius'],
    [C, "who's the prime minister of japan?"],
    [P, 'what does a capacitor actually do in a circuit?'],
    [C, "what's the latest stable version of python?"]
  ] },
  { id: 'Q2', questions: [
    [R, 'look online for what reviewers say about the framework laptop 13 and give me a short summary with sources'],
    [R, 'which of those sources is the most recent one, and what date was it published?']
  ] },
  // Known-good neighbour: FX40's own question (read, cited, Russell 3/3 in smoke-fx40-dolphin.mjs).
  { id: 'N', questions: [[C, 'who got pole position for the azerbaijan grand prix this weekend?']] },
  { id: 'Q3', questions: [
    [S, 'This is a test of your tool loop. Call list_files with {"path": "ghost"}. Then call list_files with exactly {"path": "ghost"} again, and again - repeat that identical call at least 12 times before you write anything. Do not call any other tool and do not answer until you have made 12 calls.'],
    [W, 'ok forget that. read README.md and tell me what its first line says']
  ] },
  // Q3b: a polling task a small model keeps repeating (the owner's stagnation shape), then a tool request.
  { id: 'Q3b', questions: [
    [S, 'Wait for the build: call list_files on the folder "inbox" once per round until a file named done.txt shows up there. It will appear soon. Never give up and never answer before done.txt is listed - just call list_files on "inbox" again.'],
    [W, 'never mind the build. read README.md and tell me what its first line says']
  ] }
]
const tool = name => String(name ?? '').split('__').at(-1)

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  record('env', 'INFO', { servers: (await call('local.servers')).map(server => ({ pid: server.pid, model: server.model })) }, 'local.servers seen by the parked instance')
  await openProject({ name: 'VR9a dolphin', files: { 'README.md': '# VR9a dolphin notes\n\nA scratch folder.\n' } })
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
      const stop = part.map(item => item.type === 'notice' ? item.payload?.localStop : undefined).filter(Boolean).at(-1)
      const read = tools.filter(t => t.name === 'web_read' && t.status !== 'failed').map(t => String(t.input.url ?? ''))
      const links = [...answer.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map(m => m[0])
      const web = tools.some(t => /^web_/.test(t.name))
      const shape = kind === C || kind === R ? web && links.length > 0 : kind === P || kind === H ? tools.length === 0 : kind === W ? tools.length > 0 && status.phase === 'completed' : true
      turns.push({ q: index + 1, kind, prompt, seconds: Math.round((Date.now() - started) / 1000), phase: status.phase, tools: tools.map(t => `${t.name}:${t.status}`), toolInputs: tools.map(t => JSON.stringify(t.input).slice(0, 200)), read, links, shape, stop: stop ? { reason: stop.reason, rounds: stop.rounds, hardLimit: stop.hardLimit, task: stop.task, detail: String(stop.detail ?? '').slice(0, 300) } : null, answer })
      console.log(`[${conversation.id} Q${index + 1} ${kind}] ${turns.at(-1).seconds}s ${status.phase} shape=${shape} tools=${tools.map(t => t.name).join(',') || '-'} stop=${stop ? stop.reason + '/' + stop.rounds : '-'}\n  ${answer.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
    const saved = projection(id)
    writeFileSync(join(outputDir(), `${label}${conversation.id}.projection.json`), JSON.stringify(saved, null, 2))
    writeFileSync(join(outputDir(), `${label}${conversation.id}.answers.json`), JSON.stringify(turns, null, 2))
    const offences = visibleTextOffences(saved)
    const fake = /\[Conductor/.test(turns.map(t => t.answer).join('\n'))
    const numbers = { turns: turns.map(({ answer, prompt, toolInputs, ...rest }) => rest), offences: offences.length, fake }
    if (conversation.id.startsWith('Q3')) {
      const [first, second] = turns
      const blocked = Boolean(first.stop && ['stagnation', 'round_limit'].includes(first.stop.reason))
      const renewed = blocked && second.stop ? second.stop.rounds < first.stop.rounds + Math.max(1, second.tools.length) : null
      record(`${label}${conversation.id}`, !blocked ? 'NOT RUN (model)' : renewed && second.shape ? 'PASS' : 'FAIL', { ...numbers, blocked, renewed, rounds: [first.stop?.rounds, second.stop?.rounds] },
        `turn 1 must stop blocked; turn 2 uses a tool and its cumulative rounds restart (HEAD) instead of continuing (pre-fix); ${label}${conversation.id}.answers.json`)
    } else {
      const shaped = turns.filter(t => t.shape).length
      record(`${label}${conversation.id}`, shaped === turns.length && !offences.length && !fake ? 'PASS' : 'FAIL', { ...numbers, shaped: `${shaped}/${turns.length}` },
        `shape only (current/research: web tool + a link; plain/history: no tool); correctness graded by the verifier; ${label}${conversation.id}.answers.json`)
    }
  }
} catch (error) {
  await failed(error)
}
await finish()
