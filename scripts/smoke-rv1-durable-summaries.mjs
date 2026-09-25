// RV1 D1-D2: durable-job rollover fix (68b115e) proof. FX3's own index fixture never rolled over
// at the default fraction, so it didn't prove attemptCredited on a rollover with real file
// progress. This copy generates 150 DISTINCT PROSE paragraphs (not regex-extractable, unlike a
// templated "fact about X" line) and asks for a one-sentence-per-file summary into INDEX.md, at the
// DEFAULT contextRolloverFraction (no override), against the real local model.
// Adapted from scripts/smoke-v1-durable-rollover.mjs (S19) and scripts/smoke-durable-jobs.mjs; does
// not edit either.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-durable-summaries.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MODEL = 'local/qwen3.6-35b-a3b'
const FILE_COUNT = 150
const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-d1-'))
const output = resolve('artifacts/verification/2026-09-25-rv1/D')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
const notesDir = join(projectPath, 'notes')
await mkdir(notesDir, { recursive: true })

// Distinct prose generator: varied subjects, verbs, settings and outcomes per file so no regex can
// pull a single "topic word" back out -- summarizing genuinely requires reading each paragraph.
const SUBJECTS = ['A retired cartographer', 'The night-shift harbor pilot', 'A traveling clockmaker', 'The village’s last blacksmith', 'A young apprentice weaver', 'The county surveyor', 'An itinerant glassblower', 'The lighthouse keeper’s daughter', 'A wandering violin tuner', 'The bridge inspector', 'A self-taught botanist', 'The postmaster of a small mountain town', 'A shipwright nearing retirement', 'The archivist of a defunct railway', 'A beekeeper with three hives']
const SETTINGS = ['on the edge of a fog-bound coastal town', 'deep in a valley crossed by an old canal', 'above a quarry that had not been worked in decades', 'beside a river prone to sudden floods', 'near the ruins of a Roman-era aqueduct', 'in a district known for its clockwork mills', 'along a coastline dotted with abandoned lighthouses', 'at the terminus of a narrow-gauge railway', 'within sight of a half-finished observatory', 'on an island reachable only at low tide']
const EVENTS = ['discovered a discrepancy in the old survey records', 'repaired a mechanism nobody else understood', 'kept a private journal of unusual weather patterns', 'rebuilt a structure using only salvaged materials', 'trained a successor over the course of one winter', 'corresponded for years with a scholar in a distant city', 'catalogued every specimen found along a single stretch of coast', 'restored a piece of machinery thought beyond repair', 'mapped a route that later became a public road', 'settled a long-running dispute between two neighboring villages']
const OUTCOMES = ['and the town still marks the anniversary of that work each year.', 'though few records of the achievement survive today.', 'which quietly changed how the next generation approached the same problem.', 'and a small plaque now commemorates the effort.', 'a fact mentioned only in passing in a single local history.', 'and the technique was later adopted well beyond the original district.', 'though the person themselves remained largely unknown outside the area.', 'an episode remembered mostly through family stories rather than official records.']
function paragraph(i) {
  const s = SUBJECTS[i % SUBJECTS.length]
  const set = SETTINGS[(i * 7 + 3) % SETTINGS.length]
  const ev = EVENTS[(i * 5 + 1) % EVENTS.length]
  const out = OUTCOMES[(i * 11 + 2) % OUTCOMES.length]
  const filler = Array.from({ length: 14 }, (_, k) => `Detail ${i}.${k}: an incidental observation, numbered so the paragraph reaches a realistic length without repeating the same sentence twice in file ${i}.`).join(' ')
  return `${s}, working ${set}, ${ev}, ${out} ${filler}`
}
for (let i = 0; i < FILE_COUNT; i++) {
  await writeFile(join(notesDir, `note-${String(i).padStart(3, '0')}.txt`), paragraph(i) + '\n')
}
const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.'); git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const results = []
const record = (id, verdict, note, numbers) => { results.push({ id, verdict, note, numbers }); console.log(`[${id}] ${verdict}: ${note}`) }
const observe = (label, data = {}) => console.log(`[${new Date().toISOString()}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`)

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_EMPTY_HISTORY: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_OFFLINE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS
const fs = await import('node:fs')
const logFd = fs.openSync(join(root, 'app.log'), 'a')
const child = spawn(createRequire(import.meta.url)('electron'), [resolve('out/main/index.js')], { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
console.log('launched pid', child.pid, 'root', root)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async (fn, timeoutMs, intervalMs = 3000) => { const started = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - started > timeoutMs) throw new Error('timed out'); await sleep(intervalMs) } }

