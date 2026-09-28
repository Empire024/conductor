import { execFileSync, spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LocalModelConfig } from './config.ts'
import { configPath, loadConfig, logsDir, modelFilePath, runDir, runFile } from './config.ts'
import { lowerSpawned } from '../background-priority.ts'
import { childEnvironment } from './paths.ts'
import { writeChatTemplate } from './templates.ts'
import { AdmissionRefusal, admissionRefusal, assertResourceHeadroom, runningLlamaProcesses, withAdmissionLock, type BlockingServer, type ServerProcess } from './resource-guard.ts'

/** What the installed llama-server accepts, read from its own --help once per executable. A
 *  flag is only ever passed when the binary lists it; an older build simply gets the defaults. */
export interface LlamaServerFeatures { cacheTypeK: boolean; cacheTypeV: boolean; flashAttn: boolean }
const featureCache = new Map<string, LlamaServerFeatures>()
export function parseLlamaServerFeatures(helpText: string): LlamaServerFeatures {
  return { cacheTypeK: /--cache-type-k\b/.test(helpText), cacheTypeV: /--cache-type-v\b/.test(helpText), flashAttn: /--flash-attn\b/.test(helpText) }
}
export async function llamaServerFeatures(executable: string): Promise<LlamaServerFeatures> {
  const cached = featureCache.get(executable)
  if (cached) return cached
  const help = await new Promise<string>(resolve => {
    let output = ''
    const child = spawn(executable, ['--help'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(output) })
  })
  const features = parseLlamaServerFeatures(help)
  featureCache.set(executable, features)
  return features
}

/** llama.cpp is an inference engine here and nothing else. These flags would hand it tools, a
 *  network surface or an agent runtime of its own, so they are refused wherever extra arguments
 *  can be configured: Conductor stays the only orchestrator, and the server stays loopback-only
 *  behind its API key. */
const FORBIDDEN_ARGS = [
  /^--host$/, /^--port$/, /^--api-key(-file)?$/, /^--path$/, /^--rpc/, /^--mcp/, /^--agent/, /^--tools?$/,
  /^--jinja-tools/, /^--webui/, /^--cors/, /^--allow-origin/, /^--chat-template-file$/, /^--lora/, /^--public/
]

export function validateExtraArgs(args: string[]): string[] {
  for (const arg of args) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) throw new Error('Invalid llama.cpp argument')
    if (FORBIDDEN_ARGS.some(pattern => pattern.test(arg))) throw new Error(`Refusing llama.cpp argument ${arg}: binding, web UI, tool and agent features stay disabled`)
  }
  return args
}

/** The exact server argv. Bound to 127.0.0.1 only, web UI off, API key required, one slot, and
 *  --jinja so the model's own chat template drives OpenAI-style tool calls. No tool runtime, no
 *  MCP, no agent mode, no RPC backend. */
export function llamaServerArgs(model: LocalModelConfig, apiKey: string, modelPath = modelFilePath(model), features?: LlamaServerFeatures, chatTemplateFile?: string): string[] {
  if (!/^[a-f0-9]{32,}$/i.test(apiKey)) throw new Error('Local model API key is malformed')
  const quantizedKv = Boolean(model.kvCacheType && model.kvCacheType !== 'f16' && model.kvCacheType !== 'bf16')
  const cacheArgs = model.kvCacheType && features?.cacheTypeK && features.cacheTypeV ? ['--cache-type-k', model.kvCacheType, '--cache-type-v', model.kvCacheType] : []
  // A quantized V cache is refused by llama.cpp without flash attention, so it is asked for
  // explicitly there; otherwise the build's own default (auto) is left alone unless configured.
  const flash = model.flashAttention ?? (quantizedKv && cacheArgs.length ? 'on' : undefined)
  const flashArgs = flash && features?.flashAttn ? ['--flash-attn', flash] : []
  return [
    '--host', '127.0.0.1',
    '--port', String(model.port),
    '--api-key', apiKey,
    '--no-webui',
    '--model', modelPath,
    '--alias', model.id,
    '--ctx-size', String(model.contextTokens),
    '--n-gpu-layers', String(model.gpuLayers),
    '--parallel', '1',
    '--jinja',
    // Conductor's own template (templates.ts); the owner's extraArgs may still not name one.
    ...(chatTemplateFile ? ['--chat-template-file', chatTemplateFile] : []),
    ...cacheArgs,
    ...flashArgs,
    ...validateExtraArgs(model.extraArgs ?? [])
  ]
}

export const logFile = (model: LocalModelConfig): string => join(logsDir(), model.id.replace(/[^a-z0-9.-]/gi, '_') + '.log')

/** The OS's own identity of a process, read while the process is pinned (Node's child handle at
 *  launch, the stop helper's own handle later): its creation time, as the OS reports it, and the
 *  executable image. A pid, a name or a command line can all repeat; these two together do not. */
export interface ProcessIdentity { creationTime: string; executable: string }

/** `pid: null` marks a server this Conductor instance adopted rather than started: we know it is
 *  ours (it serves our model id and enforces our API key) but not which process it is, so nothing here may try
 *  to kill it. `generation` and `identity` are written at launch; a record without them (an older
 *  Conductor's, or one rewritten on adoption) names a process nothing here can prove is ours, so it
 *  is never stopped either. `startedAt` is the record's own time, not the OS creation time. */
export interface RunRecord { pid: number | null; port: number; model: string; file: string; startedAt: string; generation?: string; identity?: ProcessIdentity }

