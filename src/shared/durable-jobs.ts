/**
 * Durable local-model jobs: the shared contract between the main-process job controller, the
 * control protocol, IPC and the renderer. A job is the stable unit of overnight work; a worker
 * context (one local-model conversation) is disposable and replaced at every stage boundary.
 *
 * Owners: the job store and controller live in src/main/durable-jobs/ (Opus A); context
 * budgeting and stage handoff in src/main/durable-jobs/handoff.ts (Opus B); server lifecycle,
 * watchdog and loop detection in src/main/durable-jobs/watchdog.ts (Opus C); control methods,
 * IPC, renderer view, report and end-to-end smoke in agent-control.ts, ipc, renderer (Opus D).
 * Only Opus A edits this file after the initial version; others propose changes in their handoff.
 */

export const DURABLE_JOB_STATUSES = ['queued', 'running', 'paused', 'recovering', 'blocked', 'completed', 'failed', 'cancelled'] as const
export type DurableJobStatus = (typeof DURABLE_JOB_STATUSES)[number]

export const DURABLE_STAGE_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const
export type DurableStageStatus = (typeof DURABLE_STAGE_STATUSES)[number]

/** What a stage is for; it decides the stage's tool scope (handoff.ts STAGE_TOOL_MAP). */
export const DURABLE_STAGE_KINDS = ['plan', 'investigate', 'implement', 'verify', 'research', 'report'] as const
export type DurableStageKind = (typeof DURABLE_STAGE_KINDS)[number]

/** Terminal job statuses never transition again. */
export const TERMINAL_JOB_STATUSES: readonly DurableJobStatus[] = ['completed', 'failed', 'cancelled']

export interface DurableJobBudgets {
  /** Wall-clock ceiling for the whole job; 0 means none (an overnight job is not timed out). */
  maxElapsedMs: number
  /** Per model call, tool call and stage bounded waits. */
  modelCallTimeoutMs: number
  toolCallTimeoutMs: number
  stageTimeoutMs: number
  /** Retries per stage before the job blocks. */
  maxStageAttempts: number
  /** Fraction of the live model context at which a fresh stage/compaction starts (default 0.7). */
  contextRolloverFraction: number
  /** Tokens kept free for the next tool response on top of the reserved output tokens. */
  contextSafetyMarginTokens: number
  /** Ceiling for a fresh stage's prompt; default min(8,192, a quarter of the model window). */
  stagePromptBudgetTokens?: number
}

export const DEFAULT_DURABLE_JOB_BUDGETS: DurableJobBudgets = {
  maxElapsedMs: 0,
  modelCallTimeoutMs: 10 * 60_000,
  toolCallTimeoutMs: 15 * 60_000,
  stageTimeoutMs: 90 * 60_000,
  maxStageAttempts: 3,
  contextRolloverFraction: 0.7,
  contextSafetyMarginTokens: 2_048
}

export interface DurableJobModelPolicy {
  provider: 'local'
  /** Exact models.list id, e.g. local/qwen3.6-35b-a3b. A job never switches provider on its own. */
  model: string
  /** Cloud escalation is never automatic; this only records whether the owner allowed a handoff. */
  escalation: 'never' | 'report-and-block'
}

/** What a fresh worker context is rebuilt from. Persisted; never reconstructed from a transcript. */
export interface DurableJobHandoff {
  objective: string
  constraints: string[]
  decisions: string[]
  workDone: string[]
  filesChanged: string[]
  testResults: string[]
  unresolvedIssues: string[]
  nextAction: string
  /** Paths (not contents) of artifacts, logs and excerpts the next worker may read selectively. */
  artifacts: DurableJobArtifactRef[]
  updatedAt: string
}

export interface DurableJobArtifactRef {
  path: string
  kind: 'log' | 'output' | 'source' | 'checkpoint' | 'report' | 'other'
  /** Optional 1-based line range the excerpt came from. */
  range?: { from: number; to: number }
  note?: string
}

export interface DurableJobStage {
  id: string
  jobId: string
  index: number
  title: string
  /** Set by the plan; when absent it is inferred from the title (handoff.ts stageKind). */
  kind?: DurableStageKind
  objective: string
  completionCriteria: string[]
  inputs: DurableJobArtifactRef[]
  status: DurableStageStatus
  attempt: number
  /** The local-model conversation (AgentSpec id) currently or last executing this stage. */
  agentSessionId?: string
  model?: string
  startedAt?: string
  completedAt?: string
  error?: string
  /** Short factual result recorded after execution; the full output stays on disk. */
  result?: string
  checkpointId?: string
}

export interface DurableJobCheckpoint {
  id: string
  jobId: string
  stageId?: string
  createdAt: string
  reason: string
  /** Git commit hash when the project is a repository and a checkpoint commit was made. */
  commit?: string
  /** Files/artifacts captured for a non-Git project or before a broad edit. */
  artifacts: DurableJobArtifactRef[]
}

export interface DurableJobLease {
  /** Increments on every takeover; a worker holding an older epoch may not modify the job. */
  epoch: number
  /** Identity of the app process that owns the job (pid + launch id). */
  ownerId: string
  expiresAt: string
}

/** An in-flight side effect recorded before execution so a restart can reconcile it. */
export interface DurableJobOperation {
  id: string
  jobId: string
  stageId: string
  kind: 'shell' | 'file-write' | 'git' | 'test' | 'model-call' | 'other'
  description: string
  status: 'intended' | 'done' | 'failed' | 'unknown'
  intendedAt: string
  settledAt?: string
  /** How a restart decided the outcome (e.g. file hash matched, commit present, not replayed). */
  reconciliation?: string
}

