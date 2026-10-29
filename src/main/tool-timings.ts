import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AgentEvent, ActivityStatus } from '../shared/structured-agent'
import { aggregateToolTimings, summarizeToolArgs, summarizeToolError, toolCategory, TOOL_TIMING_LIMITS, type ToolTimingOutcome, type ToolTimingRecord, type ToolTimingsQuery, type ToolTimingsReport } from '../shared/tool-timings'

/**
 * The tool-call timing recorder (docs/perf-evidence/t3code-cloud-tool-timings.md). It sees every
 * structured event once, at the moment StructuredSessions stages it, through AgentManager's
 * observer, and keeps one bounded record per tool call: name, a masked argument summary, and only
 * the durations it observed (src/shared/tool-timings.ts says which and why).
 *
 * Hot path: a non-tool event costs one property check; a tool event a map lookup, and the argument
 * summary once per call. Finished records are appended to a JSONL file in batches off the event
 * path, compacted to `capacity` records within `retentionMs` when loaded and when it grows half
 * again. Durations use the monotonic clock, so a wall-clock jump cannot make one negative; only a
 * call that outlives the process falls back to wall time, and says so.
 */

const TERMINAL = new Set<ActivityStatus>(['completed', 'failed', 'rejected', 'interrupted'])
const ENDED_PHASES = new Set(['completed', 'failed', 'interrupted', 'disconnected'])
const DAY_MS = 24 * 60 * 60 * 1000
/** A provider duration beyond this is a unit or clock error, not a measurement. */
const MAX_PROVIDER_MS = 7 * DAY_MS
const FILE = 'tool-timings.jsonl'
const MAX_READ_BYTES = 16 * 1024 * 1024

export interface ToolTimingsOptions {
  /** Where the JSONL lives; absent keeps records in memory only (tests, anonymous launches). */
  directory?: string
  capacity?: number
  retentionMs?: number
  maxOpen?: number
  flushMs?: number
  /** Monotonic milliseconds. */
  now?: () => number
  wallNow?: () => number
  /** The journal's secret masker (structured-store maskSecrets), applied to every summary. */
  mask?: (text: string) => string
}

interface OpenCall {
  key: string
  record: Omit<ToolTimingRecord, 'endedAt' | 'elapsedMs' | 'elapsedSource' | 'waitMs' | 'waitSource' | 'execMs' | 'execSource' | 'prepareMs' | 'outcome'>
  firstMono: number
  phase: ActivityStatus
  phaseMono: number
  waitMs: number | null
  prepareMs: number | null
  runningMs: number | null
}

type Observed = Pick<AgentEvent, 'id' | 'sessionId' | 'runtimeId' | 'provider' | 'projectId' | 'itemId' | 'turnId' | 'timestamp' | 'data'>

export class ToolTimingRecorder {
  private readonly capacity: number
  private readonly retentionMs: number
  private readonly maxOpen: number
  private readonly flushMs: number
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly mask: (text: string) => string
  private records: ToolTimingRecord[] = []
  private readonly byKey = new Map<string, ToolTimingRecord>()
  /** Abandoned records by conversation and provider item id, so the end of a call that outlived
   *  its runtime incarnation (or this process) amends the record instead of adding a second one. */
  private readonly abandoned = new Map<string, ToolTimingRecord>()
  private readonly abandonedMono = new WeakMap<ToolTimingRecord, number>()
  private readonly aliases = new WeakMap<ToolTimingRecord, string>()
  private readonly open = new Map<string, OpenCall>()
  private readonly inFlight = new Map<string, number>()
  private pending: string[] = []
  private timer: NodeJS.Timeout | undefined
  private writes: Promise<void> = Promise.resolve()
  private fileLines = 0
  private deduplicated = 0
  private droppedOnLoad = 0
  private parseErrors = 0
  private disposed = false
  /** Failures inside the recorder itself: it never breaks the event pipeline it observes. */
  errors = 0

  constructor(private readonly options: ToolTimingsOptions = {}) {
    this.capacity = options.capacity ?? 5000
    this.retentionMs = options.retentionMs ?? 14 * DAY_MS
    this.maxOpen = options.maxOpen ?? 2000
    this.flushMs = options.flushMs ?? 2000
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now
    this.mask = options.mask ?? (text => text)
  }

  private get file(): string | undefined { return this.options.directory ? join(this.options.directory, FILE) : undefined }

