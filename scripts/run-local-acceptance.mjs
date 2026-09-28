// Replacement host launcher for one controller-granted local acceptance scenario
// (docs/verification/2026-09-28-local-safety-review.md). It replaces the quarantined
// .conductor-scratch/acceptance-immediate/run.mjs, which must never run: that wrapper grew a
// numeric-pid map from every descendant it ever saw and killed by it. Here the only cleanup
// authority is verify-kit's identity tracking: the smoke-lock child this launcher spawns (pinned by
// our own handle) is the registered root, descendants are tracked by immutable OS identity as they
// are observed, and cleanup is verify-kit safeClose - identity-bound, leaves first, fail-closed.
//
// Importing this file starts nothing. Run (only with a fresh exact controller grant):
//   node scripts/run-local-acceptance.mjs --scenario=fault --controller=agent_... --executor=agent_...
//     --generation=<n> --script="<exact manifest command>" --build=<abs out/main/index.js>
//     --commit=<HEAD sha> --candidate-sha256=<hash> [--timeout-min=<n>]
// with CONDUCTOR_CONTROL_ENDPOINT / CONDUCTOR_CONTROL_TOKEN in this process's own environment only.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const MODEL = 'local/qwen3.6-35b-a3b'
export const SLOT_FILE = join(REPO, 'artifacts', 'fixer-coordination', 'electron-slot.json')
export const EVIDENCE_ROOT = join(REPO, 'artifacts', 'verification', '2026-09-28-local-safety')
export const SLOT_MAX_AGE_MS = 5 * 60_000
const SOAK_WORKLOAD_MS = 6 * 3_600_000

/** A granted build path: absolute, already canonical (resolving it changes nothing) and free of
 *  whitespace, so the exact string checked here is the exact argument the smoke launches. */
export function canonicalBuild(build) {
  if (typeof build !== 'string' || !isAbsolute(build) || resolve(build) !== build || /\s/.test(build) || !/[\\/]out[\\/]main[\\/]index\.js$/i.test(build)) throw new Error(`build must be a canonical absolute path to out/main/index.js without spaces, got ${JSON.stringify(build)}`)
  return build
}

/** The exact smoke command per scenario, as the controller must name it in the slot grant. The
 *  smoke launches exactly `build`, re-hashed against `sha256` before each launch. Guard scenarios
 *  are refused: perf-input.mjs has its own kill paths, not covered by this review. */
export function manifestCommand(scenario, { timeoutMin, build, sha256 } = {}) {
  canonicalBuild(build)
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 ?? ''))) throw new Error('the manifest command needs the build\'s full sha256')
  const smoke = ['node', 'scripts/smoke-durable-jobs.mjs', `--real-model=${MODEL}`, `--app=${build}`, `--app-sha256=${sha256.toLowerCase()}`]
  const lock = minutes => ['node', 'scripts/smoke-lock.mjs', '--timeout-min', String(minutes), '--']
  const minutes = Number(timeoutMin)
  if (scenario === 'fault' || scenario === 'fault-control') {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error(`${scenario} needs the controller's exact --timeout-min (1-240)`)
    // The control is uninterrupted but held to the same completed-and-correct gate (--acceptance).
    return [...lock(minutes), ...smoke, ...(scenario === 'fault' ? ['--kill-server', '--restart-app'] : ['--acceptance']), '--extras=none']
  }
  if (scenario === 'soak') {
    // Workload 360 min + one bounded 20-min last iteration + 10 min cleanup; smoke-lock gets it all.
    if (!Number.isInteger(minutes) || minutes < 390) throw new Error('soak needs --timeout-min of at least 390 (6 h workload, bounded last iteration, cleanup)')
    return [...lock(minutes), ...smoke, '--fixture=crossref', '--soak']
  }
  if (scenario === 'guard' || scenario === 'guard-control') throw new Error(`${scenario}: perf-input.mjs cleanup has not been reviewed for fail-closed ownership; not run from here`)
  throw new Error(`unknown scenario ${JSON.stringify(scenario)}`)
}

