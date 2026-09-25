import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../../shared/models'
import { canTransition, TERMINAL_JOB_STATUSES, type DurableJob, type DurableJobCheckpoint, type DurableJobEvent, type DurableJobLease, type DurableJobOperation, type DurableJobStage, type DurableJobStatus } from '../../shared/durable-jobs'
import { redactData, redactHandoff, redactSensitive } from './watchdog'

type Row = Record<string, unknown>

/**
 * Who is writing. A controller writes under the lease epoch it acquired; once anyone takes the
 * job over (a restart's reconciliation, or the owner pausing/cancelling) the epoch moves on and
 * every later write from the old holder is rejected with StaleEpochError, inside the same
 * transaction as the write. The owner's own commands (pause, resume, cancel through the service)
 * are the authority and write with { owner: true }.
 */
export type WriteGuard = { epoch: number } | { owner: true }

export class StaleEpochError extends Error {
  constructor(readonly jobId: string, readonly held: number, readonly current: number) {
    super(`Durable job ${jobId} is owned by epoch ${current}; a writer holding epoch ${held} may not modify it`)
    this.name = 'StaleEpochError'
  }
}

export class IllegalTransitionError extends Error {
  constructor(readonly jobId: string, readonly from: DurableJobStatus, readonly to: DurableJobStatus) {
    super(`Durable job ${jobId} cannot move from ${from} to ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export class LeaseHeldError extends Error {
  constructor(readonly jobId: string, readonly lease: DurableJobLease) {
    super(`Durable job ${jobId} is leased by ${lease.ownerId} until ${lease.expiresAt}`)
    this.name = 'LeaseHeldError'
  }
}

export interface StoredJob extends DurableJob {
  /** Store-internal: the owner supplied the stage plan (so the controller finishes after the last one). */
  planned: boolean
}

const json = <T>(value: unknown): T => JSON.parse(String(value)) as T

/** Model and tool text never reaches the store unredacted: handoffs, stage results and errors,
 *  status reasons, operation descriptions and every event (watchdog.ts redaction). */
const cleanPatch = <T extends { handoff?: DurableJob['handoff'] }>(patch: T): T => patch.handoff ? { ...patch, handoff: redactHandoff(patch.handoff) } : patch
const cleanStage = (stage: DurableJobStage, text: Array<'title' | 'objective'> = []): DurableJobStage => {
  const clean: DurableJobStage = { ...stage, ...(stage.result !== undefined ? { result: redactSensitive(stage.result) } : {}), ...(stage.error !== undefined ? { error: redactSensitive(stage.error) } : {}) }
  for (const key of text) clean[key] = redactSensitive(stage[key])
  return clean
}

const eventField = (key: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid event data field: ${key}`)
  return key
}

/** A predicate over durable job events. Matching is done in the query, not by discarding a prefix. */
export interface DurableJobEventMatch {
  kind: DurableJobEvent['kind']
  /** Only events whose data.stageId equals this id. */
  stageId?: string
  /** Each value must equal event.data[key]. */
  dataEquals?: Record<string, string | number>
  /** event.data[key] must be this JSON type. `number` matches integer or real. */
  dataType?: Record<string, 'string' | 'number' | 'boolean'>
}

/**
 * Durable jobs live in the app's own conductor.db beside orchestration and schedules. Every row
 * carries its full contract object as JSON plus the columns the queries index on. Every mutation
 * runs in one IMMEDIATE transaction that re-reads the job's lease epoch first, so a transition,
 * its event and the guard check are atomic.
 */
export class DurableJobStore {
  private readonly db: DatabaseSync
  private readonly listeners = new Set<(jobId: string) => void>()
  private depth = 0
  private dirty = new Set<string>()

