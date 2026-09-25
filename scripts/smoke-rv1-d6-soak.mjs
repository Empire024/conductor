// RV1 D6: full soak up to 6h with the D1-style 150-file prose fixture at DEFAULT contextRolloverFraction,
// looping (create a fresh job, wait for it to settle, log the outcome, repeat) until the time budget
// is spent. Adapted from scripts/smoke-rv1-durable-summaries.mjs (D1) and
// scripts/smoke-v1-durable-rollover.mjs (not edited here).
//   DURABLE_SMOKE_TIMEOUT_MS=21600000 node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-d6-soak.mjs
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MODEL = 'local/qwen3.6-35b-a3b'
const FILE_COUNT = 150
const TOTAL_MS = Number(process.env.DURABLE_SMOKE_TIMEOUT_MS ?? 6 * 60 * 60_000)
const output = resolve('artifacts/verification/2026-09-25-rv1/durable')
await mkdir(output, { recursive: true })
const logPath = join(output, 'soak-6h.log')
const log = async (line) => { const stamped = `[${new Date().toISOString()}] ${line}`; console.log(stamped); await appendFile(logPath, stamped + '\n') }

const SUBJECTS = ['A retired cartographer', 'The night-shift harbor pilot', 'A traveling clockmaker', 'The village’s last blacksmith', 'A young apprentice weaver', 'The county surveyor', 'An itinerant glassblower', 'The lighthouse keeper’s daughter', 'A wandering violin tuner', 'The bridge inspector', 'A self-taught botanist', 'The postmaster of a small mountain town', 'A shipwright nearing retirement', 'The archivist of a defunct railway', 'A beekeeper with three hives']
const SETTINGS = ['on the edge of a fog-bound coastal town', 'deep in a valley crossed by an old canal', 'above a quarry that had not been worked in decades', 'beside a river prone to sudden floods', 'near the ruins of a Roman-era aqueduct', 'in a district known for its clockwork mills', 'along a coastline dotted with abandoned lighthouses', 'at the terminus of a narrow-gauge railway', 'within sight of a half-finished observatory', 'on an island reachable only at low tide']
const EVENTS = ['discovered a discrepancy in the old survey records', 'repaired a mechanism nobody else understood', 'kept a private journal of unusual weather patterns', 'rebuilt a structure using only salvaged materials', 'trained a successor over the course of one winter', 'corresponded for years with a scholar in a distant city', 'catalogued every specimen found along a single stretch of coast', 'restored a piece of machinery thought beyond repair', 'mapped a route that later became a public road', 'settled a long-running dispute between two neighboring villages']
const OUTCOMES = ['and the town still marks the anniversary of that work each year.', 'though few records of the achievement survive today.', 'which quietly changed how the next generation approached the same problem.', 'and a small plaque now commemorates the effort.', 'a fact mentioned only in passing in a single local history.', 'and the technique was later adopted well beyond the original district.', 'though the person themselves remained largely unknown outside the area.', 'an episode remembered mostly through family stories rather than official records.']
function paragraph(i) {
  const s = SUBJECTS[i % SUBJECTS.length], set = SETTINGS[(i * 7 + 3) % SETTINGS.length], ev = EVENTS[(i * 5 + 1) % EVENTS.length], out = OUTCOMES[(i * 11 + 2) % OUTCOMES.length]
  const filler = Array.from({ length: 14 }, (_, k) => `Detail ${i}.${k}: an incidental observation, numbered so the paragraph reaches a realistic length without repeating the same sentence twice in file ${i}.`).join(' ')
  return `${s}, working ${set}, ${ev}, ${out} ${filler}`
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 5000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) return null; await sleep(intervalMs) } }
const require = createRequire(import.meta.url)

async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-d6-'))
  const profile = join(root, 'profile'), projectPath = join(root, 'project')
  const notesDir = join(projectPath, 'notes')
  await mkdir(notesDir, { recursive: true })
  for (let i = 0; i < FILE_COUNT; i++) await writeFile(join(notesDir, `note-${String(i).padStart(3, '0')}.txt`), paragraph(i) + '\n')
  const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')
  const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
  const fs = await import('node:fs')
  const logFd = fs.openSync(join(root, 'app.log'), 'a')
  const child = spawn(require('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
  const owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  if (!owner) throw new Error('owner credential never appeared')
  let projectId
  const call = async (method, args = {}) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  projectId = (await call('projects.open', { path: projectPath, name: 'RV1 D6 soak' })).id
  return { root, child, call, projectPath }
}
const teardown = async (h) => { try { execFileSync('taskkill.exe', ['/pid', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }

await log(`D6 soak starting, budget ${TOTAL_MS}ms (${(TOTAL_MS / 3_600_000).toFixed(1)}h)`)
const deadline = Date.now() + TOTAL_MS
let iteration = 0
const summary = []
while (Date.now() < deadline) {
  iteration++
  const remaining = deadline - Date.now()
  await log(`iteration ${iteration}: launching, ${(remaining / 60000).toFixed(1)} min remaining in budget`)
  let h
  try {
    h = await launch()
    const job = await h.call('jobs.create', {
      title: `RV1 D6 soak iteration ${iteration}`, model: MODEL,
      objective: `Create INDEX.md if it does not already exist. Then, for every file in notes/ (note-000.txt through note-${String(FILE_COUNT - 1).padStart(3, '0')}.txt), in order, append one line to INDEX.md: the filename followed by a one-sentence summary of its paragraph.`,
      constraints: ['Only write INDEX.md', 'Read notes files in order, not all at once'],
      stages: [{ title: 'Summarize all notes', objective: 'Create INDEX.md if missing, then read every file in notes/ in order (note-000.txt first) and append one summary line per file.', completionCriteria: [`INDEX.md has exactly ${FILE_COUNT} lines, one per note file, in order`] }]
    })
    const perIterationBudget = Math.min(remaining, 90 * 60_000)
    const final = await poll(async () => { const s = await h.call('jobs.status', { jobId: job.id }); return ['completed', 'blocked', 'failed'].includes(s.status) ? s : null }, perIterationBudget, 10000)
    const indexPath = join(h.projectPath, 'INDEX.md')
    const lineCount = existsSync(indexPath) ? (await readFile(indexPath, 'utf8')).trim().split('\n').filter(Boolean).length : 0
    const entry = { iteration, status: final?.status ?? 'timed-out-in-iteration-budget', reason: final?.statusReason ?? null, rollovers: final?.counters?.contextRollovers ?? 0, retries: final?.counters?.retries ?? 0, lineCount, at: new Date().toISOString() }
    summary.push(entry)
    await log(`iteration ${iteration} result: ${JSON.stringify(entry)}`)
  } catch (error) {
    const entry = { iteration, status: 'error', error: String(error?.stack ?? error).slice(0, 500), at: new Date().toISOString() }
    summary.push(entry)
    await log(`iteration ${iteration} ERROR: ${entry.error}`)
  } finally {
    if (h) await teardown(h)
  }
  await writeFile(join(output, 'soak-6h-summary.json'), JSON.stringify(summary, null, 2))
}
await log(`D6 soak finished after ${iteration} iteration(s)`)
await writeFile(join(output, 'soak-6h-summary.json'), JSON.stringify(summary, null, 2))
