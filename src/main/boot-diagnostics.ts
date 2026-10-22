import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { Worker } from 'node:worker_threads'

/* Startup diagnostics, the "car diagnostics" of a launch (docs/startup-diagnostics.md). Every boot
 * stage is written to <userData>/diagnostics/boot.json synchronously the moment it begins, so a
 * process that dies inside a stage (a V8 out-of-memory abort runs no JavaScript to say so) has
 * already named it. The recovery watchdog and the meta-wizard read it and turn a failed start into
 * one line: where it died and why. On 2026-10-22 every launch died four seconds in and all anyone
 * outside the app could say was "exited with code 4294930435". */

export const DIAGNOSTICS_DIRECTORY = 'diagnostics'
export const BOOT_FILE = 'boot.json'
export const BOOT_SAMPLE_FILE = 'boot-sample.json'
export const BOOT_HISTORY_FILE = 'boot-history.jsonl'
export const BOOT_LAST_FAILURE_FILE = 'boot-last-failure.json'

/** In boot order. A stage is recorded when it begins. */
export const BOOT_STAGES = [
  'process-start', 'single-instance', 'app-ready', 'db-open', 'db-migrations', 'structured-store', 'settings',
  'services', 'control-api', 'control-ready', 'runtime-reattach', 'runtime-host', 'windows', 'ready'
] as const
export type BootStage = typeof BOOT_STAGES[number]

const MAX_STAGES = 40
const MAX_ERRORS = 5
const MAX_MESSAGE = 500
const HISTORY_TRIM_AT = 100
const HISTORY_KEEP = 50
const SAMPLE_INTERVAL_MS = 500
const BEAT_INTERVAL_MS = 250
/** The sampler keeps writing this long after ready, and never longer than the cap. */
const SAMPLE_AFTER_READY_MS = 30_000
const SAMPLE_MAX_MS = 5 * 60_000

export interface BootStageEntry { name: string; at: string; ms: number; heapMb: number; rssMb: number }
export interface BootError { at: string; stage: string; kind: string; message: string }
export interface BootFatal extends BootError { heapMb: number; rssMb: number }
export interface BootRecord {
  schema: 1
  pid: number
  version: string
  packaged: boolean
  exe: string
  startedAt: string
  heapLimitMb: number
  stage: string
  stageAt: string
  outcome: 'booting' | 'ready' | 'failed'
  readyMs: number | null
  stages: BootStageEntry[]
  peak: { heapMb: number; rssMb: number }
  errors: BootError[]
  fatal: BootFatal | null
}
export interface BootSample { schema: 1; pid: number; at: string; ms: number; rssMb: number; heapMb: number; mainBeatAgoMs: number; stage: string | null }
export interface BootHistoryLine { pid: number; version: string; startedAt: string; outcome: 'ready' | 'died'; stage: string; ms: number; peakHeapMb: number; cause: string | null }

export interface BootMemory { heapMb: number; rssMb: number; heapLimitMb: number }

