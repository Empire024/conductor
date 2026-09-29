import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../../shared/models'
import {
  MODEL_ROLES, PRODUCTION_RUN_RETENTION, PRODUCTION_TABLES as T, RUN_TRANSITIONS, TERMINAL_RUN_STATUSES,
  type ApplicabilityDecision, type AuditBudget, type ProductionRunEvent, type ProductionRunEventKind, type AuditRun, type AuditTrigger, type BudgetLedger, type ControlId, type ControlResult,
  type Finding, type FindingDraft, type FindingStatus, type ModelCallRecord, type ReviewAnswerRecord, type ModelRole, type MutationKind, type ProductionProfile,
  type RouteCoverage, type RunCheckpoint, type RunKind, type RunOperation, type RunStatus, type RunStep, type Severity, type StepKind,
  type VerificationRecord, type Waiver, type WaiverRequest
} from '../../shared/production'
import { redactSensitive } from '../durable-jobs/watchdog'
import { findingId, sameTarget } from './fingerprint'
import { defaultProfile, liveWriteAuthorization, profileProblems } from './profile'
import { controlDefinition } from './registry'

/**
 * Production audit storage in the app's conductor.db (docs/production-agent.md sections 3 and 6).
 *
 * The patterns are durable jobs' (src/main/durable-jobs/store.ts): every row keeps its contract
 * object as JSON beside the columns the queries index on; every mutation runs in one IMMEDIATE
 * transaction that re-reads the run's lease epoch first, so a transition, its event and the guard
 * check are atomic; the side-effect ledger journals a mutation as `intended` before it happens.
 *
 * conductor.db is multi-gigabyte (the owner journal), so every query here is on an index that
 * starts with the id or project it filters by, and every list is LIMITed.
 */

type Row = Record<string, unknown>
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T

/** Who is writing a run: the runner under the lease epoch it acquired, or the owner's command. */
export type WriteGuard = { epoch: number } | { owner: true }
export const OWNER: WriteGuard = { owner: true }

export interface RunLease { epoch: number; ownerId: string; expiresAt: string }

export class StaleEpochError extends Error {
  constructor(readonly runId: string, readonly held: number, readonly current: number) {
    super(`Production run ${runId} is owned by epoch ${current}; a writer holding epoch ${held} may not modify it`)
    this.name = 'StaleEpochError'
  }
}
export class IllegalTransitionError extends Error {
  constructor(readonly runId: string, readonly from: RunStatus, readonly to: RunStatus) {
    super(`Production run ${runId} cannot move from ${from} to ${to}`)
    this.name = 'IllegalTransitionError'
  }
}
export class LeaseHeldError extends Error {
  constructor(readonly runId: string, readonly lease: RunLease) {
    super(`Production run ${runId} is leased by ${lease.ownerId} until ${lease.expiresAt}`)
    this.name = 'LeaseHeldError'
  }
}
export class ActiveRunError extends Error {
  constructor(readonly activeRunId: string, projectId: string, environmentId: string) {
    super(`Run ${activeRunId} is already active for ${projectId}/${environmentId}; a new trigger sets rerunRequested on it instead of starting a second run`)
    this.name = 'ActiveRunError'
  }
}
export class WriteNotAuthorizedError extends Error {
  constructor(readonly mutation: MutationKind, environmentId: string) {
    super(`Sandbox write authorization required for ${mutation} in environment ${environmentId}; the owner or a wizard grants one with production.writes.authorize (never on production)`)
    this.name = 'WriteNotAuthorizedError'
  }
}
export class ProfileInvariantError extends Error {
  constructor(readonly problems: string[]) {
    super(`The production profile was not saved: ${problems.join('; ')}`)
    this.name = 'ProfileInvariantError'
  }
}

export { RUN_EVENT_KINDS, type ProductionRunEvent, type ProductionRunEventKind } from '../../shared/production'

export interface NewRunInput {
  id?: string
  projectId: string
  kind: RunKind
  environmentId: string
  trigger: AuditTrigger
  parentRunId?: string | null
  verifies?: string[]
  fingerprint: AuditRun['fingerprint']
  controls: ControlId[]
  steps: Array<{ kind: StepKind; controlId?: ControlId | null }>
  /** Defaults to the profile's budget. */
  budget?: AuditBudget
  artifactsDir: string
}

export type RunPatch = Partial<Pick<AuditRun, 'ledger' | 'coverage' | 'reportPaths' | 'fingerprint' | 'controls' | 'artifactsDir'>>

export interface FindingFilter {
  environmentId?: string
  status?: FindingStatus[]
  controlId?: ControlId
  severity?: Severity[]
  limit?: number
  offset?: number
}

export interface FindingUpsert { draft: FindingDraft; applicability: ApplicabilityDecision }

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'paused', 'recovering', 'blocked']
const ACTIVE_SQL = ACTIVE_RUN_STATUSES.map(status => `'${status}'`).join(', ')
const TERMINAL_SQL = TERMINAL_RUN_STATUSES.map(status => `'${status}'`).join(', ')
/** Profile versions kept per project; runs record the version they used, so the recent ones stay readable. */
export const PROFILE_HISTORY = 500
const MAX_LIST = 2_000
const bound = (limit: number | undefined, fallback: number, max = MAX_LIST): number => Math.max(1, Math.min(max, Math.floor(limit ?? fallback)))
const text = (value: string, max = 4_000): string => redactSensitive(String(value ?? '')).slice(0, max)

export const emptyLedger = (): BudgetLedger => ({
  tokens: 0, modelCalls: 0, requests: 0, elapsedMs: 0,
  byRole: Object.fromEntries(MODEL_ROLES.map(role => [role, { calls: 0, tokens: 0 }])) as Record<ModelRole, { calls: number; tokens: number }>,
  exhausted: null
})
export const emptyCoverage = (): RouteCoverage => ({ tested: [], sampled: [], excluded: [], unobservable: [] })

export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean => RUN_TRANSITIONS[from].includes(to)

export class ProductionStore {
  private readonly db: DatabaseSync
  private readonly listeners = new Set<(projectId: string) => void>()
  private depth = 0
  private dirty = new Set<string>()