export function readRunRecord(model: LocalModelConfig): RunRecord | null {
  const path = runFile(model)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
    if (!Number.isInteger(record.port) || record.port <= 0) return null
    const pidOk = record.pid === null || (Number.isInteger(record.pid) && record.pid > 0)
    return pidOk ? record : null
  } catch { return null }
}

/** A process we may not signal still exists: EPERM is never read as "gone". */
export const processAlive = (pid: number | null): boolean => {
  if (pid === null) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** "Is something listening" - the right question for "is the server I recorded actually up",
 *  where a live connection is exactly what we want to know. Not the right question for "can I
 *  start here": see `portBindable`. */
export function portInUse(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean): void => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** "Can I start here." A TCP connect (`portInUse`) returns false for a port that is bound but
 *  not yet accepting connections, and on Windows for a port a just-exited server still holds in
 *  TIME_WAIT - yet `bind()` fails for both, so only an actual bind attempt answers this question.
 *  The probe socket is always closed before resolving. */
export function portBindable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    let listening = false
    const finish = (value: boolean): void => {
      if (listening) probe.close(() => resolve(value))
      else resolve(value)
    }
    probe.once('error', (error: NodeJS.ErrnoException) => {
      finish(!(error.code === 'EADDRINUSE' || error.code === 'EACCES'))
    })
    probe.once('listening', () => { listening = true; finish(true) })
    probe.listen(port, host)
  })
}

export interface HealthResult { ok: boolean; status: number; detail?: string; models?: string[] }

/**
 * One bounded request that answers both questions a caller has: is this server up, and which model
 * is it serving. Reading the body here rather than asking a second time matters on the adoption
 * path - a process that accepts a connection and then never answers must not be able to hold a
 * local model start open, and every request on this path carries the same deadline.
 */
export async function health(port: number, apiKey: string, timeoutMs = 4000): Promise<HealthResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal })
    if (!response.ok) return { ok: false, status: response.status, detail: `HTTP ${response.status}` }
    let models: string[] = []
    try {
      const body = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> }
      const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
      models = entries.map(entry => String(entry?.id ?? '')).filter(Boolean)
    } catch { /* A server that is up but answers unreadable JSON is still up; it just names nothing. */ }
    return { ok: true, status: response.status, models }
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : 'unreachable' }
  } finally { clearTimeout(timer) }
}

/** Proof that the key is enforced: the same endpoint without an Authorization header must be
 *  refused. Used by `status` and by the security tests. */
export async function rejectsAnonymous(port: number, timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: controller.signal })
    return response.status === 401 || response.status === 403
  } catch { return false }
  finally { clearTimeout(timer) }
}

export async function llamaServerVersion(executable: string): Promise<string> {
  return await new Promise<string>(resolve => {
    let output = ''
    const child = spawn(executable, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(output.trim().split(/\r?\n/).filter(Boolean).join(' | ').slice(0, 300)) })
  })
}

/** Where a working llama-server may be found, in order of preference. A winget install adds
 *  its package directory to the user PATH, which an already-running shell has not picked up
 *  yet, so the known install locations are checked directly rather than asking for a reinstall
 *  or copying a binary into the project. */
export function llamaServerCandidates(configured?: string): string[] {
  const candidates: string[] = []
  const add = (value: string | undefined | null): void => { if (value?.trim() && !candidates.includes(value.trim())) candidates.push(value.trim()) }
  add(configured)
  add(process.env.CONDUCTOR_LLAMA_SERVER)
  if (process.platform === 'win32') {
    try {
      const found = execFileSync('where.exe', ['llama-server'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of found.split(/\r?\n/)) add(line)
    } catch { /* Not on this process's PATH; the install locations below still apply. */ }
    const local = process.env.LOCALAPPDATA
    if (local) {
      add(join(local, 'Microsoft', 'WinGet', 'Links', 'llama-server.exe'))
      const packages = join(local, 'Microsoft', 'WinGet', 'Packages')
      try {
        for (const entry of readdirSync(packages, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/llamacpp/i.test(entry.name)) continue
          const base = join(packages, entry.name)
          add(join(base, 'llama-server.exe'))
          try {
            for (const nested of readdirSync(base, { withFileTypes: true })) if (nested.isDirectory()) add(join(base, nested.name, 'llama-server.exe'))
          } catch { /* unreadable package directory */ }
        }
      } catch { /* winget packages directory is absent */ }
    }
  }
  add('llama-server')
  return candidates
}

/** The first candidate that actually answers `--version`, with the version it reported. */
export async function resolveLlamaServer(configured?: string): Promise<{ path: string; version: string } | null> {
  for (const candidate of llamaServerCandidates(configured)) {
    if (candidate !== 'llama-server' && candidate.includes('\\') && !existsSync(candidate)) continue
    const version = await llamaServerVersion(candidate)
    if (version) return { path: candidate, version }
  }
  return null
}

export interface StartOutcome { started: boolean; pid: number; port: number; message: string }


/** Either the orphan we adopted, or why the thing on that port is not ours - the caller moves to
 *  a free port on a refusal and the reason is what the owner is told. */
export interface AdoptionResult { adopted: StartOutcome | null; reason: string }

/** A port the configured server can't bind to may already hold our own orphaned llama.cpp from
 *  an earlier Conductor run. Three things have to line up before we send a conversation there: it
 *  answers our authenticated health check, it lists our model id, and - the part an answer alone
 *  cannot show - it *refuses* the same request without the key. Ollama, LM Studio and a
 *  `llama-server` started without `--api-key` all answer 200 to anything, so "it replied" proves
 *  nothing about who is listening; only the anonymous refusal proves our key is enforced, which is
 *  what makes it our server. Every probe here shares one deadline, so a process that accepts
 *  connections and then stalls cannot hold a model start open. */
export async function adoptRunningServer(model: LocalModelConfig, apiKey: string, port: number, timeoutMs = 4000): Promise<AdoptionResult> {
  const address = `127.0.0.1:${port}`
  const probe = await health(port, apiKey, timeoutMs)
  if (!probe.ok) return { adopted: null, reason: `${address} is held by something that is not answering as one of our model servers (${probe.detail ?? `HTTP ${probe.status}`})` }
  if (!probe.models?.includes(model.id)) {
    const serving = probe.models?.length ? probe.models.slice(0, 3).join(', ') : 'no model it will name'
    return { adopted: null, reason: `${address} is serving ${serving}, not ${model.id}` }
  }
  // The proof, not the presumption: a server that hands out models to an unauthenticated caller is
  // some other inference server on this machine, whatever it chose to call our model id.
  if (!await rejectsAnonymous(port, timeoutMs)) {
    return { adopted: null, reason: `${address} answers ${model.id} without our API key, so it is another inference server rather than ours` }
  }
  const existing = readRunRecord(model)
  const record: RunRecord = existing && existing.port === port && processAlive(existing.pid)
    ? existing
    : { pid: null, port, model: model.id, file: model.file, startedAt: new Date().toISOString() }
  writeFileSync(runFile(model), JSON.stringify(record, null, 2), 'utf8')
  return { adopted: { started: false, pid: record.pid ?? 0, port, message: 'adopted the server already running on this port' }, reason: 'adopted' }
}

/** The configured port is held by something that isn't ours. Rather than fail, look nearby for a
 *  free one; the caller starts there and records the port actually used so `endpointFor` (and
 *  `health`/`serverStatus`/`stopServer` here) can still find the server. */
/** A port the OS itself picks and hands back, which is the only way to be sure of escaping a
 *  reserved range: Windows will never assign one it has excluded. There is a small window between
 *  closing this probe and llama.cpp binding, which is why it is the fallback rather than the first
 *  choice - a stable port keeps the endpoint the same across restarts. */
function ephemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.once('listening', () => {
      const address = probe.address()
      const port = address && typeof address !== 'string' ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('The OS did not assign a port'))))
    })
    probe.listen(0, host)
  })
}

