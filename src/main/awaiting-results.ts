import type { AgentEvent, SessionProjection } from '../shared/structured-agent'
import { AWAITING_RESULTS_PREFIX, MAX_AWAITED, MAX_AWAIT_REASON, arrivedFrom, evaluateAwaiting, parseAwaitingRecord, type AwaitedLookup, type AwaitingFact, type AwaitingRecord } from '../shared/awaiting-results'
import { handedOffIn } from '../shared/workspace-clarity'

/**
 * The main-process half of waiting for results (src/shared/awaiting-results.ts): the durable
 * record per waiting conversation, and whether it is waiting right now. AgentControl declares and
 * cancels; every status change of a waiting conversation consumes its new arrivals (index.ts);
 * workspace clarity, the finished-tab sweep, the coworker auto-close sweep and the tab archiver
 * read fact() so a waiting tab stays in the active group and is never closed on a timer.
 */

type Settings = { getSetting(key: string): string | null; setSetting(key: string, value: string): void; removeSetting(key: string): void }

/** Journal rows read per page, and pages per consume: the journal keeps 20,000 events per
 *  conversation (structured-store JOURNAL_WINDOW), and each consume resumes where the last stopped. */
const PAGE = 1000
const MAX_PAGES = 20

export interface AwaitingResultsDependencies extends AwaitedLookup {
  settings: Settings
  snapshot(id: string): SessionProjection | null
  /** The durable event journal, `from` <= sequence < `to` (StructuredStore.journalRange). */
  journal?(id: string, from: number, to: number, limit: number): AgentEvent[]
  /** Its oldest retained sequence (StructuredStore.journalFloor). */
  journalFloor?(id: string): number | null
  /** Its work was taken over (agents.supersede, a successor): no longer waiting on its own account. */
  superseded?(id: string): boolean
  now?(): number
}

export class AwaitingResults {
  constructor(private readonly deps: AwaitingResultsDependencies) {}

  private key(waiter: string): string { return AWAITING_RESULTS_PREFIX + waiter }

  record(waiter: string): AwaitingRecord | null {
    return parseAwaitingRecord(this.deps.settings.getSetting(this.key(waiter)))
  }

  private save(waiter: string, record: AwaitingRecord): void { this.deps.settings.setSetting(this.key(waiter), JSON.stringify(record)) }

  /** Replaces the waiter's wait with these conversations (order kept, duplicates dropped).
   *  `baseline` is the waiter's sequence before the message that asked for the results went out;
   *  by default its sequence now. */
  declare(waiter: string, agents: readonly string[], reason?: string, baseline?: number): AwaitingRecord {
    const unique = [...new Set(agents.filter(id => id && id !== waiter))].slice(0, MAX_AWAITED)
    if (!unique.length) throw new Error('Name at least one other conversation to wait for')
    const record: AwaitingRecord = {
      agents: unique, since: new Date(this.deps.now?.() ?? Date.now()).toISOString(), sinceSequence: baseline ?? this.deps.snapshot(waiter)?.sequence ?? 0,
      ...(reason?.trim() ? { reason: reason.trim().slice(0, MAX_AWAIT_REASON) } : {})
    }
    this.save(waiter, record)
    // Whatever already arrived after the baseline (a reply faster than the send) counts at once.
    return this.consume(waiter) ?? { ...record, agents: [] }
  }

  /** send_message with awaitReply: the recipient joins whatever is still owed, counted from
   *  `baseline`, the sender's sequence before its message was delivered. */
  add(waiter: string, agentSessionId: string, baseline: number, reason?: string): AwaitingRecord {
    const current = this.consume(waiter)
    // Everything owed before was read through at least up to now, so rereading from the earlier
    // baseline only finds what consume() already removed.
    const from = current ? Math.min(current.sinceSequence, baseline) : baseline
    return this.declare(waiter, [...current?.agents ?? [], agentSessionId], reason ?? current?.reason, from)
  }

  clear(waiter: string): boolean {
    const had = this.deps.settings.getSetting(this.key(waiter)) !== null
    if (had) this.deps.settings.removeSetting(this.key(waiter))
    return had
  }

  /** Reads the waiter's arrivals since the record's cursor from the durable journal, removes the
   *  conversations that answered and saves how far it read. Returns what is still owed, or null
   *  when nothing is (the record is then gone). */
  consume(waiter: string): AwaitingRecord | null {
    const record = this.record(waiter)
    if (!record) return null
    const state = this.deps.snapshot(waiter)
    if (!state) return record
    const arrived = new Set<string>()
    let through = record.sinceSequence
    if (this.deps.journal) {
      const floor = this.deps.journalFloor?.(waiter) ?? null
      // Trimmed past the cursor (or never journaled): the projection is all there is to read.
      if (floor === null || floor > through + 1) arrivedFrom(through, state.items, arrived)
      for (let page = 0; page < MAX_PAGES && through < state.sequence; page++) {
        const events = this.deps.journal(waiter, through + 1, state.sequence + 1, PAGE)
        if (!events.length) { through = state.sequence; break }
        arrivedFrom(through, events, arrived)
        through = events[events.length - 1]!.sequence
        if (events.length < PAGE) { through = state.sequence; break }
      }
    } else {
      arrivedFrom(through, state.items, arrived)
      through = state.sequence
    }
    const owed = evaluateAwaiting(record, arrived, this.deps).owed
    if (!owed.length) { this.clear(waiter); return null }
    const next: AwaitingRecord = { ...record, agents: owed, sinceSequence: Math.max(record.sinceSequence, through) }
    if (next.sinceSequence !== record.sinceSequence || owed.length !== record.agents.length) this.save(waiter, next)
    return next
  }

  /** Whether it is waiting now, and on whom. */
  fact(waiter: string): AwaitingFact | undefined {
    const record = this.consume(waiter), state = this.deps.snapshot(waiter)
    if (!record || !state) return undefined
    // Stopped by the owner, handed on or taken over: not waiting (the record stays for a resume).
    if (state.phase === 'interrupted' || handedOffIn(state.items) || this.deps.superseded?.(waiter)) return undefined
    const open = evaluateAwaiting(record, new Set(), this.deps).open
    if (!open.length) return undefined
    return { agents: open, since: record.since, ...(record.reason ? { reason: record.reason } : {}) }
  }
}
