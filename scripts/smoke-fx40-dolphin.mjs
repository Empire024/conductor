// FX40: Dolphin answers current questions from the web. VR8c's C1 on the real running server, no
// research toggle, real web tools (CONDUCTOR_OFFLINE_TESTS unset). VR8c before FX40: "who got pole
// position for the azerbaijan grand prix this weekend?" answered "Max Verstappen" from memory 3/4
// (truth George Russell), because the web cue list missed "this weekend".
//   node scripts/smoke-lock.mjs --timeout-min 30 -- node scripts/smoke-fx40-dolphin.mjs [--runs 2] [--label x]
// Per run, one conversation with C1's four questions. Graded: Q1 (plain) and the P questions use no
// tool; Q2 read a page with web_read and its answer cites a page it read; the answer names Russell
// (INFO, the verifier's truth on 2026-09-26). The visible-text check runs on every projection.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { visibleTextOffences } from './check-local-visible-text.mjs'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, outputDir, poll, record, step, watchdog } from './verify-kit.mjs'

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = arg('--label', '')
const runs = Number(arg('--runs', '2'))
configure({ name: 'fx40-dolphin' + (label ? '-' + label : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-fx40' })
watchdog(runs * 12 * 60 + 8 * 60)
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const C1 = [
  'whats the difference between a mutex and a semaphore? keep it short',
  'who got pole position for the azerbaijan grand prix this weekend?',
  'can you find out online what changed in the latest typescript release and summarize it with sources?',
  'which of those changes would matter most for an existing project, and when was that version released?'
]
const PLAIN = ['how many grams of butter is 1 cup', 'explain how pole vaulting works in two sentences']
const conversations = [...Array.from({ length: runs }, (_, n) => ({ id: `C1r${n + 1}`, questions: C1 })), { id: 'P', questions: PLAIN }]
const tool = name => String(name ?? '').split('__').at(-1)

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  record('env', 'INFO', { servers: (await call('local.servers')).map(server => ({ pid: server.pid, model: server.model })) }, 'local.servers seen by the parked instance')
  await openProject({ name: 'FX40 dolphin', files: { 'README.md': '# FX40 dolphin\n' } })
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  for (const conversation of conversations) {
    step(`${conversation.id}: open`)
    const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: conversation.id })
    const id = tab.resourceId
    const turns = []
    for (const [index, prompt] of conversation.questions.entries()) {
      step(`${conversation.id} Q${index + 1}`)
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
      const cited = read.filter(url => url && answer.includes(url))
      turns.push({ q: index + 1, prompt, seconds: Math.round((Date.now() - started) / 1000), phase: status.phase, tools: tools.map(t => `${t.name}:${t.status}`), read, cited, answer })
      console.log(`[${conversation.id} Q${index + 1}] ${turns.at(-1).seconds}s ${status.phase} tools=${tools.map(t => t.name).join(',') || '-'}\n  ${answer.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
    const saved = projection(id)
    writeFileSync(join(outputDir(), `${label}${conversation.id}.projection.json`), JSON.stringify(saved, null, 2))
    writeFileSync(join(outputDir(), `${label}${conversation.id}.answers.json`), JSON.stringify(turns, null, 2))
    const offences = visibleTextOffences(saved)
    const fake = /\[Conductor/.test(turns.map(t => t.answer).join('\n'))
    const numbers = { turns: turns.map(({ answer, prompt, ...rest }) => rest), offences: offences.length }
    if (conversation.id === 'P') {
      const direct = turns.every(t => !t.tools.length)
      record(`${label}P`, direct && !offences.length && !fake ? 'PASS' : 'FAIL', numbers, `plain questions answered with no tool call: ${direct}; answers in P.answers.json`)
    } else {
      const [q1, q2] = turns
      const plainDirect = !q1.tools.length
      const pole = q2.read.length > 0 && q2.cited.length > 0
      const russell = /russell/i.test(q2.answer)
      record(`${label}${conversation.id}`, plainDirect && pole && !offences.length && !fake && turns.every(t => t.phase !== 'failed') ? 'PASS' : 'FAIL', { ...numbers, plainDirect, poleReadAndCited: pole, poleNamesRussell: russell },
        `Q2 answer: ${q2.answer.replace(/\s+/g, ' ').slice(0, 400)}; ${conversation.id}.answers.json`)
    }
  }
} catch (error) {
  await failed(error)
}
await finish()
