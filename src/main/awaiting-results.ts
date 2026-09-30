import type { AgentEvent, SessionProjection } from '../shared/structured-agent'
import { AWAITING_RESULTS_PREFIX, AWAIT_QUIET_GRACE_MS, DEFAULT_AWAIT_MINUTES, MAX_AWAITED, MAX_AWAIT_REASON, arrivedFrom, baselineOf, evaluateAwaiting, parseAwaitingRecord, type AwaitedLookup, type Sequenced, type AwaitingFact, type AwaitingRecord } from '../shared/awaiting-results'
import { handedOffIn } from '../shared/workspace-clarity'

/**
 * The main-process half of waiting for results (src/shared/awaiting-results.ts): the durable
 * record per waiting conversation, and whether it is waiting right now. AgentControl declares and
 * cancels; a delivered message from another conversation, and every status change of a waiting
 * conversation, consumes its new arrivals (index.ts);
 * workspace clarity, the finished-tab sweep, the coworker auto-close sweep and the tab archiver
 * read fact() so a waiting tab stays in the active group and is never closed on a timer.
 */

/** The newest sequence of a message from each other conversation among `entries` after `after`. */
function latestFrom(after: number, entries: Iterable<Sequenced>, into: Map<string, number>): void {
  for (const entry of entries) {
    if (entry.sequence <= after) continue
    const from = arrivedFrom(after, [entry])
    for (const id of from) into.set(id, Math.max(into.get(id) ?? -Infinity, entry.sequence))
  }
}

/** The settings key listing every conversation with a wait record. */
const AWAITING_INDEX = 'awaitingResultsIndex'
/** A waiter whose turn has ended: only such a tab is woken; one mid-turn is not waiting yet. */
const SETTLED_WAITER = new Set<SessionProjection['phase']>(['idle', 'completed', 'failed', 'disconnected'])

/** A wait the sweep ended: its deadline passed, or everyone it waited for went quiet. `agents` are
 *  the conversations now carrying the awaited work (a successor in place of a handed-off one). */
