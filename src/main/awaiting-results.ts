import type { SessionProjection } from '../shared/structured-agent'
import { AWAITING_RESULTS_PREFIX, MAX_AWAITED, MAX_AWAIT_REASON, evaluateAwaiting, parseAwaitingRecord, type AwaitedLookup, type AwaitingFact, type AwaitingRecord } from '../shared/awaiting-results'
import { handedOffIn } from '../shared/workspace-clarity'

/**
 * The main-process half of waiting for results (src/shared/awaiting-results.ts): the durable
 * record per waiting conversation, and whether it is waiting right now. AgentControl declares and
 * cancels; workspace clarity, the finished-tab sweep, the coworker auto-close sweep and the tab
 * archiver read fact() so a waiting tab stays in the active group and is never closed on a timer.
 */

type Settings = { getSetting(key: string): string | null; setSetting(key: string, value: string): void; removeSetting(key: string): void }

export interface AwaitingResultsDependencies extends AwaitedLookup {
  settings: Settings
  snapshot(id: string): SessionProjection | null
  /** Its work was taken over (agents.supersede, a successor): no longer waiting on its own account. */
  superseded?(id: string): boolean
  now?(): number
}

export class AwaitingResults {
  constructor(private readonly deps: AwaitingResultsDependencies) {}

  record(waiter: string): AwaitingRecord | null {
    return parseAwaitingRecord(this.deps.settings.getSetting(AWAITING_RESULTS_PREFIX + waiter))
  }

  /** Replaces the waiter's wait with these conversations (order kept, duplicates dropped). */
  declare(waiter: string, agents: readonly string[], reason?: string): AwaitingRecord {
    const unique = [...new Set(agents.filter(id => id && id !== waiter))].slice(0, MAX_AWAITED)
    if (!unique.length) throw new Error('Name at least one other conversation to wait for')
    const record: AwaitingRecord = {
      agents: unique, since: new Date(this.deps.now?.() ?? Date.now()).toISOString(), sinceSequence: this.deps.snapshot(waiter)?.sequence ?? 0,
      ...(reason?.trim() ? { reason: reason.trim().slice(0, MAX_AWAIT_REASON) } : {})
    }
    this.deps.settings.setSetting(AWAITING_RESULTS_PREFIX + waiter, JSON.stringify(record))
    return record
  }

  /** send_message with awaitReply: the recipient joins whatever is still owed. */
  add(waiter: string, agentSessionId: string, reason?: string): AwaitingRecord {
    const current = this.record(waiter), state = this.deps.snapshot(waiter)
    const owed = current && state ? evaluateAwaiting(current, state, this.deps).owed : []
    return this.declare(waiter, [...owed, agentSessionId], reason ?? current?.reason)
  }

  clear(waiter: string): boolean {
    const had = this.deps.settings.getSetting(AWAITING_RESULTS_PREFIX + waiter) !== null
    if (had) this.deps.settings.removeSetting(AWAITING_RESULTS_PREFIX + waiter)
    return had
  }

  /** Whether it is waiting now, and on whom. Deletes a wait every awaited message resolved. */
  fact(waiter: string, state: SessionProjection | null | undefined = this.deps.snapshot(waiter)): AwaitingFact | undefined {
    const record = this.record(waiter)
    if (!record || !state) return undefined
    const { owed, open } = evaluateAwaiting(record, state, this.deps)
    if (!owed.length) { this.clear(waiter); return undefined }
    // Stopped by the owner, handed on or taken over: not waiting (the record stays for a resume).
    if (state.phase === 'interrupted' || handedOffIn(state.items) || this.deps.superseded?.(waiter)) return undefined
    if (!open.length) return undefined
    return { agents: open, since: record.since, ...(record.reason ? { reason: record.reason } : {}) }
  }
}