/**
 * Somewhere to start when the configured port cannot be bound. The neighbouring ports are tried
 * first so the endpoint stays predictable, but a short scan is not enough on its own: Hyper-V, WSL
 * and Docker reserve TCP ranges a hundred ports wide and renumber them on reboot, which is exactly
 * how a model that worked yesterday starts reporting `couldn't bind HTTP server socket` today. A
 * range that swallows the whole scan is normal, so the OS gets the last word.
 */
export async function findFreePort(model: LocalModelConfig, span = 40): Promise<number> {
  for (let candidate = model.port + 1; candidate <= model.port + span; candidate++) {
    if (await portBindable(candidate)) return candidate
  }
  try { return await ephemeralPort() }
  catch (error) {
    throw new Error(`No free port for ${model.id}: 127.0.0.1:${model.port}-${model.port + span} are all unavailable and the OS would not assign one (${error instanceof Error ? error.message : String(error)}). On Windows, check reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp`)
  }
}

/** Lines a Windows-style bind failure or crash tends to leave in llama.cpp's own log, read from
 *  at most the last 64 KiB - these files reach hundreds of MB over a server's lifetime. */
function tailErrorLines(path: string, maxBytes = 64 * 1024, maxLines = 3): string[] {
  try {
    if (!existsSync(path)) return []
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return []
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      return buffer.toString('utf8').split(/\r?\n/)
        .filter(line => /^\s*\S+\s+E\s/.test(line) || /error/i.test(line) || /exiting/i.test(line))
        .map(line => line.trim())
        .slice(-maxLines)
    } finally { closeSync(fd) }
  } catch { return [] }
}

/** What the generic "exited during startup" message could not say: which port, and why, lifted
 *  from the tail of the server's own log rather than left for the owner to go find. */
export function describeStartupFailure(model: LocalModelConfig, port: number): string {
  const log = logFile(model)
  const lines = tailErrorLines(log)
  const headline = lines.some(line => /bind/i.test(line)) ? `llama.cpp could not bind 127.0.0.1:${port}` : `llama.cpp exited during startup on 127.0.0.1:${port}`
  const detail = lines.length ? ` (${lines.join('; ')})` : ''
  return `${headline}${detail}; see ${log}`
}

/** Start one model server, refusing rather than duplicating: an existing healthy process for
 *  this model is reported as already running. A configured port that cannot be bound is first
 *  checked for one of our own orphaned servers (adopted rather than duplicated) and otherwise
 *  worked around by moving to a nearby free port - only a port occupied by someone else across
 *  the whole scan range is an error. */
export async function startServer(executable: string, model: LocalModelConfig, apiKey: string, opts: StartOptions = {}): Promise<StartOutcome> {
  return withAdmissionLock(() => startAdmittedServer(executable, model, apiKey, opts))
}

/** Must run inside the machine-wide admission lock, through record publication and health.
 * Stale records are evidence to investigate, never evidence to kill a process or to reuse it. */