  constructor(path: string | DatabaseSync, private readonly clock: () => Date = () => new Date()) {
    if (typeof path === 'string') {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
    } else this.db = path
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        planned INTEGER NOT NULL DEFAULT 0,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires TEXT,
        running_since TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durable_jobs_status_idx ON durable_jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS durable_jobs_project_idx ON durable_jobs(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS durable_job_stages (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
        stage_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempt_base INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        UNIQUE(job_id, stage_index)
      );
      CREATE TABLE IF NOT EXISTS durable_job_checkpoints (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durable_job_checkpoints_job_idx ON durable_job_checkpoints(job_id, created_at);
      CREATE TABLE IF NOT EXISTS durable_job_operations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        status TEXT NOT NULL,
        intended_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durable_job_operations_job_idx ON durable_job_operations(job_id, status, intended_at);
      CREATE TABLE IF NOT EXISTS durable_job_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durable_job_events_job_idx ON durable_job_events(job_id, seq);
    `)
  }

  /** Fires after every committed change with the job id (the service turns it into onChange). */
  onChange(listener: (jobId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private now(): string { return this.clock().toISOString() }

  private transaction<T>(jobId: string, work: () => T): T {
    if (this.depth > 0) { this.dirty.add(jobId); return work() }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    this.dirty.add(jobId)
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.dirty.clear()
      throw error
    } finally {
      this.depth--
      if (this.depth === 0) {
        const changed = [...this.dirty]
        this.dirty.clear()
        for (const id of changed) for (const listener of this.listeners) { try { listener(id) } catch (error) { console.warn('Durable job listener failed', error) } }
      }
    }
  }

  private row(jobId: string): Row {
    const row = this.db.prepare('SELECT * FROM durable_jobs WHERE id = ?').get(jobId) as Row | undefined
    if (!row) throw new Error(`Durable job not found: ${jobId}`)
    return row
  }

  private mapJob(row: Row): StoredJob {
    const job = json<DurableJob>(row.data)
    const lease: DurableJobLease | undefined = row.lease_owner ? { epoch: Number(row.lease_epoch), ownerId: String(row.lease_owner), expiresAt: String(row.lease_expires) } : undefined
    return { ...job, status: row.status as DurableJobStatus, lease, planned: Number(row.planned) === 1 }
  }

  private check(jobId: string, guard: WriteGuard): Row {
    const row = this.row(jobId)
    if ('epoch' in guard && Number(row.lease_epoch) !== guard.epoch) throw new StaleEpochError(jobId, guard.epoch, Number(row.lease_epoch))
    return row
  }

  private saveJob(job: DurableJob, row: Row, extra: { runningSince?: string | null } = {}): void {
    const { lease: _lease, planned: _planned, ...data } = job as StoredJob
    const runningSince = extra.runningSince === undefined ? (row.running_since as string | null) : extra.runningSince
    this.db.prepare('UPDATE durable_jobs SET status = ?, running_since = ?, updated_at = ?, data = ? WHERE id = ?')
      .run(job.status, runningSince, job.updatedAt, JSON.stringify(data), job.id)
  }

  private insertEvent(jobId: string, kind: DurableJobEvent['kind'], message: string, data?: Record<string, unknown>): DurableJobEvent {
    const event: DurableJobEvent = { id: makeId('jobevt'), jobId, at: this.now(), kind, message: redactSensitive(message).slice(0, 4_000), ...(data ? { data: redactData(data) } : {}) }
    this.db.prepare('INSERT INTO durable_job_events (id, job_id, at, kind, data) VALUES (?, ?, ?, ?, ?)').run(event.id, jobId, event.at, kind, JSON.stringify(event))
    return event
  }

  // ---- creation and reads -------------------------------------------------------------------

  create(job: DurableJob, stages: DurableJobStage[], planned: boolean): StoredJob {
    return this.transaction(job.id, () => {
      const { lease: _lease, ...data } = job
      this.db.prepare('INSERT INTO durable_jobs (id, project_id, status, planned, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(job.id, job.projectId, job.status, planned ? 1 : 0, job.createdAt, job.updatedAt, JSON.stringify(data))
      for (const stage of stages) this.insertStage(stage)
      this.insertEvent(job.id, 'transition', `Created as ${job.status}`, { to: job.status })
      return this.get(job.id)
    })
  }

  get(jobId: string): StoredJob { return this.mapJob(this.row(jobId)) }

  has(jobId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM durable_jobs WHERE id = ?').get(jobId)) }

  list(filter: { projectId?: string; status?: DurableJobStatus[] } = {}): StoredJob[] {
    const clauses: string[] = [], params: string[] = []
    if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId) }
    if (filter.status?.length) { clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`); params.push(...filter.status) }
    const sql = `SELECT * FROM durable_jobs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 500`
    return (this.db.prepare(sql).all(...params) as Row[]).map(row => this.mapJob(row))
  }

  stages(jobId: string): DurableJobStage[] {
    return (this.db.prepare('SELECT data FROM durable_job_stages WHERE job_id = ? ORDER BY stage_index').all(jobId) as Row[]).map(row => json<DurableJobStage>(row.data))
  }

