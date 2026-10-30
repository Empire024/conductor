import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AgentEvent, ActivityStatus } from '../shared/structured-agent'
import { aggregateToolTimings, rowClockMs, summarizeToolArgs, summarizeToolError, toolCategory, TOOL_TIMING_LIMITS, type ToolTimingOutcome, type ToolTimingRecord, type ToolTimingsQuery, type ToolTimingsReport, type TranscriptToolCall } from '../shared/tool-timings'

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
/** Transcript tool calls read in one import. */
const MAX_IMPORT = 2000
/** Written only synchronously by dispose(): no async compaction ever renames over it, so what a quit
 *  writes there cannot be lost to a rewrite still in flight. A load never reads or deletes it in
 *  place: it first renames it to a claimed file of its own, so a quit during that load starts a fresh
 *  exit file the load cannot touch. A claimed file is deleted only once a rewrite holding its lines
 *  is durable; otherwise the next load reads it again. */
const EXIT_FILE = 'tool-timings.exit.jsonl'
const CLAIMED = /^tool-timings\.exit\.\d{13}-\d+-[0-9a-z]+\.claimed\.jsonl$/
/** Claimed files left by loads that never reached a durable rewrite; beyond this many, the oldest go. */
const MAX_CLAIMED = 8
const MAX_READ_BYTES = 16 * 1024 * 1024

export interface ToolTimingsOptions {
  /** Where the JSONL lives; absent keeps records in memory only (tests, anonymous launches). */
  directory?: string
  capacity?: number
  retentionMs?: number
  maxOpen?: number
  /** Cloud-transcript records kept, within `capacity`; default 1000. */
  cloudCapacity?: number
  flushMs?: number
  /** Most bytes load() reads, from the end of the file; default 16 MiB. */
  maxReadBytes?: number
  /** Monotonic milliseconds. */
  now?: () => number
  wallNow?: () => number
  /** The journal's secret masker (structured-store maskSecrets), applied to every summary. */
  mask?: (text: string) => string
  /** The asynchronous file operations, replaceable so a test can hold one mid-flight. */
  io?: Partial<{ appendFile: typeof appendFile; writeFile: typeof writeFile; rename: typeof rename; open: typeof open }>
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
  /** The provider's own start stamp (Unix ms, its clock), first one seen; null when it sent none. */
  providerStartedAtMs: number | null
  /** The provider's union of auto-approval reviews, when it reported one. Never host wait. */
  reviewMs: number | null
}

type Observed = Pick<AgentEvent, 'id' | 'sessionId' | 'runtimeId' | 'provider' | 'projectId' | 'itemId' | 'turnId' | 'timestamp' | 'data'>

export class ToolTimingRecorder {
  private readonly capacity: number
  private readonly retentionMs: number
  private readonly maxOpen: number
  private readonly cloudCapacity: number
  private readonly flushMs: number
  private readonly maxReadBytes: number
  private directoryReady = false
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly mask: (text: string) => string
  private records: ToolTimingRecord[] = []
  private readonly byKey = new Map<string, ToolTimingRecord>()
  /** Abandoned records by conversation and provider item id, so the end of a call that outlived
   *  its runtime incarnation (or this process) amends the record instead of adding a second one. */
  private readonly abandoned = new Map<string, ToolTimingRecord>()
  private readonly abandonedMono = new WeakMap<ToolTimingRecord, number>()
  /** The provider start stamp of an abandoned call, so its later end can still be timed on the provider's clock. */
  private readonly abandonedProviderStart = new WeakMap<ToolTimingRecord, number>()
  private readonly aliases = new WeakMap<ToolTimingRecord, string>()
  private readonly open = new Map<string, OpenCall>()
  private readonly inFlight = new Map<string, number>()
  private pending: Array<{ key: string; line: string }> = []
  /** Keys whose line is pending or on its way to the file, with their newest line: a rewrite leaves
   *  them to that append, and dispose() writes exactly these to the exit file. */
  private readonly unwritten = new Map<string, { count: number; line: string }>()
  private readonly io: { appendFile: typeof appendFile; writeFile: typeof writeFile; rename: typeof rename; open: typeof open }
  private timer: NodeJS.Timeout | undefined
  private writes: Promise<void> = Promise.resolve()
  private fileLines = 0
  private deduplicated = 0
  private droppedOnLoad = 0
  private parseErrors = 0
  private disposed = false
  /** Failures inside the recorder itself: it never breaks the event pipeline it observes. */
  errors = 0
  /** Bytes the last load() read: never more than maxReadBytes. */
  loadedBytes = 0