  /** Read what earlier processes recorded. Calls observed meanwhile are kept and win on a clash. */
  async load(): Promise<void> {
    const file = this.file
    if (!file) return
    let text = ''
    try {
      const size = (await stat(file)).size
      const raw = await readFile(file)
      text = (size > MAX_READ_BYTES ? raw.subarray(raw.length - MAX_READ_BYTES) : raw).toString('utf8')
      if (size > MAX_READ_BYTES) text = text.slice(text.indexOf('\n') + 1)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errors++; return }
    const cutoff = this.wallNow() - this.retentionMs, loaded = new Map<string, ToolTimingRecord>()
    let lines = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      lines++
      const record = parseRecord(line)
      if (!record) { this.parseErrors++; continue }
      if (Date.parse(record.endedAt) < cutoff) { this.droppedOnLoad++; continue }
      // A later line for the same call is its amendment (an abandoned call that ended after all).
      if (loaded.has(record.key)) loaded.delete(record.key)
      loaded.set(record.key, record)
    }
    const earlier = [...loaded.values()].filter(record => !this.byKey.has(record.key) && !this.open.has(record.key))
    const keep = earlier.slice(Math.max(0, earlier.length - Math.max(0, this.capacity - this.records.length)))
    this.droppedOnLoad += earlier.length - keep.length
    for (const record of keep) this.index(record)
    this.records = [...keep, ...this.records]
    this.fileLines = lines
    if (lines > keep.length) this.compact()
  }

  observe(event: Observed, model?: string): void {
    if (this.disposed) return
    const data = event.data
    if (data.type !== 'tool' && data.type !== 'session') return
    try {
      if (data.type === 'tool') this.observeTool(event, data, model)
      else if (ENDED_PHASES.has(data.phase) && this.open.size) this.sweep(event, data.phase)
    } catch { this.errors++ }
  }

  private observeTool(event: Observed, data: Extract<AgentEvent['data'], { type: 'tool' }>, model: string | undefined): void {
    const itemId = event.itemId ?? event.id
    const key = `${event.sessionId}\u0000${event.runtimeId}\u0000${itemId}`
    const mono = this.now(), terminal = TERMINAL.has(data.status)
    let call = this.open.get(key)
    if (!call) {
      // The same runtime's call is matched by key whatever it is named now (Codex names an approval
      // request differently from the command); another runtime's abandoned call also by its name.
      const prior = this.byKey.get(key) ?? this.abandonedFor(event.sessionId, itemId, data.name)
      if (prior && prior.outcome !== 'abandoned') {
        // A restated end (Claude restates tools when it re-attaches, Codex repeats item/completed) or a
        // late progress event of a call already finished: the first statement stands.
        prior.restated = (prior.restated ?? 0) + 1
        this.deduplicated++
        return
      }
      if (prior) { if (terminal) this.amend(prior, event, data, mono); return }
      call = this.start(key, itemId, event, data, mono, model)
      if (!terminal) {
        if (this.open.size >= this.maxOpen) this.evictOldestOpen(mono)
        this.open.set(key, call)
        this.inFlight.set(event.sessionId, (this.inFlight.get(event.sessionId) ?? 0) + 1)
      }
    }
    if (data.name) call.record.tool = data.name.slice(0, TOOL_TIMING_LIMITS.tool)
    if (!call.record.args && data.input !== undefined) call.record.args = summarizeToolArgs(call.record.tool, data.input, this.mask)
    if (data.detached) call.record.detached = true
    if (event.turnId && !call.record.turnId) call.record.turnId = event.turnId
    if (data.status !== call.phase) {
      this.closePhase(call, mono)
      call.phase = data.status
      call.phaseMono = mono
    }
    if (terminal) this.finish(call, event, data, mono, this.open.has(key))
  }

  private start(key: string, itemId: string, event: Observed, data: Extract<AgentEvent['data'], { type: 'tool' }>, mono: number, model: string | undefined): OpenCall {
    const terminal = TERMINAL.has(data.status)
    const tool = (data.name || 'unknown').slice(0, TOOL_TIMING_LIMITS.tool)
    return {
      key, firstMono: mono, phase: data.status, phaseMono: mono,
      // A phase is only measured when Conductor saw the call enter it.
      waitMs: data.status === 'awaiting_approval' ? 0 : null, prepareMs: data.status === 'preparing' ? 0 : null, runningMs: data.status === 'running' ? 0 : null,
      record: {
        key, agentSessionId: event.sessionId, projectId: event.projectId, provider: event.provider, runtimeId: event.runtimeId, itemId,
        ...(event.turnId ? { turnId: event.turnId } : {}), ...(model ? { model } : {}),
        tool, category: toolCategory(tool), args: '', startedAt: terminal ? null : new Date(this.wallNow()).toISOString(),
        concurrent: terminal ? 0 : this.inFlight.get(event.sessionId) ?? 0
      }
    }
  }

  private closePhase(call: OpenCall, mono: number): void {
    const spent = Math.max(0, mono - call.phaseMono)
    if (call.phase === 'awaiting_approval') call.waitMs = (call.waitMs ?? 0) + spent
    else if (call.phase === 'preparing') call.prepareMs = (call.prepareMs ?? 0) + spent
    else if (call.phase === 'running') call.runningMs = (call.runningMs ?? 0) + spent
  }

  private finish(call: OpenCall, event: Observed, data: Extract<AgentEvent['data'], { type: 'tool' }>, mono: number, wasOpen: boolean): void {
    if (wasOpen) {
      this.open.delete(call.key)
      const count = (this.inFlight.get(event.sessionId) ?? 1) - 1
      if (count > 0) this.inFlight.set(event.sessionId, count); else this.inFlight.delete(event.sessionId)
    }
    const provider = providerDuration(data.durationMs)
    const notes: string[] = []
    if (data.durationMs !== undefined && provider === null) notes.push('invalid-provider-duration')
    const record: ToolTimingRecord = {
      ...call.record,
      endedAt: new Date(this.wallNow()).toISOString(),
      elapsedMs: wasOpen ? Math.max(0, mono - call.firstMono) : null,
      elapsedSource: wasOpen ? 'host-monotonic' : 'unavailable',
      waitMs: call.waitMs, waitSource: call.waitMs === null ? 'unavailable' : 'observed-approval',
      execMs: provider ?? call.runningMs, execSource: provider !== null ? 'provider' : call.runningMs !== null ? 'host-phase' : 'unavailable',
      prepareMs: call.prepareMs,
      outcome: data.status as ToolTimingOutcome,
      ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
      ...(notes.length ? { notes } : {})
    }
    if (data.status === 'failed' || data.status === 'rejected') {
      const error = summarizeToolError(data.output, data.stderr, this.mask)
      if (error) record.error = error
    }
    this.commit(record)
  }

  /** The end of a call recorded as abandoned: by this process (its turn ended without it) or by an
   *  earlier one. Elapsed is monotonic when this process saw it start, otherwise wall time. */
  private amend(record: ToolTimingRecord, event: Observed, data: Extract<AgentEvent['data'], { type: 'tool' }>, mono: number): void {
    const firstMono = this.abandonedMono.get(record)
    const wall = record.startedAt ? this.wallNow() - Date.parse(record.startedAt) : NaN
    const provider = providerDuration(data.durationMs)
    const notes = [...(record.notes ?? []).filter(note => note !== 'abandoned'), 'ended-after-abandon']
    const amended: ToolTimingRecord = {
      ...record,
      ...(data.name ? { tool: data.name.slice(0, TOOL_TIMING_LIMITS.tool), category: toolCategory(data.name) } : {}),
      runtimeId: event.runtimeId,
      endedAt: new Date(this.wallNow()).toISOString(),
      ...(firstMono !== undefined ? { elapsedMs: Math.max(0, mono - firstMono), elapsedSource: 'host-monotonic' as const }
        : Number.isFinite(wall) && wall >= 0 && wall <= DAY_MS ? { elapsedMs: wall, elapsedSource: 'wall-clock' as const } : { elapsedMs: null, elapsedSource: 'unavailable' as const }),
      ...(provider !== null ? { execMs: provider, execSource: 'provider' as const } : {}),
      outcome: data.status as ToolTimingOutcome,
      ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
      notes
    }
    if (data.status === 'failed' || data.status === 'rejected') { const error = summarizeToolError(data.output, data.stderr, this.mask); if (error) amended.error = error }
    this.abandoned.delete(`${record.agentSessionId}\u0000${record.itemId}`)
    const index = this.records.lastIndexOf(record)
    if (index >= 0) this.records.splice(index, 1)
    // The record keeps its key, so the file's later line replaces the abandoned one on load; the
    // new runtime's key is an alias so that runtime's own restatements are deduplicated too.
    this.commit(amended)
    const alias = `${event.sessionId}\u0000${event.runtimeId}\u0000${record.itemId}`
    if (alias !== amended.key) { this.byKey.set(alias, amended); this.aliases.set(amended, alias) }
  }

  private abandonedFor(sessionId: string, itemId: string, tool: string): ToolTimingRecord | undefined {
    const record = this.abandoned.get(`${sessionId}\u0000${itemId}`)
    return record && (!tool || record.tool === tool.slice(0, TOOL_TIMING_LIMITS.tool)) ? record : undefined
  }

  /** A runtime that ended leaves no call of its own running, except provider-confirmed background
   *  work. Its unended calls become abandoned: their time is unknown, not zero. */
  private sweep(event: Observed, phase: string): void {
    const mono = this.now()
    for (const call of [...this.open.values()]) {
      if (call.record.agentSessionId !== event.sessionId || call.record.runtimeId !== event.runtimeId || call.record.detached) continue
      this.abandon(call, mono, phase === 'disconnected' ? 'runtime-lost' : 'turn-ended-without-tool-end')
    }
  }

  private abandon(call: OpenCall, mono: number, reason: string): void {
    this.open.delete(call.key)
    const count = (this.inFlight.get(call.record.agentSessionId) ?? 1) - 1
    if (count > 0) this.inFlight.set(call.record.agentSessionId, count); else this.inFlight.delete(call.record.agentSessionId)
    this.closePhase(call, mono)
    const record: ToolTimingRecord = {
      ...call.record, endedAt: new Date(this.wallNow()).toISOString(),
      elapsedMs: null, elapsedSource: 'unavailable', waitMs: call.waitMs, waitSource: call.waitMs === null ? 'unavailable' : 'observed-approval',
      // Partial phase times are lower bounds of a call that never ended: never offered as its exec.
      execMs: null, execSource: 'unavailable', prepareMs: call.prepareMs, outcome: 'abandoned', notes: ['abandoned', reason]
    }
    this.abandonedMono.set(record, call.firstMono)
    this.commit(record)
  }

  private evictOldestOpen(mono: number): void {
    const oldest = this.open.values().next().value
    if (oldest) this.abandon(oldest, mono, 'open-limit')
  }

  private index(record: ToolTimingRecord): void {
    this.byKey.set(record.key, record)
    if (record.outcome === 'abandoned') this.abandoned.set(`${record.agentSessionId}\u0000${record.itemId}`, record)
  }

  private commit(record: ToolTimingRecord): void {
    this.records.push(record)
    this.index(record)
    if (this.records.length > this.capacity * 1.1) {
      for (const dropped of this.records.splice(0, this.records.length - this.capacity)) {
        if (this.byKey.get(dropped.key) === dropped) this.byKey.delete(dropped.key)
        const alias = this.aliases.get(dropped)
        if (alias && this.byKey.get(alias) === dropped) this.byKey.delete(alias)
        const item = `${dropped.agentSessionId}\u0000${dropped.itemId}`
        if (this.abandoned.get(item) === dropped) this.abandoned.delete(item)
      }
    }
    if (!this.file) return
    this.pending.push(JSON.stringify({ v: 1, ...record }))
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, this.flushMs); this.timer.unref?.() }
  }

  /** Append what finished since the last flush; compaction rides the same queue. */
  flush(): Promise<void> {
    const file = this.file
    if (!file || !this.pending.length) return this.writes
    const lines = this.pending
    this.pending = []
    this.writes = this.writes.then(async () => {
      await mkdir(this.options.directory!, { recursive: true })
      await appendFile(file, lines.join('\n') + '\n')
      this.fileLines += lines.length
    }).catch(() => { this.errors++ })
    if (this.fileLines + lines.length > this.capacity * 1.5) this.compact()
    return this.writes
  }

  private compact(): void {
    const file = this.file
    if (!file) return
    this.writes = this.writes.then(async () => {
      const cutoff = this.wallNow() - this.retentionMs
      const keep = this.records.filter(record => Date.parse(record.endedAt) >= cutoff)
      const pending = new Set(this.pending)
      const lines = keep.map(record => JSON.stringify({ v: 1, ...record })).filter(line => !pending.has(line))
      await mkdir(this.options.directory!, { recursive: true })
      await writeFile(file + '.tmp', lines.length ? lines.join('\n') + '\n' : '')
      await rename(file + '.tmp', file)
      this.fileLines = lines.length
    }).catch(() => { this.errors++ })
  }

  report(query: ToolTimingsQuery = {}): ToolTimingsReport {
    const cutoff = this.wallNow() - this.retentionMs
    const live = this.records.filter(record => Date.parse(record.endedAt) >= cutoff)
    const inFlight = [...this.open.values()].filter(call => (!query.projectId || call.record.projectId === query.projectId) && (!query.agentSessionId || call.record.agentSessionId === query.agentSessionId) && (!query.provider || call.record.provider === query.provider)).length
    return aggregateToolTimings(live, query, {
      observedAt: new Date(this.wallNow()).toISOString(), inFlight,
      storage: { records: live.length, capacity: this.capacity, retentionDays: Math.round(this.retentionMs / DAY_MS), recordedSince: live[0]?.endedAt ?? null, deduplicated: this.deduplicated, droppedOnLoad: this.droppedOnLoad, parseErrors: this.parseErrors }
    })
  }

  /** On quit: calls still running are written as abandoned, so a runtime the host keeps running can
   *  still end them in the next process; then every pending line is written synchronously. */
  dispose(): void {
    if (this.disposed) return
    const mono = this.now()
    for (const call of [...this.open.values()]) this.abandon(call, mono, 'app-exit')
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const file = this.file
    if (file && this.pending.length) {
      try { mkdirSync(this.options.directory!, { recursive: true }); appendFileSync(file, this.pending.join('\n') + '\n') } catch { this.errors++ }
      this.pending = []
    }
  }
}

