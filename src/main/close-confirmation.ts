import type { RuntimeProcessSummary } from '../shared/models'
import type { SessionProjection } from '../shared/structured-agent'
import type { StopDecision } from './stop-confirmation'
import { hasSessionWork } from '../shared/session-work'

// The rule lives in shared so the renderer's own tab close asks on exactly the same work.
export { hasSessionWork }

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

/** The work quitting or restarting this app would cut: a conversation that runs on another
 *  machine (a tab placed on or mirrored from a paired host) is only watched from here, and closing
 *  this app detaches from it without touching the host, so it never blocks the quit
 *  (conductor-task:8ae9ecbc-d49b-4be2-8052-f2b9f5e78cda). */
export function localWork<T extends Pick<RuntimeProcessSummary, 'id'>>(running: T[], runsElsewhere: (id: string) => boolean): T[] {
  return running.filter(process => !runsElsewhere(process.id))
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
