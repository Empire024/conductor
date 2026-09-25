// VR7 row 19 (dolphin-useful-like-any-model reopened): on real Dolphin in a parked Conductor, the
// fixer's 9 owner-style questions (scripts/local-models/questions.json) plus VR7's 3 new ones, each
// conversation in its own tab. Passes when no status text item is over ~500 characters and no
// visible model text contains "[Conductor" (scripts/check-local-visible-text.mjs); the answers are
// still graded with the question set's own grader and reported. Uses the running server as it is.
//   node scripts/smoke-lock.mjs --timeout-min 60 -- node scripts/smoke-local-visible-text.mjs [--build] [--model local/dolphin-x1-8b]
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gradeAnswer, loadQuestionSet } from './local-models/question-set.mjs'
import { visibleTextOffences } from './check-local-visible-text.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback }
const model = flag('model', 'local/dolphin-x1-8b')
if (argv.includes('--build')) {
  const built = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0) throw new Error('electron-vite build failed')
}
const output = resolve('artifacts/local-visible-text', new Date().toISOString().replace(/[:.]/g, '-'))
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-visible-'))
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Scratch project for the visible-text smoke\n')
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const sleep = ms => new Promise(done => setTimeout(done, ms))
const poll = async (read, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const value = await read(); if (value) return value; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const toolName = name => String(name ?? '').split('__').at(-1)
const conversations = [
  ...loadQuestionSet().conversations,
  { id: 'vr7-current', questions: [{ id: 'D2a', kind: 'current', prompt: 'who won the most recent formula 1 grand prix, and which race was it?', expect: {} }] },
  { id: 'vr7-research', questions: [
    { id: 'D2b', kind: 'research', prompt: 'can you find some reviews of the steam deck oled online and sum up the pros and cons? include links', expect: {} },
    { id: 'D2c', kind: 'followup', prompt: 'which of those reviews was the most critical and what was their main complaint?', expect: {} }
  ] }
]

let app
const killElectron = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else app.process().kill('SIGKILL') } catch { /* already gone */ } }
const watchdog = setTimeout(() => { console.error('FAIL smoke-local-visible-text exceeded 55 min'); killElectron(); process.exit(1) }, 55 * 60_000)
watchdog.unref()
const results = [], offences = []
let failed = false
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  await app.firstWindow()
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 90_000)
  const call = async (method, args = {}, projectId) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }), signal: AbortSignal.timeout(60_000) })
    const body = await response.json(); if (response.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  console.log('local servers:', JSON.stringify(await call('local.servers').catch(() => null)))
  const project = await call('projects.open', { path: projectPath, name: 'Visible text smoke' })
  const projection = id => { const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  for (const conversation of conversations) {
    const args = { kind: 'agent', provider: 'local', model, permission: 'accept-edits', exactPermission: true, title: conversation.id }
    const tab = (await call('tabs.open', args, project.id).catch(async error => { if (!/did not acknowledge/.test(String(error))) throw error; await sleep(10_000); return call('tabs.open', args, project.id) })).resourceId
    let seen = 0
    for (const question of conversation.questions) {
      const started = Date.now()
      await call('agents.submit', { agentSessionId: tab, prompt: question.prompt })
      const users = () => (projection(tab).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
      const status = await poll(async () => { const current = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted', 'idle'].includes(current.phase) && Date.now() - started > 3000 && users() > seen ? current : null }, 8 * 60_000, 2000)
      const items = (projection(tab).items ?? []).map(item => item.data).filter(Boolean)
      const userAt = items.map((item, index) => item.type === 'text' && item.role === 'user' ? index : -1).filter(index => index >= 0)
      const part = items.slice(userAt[seen] + 1, userAt[seen + 1] ?? items.length)
      seen++
      const tools = part.filter(item => item.type === 'tool').map(item => ({ name: toolName(item.name), input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? {}), failed: item.status === 'failed', output: String(item.output ?? '').slice(0, 400) }))
      const answer = part.filter(item => item.type === 'text' && item.role === 'assistant').map(item => item.text).join('')
      const longestStatus = Math.max(0, ...part.filter(item => item.type === 'text' && item.role === 'status').map(item => item.text.length))
      const grade = question.expect && Object.keys(question.expect).length ? gradeAnswer(question, { answer, tools, phase: status.phase === 'idle' ? 'completed' : status.phase }) : null
      const seconds = Math.round((Date.now() - started) / 1000)
      results.push({ id: question.id, conversation: conversation.id, seconds, phase: status.phase, tools: tools.map(tool => tool.name), longestStatus, grade: grade ? { pass: grade.pass, failures: grade.failures } : 'verifier reads the answer', answer })
      console.log(`[${question.id}] ${seconds}s tools=${tools.map(tool => tool.name).join(',') || '-'} longest status ${longestStatus} chars${grade ? ` grade ${grade.pass ? 'PASS' : 'FAIL ' + grade.failures.join('; ')}` : ''}\n  ${answer.replace(/\s+/g, ' ').slice(0, 260)}`)
    }
    const saved = projection(tab)
    await writeFile(join(output, `${conversation.id}.projection.json`), JSON.stringify(saved, null, 2))
    for (const offence of visibleTextOffences(saved)) offences.push({ conversation: conversation.id, ...offence })
  }
} catch (error) {
  failed = true
  console.error('FAIL', error?.stack ?? error)
} finally {
  killElectron()
  const graded = results.filter(result => typeof result.grade === 'object')
  const summary = { questions: results.length, statusOffences: offences.length, graded: graded.length, gradedPass: graded.filter(result => result.grade.pass).length, longestStatus: Math.max(0, ...results.map(result => result.longestStatus)) }
  await writeFile(join(output, 'result.json'), JSON.stringify({ at: new Date().toISOString(), model, summary, offences, results }, null, 2))
  for (const offence of offences) console.log('OFFENCE', JSON.stringify(offence))
  const pass = !failed && !offences.length && results.length === conversations.reduce((sum, conversation) => sum + conversation.questions.length, 0)
  console.log(pass ? `PASS ${JSON.stringify(summary)}` : `FAIL ${JSON.stringify(summary)}`, output)
  process.exit(pass ? 0 : 1)
}