  stage(stageId: string): DurableJobStage {
    const row = this.db.prepare('SELECT data FROM durable_job_stages WHERE id = ?').get(stageId) as Row | undefined
    if (!row) throw new Error(`Durable job stage not found: ${stageId}`)
    return json<DurableJobStage>(row.data)
  }

  /** Attempts already spent before the owner last granted new ones (resume after exhaustion). */
  attemptBase(stageId: string): number {
    return Number((this.db.prepare('SELECT attempt_base FROM durable_job_stages WHERE id = ?').get(stageId) as Row | undefined)?.attempt_base ?? 0)
  }

  /** The owner's resume grants a stage a fresh set of maxStageAttempts on top of those spent. */
  grantAttempts(jobId: string, guard: WriteGuard, stageId: string): void {
    this.transaction(jobId, () => {
      this.check(jobId, guard)
      const stage = this.stage(stageId)
      this.db.prepare('UPDATE durable_job_stages SET attempt_base = ? WHERE id = ?').run(stage.attempt, stageId)
      this.insertEvent(jobId, 'note', `New attempts granted for stage ${stage.index + 1} after ${stage.attempt} spent`, { stageId })
    })
  }

  /** A context rollover that made progress in its own fresh context credits the attempt it just
   *  spent back, one at a time, so a stage that keeps progressing across contexts never exhausts
   *  maxStageAttempts on rollovers alone (a rollover with nothing to show for its context is not
   *  credited, and counts normally). */
  creditAttempt(jobId: string, guard: WriteGuard, stageId: string): void {
    this.transaction(jobId, () => {
      this.check(jobId, guard)
      const base = this.attemptBase(stageId)
      this.db.prepare('UPDATE durable_job_stages SET attempt_base = ? WHERE id = ?').run(base + 1, stageId)
    })
  }

  checkpoints(jobId: string): DurableJobCheckpoint[] {
    return (this.db.prepare('SELECT data FROM durable_job_checkpoints WHERE job_id = ? ORDER BY created_at, rowid').all(jobId) as Row[]).map(row => json<DurableJobCheckpoint>(row.data))
  }

  operations(jobId: string, status?: DurableJobOperation['status']): DurableJobOperation[] {
    const rows = status
      ? this.db.prepare('SELECT data FROM durable_job_operations WHERE job_id = ? AND status = ? ORDER BY intended_at, rowid').all(jobId, status)
      : this.db.prepare('SELECT data FROM durable_job_operations WHERE job_id = ? ORDER BY intended_at, rowid').all(jobId)
    return (rows as Row[]).map(row => json<DurableJobOperation>(row.data))
  }

  events(jobId: string, afterId?: string, limit = 200): DurableJobEvent[] {
    const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const after = afterId ? (this.db.prepare('SELECT seq FROM durable_job_events WHERE id = ? AND job_id = ?').get(afterId, jobId) as Row | undefined)?.seq : 0
    if (after === undefined) throw new Error('Unknown event id for this job')
    return (this.db.prepare('SELECT data FROM durable_job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(jobId, Number(after), bounded) as Row[]).map(row => json<DurableJobEvent>(row.data))
  }

  /**
   * The job's newest `limit` events (at most 1000), oldest first: one indexed read however long
   * the history is, for a view that shows the latest activity. Forward paging stays events().
   */
  latestEvents(jobId: string, limit: number): DurableJobEvent[] {
    const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)))
    return (this.db.prepare('SELECT data FROM durable_job_events WHERE job_id = ? ORDER BY seq DESC LIMIT ?').all(jobId, bounded) as Row[]).reverse().map(row => json<DurableJobEvent>(row.data))
  }