function providerDuration(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PROVIDER_MS ? value : null
}

const OUTCOMES = new Set<ToolTimingOutcome>(['completed', 'failed', 'rejected', 'interrupted', 'abandoned'])
const nullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
/** A line the file holds, or null when it is not one this version wrote. */
export function parseRecord(line: string): ToolTimingRecord | null {
  let value: Record<string, unknown>
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || value.v !== 1) return null
  const strings = ['key', 'agentSessionId', 'projectId', 'provider', 'runtimeId', 'itemId', 'tool', 'category', 'args', 'endedAt'] as const
  if (strings.some(key => typeof value[key] !== 'string') || !Number.isFinite(Date.parse(value.endedAt as string))) return null
  if (!OUTCOMES.has(value.outcome as ToolTimingOutcome) || !nullableNumber(value.elapsedMs) || !nullableNumber(value.waitMs) || !nullableNumber(value.execMs) || !nullableNumber(value.prepareMs)) return null
  const { v: _v, ...record } = value
  return { concurrent: 0, startedAt: null, ...record } as unknown as ToolTimingRecord
}

/** Normalizes an untrusted query (IPC or app control) into bounded filters. */
export function toolTimingsQuery(args: Record<string, unknown>): ToolTimingsQuery {
  const query: ToolTimingsQuery = {}
  for (const key of ['projectId', 'agentSessionId', 'provider', 'tool'] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${key} must be a non-empty string`)
    query[key] = value.trim()
  }
  for (const key of ['since', 'until'] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${key} must be an ISO date-time`)
    query[key] = new Date(Date.parse(value)).toISOString()
  }
  for (const [key, max] of [['limit', TOOL_TIMING_LIMITS.maxTop], ['recent', TOOL_TIMING_LIMITS.maxRecent]] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new Error(`${key} must be a whole number from ${key === 'limit' ? 1 : 0} to ${max}`)
    query[key] = value
  }
  if (args.includeDetached !== undefined) {
    if (typeof args.includeDetached !== 'boolean') throw new Error('includeDetached must be a boolean')
    query.includeDetached = args.includeDetached
  }
  return query
}

export function registerToolTimingsIpc(ipcMain: Pick<IpcMain, 'handle'>, recorder: () => ToolTimingRecorder | undefined, trusted: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle('tool-timings:report', (event, query: unknown) => {
    trusted(event)
    const current = recorder()
    if (!current) throw new Error('Tool timings are still starting; try again in a moment')
    return current.report(toolTimingsQuery(query && typeof query === 'object' ? query as Record<string, unknown> : {}))
  })
}
