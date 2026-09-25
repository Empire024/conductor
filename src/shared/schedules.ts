/**
 * Scheduled tasks (docs/schedules.md). A task is a goal the owner (or an agent acting for the
 * owner) wants pursued on a cadence: an assigned agent, the deterministic scripts that agent
 * wrote for it, and a history of runs with their evidence.
 *
 * A run executes the task's scripts first. When every script produced the output it produced
 * last time, the run ends there: no model is asked anything. Only changed or failed output is
 * summarized — by a local model where one can run ("churn") — and only that summary, bounded,
 * goes to the assigned frontier agent as one small "brain" request. Runs wait for the night and
 * for idle windows (src/main/schedule-gate.ts) unless a task is marked urgent.
 */

/** 'agent' is any task an agent or the owner created. The other kinds are tasks Conductor itself
 *  seeds and keeps its scripts current for; they can be paused and edited, never deleted. */
export const SCHEDULE_KINDS = ['agent', 'latest-models-methods', 'idea-incubator', 'idea-run'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]
export const BUILTIN_SCHEDULE_KINDS: ReadonlyArray<Exclude<ScheduleKind, 'agent'>> = ['latest-models-methods', 'idea-incubator', 'idea-run']

export type ScheduleOutcome = 'running' | 'unchanged' | 'changed' | 'dispatched' | 'skipped' | 'failed' | 'stale'

/** When a due run may start. 'night' waits for the night window (and for idle); 'idle' runs in
 *  any window where the owner is away and the machine is quiet. Neither runs while the owner is
 *  working at this computer unless the task is urgent. */
export const SCHEDULE_TIMINGS = ['night', 'idle'] as const
export type ScheduleTiming = (typeof SCHEDULE_TIMINGS)[number]

export const SCHEDULE_AGENT_PROVIDERS = ['local', 'claude', 'codex', 'grok'] as const
export type ScheduleAgentProvider = (typeof SCHEDULE_AGENT_PROVIDERS)[number]
/** The agent assigned to a task: it writes the task's scripts and answers its bounded brain
 *  requests. A local agent means the whole task stays on this machine. */
export interface ScheduleAgent { provider: ScheduleAgentProvider; model: string; effort?: string }

export interface ScheduleCreator {
  kind: 'owner' | 'wizard' | 'agent' | 'conductor'
  agentSessionId?: string
  title?: string
}

export interface ScheduleDefinition {
  id: string
  projectId: string
  name: string
  kind: ScheduleKind
  /** The goal: what the assigned agent is to find out, check or keep an eye on. */
  prompt: string
  agent: ScheduleAgent | null
  /** The local model that summarizes changed script output. null means the first configured
   *  local model; with none configured the run falls back to a deterministic diff. */
  churnModel: string | null
  /** Whether changed evidence goes to the assigned (non-local) agent as one bounded request. */
  brain: boolean
  enabled: boolean
  everyMinutes: number
  timing: ScheduleTiming
  /** Runs when due even while the owner is working. */
  urgent: boolean
  catchUp: 'collapse'
  timeoutMs: number
  lastRunAt: string | null
  nextDueAt: string | null
  /** When the current due window was first held back, and the latest reason. Cleared by a run. */
  deferredAt: string | null
  deferredReason: string | null
  createdBy: ScheduleCreator
  /** A conversation the owner handed script-writing to (Assign agent in the Schedules panel);
   *  it may maintain the task like its creator. */
  delegateAgentSessionId: string | null
  createdAt: string
  updatedAt: string
}

export const SCHEDULE_SCRIPT_LANGUAGES = ['node', 'powershell'] as const
export type ScheduleScriptLanguage = (typeof SCHEDULE_SCRIPT_LANGUAGES)[number]
export type ScheduleScriptFormat = 'text' | 'json'
/** 'changed' scripts (expensive checks such as tests) run only when an earlier script of the
 *  same run changed or failed. */
export type ScheduleScriptRunWhen = 'always' | 'changed'
export const SCHEDULE_SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/
export const SCHEDULE_SCRIPT_MAX_BYTES = 64 * 1024
export const SCHEDULE_SCRIPT_MAX_PER_TASK = 12
export const SCHEDULE_SCRIPT_DEFAULT_TIMEOUT_SEC = 120
export const SCHEDULE_SCRIPT_MAX_TIMEOUT_SEC = 20 * 60

export interface ScheduleScript {
  scheduleId: string
  name: string
  description: string
  language: ScheduleScriptLanguage
  content: string
  /** sha256 of content; the runner refuses to run a file that no longer matches it. */
  digest: string
  format: ScheduleScriptFormat
  runWhen: ScheduleScriptRunWhen
  timeoutSec: number
  order: number
  origin: 'conductor' | 'agent' | 'owner'
  author: ScheduleCreator
  createdAt: string
  updatedAt: string
}

export interface ScheduleScriptResult {
  name: string
  status: 'ok' | 'failed' | 'invalid' | 'timeout' | 'skipped'
  exitCode: number | null
  durationMs: number
  outputDigest: string | null
  /** Output differs from the last valid output of this script (always true on its first run). */
  changed: boolean
  /** The tail of stdout (then stderr on failure), at most 4000 characters. */
  excerpt: string
  error?: string
}

export interface ScheduleModelStep {
  provider: ScheduleAgentProvider
  model: string
  ok: boolean
  /** Why the step was skipped, fell back or failed. */
  note?: string
  /** The headless conversation that answered a brain request; open it with openConversation. */
  agentSessionId?: string | null
}