export async function inspectAdmission(model: LocalModelConfig, apiKey: string): Promise<StartOutcome | null> {
  const configured = existsSync(configPath()) ? Object.values(loadConfig().models) : [model]
  const candidates = new Map<number, { model: string; pid: number | null }>()
  for (const entry of configured) candidates.set(entry.port, { model: entry.id, pid: null })
  candidates.set(model.port, { model: model.id, pid: null })
  for (const file of readdirSync(runDir()).filter(name => name.endsWith('.json'))) {
    let record: RunRecord
    try { record = JSON.parse(readFileSync(join(runDir(), file), 'utf8')) as RunRecord } catch { throw new Error(`Cannot read local server record ${file}; no second server started. Review the runtime records before retrying.`) }
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.model !== 'string' || !(record.pid === null || (Number.isInteger(record.pid) && record.pid > 0))) throw new Error(`Invalid local server record ${file}; no second server started`)
    candidates.set(record.port, { model: record.model, pid: record.pid })
  }
  let reusable: StartOutcome | null = null
  let occupied: string | null = null
  let blocker: BlockingServer | null = null
  let inventory: ServerProcess[] | undefined
  const processes = (): ServerProcess[] => inventory ??= runningLlamaProcesses()
  for (const [port, candidate] of candidates) {
    const listening = await portInUse(port, 300)
    let alive = processAlive(candidate.pid)
    // A recorded pid that is alive but not listening is either a server still loading or a stale
    // record whose pid the OS has since handed to an unrelated process. Only the inventory tells,
    // and a stale record must not keep every other model off the machine for good.
    if (alive && !listening) alive = processes().some(entry => entry.pid === candidate.pid)
    if (!listening && !alive) continue // includes the old 35B record with a dead pid
    const probe = listening ? await health(port, apiKey, 1500) : null
    if (probe?.ok && probe.models?.includes(model.id) && await rejectsAnonymous(port, 1500)) {
      // Remember, but finish the inventory before mutating any record.
      reusable = { started: false, pid: candidate.model === model.id && alive ? candidate.pid! : 0, port, message: `reusing ${model.id} already running on 127.0.0.1:${port}` }
    } else {
      occupied = probe?.models?.join(', ') || `${candidate.model} on port ${port} (identity or health unverified)`
      blocker = { model: probe?.models?.[0] ?? candidate.model, port, pid: alive ? candidate.pid : null, ours: alive && candidate.pid !== null }
    }
  }
  // Reusing does not allocate another model, even if the owner started multiple servers manually.
  if (reusable) {
    const record = readRunRecord(model)
    if (!record || record.port !== reusable.port || record.pid !== (reusable.pid || null)) writeFileSync(runFile(model), JSON.stringify({ pid: reusable.pid || null, port: reusable.port, model: model.id, file: model.file, startedAt: new Date().toISOString() } satisfies RunRecord, null, 2), 'utf8')
    return { ...reusable, message: reusable.pid ? reusable.message : `adopted; ${reusable.message}` }
  }
  if (occupied) throw admissionRefusal(model.id, occupied, blocker ?? undefined)
  for (const entry of processes()) {
    // Unrecorded servers may have moved ports or live under another data root.
    if (entry.port) {
      const probe = await health(entry.port, apiKey, 1500)
      if (probe.ok && probe.models?.includes(model.id)) {
        const adoption = await adoptRunningServer(model, apiKey, entry.port, 1500)
        if (adoption.adopted) return adoption.adopted
      }
    }
    throw admissionRefusal(model.id, entry.model, { model: entry.model, port: entry.port, pid: entry.pid, ours: false })
  }
  return null
}

export interface StartOptions {
  pollMs?: number
  timeoutMs?: number
  /** Consulted before an idle server of another model, one this Conductor started, is stopped to
   *  make room. `'idle'` lets the switch happen; any other string is the reason the running server
   *  is busy and becomes the refusal. Without it, another running model is refused as before,
   *  which is what the CLI and the tests expect. */
  release?: (running: BlockingServer) => Promise<'idle' | string>
}

/** One llama.cpp server at a time is a VRAM rule, not a claim on the owner's attention: a server
 *  this Conductor started and that nothing is using gives way to the model that was asked for. A
 *  server started elsewhere is never touched, and a busy one is named with what keeps it busy. */
async function makeRoom(model: LocalModelConfig, running: BlockingServer, release: NonNullable<StartOptions['release']>): Promise<string> {
  const rule = 'This machine runs one llama.cpp server at a time (12 GB VRAM).'
  if (!running.ours || running.pid === null) throw new Error(`Cannot start ${model.id}: ${running.model} is running on this machine but was not started by this Conductor, so it is left alone. ${rule} Use ${running.model}, or stop it yourself before switching.`)
  const verdict = await release(running)
  if (verdict !== 'idle') throw new Error(`Cannot start ${model.id}: ${running.model} is busy (${verdict}). ${rule} Wait for that work to finish, or use ${running.model} instead. Conductor has not stopped it.`)
  const file = recordFileFor(running.model, running.pid)
  if (!file) throw new Error(`Cannot start ${model.id}: the run record for ${running.model} (pid ${running.pid}) changed before it could be stopped, so it was left alone. ${rule}`)
  const outcome = await stopOwnedServer(defaultStopDeps(file, running.model), { expectedPid: running.pid })
  if (outcome.status !== 'stopped') throw new Error(`Cannot start ${model.id}: ${outcome.message} No second server was started. ${rule}`)
  return `stopped idle ${running.model} to make room`
}

// ------------------------------------------------------------------------------------------------
// Stopping a server this Conductor started. One path for local.stop, the CLI and make-room: the
// process is identified by the OS identity recorded at launch, re-verified immediately before the
// kill, killed alone (never /T: llama-server starts no children of ours), and "stopped" is only
// reported once its exit and a free port are observed, all inside one 20-second deadline.

