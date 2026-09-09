import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeId } from '../shared/models'
import { BUILT_IN_AGENTS, DISPATCHED_COWORKER_ROLE } from '../shared/orchestration'
import type {
  CreateOrchestrationTaskInput,
  OrchestrationAgent,
  OrchestrationAgentStatus,
  OrchestrationSnapshot,
  OrchestrationTask,
  OrchestrationTaskPriority,
  OrchestrationTaskStatus,
  RoutineDefinition,
  RoutineRun,
  RoutineStartResult,
  RoutineStep,
  SaveOrchestrationAgentInput,
  SaveRoutineInput,
  UpdateOrchestrationTaskInput
} from '../shared/orchestration'

type DbRow = Record<string, unknown>

const now = (): string => new Date().toISOString()
const agentStatuses = new Set<OrchestrationAgentStatus>(['active', 'paused', 'archived'])
const taskStatuses = new Set<OrchestrationTaskStatus>([
  'backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'
])
const taskPriorities = new Set<OrchestrationTaskPriority>(['low', 'normal', 'high', 'urgent'])
const providers = new Set(['codex', 'claude', 'gemini', 'qwen', 'kimi'])

const requiredText = (value: string, label: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

const optionalText = (value: string | null | undefined, maxLength: number): string =>
  (value ?? '').trim().slice(0, maxLength)

/**
 * Persistent project-level orchestration state. It intentionally uses its own
 * connection so the feature can be integrated without exposing ConductorDatabase's
 * private sqlite handle. Both connections use WAL and foreign-key enforcement.
 */
export class OrchestrationStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS orchestration_agents_project_idx
        ON orchestration_agents(project_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS orchestration_routines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS orchestration_routines_project_idx
        ON orchestration_routines(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS orchestration_routine_steps (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES orchestration_routines(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        assigned_agent_id TEXT REFERENCES orchestration_agents(id) ON DELETE SET NULL,
        UNIQUE(routine_id, position)
      );

      CREATE TABLE IF NOT EXISTS orchestration_routine_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        routine_id TEXT NOT NULL REFERENCES orchestration_routines(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS orchestration_runs_project_idx
        ON orchestration_routine_runs(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT NOT NULL DEFAULT 'normal',
        assigned_agent_id TEXT REFERENCES orchestration_agents(id) ON DELETE SET NULL,
        routine_id TEXT REFERENCES orchestration_routines(id) ON DELETE SET NULL,
        routine_run_id TEXT REFERENCES orchestration_routine_runs(id) ON DELETE SET NULL,
        routine_step_id TEXT REFERENCES orchestration_routine_steps(id) ON DELETE SET NULL,
        blocked_by_task_id TEXT REFERENCES orchestration_tasks(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS orchestration_tasks_project_idx
        ON orchestration_tasks(project_id, status, sort_order, created_at DESC);
      CREATE INDEX IF NOT EXISTS orchestration_tasks_run_idx
        ON orchestration_tasks(routine_run_id, sort_order);
    `)
  }

  /**
   * Reusable identities the roster ships with. Re-saved on read so an improved brief reaches a
   * project that seeded an older one, while the owner's own name and model choice are left alone.
   */
  seedBuiltInAgents(projectId: string): OrchestrationAgent[] {
    this.requireProject(projectId)
    const existing = this.listAgents(projectId)
    return BUILT_IN_AGENTS.map(builtIn => {
      const match = existing.find(agent => agent.role === builtIn.role)
      return this.saveAgent({
        id: match?.id,
        projectId,
        name: match?.name ?? builtIn.name,
        provider: match?.provider ?? builtIn.provider,
        model: match?.model ?? null,
        role: builtIn.role,
        instructions: builtIn.instructions,
        status: match?.status ?? 'active'
      })
    })
  }

  /**
   * Every router.dispatch used to mint an agent named after the task it ran, so the roster filled
   * with one-shot entries like "Fix broken tab dragging". Those are runs, and the task table
   * already records them; drop the identities and leave their tasks unassigned rather than
   * deleting the owner's work.
   */
  retireDispatchedCoworkerAgents(projectId: string): number {
    this.requireProject(projectId)
    const stale = this.listAgents(projectId).filter(agent => agent.role === DISPATCHED_COWORKER_ROLE)
    for (const agent of stale) this.db.prepare('DELETE FROM orchestration_agents WHERE id = ?').run(agent.id)
    return stale.length
  }

  snapshot(projectId: string): OrchestrationSnapshot {
    this.requireProject(projectId)
    this.retireDispatchedCoworkerAgents(projectId)
    this.seedBuiltInAgents(projectId)
    return {
      agents: this.listAgents(projectId),
      tasks: this.listTasks(projectId),
      routines: this.listRoutines(projectId),
      runs: this.listRuns(projectId)
    }
  }

  listAgents(projectId: string): OrchestrationAgent[] {
    return (this.db.prepare(
      `SELECT * FROM orchestration_agents WHERE project_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, name COLLATE NOCASE`
    ).all(projectId) as DbRow[]).map(this.mapAgent)
  }

  saveAgent(input: SaveOrchestrationAgentInput): OrchestrationAgent {
    this.requireProject(input.projectId)
    if (!providers.has(input.provider)) throw new Error('Unsupported agent provider')
    const name = requiredText(input.name, 'Agent name', 120)
    const status = input.status ?? 'active'
    if (!agentStatuses.has(status)) throw new Error('Invalid agent status')
    const timestamp = now()

    if (input.id) {
      const existing = this.getAgent(input.id)
      if (!existing || existing.projectId !== input.projectId) throw new Error('Agent not found')
      this.db.prepare(
        `UPDATE orchestration_agents SET name = ?, provider = ?, model = ?, role = ?,
         instructions = ?, status = ?, updated_at = ? WHERE id = ?`
      ).run(
        name,
        input.provider,
        optionalText(input.model, 160) || null,
        optionalText(input.role, 500),
        optionalText(input.instructions, 20_000),
        status,
        timestamp,
        input.id
      )
      return this.getAgent(input.id)!
    }

    const id = makeId('orchestrator-agent')
    this.db.prepare(
      `INSERT INTO orchestration_agents
       (id, project_id, name, provider, model, role, instructions, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      name,
      input.provider,
      optionalText(input.model, 160) || null,
      optionalText(input.role, 500),
      optionalText(input.instructions, 20_000),
      status,
      timestamp,
      timestamp
    )
    return this.getAgent(id)!
  }

  removeAgent(id: string): void {
    this.db.prepare('DELETE FROM orchestration_agents WHERE id = ?').run(id)
  }

  listTasks(projectId: string): OrchestrationTask[] {
    return (this.db.prepare(
      `SELECT * FROM orchestration_tasks WHERE project_id = ?
       ORDER BY CASE status
         WHEN 'in_progress' THEN 0 WHEN 'ready' THEN 1 WHEN 'blocked' THEN 2
         WHEN 'backlog' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
       sort_order ASC, created_at DESC`
    ).all(projectId) as DbRow[]).map(this.mapTask)
  }

  createTask(input: CreateOrchestrationTaskInput): OrchestrationTask {
    this.requireProject(input.projectId)
    const status = input.status ?? 'backlog'
    const priority = input.priority ?? 'normal'
    if (!taskStatuses.has(status)) throw new Error('Invalid task status')
    if (!taskPriorities.has(priority)) throw new Error('Invalid task priority')
    this.requireAgentInProject(input.assignedAgentId, input.projectId)
    const id = makeId('task')
    const timestamp = now()
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM orchestration_tasks WHERE project_id = ?'
    ).get(input.projectId) as DbRow
    this.db.prepare(
      `INSERT INTO orchestration_tasks
       (id, project_id, title, description, status, priority, assigned_agent_id,
        sort_order, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      requiredText(input.title, 'Task title', 300),
      optionalText(input.description, 20_000),
      status,
      priority,
      input.assignedAgentId ?? null,
      Number(row.next_order),
      status === 'done' ? timestamp : null,
      timestamp,
      timestamp
    )
    return this.getTask(id)!
  }

  updateTask(id: string, input: UpdateOrchestrationTaskInput): OrchestrationTask {
    const existing = this.getTask(id)
    if (!existing) throw new Error('Task not found')
    const status = input.status ?? existing.status
    const priority = input.priority ?? existing.priority
    if (!taskStatuses.has(status)) throw new Error('Invalid task status')
    if (!taskPriorities.has(priority)) throw new Error('Invalid task priority')
    const assignedAgentId = input.assignedAgentId === undefined
      ? existing.assignedAgentId
      : input.assignedAgentId
    this.requireAgentInProject(assignedAgentId, existing.projectId)
    const timestamp = now()
    const completedAt = status === 'done' ? (existing.completedAt ?? timestamp) : null

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `UPDATE orchestration_tasks SET title = ?, description = ?, status = ?, priority = ?,
         assigned_agent_id = ?, sort_order = ?, completed_at = ?, updated_at = ? WHERE id = ?`
      ).run(
        input.title === undefined ? existing.title : requiredText(input.title, 'Task title', 300),
        input.description === undefined ? existing.description : optionalText(input.description, 20_000),
        status,
        priority,
        assignedAgentId,
        input.sortOrder ?? existing.sortOrder,
        completedAt,
        timestamp,
        id
      )

      if (status === 'done' && existing.status !== 'done') {
        this.db.prepare(
          `UPDATE orchestration_tasks SET status = 'ready', blocked_by_task_id = NULL, updated_at = ?
           WHERE blocked_by_task_id = ? AND status = 'blocked'`
        ).run(timestamp, id)
        if (existing.routineRunId) this.completeRunIfFinished(existing.routineRunId, timestamp)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getTask(id)!
  }

  removeTask(id: string): void {
    const task = this.getTask(id)
    if (!task) return
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `UPDATE orchestration_tasks SET status = 'ready', blocked_by_task_id = NULL, updated_at = ?
         WHERE blocked_by_task_id = ? AND status = 'blocked'`
      ).run(timestamp, id)
      this.db.prepare('DELETE FROM orchestration_tasks WHERE id = ?').run(id)
      if (task.routineRunId) this.completeRunIfFinished(task.routineRunId, timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listRoutines(projectId: string): RoutineDefinition[] {
    const rows = this.db.prepare(
      'SELECT * FROM orchestration_routines WHERE project_id = ? ORDER BY updated_at DESC, name COLLATE NOCASE'
    ).all(projectId) as DbRow[]
    const stepStatement = this.db.prepare(
      'SELECT * FROM orchestration_routine_steps WHERE routine_id = ? ORDER BY position ASC'
    )
    return rows.map((row) => this.mapRoutine(
      row,
      (stepStatement.all(row.id as string) as DbRow[]).map(this.mapRoutineStep)
    ))
  }

  saveRoutine(input: SaveRoutineInput): RoutineDefinition {
    this.requireProject(input.projectId)
    if (input.steps.length === 0) throw new Error('A routine needs at least one step')
    if (input.steps.length > 100) throw new Error('A routine can contain at most 100 steps')
    for (const step of input.steps) this.requireAgentInProject(step.assignedAgentId, input.projectId)
    const timestamp = now()
    const id = input.id ?? makeId('routine')
    const existing = input.id ? this.getRoutine(input.id) : null
    if (input.id && (!existing || existing.projectId !== input.projectId)) throw new Error('Routine not found')

    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (existing) {
        this.db.prepare(
          `UPDATE orchestration_routines SET name = ?, description = ?, enabled = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          requiredText(input.name, 'Routine name', 200),
          optionalText(input.description, 4000),
          input.enabled === false ? 0 : 1,
          timestamp,
          id
        )
        this.db.prepare('DELETE FROM orchestration_routine_steps WHERE routine_id = ?').run(id)
      } else {
        this.db.prepare(
          `INSERT INTO orchestration_routines
           (id, project_id, name, description, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          input.projectId,
          requiredText(input.name, 'Routine name', 200),
          optionalText(input.description, 4000),
          input.enabled === false ? 0 : 1,
          timestamp,
          timestamp
        )
      }
      const insert = this.db.prepare(
        `INSERT INTO orchestration_routine_steps
         (id, routine_id, position, title, instructions, assigned_agent_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      input.steps.forEach((step, position) => insert.run(
        step.id && !existing?.steps.some((candidate) => candidate.id === step.id)
          ? makeId('routine-step')
          : (step.id ?? makeId('routine-step')),
        id,
        position,
        requiredText(step.title, `Step ${position + 1} title`, 300),
        optionalText(step.instructions, 20_000),
        step.assignedAgentId ?? null
      ))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getRoutine(id)!
  }

  removeRoutine(id: string): void {
    this.db.prepare('DELETE FROM orchestration_routines WHERE id = ?').run(id)
  }

  startRoutine(id: string): RoutineStartResult {
    const routine = this.getRoutine(id)
    if (!routine) throw new Error('Routine not found')
    if (!routine.enabled) throw new Error('Routine is disabled')
    if (routine.steps.length === 0) throw new Error('Routine has no steps')
    const runId = makeId('routine-run')
    const timestamp = now()
    const taskIds = routine.steps.map(() => makeId('task'))

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO orchestration_routine_runs
         (id, project_id, routine_id, status, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, NULL, ?, ?)`
      ).run(runId, routine.projectId, routine.id, timestamp, timestamp, timestamp)
      const orderRow = this.db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM orchestration_tasks WHERE project_id = ?'
      ).get(routine.projectId) as DbRow
      const startOrder = Number(orderRow.next_order)
      const insert = this.db.prepare(
        `INSERT INTO orchestration_tasks
         (id, project_id, title, description, status, priority, assigned_agent_id,
          routine_id, routine_run_id, routine_step_id, blocked_by_task_id, sort_order,
          completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      routine.steps.forEach((step, position) => insert.run(
        taskIds[position]!,
        routine.projectId,
        step.title,
        step.instructions,
        position === 0 ? 'ready' : 'blocked',
        step.assignedAgentId,
        routine.id,
        runId,
        step.id,
        position === 0 ? null : taskIds[position - 1]!,
        startOrder + position,
        timestamp,
        timestamp
      ))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return {
      run: this.getRun(runId)!,
      tasks: taskIds.map((taskId) => this.getTask(taskId)!)
    }
  }

  listRuns(projectId: string): RoutineRun[] {
    return (this.db.prepare(
      `SELECT * FROM orchestration_routine_runs WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 50`
    ).all(projectId) as DbRow[]).map(this.mapRun)
  }

  close(): void {
    this.db.close()
  }

  private requireProject(projectId: string): void {
    const row = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!row) throw new Error('Project not found')
  }

  private requireAgentInProject(agentId: string | null | undefined, projectId: string): void {
    if (!agentId) return
    const row = this.db.prepare(
      'SELECT id FROM orchestration_agents WHERE id = ? AND project_id = ?'
    ).get(agentId, projectId)
    if (!row) throw new Error('Assigned agent does not belong to this project')
  }

  private completeRunIfFinished(runId: string, timestamp: string): void {
    const remaining = this.db.prepare(
      `SELECT COUNT(*) AS count FROM orchestration_tasks
       WHERE routine_run_id = ? AND status NOT IN ('done', 'cancelled')`
    ).get(runId) as DbRow
    if (Number(remaining.count) === 0) {
      this.db.prepare(
        `UPDATE orchestration_routine_runs SET status = 'complete', completed_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(timestamp, timestamp, runId)
    }
  }

  private getAgent(id: string): OrchestrationAgent | null {
    const row = this.db.prepare('SELECT * FROM orchestration_agents WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return row ? this.mapAgent(row) : null
  }

  private getTask(id: string): OrchestrationTask | null {
    const row = this.db.prepare('SELECT * FROM orchestration_tasks WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return row ? this.mapTask(row) : null
  }

  private getRoutine(id: string): RoutineDefinition | null {
    const row = this.db.prepare('SELECT * FROM orchestration_routines WHERE id = ?').get(id) as
      | DbRow
      | undefined
    if (!row) return null
    const steps = this.db.prepare(
      'SELECT * FROM orchestration_routine_steps WHERE routine_id = ? ORDER BY position ASC'
    ).all(id) as DbRow[]
    return this.mapRoutine(row, steps.map(this.mapRoutineStep))
  }

  private getRun(id: string): RoutineRun | null {
    const row = this.db.prepare('SELECT * FROM orchestration_routine_runs WHERE id = ?').get(id) as
      | DbRow
      | undefined
    return row ? this.mapRun(row) : null
  }

  private mapAgent = (row: DbRow): OrchestrationAgent => ({
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    provider: row.provider as OrchestrationAgent['provider'],
    model: (row.model as string | null) ?? null,
    role: row.role as string,
    instructions: row.instructions as string,
    status: row.status as OrchestrationAgentStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })

  private mapTask = (row: DbRow): OrchestrationTask => ({
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: row.description as string,
    status: row.status as OrchestrationTaskStatus,
    priority: row.priority as OrchestrationTaskPriority,
    assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
    routineId: (row.routine_id as string | null) ?? null,
    routineRunId: (row.routine_run_id as string | null) ?? null,
    routineStepId: (row.routine_step_id as string | null) ?? null,
    blockedByTaskId: (row.blocked_by_task_id as string | null) ?? null,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null) ?? null
  })

  private mapRoutineStep = (row: DbRow): RoutineStep => ({
    id: row.id as string,
    routineId: row.routine_id as string,
    position: Number(row.position),
    title: row.title as string,
    instructions: row.instructions as string,
    assignedAgentId: (row.assigned_agent_id as string | null) ?? null
  })

  private mapRoutine = (row: DbRow, steps: RoutineStep[]): RoutineDefinition => ({
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    description: row.description as string,
    enabled: Boolean(row.enabled),
    steps,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })

  private mapRun = (row: DbRow): RoutineRun => ({
    id: row.id as string,
    projectId: row.project_id as string,
    routineId: row.routine_id as string,
    status: row.status as RoutineRun['status'],
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })
}
