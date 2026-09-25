import type { RuntimeProcessSummary } from '../shared/models'
import type { SessionProjection } from '../shared/structured-agent'
import type { StopDecision } from './stop-confirmation'

/** What the quit/restart dialog asks about. Process existence is not turn evidence: idle
 *  adapters and shells remain open. `live` says whether this process still holds the
 *  conversation's runtime; when it does not, a queue or a background count left in the projection
 *  is history, not work (see hasSessionWork). A turn already being stopped is not work either:
 *  quitting only finishes what the stop asked for, and its queue waits for the owner. */
export function hasRunningWork(process: RuntimeProcessSummary, state?: SessionProjection | null, live?: boolean): boolean {
  if (process.kind !== 'agent') return false
  if (state) {
    return state.phase !== 'interrupting' && hasSessionWork(state, live)
  }
  return ['working', 'waiting_input', 'waiting_background'].includes(process.activityPhase ?? '') || Boolean(process.resumeAt)
}

/** Only a turn that is really running or waiting counts, never a tab that settled long ago. A
 *  usage-limit wait counts wherever it is, because Conductor itself continues it at the reset. */
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

/** Deduplicate close/menu/quit requests while the owner makes one decision. A yes/no dialog and
 *  the quit dialog's three-way decision share one pending answer: 'cancel' is no, anything else yes. */
export class CloseConfirmation {
  private pending: Promise<boolean | StopDecision> | undefined
  request(decide: () => Promise<boolean>): Promise<boolean> {
    return this.share(decide).then(answer => typeof answer === 'boolean' ? answer : answer !== 'cancel')
  }
  decide(decide: () => Promise<StopDecision>): Promise<StopDecision> {
    return this.share(decide).then(answer => typeof answer === 'boolean' ? (answer ? 'stop' : 'cancel') : answer)
  }
  private share(decide: () => Promise<boolean | StopDecision>): Promise<boolean | StopDecision> {
    if (this.pending) return this.pending
    const task = Promise.resolve().then(decide).finally(() => { if (this.pending === task) this.pending = undefined })
    this.pending = task
    return task
  }
}
