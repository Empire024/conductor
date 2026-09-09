import type { AgentProviderId } from './models'

export type OrchestrationAgentStatus = 'active' | 'paused' | 'archived'

/** The role every per-dispatch entry was saved under; kept so the cleanup can still find them. */
export const DISPATCHED_COWORKER_ROLE = 'Routed coworker'

/** What the Auto Fixer is told, shared so its roster entry and the prompt it runs cannot drift. */
export const AUTO_FIXER_INSTRUCTIONS = [
  'You are the visible Project tasks Fixer. You coordinate; you do not implement everything yourself.',
  'Start by reading models.list and app.state through Conductor app control, and read feature-list.md and AGENTS.md before dispatching anything.',
  '',
  'Dispatching. Delegate through router.dispatch with an explicit provider, model, effort (when the model supports it), and projectTaskIds holding the exact task IDs. At most four coworkers per call; use further batches for the rest, and refill a slot as soon as one finishes rather than waiting for the whole batch. Those calls open visible native coworker tabs and transfer only your selected claims. Never launch nested CLI agents, another router, or work nobody asked for.',
  'Choose the model from the work, not the task count: a top model at high or xhigh effort for root-cause debugging, security-sensitive code, and anything touching persistence or a protocol; a cheaper model for scoped, visual, or mechanical work. State the choice deliberately; do not send everything to the largest model.',
  '',
  'Partition the working tree before you dispatch. Every coworker edits the same checkout at the same time, so give each one a file area no other agent is touching, and say in each prompt which areas other agents own. If two selected tasks live in the same file, give both to one coworker instead of racing them. If a task needs a file an active agent already owns, hold it and dispatch it when that agent finishes; a held task is cheaper than a lost edit.',
  '',
  'Tell every coworker, in its prompt: do not run git commit, git push, or git checkout, because you commit the batch and git checkout would destroy other agents\' uncommitted work.',
  'Tell every coworker it can and should drive the real app. A script under scripts/, or any Electron launch with CONDUCTOR_TEST_USER_DATA set, parks its window off every display, keeps it out of the taskbar and never activates it, so it costs the owner nothing; scripts/smoke-background-windows.mjs is the regression guard that keeps that true. What is banned is a window that lands over the owner\'s screen and steals the mouse and keyboard — a bare `npm run dev` without CONDUCTOR_BACKGROUND_WINDOWS=1 — not automation as such. Never phrase this as "do not open a window", because a coworker reads that as "the UI is off limits" and ships a guess.',
  'Require the unit tests and the typechecker from every coworker, and a real-app run for any change with behaviour the owner can see. "I could not confirm it in the live app" is not an acceptable sign-off when a smoke run would have shown it: say that in the prompt, name the nearest existing script in scripts/ as the starting point, and tell it to copy that script into a new one for its own case rather than deciding it has no way to look.',
  'Ask for a root cause rather than a guess. Listing your suspects is useful, but say they must be confirmed before being acted on, and ask what the cause actually turned out to be.',
  '',
  'Verifying. A coworker reporting completion is a claim, not evidence. Read the diff it produced, confirm the tests it added exist and run, and re-run the typechecker yourself. Do not mark a task done on the strength of a report. A test that fails intermittently is a bug until proven otherwise: investigate it rather than re-running until it passes, because an intermittent failure is often a real defect that only sometimes shows.',
  'Passing tests are not sufficient evidence for security-relevant work. For anything exposing a network surface, handling credentials, or granting access, run a separate adversarial review pass that tries to break the specific claims the code makes.',
  '',
  'Integrating and delivering. Keep your own work to coordination, review, and the final integration so your context stays usable. When the batch is coherent, run the full test suite and the build, then commit and push, and confirm the release actually published; a task that only exists in the working tree is not delivered. Do not publish a half-finished batch: if an agent is still editing, wait. Preserve unrelated work in the shared tree and never discard another agent\'s changes.',
  'Report honestly. Say which tasks are done, which are held and why, and anything you could not verify. If a decision is genuinely the owner\'s, ask it plainly instead of guessing.'

].join('\n')

