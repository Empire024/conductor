import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../../shared/models'
import {
  modelKeyId, OUTCOME_RETENTION_DAYS,
  type BenchmarkResult, type DecisionKind, type DecisionRecord, type ExecutionOutcome, type FieldObservation, type ModelKey, type ModelStatus,
  type OutcomeResult, type RegistryChange, type RegistryField, type RegistryRecord, type RegistryValue, type RouteDetails, type SourceKind, type SourceRef, type TaskCategory, type TaskFeatures
} from '../../shared/model-routing'
import { familyOf } from './registry'

type Row = Record<string, unknown>

export const MODEL_INTEL_SCHEMA_VERSION = 2
/** Dispatch bindings kept across restarts: at most this many, for at most this long. */
export const BINDINGS_MAX = 1_000
export const BINDING_TTL_DAYS = 7
export const DECISION_RETENTION_DAYS = 90
const DAY_MS = 86_400_000
/** Every list query is bounded; callers that want more page by time window. */
export const MAX_QUERY_LIMIT = 10_000

const json = <T>(value: unknown): T => JSON.parse(String(value)) as T
const keyOf = (row: Row): ModelKey => ({ provider: String(row.provider), model: String(row.model) })
const bounded = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  return Math.min(limit, MAX_QUERY_LIMIT)
}
const iso = (value: string, name: string): string => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`${name} must be an ISO timestamp`)
  return new Date(time).toISOString()
}

/** One stored observation. `observedAt` is when the source first said this value, `confirmedAt`
 *  the last time it said it again: re-ingesting an unchanged value confirms, never duplicates. */
export interface StoredObservation extends FieldObservation { id: string; confirmedAt: string }

/** The registry row as stored; `stale` is derived on read by the registry, never persisted. */
export type StoredRecord = Omit<RegistryRecord, 'stale'>

/** Which keys a source listed, so a complete source that stops listing one is a removal. */
export interface SourceListing { source: string; kind: SourceKind; key: ModelKey; firstListedAt: string; lastListedAt: string; droppedAt: string | null }

export interface OutcomeQuery { key?: ModelKey; category?: TaskCategory; since: string; until?: string; limit: number }
export interface DecisionQuery { kind?: DecisionKind; since: string; until?: string; limit: number; includeDryRun?: boolean }
/** How often the system-one verdict matched the final answer (the owner's, else the frontier's). */
export interface Agreement { kind: DecisionKind; boundary?: string; since: string; cases: number; agreed: number; rate: number | null }
/** A decision's boundary: its request state's `boundary` (the approval gate's workspace-write or native-owner), else null. */
export const boundaryOf = (record: Pick<DecisionRecord, 'state'>): string | null => typeof record.state?.boundary === 'string' ? record.state.boundary : null
export interface EvaluationSpend { runId: string; key: ModelKey; at: string; tokens: number; costUsd?: number; jobs: number; gradedJobs: number; stoppedBy: string | null; reason?: string }
const spendOf = (value: unknown): EvaluationSpend | null => { try { return JSON.parse(String(value)) as EvaluationSpend } catch { return null } }
/** The system-one verdict of a decision: DecisionService records it; older records carry it as verdicts[0] of two or more. */
export function systemOneOf(record: DecisionRecord): NonNullable<DecisionRecord['systemOne']> | null {
  if (record.systemOne !== undefined) return record.systemOne
  const first = record.verdicts.length >= 2 ? record.verdicts[0]! : undefined
  if (!first) return null
  if ('failed' in first) return { decider: first.decider, choice: null, confidence: 0, failed: first.failed }
  const [choice, confidence] = Object.entries(first.probabilities).sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
  return { decider: first.decider, choice, confidence }
}
/** A dispatched agent's decision and task, so its turns are captured with them after a restart. */
export interface StoredBinding { decisionId: string | null; features: TaskFeatures; key: ModelKey; effort: string | null; projectId: string; at: number }
export interface PruneResult { outcomes: number; decisions: number; complete: boolean }

/**
 * Model intelligence tables inside conductor.db, on its own connection (docs/model-routing.md,
 * Storage). conductor.db is multi-gigabyte, so every query here is on an index and bounded by key
 * and/or time window. Module A owns the schema; the registry, reputation and decision modules
 * reach it only through these methods. It is the ReputationStorePort (reputation-service.ts) as is.
 */