  /**
   * Events that match, oldest first. `limit` keeps the newest matches and still returns them
   * oldest first, so a later budget note, retry or replan is not hidden behind earlier rows.
   * Omit `limit` to return every match. Clients that page with afterId keep using events().
   */
  matchingEvents(jobId: string, match: DurableJobEventMatch, limit?: number): DurableJobEvent[] {
    const clauses = ['job_id = ?', 'kind = ?']
    const params: Array<string | number> = [jobId, match.kind]
    if (match.stageId !== undefined) {
      clauses.push(`json_extract(data, '$.data.stageId') = ?`)
      params.push(match.stageId)
    }
    for (const [key, value] of Object.entries(match.dataEquals ?? {})) {
      clauses.push(`json_extract(data, '$.data.${eventField(key)}') = ?`)
      params.push(value)
    }
    for (const [key, type] of Object.entries(match.dataType ?? {})) {
      const path = `$.data.${eventField(key)}`
      if (type === 'string') clauses.push(`json_type(data, '${path}') = 'text'`)
      else if (type === 'number') clauses.push(`json_type(data, '${path}') IN ('integer', 'real')`)
      else if (type === 'boolean') clauses.push(`json_type(data, '${path}') IN ('true', 'false')`)
      else throw new Error(`Unsupported event data type: ${type}`)
    }
    const capped = limit === undefined || !Number.isFinite(limit) ? undefined : Math.max(1, Math.floor(limit))
    const sql = `SELECT data FROM durable_job_events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC${capped === undefined ? '' : ' LIMIT ?'}`
    if (capped !== undefined) params.push(capped)
    return (this.db.prepare(sql).all(...params) as Row[]).reverse().map(row => json<DurableJobEvent>(row.data))
  }

  lastEvent(jobId: string): DurableJobEvent | undefined {
    const row = this.db.prepare('SELECT data FROM durable_job_events WHERE job_id = ? ORDER BY seq DESC LIMIT 1').get(jobId) as Row | undefined
    return row ? json<DurableJobEvent>(row.data) : undefined
  }

  // ---- lease ----------------------------------------------------------------------------------

  /**
   * Takes the job for `ownerId`. The same owner renews in place. Another owner's unexpired lease
   * is refused unless `takeover` is set (reconciliation after an app restart: Conductor holds a
   * single-instance lock, so a lease held by a different launch id belongs to a dead process).
   * Any change of owner increments the epoch, which invalidates every write the old holder has
   * not committed yet.
   */
  acquire(jobId: string, ownerId: string, ttlMs: number, options: { takeover?: boolean; reason?: string } = {}): DurableJobLease {
    return this.transaction(jobId, () => {
      const row = this.row(jobId)
      const current = Number(row.lease_epoch)
      const expires = new Date(this.clock().getTime() + ttlMs).toISOString()
      if (row.lease_owner === ownerId && !options.takeover) {
        this.db.prepare('UPDATE durable_jobs SET lease_expires = ? WHERE id = ?').run(expires, jobId)
        return { epoch: current, ownerId, expiresAt: expires }
      }
      const held = row.lease_owner && row.lease_expires && Date.parse(String(row.lease_expires)) > this.clock().getTime()
      if (held && !options.takeover) throw new LeaseHeldError(jobId, { epoch: current, ownerId: String(row.lease_owner), expiresAt: String(row.lease_expires) })
      const epoch = current + 1
      this.db.prepare('UPDATE durable_jobs SET lease_epoch = ?, lease_owner = ?, lease_expires = ? WHERE id = ?').run(epoch, ownerId, expires, jobId)
      this.insertEvent(jobId, 'note', `Lease epoch ${epoch} taken by ${ownerId}${options.reason ? `: ${options.reason}` : ''}`, { epoch, ownerId, previousOwner: row.lease_owner ?? null })
      return { epoch, ownerId, expiresAt: expires }
    })
  }

  /** Extends the running controller's lease; a stale epoch cannot renew. */
  renew(jobId: string, epoch: number, ttlMs: number): DurableJobLease {
    return this.transaction(jobId, () => {
      const row = this.check(jobId, { epoch })
      const expires = new Date(this.clock().getTime() + ttlMs).toISOString()
      this.db.prepare('UPDATE durable_jobs SET lease_expires = ? WHERE id = ?').run(expires, jobId)
      return { epoch, ownerId: String(row.lease_owner), expiresAt: expires }
    })
  }

  /** Ends ownership without changing the epoch: the next acquire takes a new one. */
  release(jobId: string, guard: WriteGuard): void {
    this.transaction(jobId, () => {
      this.check(jobId, guard)
      this.db.prepare('UPDATE durable_jobs SET lease_owner = NULL, lease_expires = NULL WHERE id = ?').run(jobId)
    })
  }

