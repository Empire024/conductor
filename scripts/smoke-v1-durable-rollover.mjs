// V1 verify S19: a single durable-job stage that genuinely needs >=4 fresh contexts at the
// DEFAULT contextRolloverFraction (0.7, src/shared/durable-jobs.ts) -- no override. 40 notes files
// of ~2KB each; "write one line per file into INDEX.md, in order." Budget 60 min.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-durable-rollover.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MODEL = 'local/qwen3.6-35b-a3b'
const root = await mkdtemp(join(tmpdir(), 'conductor-v1-rollover-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
const notesDir = join(projectPath, 'notes')
await mkdir(notesDir, { recursive: true })
for (let i = 0; i < 40; i++) {
  const topic = ['rivers', 'bridges', 'lighthouses', 'clocks', 'telescopes', 'railways', 'canals', 'observatories'][i % 8]
  const body = Array.from({ length: 40 }, (_, line) => `Note ${i} line ${line}: a fact-like sentence about ${topic}, padded so this file is about 2KB total on disk, entry number ${i}-${line}.`).join('\n')
  await writeFile(join(notesDir, `note-${String(i).padStart(2, '0')}.txt`), body + '\n')
}
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const observations = []
const observe = (label, data = {}) => { const e = { at: new Date().toISOString(), label, ...data }; observations.push(e); console.log(`[${e.at}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`) }

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 2000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }

let owner, projectId
const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ root, observations }, null, 2)); process.exit(1) }, 65 * 60_000)
try {
  owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  projectId = (await call('projects.open', { path: projectPath, name: 'V1 rollover' })).id
  const job = await call('jobs.create', {
    title: 'V1 S19 rollover', model: MODEL,
    objective: 'Write one line per file into INDEX.md, in order (note-00.txt first): each line names the file and briefly says what it is about.',
    constraints: ['Only write INDEX.md', 'Read notes files in order, not all at once'],
    stages: [{ title: 'Index all notes', objective: 'Read every file in notes/ (note-00.txt through note-39.txt), in order, and write one line per file into INDEX.md summarising it.', completionCriteria: ['INDEX.md has exactly 40 lines, one per note file, in order'] }]
  })
  observe('job created', { jobId: job.id })
  const status = () => call('jobs.status', { jobId: job.id })
  const final = await poll(async () => { const s = await status(); return ['completed', 'blocked', 'failed'].includes(s.status) ? s : null }, 60 * 60_000, 5000)
  const events = await call('jobs.events', { jobId: job.id, limit: 200 })
  const rollovers = final.counters?.contextRollovers ?? 0
  const retries = final.counters?.retries ?? 0
  const attemptsUsedUp = events.some(e => /used all \d+ attempts/i.test(e.message))
  const indexPath = join(projectPath, 'INDEX.md')
  const indexText = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : ''
  const lineCount = indexText.trim() ? indexText.trim().split('\n').length : 0
  observe('job settled', { status: final.status, statusReason: final.statusReason, counters: final.counters, lineCount })
  await writeFile(join(output, 's19-index.md.copy'), indexText)
  await writeFile(join(output, 's19-events.json'), JSON.stringify(events, null, 2))
  const completedWithAllLines = final.status === 'completed' && lineCount === 40
  record('S19', completedWithAllLines ? 'PASS' : 'FAIL', `status=${final.status} reason=${final.statusReason ?? '(none)'}; rollovers=${rollovers}; retries=${retries}; INDEX.md lines=${lineCount}/40; blocked-with-"used all N attempts"-despite-progress=${attemptsUsedUp}`)
} catch (error) {
  record('S19', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 's19-results.json'), JSON.stringify({ results, observations }, null, 2))
  console.log('\n=== S19 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