export interface BootDiagnosticsOptions {
  directory: string
  pid: number
  version: string
  packaged: boolean
  exe: string
  /** Epoch ms the process started (performance.timeOrigin). */
  startedAtMs: number
  now?: () => number
  memory?: () => BootMemory
  isAlive?: (pid: number) => boolean
  /** The worker that keeps writing while the main thread is stuck. Off in unit tests. */
  sampler?: boolean
  /** Where uncaught errors and exit are observed; null in unit tests that drive them directly. */
  processHooks?: Pick<NodeJS.Process, 'on'> | null
}

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024)
const clip = (text: string): string => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}…` : line }
const defaultMemory = (): BootMemory => {
  const usage = process.memoryUsage()
  return { heapMb: mb(usage.heapUsed), rssMb: mb(usage.rss), heapLimitMb: mb(getHeapStatistics().heap_size_limit) }
}
const defaultAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null } }

/**
 * Shared with the sampler worker, so it can report the main thread's heap, stage and heartbeat
 * while the main thread itself is blocked: [beat epoch ms, heap MB, stage index, stop flag].
 */
const SHARED_SLOTS = 4

/** The sampler, run as an eval worker so it needs no bundle entry of its own. */
const SAMPLER_SOURCE = `
const { workerData } = require('node:worker_threads')
const { writeFileSync, renameSync } = require('node:fs')
const shared = new Float64Array(workerData.buffer)
const started = Date.now()
const write = () => {
  const now = Date.now()
  const index = shared[2]
  const sample = { schema: 1, pid: workerData.pid, at: new Date(now).toISOString(), ms: Math.round(now - workerData.startedAtMs),
    rssMb: Math.round(process.memoryUsage.rss() / 1048576), heapMb: Math.round(shared[1]), mainBeatAgoMs: Math.max(0, Math.round(now - shared[0])),
    stage: index >= 0 && index < workerData.stages.length ? workerData.stages[index] : null }
  try { writeFileSync(workerData.path + '.tmp', JSON.stringify(sample)); renameSync(workerData.path + '.tmp', workerData.path) } catch {}
}
const timer = setInterval(() => {
  if (shared[3] === 1 || Date.now() - started > workerData.maxMs) { clearInterval(timer); write(); return }
  write()
}, workerData.intervalMs)
write()
`

export class BootDiagnostics {
  private readonly now: () => number
  private readonly memory: () => BootMemory
  private readonly path: string
  private readonly record: BootRecord
  private readonly shared = new Float64Array(new SharedArrayBuffer(SHARED_SLOTS * Float64Array.BYTES_PER_ELEMENT))
  private beat: ReturnType<typeof setInterval> | null = null
  private sampler: Worker | null = null
  private controlReady = false
  private restoreExit: (() => void) | null = null
  private windowLoaded = false

  constructor(private readonly options: BootDiagnosticsOptions) {
    this.now = options.now ?? Date.now
    this.memory = options.memory ?? defaultMemory
    this.path = join(options.directory, BOOT_FILE)
    const memory = this.memory()
    const startedAt = new Date(options.startedAtMs).toISOString()
    this.record = {
      schema: 1, pid: options.pid, version: options.version, packaged: options.packaged, exe: options.exe, startedAt,
      heapLimitMb: memory.heapLimitMb, stage: 'process-start', stageAt: startedAt, outcome: 'booting', readyMs: null,
      stages: [{ name: 'process-start', at: startedAt, ms: 0, heapMb: memory.heapMb, rssMb: memory.rssMb }],
      peak: { heapMb: memory.heapMb, rssMb: memory.rssMb }, errors: [], fatal: null
    }
  }

  /** Files the previous launch's record if it never became ready, then writes this one. */
  start(): this {
    try {
      mkdirSync(this.options.directory, { recursive: true })
      this.fileUnfinishedPrevious()
    } catch { /* diagnostics never stop a launch */ }
    this.stage('single-instance')
    this.options.processHooks?.on('uncaughtException', error => this.error('uncaughtException', error))
    this.options.processHooks?.on('unhandledRejection', reason => this.error('unhandledRejection', reason))
    this.options.processHooks?.on('exit', code => this.exit(code))
    // Electron does not emit 'exit' for a process.exit() in the main process: wrapped while booting.
    if (this.options.processHooks === process) {
      const exit = process.exit.bind(process)
      this.restoreExit = () => { process.exit = exit }
      process.exit = ((code?: number | string | null) => { this.exit(Number(code ?? process.exitCode ?? 0)); return exit(code as number) }) as typeof process.exit
    }
    if (this.options.sampler) this.startSampler()
    return this
  }

  /** The record as written. */
  snapshot(): BootRecord { return structuredClone(this.record) }

  stage(name: string): void {
    if (this.record.outcome !== 'booting') return
    const at = this.now()
    const memory = this.memory()
    const entry: BootStageEntry = { name, at: new Date(at).toISOString(), ms: Math.max(0, Math.round(at - this.options.startedAtMs)), heapMb: memory.heapMb, rssMb: memory.rssMb }
    if (this.record.stages.length < MAX_STAGES) this.record.stages.push(entry)
    else this.record.stages[MAX_STAGES - 1] = entry
    this.record.stage = name
    this.record.stageAt = entry.at
    this.peak(memory)
    this.publish(name, memory.heapMb, at)
    this.write()
  }

  /** App control answers: half of ready (the other half is a window that finished loading). */
  markControlReady(): void { this.controlReady = true; this.stage('control-ready'); this.maybeReady() }
  markWindowLoaded(): void { this.windowLoaded = true; this.maybeReady() }

  error(kind: string, error: unknown): void {
    if (this.record.outcome !== 'booting') return
    const message = clip(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    const entry: BootError = { at: new Date(this.now()).toISOString(), stage: this.record.stage, kind, message }
    if (this.record.errors.length < MAX_ERRORS) this.record.errors.push(entry)
    else this.record.errors[MAX_ERRORS - 1] = entry
    this.write()
  }

  /** The process is ending before it was ready. */
  exit(code: number): void {
    if (this.record.outcome !== 'booting') return
    const memory = this.memory()
    this.record.fatal = { at: new Date(this.now()).toISOString(), stage: this.record.stage, kind: 'exit', message: `exit code ${code}`, heapMb: memory.heapMb, rssMb: memory.rssMb }
    this.record.outcome = 'failed'
    this.write()
    this.stopSampler()
  }

  dispose(): void { this.stopTimers(); this.stopSampler() }

  private maybeReady(): void {
    if (!this.controlReady || !this.windowLoaded || this.record.outcome !== 'booting') return
    this.stage('ready')
    this.record.outcome = 'ready'
    this.record.readyMs = this.record.stages.at(-1)!.ms
    this.write()
    this.appendHistory({ pid: this.record.pid, version: this.record.version, startedAt: this.record.startedAt, outcome: 'ready', stage: 'ready', ms: this.record.readyMs, peakHeapMb: this.record.peak.heapMb, cause: null })
    this.stopTimers()
    // The sampler sees the first half minute after ready too: a launch that dies in its first
    // background passes still leaves a trace.
    const stop = setTimeout(() => this.stopSampler(), SAMPLE_AFTER_READY_MS)
    stop.unref?.()
  }

  private fileUnfinishedPrevious(): void {
    const previous = readJson<BootRecord>(this.path)
    if (!previous || previous.schema !== 1 || previous.pid === this.options.pid || previous.outcome === 'ready') return
    if (previous.outcome === 'booting' && (this.options.isAlive ?? defaultAlive)(previous.pid)) return
    const sample = readJson<BootSample>(join(this.options.directory, BOOT_SAMPLE_FILE))
    const lastSample = sample?.pid === previous.pid ? sample : null
    const failure = { ...previous, filedAt: new Date(this.now()).toISOString(), lastSample }
    writeAtomic(join(this.options.directory, BOOT_LAST_FAILURE_FILE), JSON.stringify(failure, null, 2))
    const heapMb = Math.max(previous.peak?.heapMb ?? 0, lastSample?.heapMb ?? 0)
    const cause = previous.fatal?.kind ?? (previous.heapLimitMb && heapMb >= previous.heapLimitMb * 0.9 ? 'oom' : previous.errors?.length ? 'exception' : null)
    const ms = Math.max(previous.stages?.at(-1)?.ms ?? 0, lastSample?.ms ?? 0)
    this.appendHistory({ pid: previous.pid, version: previous.version, startedAt: previous.startedAt, outcome: 'died', stage: previous.stage, ms, peakHeapMb: heapMb, cause })
  }

  private appendHistory(line: BootHistoryLine): void {
    const path = join(this.options.directory, BOOT_HISTORY_FILE)
    try {
      appendFileSync(path, `${JSON.stringify(line)}\n`)
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      if (lines.length > HISTORY_TRIM_AT) writeAtomic(path, `${lines.slice(-HISTORY_KEEP).join('\n')}\n`)
    } catch { /* diagnostics never stop a launch */ }
  }

  private peak(memory: BootMemory): void {
    this.record.peak = { heapMb: Math.max(this.record.peak.heapMb, memory.heapMb), rssMb: Math.max(this.record.peak.rssMb, memory.rssMb) }
  }

  private publish(stage: string, heapMb: number, at: number): void {
    this.shared[0] = at
    this.shared[1] = heapMb
    this.shared[2] = (BOOT_STAGES as readonly string[]).indexOf(stage)
  }

  private write(): void {
    try { writeAtomic(this.path, JSON.stringify(this.record, null, 2)) } catch { /* diagnostics never stop a launch */ }
  }

  private startSampler(): void {
    try {
      this.publish(this.record.stage, this.record.peak.heapMb, this.now())
      this.sampler = new Worker(SAMPLER_SOURCE, {
        eval: true,
        workerData: { buffer: this.shared.buffer, pid: this.options.pid, startedAtMs: this.options.startedAtMs, path: join(this.options.directory, BOOT_SAMPLE_FILE), stages: BOOT_STAGES, intervalMs: SAMPLE_INTERVAL_MS, maxMs: SAMPLE_MAX_MS }
      })
      this.sampler.on('error', () => { this.sampler = null })
      this.sampler.unref()
      // The heartbeat: while the main thread runs its event loop, the sampler sees a fresh beat
      // and the current heap; a beat that ages says the main thread is stuck in one call.
      this.beat = setInterval(() => {
        const memory = this.memory()
        this.peak(memory)
        this.shared[0] = this.now()
        this.shared[1] = memory.heapMb
      }, BEAT_INTERVAL_MS)
      this.beat.unref?.()
    } catch { this.sampler = null }
  }

  private stopTimers(): void {
    if (this.beat) clearInterval(this.beat)
    this.beat = null
    this.restoreExit?.()
    this.restoreExit = null
  }
  private stopSampler(): void {
    this.shared[3] = 1
    this.stopTimers()
    const sampler = this.sampler
    this.sampler = null
    if (sampler) void sampler.terminate().catch(() => {})
  }
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
}

let active: BootDiagnostics | null = null

/** Starts this launch's record. Only a launch that holds the single-instance lock calls it. */
export function startBootDiagnostics(options: BootDiagnosticsOptions): BootDiagnostics {
  active?.dispose()
  active = new BootDiagnostics(options).start()
  return active
}

/**
 * Marks the start of a boot stage. A no-op before startBootDiagnostics (a unit test constructing the
 * database, a second instance). Test profiles may make a stage fail on purpose (below).
 */
export function bootStage(name: BootStage): void {
  active?.stage(name)
  testBootFailure(name)
}
export const bootControlReady = (): void => { active?.markControlReady() }
export const bootWindowLoaded = (): void => { active?.markWindowLoaded() }

/**
 * Test profiles only: `CONDUCTOR_TEST_BOOT_FAIL=<stage>:<kind>`, or the same text in the file
 * `CONDUCTOR_TEST_BOOT_FAIL_FILE` names (read at each stage, so a smoke "repairs" the app by deleting
 * it). Kinds: throw, exit (code 70), hang (the main thread blocks), oom (allocate until V8 aborts).
 */
export function bootFailureRequest(env: NodeJS.ProcessEnv, readFile: (path: string) => string | null = path => { try { return readFileSync(path, 'utf8') } catch { return null } }): { stage: string; kind: 'throw' | 'exit' | 'hang' | 'oom' } | null {
  if (!env.CONDUCTOR_TEST_USER_DATA) return null
  const raw = env.CONDUCTOR_TEST_BOOT_FAIL ?? (env.CONDUCTOR_TEST_BOOT_FAIL_FILE ? readFile(env.CONDUCTOR_TEST_BOOT_FAIL_FILE) : null)
  const match = /^\s*([a-z-]+):(throw|exit|hang|oom)\s*$/.exec(raw ?? '')
  return match ? { stage: match[1]!, kind: match[2] as 'throw' | 'exit' | 'hang' | 'oom' } : null
}

function testBootFailure(stage: string): void {
  const request = bootFailureRequest(process.env)
  if (!request || request.stage !== stage) return
  console.log(`[test] boot failure in stage ${stage}: ${request.kind}`)
  if (request.kind === 'throw') throw new Error(`[test] boot failure in stage ${stage}`)
  if (request.kind === 'exit') process.exit(70)
  if (request.kind === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * 60_000)
  if (request.kind === 'oom') {
    const hog: number[][] = []
    for (;;) hog.push(new Array<number>(1 << 20).fill(hog.length + 0.5))
  }
}