export interface DurableJobEvent {
  id: string
  jobId: string
  at: string
  kind: 'transition' | 'stage' | 'checkpoint' | 'recovery' | 'retry' | 'loop-detected' | 'server' | 'approval' | 'escalation' | 'note'
  message: string
  /** Conventions: a test run carries data.test ({ command, outcome: 'pass' | 'fail' | 'not-run', detail? });
   *  an escalation event carries data.occurred (true only when a cloud model actually ran). */
  data?: Record<string, unknown>
}

/** Who created a job: besides the owner, only that conversation may pause, resume or cancel it. */
export interface DurableJobCreator {
  kind: 'owner' | 'wizard' | 'agent'
  agentSessionId: string
  title: string
}

export interface DurableJob {
  id: string
  projectId: string
  workspaceId?: string
  /** Working directory the job operates in (an isolated worktree when the project is a repository). */
  cwd: string
  worktree?: { path: string; branch: string; baseCommit: string }
  title: string
  objective: string
  createdBy?: DurableJobCreator
  status: DurableJobStatus
  statusReason?: string
  model: DurableJobModelPolicy
  budgets: DurableJobBudgets
  handoff: DurableJobHandoff
  lease?: DurableJobLease
  currentStageId?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  /** Sum of active running time, excluding paused/blocked spans. */
  activeMs: number
  counters: { stagesCompleted: number; retries: number; recoveries: number; contextRollovers: number; loopsDetected: number; cloudEscalations: number }
  /** Final report path once produced; the report is a file, the chat gets a summary. */
  reportPath?: string
  logDir: string
}

/** Compact view for lists, status polling and the control protocol. */
export interface DurableJobSummary {
  id: string
  projectId: string
  title: string
  status: DurableJobStatus
  statusReason?: string
  model: string
  currentStage?: { id: string; index: number; title: string; attempt: number; startedAt?: string }
  stagesCompleted: number
  stagesTotal: number
  elapsedMs: number
  activeMs: number
  lastCheckpoint?: { id: string; createdAt: string; reason: string; commit?: string }
  lastEvent?: { at: string; kind: DurableJobEvent['kind']; message: string }
  counters: DurableJob['counters']
  updatedAt: string
}

export interface CreateDurableJobInput {
  projectId: string
  workspaceId?: string
  title: string
  objective: string
  model: string
  /** Optional explicit stage plan; when absent the controller plans one bounded first stage. */
  stages?: Array<Pick<DurableJobStage, 'title' | 'objective' | 'completionCriteria'> & { kind?: DurableStageKind; inputs?: DurableJobArtifactRef[] }>
  budgets?: Partial<DurableJobBudgets>
  constraints?: string[]
  /** Use an isolated git worktree/branch when the project is a repository (default true). */
  isolateWorktree?: boolean
  createdBy?: DurableJobCreator
}

export interface DurableJobReport {
  jobId: string
  status: DurableJobStatus
  elapsedMs: number
  activeMs: number
  modelsByStage: Array<{ stage: string; model: string; attempts: number }>
  filesChanged: string[]
  results: string[]
  tests: Array<{ command: string; outcome: 'pass' | 'fail' | 'not-run'; detail?: string }>
  checkpoints: Array<{ id: string; createdAt: string; commit?: string; reason: string }>
  recoveries: Array<{ at: string; message: string }>
  remainingWork: string[]
  cloudEscalation: { occurred: boolean; detail?: string }
  logPaths: string[]
  generatedAt: string
}

/** Control-protocol and IPC method names, so every layer uses one vocabulary. */
export const DURABLE_JOB_METHODS = {
  create: 'jobs.create',
  list: 'jobs.list',
  status: 'jobs.status',
  events: 'jobs.events',
  pause: 'jobs.pause',
  resume: 'jobs.resume',
  cancel: 'jobs.cancel',
  report: 'jobs.report'
} as const

/**
 * The service the main process exposes to the control protocol and IPC. Implemented by
 * src/main/durable-jobs/index.ts (Opus A); consumed by agent-control.ts and IPC (Opus D).
 * Every method is safe to call from any process state: a job that does not exist throws,
 * an illegal transition throws, and nothing here blocks on a model call.
 */
export interface DurableJobsService {
  create(input: CreateDurableJobInput): Promise<DurableJobSummary>
  list(filter?: { projectId?: string; status?: DurableJobStatus[] }): DurableJobSummary[]
  get(jobId: string): DurableJob & { stages: DurableJobStage[] }
  status(jobId: string): DurableJobSummary
  events(jobId: string, afterId?: string, limit?: number): DurableJobEvent[]
  checkpoints(jobId: string): DurableJobCheckpoint[]
  pause(jobId: string, reason?: string): DurableJobSummary
  resume(jobId: string): Promise<DurableJobSummary>
  cancel(jobId: string, reason?: string): Promise<DurableJobSummary>
  report(jobId: string): Promise<DurableJobReport & { reportPath: string }>
  /** Renderer/IPC subscription; fires with the summary on every persisted change. */
  onChange(listener: (summary: DurableJobSummary) => void): () => void
}

/** Allowed transitions; the store rejects anything else atomically. */
export const DURABLE_JOB_TRANSITIONS: Readonly<Record<DurableJobStatus, readonly DurableJobStatus[]>> = {
  queued: ['running', 'cancelled', 'paused'],
  running: ['paused', 'recovering', 'blocked', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  recovering: ['running', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'recovering', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: []
}

export const canTransition = (from: DurableJobStatus, to: DurableJobStatus): boolean => DURABLE_JOB_TRANSITIONS[from].includes(to)