/** The most a stop may take, helper, kill and exit observation included. */
export const STOP_DEADLINE_MS = 20_000

export type ProcessProbe =
  | ({ state: 'running' } & ProcessIdentity)
  | { state: 'absent' }
  | { state: 'unknown'; detail: string }

/** `exited`: killed (or found exiting) and the exit observed on the helper's own handle.
 *  `signalled`: the kill went out, exit not yet observed. `mismatch`/`absent`: nothing was killed. */
export type TerminateResult =
  | { state: 'exited' | 'signalled' }
  | ({ state: 'mismatch' } & ProcessIdentity)
  | { state: 'absent' }
  | { state: 'unknown'; detail: string }

export interface StopDeps {
  now(): number
  sleep(ms: number): Promise<void>
  /** The model's run record as it is on disk right now. */
  readRecord(): RunRecord | null
  removeRecord(): void
  /** Who holds `pid` right now; `unknown` for denied, failed or timed-out queries, never `absent`. */
  inspect(pid: number, budgetMs: number): Promise<ProcessProbe>
  /** Kill `pid` only if it still has `identity`, verified on the same OS handle that kills it. */
  terminate(pid: number, identity: ProcessIdentity, budgetMs: number): Promise<TerminateResult>
  portInUse(port: number, timeoutMs: number): Promise<boolean>
  /** One line per attempt and result, written as it happens. */
  journal(entry: Record<string, unknown>): void
  deadlineMs?: number
  pollMs?: number
}

export type StopOutcome =
  | { status: 'not-running'; message: string }
  | { status: 'stopped'; pid: number; killed: boolean; message: string }
  | { status: 'refused' | 'uncertain'; pid: number | null; message: string }

const FILETIME_OR_STAMP = /^[0-9A-Za-z :.+-]{1,64}$/
/** A launch identity good enough to act on: a creation time and an absolute executable path. */
export function validIdentity(identity: unknown): identity is ProcessIdentity {
  const value = identity as Partial<ProcessIdentity> | null | undefined
  return Boolean(value) && typeof value!.creationTime === 'string' && FILETIME_OR_STAMP.test(value!.creationTime) && !/^0+$/.test(value!.creationTime)
    && typeof value!.executable === 'string' && (/^[A-Za-z]:[\\/]/.test(value!.executable) || value!.executable.startsWith('/'))
}

export const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
  a.creationTime === b.creationTime && a.executable.toLowerCase() === b.executable.toLowerCase()

const sameRecord = (a: RunRecord | null, b: RunRecord): boolean =>
  Boolean(a) && a!.pid === b.pid && a!.port === b.port && a!.generation === b.generation && Boolean(a!.identity) && sameIdentity(a!.identity!, b.identity!)

/** Races a dependency call against what is left of the deadline, so an injected or wedged helper
 *  can never hold a stop past it. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { timedOut: true } | { error: unknown }> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms)) })
  try { return await Promise.race([work.then(value => ({ value }), error => ({ error })), expired]) }
  finally { clearTimeout(timer) }
}

/**
 * The one stop path. Refuses, with zero kill attempts, anything whose ownership is not proven: no
 * record, an adopted server, a record without launch generation/identity, a pid that changed since
 * the caller chose it, or a process whose identity cannot be read. A pid now held by a different
 * process means ours has already exited; that process is left alone. Any uncertainty keeps the run
 * record, so the next admission pass still sees it and starts nothing beside it.
 */