export function parseArgs(argv) {
  const args = Object.fromEntries(argv.map(arg => { const [key, ...value] = arg.split('='); return [key.replace(/^--/, ''), value.join('=')] }))
  for (const key of ['scenario', 'controller', 'executor', 'generation', 'script', 'build', 'commit', 'candidate-sha256']) if (!args[key]) throw new Error(`--${key}= is required by the separate controller GO`)
  if (!/^agent_[a-z0-9_]+$/.test(args.controller) || !/^agent_[a-z0-9_]+$/.test(args.executor) || args.controller === args.executor) throw new Error('controller and executor must be distinct exact agent IDs')
  if (!/^\d+$/.test(args.generation)) throw new Error('generation must be numeric')
  if (!/^[0-9a-f]{40}$/i.test(args.commit) || !/^[0-9a-f]{64}$/i.test(args['candidate-sha256'])) throw new Error('commit and candidate-sha256 must be full hashes')
  const command = manifestCommand(args.scenario, { timeoutMin: args['timeout-min'], build: args.build, sha256: args['candidate-sha256'] }).join(' ')
  if (args.script !== command) throw new Error(`slot script must be the exact manifest command: ${command}`)
  return { ...args, command }
}

/** The controller's grant, exactly: granted, this executor, this generation, script and build, fresh. */
export function validateSlot(slot, args, now) {
  const problems = []
  if (slot?.status !== 'granted') problems.push(`slot status ${JSON.stringify(slot?.status)}`)
  if (slot?.agentSessionId !== args.executor) problems.push('slot names another executor')
  if (slot?.generation !== Number(args.generation)) problems.push('slot names another generation')
  if (slot?.script !== args.script) problems.push('slot names another script')
  if (slot?.build !== args.build) problems.push('slot names another build')
  const age = now - Date.parse(slot?.grantedAt ?? '')
  if (!(age >= 0 && age < SLOT_MAX_AGE_MS)) problems.push('slot grant is not less than five minutes old')
  if (problems.length) throw new Error(`NOT RUN (slot): ${problems.join('; ')}`)
  return slot
}

/** Quiet, empty and attended by exactly the named participants, or refused with every reason. */
export function judgeAdmission({ appServers, osServers, load, schedules, allowed }) {
  const reasons = []
  if (!Array.isArray(appServers) || appServers.length) reasons.push(`app model servers present: ${JSON.stringify(appServers)}`)
  if (!Array.isArray(osServers) || osServers.length) reasons.push(`OS llama-server processes present: ${JSON.stringify(osServers)}`)
  if (!load?.quiet) reasons.push(`load gate: ${(load?.reasons ?? ['unknown']).join('; ')}`)
  if (!(load?.cpuPercent < 30) || !(load?.gpuPercent < 40)) reasons.push(`CPU ${load?.cpuPercent}% / GPU ${load?.gpuPercent}% not under 30% / 40%`)
  if (load?.lock?.held) reasons.push('smoke lock is held')
  const tabs = load?.midTurn?.tabs ?? []
  if (load?.midTurn?.count !== allowed.length || tabs.length !== allowed.length || !tabs.every(tab => allowed.includes(tab.agentSessionId))) reasons.push(`active tabs must be exactly ${allowed.join(', ')}; saw ${JSON.stringify(tabs.map(tab => tab.agentSessionId))}`)
  if (!Array.isArray(schedules) || !schedules.length || schedules.some(schedule => schedule.enabled !== false || schedule.running !== false)) reasons.push('schedules are not all paused and idle')
  if (reasons.length) throw new Error(`NOT RUN (admission): ${reasons.join('; ')}`)
}

/** Every artifact string passes through here: the known secrets verbatim, plus the shapes a secret
 *  takes in process data (llama-server --api-key values, Bearer headers) whatever their value. */
