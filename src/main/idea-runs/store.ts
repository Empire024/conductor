import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../../shared/models'
import type {
  IdeaActionType, IdeaCheckpointStatus, IdeaRun, IdeaRunAction, IdeaRunCheckpoint, IdeaRunPlan, IdeaRunRule, IdeaRunStage,
  IdeaRunStatus, IdeaStagePlan, IdeaStageStatus
} from '../../shared/idea-runs'

type Row = Record<string, unknown>

const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null

/** Runtime fields of a stage the controller moves; the plan part is written once at approval. */
export interface StageState {
  status: IdeaStageStatus
  agentSessionId: string | null
  startedAt: string | null
  finishedAt: string | null
  turns: number
  spentEur: number
  summary: string
  loopId: string | null
  occurrences: number
  nextDueAt: string | null
  /** Structured-session sequence the answer being waited for comes after; null when not waiting. */
  awaitSequence: number | null
  /** The logic-loop run of the occurrence in flight. */
  loopRunId: string | null
}

export interface StoredStage extends IdeaRunStage { awaitSequence: number | null; loopRunId: string | null }

export interface StoredRun extends Omit<IdeaRun, 'stages' | 'ideaTitle'> {
  stages: StoredStage[]
  plannerAwaitSequence: number | null
  plannerTurns: number
  planner: { provider: string; model: string } | null
}

/**
 * Idea runs in conductor.db, beside the ideas tables (docs/idea-autopilot.md): the run, its
 * approved stages with their runtime state, every checkpoint with the exact action and who
 * answered it, and the owner's standing rules. Everything the controller needs to pick a run up
 * again after a restart lives here.
 */
export class IdeaRunStore {
  private readonly db: DatabaseSync
  private readonly listeners = new Set<(change: { runId: string; ideaId: string }) => void>()

