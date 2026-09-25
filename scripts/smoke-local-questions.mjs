// FX29 dolphin-useful-like-any-model: the owner-style question set (scripts/local-models/questions.json)
// asked of a real model in a parked Conductor, graded by scripts/local-models/question-set.mjs.
// Every conversation is its own tab; the questions of one conversation go to that tab in order,
// so a follow-up sees the previous answer. No grant is turned on: this is a tab as the owner opens it.
//   node scripts/smoke-lock.mjs --timeout-min 60 -- node scripts/smoke-local-questions.mjs [--provider local] [--model local/dolphin-x1-8b] [--pace 20] [--only Q4,Q8]
// Local models need their server free to start (one llama.cpp server at a time); a server this
// machine already runs for the model is used as it is.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gradeAnswer, loadQuestionSet, summarize } from './local-models/question-set.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback }
const provider = flag('provider', 'local')
const model = flag('model', provider === 'local' ? 'local/dolphin-x1-8b' : 'sonnet')
const pace = Number(flag('pace', '20'))
const only = flag('only')?.split(',')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = resolve('artifacts/local-questions', `parked-${stamp}-${`${provider}-${model}`.replace(/[^a-z0-9.-]+/gi, '_')}`)
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-questions-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Scratch project for the question set\n')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const sleep = ms => new Promise(done => setTimeout(done, ms))
const poll = async (read, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const value = await read(); if (value) return value; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
// The frontier tabs name their tools differently; the grader speaks the local names.
const toolName = name => /web_?search/i.test(name) ? 'web_search' : /web_?(fetch|read)/i.test(name) ? 'web_read' : name

const grades = []
const transcript = []
let child
try {
  const log = openSync(join(output, 'app.log'), 'a')
  child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 90_000)
  const call = async (method, args = {}, projectId) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await response.json(); if (response.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const project = await call('projects.open', { path: projectPath, name: 'Question set' })
  const set = loadQuestionSet()
  const projection = id => {
    const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
    try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() }
  }
  for (const conversation of set.conversations) {
    const questions = conversation.questions.filter(question => !only || only.includes(question.id))
    if (!questions.length) continue
    const open = provider === 'local'
      ? { kind: 'agent', provider, model, permission: 'accept-edits', exactPermission: true, title: conversation.id }
      : { kind: 'agent', provider, model, title: conversation.id }
    // A fresh workspace can miss its first acknowledgement while the window is still settling.
    const tab = await call('tabs.open', open, project.id).catch(async error => {
      if (!/did not acknowledge/.test(String(error))) throw error
      await sleep(10_000)
      return call('tabs.open', open, project.id)
    }).then(result => result.resourceId)
    let seen = 0
    for (const question of questions) {
      if (grades.length && pace) await sleep(pace * 1000)
      const started = Date.now()
      await call('agents.submit', { agentSessionId: tab, prompt: question.prompt })
      const userCount = () => (projection(tab).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
      // Settled means this question's own message is in the transcript and the turn is over again.
      const status = await poll(async () => { const current = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted', 'idle'].includes(current.phase) && Date.now() - started > 3000 && userCount() > seen ? current : null }, 600_000, 2000)
      const items = (projection(tab).items ?? []).map(item => item.data).filter(Boolean)
      // This question's part of the conversation: everything after its own user message.
      const userIndexes = items.map((item, index) => item.type === 'text' && item.role === 'user' ? index : -1).filter(index => index >= 0)
      const from = userIndexes[seen] ?? items.length
      seen++
      const part = items.slice(from + 1, userIndexes[seen] ?? items.length)
      const tools = part.filter(item => item.type === 'tool').map(item => ({ name: toolName(item.name), input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? {}), failed: item.status === 'failed', output: String(item.output ?? '').slice(0, 400) }))
      const answer = part.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
      const grade = gradeAnswer(question, { answer, tools, phase: status.phase === 'idle' ? 'completed' : status.phase })
      grades.push(grade)
      transcript.push({ id: question.id, conversation: conversation.id, tab, prompt: question.prompt, phase: status.phase, elapsedMs: Date.now() - started, answer, tools, grade })
      console.log(`[${question.id}] ${grade.pass ? 'PASS' : 'FAIL'} ${Math.round((Date.now() - started) / 100) / 10}s tools=${grade.tools.join(',') || '-'} ${grade.failures.join('; ')}\n  ${answer.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
    await writeFile(join(output, `${conversation.id}.projection.json`), JSON.stringify(projection(tab), null, 2))
  }
} catch (error) {
  console.error('FAILED', error?.stack ?? error)
  process.exitCode = 1
} finally {
  if (child) try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  const summary = summarize(grades)
  await writeFile(join(output, 'results.json'), JSON.stringify({ provider, model, pace, at: new Date().toISOString(), summary, transcript }, null, 2))
  console.log(JSON.stringify(summary), output)
  if (!summary.pass) process.exitCode = 1
}