export async function stopOwnedServer(deps: StopDeps, { expectedPid }: { expectedPid?: number | null } = {}): Promise<StopOutcome> {
  const started = deps.now()
  const deadline = started + Math.min(deps.deadlineMs ?? STOP_DEADLINE_MS, STOP_DEADLINE_MS)
  const left = (): number => Math.max(0, deadline - deps.now())
  const pollMs = deps.pollMs ?? 250
  const note = (entry: Record<string, unknown>): void => { try { deps.journal({ at: new Date().toISOString(), elapsedMs: deps.now() - started, ...entry }) } catch { /* the outcome still says what happened */ } }
  const record = deps.readRecord()
  if (!record) { note({ event: 'not-running' }); return { status: 'not-running', message: 'not running' } }
  const pid = record.pid
  const refuse = (message: string): StopOutcome => { note({ event: 'refused', pid, message }); return { status: 'refused', pid, message } }
  const uncertain = (message: string): StopOutcome => { note({ event: 'uncertain', pid, message }); return { status: 'uncertain', pid, message: `${message} The run record is kept.` } }
  if (expectedPid !== undefined && pid !== expectedPid) return refuse(`The run record for ${record.model} now names pid ${pid ?? 'none'}, not the chosen pid ${expectedPid ?? 'none'}; nothing was stopped.`)
  if (pid === null) return refuse(`cannot stop: this Conductor instance did not start the server on 127.0.0.1:${record.port} (no recorded pid), so it is left alone.`)
  if (!record.generation || !validIdentity(record.identity)) return refuse(`cannot stop pid ${pid}: its run record has no launch identity (an older or adopted record), so Conductor cannot prove the process is its own and left it alone. Stop it where it was started.`)
  const identity = record.identity
  note({ event: 'stop-requested', pid, generation: record.generation, identity })

  const probe = await withinBudget(deps.inspect(pid, left()), left())
  const first: ProcessProbe = 'value' in probe ? probe.value : { state: 'unknown', detail: 'timedOut' in probe ? 'process query timed out' : String((probe as { error: unknown }).error) }
  note({ event: 'inspect', pid, result: first })
  if (first.state === 'unknown') return uncertain(`Could not verify pid ${pid} (${first.detail}); nothing was stopped.`)
  let killed = false
  let reused = first.state === 'running' && !sameIdentity(first, identity)
  let exited = first.state === 'absent' || reused
  if (!exited) {
    const attempt = await withinBudget(deps.terminate(pid, identity, left()), left())
    const result: TerminateResult = 'value' in attempt ? attempt.value : { state: 'unknown', detail: 'timedOut' in attempt ? 'kill helper timed out' : String((attempt as { error: unknown }).error) }
    note({ event: 'terminate', pid, result })
    if (result.state === 'exited') { killed = true; exited = true }
    else if (result.state === 'absent' || result.state === 'mismatch') { exited = true; reused = result.state === 'mismatch' }
    // Signalled, or an uncertain helper that may have killed: either way only an observed exit counts.
    else killed = true
    while (!exited && left() > 0) {
      const again = await withinBudget(deps.inspect(pid, left()), left())
      const seen: ProcessProbe = 'value' in again ? again.value : { state: 'unknown', detail: 'process query timed out' }
      if (seen.state === 'absent' || (seen.state === 'running' && !sameIdentity(seen, identity))) { exited = true; note({ event: 'exit-observed', pid, result: seen }) }
      else if (left() > 0) await deps.sleep(Math.min(pollMs, left()))
    }
    if (!exited) return uncertain(`pid ${pid} (${record.model}) did not exit within ${Math.round((deadline - started) / 1000)} s${result.state === 'unknown' ? ` (${result.detail})` : ''}.`)
  }
  // An unanswered port probe counts as held: only an observed free port lets the record go.
  const held = async (): Promise<boolean> => { const probed = await withinBudget(deps.portInUse(record.port, Math.min(300, Math.max(1, left()))), left()); return 'value' in probed ? probed.value : true }
  let portHeld = await held()
  while (portHeld && left() > 0) {
    await deps.sleep(Math.min(pollMs, left()))
    portHeld = await held()
  }
  if (portHeld) return uncertain(`pid ${pid} exited, but 127.0.0.1:${record.port} is still answering, so something else holds it.`)
  if (sameRecord(deps.readRecord(), record)) deps.removeRecord()
  else note({ event: 'record-replaced', pid })
  note({ event: 'stopped', pid, killed })
  return killed
    ? { status: 'stopped', pid, killed, message: `stopped (pid ${pid})` }
    : { status: 'stopped', pid, killed, message: `not running (pid ${pid} had already exited${reused ? '; the pid now belongs to another process, left alone' : ''})` }
}

/** A child process run to completion inside a budget; on timeout only this child is killed. */
function runHelper(file: string, args: string[], env: NodeJS.ProcessEnv, budgetMs: number): Promise<{ code: number | null; stdout: string; error?: string; timedOut?: boolean }> {
  return new Promise(resolve => {
    let stdout = ''
    let settled = false
    const done = (value: { code: number | null; stdout: string; error?: string; timedOut?: boolean }): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env })
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } done({ code: null, stdout, timedOut: true }) }, Math.max(1, budgetMs))
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.on('error', error => done({ code: null, stdout, error: error.message }))
    child.on('close', code => done({ code, stdout }))
  })
}

/** Opens one handle to the process (which also keeps its pid from being reused while the script
 *  runs), reads creation time and image through it, and in terminate mode kills and waits on that
 *  same handle only when both still match. Inputs arrive in the environment, never the command. */
