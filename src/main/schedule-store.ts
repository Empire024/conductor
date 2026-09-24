import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../shared/models'
import {
  nextDue, SCHEDULE_AGENT_PROVIDERS, SCHEDULE_DEFAULT_TIMEOUT_MS, SCHEDULE_KINDS, SCHEDULE_MAX_MINUTES, SCHEDULE_MIN_MINUTES,
  SCHEDULE_NAME_MAX, SCHEDULE_PROMPT_MAX, SCHEDULE_SCRIPT_DEFAULT_TIMEOUT_SEC, SCHEDULE_SCRIPT_LANGUAGES, SCHEDULE_SCRIPT_MAX_BYTES,
  SCHEDULE_SCRIPT_MAX_PER_TASK, SCHEDULE_SCRIPT_MAX_TIMEOUT_SEC, SCHEDULE_SCRIPT_NAME, SCHEDULE_TIMINGS,
  type CreateScheduleInput, type SaveScheduleScriptInput, type ScheduleAgent, type ScheduleCreator, type ScheduleDefinition,
  type ScheduleKind, type ScheduleModelStep, type ScheduleOutcome, type ScheduleRun, type ScheduleScript, type ScheduleScriptResult,
  type UpdateScheduleInput
} from '../shared/schedules'

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

/** What Conductor seeds for a built-in task (src/main/schedule-builtins). */
export interface BuiltinSchedule {
  kind: Exclude<ScheduleKind, 'agent'>
  name: string
  prompt: string
  everyMinutes: number
  timing: ScheduleDefinition['timing']
  brain: boolean
  timeoutMs: number
  agent: ScheduleAgent | null
  scripts: Array<Required<Omit<SaveScheduleScriptInput, 'language'>> & { language: ScheduleScript['language'] }>
}

export interface RunFinishData {
  digest?: string | null
  validUntil?: string | null
  artifactPath?: string | null
  scripts?: ScheduleScriptResult[]
  churn?: ScheduleModelStep | null
  brain?: ScheduleModelStep | null
}

