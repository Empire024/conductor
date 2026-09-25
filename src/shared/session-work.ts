import type { SessionProjection } from './structured-agent'

/** Only a turn that is really running or waiting counts, never a tab that settled long ago. A
 *  usage-limit wait counts wherever it is, because Conductor itself continues it at the reset.
 *  Shared by the quit dialog, app-control tabs.close and the owner's own tab close. */
export function hasSessionWork(state: SessionProjection, live?: boolean): boolean {
    if (['running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(state.phase)) return true
    if (state.limitResumeAt) return true
    // A stopped conversation, or one without a runtime in this process, cannot drain a queued
    // message or hear from background work: whatever the projection still holds is stale.
    if (live === false || ['interrupted', 'failed', 'disconnected'].includes(state.phase)) return false
    if (state.queued || state.queuedPrompts?.length) return true
    if (state.pendingSteering?.some(input => input.status === 'sending' || input.status === 'accepted')) return true
    if (state.backgroundTasks !== undefined) return state.backgroundTasks > 0
    if (state.items.some(item => item.runtimeId === state.runtimeId && (item.data.type === 'tool' || item.data.type === 'subagent') && item.data.detached && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status))) return true
    // `starting` is also used for metadata-only provider connections, so it is not turn evidence.
    return false
}

/** Names the work hasSessionWork found, for a confirmation ("running a turn"). */
export function describeSessionWork(state: SessionProjection): string {
  if (state.phase === 'waiting_approval') return 'waiting for your approval'
  if (state.phase === 'waiting_input') return 'waiting for your answer'
  if (state.phase === 'interrupting') return 'stopping its turn'
  if (state.phase === 'running') return 'running a turn'
  if (state.limitResumeAt) return 'waiting to continue after its usage limit'
  const queued = state.queuedPrompts?.length || (state.queued ? 1 : 0)
  if (queued) return queued === 1 ? '1 queued prompt' : `${queued} queued prompts`
  if (state.backgroundTasks) return state.backgroundTasks === 1 ? '1 background task' : `${state.backgroundTasks} background tasks`
  return 'still working'
}
