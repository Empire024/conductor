// V1 verify S26: a local coding tab asked an open-ended, non-coding question should answer briefly
// without looping tools, then stop. Real running model.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-local-open-ended.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { openSync, closeSync, readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-openended-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# Open-ended smoke\n')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

let child
try {
  const log = openSync(join(root, 'app.log'), 'a')
  child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const proj = await call('projects.open', { path: projectPath, name: 'V1 open-ended' })
  const tab = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S26' }, proj.id).then(r => r.resourceId)
  const t0 = Date.now()
  await call('agents.submit', { agentSessionId: tab, prompt: 'What is the meaning of life?' })
  await poll(async () => { const s = await call('agents.status', { agentSessionId: tab }); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 180_000, 2000)
  const elapsed = Date.now() - t0
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  const proj_json = JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(tab).projection_json)
  db.close()
  const items = proj_json.items ?? []
  const tools = items.filter(i => i.data?.type === 'tool')
  const assistant = items.filter(i => i.data?.type === 'text' && i.data.role === 'assistant').map(i => i.data.text)
  const noCrash = proj_json.phase === 'completed'
  const brief = assistant.join('').length < 4000
  record('S26', noCrash && tools.length <= 1 ? 'PASS' : 'FAIL', `phase=${proj_json.phase}, elapsedMs=${elapsed}, toolRounds=${tools.length}, answerChars=${assistant.join('').length}, brief=${brief}: ${assistant.join('').slice(0, 300)}`)
  await writeFile(join(output, 's26-open-ended.json'), JSON.stringify({ phase: proj_json.phase, elapsed, tools: tools.map(t => t.data.name), assistant }, null, 2))
} catch (error) {
  record('S26', 'FAIL', String(error?.stack ?? error))
} finally {
  if (child) try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's26-results.json'), JSON.stringify(results, null, 2))
}
