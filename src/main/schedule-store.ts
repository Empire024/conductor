import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../shared/models'
import { nextDue, SCHEDULE_JOB_IDS, type CreateScheduleInput, type ScheduleDefinition, type ScheduleJobId, type ScheduleOutcome, type ScheduleRun, type ScheduleSnapshot, type UpdateScheduleInput } from '../shared/schedules'

type Row = Record<string, unknown>
export interface ScheduleSourceState {
  scheduleId: string
  sourceId: string
  etag: string | null
  lastModified: string | null
  digest: string
  normalized: string
  fetchedAt: string
  validUntil: string
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !value.includes('\0')
const validInterval = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 5 && Number(value) <= 525_600
const jobNames: Record<ScheduleJobId, string> = { 'latest-models-methods': 'Latest models and methods' }

export class ScheduleStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        job_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        every_minutes INTEGER NOT NULL,
        catch_up TEXT NOT NULL DEFAULT 'collapse',
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        last_run_at TEXT,
        next_due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled, next_due_at);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        digest TEXT,
        valid_until TEXT,
        artifact_path TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx ON schedule_runs(schedule_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS schedule_source_state (
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        digest TEXT NOT NULL,
        normalized TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        PRIMARY KEY(schedule_id, source_id)
      );
    `)
  }

  snapshot(projectId: string): ScheduleSnapshot {
    const schedules = this.list(projectId)
    return { schedules, runs: Object.fromEntries(schedules.map(schedule => [schedule.id, this.runs(schedule.id)])) }
  }

  list(projectId: string): ScheduleDefinition[] {
    if (!validId(projectId)) throw new Error('Invalid project')
    return (this.db.prepare('SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at, name COLLATE NOCASE').all(projectId) as Row[]).map(this.mapSchedule)
  }

  all(): ScheduleDefinition[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY next_due_at').all() as Row[]).map(this.mapSchedule)
  }

  get(projectId: string, scheduleId: string): ScheduleDefinition {
    if (!validId(projectId) || !validId(scheduleId)) throw new Error('Invalid schedule')
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ? AND project_id = ?').get(scheduleId, projectId) as Row | undefined
    if (!row) throw new Error('Schedule not found')
    return this.mapSchedule(row)
  }

  create(input: CreateScheduleInput, now = new Date()): ScheduleDefinition {
    if (!validId(input.projectId) || !SCHEDULE_JOB_IDS.includes(input.jobId)) throw new Error('Invalid schedule')
    const everyMinutes = input.everyMinutes ?? 1_440
    if (!validInterval(everyMinutes)) throw new Error('Schedule interval must be between 5 minutes and one year')
    const enabled = input.enabled !== false
    const id = makeId('schedule'), timestamp = now.toISOString()
    const due = enabled ? new Date(now.getTime() + everyMinutes * 60_000).toISOString() : null
    try {
      this.db.prepare(`INSERT INTO schedules
        (id, project_id, name, job_id, enabled, every_minutes, catch_up, timeout_ms, last_run_at, next_due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'collapse', 120000, NULL, ?, ?, ?)`)
        .run(id, input.projectId, jobNames[input.jobId], input.jobId, enabled ? 1 : 0, everyMinutes, due, timestamp, timestamp)
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('This project already has that schedule')
      throw error
    }
    return this.get(input.projectId, id)
  }

  /** Installed migration seed: idempotent, and never re-enables a schedule the owner later disabled. */
  ensureLatestModelsSchedule(projectId: string, now = new Date()): ScheduleDefinition {
    const existing = this.list(projectId).find(schedule => schedule.jobId === 'latest-models-methods')
    return existing ?? this.create({ projectId, jobId: 'latest-models-methods', everyMinutes: 1_440, enabled: true }, now)
  }

  update(projectId: string, scheduleId: string, input: UpdateScheduleInput, now = new Date()): ScheduleDefinition {
    const current = this.get(projectId, scheduleId)
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Invalid enabled setting')
    if (input.everyMinutes !== undefined && !validInterval(input.everyMinutes)) throw new Error('Schedule interval must be between 5 minutes and one year')
    const enabled = input.enabled ?? current.enabled
    const everyMinutes = input.everyMinutes ?? current.everyMinutes
    const next = enabled
      ? (current.enabled && input.everyMinutes === undefined ? current.nextDueAt : new Date(now.getTime() + everyMinutes * 60_000).toISOString())
      : null
    this.db.prepare('UPDATE schedules SET enabled = ?, every_minutes = ?, next_due_at = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, everyMinutes, next, now.toISOString(), scheduleId)
    return this.get(projectId, scheduleId)
  }

  begin(schedule: ScheduleDefinition, now: Date): ScheduleRun {
    const id = makeId('schedule-run'), timestamp = now.toISOString()
    const following = nextDue(schedule, now)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO schedule_runs
        (id, schedule_id, started_at, finished_at, outcome, detail, digest, valid_until, artifact_path)
        VALUES (?, ?, ?, NULL, 'running', 'Running', NULL, NULL, NULL)`).run(id, schedule.id, timestamp)
      this.db.prepare('UPDATE schedules SET last_run_at = ?, next_due_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, following, timestamp, schedule.id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.run(id)
  }

  recordSkipped(schedule: ScheduleDefinition, now: Date, detail: string): ScheduleRun {
    const run = this.begin(schedule, now)
    return this.finish(run.id, 'skipped', detail)
  }

  finish(id: string, outcome: Exclude<ScheduleOutcome, 'running'>, detail: string, data: {digest?: string | null;validUntil?: string | null;artifactPath?: string | null} = {}, now = new Date()): ScheduleRun {
    if (!validId(id)) throw new Error('Invalid run')
    this.db.prepare(`UPDATE schedule_runs SET finished_at = ?, outcome = ?, detail = ?, digest = ?, valid_until = ?, artifact_path = ?
      WHERE id = ? AND outcome = 'running'`).run(now.toISOString(), outcome, detail.slice(0, 20_000), data.digest ?? null, data.validUntil ?? null, data.artifactPath ?? null, id)
    const run = this.run(id)
    this.prune(run.scheduleId)
    return run
  }

  reconcileInterrupted(now = new Date(), activeRunIds: ReadonlySet<string> = new Set()): ScheduleRun[] {
    const rows = this.db.prepare(`SELECT r.id, r.started_at, s.timeout_ms FROM schedule_runs r
      JOIN schedules s ON s.id = r.schedule_id WHERE r.outcome = 'running'`).all() as Row[]
    const reconciled: ScheduleRun[] = []
    for (const row of rows) {
      const id = String(row.id)
      if (!activeRunIds.has(id) && now.getTime() - Date.parse(String(row.started_at)) > Number(row.timeout_ms)) {
        reconciled.push(this.finish(id, 'failed', 'The app stopped before this scheduled run finished.', {}, now))
      }
    }
    return reconciled
  }

  runs(scheduleId: string): ScheduleRun[] {
    if (!validId(scheduleId)) throw new Error('Invalid schedule')
    return (this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 50').all(scheduleId) as Row[]).map(this.mapRun)
  }

  run(id: string): ScheduleRun {
    const row = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Schedule run not found')
    return this.mapRun(row)
  }

  runForProject(projectId: string, runId: string): ScheduleRun {
    const row = this.db.prepare(`SELECT r.* FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id
      WHERE r.id = ? AND s.project_id = ?`).get(runId, projectId) as Row | undefined
    if (!row) throw new Error('Schedule run not found')
    return this.mapRun(row)
  }

  source(scheduleId: string, sourceId: string): ScheduleSourceState | null {
    const row = this.db.prepare('SELECT * FROM schedule_source_state WHERE schedule_id = ? AND source_id = ?').get(scheduleId, sourceId) as Row | undefined
    return row ? this.mapSource(row) : null
  }

  saveSource(state: ScheduleSourceState): void {
    this.db.prepare(`INSERT INTO schedule_source_state
      (schedule_id, source_id, etag, last_modified, digest, normalized, fetched_at, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id, source_id) DO UPDATE SET etag=excluded.etag, last_modified=excluded.last_modified,
      digest=excluded.digest, normalized=excluded.normalized, fetched_at=excluded.fetched_at, valid_until=excluded.valid_until`)
      .run(state.scheduleId, state.sourceId, state.etag, state.lastModified, state.digest, state.normalized, state.fetchedAt, state.validUntil)
  }

  close(): void { this.db.close() }

  private prune(scheduleId: string): void {
    this.db.prepare(`DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN
      (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 50)`).run(scheduleId, scheduleId)
  }
  private mapSchedule = (row: Row): ScheduleDefinition => ({
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), jobId: row.job_id as ScheduleJobId,
    enabled: Boolean(row.enabled), everyMinutes: Number(row.every_minutes), catchUp: 'collapse', timeoutMs: Number(row.timeout_ms),
    lastRunAt: row.last_run_at as string | null, nextDueAt: row.next_due_at as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  })
  private mapRun = (row: Row): ScheduleRun => ({
    id: String(row.id), scheduleId: String(row.schedule_id), startedAt: String(row.started_at), finishedAt: row.finished_at as string | null,
    outcome: row.outcome as ScheduleOutcome, detail: String(row.detail), digest: row.digest as string | null,
    validUntil: row.valid_until as string | null, artifactPath: row.artifact_path as string | null
  })
  private mapSource = (row: Row): ScheduleSourceState => ({
    scheduleId: String(row.schedule_id), sourceId: String(row.source_id), etag: row.etag as string | null,
    lastModified: row.last_modified as string | null, digest: String(row.digest), normalized: String(row.normalized),
    fetchedAt: String(row.fetched_at), validUntil: String(row.valid_until)
  })
}