export function sanitizeText(text, secrets = []) {
  let out = secrets.filter(secret => typeof secret === 'string' && secret.length >= 8).reduce((value, secret) => value.split(secret).join('[redacted]'), String(text))
  out = out.replace(/(--api-key(?:-file)?(?:=|\s+))("?)[^\s"]+/gi, '$1$2[redacted]')
  // Any non-space run, so a value whose start was already redacted in a held buffer
  // ("Bearer [redacted]" + the rest of it from the next chunk) is still matched whole.
  return out.replace(/(Bearer\s+)[^\s"]{8,}/g, '$1[redacted]')
}

/** A secret-shaped value: an --api-key or Bearer keyword and the (possibly still empty) value after it. */
const SECRET_SHAPE = /(--api-key(?:-file)?(?:=|\s+)|Bearer\s+)("?)([^\s"]*)/gi

/**
 * A streaming redactor for child output. Bytes are decoded across chunk boundaries (split UTF-8 is
 * never mangled). The WHOLE buffer is sanitized before any cut is chosen, so a complete secret is
 * already replaced wherever the cut falls. The cut is then: after the last newline, or - for a line
 * longer than `maxLine` - all but a tail at least as long as any known secret (a partial secret at
 * the end stays held until it is complete). Any --api-key/Bearer value that still reaches the end
 * of the buffer may continue in the next chunk, so the cut moves back before its keyword. Only if
 * such a value keeps growing past `hardMax` is it released (already redacted) and its continuation
 * in later chunks dropped as part of the same value. end() flushes the rest.
 */
export function createRedactor(secrets = [], { maxLine = 64 * 1024, hardMax = 1024 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8')
  const keep = Math.max(256, ...secrets.filter(Boolean).map(secret => String(secret).length))
  let pending = '', continuingValue = false
  const take = final => {
    if (continuingValue) {
      // The released part of a secret value ended at the buffer's end: the same value goes on here.
      const rest = /^[^\s"]*/.exec(pending)[0]
      pending = pending.slice(rest.length)
      if (pending.length || final) continuingValue = false
      if (!pending.length) return ''
    }
    const text = sanitizeText(pending, secrets)
    let cut
    if (final) cut = text.length
    else {
      const newline = text.lastIndexOf('\n')
      cut = newline >= 0 ? newline + 1 : text.length > maxLine ? Math.max(0, text.length - keep) : 0
      for (const match of text.matchAll(SECRET_SHAPE)) if (match.index + match[0].length === text.length) cut = Math.min(cut, match.index)
      if (cut <= 0 && text.length > hardMax) { cut = text.length; continuingValue = [...text.matchAll(SECRET_SHAPE)].some(match => match.index + match[0].length === text.length) }
    }
    // Never split a surrogate pair at the cut.
    if (cut > 0 && cut < text.length && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--
    pending = text.slice(cut)
    return text.slice(0, cut)
  }
  return {
    push(chunk) { pending += typeof chunk === 'string' ? chunk : decoder.write(chunk); return take(false) },
    end() { pending += decoder.end(); return take(true) }
  }
}

/** Evidence written as it happens: run.json replaced atomically, events.ndjson appended, never
 *  an existing generation's directory reused (no automatic retry). Everything it writes - run
 *  fields, events, error text from any path - is sanitized first. */
export function evidenceWriter(dir, { secrets = [] } = {}) {
  if (existsSync(join(dir, 'run.json'))) throw new Error(`NOT RUN (evidence): ${dir} already holds a run; no automatic retry`)
  mkdirSync(dir, { recursive: true })
  const run = {}
  const clean = value => sanitizeText(value, secrets)
  const save = () => { const temp = join(dir, 'run.json.tmp'); writeFileSync(temp, clean(JSON.stringify(run, null, 2)) + '\n', 'utf8'); renameSync(temp, join(dir, 'run.json')) }
  const event = entry => { const fd = openSync(join(dir, 'events.ndjson'), 'a'); try { appendFileSync(fd, clean(JSON.stringify({ at: new Date().toISOString(), ...entry })) + '\n'); fsyncSync(fd) } finally { closeSync(fd) } }
  return { run, save, event, dir, clean }
}

const redact = (text, secrets) => sanitizeText(text, secrets)

async function defaultDeps() {
  const kit = await import('./verify-kit.mjs')
  const endpoint = process.env.CONDUCTOR_CONTROL_ENDPOINT, token = process.env.CONDUCTOR_CONTROL_TOKEN
  return {
    kit, now: () => Date.now(), sleep: kit.sleep, loadCheck: kit.loadCheck,
    readSlot: () => JSON.parse(readFileSync(SLOT_FILE, 'utf8')),
    head: () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim(),
    digest: path => createHash('sha256').update(readFileSync(path)).digest('hex'),
    credential: { endpoint, token },
    call: async method => {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: {} }), signal: AbortSignal.timeout(10_000) })
      const body = await response.json()
      if (!response.ok || body.error) throw new Error(`${method}: HTTP ${response.status}`)
      return body.result
    },
    spawnSmoke: (file, args, options) => spawn(file, args, options)
  }
}

