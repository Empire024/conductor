/** Owner-scale startup check (docs/startup-diagnostics.md, part 3). On 2026-10-22 every launch died
 *  four seconds in: StructuredAgentStore parsed all 1,666 stored conversations (1.27 GB of JSON) at
 *  construction and filled the 4 GB V8 heap (docs/conversation-residency.md). Every smoke ran on a
 *  small test profile, so none saw it. This boots the candidate in the current directory, parked,
 *  on a copy of the synthetic owner-scale profile (scripts/owner-scale-profile.mjs, generated once
 *  and cached in the main checkout) and fails when it does not become ready within the time budget,
 *  when its heap passes the heap budget, when it dies or stops answering in the 20 s after ready, or
 *  when its first window does not paint.
 *
 *  Readiness and heap come from <userData>/diagnostics/boot.json (outcome 'ready', readyMs,
 *  peak.heapMb, heapLimitMb) when the candidate writes it; an older candidate is measured from
 *  launch until app control answers, with the heap read through app.evaluate.
 *
 *  Usage: node scripts/smoke-owner-scale-startup.mjs [--keep] [--regenerate] [--budget-ms N]
 *         [--heap-budget-mb N] [--stay-ms N] [--small]
 *  (--small: the generator's 1/50 profile, for working on the smoke itself; it proves nothing.)
 *  Run it under scripts/smoke-lock.mjs, after `npm run build` in the same hold. */
import { _electron as electron } from '@playwright/test'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SMALL_SIZING, closeApp, defaultCacheDirectory, ensureOwnerScaleProfile, parkedEnvironment, projectsRoot, removeTree } from './owner-scale-profile.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? Number(args[at + 1]) : fallback }
/** Budgets, from measurements on this profile (3,000 conversations, 1.45 GB of projection JSON,
 *  3.4 GB journal, 120 open tabs) on 2026-10-22, three runs each:
 *  - HEAD (fc0a58d plus the boot diagnostics): ready in 1.5-1.7 s (boot.json readyMs), heap 180-197 MB
 *    at ready and a peak of 299-300 MB over the next 20 s.
 *  - 0db4b53 (a4c6427^, the build installed during the outage): died 9.7-10.3 s after launch with
 *    "OOM error in V8 ... JavaScript heap out of memory" at about 3.7 GB, exit code 4294930435, the
 *    same code the meta-wizard reported that morning.
 *  Time: 60 s is about 35x HEAD and leaves room for a machine under load (smokes run below normal
 *  priority while the owner works; an empty-profile boot has taken 13 s under contention). A launch
 *  that takes a minute to answer is broken for the owner anyway.
 *  Heap: 40% of the V8 limit (1,638 MB of 4,096) is 5x HEAD's peak and well under half of what the
 *  pre-fix build reached before it died; it also leaves the memory guard (70%) the headroom a day
 *  of real use needs after startup. */
const BUDGET_MS = option('--budget-ms', 60_000)
const HEAP_FRACTION = 0.4
const HEAP_BUDGET_MB = option('--heap-budget-mb', null)
const STAY_MS = option('--stay-ms', 20_000)
const keep = args.includes('--keep')
const cwd = process.cwd()
const main = resolve(cwd, 'out', 'main', 'index.js')
const output = resolve(cwd, 'artifacts', 'owner-scale-startup')
mkdirSync(output, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
const within = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)])
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

if (!existsSync(main)) { console.error(`FAIL: ${main} does not exist; build the candidate first (npm run build)`); process.exit(1) }
const { database, manifest } = await ensureOwnerScaleProfile({ cwd, regenerate: args.includes('--regenerate'), ...(args.includes('--small') ? { sizing: SMALL_SIZING, cache: join(defaultCacheDirectory(cwd), 'small') } : {}) })

const root = mkdtempSync(join(tmpdir(), 'conductor-owner-scale-'))
const userData = join(root, 'profile')
const logPath = join(output, 'main.log')
const log = createWriteStream(logPath)
const tail = []
const keepLine = (stream, text) => {
  log.write(`[${stream}] ${text}`)
  for (const line of String(text).split(/\r?\n/)) if (line.trim()) { tail.push(`[${stream}] ${line.slice(0, 400)}`); if (tail.length > 60) tail.shift() }
}
const result = { candidate: cwd, profile: { key: manifest.key, conversations: manifest.conversations, projectionBytes: manifest.projectionBytes, journalBytes: manifest.journalBytes, databaseBytes: manifest.databaseBytes }, budgetMs: BUDGET_MS, failures: [] }
let app = null, child = null, exited = null
const fail = message => { result.failures.push(message); console.error(`FAIL: ${message}`) }