  /** The owner's command supersedes whoever runs the job: epoch+1, no holder. */
  supersede(jobId: string, reason: string): number {
    return this.transaction(jobId, () => {
      const row = this.row(jobId)
      const epoch = Number(row.lease_epoch) + 1
      this.db.prepare('UPDATE durable_jobs SET lease_epoch = ?, lease_owner = NULL, lease_expires = NULL WHERE id = ?').run(epoch, jobId)
      this.insertEvent(jobId, 'note', `Lease epoch ${epoch}: ${reason}`, { epoch })
      return epoch
    })
  }

  // ---- mutations ------------------------------------------------------------------------------

  /**
   * The one way a job's status changes. Illegal moves throw without writing. Active time is
   * accumulated when leaving `running`; startedAt is set on the first run and finishedAt on a
   * terminal status. The event is written in the same transaction. `activeUntil` (epoch ms) ends
   * the running span earlier than now: reconciliation passes when the dead process was last seen,
   * so the time Conductor was down is not counted as active.
   */
  transition(jobId: string, to: DurableJobStatus, reason: string, guard: WriteGuard, patch: Partial<Pick<DurableJob, 'currentStageId' | 'handoff' | 'counters' | 'reportPath'>> = {}, data?: Record<string, unknown>, activeUntil?: number): StoredJob {
    return this.transaction(jobId, () => {
      const row = this.check(jobId, guard)
      const job = this.mapJob(row)
      if (!canTransition(job.status, to)) throw new IllegalTransitionError(jobId, job.status, to)
      const now = this.clock()
      const at = now.toISOString()
      const runningSince = row.running_since ? Date.parse(String(row.running_since)) : undefined
      const next: DurableJob = {
        ...job, ...cleanPatch(patch), status: to, statusReason: redactSensitive(reason), updatedAt: at,
        activeMs: job.activeMs + (job.status === 'running' && runningSince !== undefined ? Math.max(0, Math.min(now.getTime(), activeUntil ?? Infinity) - runningSince) : 0),
        ...(to === 'running' && !job.startedAt ? { startedAt: at } : {}),
        ...(TERMINAL_JOB_STATUSES.includes(to) ? { finishedAt: at } : {})
      }
      this.saveJob(next, row, { runningSince: to === 'running' ? at : null })
      if (TERMINAL_JOB_STATUSES.includes(to)) this.db.prepare('UPDATE durable_jobs SET lease_owner = NULL, lease_expires = NULL WHERE id = ?').run(jobId)
      this.insertEvent(jobId, 'transition', `${job.status} → ${to}: ${reason}`, { from: job.status, to, ...data })
      return this.get(jobId)
    })
  }

  /** Non-status job fields. Terminal jobs stay writable only for reportPath. */
  update(jobId: string, guard: WriteGuard, patch: Partial<Pick<DurableJob, 'currentStageId' | 'handoff' | 'counters' | 'reportPath' | 'worktree' | 'cwd'>>): StoredJob {
    return this.transaction(jobId, () => {
      const row = this.check(jobId, guard)
      const job = this.mapJob(row)
      if (TERMINAL_JOB_STATUSES.includes(job.status) && Object.keys(patch).some(key => key !== 'reportPath')) throw new Error(`Durable job ${jobId} is ${job.status}`)
      this.saveJob({ ...job, ...cleanPatch(patch), updatedAt: this.now() }, row)
      return this.get(jobId)
    })
  }

  /** Adds to counters atomically (read-modify-write inside the guard). */
  count(jobId: string, guard: WriteGuard, deltas: Partial<DurableJob['counters']>): StoredJob {
    return this.transaction(jobId, () => {
      const job = this.mapJob(this.check(jobId, guard))
      const counters = { ...job.counters }
      for (const [key, delta] of Object.entries(deltas) as Array<[keyof DurableJob['counters'], number]>) counters[key] += delta
      return this.update(jobId, guard, { counters })
    })
  }

  private insertStage(stage: DurableJobStage): void {
    this.db.prepare('INSERT INTO durable_job_stages (id, job_id, stage_index, status, data) VALUES (?, ?, ?, ?, ?)').run(stage.id, stage.jobId, stage.index, stage.status, JSON.stringify(stage))
  }

  addStage(jobId: string, guard: WriteGuard, planned: DurableJobStage, message?: string): DurableJobStage {
    // A stage the job planned for itself carries model text in its title and objective.
    const stage = cleanStage(planned, ['title', 'objective'])
    return this.transaction(jobId, () => {
      this.check(jobId, guard)
      this.insertStage(stage)
      this.insertEvent(jobId, 'stage', message ?? `Planned stage ${stage.index + 1}: ${stage.title}`, { stageId: stage.id })
      return stage
    })
  }