const RUN_HISTORY = 50
const CONDUCTOR: ScheduleCreator = { kind: 'conductor', title: 'Conductor' }
export const scriptDigest = (content: string): string => createHash('sha256').update(content).digest('hex')

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !value.includes('\0')
const validInterval = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= SCHEDULE_MIN_MINUTES && Number(value) <= SCHEDULE_MAX_MINUTES
const intervalError = `Schedule interval must be between ${SCHEDULE_MIN_MINUTES} minutes and one year`
const plainText = (value: unknown, key: string, maximum: number, required: boolean): string => {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum || required && !value.trim()) throw new Error(`The ${key} must be ${required ? 'non-empty ' : ''}text of up to ${maximum.toLocaleString('en-US')} characters`)
  return required ? value.trim() : value
}
const flag = (value: unknown, key: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`)
  return value
}
export function validAgent(value: unknown): ScheduleAgent | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent must be {provider, model, effort?} or null')
  const agent = value as Record<string, unknown>
  if (Object.keys(agent).some(key => !['provider', 'model', 'effort'].includes(key))) throw new Error('agent accepts only provider, model and effort')
  if (!SCHEDULE_AGENT_PROVIDERS.includes(agent.provider as ScheduleAgent['provider'])) throw new Error(`agent.provider must be one of ${SCHEDULE_AGENT_PROVIDERS.join(', ')}`)
  const model = plainText(agent.model, 'agent model', 200, true)
  if (agent.effort !== undefined && (typeof agent.effort !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(agent.effort))) throw new Error('agent.effort must be an effort id such as low, medium or high')
  return { provider: agent.provider as ScheduleAgent['provider'], model, ...(agent.effort === undefined ? {} : { effort: agent.effort as string }) }
}
const validChurnModel = (value: unknown): string | null => value === null ? null : plainText(value, 'churn model', 200, true)
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

export class ScheduleStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private columns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => String(row.name))
  }

  private migrate(): void {
    const schedulesTable = (name: string): string => `CREATE TABLE ${name} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'agent',
        prompt TEXT NOT NULL DEFAULT '',
        agent TEXT,
        churn_model TEXT,
        brain INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        every_minutes INTEGER NOT NULL,
        timing TEXT NOT NULL DEFAULT 'idle',
        urgent INTEGER NOT NULL DEFAULT 0,
        catch_up TEXT NOT NULL DEFAULT 'collapse',
        timeout_ms INTEGER NOT NULL DEFAULT ${SCHEDULE_DEFAULT_TIMEOUT_MS},
        last_run_at TEXT,
        next_due_at TEXT,
        deferred_at TEXT,
        deferred_reason TEXT,
        created_by TEXT NOT NULL DEFAULT '{"kind":"owner"}',
        delegate_agent_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    const existing = this.columns('schedules')
    if (!existing.length) this.db.exec(schedulesTable('schedules'))
    else if (existing.includes('job_id')) this.rebuildLegacySchedules(schedulesTable('schedules_v2'))
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled, next_due_at);
      CREATE UNIQUE INDEX IF NOT EXISTS schedules_builtin_idx ON schedules(project_id, kind) WHERE kind <> 'agent';
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
      CREATE TABLE IF NOT EXISTS schedule_scripts (
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL,
        content TEXT NOT NULL,
        digest TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'text',
        run_when TEXT NOT NULL DEFAULT 'always',
        timeout_sec INTEGER NOT NULL DEFAULT ${SCHEDULE_SCRIPT_DEFAULT_TIMEOUT_SEC},
        sort_order INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(schedule_id, name)
      );
    `)
    // Run rows written before scheduled tasks existed have none of these; their defaults read as
    // a scheduled run with no script results, which is what they were.
    const runColumns = this.columns('schedule_runs')
    const added: Array<[string, string]> = [['trigger', "TEXT NOT NULL DEFAULT 'schedule'"], ['scripts', "TEXT NOT NULL DEFAULT '[]'"], ['churn', 'TEXT'], ['brain', 'TEXT']]
    for (const [column, definition] of added) if (!runColumns.includes(column)) this.db.exec(`ALTER TABLE schedule_runs ADD COLUMN ${column} ${definition}`)
  }

  /**
   * The first schedules table keyed a schedule by a fixed job id, UNIQUE per project, which a
   * general task list cannot keep. SQLite cannot drop a table constraint, so the table is rebuilt
   * in place (the documented create-copy-drop-rename procedure). Foreign keys are switched off for
   * this connection first: with them on, dropping the old table would cascade into schedule_runs
   * and erase exactly the history the migration must keep. The job id becomes the task kind.
   */
  private rebuildLegacySchedules(createV2: string): void {
    this.db.exec('PRAGMA foreign_keys = OFF')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`DROP TABLE IF EXISTS schedules_v2; ${createV2};`)
        this.db.prepare(`INSERT INTO schedules_v2
          (id, project_id, name, kind, prompt, agent, churn_model, brain, enabled, every_minutes, timing, urgent, catch_up, timeout_ms,
           last_run_at, next_due_at, created_by, created_at, updated_at)
          SELECT id, project_id, name, job_id, '', NULL, NULL, 1, enabled, every_minutes, 'night', 0, catch_up, timeout_ms,
           last_run_at, next_due_at, ?, created_at, updated_at FROM schedules`).run(JSON.stringify(CONDUCTOR))
        this.db.exec('DROP TABLE schedules; ALTER TABLE schedules_v2 RENAME TO schedules;')
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } finally { this.db.exec('PRAGMA foreign_keys = ON') }
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
    if (!row) throw new Error('No scheduled task with that id in this project')
    return this.mapSchedule(row)
  }

  /** A new task is due at once: it runs in the first window the scheduler allows (tonight, or
   *  the next time the owner is away), not one whole interval after it was asked for. */
  create(input: CreateScheduleInput & { createdBy?: ScheduleCreator; kind?: ScheduleKind; timeoutMs?: number }, now = new Date()): ScheduleDefinition {
    if (!validId(input.projectId)) throw new Error('Invalid project')
    const kind = input.kind ?? 'agent'
    if (!SCHEDULE_KINDS.includes(kind)) throw new Error('Invalid scheduled task kind')
    const name = plainText(input.name, 'name', SCHEDULE_NAME_MAX, true)
    const prompt = plainText(input.prompt, 'prompt', SCHEDULE_PROMPT_MAX, false)
    const everyMinutes = input.everyMinutes ?? 1_440
    if (!validInterval(everyMinutes)) throw new Error(intervalError)
    const timing = input.timing ?? 'night'
    if (!SCHEDULE_TIMINGS.includes(timing)) throw new Error(`timing must be ${SCHEDULE_TIMINGS.join(' or ')}`)
    const urgent = input.urgent === undefined ? false : flag(input.urgent, 'urgent')
    const brain = input.brain === undefined ? true : flag(input.brain, 'brain')
    const enabled = input.enabled === undefined ? true : flag(input.enabled, 'enabled')
    const agent = input.agent === undefined ? null : validAgent(input.agent)
    const churnModel = input.churnModel === undefined ? null : validChurnModel(input.churnModel)
    const timeoutMs = input.timeoutMs ?? SCHEDULE_DEFAULT_TIMEOUT_MS
    const id = makeId('schedule'), timestamp = now.toISOString()
    const due = !enabled ? null : kind === 'agent' ? timestamp : new Date(now.getTime() + everyMinutes * 60_000).toISOString()
    try {
      this.db.prepare(`INSERT INTO schedules
        (id, project_id, name, kind, prompt, agent, churn_model, brain, enabled, every_minutes, timing, urgent, catch_up, timeout_ms,
         last_run_at, next_due_at, deferred_at, deferred_reason, created_by, delegate_agent_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collapse', ?, NULL, ?, NULL, NULL, ?, NULL, ?, ?)`)
        .run(id, input.projectId, name, kind, prompt, agent ? JSON.stringify(agent) : null, churnModel, brain ? 1 : 0, enabled ? 1 : 0, everyMinutes,
          timing, urgent ? 1 : 0, timeoutMs, due, JSON.stringify(input.createdBy ?? { kind: 'owner' }), timestamp, timestamp)
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('This project already has that built-in task')
      throw error
    }
    return this.get(input.projectId, id)
  }

  /**
   * Seeds a built-in task once per project and keeps its Conductor-written scripts equal to the
   * ones this build ships. The owner's choices are never overwritten: enabled, cadence, timing,
   * agent and anything else they edited stay. A task migrated from the old fixed job has an empty
   * prompt, which is how its first seeding here is recognised and given the task's defaults.
   */
  ensureBuiltin(projectId: string, spec: BuiltinSchedule, now = new Date()): ScheduleDefinition {
    const existing = this.list(projectId).find(schedule => schedule.kind === spec.kind)
    let schedule = existing ?? this.create({ projectId, kind: spec.kind, name: spec.name, prompt: spec.prompt, everyMinutes: spec.everyMinutes, timing: spec.timing, brain: spec.brain, agent: spec.agent, createdBy: CONDUCTOR, timeoutMs: spec.timeoutMs }, now)
    if (existing && !existing.prompt.trim()) {
      this.db.prepare('UPDATE schedules SET name = ?, prompt = ?, agent = ?, brain = ?, timing = ?, timeout_ms = MAX(timeout_ms, ?), updated_at = ? WHERE id = ?')
        .run(spec.name, spec.prompt, spec.agent ? JSON.stringify(spec.agent) : null, spec.brain ? 1 : 0, spec.timing, spec.timeoutMs, now.toISOString(), existing.id)
      schedule = this.get(projectId, existing.id)
    }
    const shipped = new Set(spec.scripts.map(script => script.name))
    for (const script of this.scripts(schedule.id)) {
      if (script.origin === 'conductor' && !shipped.has(script.name)) this.db.prepare('DELETE FROM schedule_scripts WHERE schedule_id = ? AND name = ?').run(schedule.id, script.name)
    }
    for (const script of spec.scripts) {
      const current = this.script(schedule.id, script.name)
      if (current?.origin === 'conductor' && current.digest === scriptDigest(script.content) && current.timeoutSec === script.timeoutSec && current.order === script.order && current.runWhen === script.runWhen) continue
      this.writeScript(schedule.id, script, 'conductor', CONDUCTOR, now)
    }
    return schedule
  }

  update(projectId: string, scheduleId: string, input: UpdateScheduleInput, now = new Date()): ScheduleDefinition {
    const current = this.get(projectId, scheduleId)
    if (!input || typeof input !== 'object') throw new Error('Invalid scheduled task update')
    const name = input.name === undefined ? current.name : plainText(input.name, 'name', SCHEDULE_NAME_MAX, true)
    const prompt = input.prompt === undefined ? current.prompt : plainText(input.prompt, 'prompt', SCHEDULE_PROMPT_MAX, false)
    if (input.everyMinutes !== undefined && !validInterval(input.everyMinutes)) throw new Error(intervalError)
    if (input.timing !== undefined && !SCHEDULE_TIMINGS.includes(input.timing)) throw new Error(`timing must be ${SCHEDULE_TIMINGS.join(' or ')}`)
    const enabled = input.enabled === undefined ? current.enabled : flag(input.enabled, 'enabled')
    const urgent = input.urgent === undefined ? current.urgent : flag(input.urgent, 'urgent')
    const brain = input.brain === undefined ? current.brain : flag(input.brain, 'brain')
    const agent = input.agent === undefined ? current.agent : validAgent(input.agent)
    const churnModel = input.churnModel === undefined ? current.churnModel : validChurnModel(input.churnModel)
    const everyMinutes = input.everyMinutes ?? current.everyMinutes
    const timing = input.timing ?? current.timing
    // Resuming, or changing the cadence, starts a fresh window; anything else keeps the one it had.
    const next = enabled
      ? (current.enabled && input.everyMinutes === undefined ? current.nextDueAt : new Date(now.getTime() + everyMinutes * 60_000).toISOString())
      : null
    this.db.prepare(`UPDATE schedules SET name = ?, prompt = ?, agent = ?, churn_model = ?, brain = ?, enabled = ?, every_minutes = ?, timing = ?, urgent = ?,
      next_due_at = ?, deferred_at = CASE WHEN ? THEN deferred_at ELSE NULL END, deferred_reason = CASE WHEN ? THEN deferred_reason ELSE NULL END, updated_at = ? WHERE id = ?`)
      .run(name, prompt, agent ? JSON.stringify(agent) : null, churnModel, brain ? 1 : 0, enabled ? 1 : 0, everyMinutes, timing, urgent ? 1 : 0,
        next, enabled ? 1 : 0, enabled ? 1 : 0, now.toISOString(), scheduleId)
    return this.get(projectId, scheduleId)
  }

  remove(projectId: string, scheduleId: string): void {
    const schedule = this.get(projectId, scheduleId)
    if (schedule.kind !== 'agent') throw new Error('A built-in scheduled task cannot be deleted; pause it instead')
    this.db.prepare('DELETE FROM schedules WHERE id = ? AND project_id = ?').run(scheduleId, projectId)
  }

  setDelegate(projectId: string, scheduleId: string, agentSessionId: string, now = new Date()): ScheduleDefinition {
    this.get(projectId, scheduleId)
    if (!validId(agentSessionId)) throw new Error('Invalid conversation')
    this.db.prepare('UPDATE schedules SET delegate_agent_session_id = ?, updated_at = ? WHERE id = ?').run(agentSessionId, now.toISOString(), scheduleId)
    return this.get(projectId, scheduleId)
  }

  /** Records why a due run is being held back. The first deferral of a window is kept so the
   *  owner can see how long it has waited; the reason is always the latest. */
  defer(scheduleId: string, reason: string, now = new Date()): boolean {
    const result = this.db.prepare(`UPDATE schedules SET deferred_at = COALESCE(deferred_at, ?), deferred_reason = ?
      WHERE id = ? AND (deferred_reason IS NULL OR deferred_reason <> ?)`).run(now.toISOString(), reason.slice(0, 500), scheduleId, reason.slice(0, 500))
    return Number(result.changes) > 0
  }

  begin(schedule: ScheduleDefinition, now: Date, trigger: ScheduleRun['trigger'] = 'schedule'): ScheduleRun {
    const id = makeId('schedule-run'), timestamp = now.toISOString()
    const following = nextDue(schedule, now)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO schedule_runs
        (id, schedule_id, started_at, finished_at, outcome, detail, digest, valid_until, artifact_path, trigger, scripts, churn, brain)
        VALUES (?, ?, ?, NULL, 'running', 'Running', NULL, NULL, NULL, ?, '[]', NULL, NULL)`).run(id, schedule.id, timestamp, trigger)
      this.db.prepare('UPDATE schedules SET last_run_at = ?, next_due_at = ?, deferred_at = NULL, deferred_reason = NULL, updated_at = ? WHERE id = ?')
        .run(timestamp, following, timestamp, schedule.id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.run(id)
  }

  recordSkipped(schedule: ScheduleDefinition, now: Date, detail: string, trigger: ScheduleRun['trigger'] = 'schedule'): ScheduleRun {
    const run = this.begin(schedule, now, trigger)
    return this.finish(run.id, 'skipped', detail)
  }

  finish(id: string, outcome: Exclude<ScheduleOutcome, 'running'>, detail: string, data: RunFinishData = {}, now = new Date()): ScheduleRun {
    if (!validId(id)) throw new Error('Invalid run')
    this.db.prepare(`UPDATE schedule_runs SET finished_at = ?, outcome = ?, detail = ?, digest = ?, valid_until = ?, artifact_path = ?, scripts = ?, churn = ?, brain = ?
      WHERE id = ? AND outcome = 'running'`).run(now.toISOString(), outcome, detail.slice(0, 20_000), data.digest ?? null, data.validUntil ?? null, data.artifactPath ?? null,
      JSON.stringify(data.scripts ?? []), data.churn ? JSON.stringify(data.churn) : null, data.brain ? JSON.stringify(data.brain) : null, id)
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

  runs(scheduleId: string, limit = RUN_HISTORY): ScheduleRun[] {
    if (!validId(scheduleId)) throw new Error('Invalid schedule')
    return (this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?').all(scheduleId, Math.max(1, Math.min(RUN_HISTORY, Math.floor(limit)))) as Row[]).map(this.mapRun)
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

  scripts(scheduleId: string): ScheduleScript[] {
    if (!validId(scheduleId)) throw new Error('Invalid schedule')
    return (this.db.prepare('SELECT * FROM schedule_scripts WHERE schedule_id = ? ORDER BY sort_order, name').all(scheduleId) as Row[]).map(this.mapScript)
  }

  script(scheduleId: string, name: string): ScheduleScript | null {
    const row = this.db.prepare('SELECT * FROM schedule_scripts WHERE schedule_id = ? AND name = ?').get(scheduleId, name) as Row | undefined
    return row ? this.mapScript(row) : null
  }

  /** An agent's or the owner's script. The scripts Conductor ships for a built-in task are
   *  replaced only by a newer build, never through here. */
  saveScript(projectId: string, scheduleId: string, input: SaveScheduleScriptInput, origin: 'agent' | 'owner', author: ScheduleCreator, now = new Date()): ScheduleScript {
    this.get(projectId, scheduleId)
    if (!input || typeof input !== 'object') throw new Error('Invalid script')
    const name = typeof input.name === 'string' ? input.name : ''
    if (!SCHEDULE_SCRIPT_NAME.test(name)) throw new Error('A script name is 1-48 lower-case letters, digits and hyphens, starting with a letter or digit')
    const current = this.script(scheduleId, name)
    if (current?.origin === 'conductor') throw new Error(`${name} is a script Conductor ships with this built-in task; add a script under another name instead`)
    if (!current && this.scripts(scheduleId).length >= SCHEDULE_SCRIPT_MAX_PER_TASK) throw new Error(`A scheduled task holds at most ${SCHEDULE_SCRIPT_MAX_PER_TASK} scripts`)
    return this.writeScript(scheduleId, {
      name,
      content: input.content,
      language: input.language ?? current?.language ?? 'node',
      description: input.description ?? current?.description ?? '',
      format: input.format ?? current?.format ?? 'text',
      runWhen: input.runWhen ?? current?.runWhen ?? 'always',
      timeoutSec: input.timeoutSec ?? current?.timeoutSec ?? SCHEDULE_SCRIPT_DEFAULT_TIMEOUT_SEC,
      order: input.order ?? current?.order ?? this.scripts(scheduleId).length
    }, origin, author, now)
  }

  deleteScript(projectId: string, scheduleId: string, name: string): void {
    this.get(projectId, scheduleId)
    const current = this.script(scheduleId, typeof name === 'string' ? name : '')
    if (!current) throw new Error('No script with that name in this task')
    if (current.origin === 'conductor') throw new Error('A script Conductor ships with a built-in task cannot be deleted')
    this.db.prepare('DELETE FROM schedule_scripts WHERE schedule_id = ? AND name = ?').run(scheduleId, current.name)
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

  private writeScript(scheduleId: string, input: Required<Omit<SaveScheduleScriptInput, 'language'>> & { language: ScheduleScript['language'] }, origin: ScheduleScript['origin'], author: ScheduleCreator, now: Date): ScheduleScript {
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.includes('\0') || Buffer.byteLength(input.content) > SCHEDULE_SCRIPT_MAX_BYTES) throw new Error(`Script content must be non-empty text of at most ${SCHEDULE_SCRIPT_MAX_BYTES / 1024} KB`)
    if (!SCHEDULE_SCRIPT_LANGUAGES.includes(input.language)) throw new Error(`language must be ${SCHEDULE_SCRIPT_LANGUAGES.join(' or ')}`)
    if (!['text', 'json'].includes(input.format)) throw new Error('format must be text or json')
    if (!['always', 'changed'].includes(input.runWhen)) throw new Error('runWhen must be always or changed')
    if (!Number.isInteger(input.timeoutSec) || input.timeoutSec < 1 || input.timeoutSec > SCHEDULE_SCRIPT_MAX_TIMEOUT_SEC) throw new Error(`timeoutSec must be a whole number from 1 to ${SCHEDULE_SCRIPT_MAX_TIMEOUT_SEC}`)
    if (!Number.isInteger(input.order) || input.order < 0 || input.order > 1000) throw new Error('order must be a whole number from 0 to 1000')
    const description = plainText(input.description, 'description', 500, false)
    const timestamp = now.toISOString()
    this.db.prepare(`INSERT INTO schedule_scripts
      (schedule_id, name, description, language, content, digest, format, run_when, timeout_sec, sort_order, origin, author, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id, name) DO UPDATE SET description=excluded.description, language=excluded.language, content=excluded.content,
      digest=excluded.digest, format=excluded.format, run_when=excluded.run_when, timeout_sec=excluded.timeout_sec, sort_order=excluded.sort_order,
      origin=excluded.origin, author=excluded.author, updated_at=excluded.updated_at`)
      .run(scheduleId, input.name, description, input.language, input.content, scriptDigest(input.content), input.format, input.runWhen, input.timeoutSec, input.order,
        origin, JSON.stringify(author), timestamp, timestamp)
    return this.script(scheduleId, input.name)!
  }

  private prune(scheduleId: string): void {
    this.db.prepare(`DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN
      (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ${RUN_HISTORY})`).run(scheduleId, scheduleId)
  }
  private mapSchedule = (row: Row): ScheduleDefinition => ({
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), kind: row.kind as ScheduleKind,
    prompt: String(row.prompt ?? ''), agent: parseJson<ScheduleAgent | null>(row.agent, null), churnModel: row.churn_model as string | null,
    brain: Boolean(row.brain), enabled: Boolean(row.enabled), everyMinutes: Number(row.every_minutes),
    timing: SCHEDULE_TIMINGS.includes(row.timing as ScheduleDefinition['timing']) ? row.timing as ScheduleDefinition['timing'] : 'idle',
    urgent: Boolean(row.urgent), catchUp: 'collapse', timeoutMs: Number(row.timeout_ms),
    lastRunAt: row.last_run_at as string | null, nextDueAt: row.next_due_at as string | null,
    deferredAt: row.deferred_at as string | null, deferredReason: row.deferred_reason as string | null,
    createdBy: parseJson<ScheduleCreator>(row.created_by, { kind: 'owner' }), delegateAgentSessionId: row.delegate_agent_session_id as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  })
  private mapRun = (row: Row): ScheduleRun => ({
    id: String(row.id), scheduleId: String(row.schedule_id), startedAt: String(row.started_at), finishedAt: row.finished_at as string | null,
    outcome: row.outcome as ScheduleOutcome, detail: String(row.detail), digest: row.digest as string | null,
    validUntil: row.valid_until as string | null, artifactPath: row.artifact_path as string | null,
    trigger: row.trigger === 'manual' ? 'manual' : 'schedule', scripts: parseJson<ScheduleScriptResult[]>(row.scripts, []),
    churn: parseJson<ScheduleModelStep | null>(row.churn, null), brain: parseJson<ScheduleModelStep | null>(row.brain, null)
  })
  private mapScript = (row: Row): ScheduleScript => ({
    scheduleId: String(row.schedule_id), name: String(row.name), description: String(row.description), language: row.language as ScheduleScript['language'],
    content: String(row.content), digest: String(row.digest), format: row.format === 'json' ? 'json' : 'text', runWhen: row.run_when === 'changed' ? 'changed' : 'always',
    timeoutSec: Number(row.timeout_sec), order: Number(row.sort_order), origin: row.origin as ScheduleScript['origin'],
    author: parseJson<ScheduleCreator>(row.author, { kind: 'owner' }), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  })
  private mapSource = (row: Row): ScheduleSourceState => ({
    scheduleId: String(row.schedule_id), sourceId: String(row.source_id), etag: row.etag as string | null,
    lastModified: row.last_modified as string | null, digest: String(row.digest), normalized: String(row.normalized),
    fetchedAt: String(row.fetched_at), validUntil: String(row.valid_until)
  })
}