const cleanup = async () => {
  if (app) {
    await closeApp(app, 30_000, child ?? undefined)
  }
  log.end()
  for (const name of ['boot.json', 'boot-sample.json', 'boot-history.jsonl', 'boot-last-failure.json']) {
    try { copyFileSync(join(userData, 'diagnostics', name), join(output, name)) } catch { /* not written */ }
  }
  if (keep) console.log(`kept the test profile at ${root}`)
  else if (!await removeTree(root)) fail(`the test profile ${root} could not be deleted`)
  await removeTree(projectsRoot())
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(130)) })

try {
  // A fresh copy of the cached database and empty project folders for every run.
  rmSync(projectsRoot(), { recursive: true, force: true })
  for (let index = 1; index <= manifest.projects; index++) mkdirSync(join(projectsRoot(), `project-${String(index).padStart(2, '0')}`), { recursive: true })
  mkdirSync(userData, { recursive: true })
  const copyStarted = Date.now()
  copyFileSync(database, join(userData, 'conductor.db'))
  {
    // The agents the owner used in the last day: the update gate and the processes board read them.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(userData, 'conductor.db'))
    const touch = db.prepare('UPDATE agent_sessions SET updated_at=? WHERE id=?')
    db.exec('BEGIN')
    manifest.recentAgents.forEach((id, index) => touch.run(new Date(Date.now() - index * 6 * 60_000).toISOString(), id))
    db.exec('COMMIT')
    db.close()
  }
  console.log(`profile copied in ${((Date.now() - copyStarted) / 1000).toFixed(1)} s: ${(manifest.databaseBytes / 1e9).toFixed(2)} GB, ${manifest.conversations} conversations, ${(manifest.projectionBytes / 1e9).toFixed(2)} GB of projection JSON, ${manifest.openTabs} open tabs`)

  const started = Date.now()
  try {
    app = await electron.launch({ args: [main], cwd, env: parkedEnvironment(userData), timeout: BUDGET_MS })
  } catch (error) {
    keepLine('launch', String(error?.message ?? error))
    throw new Error(`the candidate did not launch: ${String(error?.message ?? error).split('\n')[0]}`)
  }
  child = app.process()
  child.stdout?.on('data', data => keepLine('out', data))
  child.stderr?.on('data', data => keepLine('err', data))
  child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() - started } })
  result.pid = child.pid

  const ownerPath = join(userData, 'control-owner.json'), bootPath = join(userData, 'diagnostics', 'boot.json'), samplePath = join(userData, 'diagnostics', 'boot-sample.json')
  const control = async (method, timeoutMs = 5000) => {
    const owner = readJson(ownerPath)
    if (!owner?.endpoint) return null
    try {
      const response = await fetch(owner.endpoint, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: {} }) })
      return response.status === 200 ? await response.json() : null
    } catch { return null }
  }
  let peakSampleMb = 0, boot = null, readyMs = null, source = null
  // Wait for ready: boot.json decides when the candidate writes it; otherwise app control answering
  // plus a window. Never longer than the budget.
  for (;;) {
    boot = readJson(bootPath) ?? boot
    const sample = readJson(samplePath)
    if (sample?.heapMb) peakSampleMb = Math.max(peakSampleMb, sample.heapMb)
    if (boot?.outcome === 'ready') { readyMs = boot.readyMs; source = 'boot.json'; break }
    if (boot?.outcome === 'failed') break
    if (exited) break
    if (!boot && app.windows().length && await control('tools.list', 2000)) { readyMs = Date.now() - started; source = 'app control (no boot.json)'; break }
    if (Date.now() - started > BUDGET_MS) break
    await sleep(250)
  }
  result.readySource = source
  result.readyMs = readyMs
  if (readyMs === null) {
    if (exited) fail(`the candidate exited (code ${exited.code}${exited.signal ? `, ${exited.signal}` : ''}) ${(exited.at / 1000).toFixed(1)} s after launch without becoming ready${boot ? `, last stage ${boot.stage}` : ''}`)
    else if (boot?.outcome === 'failed') fail(`boot.json says the launch failed in stage ${boot.stage}: ${JSON.stringify(boot.fatal ?? boot.errors?.at(-1) ?? null)}`)
    else fail(`not ready within ${BUDGET_MS / 1000} s${boot ? ` (boot.json stage ${boot.stage}, outcome ${boot.outcome})` : ' (no boot.json, app control never answered)'}`)
  } else if (readyMs > BUDGET_MS) fail(`ready after ${(readyMs / 1000).toFixed(1)} s, over the ${BUDGET_MS / 1000} s budget`)
  else console.log(`ready in ${(readyMs / 1000).toFixed(1)} s (${source})`)

  const heapNow = async () => within(app.evaluate(() => {
    const stats = process.getBuiltinModule('node:v8').getHeapStatistics()
    return { heapMb: Math.round(stats.used_heap_size / 1048576), limitMb: Math.round(stats.heap_size_limit / 1048576), rssMb: Math.round(process.memoryUsage().rss / 1048576) }
  }).catch(() => null), 10_000, null)
  const samples = []
  if (readyMs !== null && !exited) {
    const atReady = await heapNow()
    result.heapAtReady = atReady
    // The first window paints (parked off every display, so a capture is the only way to see it).
    const page = app.windows()[0] ?? await within(app.firstWindow().catch(() => null), 30_000, null)
    if (!page) fail('no window after ready')
    else {
      await page.waitForSelector('.app-shell, .pane-workspace, .empty-pane-workspace', { timeout: 20_000 }).catch(() => {})
      const png = await within(app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')).catch(() => ''), 20_000, '')
      result.paintedBytes = Buffer.from(png, 'base64').length
      if (result.paintedBytes > 5000) writeFileSync(join(output, 'first-window.png'), Buffer.from(png, 'base64'))
      else fail(`the first window did not paint (capture ${result.paintedBytes} bytes)`)
    }
    // It stays up: the memory guard, the prune passes and the first refreshes run in these seconds.
    const stayUntil = Date.now() + STAY_MS
    let unresponsive = 0
    while (Date.now() < stayUntil && !exited) {
      await sleep(2000)
      const heap = await heapNow()
      if (heap) samples.push(heap)
      else if (!exited) unresponsive++
    }
    if (exited) fail(`the candidate exited (code ${exited.code}${exited.signal ? `, ${exited.signal}` : ''}) ${((exited.at - readyMs) / 1000).toFixed(1)} s after it was ready`)
    else if (!await control('tools.list', 15_000)) fail(`app control stopped answering within ${STAY_MS / 1000} s of ready`)
    if (unresponsive > 2) fail(`the main process did not answer ${unresponsive} heap reads in the ${STAY_MS / 1000} s after ready`)
    result.stayedMs = STAY_MS
  }
  boot = readJson(bootPath) ?? boot
  const limitMb = boot?.heapLimitMb ?? result.heapAtReady?.limitMb ?? samples[0]?.limitMb ?? 4096
  const heapBudgetMb = HEAP_BUDGET_MB ?? Math.round(limitMb * HEAP_FRACTION)
  const peakMb = Math.max(boot?.peak?.heapMb ?? 0, peakSampleMb, result.heapAtReady?.heapMb ?? 0, ...samples.map(sample => sample.heapMb)) || null
  Object.assign(result, { bootPeak: boot?.peak ?? null, heapLimitMb: limitMb, heapBudgetMb, peakHeapMb: peakMb, afterReady: samples.map(sample => sample.heapMb), lastStage: boot?.stage ?? null, stages: boot?.stages?.map(stage => `${stage.name}@${stage.ms}ms/${stage.heapMb}MB`) ?? null })
  if (peakMb === null) console.log('heap: not measured (the main process never answered)')
  else if (peakMb > heapBudgetMb) fail(`peak heap ${peakMb} MB is over the ${heapBudgetMb} MB budget (${Math.round(HEAP_FRACTION * 100)}% of the ${limitMb} MB V8 limit)`)
  if (peakMb !== null) console.log(`heap: peak ${peakMb} MB of a ${limitMb} MB limit (budget ${heapBudgetMb} MB); at ready ${result.heapAtReady?.heapMb ?? '?'} MB; after ready ${samples.map(sample => sample.heapMb).join(', ') || '-'} MB`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  if (result.failures.length) {
    // The one-line verdict the meta-wizard and the watchdog print, when the checkout has the reader.
    try {
      const { readBootVerdict } = await import(new URL('./meta-wizard/boot.mjs', import.meta.url).href)
      const verdict = await readBootVerdict(userData, { pid: result.pid ?? null, alive: Boolean(app && !exited), exitCode: exited?.code ?? null, log: tail.join('\n') })
      result.verdict = verdict?.line ?? null
    } catch { /* an older checkout without boot diagnostics */ }
    if (result.verdict) console.error(`verdict: ${result.verdict}`)
    const oom = tail.some(line => /JavaScript heap out of memory|OOM error in V8/i.test(line))
    if (oom) console.error('the main process ran out of V8 heap (JavaScript heap out of memory)')
    console.error(`main process output, last lines (full log ${logPath}):`)
    // Electron repeats its fatal lines; each distinct line once, in order.
    for (const line of [...new Set(tail.map(line => line.replace(/^[(?:err|out)] /, '')))].slice(-30)) console.error('  ' + line)
  }
  await cleanup()
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`${result.failures.length ? 'FAILED' : 'PASSED'}: owner-scale startup, ${result.readyMs !== null && result.readyMs !== undefined ? `ready in ${(result.readyMs / 1000).toFixed(1)} s` : 'never ready'}, peak heap ${result.peakHeapMb ?? '?'} MB (result ${join(output, 'result.json')})`)
  process.exitCode = result.failures.length ? 1 : 0
}