  saveStage(jobId: string, guard: WriteGuard, saved: DurableJobStage, event?: { kind: DurableJobEvent['kind']; message: string; data?: Record<string, unknown> }): DurableJobStage {
    const stage = cleanStage(saved)
    return this.transaction(jobId, () => {
      this.check(jobId, guard)
      this.db.prepare('UPDATE durable_job_stages SET status = ?, data = ? WHERE id = ? AND job_id = ?').run(stage.status, JSON.stringify(stage), stage.id, jobId)
      if (event) this.insertEvent(jobId, event.kind, event.message, { stageId: stage.id, ...event.data })
      this.db.prepare('UPDATE durable_jobs SET updated_at = ? WHERE id = ?').run(this.now(), jobId)
      return stage
    })
  }

  /** Records a side effect BEFORE it is executed (status 'intended'). */
  intend(jobId: string, guard: WriteGuard, operation: Pick<DurableJobOperation, 'stageId' | 'kind' | 'description'>): DurableJobOperation {
    return this.transaction(jobId, () => {
      this.check(jobId, guard)
      const op: DurableJobOperation = { id: makeId('jobop'), jobId, ...operation, description: redactSensitive(operation.description).slice(0, 2_000), status: 'intended', intendedAt: this.now() }
      this.db.prepare('INSERT INTO durable_job_operations (id, job_id, stage_id, status, intended_at, data) VALUES (?, ?, ?, ?, ?, ?)').run(op.id, jobId, op.stageId, op.status, op.intendedAt, JSON.stringify(op))
      return op
    })
  }

  /** Records the outcome after execution, or a reconciliation's decision. */
  settle(jobId: string, guard: WriteGuard, operationId: string, status: Exclude<DurableJobOperation['status'], 'intended'>, reconciliation?: string): DurableJobOperation {
    return this.transaction(jobId, () => {
      this.check(jobId, guard)
      const row = this.db.prepare('SELECT data FROM durable_job_operations WHERE id = ? AND job_id = ?').get(operationId, jobId) as Row | undefined
      if (!row) throw new Error(`Durable job operation not found: ${operationId}`)
      const op: DurableJobOperation = { ...json<DurableJobOperation>(row.data), status, settledAt: this.now(), ...(reconciliation ? { reconciliation: redactSensitive(reconciliation).slice(0, 2_000) } : {}) }
      this.db.prepare('UPDATE durable_job_operations SET status = ?, data = ? WHERE id = ?').run(status, JSON.stringify(op), operationId)
      return op
    })
  }

  addCheckpoint(jobId: string, guard: WriteGuard, checkpoint: Omit<DurableJobCheckpoint, 'id' | 'jobId' | 'createdAt'>): DurableJobCheckpoint {
    return this.transaction(jobId, () => {
      this.check(jobId, guard)
      const record: DurableJobCheckpoint = { id: makeId('jobckpt'), jobId, createdAt: this.now(), ...checkpoint }
      this.db.prepare('INSERT INTO durable_job_checkpoints (id, job_id, created_at, data) VALUES (?, ?, ?, ?)').run(record.id, jobId, record.createdAt, JSON.stringify(record))
      this.insertEvent(jobId, 'checkpoint', `Checkpoint: ${record.reason}${record.commit ? ` (${record.commit.slice(0, 12)})` : ''}`, { checkpointId: record.id, commit: record.commit ?? null })
      return record
    })
  }

  event(jobId: string, guard: WriteGuard, kind: DurableJobEvent['kind'], message: string, data?: Record<string, unknown>): DurableJobEvent {
    return this.transaction(jobId, () => {
      this.check(jobId, guard)
      const event = this.insertEvent(jobId, kind, message, data)
      this.db.prepare('UPDATE durable_jobs SET updated_at = ? WHERE id = ?').run(event.at, jobId)
      return event
    })
  }

  /** Runs several guarded writes as one transaction (one onChange notification). */
  batch<T>(jobId: string, work: () => T): T { return this.transaction(jobId, work) }

  /** The instant the current running span began (for elapsed/active figures in summaries). */
  runningSince(jobId: string): string | undefined {
    const value = this.row(jobId).running_since
    return value ? String(value) : undefined
  }

  close(): void { this.db.close() }
}