export interface ScheduleRun {
  id: string
  scheduleId: string
  startedAt: string
  finishedAt: string | null
  outcome: ScheduleOutcome
  /** The run's result as the owner reads it: the brain answer, the local summary, or the
   *  deterministic diff, in that order of preference. */
  detail: string
  digest: string | null
  validUntil: string | null
  artifactPath: string | null
  trigger: 'schedule' | 'manual'
  scripts: ScheduleScriptResult[]
  churn: ScheduleModelStep | null
  brain: ScheduleModelStep | null
}

/** Whether a due run may start now, and why. */
export interface ScheduleGateVerdict {
  allowed: boolean
  /** One sentence: why it runs, or what it is waiting for. */
  reason: string
  /** The measurements behind the decision, e.g. "owner idle 23 min", "CPU 12%". */
  signals: string[]
  checkedAt: string
  /** When a deferred run should be looked at again; null when allowed. */
  retryAt: string | null
}

export interface ScheduleAgentOption {
  provider: ScheduleAgentProvider
  label: string
  available: boolean
  models: Array<{ id: string; label: string; effort?: string[] }>
}

export interface ScheduleSnapshot {
  schedules: ScheduleDefinition[]
  runs: Record<string, ScheduleRun[]>
  scripts: Record<string, ScheduleScript[]>
  /** The scheduler's latest verdict about starting due work, null before its first check. */
  gate: ScheduleGateVerdict | null
  running: { scheduleId: string; runId: string; startedAt: string } | null
  /** Providers and models a task can be assigned to. */
  agents: ScheduleAgentOption[]
}

export interface CreateScheduleInput {
  projectId: string
  name: string
  prompt?: string
  everyMinutes?: number
  timing?: ScheduleTiming
  urgent?: boolean
  agent?: ScheduleAgent | null
  churnModel?: string | null
  brain?: boolean
  enabled?: boolean
}

export interface UpdateScheduleInput {
  name?: string
  prompt?: string
  everyMinutes?: number
  timing?: ScheduleTiming
  urgent?: boolean
  agent?: ScheduleAgent | null
  churnModel?: string | null
  brain?: boolean
  enabled?: boolean
}

export interface SaveScheduleScriptInput {
  name: string
  content: string
  language?: ScheduleScriptLanguage
  description?: string
  format?: ScheduleScriptFormat
  runWhen?: ScheduleScriptRunWhen
  timeoutSec?: number
  order?: number
}

export interface SchedulesBridge {
  snapshot(projectId: string): Promise<ScheduleSnapshot>
  create(input: CreateScheduleInput): Promise<ScheduleDefinition>
  update(projectId: string, scheduleId: string, input: UpdateScheduleInput): Promise<ScheduleDefinition>
  /** The renderer confirms with the owner before calling; built-in tasks refuse. */
  remove(projectId: string, scheduleId: string): Promise<void>
  runNow(projectId: string, scheduleId: string): Promise<ScheduleRun>
  openArtifact(projectId: string, runId: string): Promise<void>
  /** Opens the conversation that answered a run's brain request as a tab. */
  openConversation(projectId: string, runId: string): Promise<void>
  /** Opens a visible tab with the task's assigned agent and briefs it to write the task's scripts
   *  through app control; that conversation may then maintain the task. */
  assignScripts(projectId: string, scheduleId: string): Promise<{ agentSessionId: string; tabId: string }>
  deleteScript(projectId: string, scheduleId: string, name: string): Promise<void>
  onChanged(callback: (projectId: string) => void): () => void
}

export const SCHEDULE_MIN_MINUTES = 5
export const SCHEDULE_MAX_MINUTES = 525_600
export const SCHEDULE_DEFAULT_TIMEOUT_MS = 20 * 60_000
export const SCHEDULE_NAME_MAX = 120
export const SCHEDULE_PROMPT_MAX = 8_000

const intervalMs = (schedule: Pick<ScheduleDefinition, 'everyMinutes'>): number =>
  Math.max(1, Math.floor(schedule.everyMinutes)) * 60_000

/** Return the first future window. A long outage advances one window only; it never creates backfill work. */
export function nextDue(schedule: Pick<ScheduleDefinition, 'enabled' | 'everyMinutes' | 'nextDueAt' | 'lastRunAt'>, now: Date): string | null {
  if (!schedule.enabled) return null
  const step = intervalMs(schedule)
  const nowMs = now.getTime()
  const candidate = Date.parse(schedule.nextDueAt ?? schedule.lastRunAt ?? '')
  if (!Number.isFinite(candidate)) return new Date(nowMs + step).toISOString()
  if (candidate > nowMs) return new Date(candidate).toISOString()
  return new Date(candidate + (Math.floor((nowMs - candidate) / step) + 1) * step).toISOString()
}

export function dueNow(schedules: readonly ScheduleDefinition[], now: Date): ScheduleDefinition[] {
  const at = now.getTime()
  return schedules.filter(schedule => schedule.enabled && schedule.nextDueAt !== null && Date.parse(schedule.nextDueAt) <= at)
}

/** "every 5 minutes", "every 6 hours", "daily", "every 3 days", "weekly". */
export function describeCadence(everyMinutes: number): string {
  const minutes = Math.max(1, Math.floor(everyMinutes))
  if (minutes === 1_440) return 'daily'
  if (minutes === 10_080) return 'weekly'
  if (minutes % 1_440 === 0) return `every ${minutes / 1_440} days`
  if (minutes % 60 === 0) return minutes === 60 ? 'hourly' : `every ${minutes / 60} hours`
  return `every ${minutes} minutes`
}