export class ModelIntelligenceStore {
  private readonly db: DatabaseSync
  private depth = 0

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
      CREATE TABLE IF NOT EXISTS model_intel_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_registry (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        family TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_registry_provider_idx ON model_registry(provider, model);
      CREATE INDEX IF NOT EXISTS model_registry_family_idx ON model_registry(family);
      CREATE TABLE IF NOT EXISTS model_observations (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        field TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_url TEXT,
        observed_at TEXT NOT NULL,
        confirmed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_observations_key_idx ON model_observations(key, field, observed_at);
      CREATE INDEX IF NOT EXISTS model_observations_source_idx ON model_observations(key, field, source_name, observed_at);
      CREATE TABLE IF NOT EXISTS model_source_listing (
        source_name TEXT NOT NULL,
        key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        first_listed_at TEXT NOT NULL,
        last_listed_at TEXT NOT NULL,
        dropped_at TEXT,
        PRIMARY KEY (source_name, key)
      );
      CREATE INDEX IF NOT EXISTS model_source_listing_key_idx ON model_source_listing(key);
      CREATE TABLE IF NOT EXISTS model_benchmarks (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        benchmark TEXT NOT NULL,
        score REAL NOT NULL,
        raw TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        source_name TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_benchmarks_key_idx ON model_benchmarks(key, benchmark);
      CREATE TABLE IF NOT EXISTS model_changes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        field TEXT,
        before_json TEXT,
        after_json TEXT,
        source_json TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_changes_at_idx ON model_changes(at);
      CREATE INDEX IF NOT EXISTS model_changes_key_idx ON model_changes(key, at);
      CREATE TABLE IF NOT EXISTS execution_outcomes (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        source TEXT NOT NULL,
        ref TEXT NOT NULL,
        category TEXT NOT NULL,
        at TEXT NOT NULL,
        result TEXT NOT NULL,
        decision_id TEXT,
        project_id TEXT,
        row_json TEXT NOT NULL,
        UNIQUE(source, ref, key)
      );
      CREATE INDEX IF NOT EXISTS execution_outcomes_key_idx ON execution_outcomes(key, category, at);
      CREATE INDEX IF NOT EXISTS execution_outcomes_category_idx ON execution_outcomes(category, at);
      CREATE INDEX IF NOT EXISTS execution_outcomes_at_idx ON execution_outcomes(at);
      CREATE INDEX IF NOT EXISTS execution_outcomes_decision_idx ON execution_outcomes(decision_id) WHERE decision_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        requester TEXT NOT NULL,
        at TEXT NOT NULL,
        choice TEXT,
        confidence REAL NOT NULL,
        decided_by TEXT NOT NULL,
        escalated INTEGER NOT NULL,
        project_id TEXT,
        agent_session_id TEXT,
        record_json TEXT NOT NULL,
        outcome_json TEXT
      );
      CREATE INDEX IF NOT EXISTS routing_decisions_at_idx ON routing_decisions(at);
      CREATE INDEX IF NOT EXISTS routing_decisions_kind_idx ON routing_decisions(kind, at);
      CREATE TABLE IF NOT EXISTS dispatch_bindings (
        agent_session_id TEXT PRIMARY KEY,
        decision_id TEXT,
        at TEXT NOT NULL,
        binding_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatch_bindings_at_idx ON dispatch_bindings(at);
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        run_id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        at TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evaluation_runs_at_idx ON evaluation_runs(at);
    `)
    const version = this.db.prepare("SELECT value FROM model_intel_meta WHERE key = 'schema_version'").get() as Row | undefined
    if (version && Number(version.value) > MODEL_INTEL_SCHEMA_VERSION) throw new Error(`Model intelligence schema ${String(version.value)} is newer than this build (${MODEL_INTEL_SCHEMA_VERSION})`)
    // v2: modelKeyId no longer doubles a local prefix, so v1's `local/local/<id>` keys become `local/<id>`.
    if (version && Number(version.value) < 2) this.transaction(() => {
      for (const table of ['model_registry', 'model_observations', 'model_benchmarks', 'model_changes', 'model_source_listing', 'execution_outcomes'])
        this.db.prepare(`UPDATE ${table} SET key = substr(key, 7) WHERE key LIKE 'local/local/%'`).run()
    })
    // v2: route details and dry runs on decisions (added columns; v1 rows read as none and false).
    const columns = new Set((this.db.prepare('PRAGMA table_info(routing_decisions)').all() as Row[]).map(row => String(row.name)))
    if (!columns.has('route_json')) this.db.exec('ALTER TABLE routing_decisions ADD COLUMN route_json TEXT')
    if (!columns.has('dry_run')) this.db.exec('ALTER TABLE routing_decisions ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0')
    this.db.prepare("INSERT INTO model_intel_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(MODEL_INTEL_SCHEMA_VERSION))
  }

  schemaVersion(): number {
    return Number((this.db.prepare("SELECT value FROM model_intel_meta WHERE key = 'schema_version'").get() as Row).value)
  }

  now(): Date { return this.clock() }

  /** One IMMEDIATE transaction; nested calls join the outer one, and a throw anywhere rolls all of it back. */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally { this.depth-- }
  }

  close(): void { this.db.close() }

  // -------------------------------------------------------------------------------------------
  // Registry rows (the registry derives them; see registry.ts)

  record(key: ModelKey | string): StoredRecord | null {
    const row = this.db.prepare('SELECT * FROM model_registry WHERE key = ?').get(typeof key === 'string' ? key : modelKeyId(key)) as Row | undefined
    return row ? this.mapRecord(row) : null
  }

  records(filter: { provider?: string; model?: string; family?: string; status?: ModelStatus; limit?: number } = {}): StoredRecord[] {
    const where: string[] = [], args: string[] = []
    if (filter.provider !== undefined) { where.push('provider = ?'); args.push(filter.provider) }
    if (filter.model !== undefined) { where.push('model = ?'); args.push(filter.model) }
    if (filter.family !== undefined) { where.push('family = ?'); args.push(filter.family) }
    if (filter.status !== undefined) { where.push('status = ?'); args.push(filter.status) }
    const sql = `SELECT * FROM model_registry${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY provider, model LIMIT ?`
    return (this.db.prepare(sql).all(...args, bounded(filter.limit ?? MAX_QUERY_LIMIT)) as Row[]).map(row => this.mapRecord(row))
  }

  hasProvider(provider: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM model_registry WHERE provider = ? LIMIT 1').get(provider))
  }

  /** ReputationStorePort: whether the registry knows the key, so a new unproven key gets a prior-only score. */
  known(key: ModelKey): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM model_registry WHERE key = ?').get(modelKeyId(key)))
  }

  /** ReputationStorePort: the other live keys of this key's family (see familyOf). */
  family(key: ModelKey): ModelKey[] {
    const family = this.record(key)?.family ?? familyOf(key.model)
    if (!family) return []
    const id = modelKeyId(key)
    return (this.db.prepare("SELECT provider, model FROM model_registry WHERE family = ? AND key <> ? AND status <> 'retired' ORDER BY provider, model LIMIT ?").all(family, id, MAX_QUERY_LIMIT) as Row[]).map(keyOf)
  }

  saveRecord(record: StoredRecord): void {
    this.db.prepare(`INSERT INTO model_registry (key, provider, model, status, family, first_seen_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status = excluded.status, family = excluded.family, updated_at = excluded.updated_at, record_json = excluded.record_json`)
      .run(modelKeyId(record.key), record.key.provider, record.key.model, record.status, record.family, record.firstSeenAt, record.updatedAt, JSON.stringify(record))
  }

  private mapRecord(row: Row): StoredRecord {
    return { ...json<StoredRecord>(row.record_json), status: row.status as ModelStatus, firstSeenAt: String(row.first_seen_at), updatedAt: String(row.updated_at) }
  }

  // -------------------------------------------------------------------------------------------
  // Observations and source listings

  /** Stores the observation unless its source's latest value for the field is the same, in which
   *  case that row is confirmed instead. Returns whether a new row was written. */
  observe(observation: FieldObservation): 'added' | 'confirmed' {
    const key = modelKeyId(observation.key), at = iso(observation.observedAt, 'observedAt'), value = JSON.stringify(observation.value)
    const latest = this.db.prepare('SELECT id, value_json, confirmed_at FROM model_observations WHERE key = ? AND field = ? AND source_name = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1')
      .get(key, observation.field, observation.source.name) as Row | undefined
    if (latest && latest.value_json === value) {
      if (String(latest.confirmed_at) < at) this.db.prepare('UPDATE model_observations SET confirmed_at = ? WHERE id = ?').run(at, String(latest.id))
      return 'confirmed'
    }
    this.db.prepare('INSERT INTO model_observations (id, key, field, value_json, source_kind, source_name, source_url, observed_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(makeId('mobs'), key, observation.field, value, observation.source.kind, observation.source.name, observation.source.url ?? null, at, at)
    return 'added'
  }

  /** Every source's latest observation of every field of one key (older values stay for audit). */
  latestObservations(key: ModelKey): StoredObservation[] {
    const rows = this.db.prepare('SELECT * FROM model_observations WHERE key = ? ORDER BY field, source_name, observed_at DESC, rowid DESC').all(modelKeyId(key)) as Row[]
    const seen = new Set<string>(), latest: StoredObservation[] = []
    for (const row of rows) {
      const slot = `${String(row.field)}\0${String(row.source_name)}`
      if (seen.has(slot)) continue
      seen.add(slot)
      latest.push(this.mapObservation(row, key))
    }
    return latest
  }

  /** The full history of one key, optionally of one field, newest first. */
  observations(key: ModelKey, field?: RegistryField, limit = 500): StoredObservation[] {
    const rows = field
      ? this.db.prepare('SELECT * FROM model_observations WHERE key = ? AND field = ? ORDER BY observed_at DESC, rowid DESC LIMIT ?').all(modelKeyId(key), field, bounded(limit))
      : this.db.prepare('SELECT * FROM model_observations WHERE key = ? ORDER BY observed_at DESC, rowid DESC LIMIT ?').all(modelKeyId(key), bounded(limit))
    return (rows as Row[]).map(row => this.mapObservation(row, key))
  }

  private mapObservation(row: Row, key: ModelKey): StoredObservation {
    const source: SourceRef = { kind: row.source_kind as SourceKind, name: String(row.source_name), ...(row.source_url ? { url: String(row.source_url) } : {}) }
    return { id: String(row.id), key, field: row.field as RegistryField, value: json<RegistryValue>(row.value_json), source, observedAt: String(row.observed_at), confirmedAt: String(row.confirmed_at) }
  }

  /** Marks keys as listed by a source now; returns the keys that were new to it or had been dropped. */
  list(source: SourceRef, keys: ModelKey[], at: string): ModelKey[] {
    const returned: ModelKey[] = []
    for (const key of keys) {
      const id = modelKeyId(key)
      const row = this.db.prepare('SELECT dropped_at FROM model_source_listing WHERE source_name = ? AND key = ?').get(source.name, id) as Row | undefined
      if (!row || row.dropped_at) returned.push(key)
      this.db.prepare(`INSERT INTO model_source_listing (source_name, key, source_kind, first_listed_at, last_listed_at, dropped_at) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(source_name, key) DO UPDATE SET source_kind = excluded.source_kind, last_listed_at = MAX(last_listed_at, excluded.last_listed_at), dropped_at = NULL`)
        .run(source.name, id, source.kind, at, at)
    }
    return returned
  }

  /** Keys the source still lists, bounded by what one source can plausibly list. */
  listedBy(sourceName: string): ModelKey[] {
    return (this.db.prepare(`SELECT r.provider, r.model FROM model_source_listing l JOIN model_registry r ON r.key = l.key
      WHERE l.source_name = ? AND l.dropped_at IS NULL LIMIT ?`).all(sourceName, MAX_QUERY_LIMIT) as Row[]).map(keyOf)
  }

  drop(sourceName: string, key: ModelKey, at: string): void {
    this.db.prepare('UPDATE model_source_listing SET dropped_at = ? WHERE source_name = ? AND key = ? AND dropped_at IS NULL').run(at, sourceName, modelKeyId(key))
  }

  listings(key: ModelKey): SourceListing[] {
    return (this.db.prepare('SELECT * FROM model_source_listing WHERE key = ? ORDER BY source_name').all(modelKeyId(key)) as Row[]).map(row => ({
      source: String(row.source_name), kind: row.source_kind as SourceKind, key, firstListedAt: String(row.first_listed_at), lastListedAt: String(row.last_listed_at), droppedAt: row.dropped_at ? String(row.dropped_at) : null
    }))
  }

  // -------------------------------------------------------------------------------------------
  // Changes

  recordChange(change: RegistryChange): void {
    this.db.prepare('INSERT INTO model_changes (id, kind, key, field, before_json, after_json, source_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(makeId('mchg'), change.kind, modelKeyId(change.key), change.field ?? null, change.before === undefined ? null : JSON.stringify(change.before),
        change.after === undefined ? null : JSON.stringify(change.after), JSON.stringify({ ...change.source, key: change.key }), iso(change.at, 'at'))
  }

  changes(query: { since: string; key?: ModelKey; limit: number }): RegistryChange[] {
    const since = iso(query.since, 'since')
    const rows = query.key
      ? this.db.prepare('SELECT * FROM model_changes WHERE key = ? AND at >= ? ORDER BY at, rowid LIMIT ?').all(modelKeyId(query.key), since, bounded(query.limit))
      : this.db.prepare('SELECT * FROM model_changes WHERE at >= ? ORDER BY at, rowid LIMIT ?').all(since, bounded(query.limit))
    return (rows as Row[]).map(row => {
      const { key, ...source } = json<SourceRef & { key: ModelKey }>(row.source_json)
      return {
        kind: row.kind as RegistryChange['kind'], key, ...(row.field ? { field: row.field as RegistryField } : {}),
        ...(row.before_json !== null ? { before: json<RegistryValue>(row.before_json) } : {}), ...(row.after_json !== null ? { after: json<RegistryValue>(row.after_json) } : {}),
        source, at: String(row.at)
      }
    })
  }

  // -------------------------------------------------------------------------------------------
  // Benchmarks (priors only; never part of a record's factual fields)

  /** Skips a result identical to the latest one from the same source for the same benchmark. */
  recordBenchmark(result: BenchmarkResult): 'added' | 'unchanged' {
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) throw new Error(`Benchmark score for ${modelKeyId(result.key)} must be normalised to 0..1`)
    const key = modelKeyId(result.key)
    const latest = this.db.prepare('SELECT score, raw, categories_json FROM model_benchmarks WHERE key = ? AND benchmark = ? AND source_name = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1')
      .get(key, result.benchmark, result.source.name) as Row | undefined
    const categories = JSON.stringify([...result.categories].sort())
    if (latest && Number(latest.score) === result.score && latest.raw === result.raw && latest.categories_json === categories) return 'unchanged'
    this.db.prepare('INSERT INTO model_benchmarks (id, key, benchmark, score, raw, categories_json, source_json, source_name, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(makeId('mbench'), key, result.benchmark, result.score, result.raw, categories, JSON.stringify(result.source), result.source.name, iso(result.observedAt, 'observedAt'))
    return 'added'
  }

  /** The latest result per (benchmark, source) for one key; a key with none of its own takes its
   *  family's (the same weights under another provider, e.g. OpenRouter's), so priors reach the
   *  CLI keys the router offers. */
  benchmarks(key: ModelKey): BenchmarkResult[] {
    const own = this.benchmarksOf(key)
    if (own.length) return own
    const seen = new Set<string>(), inherited: BenchmarkResult[] = []
    for (const member of this.family(key)) for (const result of this.benchmarksOf(member)) {
      const slot = `${result.benchmark}\0${result.source.name}`
      if (!seen.has(slot)) { seen.add(slot); inherited.push({ ...result, key }) }
    }
    return inherited
  }

  private benchmarksOf(key: ModelKey): BenchmarkResult[] {
    const rows = this.db.prepare('SELECT * FROM model_benchmarks WHERE key = ? ORDER BY benchmark, source_name, observed_at DESC, rowid DESC LIMIT ?').all(modelKeyId(key), MAX_QUERY_LIMIT) as Row[]
    const seen = new Set<string>(), results: BenchmarkResult[] = []
    for (const row of rows) {
      const slot = `${String(row.benchmark)}\0${String(row.source_name)}`
      if (seen.has(slot)) continue
      seen.add(slot)
      results.push({ key, benchmark: String(row.benchmark), score: Number(row.score), raw: String(row.raw), categories: json<TaskCategory[]>(row.categories_json), source: json<SourceRef>(row.source_json), observedAt: String(row.observed_at) })
    }
    return results
  }

  // -------------------------------------------------------------------------------------------
  // Execution outcomes (module B)

  /** Idempotent on (source, ref, key): a second capture of the same execution returns the stored row. */
  recordOutcome(outcome: Omit<ExecutionOutcome, 'id'> & { id?: string }): { outcome: ExecutionOutcome; inserted: boolean } {
    const key = modelKeyId(outcome.key)
    if (!outcome.ref) throw new Error('An outcome needs a source reference')
    const row: ExecutionOutcome = { ...outcome, id: outcome.id ?? makeId('mout'), at: iso(outcome.at, 'at') }
    const inserted = this.db.prepare(`INSERT INTO execution_outcomes (id, key, source, ref, category, at, result, decision_id, project_id, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, ref, key) DO NOTHING`).run(row.id, key, row.source, row.ref, row.category, row.at, row.result, row.decisionId, row.projectId, JSON.stringify(row)).changes > 0
    if (inserted) return { outcome: row, inserted }
    const existing = this.db.prepare('SELECT row_json FROM execution_outcomes WHERE source = ? AND ref = ? AND key = ?').get(row.source, row.ref, key) as Row
    return { outcome: json<ExecutionOutcome>(existing.row_json), inserted: false }
  }

  outcome(id: string): ExecutionOutcome | null {
    const row = this.db.prepare('SELECT row_json FROM execution_outcomes WHERE id = ?').get(id) as Row | undefined
    return row ? json<ExecutionOutcome>(row.row_json) : null
  }

  /** The owner's (or a wizard's) later verdict on an execution: models.outcome. */
  amendOutcome(id: string, patch: Partial<Pick<ExecutionOutcome, 'result' | 'ownerCorrected' | 'falseCompletion' | 'repairedBy' | 'verifier' | 'detail' | 'decisionId'>>): ExecutionOutcome | null {
    return this.transaction(() => {
      const current = this.outcome(id)
      if (!current) return null
      const next: ExecutionOutcome = { ...current, ...patch, id: current.id }
      this.db.prepare('UPDATE execution_outcomes SET result = ?, decision_id = ?, row_json = ? WHERE id = ?').run(next.result, next.decisionId, JSON.stringify(next), id)
      return next
    })
  }

  /** Newest first, within [since, until). Uses the (key, category, at), (category, at) or (at) index. */
  outcomes(query: OutcomeQuery): ExecutionOutcome[] {
    const where = ['at >= ?'], args: Array<string | number> = [iso(query.since, 'since')]
    if (query.until !== undefined) { where.push('at < ?'); args.push(iso(query.until, 'until')) }
    if (query.key) { where.unshift('key = ?'); args.unshift(modelKeyId(query.key)) }
    if (query.category) { where.splice(query.key ? 1 : 0, 0, 'category = ?'); args.splice(query.key ? 1 : 0, 0, query.category) }
    return (this.db.prepare(`SELECT row_json FROM execution_outcomes WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...args, bounded(query.limit)) as Row[])
      .map(row => json<ExecutionOutcome>(row.row_json))
  }

  outcomesForDecision(decisionId: string, limit = 100): ExecutionOutcome[] {
    return (this.db.prepare('SELECT row_json FROM execution_outcomes WHERE decision_id = ? ORDER BY at DESC LIMIT ?').all(decisionId, bounded(limit)) as Row[]).map(row => json<ExecutionOutcome>(row.row_json))
  }

  // -------------------------------------------------------------------------------------------
  // Routing decisions (module C)

  /** A models.route decision is a dry run: journaled for decisions.get and models.outcome, but
   *  left out of decisions.list (and agreement counts) by default. */
  recordDecision(record: DecisionRecord): void {
    const at = iso(record.at, 'at'), dryRun = record.dryRun ?? record.requester === 'models.route'
    const { outcome: _outcome, route, dryRun: _dry, ...rest } = record
    this.db.prepare(`INSERT INTO routing_decisions (id, kind, requester, at, choice, confidence, decided_by, escalated, project_id, agent_session_id, record_json, outcome_json, route_json, dry_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.kind, record.requester, at, record.choice, record.confidence, record.decidedBy, record.escalated ? 1 : 0, record.projectId, record.agentSessionId,
        JSON.stringify({ ...rest, at, outcome: null }), record.outcome ? JSON.stringify(record.outcome) : null, route ? JSON.stringify(route) : null, dryRun ? 1 : 0)
  }

  /** What the router made of a route decision: selection, fallback, escalation and reasons. */
  recordRouteDetails(id: string, details: RouteDetails): DecisionRecord | null {
    const changed = this.db.prepare('UPDATE routing_decisions SET route_json = ? WHERE id = ?').run(JSON.stringify(details), id).changes
    return changed ? this.decision(id) : null
  }

  /** One open attempt of a dispatch made for this decision; attempts accumulate in order. */
  appendRouteAttempt(id: string, attempt: NonNullable<RouteDetails['attempts']>[number]): DecisionRecord | null {
    return this.transaction(() => {
      const current = this.decision(id)
      if (!current?.route) return null
      return this.recordRouteDetails(id, { ...current.route, attempts: [...current.route.attempts ?? [], attempt] })
    })
  }

  updateDecisionOutcome(id: string, outcome: NonNullable<DecisionRecord['outcome']> | null): DecisionRecord | null {
    const value = outcome ? { ...outcome, at: iso(outcome.at, 'at') } : null
    const changed = this.db.prepare('UPDATE routing_decisions SET outcome_json = ? WHERE id = ?').run(value ? JSON.stringify(value) : null, id).changes
    return changed ? this.decision(id) : null
  }

  decision(id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT record_json, outcome_json, route_json, dry_run FROM routing_decisions WHERE id = ?').get(id) as Row | undefined
    return row ? this.mapDecision(row) : null
  }

  /** Newest first, within [since, until), on the (kind, at) or (at) index; dry runs only when asked. */
  decisions(query: DecisionQuery): DecisionRecord[] {
    const where = ['at >= ?'], args: string[] = [iso(query.since, 'since')]
    if (query.until !== undefined) { where.push('at < ?'); args.push(iso(query.until, 'until')) }
    if (query.kind) { where.unshift('kind = ?'); args.unshift(query.kind) }
    if (!query.includeDryRun) where.push('dry_run = 0')
    return (this.db.prepare(`SELECT record_json, outcome_json, route_json, dry_run FROM routing_decisions WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...args, bounded(query.limit)) as Row[])
      .map(row => this.mapDecision(row))
  }

  private mapDecision(row: Row): DecisionRecord {
    return {
      ...json<DecisionRecord>(row.record_json), outcome: row.outcome_json ? json<{ result: OutcomeResult; at: string; detail?: string }>(row.outcome_json) : null,
      ...(row.route_json ? { route: json<RouteDetails>(row.route_json) } : {}), ...(Number(row.dry_run) === 1 ? { dryRun: true } : {})
    }
  }

  /**
   * Agreement of the system-one verdict with the final answer for one kind (the owner's go-live
   * rule reads it). A case needs a system-one verdict that did not fail and a final answer: the
   * owner's (an outcome detail "... answered <choice>"), else the frontier or reviewer choice.
   * Dry runs are not cases. Bounded by `limit` newest decisions.
   */
  approvalAgreement(query: { kind: DecisionKind; since: string; limit?: number; boundary?: string }): Agreement {
    let cases = 0, agreed = 0
    for (const record of this.decisions({ kind: query.kind, since: query.since, limit: query.limit ?? 2_000 })) {
      if (query.boundary !== undefined && boundaryOf(record) !== query.boundary) continue
      const systemOne = systemOneOf(record)
      if (!systemOne || systemOne.failed || !systemOne.choice) continue
      // The owner's own answer settles it; else the frontier's choice when the frontier decided.
      const final = record.outcome?.answer ?? (record.escalated && record.decidedBy !== systemOne.decider ? record.choice : null)
      if (!final) continue
      cases++
      if (systemOne.choice === final) agreed++
    }
    return { kind: query.kind, ...(query.boundary !== undefined ? { boundary: query.boundary } : {}), since: iso(query.since, 'since'), cases, agreed, rate: cases ? agreed / cases : null }
  }

  /** One evaluation run's spend, journaled once per run (evaluation.ts recordSpend), so the owner's
   *  caps are auditable and enforceable. */
  recordEvaluationSpend(spend: EvaluationSpend): void {
    this.db.prepare(`INSERT INTO evaluation_runs (run_id, key, at, tokens, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET tokens = excluded.tokens, record_json = excluded.record_json`)
      .run(spend.runId, modelKeyId(spend.key), iso(spend.at, 'at'), Math.max(0, Math.round(spend.tokens)), JSON.stringify(spend))
  }

  /** Cloud evaluation spend since an instant: runs and tokens (local runs cost nothing and are not counted,
   *  nor is a run refused before any model call). */
  evaluationSpend(since: string, provider?: string): { runs: number; tokens: number } {
    let runs = 0, tokens = 0
    for (const row of this.db.prepare('SELECT key, tokens, record_json FROM evaluation_runs WHERE at >= ? ORDER BY at DESC LIMIT ?').all(iso(since, 'since'), MAX_QUERY_LIMIT) as Row[]) {
      const key = String(row.key)
      if (key.startsWith('local/') || provider && !key.startsWith(`${provider}/`)) continue
      if (spendOf(row.record_json)?.stoppedBy === 'refused') continue
      runs++
      tokens += Number(row.tokens)
    }
    return { runs, tokens }
  }

  /** The journaled evaluation runs since an instant, newest first. */
  evaluationRuns(since: string): EvaluationSpend[] {
    return (this.db.prepare('SELECT record_json FROM evaluation_runs WHERE at >= ? ORDER BY at DESC LIMIT ?').all(iso(since, 'since'), MAX_QUERY_LIMIT) as Row[])
      .flatMap(row => { const spend = spendOf(row.record_json); return spend ? [spend] : [] })
  }

  /** Marks a journaled run as refused before any model call: it spent nothing and leaves the day's caps.
   *  The correction for a run charged a budget its turn never used; returns whether a row changed. */
  releaseEvaluationSpend(runId: string, reason: string): boolean {
    const row = this.db.prepare('SELECT record_json FROM evaluation_runs WHERE run_id = ?').get(runId) as Row | undefined
    const spend = row ? spendOf(row.record_json) : null
    if (!spend || spend.stoppedBy === 'refused' && spend.tokens === 0) return false
    const released: EvaluationSpend = { ...spend, tokens: 0, costUsd: 0, stoppedBy: 'refused', reason }
    this.db.prepare('UPDATE evaluation_runs SET tokens = 0, record_json = ? WHERE run_id = ?').run(JSON.stringify(released), runId)
    return true
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch bindings

  /** Keeps the newest BINDINGS_MAX bindings younger than BINDING_TTL_DAYS. */
  saveBinding(agentSessionId: string, binding: StoredBinding): void {
    this.transaction(() => {
      const at = new Date(binding.at).toISOString()
      this.db.prepare(`INSERT INTO dispatch_bindings (agent_session_id, decision_id, at, binding_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_session_id) DO UPDATE SET decision_id = excluded.decision_id, at = excluded.at, binding_json = excluded.binding_json`).run(agentSessionId, binding.decisionId, at, JSON.stringify(binding))
      this.db.prepare('DELETE FROM dispatch_bindings WHERE at < ?').run(new Date(this.clock().getTime() - BINDING_TTL_DAYS * DAY_MS).toISOString())
      this.db.prepare('DELETE FROM dispatch_bindings WHERE agent_session_id IN (SELECT agent_session_id FROM dispatch_bindings ORDER BY at DESC LIMIT -1 OFFSET ?)').run(BINDINGS_MAX)
    })
  }

  binding(agentSessionId: string): StoredBinding | null {
    const row = this.db.prepare('SELECT binding_json, at FROM dispatch_bindings WHERE agent_session_id = ?').get(agentSessionId) as Row | undefined
    if (!row) return null
    if (this.clock().getTime() - Date.parse(String(row.at)) > BINDING_TTL_DAYS * DAY_MS) return null
    return json<StoredBinding>(row.binding_json)
  }

  // -------------------------------------------------------------------------------------------
  // Retention

  /** Deletes outcomes past OUTCOME_RETENTION_DAYS and decisions past DECISION_RETENTION_DAYS in
   *  bounded batches, so a startup prune never holds the shared database for long. `complete` is
   *  false when the batch budget ran out first; the next startup continues. */
  prune(now: Date = this.clock(), options: { batchSize?: number; maxBatches?: number } = {}): PruneResult {
    const batchSize = options.batchSize ?? 2_000, maxBatches = options.maxBatches ?? 25
    const sweep = (table: string, days: number): { deleted: number; done: boolean } => {
      const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString()
      const statement = this.db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE at < ? ORDER BY at LIMIT ?)`)
      let deleted = 0
      for (let batch = 0; batch < maxBatches; batch++) {
        const removed = Number(statement.run(cutoff, batchSize).changes)
        deleted += removed
        if (removed < batchSize) return { deleted, done: true }
      }
      return { deleted, done: false }
    }
    const outcomes = sweep('execution_outcomes', OUTCOME_RETENTION_DAYS), decisions = sweep('routing_decisions', DECISION_RETENTION_DAYS)
    return { outcomes: outcomes.deleted, decisions: decisions.deleted, complete: outcomes.done && decisions.done }
  }
}
