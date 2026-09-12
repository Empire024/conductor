import type { RuntimeProcessSummary } from '../shared/models'
import type { SessionProjection } from '../shared/structured-agent'

/** Process existence is not turn evidence: idle adapters and shells remain open. */
export function hasRunningWork(process: RuntimeProcessSummary, state?: SessionProjection | null): boolean {
  if (process.kind !== 'agent') return false
  if (state) {
    if (['running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(state.phase)) return true
    if (state.queued || state.queuedPrompts?.length) return true
    if (state.pendingSteering?.some(input => input.status === 'sending' || input.status === 'accepted')) return true
    if (state.items.some(item => item.data.type === 'tool' && item.data.detached && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status))) return true
    if (state.items.some(item => item.data.type === 'subagent' && item.data.detached && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status))) return true
    // `starting` is also used for metadata-only provider connections, so it is not turn evidence.
    return false
  }
  return ['working', 'waiting_input'].includes(process.activityPhase ?? '') || Boolean(process.resumeAt)
}

/** Deduplicate close/menu/quit requests while the owner makes one decision. */
export class CloseConfirmation {
  private pending: Promise<boolean> | undefined
  request(decide: () => Promise<boolean>): Promise<boolean> {
    if (this.pending) return this.pending
    const task = Promise.resolve().then(decide).finally(() => { if (this.pending === task) this.pending = undefined })
    this.pending = task
    return task
  }
}
