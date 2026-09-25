/**
 * The idea autopilot (docs/idea-autopilot.md): "Run this idea" turns an idea into a durable run
 * with a staged plan a frontier model writes and the owner approves. A run controller then opens
 * and steers an agent per stage, keeps recurring work in a logic loop fired by a scheduled task,
 * pauses at every outward-facing or irreversible action until the owner answers, and records each
 * step on the idea's timeline.
 */

export const IDEA_RUN_STATUSES = ['planning', 'awaiting-approval', 'running', 'waiting-owner', 'paused', 'completed', 'stopped', 'failed'] as const
export type IdeaRunStatus = (typeof IDEA_RUN_STATUSES)[number]
export const IDEA_RUN_STATUS_LABELS: Readonly<Record<IdeaRunStatus, string>> = {
  planning: 'Planning', 'awaiting-approval': 'Plan waiting for you', running: 'Running', 'waiting-owner': 'Waiting for you',
  paused: 'Paused', completed: 'Completed', stopped: 'Stopped', failed: 'Failed'
}
/** A run in one of these is finished and never moves again. */
export const IDEA_RUN_FINAL: ReadonlySet<IdeaRunStatus> = new Set(['completed', 'stopped', 'failed'])

/**
 * Outward-facing or irreversible action types. Every one pauses for the owner with the exact
 * action shown, unless the owner set a standing rule for that type on that run.
 */
export const IDEA_ACTION_TYPES = ['create-account', 'publish', 'message', 'purchase', 'order', 'spend', 'external'] as const
export type IdeaActionType = (typeof IDEA_ACTION_TYPES)[number]
export const IDEA_ACTION_LABELS: Readonly<Record<IdeaActionType, string>> = {
  'create-account': 'Create an account', publish: 'Publish or upload publicly', message: 'Message or reply to people',
  purchase: 'Buy something', order: 'Place an order', spend: 'Spend money (ads, subscriptions, API credit)', external: 'Other outside action'
}

export const IDEA_STAGE_KINDS = ['research', 'create', 'brand-check', 'public', 'report'] as const
export type IdeaStageKind = (typeof IDEA_STAGE_KINDS)[number]

export interface IdeaStageAgent {
  provider: 'claude' | 'codex' | 'local'
  model: string
  effort?: string
}

export interface IdeaStageBudget {
  /** Wall time from the stage's first turn (each occurrence of a recurring stage gets its own). */
  maxMinutes: number
  /** Agent turns, follow-ups included. */
  maxTurns: number
  /** Money the stage may spend: agent-reported spend plus approved purchases, orders and spend. */
  maxEur: number
}

/** Recurring work: a logic loop the run creates, fired by the project's idea-run scheduled task. */
export interface IdeaStageRecurrence {
  everyMinutes: number
  /** How many occurrences finish the stage. */
  times: number
  loop: { title: string; steps: Array<{ id: string; role: string; model: string; done?: string }> }
}

export interface IdeaStagePlan {
  id: string
  title: string
  kind: IdeaStageKind
  goal: string
  doneCriteria: string[]
  agent: IdeaStageAgent
  budget: IdeaStageBudget
  /** Action types the planner expects this stage to ask for; each one still pauses when asked. */
  checkpoints: IdeaActionType[]
  /** Makes or edits images, video or audio: provenance labels must be kept. */
  generatesMedia: boolean
  recurrence?: IdeaStageRecurrence
}

export interface IdeaRunPlan {
  summary: string
  stages: IdeaStagePlan[]
  /** Weekly usage caps (percent) for the run; never above the owner's defaults. */
  weeklyCaps: { claude: number; codex: number }
  /** Rules every stage brief carries (provenance, brand check, checkpoints). */
  rules: string[]
  /** What Conductor changed or refused in the planner's draft, for the owner to read before approving. */
  warnings: string[]
  author: { provider: string; model: string; agentSessionId?: string }
}

export type IdeaStageStatus = 'pending' | 'running' | 'waiting-owner' | 'recurring' | 'done' | 'failed' | 'paused'

export interface IdeaRunStage extends IdeaStagePlan {
  index: number
  status: IdeaStageStatus
  agentSessionId: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Turns sent to the stage agent (this occurrence for a recurring stage). */
  turns: number
  spentEur: number
  summary: string
  /** Logic loop the recurrence runs, once created. */
  loopId: string | null
  occurrences: number
  nextDueAt: string | null
}

export type IdeaCheckpointStatus = 'pending' | 'approved' | 'denied'

export interface IdeaRunAction {
  type: IdeaActionType
  /** One line: what will happen. */
  summary: string
  /** The exact action: the post text and file, the account name and site, the order lines. */
  detail: string
  /** Where: a site, account, recipient or URL. */
  target?: string
  amountEur?: number
}

export interface IdeaRunCheckpoint {
  id: string
  runId: string
  stageId: string
  action: IdeaRunAction
  status: IdeaCheckpointStatus
  createdAt: string
  decidedAt: string | null
  /** "owner", "phone Pixel", "standing rule", "Conductor (provenance rule)". */
  decidedBy: string | null
  note: string | null
}

export interface IdeaRunRule {
  runId: string
  actionType: IdeaActionType
  decision: 'approve' | 'deny'
  createdAt: string
  createdBy: string
}

export interface IdeaRun {
  id: string
  ideaId: string
  ideaTitle: string
  projectId: string
  status: IdeaRunStatus
  /** A dry run: agents simulate every outside action; approvals are recorded, never executed. */
  dryRun: boolean
  plan: IdeaRunPlan | null
  stages: IdeaRunStage[]
  checkpoints: IdeaRunCheckpoint[]
  rules: IdeaRunRule[]
  plannerAgentSessionId: string | null
  /** Why the run is paused, waiting or failed. */
  reason: string | null
  createdAt: string
  updatedAt: string
  approvedAt: string | null
}

export interface StartIdeaRunInput {
  ideaId: string
  projectId: string
  /** The frontier model that writes the plan; default Claude Opus. */
  planner?: { provider: 'claude' | 'codex'; model?: string }
  dryRun?: boolean
}

export interface DecideCheckpointInput {
  checkpointId: string
  decision: 'approve' | 'deny'
  /** Apply this decision to every later action of the same type in this run. */
  standing?: boolean
  note?: string
}

export interface IdeaRunsBridge {
  list(query?: { ideaId?: string }): Promise<IdeaRun[]>
  get(runId: string): Promise<IdeaRun>
  start(input: StartIdeaRunInput): Promise<IdeaRun>
  approve(runId: string): Promise<IdeaRun>
  decide(input: DecideCheckpointInput): Promise<IdeaRun>
  pause(runId: string): Promise<IdeaRun>
  resume(runId: string): Promise<IdeaRun>
  stop(runId: string): Promise<IdeaRun>
  onChanged(listener: (change: { runId: string; ideaId: string }) => void): () => void
}

export const IDEA_RUNS_IPC = {
  list: 'idea-runs:list', get: 'idea-runs:get', start: 'idea-runs:start', approve: 'idea-runs:approve', decide: 'idea-runs:decide',
  pause: 'idea-runs:pause', resume: 'idea-runs:resume', stop: 'idea-runs:stop', changed: 'idea-runs:changed'
} as const

/** The owner's defaults (owner, 2026-09-25): Claude weekly usage stops at 85%, Codex at 95%. */
export const IDEA_RUN_DEFAULT_WEEKLY_CAPS = { claude: 85, codex: 95 } as const
export const IDEA_RUN_DEFAULT_BUDGET: IdeaStageBudget = { maxMinutes: 60, maxTurns: 6, maxEur: 0 }
