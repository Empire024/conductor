import type { SessionProjection } from './structured-agent'

/**
 * Waiting for results (feature-list `waiting-tabs-stay-active`). On 2026-09-29 an independent
 * reviewer tab ended its turn waiting for fix commits from coworkers it did not control; their
 * send_message would wake it, yet workspace clarity read "settled" as finished and put it in Done,
 * where the finished-tab sweep would eventually close it. Ending a provider turn is not finishing.
 *
 * The signal is an explicit declaration, because only the conversation knows it is waiting and an
 * idle tab that merely could receive a message is not:
 *
 * - agents.await({agents, reason?}) names the conversations whose results it waits for;
 * - send_message({agentSessionId, text, awaitReply: true}) (agents.steer with awaitReply) adds the
 *   recipient after delivering the message;
 * - a controller's live coworkers (control links) already keep it live in workspace clarity.
 *
 * The record lives in the settings table under AWAITING_RESULTS_PREFIX + the waiter's id, so it
 * survives a restart. What resolves it is the waiter's own durable event journal: a user message
 * whose origin is an awaited conversation (or one that took its work over), after the record's
 * cursor. Every route another tab reaches it by (send_message, agents.report, a successor's
 * message, a message across workspaces or projects) records that origin, and the message itself
 * starts the waiter's turn as it always did, so nothing polls.
 *
 * - Arrivals are consumed durably: the record keeps only the conversations still owed and the
 *   journal sequence it has read through (sinceSequence), so a reply that later falls out of the
 *   bounded timeline projection, or a restart, never brings a satisfied dependency back. Main
 *   consumes on every status change of a waiting conversation (a delivered message starts or
 *   joins a turn), well inside the journal's retention window.
 * - A turn that ends after the last owed message arrived, without declaring again, is finished
 *   work (the record is deleted and the tab goes to Done). A turn that declares again starts a
 *   fresh wait. send_message's awaitReply takes its baseline before the message is delivered, so a
 *   reply that arrives while the send is still returning counts.
 * - An awaited conversation with no open tab any more (closed, finished, never existed) is no
 *   longer waited for. If every one is gone the tab is not waiting; the record is kept, so an
 *   awaited coworker reopened by a message counts again.
 * - agents.await({clear:true}), agents.finish and any finish route (closeFinished) cancel it.
 * - While the waiter is stopped by the owner, handed off or superseded it is not waiting.
 */

export const AWAITING_RESULTS_PREFIX = 'awaitingResults:'
export const MAX_AWAITED = 20
export const MAX_AWAIT_REASON = 300

export interface AwaitingRecord {
  /** Conversations whose results are still owed, in the order named; arrivals are removed. */
  agents: string[]
  reason?: string
  /** When it was declared (ISO). */
  since: string
  /** The waiter's event sequence read through so far (the declaration's baseline at first): only
   *  later messages resolve it, and everything up to here has been consumed. */
  sinceSequence: number
  /** Each owed conversation's own baseline: only its messages after this count. A broadcast reply is
   *  judged against it, not against the cursor, which a catch-up read may have moved past a trimmed
   *  gap. Absent in records written before it existed: sinceSequence stands in. */
  baselines?: Record<string, number>
}

export const baselineOf = (record: Pick<AwaitingRecord, 'sinceSequence' | 'baselines'>, agentSessionId: string): number => record.baselines?.[agentSessionId] ?? record.sinceSequence

/** What the renderer and the close rules see: the conversations still owed, with titles. */
export interface AwaitingFact {
  agents: Array<{ agentSessionId: string; title: string }>
  reason?: string
  since: string
}

export function parseAwaitingRecord(raw: string | null | undefined): AwaitingRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<AwaitingRecord>
    if (!Array.isArray(value.agents) || !value.agents.every(id => typeof id === 'string' && id) || typeof value.since !== 'string' || typeof value.sinceSequence !== 'number') return null
    const baselines = value.baselines && typeof value.baselines === 'object' && !Array.isArray(value.baselines) ? Object.fromEntries(Object.entries(value.baselines).filter(([, sequence]) => typeof sequence === 'number')) as Record<string, number> : undefined
    return { agents: value.agents, since: value.since, sinceSequence: value.sinceSequence, ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}), ...(baselines ? { baselines } : {}) }
  } catch { return null }
}

/** Anything sequenced that carries timeline data: journal events and projection items alike. */
export interface Sequenced { sequence: number; data: SessionProjection['items'][number]['data'] }

/** The conversations whose messages arrived among `entries` after sequence `after`. */
export function arrivedFrom(after: number, entries: Iterable<Sequenced>, into: Set<string> = new Set()): Set<string> {
  for (const entry of entries) {
    if (entry.sequence <= after) continue
    const data = entry.data
    if (data.type === 'text' && data.role === 'user' && data.origin?.agentSessionId) into.add(data.origin.agentSessionId)
  }
  return into
}

export interface AwaitedLookup {
  /** The awaited conversation's open tab title, or undefined when it has none any more. */
  open(agentSessionId: string): string | undefined
  /** The conversations that took its work over (handoff successor, supersede), nearest first. */
  successors(agentSessionId: string): string[]
}

export interface AwaitingEvaluation {
  /** Awaited conversations whose result has not arrived, with or without an open tab. */
  owed: string[]
  /** Of those, the ones still open: the waiter is waiting while this is not empty. */
  open: Array<{ agentSessionId: string; title: string }>
}

export function evaluateAwaiting(record: AwaitingRecord, arrived: ReadonlySet<string>, lookup: AwaitedLookup): AwaitingEvaluation {
  const owed = record.agents.filter(id => ![id, ...lookup.successors(id)].some(candidate => arrived.has(candidate)))
  const open = owed.flatMap(id => {
    // A handed-off conversation's successor carries its work, and its report.
    for (const candidate of [id, ...lookup.successors(id)].reverse()) {
      const title = lookup.open(candidate)
      if (title !== undefined) return [{ agentSessionId: candidate, title }]
    }
    return []
  })
  return { owed, open }
}

/** "waiting for Fixer A, Fixer B" in a row; the full sentence goes in the tooltip. */
export function awaitingLabel(fact: Pick<AwaitingFact, 'agents'>, limit = 2): string {
  const names = fact.agents.map(agent => agent.title || agent.agentSessionId)
  if (!names.length) return 'waiting for results'
  const shown = names.slice(0, limit).join(', ')
  return `waiting for ${shown}${names.length > limit ? ` +${names.length - limit}` : ''}`
}

export function awaitingSentence(fact: AwaitingFact): string {
  const names = fact.agents.map(agent => `${agent.title || 'a conversation'} (${agent.agentSessionId})`).join(', ')
  return `Waiting for results from ${names || 'other conversations'}${fact.reason ? `: ${fact.reason}` : ''}. It wakes when they message it.`
}
