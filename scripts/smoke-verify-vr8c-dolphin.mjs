// VR8c (verify loop v3) dolphin-useful-like-any-model on the named build: real Dolphin on the running
// server, no research toggle, CONDUCTOR_OFFLINE_TESTS unset (the web tools are real).
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8c-dolphin.mjs [--keep]
// C1: four new owner-style questions in one conversation (plain, this week's event, find online with
//     sources, follow-up). C3: VR7 row 19's research trigger in two fresh tabs (2 of 2).
// Each conversation's saved projection goes through check-local-visible-text.mjs; the visible pane's
// text and a screenshot are kept for the verifier to read. Answers are graded by the verifier.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { visibleTextOffences } from './check-local-visible-text.mjs'
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, outputDir, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

configure({ name: 'vr8c-dolphin' + (process.argv.includes('--label') ? '-' + process.argv[process.argv.indexOf('--label') + 1] : ''), output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8c' })
watchdog(19 * 60)
await loadCheck()

const MODEL = 'local/dolphin-x1-8b'
const conversations = [
  { id: 'C1', questions: [
    'whats the difference between a mutex and a semaphore? keep it short',
    'who got pole position for the azerbaijan grand prix this weekend?',
    'can you find out online what changed in the latest typescript release and summarize it with sources?',
    'which of those changes would matter most for an existing project, and when was that version released?'
  ] },
  { id: 'C3a', questions: ['can you find some reviews of the steam deck oled online and sum up the pros and cons? include links'] },
  { id: 'C3b', questions: ['can you find some reviews of the steam deck oled online and sum up the pros and cons? include links'] }
]
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : ''
const tool = name => String(name ?? '').split('__').at(-1)

try {
  const inst = await launchParked({ mode: 'playwright', env: { CONDUCTOR_OFFLINE_TESTS: undefined } })
  record('env', 'INFO', { servers: (await call('local.servers')).map(server => ({ pid: server.pid, model: server.model })) }, 'local.servers seen by the parked instance')
  await openProject({ name: 'VR8c dolphin', files: { 'README.md': '# VR8c dolphin\n' } })
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  for (const conversation of conversations.filter(entry => !only || only.includes(entry.id))) {
    step(`${conversation.id}: open`)
    const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: conversation.id })
    const id = tab.resourceId
    const turns = []
    for (const [index, prompt] of conversation.questions.entries()) {
      step(`${conversation.id} Q${index + 1}`)
      const started = Date.now()
      await call('agents.submit', { agentSessionId: id, prompt })
      const users = () => (projection(id).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
      const status = await poll(async () => { const s = await call('agents.status', { agentSessionId: id }); return ['completed', 'failed', 'interrupted', 'idle'].includes(s.phase) && Date.now() - started > 3000 && users() > index ? s : null }, { timeoutMs: 4 * 60_000, intervalMs: 2000, label: `${conversation.id} Q${index + 1}` })
      const items = (projection(id).items ?? []).map(item => item.data).filter(Boolean)
      const userAt = items.map((item, at) => item.type === 'text' && item.role === 'user' ? at : -1).filter(at => at >= 0)
      const part = items.slice(userAt[index] + 1, userAt[index + 1] ?? items.length)
      const tools = part.filter(item => item.type === 'tool').map(item => ({ name: tool(item.name), input: JSON.stringify(item.input ?? {}).slice(0, 200), status: item.status }))
      const answer = part.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
      const statuses = part.filter(item => item.type === 'text' && item.role === 'status').map(item => item.text.length)
      turns.push({ q: index + 1, prompt, seconds: Math.round((Date.now() - started) / 1000), phase: status.phase, tools, statusItems: statuses.length, longestStatus: Math.max(0, ...statuses), answerChars: answer.length, answer })
      console.log(`[${conversation.id} Q${index + 1}] ${turns.at(-1).seconds}s ${status.phase} tools=${tools.map(t => t.name).join(',') || '-'}\n  ${answer.replace(/\s+/g, ' ').slice(0, 400)}`)
    }
    const saved = projection(id)
    writeFileSync(join(outputDir(), `${label}${conversation.id}.projection.json`), JSON.stringify(saved, null, 2))
    const offences = visibleTextOffences(saved)
    await call('tabs.focus', { tabId: tab.id })
    const view = await page()
    await view.waitForTimeout(1500)
    const paneText = await view.locator('.pane-workspace').first().innerText().catch(error => 'innerText failed: ' + error.message)
    writeFileSync(join(outputDir(), `${label}${conversation.id}.visible.txt`), paneText)
    const picture = await shot(`${label}${conversation.id}-timeline`)
    const fake = /\[Conductor/.test(turns.map(t => t.answer).join('\n'))
    const webUsed = turns.filter((t, at) => conversation.id !== 'C1' || at > 0).every(t => t.tools.some(x => /^web_/.test(x.name)))
    record(label + conversation.id, !offences.length && !fake && turns.every(t => t.phase !== 'failed') ? 'PASS' : 'FAIL',
      { turns: turns.map(({ answer, ...rest }) => ({ ...rest, tools: rest.tools.map(x => x.name) })), offences: offences.length, webUsed },
      `visible-text check (no status >500 chars, no "[Conductor"); answers graded by the verifier in the report; ${conversation.id}.projection.json, ${conversation.id}.visible.txt, ${picture}`)
    writeFileSync(join(outputDir(), `${label}${conversation.id}.answers.json`), JSON.stringify(turns, null, 2))
  }
} catch (error) {
  await failed(error)
}
await finish()
