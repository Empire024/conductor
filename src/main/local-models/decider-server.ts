import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lowerSpawned } from '../background-priority'
import { portBindable, processAlive } from './llama'

/**
 * The decision model's own server (docs/model-routing.md, "CPU decider"): Laya typed-decisions, a
 * 421M ModernBERT-large classifier that answers a typed choice with calibrated probabilities in one
 * forward pass. It is not a llama.cpp server and never touches the GPU: `laya-serve` runs from its
 * own Python venv under the local root, pinned to CPU, LAYA_THREADS threads, loopback only, behind
 * the local stack's API key, offline (the pinned checkpoint was downloaded once, with the owner's
 * approval, and its SHA-256 is checked at every load). One per machine: it is started lazily on the
 * first decision and kept warm; another Conductor on this machine adopts it through the run record,
 * and only the Conductor that started it stops it when it quits.
 *
 * Nothing here is part of llama.cpp admission: the run record lives under <root>/decider, not the
 * runtime folder `inspectAdmission` reads, and the process is python, not llama-server.
 */

export const DECIDER_MODEL = 'decider/laya-typed-decisions'
export const DECIDER_LABEL = 'Decision model: Laya typed-decisions (CPU, shadow)'
export const LAYA_REPO = 'convaiinnovations/laya'
export const LAYA_SUBFOLDER = 'typed-decisions'
/** The reviewed commit of LAYA_REPO; laya 0.3.21's own PINNED_REVISIONS names the same one. */
export const LAYA_REVISION = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851'
/** typed-decisions/model.safetensors at LAYA_REVISION (Hugging Face LFS oid, 842,609,220 bytes). */
export const LAYA_WEIGHTS_SHA256 = '4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e'
export const DECIDER_PORT = 51440
/** CPU threads for inference: MAIN has 24, shared with smokes, builds and the owner's desktop. */
export const DECIDER_THREADS = 4
const START_TIMEOUT_MS = 180_000
const HEALTH_TIMEOUT_MS = 2_000

export interface DeciderPaths { dir: string; python: string; hfHome: string; runFile: string; log: string }
export const deciderPaths = (root: string): DeciderPaths => {
  const dir = join(root, 'decider')
  return { dir, python: join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), hfHome: join(dir, 'hf'), runFile: join(dir, 'run.json'), log: join(dir, 'laya-serve.log') }
}

/** Whether the venv and the pinned checkpoint are on disk; the reason names what is missing. */
export function deciderInstalled(paths: DeciderPaths, exists: (path: string) => boolean = existsSync, list: (path: string) => string[] = readdirSync): { installed: boolean; reason?: string } {
  if (!exists(paths.python)) return { installed: false, reason: `the decider venv is not set up (${paths.python}); run scripts/local-models/setup-decider.ps1` }
  const snapshot = join(paths.hfHome, 'hub', `models--${LAYA_REPO.replace('/', '--')}`, 'snapshots', LAYA_REVISION, LAYA_SUBFOLDER)
  let files: string[] = []
  try { files = list(snapshot) } catch { /* absent */ }
  if (!files.includes('model.safetensors')) return { installed: false, reason: `the pinned Laya checkpoint is not downloaded (${snapshot}); run scripts/local-models/setup-decider.ps1` }
  return { installed: true }
}

/** The sidecar's environment: CPU only, bounded threads, loopback, keyed, offline, pinned. */
export function deciderEnvironment(paths: DeciderPaths, port: number, apiKey: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const threads = String(DECIDER_THREADS)
  // Only what Python and Windows need from the parent: no provider tokens reach the sidecar.
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'HOME', 'LANG']
  const env: NodeJS.ProcessEnv = Object.fromEntries(keep.filter(name => base[name] !== undefined).map(name => [name, base[name]]))
  return {
    ...env,
    LAYA_HOST: '127.0.0.1', LAYA_PORT: String(port), LAYA_API_KEY: apiKey,
    LAYA_DEVICE: 'cpu', CUDA_VISIBLE_DEVICES: '', LAYA_MODELS: LAYA_SUBFOLDER, LAYA_PRELOAD: '1', LAYA_MAX_LOADED: '1', LAYA_AUTO_TASK: '0',
    LAYA_THREADS: threads, OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads, LAYA_MAX_CONCURRENT: '4', LAYA_LOG_LEVEL: 'warning',
    LAYA_REVISION, LAYA_SHA256_DIGESTS: JSON.stringify({ 'model.safetensors': LAYA_WEIGHTS_SHA256 }),
    HF_HOME: paths.hfHome, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', USE_TF: '0', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1'
  }
}