  constructor(path: string | DatabaseSync, private readonly clock: () => Date = () => new Date()) {
    if (typeof path === 'string') {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
    } else this.db = path
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  /** Idempotent: every statement is IF NOT EXISTS, so a second launch (or a second store on the
   *  same file) changes nothing. Project rows cascade: removing a project removes its audits. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${T.profiles} (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        designated INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (project_id, version)
      );
      CREATE TABLE IF NOT EXISTS ${T.runs} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${T.runs}_env_idx ON ${T.runs}(project_id, environment_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS ${T.runs}_project_idx ON ${T.runs}(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ${T.runs}_status_idx ON ${T.runs}(status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS ${T.runs}_active_idx ON ${T.runs}(project_id, environment_id) WHERE status IN (${ACTIVE_SQL});
      CREATE TABLE IF NOT EXISTS ${T.steps} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${T.runs}(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (run_id, step_index)
      );
      CREATE TABLE IF NOT EXISTS ${T.operations} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${T.runs}(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${T.operations}_run_idx ON ${T.operations}(run_id, status, at);
      CREATE TABLE IF NOT EXISTS ${T.results} (
        run_id TEXT NOT NULL REFERENCES ${T.runs}(id) ON DELETE CASCADE,
        control_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, control_id)
      );
      CREATE TABLE IF NOT EXISTS ${T.findings} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL,
        control_id TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${T.findings}_env_idx ON ${T.findings}(project_id, environment_id, status, severity, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ${T.findings}_control_idx ON ${T.findings}(project_id, control_id, status);
      CREATE INDEX IF NOT EXISTS ${T.findings}_recent_idx ON ${T.findings}(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS ${T.waivers} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${T.waivers}_finding_idx ON ${T.waivers}(project_id, finding_id);
      CREATE INDEX IF NOT EXISTS ${T.waivers}_expiry_idx ON ${T.waivers}(project_id, revoked_at, expires_at);
      CREATE TABLE IF NOT EXISTS ${T.modelCalls} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${T.runs}(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${T.modelCalls}_run_idx ON ${T.modelCalls}(run_id, at);
      CREATE TABLE IF NOT EXISTS ${T.events} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES ${T.runs}(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${T.events}_run_idx ON ${T.events}(run_id, seq);
      CREATE TABLE IF NOT EXISTS ${T.reviewAnswers} (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (project_id, environment_id, item_id)
      );
    `)
  }

  /** Fires after every committed change with the project id (the service turns it into PRODUCTION_IPC.changed). */
  onChange(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private now(): string { return this.clock().toISOString() }

  private tx<T>(projectId: string, work: () => T): T {
    this.dirty.add(projectId)
    if (this.depth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
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
        for (const id of changed) for (const listener of this.listeners) { try { listener(id) } catch (error) { console.warn('Production store listener failed', error) } }
      }
    }
  }

  // ---- profiles ---------------------------------------------------------------------------------

  profile(projectId: string): ProductionProfile | null {
    const row = this.db.prepare(`SELECT data FROM ${T.profiles} WHERE project_id = ? ORDER BY version DESC LIMIT 1`).get(projectId) as Row | undefined
    return row ? json<ProductionProfile>(row.data) : null
  }

  profileAt(projectId: string, version: number): ProductionProfile | null {
    const row = this.db.prepare(`SELECT data FROM ${T.profiles} WHERE project_id = ? AND version = ?`).get(projectId, version) as Row | undefined
    return row ? json<ProductionProfile>(row.data) : null
  }

  profileHistory(projectId: string, limit = 50): Array<{ version: number; updatedAt: string; updatedBy: string }> {
    return (this.db.prepare(`SELECT version, updated_at, updated_by FROM ${T.profiles} WHERE project_id = ? ORDER BY version DESC LIMIT ?`).all(projectId, bound(limit, 50, PROFILE_HISTORY)) as Row[])
      .map(row => ({ version: Number(row.version), updatedAt: String(row.updated_at), updatedBy: String(row.updated_by) }))
  }

  /** The latest profile, creating version 1 from defaultProfile when the project has none. */
  ensureProfile(projectId: string, by = 'conductor'): ProductionProfile {
    return this.profile(projectId) ?? this.tx(projectId, () => this.profile(projectId) ?? this.insertProfile(defaultProfile(projectId, this.clock()), 1, by))
  }

  /**
   * The one way a profile changes: `mutate` receives the latest version (or the default profile)
   * and returns the next one; the store writes it as version + 1 with its own timestamp and author,
   * after checking the invariants every caller is held to (no write authorization on production).
   * Every call is a version bump, even when nothing differs.
   */
  mutateProfile(projectId: string, by: string, mutate: (current: ProductionProfile) => ProductionProfile): ProductionProfile {
    return this.tx(projectId, () => {
      const current = this.profile(projectId)
      const base = current ?? defaultProfile(projectId, this.clock())
      const next = mutate(structuredClone(base))
      return this.insertProfile({ ...next, projectId }, (current?.version ?? 0) + 1, by)
    })
  }

  private insertProfile(profile: ProductionProfile, version: number, by: string): ProductionProfile {
    const saved: ProductionProfile = { ...profile, version, updatedAt: this.now(), updatedBy: String(by).slice(0, 200) }
    const problems = profileProblems(saved)
    if (problems.length) throw new ProfileInvariantError(problems)
    this.db.prepare(`INSERT INTO ${T.profiles} (project_id, version, designated, updated_at, updated_by, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(saved.projectId, version, saved.designation.productionReady ? 1 : 0, saved.updatedAt, saved.updatedBy, JSON.stringify(saved))
    if (version > PROFILE_HISTORY) this.db.prepare(`DELETE FROM ${T.profiles} WHERE project_id = ? AND version <= ?`).run(saved.projectId, version - PROFILE_HISTORY)
    return saved
  }

  /** Latest profile of every project that has one (the aggregate queue filters on designation). */
  latestProfiles(options: { designatedOnly?: boolean; limit?: number } = {}): ProductionProfile[] {
    const rows = this.db.prepare(`SELECT p.data, p.designated FROM ${T.profiles} p
      JOIN (SELECT project_id, MAX(version) AS version FROM ${T.profiles} GROUP BY project_id) latest ON latest.project_id = p.project_id AND latest.version = p.version
      ${options.designatedOnly ? 'WHERE p.designated = 1' : ''} LIMIT ?`).all(bound(options.limit, 500)) as Row[]
    return rows.map(row => json<ProductionProfile>(row.data))
  }

  // ---- runs -------------------------------------------------------------------------------------

  private runRow(runId: string): Row {
    const row = this.db.prepare(`SELECT * FROM ${T.runs} WHERE id = ?`).get(runId) as Row | undefined
    if (!row) throw new Error(`Production run not found: ${runId}`)
    return row
  }

  private mapRun(row: Row, steps?: RunStep[]): AuditRun {
    const data = json<Omit<AuditRun, 'steps' | 'status'>>(row.data)
    return { ...data, status: row.status as RunStatus, steps: steps ?? this.steps(String(row.id)) }
  }

  private guarded(runId: string, guard: WriteGuard): Row {
    const row = this.runRow(runId)
    if ('epoch' in guard && Number(row.lease_epoch) !== guard.epoch) throw new StaleEpochError(runId, guard.epoch, Number(row.lease_epoch))
    return row
  }

  private saveRun(run: AuditRun): void {
    const { steps: _steps, status, ...data } = run
    this.db.prepare(`UPDATE ${T.runs} SET status = ?, updated_at = ?, finished_at = ?, data = ? WHERE id = ?`).run(status, this.now(), run.finishedAt, JSON.stringify(data), run.id)
  }

  private insertEvent(runId: string, kind: ProductionRunEventKind, message: string, data?: ProductionRunEvent['data']): void {
    const event = { id: makeId('prevt'), runId, at: this.now(), kind, message: text(message), ...(data ? { data } : {}) }
    this.db.prepare(`INSERT INTO ${T.events} (id, run_id, at, kind, data) VALUES (?, ?, ?, ?, ?)`).run(event.id, runId, event.at, kind, JSON.stringify(event))
  }

  /**
   * Creates a queued run with its steps. One active run per (project, environment) is enforced by
   * a unique partial index, so two racing triggers can never both create one: the loser gets
   * ActiveRunError naming the active run (the caller sets rerunRequested on it instead). The
   * fingerprint must be of the run's own environment, and the environment must be in the profile.
   */
  createRun(input: NewRunInput): AuditRun {
    const id = input.id ?? makeId('prun')
    if (input.fingerprint.environmentId !== input.environmentId) throw new Error(`The fingerprint was computed for ${input.fingerprint.environmentId}, not ${input.environmentId}; results never carry across environments`)
    if (!input.steps.length) throw new Error('A run needs at least one step')
    if (input.kind === 'verify' && !input.verifies?.length) throw new Error('A verify run names the findings it verifies')
    return this.tx(input.projectId, () => {
      const profile = this.profile(input.projectId)
      if (!profile?.environments.some(environment => environment.id === input.environmentId)) throw new Error(`Environment ${input.environmentId} is not in the production profile of ${input.projectId}`)
      const active = this.activeRun(input.projectId, input.environmentId)
      if (active) throw new ActiveRunError(active.id, input.projectId, input.environmentId)
      for (const findingIdValue of input.verifies ?? []) {
        const finding = this.finding(findingIdValue)
        if (!finding || finding.projectId !== input.projectId || finding.environmentId !== input.environmentId) throw new Error(`Finding ${findingIdValue} is not a finding of ${input.projectId}/${input.environmentId}`)
      }
      const at = this.now()
      const run: AuditRun = {
        id, projectId: input.projectId, kind: input.kind, environmentId: input.environmentId, trigger: { ...input.trigger, detail: text(input.trigger.detail, 2_000) },
        parentRunId: input.parentRunId ?? null, verifies: [...(input.verifies ?? [])], fingerprint: input.fingerprint, status: 'queued', statusReason: null,
        controls: [...input.controls], steps: [], checkpoint: { nextStepIndex: 0, doneStepIds: [], at }, budget: { ...(input.budget ?? profile.budget) },
        ledger: emptyLedger(), coverage: emptyCoverage(), artifactsDir: input.artifactsDir, reportPaths: null, createdAt: at, startedAt: null, finishedAt: null, rerunRequested: null
      }
      const { steps: _steps, status: _status, ...data } = run
      this.db.prepare(`INSERT INTO ${T.runs} (id, project_id, environment_id, kind, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, run.projectId, run.environmentId, run.kind, at, at, JSON.stringify(data))
      input.steps.forEach((step, index) => {
        if (step.kind === 'control' && !step.controlId) throw new Error(`Step ${index} is a control step without a controlId`)
        const record: RunStep = { id: `${id}_s${index}`, index, kind: step.kind, controlId: step.controlId ?? null, status: 'pending', attempts: 0, startedAt: null, finishedAt: null, error: null }
        this.db.prepare(`INSERT INTO ${T.steps} (id, run_id, step_index, status, data) VALUES (?, ?, ?, ?, ?)`).run(record.id, id, index, record.status, JSON.stringify(record))
      })
      this.insertEvent(id, 'transition', `Created as queued (${run.kind}, trigger ${run.trigger.kind})`, { to: 'queued' })
      return this.run(id)
    })
  }

