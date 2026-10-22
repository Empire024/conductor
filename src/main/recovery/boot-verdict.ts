import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOOT_FILE, BOOT_HISTORY_FILE, BOOT_LAST_FAILURE_FILE, BOOT_SAMPLE_FILE, DIAGNOSTICS_DIRECTORY, type BootHistoryLine, type BootRecord, type BootSample } from '../boot-diagnostics'

/* One line about how a launch went, from its boot record (docs/startup-diagnostics.md). Pure, and
 * mirrored line for line by scripts/meta-wizard/boot.mjs (the meta-wizard runs outside the app and
 * cannot import this); both pass scripts/meta-wizard/boot-verdict-cases.json. */

export type BootState = 'ready' | 'booting' | 'stalled' | 'died' | 'unknown'
export type BootCause = 'oom' | 'exception' | 'exit' | 'hang' | 'crash'
export interface BootVerdict { state: BootState; stage: string | null; cause: BootCause | null; signature: string; line: string; version: string | null; pid: number | null }
export interface BootVerdictInput {
  record: BootRecord | null
  sample?: BootSample | null
  /** The launch's pid when the caller knows it; the record must be that launch's. */
  pid?: number | null
  alive: boolean
  exitCode?: number | null
  /** The launch's stdout/stderr tail, when captured. */
  log?: string
  now: number
}

/** A stage unchanged this long in a live, unready process is a hang. */
export const STALL_MS = 120_000
const OOM_TEXT = /JavaScript heap out of memory|OOM error in V8|Fatal JavaScript invalid size error|Ineffective mark-compacts near heap limit/i
/** Exit codes seen for a V8 out-of-memory abort of the Windows app (2026-10-22 launch logs). */
const OOM_EXIT_CODES = new Set([3758096392, -536870904, 4294930435, -36861])

const seconds = (ms: number): string => ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`
const size = (megabytes: number): string => megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`

export function bootVerdict(input: BootVerdictInput): BootVerdict {
  const { record, alive, now } = input
  const exitCode = input.exitCode ?? null
  const log = input.log ?? ''
  const sample = input.sample && record && input.sample.pid === record.pid ? input.sample : null
  const pid = record?.pid ?? input.pid ?? null
  const who = record ? `Conductor ${record.version || 'unknown version'}, pid ${record.pid}` : pid ? `pid ${pid}` : 'Conductor'
  const result = (state: BootState, stage: string | null, cause: BootCause | null, line: string): BootVerdict =>
    ({ state, stage, cause, signature: `${state}:${stage ?? 'none'}:${cause ?? 'none'}`, line, version: record?.version ?? null, pid })
  const exited = exitCode === null ? '' : `exit code ${exitCode}`
  const oomSeen = OOM_TEXT.test(log) || (exitCode !== null && OOM_EXIT_CODES.has(exitCode))

  if (!record) {
    if (alive) return result('unknown', null, null, `${who} runs but has written no boot diagnostics (a build without them, or it has not reached the single-instance lock)`)
    const why = oomSeen ? `V8 heap out of memory${exited ? ` (${exited})` : ''}` : exited ? `exited with ${exited}` : 'it ended'
    return result('unknown', null, oomSeen ? 'oom' : exitCode === null ? null : 'crash', `died before writing boot diagnostics (before the single-instance lock, or a build without them): ${why}`)
  }

  const started = Date.parse(record.startedAt)
  const lastMs = Math.max(record.stages.at(-1)?.ms ?? 0, sample?.ms ?? 0)
  const heapMb = Math.max(record.peak?.heapMb ?? 0, sample?.heapMb ?? 0)
  const rssMb = Math.max(record.peak?.rssMb ?? 0, sample?.rssMb ?? 0)
  const nearLimit = record.heapLimitMb > 0 && heapMb >= record.heapLimitMb * 0.9
  const memory = `heap ${size(heapMb)} of a ${size(record.heapLimitMb)} limit, RSS ${size(rssMb)}`
  const lastError = record.errors.at(-1)
  const errorText = lastError ? `${lastError.kind} ${lastError.message}` : ''

  if (record.outcome === 'ready') return result('ready', 'ready', null, `ready in ${seconds(record.readyMs ?? lastMs)} (peak heap ${size(heapMb)}); ${who}`)

  if (!alive) {
    const at = `died in stage ${record.stage} ${seconds(lastMs)} after start`
    if (record.fatal?.kind === 'exit') return result('died', record.stage, 'exit', `${at}: exited (${record.fatal.message})${errorText ? ` after ${errorText}` : ''}; ${who}`)
    if (oomSeen || nearLimit) return result('died', record.stage, 'oom', `${at}: V8 heap out of memory (${memory}); ${who}`)
    if (lastError) return result('died', record.stage, 'exception', `${at}: crashed after ${errorText}${exited ? ` (${exited})` : ''}; ${who}`)
    return result('died', record.stage, 'crash', `${at}: the process ended without a JavaScript error${exited ? ` (${exited})` : ''} (${memory}); ${who}`)
  }

  const inStage = Math.max(0, now - Date.parse(record.stageAt))
  const since = Number.isFinite(started) ? now - started : lastMs
  if (lastError && Date.parse(lastError.at) >= Date.parse(record.stageAt) && now - Date.parse(lastError.at) >= 10_000) {
    return result('stalled', record.stage, 'exception', `stalled in stage ${record.stage} for ${seconds(inStage)} after ${errorText}; ${who}`)
  }
  if (inStage >= STALL_MS) {
    const blocked = sample && sample.mainBeatAgoMs >= 5_000 ? `main thread blocked for ${seconds(sample.mainBeatAgoMs)}` : sample ? 'main thread responsive' : 'no sample'
    return result('stalled', record.stage, 'hang', `stalled in stage ${record.stage} for ${seconds(inStage)} (${blocked}; ${memory}); ${who}`)
  }
  return result('booting', record.stage, null, `booting: in stage ${record.stage} for ${seconds(inStage)}, ${seconds(since)} after start (${memory}); ${who}`)
}