/** The sidecar's run record: which process, where, and which Conductor started it. */
export interface DeciderRunRecord { pid: number; port: number; startedAt: string; ownerPid: number }

export interface DeciderServerEntry {
  model: string; label: string; pid: number | null; port: number | null; startedAt: string | null; startedByConductor: boolean
  role: 'decider'; device: 'cpu'; threads: number; gpu: false; state: 'running' | 'starting' | 'stopped' | 'not-installed'; detail?: string
}

/** One typed choice, as laya-serve answers it (Jev /v1/systemone shape). */
export interface LayaChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface LayaResult { answers: Record<string, LayaChoiceAnswer | Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number }; model?: string; inferenceMs?: number }

export interface DeciderServerDeps {
  paths: DeciderPaths
  apiKey(): string
  log(message: string, error?: unknown): void
  spawn?: typeof nodeSpawn
  fetch?: typeof fetch
  now?(): number
  alive?(pid: number): boolean
  bindable?(port: number): Promise<boolean>
  kill?(pid: number): void
  /** This Conductor's own pid, recorded as the sidecar's owner. */
  selfPid?: number
}

export class DeciderServer {
  private starting: Promise<DeciderRunRecord> | null = null
  private child: ChildProcess | null = null
  private lastError: string | null = null
  constructor(private deps: DeciderServerDeps) {}

  installed(): { installed: boolean; reason?: string } { return deciderInstalled(this.deps.paths) }

  private record(): DeciderRunRecord | null {
    try {
      const value = JSON.parse(readFileSync(this.deps.paths.runFile, 'utf8')) as DeciderRunRecord
      return Number.isInteger(value.pid) && value.pid > 0 && Number.isInteger(value.port) && value.port > 0 ? value : null
    } catch { return null }
  }
  private alive(pid: number): boolean { return (this.deps.alive ?? processAlive)(pid) }

  /** What local.servers shows for it: running, starting, stopped or not installed. Synchronous. */
  status(): DeciderServerEntry {
    const base = { model: DECIDER_MODEL, label: DECIDER_LABEL, role: 'decider' as const, device: 'cpu' as const, threads: DECIDER_THREADS, gpu: false as const }
    const record = this.record()
    if (record && this.alive(record.pid)) return { ...base, pid: record.pid, port: record.port, startedAt: record.startedAt, startedByConductor: true, state: this.starting ? 'starting' : 'running' }
    const installed = this.installed()
    if (!installed.installed) return { ...base, pid: null, port: null, startedAt: null, startedByConductor: false, state: 'not-installed', detail: installed.reason! }
    return { ...base, pid: null, port: null, startedAt: null, startedByConductor: false, state: 'stopped', detail: this.lastError ?? 'started on the first decision' }
  }