const WINDOWS_PROCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
function Say($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress)); exit 0 }
$id = [int]$env:CONDUCTOR_PROC_PID
try { $p = [System.Diagnostics.Process]::GetProcessById($id) } catch { if ($_.Exception.GetBaseException() -is [System.ArgumentException]) { Say @{ state = 'absent' } }; Say @{ state = 'unknown'; detail = 'lookup: ' + $_.Exception.GetBaseException().Message } }
try { $null = $p.Handle } catch { Say @{ state = 'unknown'; detail = 'open: ' + $_.Exception.GetBaseException().Message } }
try {
  if ($p.HasExited) { Say @{ state = 'absent' } }
  $created = $p.StartTime.ToFileTimeUtc().ToString()
  $exe = $p.MainModule.FileName
} catch { if ($p.HasExited) { Say @{ state = 'absent' } }; Say @{ state = 'unknown'; detail = 'identity: ' + $_.Exception.GetBaseException().Message } }
if ($env:CONDUCTOR_PROC_MODE -ne 'terminate') { Say @{ state = 'running'; creationTime = $created; executable = $exe } }
if ($created -ne $env:CONDUCTOR_PROC_CREATION -or $exe.ToLowerInvariant() -ne $env:CONDUCTOR_PROC_EXE.ToLowerInvariant()) { Say @{ state = 'mismatch'; creationTime = $created; executable = $exe } }
try { $p.Kill() } catch { if ($p.HasExited) { Say @{ state = 'exited' } }; Say @{ state = 'unknown'; detail = 'kill: ' + $_.Exception.GetBaseException().Message } }
if ($p.WaitForExit([int]$env:CONDUCTOR_PROC_WAIT_MS)) { Say @{ state = 'exited' } }
Say @{ state = 'signalled' }
`

function parseHelper(outcome: { code: number | null; stdout: string; error?: string; timedOut?: boolean }): Record<string, unknown> {
  if (outcome.timedOut) return { state: 'unknown', detail: 'process helper timed out' }
  if (outcome.error) return { state: 'unknown', detail: `process helper failed to start: ${outcome.error}` }
  if (outcome.code !== 0) return { state: 'unknown', detail: `process helper exited ${outcome.code}` }
  try { return JSON.parse(outcome.stdout.trim()) as Record<string, unknown> } catch { return { state: 'unknown', detail: 'process helper answered unreadably' } }
}

async function windowsProcess(mode: 'inspect' | 'terminate', pid: number, budgetMs: number, identity?: ProcessIdentity): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(WINDOWS_PROCESS_SCRIPT, 'utf16le').toString('base64')
  const env = { ...process.env, CONDUCTOR_PROC_MODE: mode, CONDUCTOR_PROC_PID: String(pid), CONDUCTOR_PROC_CREATION: identity?.creationTime ?? '', CONDUCTOR_PROC_EXE: identity?.executable ?? '', CONDUCTOR_PROC_WAIT_MS: String(Math.max(0, Math.min(5000, budgetMs - 2000))) }
  return parseHelper(await runHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], env, budgetMs))
}

/** POSIX: `ps` names start time (to the second) and image; the check and the signal are two steps,
 *  so a pid reused in between is a residual race here, unlike the handle-bound Windows path. */
async function posixInspect(pid: number, budgetMs: number): Promise<ProcessProbe> {
  const started = await runHelper('ps', ['-o', 'lstart=', '-p', String(pid)], process.env, budgetMs)
  if (started.timedOut || started.error) return { state: 'unknown', detail: started.error ?? 'ps timed out' }
  if (started.code !== 0 || !started.stdout.trim()) return started.code === 1 ? { state: 'absent' } : { state: 'unknown', detail: `ps exited ${started.code}` }
  let executable = ''
  try { executable = readlinkSync(`/proc/${pid}/exe`) } catch {
    const image = await runHelper('ps', ['-o', 'comm=', '-p', String(pid)], process.env, budgetMs)
    executable = image.code === 0 ? image.stdout.trim() : ''
  }
  return executable ? { state: 'running', creationTime: started.stdout.trim().replace(/\s+/g, ' '), executable } : { state: 'unknown', detail: 'image unreadable' }
}

export const processControl = {
  async inspect(pid: number, budgetMs: number): Promise<ProcessProbe> {
    if (process.platform !== 'win32') return posixInspect(pid, budgetMs)
    const answer = await windowsProcess('inspect', pid, budgetMs)
    if (answer.state === 'absent') return { state: 'absent' }
    if (answer.state === 'running' && typeof answer.creationTime === 'string' && typeof answer.executable === 'string') return { state: 'running', creationTime: answer.creationTime, executable: answer.executable }
    return { state: 'unknown', detail: String(answer.detail ?? 'unexpected process answer') }
  },
  async terminate(pid: number, identity: ProcessIdentity, budgetMs: number): Promise<TerminateResult> {
    if (process.platform !== 'win32') {
      const now = await posixInspect(pid, budgetMs)
      if (now.state !== 'running') return now
      if (!sameIdentity(now, identity)) return { state: 'mismatch', creationTime: now.creationTime, executable: now.executable }
      try { process.kill(pid, 'SIGTERM'); return { state: 'signalled' } } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return code === 'ESRCH' ? { state: 'absent' } : { state: 'unknown', detail: `kill: ${code ?? String(error)}` }
      }
    }
    const answer = await windowsProcess('terminate', pid, budgetMs, identity)
    if (answer.state === 'exited' || answer.state === 'signalled' || answer.state === 'absent') return { state: answer.state }
    if (answer.state === 'mismatch') return { state: 'mismatch', creationTime: String(answer.creationTime ?? ''), executable: String(answer.executable ?? '') }
    return { state: 'unknown', detail: String(answer.detail ?? 'unexpected process answer') }
  }
}

const stopJournal = (modelId: string): string => join(logsDir(), modelId.replace(/[^a-z0-9.-]/gi, '_') + '.stop.jsonl')

/** The run record file that names `model` with `pid`, if one still does. */
function recordFileFor(model: string, pid: number | null): string | null {
  for (const file of readdirSync(runDir()).filter(name => name.endsWith('.json'))) {
    try {
      const record = JSON.parse(readFileSync(join(runDir(), file), 'utf8')) as RunRecord
      if (record.model === model && record.pid === pid) return join(runDir(), file)
    } catch { /* An unreadable record is reported by the next admission pass, not hidden here. */ }
  }
  return null
}

function readRecordFile(path: string): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
    return Number.isInteger(record.port) && (record.pid === null || (Number.isInteger(record.pid) && record.pid > 0)) ? record : null
  } catch { return null }
}

export function defaultStopDeps(recordPath: string, modelId: string): StopDeps {
  return {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    readRecord: () => existsSync(recordPath) ? readRecordFile(recordPath) : null,
    removeRecord: () => rmSync(recordPath, { force: true }),
    inspect: processControl.inspect,
    terminate: processControl.terminate,
    portInUse,
    journal: entry => appendFileSync(stopJournal(modelId), JSON.stringify({ model: modelId, ...entry }) + '\n', 'utf8')
  }
}

/** Freed VRAM takes a moment to show up in nvidia-smi after a server exits; a start right after a
 *  switch would otherwise be refused for memory that is already free. */
async function waitForHeadroom(model: LocalModelConfig, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { assertResourceHeadroom(model); return } catch { await new Promise(resolve => setTimeout(resolve, 500)) }
  }
}

async function startAdmittedServer(executable: string, model: LocalModelConfig, apiKey: string, opts: StartOptions): Promise<StartOutcome> {
  const pollMs = opts.pollMs ?? 2000
  const timeoutMs = opts.timeoutMs ?? 300_000

  let existing: StartOutcome | null
  let switched = ''
  try { existing = await inspectAdmission(model, apiKey) }
  catch (error) {
    if (!(error instanceof AdmissionRefusal) || !opts.release) throw error
    switched = await makeRoom(model, error.running, opts.release)
    existing = await inspectAdmission(model, apiKey)
  }
  if (existing) return existing

  let port = model.port
  let moved = ''
  if (!(await portBindable(port))) {
    const adoption = await adoptRunningServer(model, apiKey, port)
    if (adoption.adopted) return adoption.adopted
    moved = adoption.reason
    port = await findFreePort(model)
  }

  const path = modelFilePath(model)
  if (!existsSync(path)) throw new Error(`Model file missing: ${path}`)
  if (switched) await waitForHeadroom(model)
  const features = model.kvCacheType || model.flashAttention ? await llamaServerFeatures(executable) : undefined
  // Budget the cache the server will actually get: a build without the cache-type flags runs f16.
  assertResourceHeadroom(model.kvCacheType && !(features?.cacheTypeK && features.cacheTypeV) ? { ...model, kvCacheType: undefined } : model)
  const log = openSync(logFile(model), 'a')
  // TEMP, caches and any model-cache variable point at the local root, so the server can never
  // stage large files on the system drive.
  const template = writeChatTemplate(model.id, join(dirname(configPath()), 'templates'))
  const child = spawn(executable, llamaServerArgs({ ...model, port }, apiKey, path, features, template), { shell: false, windowsHide: true, detached: true, stdio: ['ignore', log, log], env: childEnvironment() })
  closeSync(log)
  let spawnError = ''
  child.on('error', error => { spawnError = error.message })
  child.unref()
  if (!child.pid) throw new Error('llama.cpp server failed to start')
  // A model server's CPU threads (a MoE model's experts run there) yield to the owner's own window:
  // a busy soak at normal priority tripled typing latency (docs/perf/typing-under-load.md).
  lowerSpawned(child.pid)
  // Node holds the child's handle until it exits, so this pid cannot be reused while its identity is
  // read: the identity recorded here is the one every later stop must find again.
  const identity = await processControl.inspect(child.pid, 15_000)
  if (identity.state !== 'running') {
    if (identity.state === 'absent' || spawnError) throw new Error(spawnError || describeStartupFailure(model, port))
    child.kill() // our own child, through Node's handle: never a pid lookup
    throw new Error(`llama.cpp started as pid ${child.pid} but its process identity could not be read (${identity.detail}), so it was stopped rather than left running unstoppable`)
  }
  writeFileSync(runFile(model), JSON.stringify({ pid: child.pid, port, model: model.id, file: model.file, startedAt: new Date().toISOString(), generation: randomBytes(12).toString('hex'), identity: { creationTime: identity.creationTime, executable: identity.executable } } satisfies RunRecord, null, 2), 'utf8')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (spawnError || !processAlive(child.pid)) throw new Error(spawnError || describeStartupFailure(model, port))
    if ((await health(port, apiKey)).ok) return { started: true, pid: child.pid, port, message: [moved ? `healthy on 127.0.0.1:${port}; ${moved}` : 'healthy', switched].filter(Boolean).join('; ') }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  throw new Error(`Server health check failed: ${model.id} did not answer on 127.0.0.1:${port} within 5 minutes`)
}

/** Stop the server this stack started for `model`, through the one verified path above. Resolves
 *  only when the process is gone ('stopped (pid N)', or 'not running' variants); a refusal or an
 *  unconfirmed stop throws with the reason, so no caller can report it as success. `expectedPid`
 *  is the pid the caller chose; a record that names another by now is refused. The admission lock
 *  keeps a start from writing a new record mid-stop; waiting for it counts against the deadline. */
export async function stopServer(model: LocalModelConfig, { expectedPid, deps }: { expectedPid?: number | null; deps?: StopDeps } = {}): Promise<string> {
  const started = Date.now()
  const run = (): Promise<StopOutcome> => stopOwnedServer(deps ?? { ...defaultStopDeps(runFile(model), model.id), deadlineMs: STOP_DEADLINE_MS - (Date.now() - started) }, { expectedPid })
  const outcome = deps ? await run() : await withAdmissionLock(run, STOP_DEADLINE_MS / 2)
  if (outcome.status === 'stopped' || outcome.status === 'not-running') return outcome.message
  throw new Error(outcome.message)
}

export interface ServerStatus { model: string; port: number; pid: number | null; running: boolean; healthy: boolean; keyEnforced: boolean; detail?: string }

export async function serverStatus(model: LocalModelConfig, apiKey: string): Promise<ServerStatus> {
  const record = readRunRecord(model)
  const port = record?.port ?? model.port
  if (!record) return { model: model.id, port, pid: null, running: false, healthy: false, keyEnforced: false, detail: 'not running' }
  const pidAlive = processAlive(record.pid)
  // A record with pid: null names a server we adopted rather than started: there is no pid to
  // check, so a healthy port is the only evidence of "running" we can have.
  const probe = (pidAlive || record.pid === null) ? await health(port, apiKey) : { ok: false, status: 0, detail: 'not running' }
  const running = record.pid === null ? probe.ok : pidAlive
  return { model: model.id, port, pid: record.pid, running, healthy: probe.ok, keyEnforced: probe.ok ? await rejectsAnonymous(port) : false, detail: probe.detail }
}