const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null } }

/** The record of launch `pid` (or the newest launch when pid is null): boot.json, else the filed
 *  last failure, else its history line. */
export function readBootRecord(userData: string, pid: number | null): { record: BootRecord | null; sample: BootSample | null } {
  const directory = join(userData, DIAGNOSTICS_DIRECTORY)
  const sample = readJson<BootSample>(join(directory, BOOT_SAMPLE_FILE))
  const current = readJson<BootRecord>(join(directory, BOOT_FILE))
  if (current?.schema === 1 && (pid === null || current.pid === pid)) return { record: current, sample }
  if (pid === null) return { record: null, sample: null }
  const failure = readJson<BootRecord & { lastSample?: BootSample | null }>(join(directory, BOOT_LAST_FAILURE_FILE))
  if (failure?.schema === 1 && failure.pid === pid) return { record: failure, sample: failure.lastSample ?? null }
  let lines: BootHistoryLine[] = []
  try { lines = readFileSync(join(directory, BOOT_HISTORY_FILE), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as BootHistoryLine) } catch { /* none */ }
  const line = lines.reverse().find(entry => entry.pid === pid)
  return { record: line ? historyRecord(line) : null, sample: null }
}

/** A history line shaped as a record, for a launch whose boot.json a later launch replaced. */
export function historyRecord(line: BootHistoryLine): BootRecord {
  const at = new Date(Date.parse(line.startedAt) + line.ms).toISOString()
  return {
    // The line keeps only the cause: an out-of-memory one reads as a heap at its limit again.
    schema: 1, pid: line.pid, version: line.version, packaged: true, exe: '', startedAt: line.startedAt, heapLimitMb: line.cause === 'oom' ? line.peakHeapMb : 0, stage: line.stage, stageAt: at,
    outcome: line.outcome === 'ready' ? 'ready' : 'booting', readyMs: line.outcome === 'ready' ? line.ms : null,
    stages: [{ name: line.stage, at, ms: line.ms, heapMb: line.peakHeapMb, rssMb: 0 }], peak: { heapMb: line.peakHeapMb, rssMb: 0 },
    errors: line.cause === 'exception' ? [{ at, stage: line.stage, kind: 'error', message: 'recorded by an earlier launch' }] : [],
    fatal: line.cause === 'exit' ? { at, stage: line.stage, kind: 'exit', message: 'exit', heapMb: line.peakHeapMb, rssMb: 0 } : null
  }
}

export function readBootVerdict(userData: string, options: { pid?: number | null; alive: boolean; exitCode?: number | null; log?: string; now?: number }): BootVerdict {
  const { record, sample } = readBootRecord(userData, options.pid ?? null)
  return bootVerdict({ record, sample, pid: options.pid ?? null, alive: options.alive, exitCode: options.exitCode ?? null, log: options.log ?? '', now: options.now ?? Date.now() })
}