  private async healthy(port: number): Promise<boolean> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    try {
      const response = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
      if (!response.ok) return false
      const body = await response.json() as { loaded?: unknown }
      return Array.isArray(body.loaded) && body.loaded.includes(LAYA_SUBFOLDER)
    } catch { return false } finally { clearTimeout(timer) }
  }

  /** The running sidecar, started when none is: one start at a time, adopted when another Conductor's is up. */
  ensure(): Promise<DeciderRunRecord> {
    if (this.starting) return this.starting
    const work = (async () => {
      const record = this.record()
      if (record && this.alive(record.pid) && await this.healthy(record.port)) return record
      if (record && this.alive(record.pid)) {
        // Another Conductor may be starting it right now: wait for it rather than start a second one.
        const until = (this.deps.now ?? Date.now)() + START_TIMEOUT_MS
        while ((this.deps.now ?? Date.now)() < until && this.alive(record.pid)) {
          if (await this.healthy(record.port)) return record
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        if (this.alive(record.pid)) throw new Error(`the decider (pid ${record.pid}) did not become healthy on 127.0.0.1:${record.port}`)
      }
      return await this.start()
    })()
    this.starting = work
    void work.then(() => { this.lastError = null }, error => { this.lastError = error instanceof Error ? error.message : String(error) }).finally(() => { if (this.starting === work) this.starting = null })
    return work
  }

  private async start(): Promise<DeciderRunRecord> {
    const installed = this.installed()
    if (!installed.installed) throw new Error(`decider unavailable: ${installed.reason}`)
    const { paths } = this.deps
    mkdirSync(paths.dir, { recursive: true })
    let port = DECIDER_PORT
    const bindable = this.deps.bindable ?? portBindable
    for (let offset = 0; offset <= 20 && !(await bindable(port)); offset++) port = DECIDER_PORT + offset + 1
    const log = openSync(paths.log, 'a')
    const child = (this.deps.spawn ?? nodeSpawn)(paths.python, ['-m', 'laya.serve'], { cwd: paths.dir, env: deciderEnvironment(paths, port, this.deps.apiKey()), shell: false, windowsHide: true, detached: false, stdio: ['ignore', log, log] })
    closeSync(log)
    let spawnError = ''
    child.on('error', error => { spawnError = error.message })
    if (!child.pid) throw new Error(`the decider did not start${spawnError ? `: ${spawnError}` : ''}`)
    this.child = child
    child.once('exit', () => { if (this.child === child) this.child = null })
    // Its CPU threads yield to the owner's window, as a llama.cpp server's do.
    lowerSpawned(child.pid)
    const record: DeciderRunRecord = { pid: child.pid, port, startedAt: new Date((this.deps.now ?? Date.now)()).toISOString(), ownerPid: this.deps.selfPid ?? process.pid }
    writeFileSync(paths.runFile, JSON.stringify(record, null, 2), 'utf8')
    const until = (this.deps.now ?? Date.now)() + START_TIMEOUT_MS
    while ((this.deps.now ?? Date.now)() < until) {
      if (spawnError || child.exitCode !== null) { this.forget(record); throw new Error(`the decider exited during startup${spawnError ? `: ${spawnError}` : ''}; see ${paths.log}`) }
      if (await this.healthy(port)) { this.deps.log(`decider started on 127.0.0.1:${port} (pid ${child.pid}, CPU, ${DECIDER_THREADS} threads)`); return record }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    this.kill(record.pid)
    this.forget(record)
    throw new Error(`the decider did not become healthy within ${START_TIMEOUT_MS / 1000} s; see ${paths.log}`)
  }

  private forget(record: DeciderRunRecord): void {
    const current = this.record()
    if (current && current.pid === record.pid) rmSync(this.deps.paths.runFile, { force: true })
  }
  private kill(pid: number): void {
    try { (this.deps.kill ?? (target => process.kill(target)))(pid) } catch { /* already gone */ }
  }

  /** One typed decision: POST /v1/systemone on the typed-decisions checkpoint, bounded by `timeoutMs`. */
  async predict(state: Record<string, unknown>, questions: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LayaResult> {
    const record = await this.ensure()
    const controller = new AbortController(), abort = (): void => controller.abort()
    const timer = setTimeout(abort, options.timeoutMs ?? 20_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${record.port}/v1/systemone`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.deps.apiKey()}` },
        body: JSON.stringify({ model: LAYA_SUBFOLDER, state, questions })
      })
      if (!response.ok) throw new Error(`the decider answered HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`)
      const inference = Number(response.headers.get('x-inference-time-ms'))
      const body = await response.json() as LayaResult
      return { ...body, ...(Number.isFinite(inference) ? { inferenceMs: inference } : {}) }
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) throw new Error(`the decider did not answer within ${Math.round((options.timeoutMs ?? 20_000) / 1000)} s`)
      throw error
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
  }

  /** local.stop on the decider: it stops, and the next decision starts it again. */
  async stop(): Promise<string> {
    const record = this.record()
    if (!record || !this.alive(record.pid)) { if (record) this.forget(record); return 'the decider is not running' }
    this.kill(record.pid)
    const until = (this.deps.now ?? Date.now)() + 10_000
    while (this.alive(record.pid) && (this.deps.now ?? Date.now)() < until) await new Promise(resolve => setTimeout(resolve, 200))
    if (this.alive(record.pid)) throw new Error(`the decider (pid ${record.pid}) did not exit within 10 s`)
    this.forget(record)
    return `stopped the decider (pid ${record.pid}); the next decision starts it again`
  }

  /** App quit: only the Conductor that started the sidecar stops it; another one keeps using it. */
  dispose(): void {
    const record = this.record()
    if (!record || record.ownerPid !== (this.deps.selfPid ?? process.pid)) return
    this.kill(record.pid)
    this.forget(record)
  }
}
