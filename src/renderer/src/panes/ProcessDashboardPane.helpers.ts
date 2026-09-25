import type { RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection, TimelineItem } from '../../../shared/structured-agent'
import { isViewing } from '../../../shared/project-activity'

/** 'viewing': the turn ended but background tasks it started still run (shared/project-activity.ts). */
export type ProcessTrackerState = 'attention' | 'working' | 'viewing' | 'paused' | 'disconnected' | 'ready' | 'finished'

export interface ReportedPlanProgress {
  completed: number
  total: number
  label: string
}

export const PROCESS_BOARD_RECENT_MS = 24 * 60 * 60 * 1000

export interface ProcessBoardSelection {
  processes: RuntimeProcessSummary[]
  hiddenOlder: number
}

/** Keep the automatic board bounded before any conversation snapshot is requested. Live,
 * waiting, interrupted, and owner-attention rows stay visible regardless of age; settled rows
 * enter through the 24-hour window or explicit, page-sized "show older" requests. */
export function selectProcessBoardProcesses(
  processes: readonly RuntimeProcessSummary[],
  now = Date.now(),
  olderLimit = 0
): ProcessBoardSelection {
  const recentAfter = now - PROCESS_BOARD_RECENT_MS
  const current: RuntimeProcessSummary[] = []
  const older: RuntimeProcessSummary[] = []
  for (const process of [...processes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const updatedAt = Date.parse(process.updatedAt)
    const active = process.needsInput || ['starting', 'running', 'waiting_input', 'limited'].includes(process.status) ||
      ['working', 'waiting_input', 'waiting_background', 'limited', 'disconnected'].includes(process.activityPhase ?? '')
    if (active || (Number.isFinite(updatedAt) && updatedAt >= recentAfter)) current.push(process)
    else older.push(process)
  }
  const requestedOlder = older.slice(0, Math.max(0, olderLimit))
  return { processes: [...current, ...requestedOlder], hiddenOlder: older.length - requestedOlder.length }
}

/** Runtime state comes from the persisted process/activity record. A connected adapter is only
 * "working" when it is starting or its activity phase says work is being produced. */
export function processTrackerState(process: RuntimeProcessSummary, snapshot?: (Pick<SessionProjection, 'phase'> & Partial<Pick<SessionProjection, 'backgroundTasks'>>) | null): ProcessTrackerState {
  // Connection state and execution state are distinct. A completed turn can later lose its
  // adapter while retaining a resumable native conversation; that snapshot is authoritative for
  // whether the owner must explicitly reconnect it.
  if (snapshot?.phase === 'disconnected') return 'disconnected'
  if (process.needsInput || process.status === 'waiting_input' || process.activityPhase === 'waiting_input') return 'attention'
  if (process.status === 'limited' || process.activityPhase === 'limited') return 'paused'
  if (process.activityPhase === 'disconnected') return 'disconnected'
  // A conversation that has settled speaks for itself. The persisted row can keep saying
  // 'working' for hours after its tab closed - a detached subagent that never reported its end
  // holds it there - so it only fills in a background count the snapshot does not carry.
  if (snapshot && settledPhases.has(snapshot.phase)) {
    if (isViewing(snapshot.phase, snapshot.backgroundTasks) || (snapshot.backgroundTasks === undefined && process.activityPhase === 'waiting_background')) return 'viewing'
    return snapshot.phase === 'idle' && !finishedRecord(process) ? 'ready' : 'finished'
  }
  if (snapshot && ['starting', 'running', 'interrupting'].includes(snapshot.phase)) return 'working'
  // Background work the runtime will wake this conversation for is neither the adapter sitting
  // idle nor a finished run: the turn ended while tasks it started still run.
  if (process.activityPhase === 'waiting_background' || isViewing(snapshot?.phase, snapshot?.backgroundTasks)) return 'viewing'
  if (finishedRecord(process)) return 'finished'
  if (process.status === 'starting' || process.activityPhase === 'working') return 'working'
  return 'ready'
}

const settledPhases = new Set<string>(['completed', 'failed', 'interrupted', 'idle'])
const finishedRecord = (process: RuntimeProcessSummary): boolean =>
  ['complete', 'exited', 'error', 'unavailable'].includes(process.status) || ['complete', 'failed', 'stopped'].includes(process.activityPhase ?? '')

/** How long background work may run before the board calls it stuck, unless the task declared
 *  its own timeout. */
export const BACKGROUND_EXPECTED_MS = 30 * 60 * 1000

/** A viewing conversation waits on work nobody watches, so a render or smoke that hung keeps it
 *  "Viewing" indefinitely. Each running detached task is aged from its own start against its
 *  declared timeout (a Bash `timeout`, in milliseconds) or the default; a count the runtime
 *  reported without a started row is aged from the conversation's last change. */
export function stuckBackgroundTask(
  snapshot: (Pick<SessionProjection, 'phase' | 'runtimeId' | 'items'> & Partial<Pick<SessionProjection, 'backgroundTasks'>>) | null | undefined,
  now = Date.now(),
  lastChangeAt?: string
): string | undefined {
  if (!snapshot || !isViewing(snapshot.phase, snapshot.backgroundTasks)) return undefined
  const shells = liveBackgroundShells(snapshot)
  const running = snapshot.items.filter(item => item.runtimeId === snapshot.runtimeId &&
    (item.data.type === 'tool' || item.data.type === 'subagent') && item.data.detached &&
    (item.data.status === 'running' || item.data.type === 'tool' && item.nativeItemId !== undefined && shells.has(item.nativeItemId)))
  const tasks = running.length
    ? running.map(item => ({ startedAt: item.timestamp, expected: declaredTimeout(item) ?? BACKGROUND_EXPECTED_MS }))
    : lastChangeAt ? [{ startedAt: lastChangeAt, expected: BACKGROUND_EXPECTED_MS }] : []
  let oldest: string | undefined, oldestAge = -1
  for (const task of tasks) {
    const age = now - Date.parse(task.startedAt)
    if (Number.isFinite(age) && age > task.expected && age > oldestAge) { oldest = task.startedAt; oldestAge = age }
  }
  const age = durationLabel(oldest, now)
  return age ? `background task stuck ${age}` : undefined
}
/** Claude answers a backgrounded Bash call at once ("running in background"), so its row reads
 *  completed while the shell runs on. Its task lifecycle notices (task_started, then a
 *  task_notification with a final status) say which shells, by tool_use_id, still run. */
function liveBackgroundShells(snapshot: Pick<SessionProjection, 'runtimeId' | 'items'>): Set<string> {
  const live = new Set<string>()
  for (const item of snapshot.items) {
    if (item.runtimeId !== snapshot.runtimeId || item.data.type !== 'notice' || item.data.message !== 'Claude task lifecycle') continue
    const payload = item.data.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const tool = payload.tool_use_id, status = payload.status
    if (typeof tool !== 'string') continue
    if (status === 'completed' || status === 'failed' || status === 'stopped' || payload.subtype === 'task_notification') live.delete(tool)
    else if (payload.subtype === 'task_started' && payload.is_backgrounded === true) live.add(tool)
  }
  return live
}
function declaredTimeout(item: TimelineItem): number | undefined {
  if (item.data.type !== 'tool') return undefined
  const input = item.data.input
  const timeout = input && typeof input === 'object' && !Array.isArray(input) ? input.timeout : undefined
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined
}

export const isProcessWorking = (process: RuntimeProcessSummary, snapshot?: Pick<SessionProjection, 'phase'> | null): boolean => ['working', 'viewing'].includes(processTrackerState(process, snapshot))

export function reportedPlanProgress(snapshot: SessionProjection | null | undefined): ReportedPlanProgress | undefined {
  if (!snapshot) return undefined
  const plan = snapshot.items
    .filter((item): item is TimelineItem & { data: Extract<TimelineItem['data'], { type: 'plan' }> } => item.runtimeId === snapshot.runtimeId && item.data.type === 'plan')
    .at(-1)
  if (!plan?.data.steps.length) return undefined
  const completed = plan.data.steps.filter(step => step.status === 'completed').length
  return { completed, total: plan.data.steps.length, label: `${completed}/${plan.data.steps.length} steps` }
}

/** The timestamp is the owner's most recent prompt in the active runtime. It is labelled as turn
 * time in the UI rather than pretending to be provider compute time. */
export function currentTurnStartedAt(snapshot: SessionProjection | null | undefined): string | undefined {
  if (!snapshot || !['running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(snapshot.phase)) return undefined
  return snapshot.items
    .filter(item => item.runtimeId === snapshot.runtimeId && !item.parentId && item.data.type === 'text' && item.data.role === 'user')
    .at(-1)?.timestamp
}

export function durationLabel(startedAt: string | undefined, now = Date.now()): string | undefined {
  if (!startedAt) return undefined
  const elapsed = now - Date.parse(startedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export interface SerialPoller {
  run(): Promise<void>
  dispose(): void
}

/** Prevents overlapping timer reads and commits one complete generation atomically. */
export function createSerialPoller<T>(read: () => Promise<T>, commit: (value: T) => void): SerialPoller {
  let disposed = false
  let pending: Promise<void> | undefined
  return {
    run() {
      if (disposed) return Promise.resolve()
      if (pending) return pending
      pending = read().then(value => { if (!disposed) commit(value) }).finally(() => { pending = undefined })
      return pending
    },
    dispose() { disposed = true }
  }
}
