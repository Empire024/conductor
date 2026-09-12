import type { RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection, TimelineItem } from '../../../shared/structured-agent'

export type ProcessTrackerState = 'attention' | 'working' | 'paused' | 'disconnected' | 'ready' | 'finished'

export interface ReportedPlanProgress {
  completed: number
  total: number
  label: string
}

/** Runtime state comes from the persisted process/activity record. A connected adapter is only
 * "working" when it is starting or its activity phase says work is being produced. */
export function processTrackerState(process: RuntimeProcessSummary, snapshot?: Pick<SessionProjection, 'phase'> | null): ProcessTrackerState {
  // Connection state and execution state are distinct. A completed turn can later lose its
  // adapter while retaining a resumable native conversation; that snapshot is authoritative for
  // whether the owner must explicitly reconnect it.
  if (snapshot?.phase === 'disconnected') return 'disconnected'
  if (process.needsInput || process.status === 'waiting_input' || process.activityPhase === 'waiting_input') return 'attention'
  if (process.status === 'limited' || process.activityPhase === 'limited') return 'paused'
  if (process.activityPhase === 'disconnected') return 'disconnected'
  if (['complete', 'exited', 'error', 'unavailable'].includes(process.status) || ['complete', 'failed', 'stopped'].includes(process.activityPhase ?? '')) return 'finished'
  if (process.status === 'starting' || process.activityPhase === 'working') return 'working'
  return 'ready'
}

export const isProcessWorking = (process: RuntimeProcessSummary, snapshot?: Pick<SessionProjection, 'phase'> | null): boolean => processTrackerState(process, snapshot) === 'working'

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