  constructor(path: string | DatabaseSync, private readonly clock: () => Date = () => new Date()) {
    if (typeof path === 'string') {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
    } else this.db = path
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idea_runs (
        id TEXT PRIMARY KEY, idea_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, dry_run INTEGER NOT NULL,
        plan TEXT, planner TEXT, planner_agent_session_id TEXT, planner_await_sequence INTEGER, planner_turns INTEGER NOT NULL DEFAULT 0,
        reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idea_runs_idea_idx ON idea_runs(idea_id, created_at);
      CREATE INDEX IF NOT EXISTS idea_runs_status_idx ON idea_runs(status);
      CREATE TABLE IF NOT EXISTS idea_run_stages (
        run_id TEXT NOT NULL, idx INTEGER NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, agent_session_id TEXT,
        started_at TEXT, finished_at TEXT, turns INTEGER NOT NULL DEFAULT 0, spent_eur REAL NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
        loop_id TEXT, occurrences INTEGER NOT NULL DEFAULT 0, next_due_at TEXT, await_sequence INTEGER, loop_run_id TEXT,
        PRIMARY KEY (run_id, idx)
      );
      CREATE TABLE IF NOT EXISTS idea_run_checkpoints (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, note TEXT, delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idea_run_checkpoints_run_idx ON idea_run_checkpoints(run_id, created_at);
      CREATE TABLE IF NOT EXISTS idea_run_rules (
        run_id TEXT NOT NULL, action_type TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
        PRIMARY KEY (run_id, action_type)
      );
    `)
  }

  close(): void { this.db.close() }
  onChange(listener: (change: { runId: string; ideaId: string }) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private now(): string { return this.clock().toISOString() }

  private changed(runId: string): void {
    const row = this.db.prepare('SELECT idea_id FROM idea_runs WHERE id = ?').get(runId) as Row | undefined
    if (!row) return
    this.db.prepare('UPDATE idea_runs SET updated_at = ? WHERE id = ?').run(this.now(), runId)
    for (const listener of [...this.listeners]) { try { listener({ runId, ideaId: String(row.idea_id) }) } catch { /* a listener's problem */ } }
  }

  create(input: { ideaId: string; projectId: string; dryRun: boolean; planner?: { provider: string; model: string } }): StoredRun {
    const id = makeId('idearun'), now = this.now()
    this.db.prepare(`INSERT INTO idea_runs (id, idea_id, project_id, status, dry_run, planner, created_at, updated_at) VALUES (?, ?, ?, 'planning', ?, ?, ?, ?)`)
      .run(id, input.ideaId, input.projectId, input.dryRun ? 1 : 0, input.planner ? JSON.stringify(input.planner) : null, now, now)
    this.changed(id)
    return this.get(id)
  }

  exists(runId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM idea_runs WHERE id = ?').get(String(runId))) }

  get(runId: string): StoredRun {
    const row = this.db.prepare('SELECT * FROM idea_runs WHERE id = ?').get(String(runId)) as Row | undefined
    if (!row) throw new Error('No idea run with that id exists')
    return this.runRow(row)
  }

  list(query: { ideaId?: string; statuses?: readonly IdeaRunStatus[] } = {}): StoredRun[] {
    const rows = (query.ideaId
      ? this.db.prepare('SELECT * FROM idea_runs WHERE idea_id = ? ORDER BY created_at DESC, rowid DESC').all(query.ideaId)
      : this.db.prepare('SELECT * FROM idea_runs ORDER BY created_at DESC, rowid DESC LIMIT 200').all()) as Row[]
    return rows.map(row => this.runRow(row)).filter(run => !query.statuses || query.statuses.includes(run.status))
  }

  setStatus(runId: string, status: IdeaRunStatus, reason: string | null = null): void {
    this.db.prepare('UPDATE idea_runs SET status = ?, reason = ? WHERE id = ?').run(status, reason, runId)
    this.changed(runId)
  }

  setPlanner(runId: string, values: { agentSessionId?: string; awaitSequence?: number | null; turns?: number }): void {
    const run = this.get(runId)
    this.db.prepare('UPDATE idea_runs SET planner_agent_session_id = ?, planner_await_sequence = ?, planner_turns = ? WHERE id = ?')
      .run(values.agentSessionId ?? run.plannerAgentSessionId, values.awaitSequence === undefined ? run.plannerAwaitSequence : values.awaitSequence, values.turns ?? run.plannerTurns, runId)
    this.changed(runId)
  }

  /** The plan the owner will read; its stages become rows only when it is approved. */
  setPlan(runId: string, plan: IdeaRunPlan): void {
    this.db.prepare(`UPDATE idea_runs SET plan = ?, status = 'awaiting-approval', reason = NULL, planner_await_sequence = NULL WHERE id = ?`).run(JSON.stringify(plan), runId)
    this.changed(runId)
  }

  approve(runId: string): void {
    const run = this.get(runId)
    if (!run.plan) throw new Error('This run has no plan to approve yet')
    const now = this.now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM idea_run_stages WHERE run_id = ?').run(runId)
      run.plan.stages.forEach((stage, index) => {
        this.db.prepare(`INSERT INTO idea_run_stages (run_id, idx, plan, status) VALUES (?, ?, ?, 'pending')`).run(runId, index, JSON.stringify(stage))
      })
      this.db.prepare(`UPDATE idea_runs SET status = 'running', approved_at = ?, reason = NULL WHERE id = ?`).run(now, runId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.changed(runId)
  }

  updateStage(runId: string, index: number, values: Partial<StageState>): StoredStage {
    const current = this.get(runId).stages[index]
    if (!current) throw new Error(`Idea run ${runId} has no stage ${index}`)
    const next = { ...current, ...values }
    this.db.prepare(`UPDATE idea_run_stages SET status = ?, agent_session_id = ?, started_at = ?, finished_at = ?, turns = ?, spent_eur = ?, summary = ?,
      loop_id = ?, occurrences = ?, next_due_at = ?, await_sequence = ?, loop_run_id = ? WHERE run_id = ? AND idx = ?`)
      .run(next.status, next.agentSessionId, next.startedAt, next.finishedAt, next.turns, next.spentEur, next.summary, next.loopId, next.occurrences,
        next.nextDueAt, next.awaitSequence, next.loopRunId, runId, index)
    this.changed(runId)
    return this.get(runId).stages[index]!
  }

  addCheckpoint(runId: string, stageId: string, action: IdeaRunAction, verdict: { status: IdeaCheckpointStatus; by?: string; note?: string }): IdeaRunCheckpoint {
    const id = makeId('ideacheck'), now = this.now()
    const decided = verdict.status !== 'pending'
    this.db.prepare('INSERT INTO idea_run_checkpoints (id, run_id, stage_id, action, status, created_at, decided_at, decided_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, runId, stageId, JSON.stringify(action), verdict.status, now, decided ? now : null, decided ? verdict.by ?? null : null, verdict.note ?? null)
    this.changed(runId)
    return this.checkpoint(id)!
  }

  checkpoint(id: string): IdeaRunCheckpoint | null {
    const row = this.db.prepare('SELECT * FROM idea_run_checkpoints WHERE id = ?').get(String(id)) as Row | undefined
    return row ? this.checkpointRow(row) : null
  }

  decideCheckpoint(id: string, status: 'approved' | 'denied', by: string, note?: string): IdeaRunCheckpoint {
    const checkpoint = this.checkpoint(id)
    if (!checkpoint) throw new Error('No checkpoint with that id exists')
    if (checkpoint.status !== 'pending') throw new Error(`That checkpoint was already ${checkpoint.status}`)
    this.db.prepare(`UPDATE idea_run_checkpoints SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'`).run(status, this.now(), by, note ?? null, id)
    this.changed(checkpoint.runId)
    return this.checkpoint(id)!
  }

  setRule(runId: string, actionType: IdeaActionType, decision: 'approve' | 'deny', createdBy: string): void {
    this.db.prepare(`INSERT INTO idea_run_rules (run_id, action_type, decision, created_at, created_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, action_type) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at, created_by = excluded.created_by`)
      .run(runId, actionType, decision, this.now(), createdBy)
    this.changed(runId)
  }

  /** Decided checkpoints of a stage its agent has not been told about yet. */
  undelivered(runId: string, stageId: string): IdeaRunCheckpoint[] {
    return (this.db.prepare(`SELECT * FROM idea_run_checkpoints WHERE run_id = ? AND stage_id = ? AND status <> 'pending' AND delivered = 0 ORDER BY created_at, rowid`).all(runId, stageId) as Row[]).map(row => this.checkpointRow(row))
  }

  markDelivered(ids: readonly string[]): void {
    for (const id of ids) this.db.prepare('UPDATE idea_run_checkpoints SET delivered = 1 WHERE id = ?').run(id)
  }

  /** The owner resumed a stage that hit its budget: the plan's budget for it grows. */
  setStageBudget(runId: string, index: number, budget: IdeaStagePlan['budget']): void {
    const row = this.db.prepare('SELECT plan FROM idea_run_stages WHERE run_id = ? AND idx = ?').get(runId, index) as Row | undefined
    if (!row) throw new Error(`Idea run ${runId} has no stage ${index}`)
    this.db.prepare('UPDATE idea_run_stages SET plan = ? WHERE run_id = ? AND idx = ?').run(JSON.stringify({ ...parse<IdeaStagePlan>(row.plan, {} as IdeaStagePlan), budget }), runId, index)
    this.changed(runId)
  }

  /** Every pending checkpoint, oldest first, across runs (the phone's list). */
  pendingCheckpoints(): IdeaRunCheckpoint[] {
    return (this.db.prepare(`SELECT * FROM idea_run_checkpoints WHERE status = 'pending' ORDER BY created_at, rowid`).all() as Row[]).map(row => this.checkpointRow(row))
  }

  private checkpointRow(row: Row): IdeaRunCheckpoint {
    return {
      id: String(row.id), runId: String(row.run_id), stageId: String(row.stage_id), action: parse<IdeaRunAction>(row.action, { type: 'external', summary: '', detail: '' }),
      status: String(row.status) as IdeaCheckpointStatus, createdAt: String(row.created_at), decidedAt: text(row.decided_at), decidedBy: text(row.decided_by), note: text(row.note)
    }
  }

  private runRow(row: Row): StoredRun {
    const id = String(row.id)
    const stages = (this.db.prepare('SELECT * FROM idea_run_stages WHERE run_id = ? ORDER BY idx').all(id) as Row[]).map((stage): StoredStage => ({
      ...parse<IdeaStagePlan>(stage.plan, {} as IdeaStagePlan),
      index: Number(stage.idx), status: String(stage.status) as IdeaStageStatus, agentSessionId: text(stage.agent_session_id),
      startedAt: text(stage.started_at), finishedAt: text(stage.finished_at), turns: Number(stage.turns ?? 0), spentEur: Number(stage.spent_eur ?? 0),
      summary: String(stage.summary ?? ''), loopId: text(stage.loop_id), occurrences: Number(stage.occurrences ?? 0), nextDueAt: text(stage.next_due_at),
      awaitSequence: stage.await_sequence === null || stage.await_sequence === undefined ? null : Number(stage.await_sequence), loopRunId: text(stage.loop_run_id)
    }))
    const checkpoints = (this.db.prepare('SELECT * FROM idea_run_checkpoints WHERE run_id = ? ORDER BY created_at, rowid').all(id) as Row[]).map(item => this.checkpointRow(item))
    const rules = (this.db.prepare('SELECT * FROM idea_run_rules WHERE run_id = ? ORDER BY created_at').all(id) as Row[]).map((item): IdeaRunRule => ({
      runId: id, actionType: String(item.action_type) as IdeaActionType, decision: item.decision === 'deny' ? 'deny' : 'approve', createdAt: String(item.created_at), createdBy: String(item.created_by)
    }))
    return {
      id, ideaId: String(row.idea_id), projectId: String(row.project_id), status: String(row.status) as IdeaRunStatus, dryRun: Number(row.dry_run) === 1,
      plan: parse<IdeaRunPlan | null>(row.plan, null), stages, checkpoints, rules, plannerAgentSessionId: text(row.planner_agent_session_id),
      plannerAwaitSequence: row.planner_await_sequence === null || row.planner_await_sequence === undefined ? null : Number(row.planner_await_sequence),
      plannerTurns: Number(row.planner_turns ?? 0), planner: parse<StoredRun['planner']>(row.planner, null), reason: text(row.reason), createdAt: String(row.created_at), updatedAt: String(row.updated_at), approvedAt: text(row.approved_at)
    }
  }
}