let owner, projectId
const HARD_TIMEOUT_MS = 4 * 60 * 60_000 // generous; D6 covers the full 6h soak separately
const watchdog = setTimeout(() => { observe('watchdog: giving up after 4h'); process.exit(1) }, HARD_TIMEOUT_MS)
try {
  owner = await poll(async () => { try { return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) } catch { return null } }, 60_000)
  const call = async (method, args = {}) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await r.json(); if (r.status !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`); return body.result
  }
  projectId = (await call('projects.open', { path: projectPath, name: 'RV1 D1 durable summaries' })).id
  const job = await call('jobs.create', {
    title: 'RV1 D1 durable summaries', model: MODEL,
    objective: `For every file in notes/ (note-000.txt through note-${String(FILE_COUNT - 1).padStart(3, '0')}.txt), in order, append one line to INDEX.md: the filename followed by a one-sentence summary of its paragraph.`,
    constraints: ['Only write INDEX.md', 'Read notes files in order, not all at once', 'Do not use a script or regex to extract text -- read and summarize each paragraph'],
    stages: [{ title: 'Summarize all notes', objective: `Read every file in notes/ in order (note-000.txt first) and append one line per file to INDEX.md with a genuine one-sentence summary of its content.`, completionCriteria: [`INDEX.md has exactly ${FILE_COUNT} lines, one per note file, in order`] }]
  })
  observe('job created', { jobId: job.id })
  const status = () => call('jobs.status', { jobId: job.id })
  const final = await poll(async () => { const s = await status(); return ['completed', 'blocked', 'failed'].includes(s.status) ? s : null }, HARD_TIMEOUT_MS - 5 * 60_000, 5000)
  const events = await call('jobs.events', { jobId: job.id, limit: 500 })
  const rollovers = final.counters?.contextRollovers ?? 0
  const retries = final.counters?.retries ?? 0
  const indexPath = join(projectPath, 'INDEX.md')
  const indexText = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : ''
  const lines = indexText.trim() ? indexText.trim().split('\n') : []
  const inOrder = lines.every((l, i) => l.includes(`note-${String(i).padStart(3, '0')}`))
  const rolloverEvents = events.filter(e => /rollover/i.test(e.message))
  const creditedRollovers = rolloverEvents.filter(e => e.attemptCredited === true || /attemptCredited["']?\s*:\s*true/.test(JSON.stringify(e)))
  observe('job settled', { status: final.status, statusReason: final.statusReason, counters: final.counters, lineCount: lines.length, inOrder })
  await writeFile(join(output, 'd1-index.md.copy'), indexText)
  await writeFile(join(output, 'd1-events.json'), JSON.stringify(events, null, 2))
  const pass = final.status === 'completed' && lines.length === FILE_COUNT && inOrder && rollovers >= 3
  record('D1', pass ? 'PASS' : (rollovers < 3 ? 'INFO' : 'FAIL'),
    `status=${final.status} reason=${final.statusReason ?? '(none)'}; rollovers=${rollovers}; retries=${retries}; INDEX.md lines=${lines.length}/${FILE_COUNT}; inOrder=${inOrder}; rollover events=${rolloverEvents.length}, attemptCredited-true among them=${creditedRollovers.length}`,
    { rollovers, retries, lineCount: lines.length })
  record('D2', rolloverEvents.length ? 'INFO' : 'NOT RUN', `credited vs spent stage attempts across ${rolloverEvents.length} rollover events: attemptCredited=true count=${creditedRollovers.length}, false/other=${rolloverEvents.length - creditedRollovers.length}; no owner block observed=${final.status !== 'blocked'}`)
  if (rollovers < 3) observe('rollovers below target 3 at default fraction with 150x~2KB files; would need larger per-file size to force more rollovers per plan note')
} catch (error) {
  record('D1', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  await writeFile(join(output, 'd1-results.json'), JSON.stringify(results, null, 2))
  console.log('\n=== D1 SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
  console.log('root kept at', root)
}
