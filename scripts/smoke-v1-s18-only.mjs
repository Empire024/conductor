// V1 verify S18 only: a small durable job, then a >=5 min interactive local turn in another tab.
// Driven entirely through app-control (no UI clicking) since S17 already covered the UI evidence
// and the launcher click after a job tab was flaky under heavy machine contention.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-s18-only.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s18-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'notes.txt'), 'first line\n')
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 1000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 20 * 60_000)
try {
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}, scopeProjectId) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scopeProjectId ? { scope: { projectId: scopeProjectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  const proj = await call('projects.open', { path: projectPath, name: 'V1 S18' })
  const status = jobId => call('jobs.status', { jobId }, proj.id)
  const contentionJob = await call('jobs.create', { title: 'V1 contention smoke', model: MODEL, objective: 'Append the line "contention smoke" to notes.txt.', stages: [{ title: 'Append', objective: 'Append the line "contention smoke" to notes.txt', completionCriteria: ['notes.txt ends with contention smoke'] }] }, proj.id)
  console.log('contention job created', contentionJob.id)
  const interactiveId = await call('tabs.open', { kind: 'agent', provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'S18 interactive' }, proj.id).then(r => r.resourceId)
  await call('agents.submit', { agentSessionId: interactiveId, prompt: 'Write a detailed 4000-word essay about the history of clocks, covering mechanical, electronic and atomic clocks.' }, proj.id)
  console.log('interactive local turn submitted', interactiveId)

  const events = []
  const start = Date.now()
  const poller = setInterval(async () => { try { const s = await status(contentionJob.id); events.push({ atMs: Date.now() - start, status: s.status, statusReason: s.statusReason, lastEvent: s.lastEvent?.message?.slice(0, 150) }) } catch {} }, 5000)
  await sleep(5 * 60_000 + 15_000)
  clearInterval(poller)
  const duringInteractive = await status(contentionJob.id)
  console.log('during interactive turn (>=5min elapsed)', JSON.stringify(duringInteractive).slice(0, 300))
  await writeFile(join(output, 's18-contention-events.json'), JSON.stringify(events, null, 2))
  const waitedVisibly = events.some(e => /wait|busy|slot|another|local model/i.test(e.statusReason ?? '') || e.status === 'blocked')
  const settledAfter = await poll(async () => { const s = await status(contentionJob.id); return ['completed', 'blocked', 'failed'].includes(s.status) ? s : null }, 20 * 60_000, 3000).catch(e => { console.log('contention job never settled', e.message); return null })
  const interactiveSettled = await poll(async () => { const s = await call('agents.status', { agentSessionId: interactiveId }, proj.id); return ['completed', 'failed', 'interrupted'].includes(s.phase) ? s : null }, 20 * 60_000, 3000).catch(() => null)
  record('S18', settledAfter?.status === 'completed' ? 'PASS' : (waitedVisibly && settledAfter) ? 'PASS' : 'FAIL', `during contention: status=${duringInteractive.status} reason=${duringInteractive.statusReason ?? '(none)'}; waitedVisibly=${waitedVisibly}; job final=${settledAfter?.status ?? 'never settled'}; interactive turn ended=${interactiveSettled?.phase ?? 'unknown'}`)
} catch (error) {
  record('S18', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's18-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== S18 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