/** One scenario, end to end. Returns the run record; never throws past its own evidence. */
export async function runAcceptance(argv, overrides = {}) {
  const deps = { ...(await defaultDeps()), ...overrides }
  const { kit } = deps
  const secrets = [deps.credential?.token]
  let evidence = null, child = null, inst = null, sampler = null, heartbeat = null, log = null
  const redactors = []
  // Flushes every redactor's held tail and closes full.log, on the normal path and every error path.
  const closeLog = async () => {
    if (!log) return
    const stream = log
    log = null
    for (const redactor of redactors) { const rest = redactor.end(); if (rest) stream.write(rest) }
    await new Promise(done => stream.end(done))
  }
  const fail = (status, error) => {
    if (!evidence) throw error
    // An unaccounted cleanup outranks the failure that led to it.
    if (!String(evidence.run.status).startsWith('UNVERIFIED')) evidence.run.status = status
    evidence.run.reason = redact(error?.message ?? error, secrets).slice(0, 2000)
    evidence.run.endAt ??= new Date(deps.now()).toISOString()
    evidence.event({ event: 'status', status, reason: evidence.run.reason })
    evidence.save()
    return evidence.run
  }
  const args = parseArgs(argv)
  evidence = evidenceWriter(join(overrides.evidenceRoot ?? EVIDENCE_ROOT, `${args.scenario}-${args.generation}`), { secrets })
  Object.assign(evidence.run, { scenario: args.scenario, controller: args.controller, executor: args.executor, generation: Number(args.generation), command: args.command, preparedAt: new Date(deps.now()).toISOString(), acceptance: 'CONTROLLER JUDGMENT REQUIRED', status: 'PREPARING' })
  evidence.save()
  try {
    if (!deps.credential?.endpoint?.startsWith('http://127.0.0.1:') || !deps.credential?.token) throw new Error('NOT RUN (credential): own scoped endpoint and token required from this process environment')
    evidence.run.slot = validateSlot(deps.readSlot(), args, deps.now())
    evidence.run.commit = deps.head()
    if (evidence.run.commit !== args.commit) throw new Error('NOT RUN (build): candidate commit changed')
    evidence.run.candidateBuild = { path: args.build, sha256: deps.digest(args.build) }
    if (evidence.run.candidateBuild.sha256.toLowerCase() !== args['candidate-sha256'].toLowerCase()) throw new Error('NOT RUN (build): candidate build hash changed')
    const schedules = await deps.call('schedules.list')
    const appServers = await deps.call('local.servers')
    const { list } = await kit.listProcesses()
    const osServers = list.filter(entry => /^llama-server(\.exe)?$/i.test(entry.name)).map(entry => ({ pid: entry.pid, creationTime: entry.creationTime }))
    const load = await deps.loadCheck({ selfTabs: 2, record: false })
    Object.assign(evidence.run, { schedulesBefore: schedules.map(s => ({ id: s.id, enabled: s.enabled, running: s.running })), serversBefore: { app: appServers.map(s => ({ model: s.model, pid: s.pid })), os: osServers }, load: { quiet: load?.quiet, cpu: load?.cpuPercent, gpu: load?.gpuPercent, reasons: load?.reasons, tabs: load?.midTurn?.tabs?.map(tab => tab.agentSessionId), info: load?.info ?? [] } })
    judgeAdmission({ appServers, osServers, load, schedules, allowed: [args.controller, args.executor] })
    evidence.save()
    validateSlot(deps.readSlot(), args, deps.now()) // immediately before spawn
    // And the build bytes once more: the smoke re-checks them itself before every launch too.
    try { kit.assertBuildHash(args.build, args['candidate-sha256'], { digest: deps.digest }) } catch (error) { throw new Error(`NOT RUN (build): ${error.message}`) }

    const temp = join(REPO, '.conductor-scratch', 'local-acceptance', `temp-${args.scenario}-${args.generation}`)
    mkdirSync(temp, { recursive: true })
    const parts = args.command.split(' ')
    const separator = parts.indexOf('--')
    const smokeArgs = [join(REPO, parts[1]), ...parts.slice(2, separator + 1), process.execPath, join(REPO, parts[separator + 2]), ...parts.slice(separator + 3)]
    const env = { ...process.env, TMP: temp, TEMP: temp, CONDUCTOR_BACKGROUND_WINDOWS: '1', ...(args.scenario === 'soak' ? { DURABLE_SOAK_WORKLOAD_MS: String(SOAK_WORKLOAD_MS) } : {}) }
    delete env.CONDUCTOR_CONTROL_ENDPOINT; delete env.CONDUCTOR_CONTROL_TOKEN
    Object.assign(evidence.run, { executed: [process.execPath, ...smokeArgs].join(' '), environment: { TMP: temp, CONDUCTOR_BACKGROUND_WINDOWS: '1', DURABLE_SOAK_WORKLOAD_MS: env.DURABLE_SOAK_WORKLOAD_MS ?? null }, startAt: new Date(deps.now()).toISOString(), status: 'RUNNING' })
    evidence.save()
    log = createWriteStream(join(evidence.dir, 'full.log'), { flags: 'wx' })
    log.on('error', error => { evidence.run.logError = String(error?.code ?? error?.message ?? error) })
    const spawnedAtMs = deps.now()
    child = deps.spawnSmoke(process.execPath, smokeArgs, { cwd: REPO, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise(done => { child.on('error', error => done({ code: null, signal: null, error: error.message })); child.on('exit', (code, signal) => done({ code, signal })) })
    // One redactor per stream: a secret or a UTF-8 character split across chunks is seen whole.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      const redactor = createRedactor(secrets)
      redactors.push(redactor)
      stream.on('data', chunk => { const text = redactor.push(chunk); if (text && log) log.write(text) })
    }
    // Our own child, pinned by our handle: the one root. Everything else is proven from it.
    inst = kit.newInstance({ name: `local-acceptance-${args.scenario}`, generation: `${args.scenario}-${args.generation}` })
    // Only a child still running after this snapshot, created inside the spawn window, is ours to
    // register: one that exited first may already have handed its pid to a foreign process.
    evidence.run.root = await kit.registerOwnChild(inst, child, { source: 'smoke-lock launch', list: (await kit.listProcesses()).list, spawnedAtMs, now: deps.now })
    // Registration already tracked whatever its snapshot showed under the root.
    evidence.event({ event: 'tracked', processes: inst.roots.map(entry => ({ pid: entry.pid, name: entry.name, creationTime: entry.creationTime, source: entry.source })) })
    evidence.save()
    const track = async () => {
      try {
        const added = kit.trackDescendants(inst, (await kit.listProcesses({ timeoutMs: 20_000 })).list)
        if (added.length) evidence.event({ event: 'tracked', processes: added.map(entry => ({ pid: entry.pid, name: entry.name, creationTime: entry.creationTime })) })
      } catch (error) { evidence.event({ event: 'track-failed', error: String(error?.message ?? error).slice(0, 300) }) }
    }
    await track()
    sampler = setInterval(() => { void track() }, overrides.trackMs ?? 5000)
    heartbeat = setInterval(() => { evidence.run.lastHeartbeatAt = new Date(deps.now()).toISOString(); evidence.save() }, overrides.heartbeatMs ?? 60_000)
    const ceilingMs = (Number(args['timeout-min']) + 10) * 60_000
    const exit = await Promise.race([exited, new Promise(done => { const timer = setTimeout(() => done({ code: null, signal: null, watchdog: `exceeded ${ceilingMs / 60_000} min` }), overrides.ceilingMs ?? ceilingMs); timer.unref?.() })])
    clearInterval(sampler); clearInterval(heartbeat); sampler = heartbeat = null
    await track()
    await closeLog()
    Object.assign(evidence.run, { endAt: new Date(deps.now()).toISOString(), exit })
    evidence.event({ event: 'exit', exit })
    evidence.save()
    return await finishRun({ evidence, inst, deps, args, clean: exit.code === 0 && !exit.watchdog })
  } catch (error) {
    if (sampler) clearInterval(sampler)
    if (heartbeat) clearInterval(heartbeat)
    // A still-running child we could not register is stopped only through Node's own handle.
    if (child && child.exitCode === null && child.signalCode === null && !inst?.roots?.length) { try { child.kill() } catch { /* already gone */ } }
    try { await closeLog() } catch (logError) { evidence.run.logError = String(logError?.message ?? logError) }
    if (inst) { try { await finishRun({ evidence, inst, deps, args, clean: false }) } catch (cleanupError) { evidence.run.cleanupError = String(cleanupError?.message ?? cleanupError) } }
    else if (child) evidence.run.cleanup = { unresolved: [{ pid: child.pid, reason: 'launched child never registered; nothing attributed or killed' }] }
    return fail(evidence.run.startAt ? 'FAIL' : 'NOT RUN', error)
  }
}

/** Identity-bound cleanup and the exit inventory. Foreign neighbours are counted, never touched. */
async function finishRun({ evidence, inst, deps, args, clean }) {
  const { kit } = deps
  const close = await kit.safeClose(inst, { deps: { ...kit.closeDeps, ...(deps.closeDeps ?? {}), ledger: entry => evidence.event({ event: 'cleanup', ...entry }) } })
  let appServers = null, osServers = null
  try { appServers = (await deps.call('local.servers')).map(s => ({ model: s.model, pid: s.pid, startedByConductor: s.startedByConductor })) } catch (error) { evidence.run.appServersError = String(error?.message ?? error) }
  try { osServers = (await kit.listProcesses()).list.filter(entry => /^llama-server(\.exe)?$/i.test(entry.name)).map(entry => ({ pid: entry.pid, ppid: entry.ppid, creationTime: entry.creationTime })) } catch (error) { evidence.run.osServersError = String(error?.message ?? error) }
  try { evidence.run.schedulesAfter = (await deps.call('schedules.list')).map(s => ({ id: s.id, enabled: s.enabled, running: s.running })) } catch (error) { evidence.run.schedulesAfterError = String(error?.message ?? error) }
  evidence.run.cleanup = { ...close, appServers, osServers, trackedIdentities: inst.roots.length }
  const accounted = close && !close.leftovers.length && !close.unresolved.length && Array.isArray(appServers) && !appServers.length && Array.isArray(osServers) && !osServers.length
  evidence.run.status = clean && accounted ? 'AWAITING CONTROLLER JUDGMENT' : accounted ? 'FAIL' : 'UNVERIFIED (cleanup)'
  evidence.event({ event: 'status', status: evidence.run.status })
  evidence.save()
  return evidence.run
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const deps = await defaultDeps()
  const run = await runAcceptance(process.argv.slice(2), deps).catch(error => { console.error(redact(error?.message ?? error, [deps.credential?.token])); return { status: 'NOT RUN' } })
  console.log(`[run-local-acceptance] ${run.status}`)
  process.exitCode = run.status === 'AWAITING CONTROLLER JUDGMENT' ? 0 : 1
}