  constructor(private readonly options: ToolTimingsOptions = {}) {
    this.capacity = options.capacity ?? 5000
    this.retentionMs = options.retentionMs ?? 14 * DAY_MS
    this.maxOpen = options.maxOpen ?? 2000
    this.cloudCapacity = Math.max(0, Math.floor(options.cloudCapacity ?? 1000))
    this.flushMs = options.flushMs ?? 2000
    this.maxReadBytes = Math.max(1, Math.floor(options.maxReadBytes ?? MAX_READ_BYTES))
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now
    this.mask = options.mask ?? (text => text)
    this.io = { appendFile, writeFile, rename, open, ...options.io }
  }

  private get file(): string | undefined { return this.options.directory ? join(this.options.directory, FILE) : undefined }
  private get exitFile(): string | undefined { return this.options.directory ? join(this.options.directory, EXIT_FILE) : undefined }

  /** The newest `maxReadBytes` of a file, whole lines only; null when it does not exist. */
  private async readTail(path: string): Promise<{ text: string; truncated: boolean } | null> {
    let handle
    try { handle = await this.io.open(path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const size = (await handle.stat()).size, length = Math.min(size, this.maxReadBytes)
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read)
        if (!bytesRead) break
        read += bytesRead
      }
      this.loadedBytes += read
      let bytes = buffer.subarray(0, read)
      const truncated = size > length
      // Cut at a newline byte, which never occurs inside a UTF-8 sequence: the partial first
      // line, and any split character with it, is dropped before decoding.
      if (truncated) { const newline = bytes.indexOf(0x0a); bytes = bytes.subarray(newline < 0 ? bytes.length : newline + 1) }
      return { text: bytes.toString('utf8'), truncated }
    } finally { await handle.close() }
  }

  /** Takes the exit file over under a name of this load's own (a quit from now on writes a fresh
   *  one), and lists every claimed file to read: those, oldest first, and the ones beyond the cap. */
  private async claimExitFiles(exitFile: string): Promise<{ read: string[]; overflow: string[] }> {
    const directory = this.options.directory!
    const claimed = `tool-timings.exit.${String(this.wallNow()).padStart(13, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.claimed.jsonl`
    // Busy (a quit writing it on Windows) or missing: it stays where it is for the next load.
    try { await this.io.rename(exitFile, join(directory, claimed)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errors++ }
    let names: string[] = []
    try { names = (await readdir(directory)).filter(name => CLAIMED.test(name)).sort() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const paths = names.map(name => join(directory, name))
    return { read: paths.slice(-MAX_CLAIMED), overflow: paths.slice(0, Math.max(0, paths.length - MAX_CLAIMED)) }
  }

  /** Read what earlier processes recorded. Calls observed meanwhile are kept and win on a clash.
   *  Runs on the write queue, so no append lands on a torn last line before compaction heals it. */
  load(): Promise<void> {
    // Never rejects: index.ts starts it with `void`.
    this.writes = this.writes.then(() => this.loadTail()).catch(() => { this.errors++ })
    return this.writes
  }

  private async loadTail(): Promise<void> {
    const file = this.file, exitFile = this.exitFile
    // After a quit, nothing is loaded and nothing on disk is touched.
    if (!file || !exitFile || this.disposed) return
    this.loadedBytes = 0
    let main: { text: string; truncated: boolean } | null, claims: { read: string[]; overflow: string[] }, exits: Array<{ text: string; truncated: boolean } | null>
    // Only the newest `maxReadBytes` of each file are ever read, however large it grew.
    try {
      claims = await this.claimExitFiles(exitFile)
      main = await this.readTail(file)
      exits = []
      for (const path of claims.read) exits.push(await this.readTail(path))
    } catch { this.errors++; return }
    const exitText = exits.map(exit => exit?.text ?? '').join('\n')
    if (!main && !claims.read.length) return
    // A last line without its newline was cut off by a crash mid-append.
    const torn = Boolean(main?.text && !main.text.endsWith('\n'))
    const cutoff = this.wallNow() - this.retentionMs, loaded = new Map<string, ToolTimingRecord>()
    let lines = 0
    // Exit files are read last, oldest first: what a quit wrote is newer than the main file.
    for (const line of [...(main?.text ?? '').split('\n'), ...exitText.split('\n')]) {
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
    this.trimCloud(this.cloudCapacity)
    this.fileLines = lines
    // An oversized, torn or partly stale file, or one with a quit's lines beside it, is rewritten
    // from what was kept inside this queued step, so it is whole, merged and under the bound before
    // any queued append lands on it. Only this load's claimed files go, and only once that rewrite
    // is durable: a rewrite skipped because the app is quitting deletes nothing.
    if (main?.truncated || torn || lines > keep.length || claims.read.length || claims.overflow.length) {
      try {
        if (await this.rewrite()) for (const path of [...claims.overflow, ...claims.read]) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      } catch { this.errors++; this.directoryReady = false }
    }
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
    if (call.providerStartedAtMs === null && data.providerStartedAtMs !== undefined) call.providerStartedAtMs = data.providerStartedAtMs
    if (data.providerReviewMs !== undefined) call.reviewMs = data.providerReviewMs
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
      providerStartedAtMs: null, reviewMs: null,
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
    const lifecycle = providerInterval(call.providerStartedAtMs, data.providerCompletedAtMs, notes)
    const review = providerReview(call.reviewMs, notes)
    const record: ToolTimingRecord = {
      ...call.record,
      endedAt: new Date(this.wallNow()).toISOString(),
      // The provider's own start-to-end on its own clock; otherwise what this host saw, never a mix.
      ...(lifecycle !== null ? { elapsedMs: lifecycle, elapsedSource: 'provider' as const }
        : { elapsedMs: wasOpen ? Math.max(0, mono - call.firstMono) : null, elapsedSource: wasOpen ? 'host-monotonic' as const : 'unavailable' as const }),
      ...(review !== null ? { reviewMs: review, reviewSource: 'provider-review' as const } : {}),
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
    const lifecycle = providerInterval(this.abandonedProviderStart.get(record) ?? null, data.providerCompletedAtMs, notes)
    const review = data.providerReviewMs !== undefined ? providerReview(data.providerReviewMs, notes) : null
    const amended: ToolTimingRecord = {
      ...record,
      ...(data.name ? { tool: data.name.slice(0, TOOL_TIMING_LIMITS.tool), category: toolCategory(data.name) } : {}),
      runtimeId: event.runtimeId,
      endedAt: new Date(this.wallNow()).toISOString(),
      ...(review !== null ? { reviewMs: review, reviewSource: 'provider-review' as const } : {}),
      ...(lifecycle !== null ? { elapsedMs: lifecycle, elapsedSource: 'provider' as const } : firstMono !== undefined ? { elapsedMs: Math.max(0, mono - firstMono), elapsedSource: 'host-monotonic' as const }
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
    if (call.providerStartedAtMs !== null) this.abandonedProviderStart.set(record, call.providerStartedAtMs)
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

  /**
   * A cloud coworker's tool calls, paired from its pulled transcript (cloud/runs.ts parseTranscript).
   * Each is keyed by the cloud session and its tool_use_id, never by a runtime, so a repeated pull,
   * a pull after a restart, or the same id in another session adds nothing twice; the first
   * statement stands. Elapsed is the transcript rows' own times on the cloud's clock (transcript-wall),
   * never this host's: a missing, reversed or implausible pair, a denial and a result the CLI wrote
   * for an interrupted call are not timed. Wait and execution are never inferred from it.
   */
  importCloudTranscript(input: { projectId: string; runId: string; cloudSessionId: string; model?: string; calls: readonly TranscriptToolCall[] }): { added: number; known: number; skipped: number } {
    const counts = { added: 0, known: 0, skipped: 0 }
    if (this.disposed || !input.cloudSessionId || !this.cloudCapacity) return counts
    const cutoff = this.wallNow() - this.retentionMs
    let cloud = this.records.filter(record => record.origin === 'cloud-transcript').length
    for (const call of input.calls.slice(-MAX_IMPORT)) {
      try {
        const key = `cloud-transcript\u0000${input.cloudSessionId}\u0000${call.toolUseId}`
        if (this.byKey.has(key)) { counts.known++; this.deduplicated++; continue }
        const record = this.transcriptRecord(key, input, call)
        // A call whose rows carry no time of their own has no place on any clock but this host's,
        // which is not the cloud's: it is not recorded, so no window or retention reads it as "now".
        if (!record) { counts.skipped++; continue }
        // Beyond retention, or older than everything kept once the cloud allowance is full: a later
        // pull would only add what the next trim drops again.
        const ended = Date.parse(record.endedAt)
        const oldest = cloud >= this.cloudCapacity ? this.records.find(entry => entry.origin === 'cloud-transcript') : undefined
        if (ended < cutoff || oldest && ended <= Date.parse(oldest.endedAt)) { counts.skipped++; continue }
        if (cloud >= this.cloudCapacity) this.trimCloud(this.cloudCapacity - 1); else cloud++
        this.commit(record)
        counts.added++
      } catch { this.errors++ }
    }
    return counts
  }

  /** Null when neither row has a time the cloud wrote (rowClockMs). */
  private transcriptRecord(key: string, input: { projectId: string; runId: string; cloudSessionId: string; model?: string }, call: TranscriptToolCall): ToolTimingRecord | null {
    const notes = [...call.notes]
    const start = rowClockMs(call.usedAt), end = rowClockMs(call.resultAt)
    const endedMs = end ?? start
    if (endedMs === null) return null
    let elapsedMs: number | null = null
    if (call.denied) notes.push('denied-or-interrupted-result')
    else if (call.notes.length) { /* the parser could not pair it on one clock: not timed */ }
    else if (start === null || end === null) notes.push('missing-transcript-time')
    else if (end < start || end - start > MAX_PROVIDER_MS) notes.push('invalid-transcript-interval')
    else elapsedMs = end - start
    const tool = (call.name || 'Tool').slice(0, TOOL_TIMING_LIMITS.tool)
    const outcome: ToolTimingOutcome = call.denied ? (/interrupt|cancel/i.test(call.denied) ? 'interrupted' : 'rejected') : call.isError ? 'failed' : 'completed'
    const record: ToolTimingRecord = {
      key, agentSessionId: input.runId, projectId: input.projectId, provider: 'claude-cloud', runtimeId: input.cloudSessionId, itemId: call.toolUseId,
      ...(input.model ? { model: input.model } : {}), origin: 'cloud-transcript',
      tool, category: toolCategory(tool), args: summarizeToolArgs(tool, call.input, this.mask),
      startedAt: start !== null ? new Date(start).toISOString() : null, endedAt: new Date(endedMs).toISOString(),
      elapsedMs, elapsedSource: elapsedMs === null ? 'unavailable' : 'transcript-wall',
      waitMs: null, waitSource: 'unavailable', execMs: null, execSource: 'unavailable', prepareMs: null,
      outcome, concurrent: 0, ...(notes.length ? { notes } : {})
    }
    if (outcome === 'failed' || outcome === 'rejected') { const error = summarizeToolError(call.result.slice(0, 4000), undefined, this.mask); if (error) record.error = error }
    return record
  }

  /** Keeps at most `keep` cloud-transcript records, dropping the oldest; native records are never touched. */
  private trimCloud(keep: number): void {
    let excess = this.records.filter(record => record.origin === 'cloud-transcript').length - Math.max(0, keep)
    if (excess <= 0) return
    this.records = this.records.filter(record => {
      if (excess <= 0 || record.origin !== 'cloud-transcript') return true
      excess--
      if (this.byKey.get(record.key) === record) this.byKey.delete(record.key)
      return false
    })
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
    this.pending.push({ key: record.key, line: JSON.stringify({ v: 1, ...record }) })
    this.unwritten.set(record.key, { count: (this.unwritten.get(record.key)?.count ?? 0) + 1, line: this.pending.at(-1)!.line })
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, this.flushMs); this.timer.unref?.() }
  }

  /** Append what finished since the last flush; compaction rides the same queue. */
  flush(): Promise<void> {
    const file = this.file
    if (!file || !this.pending.length) return this.writes
    const lines = this.pending
    this.pending = []
    this.writes = this.writes.then(async () => {
      // After dispose() these lines are already in the exit file.
      if (this.disposed) return
      try {
        if (!this.directoryReady) { await mkdir(this.options.directory!, { recursive: true }); this.directoryReady = true }
        await this.io.appendFile(file, lines.map(entry => entry.line).join('\n') + '\n')
        this.fileLines += lines.length
      } finally {
        for (const { key } of lines) { const entry = this.unwritten.get(key); if (entry && entry.count > 1) entry.count--; else this.unwritten.delete(key) }
      }
    }).catch(() => { this.errors++; this.directoryReady = false })
    if (this.fileLines + lines.length > this.capacity * 1.5) this.compact()
    return this.writes
  }

  private compact(): void {
    if (!this.file) return
    this.writes = this.writes.then(async () => { await this.rewrite() }).catch(() => { this.errors++; this.directoryReady = false })
  }

  /** The file rewritten from the kept records; a record whose line an append still owes is left to it.
   *  True once the new file is in place; false when nothing was written (no file, or quitting). */
  private async rewrite(): Promise<boolean> {
    const file = this.file
    if (!file || this.disposed) return false
    const cutoff = this.wallNow() - this.retentionMs
    const lines = this.records.filter(record => Date.parse(record.endedAt) >= cutoff && !this.unwritten.has(record.key)).map(record => JSON.stringify({ v: 1, ...record }))
    if (!this.directoryReady) { await mkdir(this.options.directory!, { recursive: true }); this.directoryReady = true }
    await this.io.writeFile(file + '.tmp', lines.length ? lines.join('\n') + '\n' : '')
    await this.io.rename(file + '.tmp', file)
    this.fileLines = lines.length
    return true
  }

  report(query: ToolTimingsQuery = {}): ToolTimingsReport {
    const cutoff = this.wallNow() - this.retentionMs
    const live = this.records.filter(record => Date.parse(record.endedAt) >= cutoff)
    const inFlight = query.origin === 'cloud-transcript' ? 0 : [...this.open.values()].filter(call => (!query.projectId || call.record.projectId === query.projectId) && (!query.agentSessionId || call.record.agentSessionId === query.agentSessionId) && (!query.provider || call.record.provider === query.provider)).length
    return aggregateToolTimings(live, query, {
      observedAt: new Date(this.wallNow()).toISOString(), inFlight,
      storage: { records: live.length, capacity: this.capacity, retentionDays: Math.round(this.retentionMs / DAY_MS), recordedSince: live[0]?.endedAt ?? null, deduplicated: this.deduplicated, droppedOnLoad: this.droppedOnLoad, parseErrors: this.parseErrors }
    })
  }

  /** On quit: calls still running are written as abandoned, so a runtime the host keeps running can
   *  still end them in the next process. Every line not yet durable (pending, or held by an append
   *  still queued or in flight) is written synchronously to the exit file, never to the main file a
   *  compaction may be renaming over; queued steps that have not started become no-ops. A line both
   *  there and appended by a step already in flight is one record: the next load merges by key. */
  dispose(): void {
    if (this.disposed) return
    const mono = this.now()
    for (const call of [...this.open.values()]) this.abandon(call, mono, 'app-exit')
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const exitFile = this.exitFile
    const lines = [...this.unwritten.values()].map(entry => entry.line)
    if (exitFile && lines.length) {
      try { mkdirSync(this.options.directory!, { recursive: true }); appendFileSync(exitFile, lines.join('\n') + '\n') } catch { this.errors++ }
    }
    this.pending = []
  }
}

function providerDuration(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PROVIDER_MS ? value : null
}

/** End minus start, both the provider's own stamps on its own clock. Null when either was not sent;
 *  a stamp that is negative, reversed or implausibly far apart is noted and not trusted. */
function providerInterval(start: number | null, end: number | undefined, notes: string[]): number | null {
  if (start === null || end === undefined) return null
  const valid = [start, end].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) && end >= start && end - start <= MAX_PROVIDER_MS
  if (!valid) { notes.push('invalid-provider-interval'); return null }
  return end - start
}

function providerReview(value: number | null | undefined, notes: string[]): number | null {
  if (value === null || value === undefined) return null
  const review = providerDuration(value)
  if (review === null) notes.push('invalid-provider-review')
  return review
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
  if (value.origin !== undefined && value.origin !== 'cloud-transcript') return null
  if (value.reviewMs !== undefined && (typeof value.reviewMs !== 'number' || !Number.isFinite(value.reviewMs) || value.reviewMs < 0 || value.reviewSource !== 'provider-review')) return null
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
  if (args.origin !== undefined) {
    if (args.origin !== 'native' && args.origin !== 'cloud-transcript') throw new Error('origin must be "native" or "cloud-transcript"')
    query.origin = args.origin
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
