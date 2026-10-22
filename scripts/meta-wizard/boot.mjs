import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// How a Conductor launch went, from the boot record it writes as it starts
// (<userData>/diagnostics/boot.json, docs/startup-diagnostics.md): one line that says where a failed
// start died and why. Mirrors src/main/recovery/boot-verdict.ts line for line (the meta-wizard runs
// outside the app and cannot import it); both pass scripts/meta-wizard/boot-verdict-cases.json.

export const DIAGNOSTICS_DIRECTORY = 'diagnostics'
export const STALL_MS = 120_000
const OOM_TEXT = /JavaScript heap out of memory|OOM error in V8|Fatal JavaScript invalid size error|Ineffective mark-compacts near heap limit/i
const OOM_EXIT_CODES = new Set([3758096392, -536870904, 4294930435, -36861])

const seconds = ms => ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`
const size = megabytes => megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`

/** `{state, stage, cause, signature, line, version, pid}`; pure. */
export function bootVerdict({ record, sample = null, pid = null, alive, exitCode = null, log = '', now }) {
  sample = sample && record && sample.pid === record.pid ? sample : null
  pid = record?.pid ?? pid ?? null
  exitCode = exitCode ?? null
  log = log ?? ''
  const who = record ? `Conductor ${record.version || 'unknown version'}, pid ${record.pid}` : pid ? `pid ${pid}` : 'Conductor'
  const result = (state, stage, cause, line) => ({ state, stage, cause, signature: `${state}:${stage ?? 'none'}:${cause ?? 'none'}`, line, version: record?.version ?? null, pid })
  const exited = exitCode === null ? '' : `exit code ${exitCode}`
  const oomSeen = OOM_TEXT.test(log) || (exitCode !== null && OOM_EXIT_CODES.has(exitCode))

  if (!record) {
    if (alive) return result('unknown', null, null, `${who} runs but has written no boot diagnostics (a build without them, or it has not reached the single-instance lock)`)
    const why = oomSeen ? `V8 heap out of memory${exited ? ` (${exited})` : ''}` : exited ? `exited with ${exited}` : 'it ended'
    return result('unknown', null, oomSeen ? 'oom' : exitCode === null ? null : 'crash', `died before writing boot diagnostics (before the single-instance lock, or a build without them): ${why}`)
  }

  const started = Date.parse(record.startedAt)
  const lastMs = Math.max(record.stages?.at(-1)?.ms ?? 0, sample?.ms ?? 0)
  const heapMb = Math.max(record.peak?.heapMb ?? 0, sample?.heapMb ?? 0)
  const rssMb = Math.max(record.peak?.rssMb ?? 0, sample?.rssMb ?? 0)
  const nearLimit = record.heapLimitMb > 0 && heapMb >= record.heapLimitMb * 0.9
  const memory = `heap ${size(heapMb)} of a ${size(record.heapLimitMb)} limit, RSS ${size(rssMb)}`
  const lastError = record.errors?.at(-1)
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

/** A history line shaped as a record, for a launch whose boot.json a later launch replaced. */
export function historyRecord(line) {
  const at = new Date(Date.parse(line.startedAt) + line.ms).toISOString()
  return {
    schema: 1, pid: line.pid, version: line.version, packaged: true, exe: '', startedAt: line.startedAt, heapLimitMb: line.cause === 'oom' ? line.peakHeapMb : 0, stage: line.stage, stageAt: at,
    outcome: line.outcome === 'ready' ? 'ready' : 'booting', readyMs: line.outcome === 'ready' ? line.ms : null,
    stages: [{ name: line.stage, at, ms: line.ms, heapMb: line.peakHeapMb, rssMb: 0 }], peak: { heapMb: line.peakHeapMb, rssMb: 0 },
    errors: line.cause === 'exception' ? [{ at, stage: line.stage, kind: 'error', message: 'recorded by an earlier launch' }] : [],
    fatal: line.cause === 'exit' ? { at, stage: line.stage, kind: 'exit', message: 'exit', heapMb: line.peakHeapMb, rssMb: 0 } : null
  }
}

const readJson = async path => { try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')) } catch { return null } }

/** The record of launch `pid` (the newest launch when pid is null): boot.json, else the filed last
 *  failure, else its history line. */
export async function readBootRecord(userData, pid = null) {
  const directory = join(userData, DIAGNOSTICS_DIRECTORY)
  const sample = await readJson(join(directory, 'boot-sample.json'))
  const current = await readJson(join(directory, 'boot.json'))
  if (current?.schema === 1 && (pid === null || current.pid === pid)) return { record: current, sample }
  if (pid === null) return { record: null, sample: null }
  const failure = await readJson(join(directory, 'boot-last-failure.json'))
  if (failure?.schema === 1 && failure.pid === pid) return { record: failure, sample: failure.lastSample ?? null }
  let lines = []
  try { lines = (await readFile(join(directory, 'boot-history.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { /* none */ }
  const line = lines.reverse().find(entry => entry.pid === pid)
  return { record: line ? historyRecord(line) : null, sample: null }
}

/** Never throws: a verdict that cannot be read is `unknown`. */
export async function readBootVerdict(userData, { pid = null, alive = false, exitCode = null, log = '', now = Date.now() } = {}) {
  try {
    const { record, sample } = await readBootRecord(userData, pid)
    return bootVerdict({ record, sample, pid, alive, exitCode, log, now })
  } catch (error) {
    return { state: 'unknown', stage: null, cause: null, signature: 'unknown:none:none', line: `boot diagnostics unreadable: ${error?.message ?? error}`, version: null, pid }
  }
}