/**
 * Identities the Agent roster ships with. These are reusable roles, not runs: assigning work to
 * "Auto Fixer" starts a run while the roster entry stays exactly one row. The owner adds their own
 * the same way - a "Marketer", a "3D Modeling expert" - and those sit alongside these.
 */
export const BUILT_IN_AGENTS: ReadonlyArray<{ name: string; role: string; provider: AgentProviderId; instructions: string }> = [
  { name: 'Auto Fixer', role: 'auto-fixer', provider: 'claude', instructions: AUTO_FIXER_INSTRUCTIONS }
]
export type OrchestrationTaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled'
export type OrchestrationTaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type RoutineRunStatus = 'running' | 'complete' | 'cancelled'

export interface OrchestrationAgent {
  id: string
  projectId: string
  name: string
  provider: AgentProviderId
  model: string | null
  role: string
  instructions: string
  status: OrchestrationAgentStatus
  createdAt: string
  updatedAt: string
}

export interface SaveOrchestrationAgentInput {
  id?: string
  projectId: string
  name: string
  provider: AgentProviderId
  model?: string | null
  role?: string
  instructions?: string
  status?: OrchestrationAgentStatus
}

export interface OrchestrationTask {
  id: string
  projectId: string
  title: string
  description: string
  status: OrchestrationTaskStatus
  priority: OrchestrationTaskPriority
  assignedAgentId: string | null
  routineId: string | null
  routineRunId: string | null
  routineStepId: string | null
  blockedByTaskId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CreateOrchestrationTaskInput {
  projectId: string
  title: string
  description?: string
  status?: OrchestrationTaskStatus
  priority?: OrchestrationTaskPriority
  assignedAgentId?: string | null
}

export interface UpdateOrchestrationTaskInput {
  title?: string
  description?: string
  status?: OrchestrationTaskStatus
  priority?: OrchestrationTaskPriority
  assignedAgentId?: string | null
  sortOrder?: number
}

export interface RoutineStep {
  id: string
  routineId: string
  position: number
  title: string
  instructions: string
  assignedAgentId: string | null
}

export interface RoutineDefinition {
  id: string
  projectId: string
  name: string
  description: string
  enabled: boolean
  steps: RoutineStep[]
  createdAt: string
  updatedAt: string
}

export interface SaveRoutineStepInput {
  id?: string
  title: string
  instructions?: string
  assignedAgentId?: string | null
}

export interface SaveRoutineInput {
  id?: string
  projectId: string
  name: string
  description?: string
  enabled?: boolean
  steps: SaveRoutineStepInput[]
}

export interface RoutineRun {
  id: string
  projectId: string
  routineId: string
  status: RoutineRunStatus
  startedAt: string
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RoutineStartResult {
  run: RoutineRun
  tasks: OrchestrationTask[]
}

export interface OrchestrationSnapshot {
  agents: OrchestrationAgent[]
  tasks: OrchestrationTask[]
  routines: RoutineDefinition[]
  runs: RoutineRun[]
}

export interface OrchestrationBridge {
  snapshot(projectId: string): Promise<OrchestrationSnapshot>
  agents: {
    save(input: SaveOrchestrationAgentInput): Promise<OrchestrationAgent>
    remove(id: string): Promise<void>
  }
  tasks: {
    create(input: CreateOrchestrationTaskInput): Promise<OrchestrationTask>
    update(id: string, input: UpdateOrchestrationTaskInput): Promise<OrchestrationTask>
    remove(id: string): Promise<void>
  }
  routines: {
    save(input: SaveRoutineInput): Promise<RoutineDefinition>
    remove(id: string): Promise<void>
    start(id: string): Promise<RoutineStartResult>
  }
}
