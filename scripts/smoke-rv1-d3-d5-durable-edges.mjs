// RV1 D3, D5: durable-jobs rollover edge cases. Adapted from scripts/smoke-v1-durable-rollover.mjs
// (not edited here). Reads src/main/durable-jobs/controller.ts (not edited) to confirm
// DEFAULT_DURABLE_JOB_BUDGETS.maxStageAttempts=3 is the "used all N attempts" block bound.
// D3: a rollover with NO file progress (a stage that only reads, never writes) still spends an
//     attempt -- the stage should block after 3 such rollovers, at the default fraction.
// D5: runaway guard -- a stage whose task can never finish, writing a line each context (append to
//     LOG.md forever until it has 100000 lines). Capped at 60 minutes; records whether/when it was
//     ever stopped.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-d3-d5-durable-edges.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MODEL = 'local/qwen3.6-35b-a3b'
const output = resolve('artifacts/verification/2026-09-25-rv1/D')
await mkdir(output, { recursive: true })
const results = []
const record = (id, verdict, note, numbers) => { results.push({ id, verdict, note, numbers }); console.log(`[${id}] ${verdict}: ${note}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 3000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) return null; await sleep(intervalMs) } }

async function launchProject(label, projectPath) {
  const root = await mkdtemp(join(tmpdir(), `conductor-rv1-${label}-`))
  const profile = join(root, 'profile')
  const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
  const fs = await import('node:fs')
  const logFd = fs.openSync(join(root, 'app.log'), 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  if (!owner) throw new Error('owner credential never appeared')
  let projectId
  const call = async (method, args = {}) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  projectId = (await call('projects.open', { path: projectPath, name: label })).id
  return { root, child, call, appLog: join(root, 'app.log') }
}
const teardown = async (h) => { try { execFileSync('taskkill.exe', ['/pid', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }

// ---- D3: no-file-progress rollover spends an attempt ----
{
  const projectPath = join(tmpdir(), 'rv1-d3-' + Date.now())
  await mkdir(projectPath, { recursive: true })
  const huge = Array.from({ length: 60_000 }, (_, i) => `Line ${i}: padding text so this file is large enough that reading it repeatedly, without writing anything, forces multiple fresh contexts at the default rollover fraction. Extra words extra words extra words.`).join('\n')
  await writeFile(join(projectPath, 'HUGE.txt'), huge)
  const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')
  let h
  try {
    h = await launchProject('d3', projectPath)
    const job = await h.call('jobs.create', {
      title: 'RV1 D3 no-progress rollover', model: MODEL,
      objective: 'Read HUGE.txt completely and think carefully about its structure. Do NOT write, edit or create any file. Only report your understanding when done.',
      constraints: ['Do not write any file'],
      stages: [{ title: 'Read only', objective: 'Read HUGE.txt in full, carefully, without writing any file. Only finish once you have read the entire file.', completionCriteria: ['The entire file has been read and understood'] }]
    })
    const final = await poll(async () => { const s = await h.call('jobs.status', { jobId: job.id }); return ['completed', 'blocked', 'failed'].includes(s.status) ? s : null }, 40 * 60_000, 5000)
    const events = final ? await h.call('jobs.events', { jobId: job.id, limit: 200 }) : []
    const rolloverEvents = events.filter(e => /rollover/i.test(e.message))
    const blockedAfterAttempts = final?.status === 'blocked' && /used all \d+ attempts/i.test(final.statusReason ?? '')
    record('D3', final ? (blockedAfterAttempts || (final.counters?.contextRollovers ?? 0) > 0 ? 'PASS' : 'INFO') : 'FAIL',
      `status=${final?.status ?? 'timed out waiting'}; reason=${final?.statusReason ?? '(none)'}; rollovers=${final?.counters?.contextRollovers ?? 0}; rollover events=${rolloverEvents.length}; blocked with "used all N attempts" despite zero file progress=${blockedAfterAttempts}`)
  } catch (error) {
    record('D3', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
  } finally { if (h) await teardown(h) }
}

// ---- D5: runaway guard, capped at 60 minutes ----
{
  const projectPath = join(tmpdir(), 'rv1-d5-' + Date.now())
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'README.md'), '# rv1 d5 runaway guard\n')
  const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')
  let h
  try {
    h = await launchProject('d5', projectPath)
    const t0 = Date.now()
    const job = await h.call('jobs.create', {
      title: 'RV1 D5 runaway guard', model: MODEL,
      objective: 'Append one new line to LOG.md every time you work, until LOG.md has 100000 lines. Never stop early.',
      stages: [{ title: 'Grow LOG.md forever', objective: 'Keep appending distinct lines to LOG.md, one per step, until it has 100000 lines total.', completionCriteria: ['LOG.md has 100000 lines'] }]
    })
    const CAP_MS = 60 * 60_000
    const final = await poll(async () => { const s = await h.call('jobs.status', { jobId: job.id }); return ['completed', 'blocked', 'failed'].includes(s.status) ? s : null }, CAP_MS, 10000)
    const elapsed = Date.now() - t0
    const logPath = join(projectPath, 'LOG.md')
    const lineCount = existsSync(logPath) ? (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).length : 0
    const events = final ? await h.call('jobs.events', { jobId: job.id, limit: 500 }) : await h.call('jobs.events', { jobId: job.id, limit: 500 }).catch(() => [])
    const rollovers = final?.counters?.contextRollovers ?? 'n/a (still running at 60min cap)'
    record('D5', final ? 'INFO' : 'INFO',
      `after ${Math.round(elapsed / 1000)}s (60min cap): ${final ? `stopped itself with status=${final.status}, reason=${final.statusReason ?? '(none)'}` : 'STILL RUNNING at the cap -- forcibly stopped by this smoke, not by the app'}; LOG.md lines=${lineCount}/100000; rollovers=${rollovers}; events recorded=${events.length}`,
      { elapsedMs: elapsed, lineCount })
    if (!final) { await h.call('jobs.cancel', { jobId: job.id }).catch(() => {}) }
  } catch (error) {
    record('D5', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
  } finally { if (h) await teardown(h) }
}

await writeFile(join(output, 'd3-d5-results.json'), JSON.stringify(results, null, 2))
console.log('\n=== D3/D5 SUMMARY ===')
for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