  run(runId: string): AuditRun { return this.mapRun(this.runRow(runId)) }

  findRun(runId: string): AuditRun | null {
    const row = this.db.prepare(`SELECT * FROM ${T.runs} WHERE id = ?`).get(runId) as Row | undefined
    return row ? this.mapRun(row) : null
  }

  private withSteps(rows: Row[]): AuditRun[] {
    if (!rows.length) return []
    const ids = rows.map(row => String(row.id))
    const steps = new Map<string, RunStep[]>(ids.map(id => [id, []]))
    for (const row of this.db.prepare(`SELECT run_id, data FROM ${T.steps} WHERE run_id IN (${ids.map(() => '?').join(', ')}) ORDER BY run_id, step_index`).all(...ids) as Row[]) steps.get(String(row.run_id))!.push(json<RunStep>(row.data))
    return rows.map(row => this.mapRun(row, steps.get(String(row.id))))
  }

  /** Newest first; bounded. */
  runs(projectId: string, filter: { environmentId?: string; status?: RunStatus[]; limit?: number } = {}): AuditRun[] {
    const clauses = ['project_id = ?'], params: Array<string | number> = [projectId]
    if (filter.environmentId) { clauses.push('environment_id = ?'); params.push(filter.environmentId) }
    if (filter.status?.length) { clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`); params.push(...filter.status) }
    params.push(bound(filter.limit, 50, 500))
    return this.withSteps(this.db.prepare(`SELECT * FROM ${T.runs} WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params) as Row[])
  }

  /** Runs in the given statuses across every project (reconciliation); bounded. */
  runsByStatus(statuses: RunStatus[], limit = 500): AuditRun[] {
    if (!statuses.length) return []
    return this.withSteps(this.db.prepare(`SELECT * FROM ${T.runs} WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY updated_at LIMIT ?`).all(...statuses, bound(limit, 500)) as Row[])
  }

  activeRun(projectId: string, environmentId: string): AuditRun | null {
    const row = this.db.prepare(`SELECT * FROM ${T.runs} WHERE project_id = ? AND environment_id = ? AND status IN (${ACTIVE_SQL}) LIMIT 1`).get(projectId, environmentId) as Row | undefined
    return row ? this.mapRun(row) : null
  }

  lastCompletedRun(projectId: string, environmentId: string): AuditRun | null {
    const row = this.db.prepare(`SELECT * FROM ${T.runs} WHERE project_id = ? AND environment_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`).get(projectId, environmentId) as Row | undefined
    return row ? this.mapRun(row) : null
  }

  /** The newest terminal run (completed, failed or cancelled): BLOCKED in the gate reads it. */
  lastFinishedRun(projectId: string, environmentId: string): AuditRun | null {
    const row = this.db.prepare(`SELECT * FROM ${T.runs} WHERE project_id = ? AND environment_id = ? AND status IN (${TERMINAL_SQL}) ORDER BY created_at DESC LIMIT 1`).get(projectId, environmentId) as Row | undefined
    return row ? this.mapRun(row) : null
  }

  /**
   * The one way a run's status changes; a move RUN_TRANSITIONS does not list throws without
   * writing. startedAt is set on the first `running`, finishedAt and lease release on a terminal
   * status, and the event is written in the same transaction.
   */
  transition(runId: string, to: RunStatus, reason: string, guard: WriteGuard, patch: RunPatch = {}): AuditRun {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const row = this.guarded(runId, guard)
      const run = this.mapRun(row)
      if (!canTransitionRun(run.status, to)) throw new IllegalTransitionError(runId, run.status, to)
      const at = this.now()
      const terminal = TERMINAL_RUN_STATUSES.includes(to)
      const next: AuditRun = {
        ...run, ...patch, status: to, statusReason: text(reason, 2_000),
        ...(to === 'running' && !run.startedAt ? { startedAt: at } : {}),
        ...(terminal ? { finishedAt: at } : {})
      }
      this.saveRun(next)
      if (terminal) this.db.prepare(`UPDATE ${T.runs} SET lease_owner = NULL, lease_expires = NULL WHERE id = ?`).run(runId)
      this.insertEvent(runId, 'transition', `${run.status} → ${to}: ${reason}`, { from: run.status, to })
      return this.run(runId)
    })
  }

  /** Non-status fields. A terminal run accepts only reportPaths (the report step may finish after). */
  updateRun(runId: string, guard: WriteGuard, patch: RunPatch): AuditRun {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (TERMINAL_RUN_STATUSES.includes(run.status) && Object.keys(patch).some(key => key !== 'reportPaths')) throw new Error(`Production run ${runId} is ${run.status}`)
      if (patch.fingerprint && patch.fingerprint.environmentId !== run.environmentId) throw new Error(`A run of ${run.environmentId} cannot take a fingerprint of ${patch.fingerprint.environmentId}`)
      this.saveRun({ ...run, ...patch })
      return this.run(runId)
    })
  }

  /**
   * Adds to the run's ledger atomically and marks it exhausted when a ceiling is reached (tokens,
   * model calls, requests, duration). Pre-charging a model call's maxTokens and reconciling after
   * are two charges; a negative delta reconciles.
   */
  charge(runId: string, guard: WriteGuard, delta: { tokens?: number; modelCalls?: number; requests?: number; elapsedMs?: number; role?: ModelRole }): BudgetLedger {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new Error(`Production run ${runId} is ${run.status}`)
      const ledger: BudgetLedger = structuredClone(run.ledger)
      ledger.tokens = Math.max(0, ledger.tokens + (delta.tokens ?? 0))
      ledger.modelCalls = Math.max(0, ledger.modelCalls + (delta.modelCalls ?? 0))
      ledger.requests = Math.max(0, ledger.requests + (delta.requests ?? 0))
      ledger.elapsedMs = Math.max(0, ledger.elapsedMs + (delta.elapsedMs ?? 0))
      if (delta.role) {
        const role = ledger.byRole[delta.role] ?? { calls: 0, tokens: 0 }
        ledger.byRole[delta.role] = { calls: Math.max(0, role.calls + (delta.modelCalls ?? 0)), tokens: Math.max(0, role.tokens + (delta.tokens ?? 0)) }
      }
      if (!ledger.exhausted) {
        const limits: Array<[keyof AuditBudget, number, number]> = [['maxTokens', ledger.tokens, run.budget.maxTokens], ['maxModelCalls', ledger.modelCalls, run.budget.maxModelCalls], ['maxRequests', ledger.requests, run.budget.maxRequests], ['maxDurationMs', ledger.elapsedMs, run.budget.maxDurationMs]]
        const hit = limits.find(([, used, limit]) => used >= limit)
        if (hit) {
          ledger.exhausted = hit[0]
          this.insertEvent(runId, 'note', `Budget ${hit[0]} reached (${hit[1]} of ${hit[2]})`, { exhausted: hit[0] })
        }
      }
      this.saveRun({ ...run, ledger })
      return ledger
    })
  }

  /**
   * A trigger that arrived while the run is active: the latest trigger wins and change classes are
   * merged, so any number of triggers coalesce into one follow-up run. Returns null for a terminal
   * run (the caller starts a new run instead). Owner authority: triggers come from anywhere.
   */
  requestRerun(runId: string, trigger: AuditTrigger): AuditRun | null {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.run(runId)
      if (TERMINAL_RUN_STATUSES.includes(run.status)) return null
      const changes = [...new Set([...(run.rerunRequested?.changes ?? []), ...trigger.changes])]
      const merged: AuditTrigger = { ...trigger, detail: text(trigger.detail, 2_000), changes }
      this.saveRun({ ...run, rerunRequested: merged })
      this.insertEvent(runId, 'note', `Rerun requested by a ${trigger.kind} trigger${changes.length ? ` (${changes.join(', ')})` : ''}`, { trigger: trigger.kind })
      return this.run(runId)
    })
  }

  /** Clears and returns a finished run's rerunRequested exactly once (the runner starts one follow-up). */
  takeRerun(runId: string): AuditTrigger | null {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.run(runId)
      if (!run.rerunRequested) return null
      if (!TERMINAL_RUN_STATUSES.includes(run.status)) throw new Error(`Production run ${runId} is still ${run.status}; its rerun starts when it ends`)
      this.saveRun({ ...run, rerunRequested: null })
      return run.rerunRequested
    })
  }

  // ---- lease ------------------------------------------------------------------------------------

  lease(runId: string): RunLease | null {
    const row = this.runRow(runId)
    return row.lease_owner ? { epoch: Number(row.lease_epoch), ownerId: String(row.lease_owner), expiresAt: String(row.lease_expires) } : null
  }

  /**
   * Takes the run for `ownerId`; the same owner renews in place. Another owner's unexpired lease is
   * refused unless `takeover` (reconciliation after a restart: Conductor holds a single-instance
   * lock, so a lease held by a different launch belongs to a dead process). A change of owner
   * increments the epoch, which invalidates every write the old holder has not committed.
   */
  acquire(runId: string, ownerId: string, ttlMs: number, options: { takeover?: boolean; reason?: string } = {}): RunLease {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const row = this.runRow(runId)
      if (TERMINAL_RUN_STATUSES.includes(row.status as RunStatus)) throw new Error(`Production run ${runId} is ${String(row.status)}`)
      const current = Number(row.lease_epoch)
      const expires = new Date(this.clock().getTime() + ttlMs).toISOString()
      if (row.lease_owner === ownerId && !options.takeover) {
        this.db.prepare(`UPDATE ${T.runs} SET lease_expires = ? WHERE id = ?`).run(expires, runId)
        return { epoch: current, ownerId, expiresAt: expires }
      }
      const held = row.lease_owner && row.lease_expires && Date.parse(String(row.lease_expires)) > this.clock().getTime()
      if (held && !options.takeover) throw new LeaseHeldError(runId, { epoch: current, ownerId: String(row.lease_owner), expiresAt: String(row.lease_expires) })
      const epoch = current + 1
      this.db.prepare(`UPDATE ${T.runs} SET lease_epoch = ?, lease_owner = ?, lease_expires = ? WHERE id = ?`).run(epoch, ownerId, expires, runId)
      this.insertEvent(runId, 'lease', `Lease epoch ${epoch} taken by ${ownerId}${options.reason ? `: ${options.reason}` : ''}`, { epoch, ownerId, previousOwner: (row.lease_owner as string | null) ?? null })
      return { epoch, ownerId, expiresAt: expires }
    })
  }

  renew(runId: string, epoch: number, ttlMs: number): RunLease {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const row = this.guarded(runId, { epoch })
      if (!row.lease_owner) throw new StaleEpochError(runId, epoch, Number(row.lease_epoch))
      const expires = new Date(this.clock().getTime() + ttlMs).toISOString()
      this.db.prepare(`UPDATE ${T.runs} SET lease_expires = ? WHERE id = ?`).run(expires, runId)
      return { epoch, ownerId: String(row.lease_owner), expiresAt: expires }
    })
  }

  release(runId: string, guard: WriteGuard): void {
    const projectId = String(this.runRow(runId).project_id)
    this.tx(projectId, () => {
      this.guarded(runId, guard)
      this.db.prepare(`UPDATE ${T.runs} SET lease_owner = NULL, lease_expires = NULL WHERE id = ?`).run(runId)
    })
  }

  /** The owner's pause or cancel supersedes whoever runs it: epoch + 1, no holder. */
  supersede(runId: string, reason: string): number {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const epoch = Number(this.runRow(runId).lease_epoch) + 1
      this.db.prepare(`UPDATE ${T.runs} SET lease_epoch = ?, lease_owner = NULL, lease_expires = NULL WHERE id = ?`).run(epoch, runId)
      this.insertEvent(runId, 'lease', `Lease epoch ${epoch}: ${reason}`, { epoch })
      return epoch
    })
  }

  // ---- steps and checkpoints --------------------------------------------------------------------

  steps(runId: string): RunStep[] {
    return (this.db.prepare(`SELECT data FROM ${T.steps} WHERE run_id = ? ORDER BY step_index`).all(runId) as Row[]).map(row => json<RunStep>(row.data))
  }

  private stepRow(runId: string, stepId: string): RunStep {
    const row = this.db.prepare(`SELECT data FROM ${T.steps} WHERE id = ? AND run_id = ?`).get(stepId, runId) as Row | undefined
    if (!row) throw new Error(`Step ${stepId} is not a step of run ${runId}`)
    return json<RunStep>(row.data)
  }

  private saveStep(runId: string, step: RunStep): void {
    this.db.prepare(`UPDATE ${T.steps} SET status = ?, data = ? WHERE id = ? AND run_id = ?`).run(step.status, JSON.stringify(step), step.id, runId)
  }

  /** Starts a pending or failed step of a running run; a done or skipped step is never repeated. */
  startStep(runId: string, guard: WriteGuard, stepId: string): RunStep {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (run.status !== 'running') throw new Error(`Production run ${runId} is ${run.status}; steps run only while it is running`)
      const step = this.stepRow(runId, stepId)
      if (step.status === 'done' || step.status === 'skipped') throw new Error(`Step ${step.index} (${step.kind}) of run ${runId} is already ${step.status}; a resumed run never repeats it`)
      if (step.status === 'running') throw new Error(`Step ${step.index} of run ${runId} is already running`)
      const next: RunStep = { ...step, status: 'running', attempts: step.attempts + 1, startedAt: this.now(), finishedAt: null, error: null }
      this.saveStep(runId, next)
      this.insertEvent(runId, 'step', `Step ${step.index + 1} started: ${step.kind}${step.controlId ? ` ${step.controlId}` : ''} (attempt ${next.attempts})`, { stepId, index: step.index })
      return next
    })
  }

  /**
   * Finishes a step and writes the checkpoint in the same transaction: nextStepIndex is the first
   * step that is neither done nor skipped, so a restart resumes exactly there. A failed step does
   * not advance the checkpoint.
   */
  finishStep(runId: string, guard: WriteGuard, stepId: string, status: 'done' | 'failed' | 'skipped', error: string | null = null): { step: RunStep; checkpoint: RunCheckpoint } {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new Error(`Production run ${runId} is ${run.status}`)
      const step = this.stepRow(runId, stepId)
      if (step.status !== 'running' && !(status === 'skipped' && step.status === 'pending')) throw new Error(`Step ${step.index} of run ${runId} is ${step.status}, not running`)
      const at = this.now()
      const saved: RunStep = { ...step, status, finishedAt: at, error: error === null ? null : text(error, 2_000) }
      this.saveStep(runId, saved)
      const steps = this.steps(runId)
      const settled = steps.filter(candidate => candidate.status === 'done' || candidate.status === 'skipped')
      const firstOpen = steps.find(candidate => candidate.status !== 'done' && candidate.status !== 'skipped')
      const checkpoint: RunCheckpoint = { nextStepIndex: firstOpen ? firstOpen.index : steps.length, doneStepIds: settled.map(candidate => candidate.id), at }
      this.saveRun({ ...run, checkpoint })
      this.insertEvent(runId, status === 'failed' ? 'step' : 'checkpoint', `Step ${step.index + 1} ${status}${error ? `: ${error}` : ''}; next step ${checkpoint.nextStepIndex + 1} of ${steps.length}`, { stepId, index: step.index, status, nextStepIndex: checkpoint.nextStepIndex })
      return { step: saved, checkpoint }
    })
  }

  /** Steps that were running when the process stopped go back to pending (their attempt stays counted). */
  resetInterruptedSteps(runId: string, guard: WriteGuard, reason: string): RunStep[] {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      this.guarded(runId, guard)
      const reset: RunStep[] = []
      for (const step of this.steps(runId)) {
        if (step.status !== 'running') continue
        const next: RunStep = { ...step, status: 'pending', finishedAt: null, error: text(reason, 2_000) }
        this.saveStep(runId, next)
        reset.push(next)
        this.insertEvent(runId, 'step', `Step ${step.index + 1} (${step.kind}) was interrupted and will run again: ${reason}`, { stepId: step.id, index: step.index })
      }
      return reset
    })
  }

  // ---- operation ledger -------------------------------------------------------------------------

  /**
   * Journals a mutation BEFORE it happens. Refused unless the project's current profile holds a
   * live write authorization for the run's environment naming this mutation kind, which is never
   * the case for a production environment: the refusal is in the tool path, never in a prompt.
   */
  intend(runId: string, guard: WriteGuard, operation: { stepId: string; mutation: MutationKind; target: string }): RunOperation {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (run.status !== 'running') throw new Error(`Production run ${runId} is ${run.status}; nothing is mutated outside a running step`)
      this.stepRow(runId, operation.stepId)
      const profile = this.profile(projectId)
      if (!profile || !liveWriteAuthorization(profile, run.environmentId, operation.mutation, this.clock())) throw new WriteNotAuthorizedError(operation.mutation, run.environmentId)
      const record: RunOperation = { id: makeId('prop'), runId, stepId: operation.stepId, mutation: operation.mutation, target: text(operation.target, 1_000), status: 'intended', at: this.now() }
      this.db.prepare(`INSERT INTO ${T.operations} (id, run_id, step_id, status, at, data) VALUES (?, ?, ?, ?, ?, ?)`).run(record.id, runId, record.stepId, record.status, record.at, JSON.stringify(record))
      this.insertEvent(runId, 'operation', `Intended ${record.mutation} on ${record.target}`, { operationId: record.id, mutation: record.mutation, status: 'intended' })
      return record
    })
  }

  /** Records the outcome after execution, or reconciliation's decision; a settled operation stays settled. */
  settle(runId: string, guard: WriteGuard, operationId: string, status: Exclude<RunOperation['status'], 'intended'>, reconciliation?: string): RunOperation {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      this.guarded(runId, guard)
      const row = this.db.prepare(`SELECT data FROM ${T.operations} WHERE id = ? AND run_id = ?`).get(operationId, runId) as Row | undefined
      if (!row) throw new Error(`Operation ${operationId} is not in run ${runId}`)
      const current = json<RunOperation>(row.data)
      if (current.status !== 'intended') throw new Error(`Operation ${operationId} is already ${current.status}`)
      const record: RunOperation = { ...current, status, at: this.now(), ...(reconciliation ? { reconciliation: text(reconciliation, 2_000) } : {}) }
      this.db.prepare(`UPDATE ${T.operations} SET status = ?, at = ?, data = ? WHERE id = ?`).run(status, record.at, JSON.stringify(record), operationId)
      this.insertEvent(runId, 'operation', `${record.mutation} on ${record.target}: ${status}${reconciliation ? `. ${reconciliation}` : ''}`, { operationId, mutation: record.mutation, status })
      return record
    })
  }

  operations(runId: string, status?: RunOperation['status']): RunOperation[] {
    const rows = status
      ? this.db.prepare(`SELECT data FROM ${T.operations} WHERE run_id = ? AND status = ? ORDER BY at, rowid LIMIT ${MAX_LIST}`).all(runId, status)
      : this.db.prepare(`SELECT data FROM ${T.operations} WHERE run_id = ? ORDER BY at, rowid LIMIT ${MAX_LIST}`).all(runId)
    return (rows as Row[]).map(row => json<RunOperation>(row.data))
  }

  // ---- human-review answers ---------------------------------------------------------------------

  /** Records (or replaces) the answer to one human-review item; results and findings stay as they were. */
  answerReview(record: ReviewAnswerRecord): ReviewAnswerRecord {
    return this.tx(record.projectId, () => {
      const saved: ReviewAnswerRecord = { ...record, note: record.note === null ? null : text(record.note, 2_000) }
      this.db.prepare(`INSERT INTO ${T.reviewAnswers} (project_id, environment_id, item_id, answered_at, data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project_id, environment_id, item_id) DO UPDATE SET answered_at = excluded.answered_at, data = excluded.data`)
        .run(saved.projectId, saved.environmentId, saved.itemId, saved.answeredAt, JSON.stringify(saved))
      return saved
    })
  }

  reviewAnswers(projectId: string, environmentId: string, limit = 1_000): ReviewAnswerRecord[] {
    return (this.db.prepare(`SELECT data FROM ${T.reviewAnswers} WHERE project_id = ? AND environment_id = ? ORDER BY item_id LIMIT ?`).all(projectId, environmentId, bound(limit, 1_000)) as Row[]).map(row => json<ReviewAnswerRecord>(row.data))
  }

  // ---- control results --------------------------------------------------------------------------

  /** Upserts one control's result for the run (a resumed control step overwrites, never duplicates). */
  saveResult(runId: string, guard: WriteGuard, result: ControlResult): ControlResult {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new Error(`Production run ${runId} is ${run.status}`)
      if (result.runId !== runId) throw new Error(`The result names run ${result.runId}, not ${runId}`)
      const saved: ControlResult = { ...result, rationale: text(result.rationale, 8_000) }
      this.db.prepare(`INSERT INTO ${T.results} (run_id, control_id, project_id, environment_id, status, data) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_id, control_id) DO UPDATE SET status = excluded.status, data = excluded.data`)
        .run(runId, result.controlId, projectId, run.environmentId, result.status, JSON.stringify(saved))
      return saved
    })
  }

  results(runId: string): ControlResult[] {
    return (this.db.prepare(`SELECT data FROM ${T.results} WHERE run_id = ? ORDER BY control_id`).all(runId) as Row[]).map(row => json<ControlResult>(row.data))
  }

  // ---- findings ---------------------------------------------------------------------------------

  finding(id: string): Finding | null {
    const row = this.db.prepare(`SELECT data FROM ${T.findings} WHERE id = ?`).get(id) as Row | undefined
    return row ? json<Finding>(row.data) : null
  }

  private saveFinding(finding: Finding): void {
    this.db.prepare(`INSERT INTO ${T.findings} (id, project_id, environment_id, control_id, status, severity, confidence, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET status = excluded.status, severity = excluded.severity, confidence = excluded.confidence, updated_at = excluded.updated_at, data = excluded.data`)
      .run(finding.id, finding.projectId, finding.environmentId, finding.controlId, finding.status, finding.severity, finding.confidence, finding.updatedAt, JSON.stringify(finding))
  }

  /**
   * Upserts the run's findings by stable id. A new finding opens; one seen before keeps its id,
   * first-seen run, task and waiver, takes the new observation, and counts one more occurrence
   * (once per run, so a resumed step upserting again does not double count). A finding that was
   * fixed and reproduces again is reopened. Nothing here marks a finding fixed: only a verify run's
   * VerificationRecord does (recordVerification).
   */
  upsertFindings(runId: string, guard: WriteGuard, entries: FindingUpsert[]): Finding[] {
    const projectId = String(this.runRow(runId).project_id)
    return this.tx(projectId, () => {
      const run = this.mapRun(this.guarded(runId, guard))
      if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new Error(`Production run ${runId} is ${run.status}`)
      const at = this.now()
      const out: Finding[] = []
      for (const { draft, applicability } of entries) {
        const id = findingId({ projectId, environmentId: run.environmentId, controlId: draft.controlId, checkId: draft.checkId, key: draft.key, route: draft.route })
        const clean: FindingDraft = {
          ...draft, title: text(draft.title, 500), expected: text(draft.expected, 4_000), observed: text(draft.observed, 8_000),
          reproduction: draft.reproduction.slice(0, 50).map(line => text(line, 1_000)), proposedFix: text(draft.proposedFix, 4_000)
        }
        const existing = this.finding(id)
        const finding: Finding = existing
          ? {
            ...existing, ...clean, applicability,
            status: existing.status === 'fixed' ? 'reopened' : existing.status,
            occurrences: existing.lastSeenRunId === runId ? existing.occurrences : existing.occurrences + 1,
            lastSeenRunId: runId, lastSeenFingerprint: run.fingerprint, updatedAt: at
          }
          : {
            ...clean, id, projectId, environmentId: run.environmentId, sources: [...controlDefinition(draft.controlId).sources], applicability,
            status: 'open', verification: null, firstSeenRunId: runId, lastSeenRunId: runId, lastSeenFingerprint: run.fingerprint,
            occurrences: 1, taskId: null, waiverId: null, createdAt: at, updatedAt: at
          }
        this.saveFinding(finding)
        if (!existing || existing.status === 'fixed') this.insertEvent(runId, 'finding', `${existing ? 'Reopened' : 'New'} ${finding.severity} finding ${finding.id} (${finding.controlId} ${finding.checkId}): ${finding.title}`, { findingId: finding.id, status: finding.status })
        out.push(finding)
      }
      return out
    })
  }

  /** Bounded, newest first; every filter is on the project index. */
  findings(projectId: string, filter: FindingFilter = {}): Finding[] {
    const { sql, params } = this.findingWhere(projectId, filter)
    params.push(bound(filter.limit, 500), Math.max(0, Math.floor(filter.offset ?? 0)))
    // With a selective filter, `+updated_at` stops SQLite from walking the whole project through
    // recent_idx just to avoid a sort: it seeks env_idx or control_idx and sorts only the matches.
    const order = filter.environmentId || filter.status?.length || filter.severity?.length || filter.controlId ? '+updated_at' : 'updated_at'
    return (this.db.prepare(`SELECT data FROM ${T.findings} WHERE ${sql} ORDER BY ${order} DESC LIMIT ? OFFSET ?`).all(...params) as Row[]).map(row => json<Finding>(row.data))
  }

  findingsByIds(projectId: string, ids: string[]): Finding[] {
    if (!ids.length) return []
    const unique = [...new Set(ids)].slice(0, MAX_LIST)
    return (this.db.prepare(`SELECT data FROM ${T.findings} WHERE id IN (${unique.map(() => '?').join(', ')}) AND +project_id = ?`).all(...unique, projectId) as Row[]).map(row => json<Finding>(row.data))
  }

  /** Counts by status and severity for the gate and the queue, without reading any finding body. */
  findingCounts(projectId: string, environmentId?: string): Array<{ status: FindingStatus; severity: Severity; confidence: Finding['confidence']; count: number }> {
    const rows = environmentId
      ? this.db.prepare(`SELECT status, severity, confidence, COUNT(*) AS count FROM ${T.findings} WHERE project_id = ? AND environment_id = ? GROUP BY status, severity, confidence`).all(projectId, environmentId)
      : this.db.prepare(`SELECT status, severity, confidence, COUNT(*) AS count FROM ${T.findings} WHERE project_id = ? GROUP BY status, severity, confidence`).all(projectId)
    return (rows as Row[]).map(row => ({ status: row.status as FindingStatus, severity: row.severity as Severity, confidence: row.confidence as Finding['confidence'], count: Number(row.count) }))
  }

  private findingWhere(projectId: string, filter: FindingFilter): { sql: string; params: Array<string | number> } {
    const clauses = ['project_id = ?'], params: Array<string | number> = [projectId]
    if (filter.environmentId) { clauses.push('environment_id = ?'); params.push(filter.environmentId) }
    if (filter.status?.length) { clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`); params.push(...filter.status) }
    if (filter.severity?.length) { clauses.push(`severity IN (${filter.severity.map(() => '?').join(', ')})`); params.push(...filter.severity) }
    if (filter.controlId) { clauses.push('control_id = ?'); params.push(filter.controlId) }
    return { sql: clauses.join(' AND '), params }
  }

  /**
   * A verify run's verdict on one finding: `verified-fixed` marks it fixed, `disputed` marks it
   * disputed, `verified-open` and `could-not-verify` leave its status (a waiver stays). Refused
   * unless the verifier run is a `verify` run of the same project and environment that names the
   * finding, and a fix is refused on the fingerprint the finding was last seen at (the artifact did
   * not change, so there is nothing to have fixed).
   */
  recordVerification(record: VerificationRecord): Finding {
    const finding = this.finding(record.findingId)
    if (!finding) throw new Error(`Finding ${record.findingId} not found`)
    return this.tx(finding.projectId, () => {
      const run = this.findRun(record.verifierRunId)
      if (!run || run.kind !== 'verify') throw new Error(`Only a verify run records a verification; ${record.verifierRunId} is ${run ? `a ${run.kind} run` : 'not a run'}`)
      if (run.projectId !== finding.projectId || run.environmentId !== finding.environmentId) throw new Error(`Verify run ${run.id} audits ${run.projectId}/${run.environmentId}, not the finding's ${finding.projectId}/${finding.environmentId}`)
      if (!run.verifies.includes(finding.id)) throw new Error(`Verify run ${run.id} was not opened for finding ${finding.id}`)
      if (record.fingerprint.environmentId !== finding.environmentId) throw new Error('The verification fingerprint is of another environment')
      if (record.status === 'verified-fixed' && sameTarget(record.fingerprint, finding.lastSeenFingerprint)) throw new Error(`Finding ${finding.id}: the artifact is unchanged since it was last seen, so a fix cannot be verified (record could-not-verify: artifact unchanged)`)
      const current = this.finding(finding.id)!
      const status: FindingStatus = record.status === 'verified-fixed' ? 'fixed' : record.status === 'disputed' ? 'disputed' : current.status
      const verification: VerificationRecord = { ...record, disagreement: record.disagreement === null ? null : text(record.disagreement, 4_000) }
      const next: Finding = { ...current, status, verification, updatedAt: this.now() }
      this.saveFinding(next)
      this.insertEvent(run.id, 'finding', `Verification of ${finding.id}: ${record.status}${record.disagreement ? ` (disagreement: ${record.disagreement})` : ''}`, { findingId: finding.id, verification: record.status, status })
      return next
    })
  }

  /** Links the board task created for a finding; never changes the finding's status. */
  linkTask(findingIdValue: string, taskId: string | null): Finding {
    const finding = this.finding(findingIdValue)
    if (!finding) throw new Error(`Finding ${findingIdValue} not found`)
    return this.tx(finding.projectId, () => {
      const next: Finding = { ...this.finding(findingIdValue)!, taskId, updatedAt: this.now() }
      this.saveFinding(next)
      return next
    })
  }

  // ---- waivers ----------------------------------------------------------------------------------

  waiver(id: string): Waiver | null {
    const row = this.db.prepare(`SELECT data FROM ${T.waivers} WHERE id = ?`).get(id) as Row | undefined
    return row ? json<Waiver>(row.data) : null
  }

  /** Active: not revoked and not expired at `now`. Otherwise every waiver, newest first; bounded. */
  waivers(projectId: string, options: { active?: boolean; findingId?: string; limit?: number } = {}): Waiver[] {
    const clauses = ['project_id = ?'], params: Array<string | number> = [projectId]
    if (options.findingId) { clauses.push('finding_id = ?'); params.push(options.findingId) }
    if (options.active) { clauses.push('revoked_at IS NULL AND expires_at > ?'); params.push(this.now()) }
    params.push(bound(options.limit, 500))
    return (this.db.prepare(`SELECT data FROM ${T.waivers} WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...params) as Row[]).map(row => json<Waiver>(row.data))
  }

  /**
   * A waiver preserves the finding and marks it waived. It needs a reason, scope, owner and an
   * expiry in the future, and an owner or wizard grantor that is not the agent whose run found the
   * finding (agents cannot waive their own failures). A fixed finding has nothing to waive; a
   * finding with a live waiver must have it revoked first.
   */
  createWaiver(projectId: string, request: WaiverRequest, grantedBy: Waiver['grantedBy']): Waiver {
    return this.tx(projectId, () => {
      if (grantedBy.kind !== 'owner' && grantedBy.kind !== 'wizard') throw new Error('Only the owner or a wizard tab can grant a waiver')
      for (const key of ['reason', 'scope', 'owner'] as const) if (typeof request[key] !== 'string' || !request[key].trim()) throw new Error(`A waiver needs a ${key}`)
      const expires = Date.parse(request.expiresAt)
      if (!Number.isFinite(expires) || expires <= this.clock().getTime()) throw new Error('A waiver needs an expiresAt in the future')
      const finding = this.finding(request.findingId)
      if (!finding || finding.projectId !== projectId) throw new Error(`Finding ${request.findingId} is not a finding of this project`)
      if (finding.status === 'fixed') throw new Error(`Finding ${finding.id} is verified fixed; there is nothing to waive`)
      const live = this.waivers(projectId, { active: true, findingId: finding.id, limit: 1 })[0]
      if (live) throw new Error(`Finding ${finding.id} already has waiver ${live.id} until ${live.expiresAt}; revoke it first`)
      if (grantedBy.agentSessionId) {
        for (const runId of new Set([finding.firstSeenRunId, finding.lastSeenRunId])) {
          const run = this.findRun(runId)
          if (run?.trigger.by.agentSessionId && run.trigger.by.agentSessionId === grantedBy.agentSessionId) throw new Error(`The conversation that triggered run ${run.id} cannot waive what that run found; the owner or another wizard decides`)
        }
      }
      const waiver: Waiver = {
        id: makeId('pwv'), projectId, findingId: finding.id, reason: text(request.reason, 2_000), scope: text(request.scope, 1_000), owner: text(request.owner, 200),
        grantedBy, grantedAt: this.now(), expiresAt: new Date(expires).toISOString(), revokedAt: null, revokedReason: null
      }
      this.db.prepare(`INSERT INTO ${T.waivers} (id, project_id, finding_id, expires_at, revoked_at, data) VALUES (?, ?, ?, ?, NULL, ?)`).run(waiver.id, projectId, finding.id, waiver.expiresAt, JSON.stringify(waiver))
      this.saveFinding({ ...finding, status: 'waived', waiverId: waiver.id, updatedAt: this.now() })
      return waiver
    })
  }

  revokeWaiver(projectId: string, waiverId: string, reason: string): Waiver {
    return this.tx(projectId, () => {
      const waiver = this.waiver(waiverId)
      if (!waiver || waiver.projectId !== projectId) throw new Error(`Waiver ${waiverId} is not a waiver of this project`)
      if (waiver.revokedAt) throw new Error(`Waiver ${waiverId} was already revoked at ${waiver.revokedAt}`)
      if (!reason.trim()) throw new Error('Revoking a waiver needs a reason')
      const revoked: Waiver = { ...waiver, revokedAt: this.now(), revokedReason: text(reason, 2_000) }
      this.db.prepare(`UPDATE ${T.waivers} SET revoked_at = ?, data = ? WHERE id = ?`).run(revoked.revokedAt, JSON.stringify(revoked), waiverId)
      const finding = this.finding(waiver.findingId)
      if (finding && finding.waiverId === waiverId) this.saveFinding({ ...finding, status: finding.status === 'waived' ? 'open' : finding.status, waiverId: null, updatedAt: this.now() })
      return revoked
    })
  }

  // ---- model calls and events -------------------------------------------------------------------

  /** Journals one interpretation call or refusal (tokens and cost as evaluations record them). */
  recordModelCall(record: ModelCallRecord): ModelCallRecord {
    const projectId = String(this.runRow(record.runId).project_id)
    return this.tx(projectId, () => {
      const saved: ModelCallRecord = { ...record, refused: record.refused === null ? null : text(record.refused, 1_000) }
      this.db.prepare(`INSERT INTO ${T.modelCalls} (id, run_id, role, at, data) VALUES (?, ?, ?, ?, ?)`).run(saved.id, saved.runId, saved.role, saved.at, JSON.stringify(saved))
      this.insertEvent(saved.runId, 'model-call', saved.refused ? `${saved.role} call refused: ${saved.refused}` : `${saved.role} call to ${saved.provider}/${saved.model}: ${saved.inputTokens}+${saved.outputTokens} tokens`, { modelCallId: saved.id, role: saved.role, refused: saved.refused !== null })
      return saved
    })
  }

  modelCalls(runId: string, limit = 200): ModelCallRecord[] {
    return (this.db.prepare(`SELECT data FROM ${T.modelCalls} WHERE run_id = ? ORDER BY at, rowid LIMIT ?`).all(runId, bound(limit, 200)) as Row[]).map(row => json<ModelCallRecord>(row.data))
  }

  event(runId: string, guard: WriteGuard, kind: ProductionRunEventKind, message: string, data?: ProductionRunEvent['data']): void {
    const projectId = String(this.runRow(runId).project_id)
    this.tx(projectId, () => {
      this.guarded(runId, guard)
      this.insertEvent(runId, kind, message, data)
    })
  }

  /** Oldest first after `afterSeq`; bounded to 1000. */
  events(runId: string, afterSeq = 0, limit = 200): ProductionRunEvent[] {
    return (this.db.prepare(`SELECT seq, data FROM ${T.events} WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(runId, afterSeq, bound(limit, 200, 1_000)) as Row[]).map(row => ({ ...json<Omit<ProductionRunEvent, 'seq'>>(row.data), seq: Number(row.seq) }))
  }

  /** The newest `limit` events, oldest first: one indexed read however long the history is. */
  latestEvents(runId: string, limit = 50): ProductionRunEvent[] {
    return (this.db.prepare(`SELECT seq, data FROM ${T.events} WHERE run_id = ? ORDER BY seq DESC LIMIT ?`).all(runId, bound(limit, 50, 1_000)) as Row[]).reverse().map(row => ({ ...json<Omit<ProductionRunEvent, 'seq'>>(row.data), seq: Number(row.seq) }))
  }

  lastEventAt(runId: string): string | null {
    const row = this.db.prepare(`SELECT at FROM ${T.events} WHERE run_id = ? ORDER BY seq DESC LIMIT 1`).get(runId) as Row | undefined
    return row ? String(row.at) : null
  }

  // ---- retention --------------------------------------------------------------------------------

  /**
   * Keeps the newest `keep` finished runs of a project and environment and deletes the rest (steps,
   * operations, results, model calls and events cascade). The last completed run is never removed,
   * because the gate reads it. Returns what was removed so the caller deletes the evidence folders.
   * Findings keep their history: their run ids simply stop resolving.
   */
  pruneRuns(projectId: string, environmentId: string, keep = PRODUCTION_RUN_RETENTION): Array<{ id: string; artifactsDir: string }> {
    return this.tx(projectId, () => {
      const lastCompleted = this.lastCompletedRun(projectId, environmentId)?.id ?? ''
      const rows = this.db.prepare(`SELECT id, data FROM ${T.runs} WHERE project_id = ? AND environment_id = ? AND status IN (${TERMINAL_SQL}) ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(projectId, environmentId, MAX_LIST, Math.max(0, Math.floor(keep))) as Row[]
      const removed = rows.filter(row => String(row.id) !== lastCompleted).map(row => ({ id: String(row.id), artifactsDir: json<AuditRun>(row.data).artifactsDir }))
      for (const run of removed) this.db.prepare(`DELETE FROM ${T.runs} WHERE id = ?`).run(run.id)
      return removed
    })
  }

  /** Several writes as one transaction (one onChange notification). */
  batch<T>(projectId: string, work: () => T): T { return this.tx(projectId, work) }

  private closed = false
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

// ---- reconcile on start -------------------------------------------------------------------------

export interface ReconcileRunsOptions {
  store: ProductionStore
  /** This launch's owner id; a run it already holds is live, not left over. */
  ownerId: string
  leaseTtlMs: number
  /**
   * Durable evidence of an in-flight mutation's outcome, if the runner can read any (a fixture
   * server's mutation log, a sandbox adapter's record). Without evidence the operation is
   * `unknown` and the run blocks for the owner: nothing is replayed.
   */
  evidence?: (operation: RunOperation, run: AuditRun) => { status: 'done' | 'failed'; reason: string } | null
}

export interface ReconcileRunOutcome {
  runId: string
  projectId: string
  /** `resume`: recovering, ready for the runner at its checkpoint; `blocked`: waits for the owner. */
  decision: 'resume' | 'blocked'
  operations: Array<Pick<RunOperation, 'id' | 'mutation' | 'target' | 'status' | 'reconciliation'>>
  resetSteps: string[]
}

/**
 * Reconciliation on app start, as durable jobs do it (src/main/durable-jobs/reconcile.ts). A run
 * that was `running` or `recovering` when Conductor stopped still carries the dead process's
 * lease; Conductor holds a single-instance lock, so any other owner id is dead. For each: take the
 * lease over (new epoch, so nothing the old process might flush is accepted), move running to
 * recovering, settle every `intended` operation from durable evidence or as `unknown`, put steps
 * that were running back to pending (a fresh browser reruns them; control steps are idempotent),
 * and either leave the run recovering to resume at its checkpoint or block it for the owner when a
 * side effect is unknown. A blocked run with an intended operation is settled the same way and
 * stays blocked. Queued and paused runs hold nothing and are left alone.
 */
export function reconcileRuns(options: ReconcileRunsOptions): ReconcileRunOutcome[] {
  const { store } = options
  const outcomes: ReconcileRunOutcome[] = []
  for (const listed of store.runsByStatus(['running', 'recovering', 'blocked'])) {
    const lease = store.lease(listed.id)
    if (lease?.ownerId === options.ownerId) continue
    const intended = store.operations(listed.id, 'intended')
    const interrupted = listed.steps.some(step => step.status === 'running')
    if (listed.status === 'blocked' && !intended.length && !interrupted) continue
    const taken = store.acquire(listed.id, options.ownerId, options.leaseTtlMs, { takeover: true, reason: 'reconciliation after Conductor restarted' })
    const guard: WriteGuard = { epoch: taken.epoch }
    if (listed.status === 'running') store.transition(listed.id, 'recovering', 'Conductor restarted while this run was running', guard)
    store.event(listed.id, guard, 'recovery', `Reconciling after restart; previous owner ${lease?.ownerId ?? 'none'} (epoch ${lease?.epoch ?? 0})`, { previousOwner: lease?.ownerId ?? null, epoch: taken.epoch })
    const run = store.run(listed.id)
    const settled: ReconcileRunOutcome['operations'] = []
    for (const operation of intended) {
      const verdict = options.evidence?.(operation, run) ?? { status: 'unknown' as const, reason: `A ${operation.mutation} on ${operation.target} was in flight when Conductor stopped and no evidence of its outcome was recorded; it is not replayed.` }
      const record = store.settle(run.id, guard, operation.id, verdict.status, verdict.reason)
      settled.push({ id: record.id, mutation: record.mutation, target: record.target, status: record.status, reconciliation: record.reconciliation })
    }
    const resetSteps = store.resetInterruptedSteps(run.id, guard, 'Conductor restarted during this step').map(step => step.id)
    const unknown = settled.filter(operation => operation.status === 'unknown')
    if (unknown.length && run.status !== 'blocked') {
      const targets = unknown.map(operation => `${operation.mutation} on ${operation.target}`).join('; ')
      store.transition(run.id, 'blocked', `A sandbox mutation was in flight when Conductor stopped and its outcome is unknown (${targets}). Nothing was replayed. Check the environment ${run.environmentId}, then resume or cancel the run.`, guard)
    }
    store.release(run.id, guard)
    outcomes.push({ runId: run.id, projectId: run.projectId, decision: unknown.length || run.status === 'blocked' ? 'blocked' : 'resume', operations: settled, resetSteps })
  }
  return outcomes
}