export interface AwaitWake { waiter: string; kind: 'deadline' | 'quiet'; record: AwaitingRecord; agents: string[] }

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

  private save(waiter: string, record: AwaitingRecord): void {
    this.deps.settings.setSetting(this.key(waiter), JSON.stringify(record))
    const index = this.waiters()
    if (!index.includes(waiter)) this.deps.settings.setSetting(AWAITING_INDEX, JSON.stringify([...index, waiter]))
  }

  /** The conversations with a wait record, for the deadline and quiet sweep (the settings table has
   *  no prefix listing). Records written before the index existed are not swept until declared again. */
  waiters(): string[] {
    try {
      const value: unknown = JSON.parse(this.deps.settings.getSetting(AWAITING_INDEX) ?? '[]')
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    } catch { return [] }
  }

  /** When each waiter's awaited conversations were first seen all quiet (in memory: a restart
   *  only restarts the grace period). */
  private readonly quietSince = new Map<string, number>()

  /** The waits to end now: a passed deadline, or every awaited conversation quiet for the grace
   *  period without messaging. Each returned wait is already cleared; the caller wakes its waiter.
   *  A waiter mid-turn, stopped by the owner, handed off or superseded is left alone. */
  sweep(quiet: (agentSessionId: string) => boolean, graceMs = AWAIT_QUIET_GRACE_MS): AwaitWake[] {
    const now = this.deps.now?.() ?? Date.now(), wakes: AwaitWake[] = []
    const index = this.waiters()
    for (const waiter of index) {
      const record = this.consume(waiter), state = this.deps.snapshot(waiter)
      if (!record) { this.quietSince.delete(waiter); continue }
      if (!state || !SETTLED_WAITER.has(state.phase) || handedOffIn(state.items) || this.deps.superseded?.(waiter)) { this.quietSince.delete(waiter); continue }
      if (record.deadline && Date.parse(record.deadline) <= now) {
        this.clear(waiter)
        wakes.push({ waiter, kind: 'deadline', record, agents: record.agents.map(id => this.holder(id)) })
        continue
      }
      const agents = record.agents.map(id => this.holder(id))
      if (!agents.every(id => this.deps.open(id) === undefined || quiet(id))) { this.quietSince.delete(waiter); continue }
      const first = this.quietSince.get(waiter) ?? now
      this.quietSince.set(waiter, first)
      if (now - first < graceMs) continue
      this.clear(waiter)
      wakes.push({ waiter, kind: 'quiet', record, agents })
    }
    return wakes
  }

  /** The conversation carrying an awaited one's work now: its newest open successor, else itself. */
  private holder(id: string): string {
    for (const candidate of [id, ...this.deps.successors(id)].reverse()) if (this.deps.open(candidate) !== undefined) return candidate
    return id
  }

  /** Replaces the waiter's wait with these conversations (order kept, duplicates dropped).
   *  `baseline` is the waiter's sequence before the message that asked for the results went out;
   *  by default its sequence now. */
  declare(waiter: string, agents: readonly string[], reason?: string, baseline?: number, kept: Record<string, number> = {}, deadline?: string): AwaitingRecord {
    const unique = [...new Set(agents.filter(id => id && id !== waiter))].slice(0, MAX_AWAITED)
    if (!unique.length) throw new Error('Name at least one other conversation to wait for')
    const from = baseline ?? this.deps.snapshot(waiter)?.sequence ?? 0
    const now = this.deps.now?.() ?? Date.now()
    const record: AwaitingRecord = {
      agents: unique, since: new Date(now).toISOString(), sinceSequence: from,
      // An agent still owed from an earlier wait keeps its own, earlier baseline.
      baselines: Object.fromEntries(unique.map(id => [id, kept[id] ?? from])),
      ...(reason?.trim() ? { reason: reason.trim().slice(0, MAX_AWAIT_REASON) } : {}),
      deadline: deadline ?? new Date(now + DEFAULT_AWAIT_MINUTES * 60_000).toISOString()
    }
    this.quietSince.delete(waiter)
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
    // The shared cursor may start earlier, but the new recipient counts only from its own pre-send
    // baseline; one already owed keeps its earlier baseline.
    const kept = { ...current ? Object.fromEntries(current.agents.map(id => [id, baselineOf(current, id)])) : {}, ...current?.agents.includes(agentSessionId) ? {} : { [agentSessionId]: baseline } }
    // An earlier deadline still stands; a first wait gets the default one.
    return this.declare(waiter, [...current?.agents ?? [], agentSessionId], reason ?? current?.reason, from, kept, current?.deadline)
  }

  clear(waiter: string): boolean {
    const had = this.deps.settings.getSetting(this.key(waiter)) !== null
    if (had) this.deps.settings.removeSetting(this.key(waiter))
    this.quietSince.delete(waiter)
    const index = this.waiters()
    if (index.includes(waiter)) {
      const rest = index.filter(id => id !== waiter)
      if (rest.length) this.deps.settings.setSetting(AWAITING_INDEX, JSON.stringify(rest))
      else this.deps.settings.removeSetting(AWAITING_INDEX)
    }
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
    // The projection also holds events staged but not yet written to the journal (the newest ones),
    // so both are read: the journal for everything durable since the cursor, the projection for
    // the staged tail and for anything the journal no longer holds.
    const arrived = new Map<string, number>()
    latestFrom(record.sinceSequence, state.items, arrived)
    let through = record.sinceSequence, exhausted = !this.deps.journal
    for (let page = 0; this.deps.journal && page < MAX_PAGES && through < state.sequence; page++) {
      const events = this.deps.journal(waiter, through + 1, state.sequence + 1, PAGE)
      latestFrom(through, events, arrived)
      if (events.length) through = events[events.length - 1]!.sequence
      if (events.length < PAGE) { exhausted = true; break }
    }
    if (through >= state.sequence) exhausted = true
    // The cursor moves past the journal's end only once the journal was read to its end: then
    // every later event is in the projection, which was just read. Otherwise it stops at the last
    // durable event read, and the next consume continues from there.
    if (exhausted) through = Math.max(through, state.sequence)
    // Each sender's newest message counts only when it is newer than that agent's own baseline.
    const owed = record.agents.filter(id => ![id, ...this.deps.successors(id)].some(sender => (arrived.get(sender) ?? -Infinity) > baselineOf(record, id)))
    if (!owed.length) { this.clear(waiter); return null }
    // Baselines are written out before the cursor moves: a record from before they existed would
    // otherwise take the advanced cursor as every agent's baseline.
    const next: AwaitingRecord = { ...record, agents: owed, sinceSequence: Math.max(record.sinceSequence, through), baselines: Object.fromEntries(owed.map(id => [id, baselineOf(record, id)])) }
    if (next.sinceSequence !== record.sinceSequence || owed.length !== record.agents.length || !record.baselines) this.save(waiter, next)
    return next
  }

  /** Journal events as they are broadcast (already durable): a message from another conversation
   *  consumes its recipient's wait at once, even when it joins a running turn and no status change
   *  follows. Only user messages with an origin are looked at. */
  noteEvents(events: ReadonlyArray<{ sessionId: string; sequence: number; data: { type: string; role?: string; origin?: { agentSessionId?: string } } }>): void {
    const replies = new Map<string, Array<{ from: string; sequence: number }>>()
    for (const event of events) {
      const from = event.data.type === 'text' && event.data.role === 'user' ? event.data.origin?.agentSessionId : undefined
      if (from) replies.set(event.sessionId, [...replies.get(event.sessionId) ?? [], { from, sequence: event.sequence }])
    }
    for (const [waiter, arrived] of replies) {
      const record = this.record(waiter)
      if (!record) continue
      // The broadcast reply itself is the evidence: it may already have left the journal and the
      // projection (a flush checkpoints, and may trim, before its batch is broadcast). It counts when
      // it is newer than that agent's own baseline, wherever the cursor has got to.
      const owed = record.agents.filter(id => {
        const senders = new Set([id, ...this.deps.successors(id)])
        return !arrived.some(reply => senders.has(reply.from) && reply.sequence > baselineOf(record, id))
      })
      if (!owed.length) { this.clear(waiter); continue }
      if (owed.length !== record.agents.length) this.save(waiter, { ...record, agents: owed, baselines: Object.fromEntries(owed.map(id => [id, baselineOf(record, id)])) })
      this.consume(waiter)
    }
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
