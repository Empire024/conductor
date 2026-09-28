import type { AgentEvent, AgentEventData } from '../shared/structured-agent'
import { isControlActivityNotice } from '../shared/control-activity'
import { ArgumentError } from './control-args'

/**
 * agents.history as a controller reads it: the newest few entries of a conversation, compact.
 *
 * The journal is the native event stream: one row per streamed delta, restated session phases,
 * usage figures, and each tool's full input and output. Handing that over verbatim cost a
 * controller 161 KB for 100 of the *oldest* events of a conversation (2026-09-28), when what it
 * wanted was the last answer. So by default the journal is read backwards in bounded pages from
 * the newest row, consecutive events of one item are folded into one entry, bookkeeping is left
 * out, and every text is capped. `raw:true` keeps the old contract (oldest first after
 * afterSequence) for mirrors and tools that fold events themselves.
 */

export interface HistoryJournal {
  /** Rows from <= sequence < to, oldest first, at most limit (StructuredStore.journalRange). */
  range(from: number, to: number, limit: number): AgentEvent[]
  /** The oldest sequence still held, or null for an empty journal. */
  floor(): number | null
  /** The newest sequence of the conversation (its projection's), or null when unknown. */
  latest(): number | null
}

export interface HistoryEntry {
  sequence: number
  firstSequence?: number
  at: string
  type: AgentEventData['type']
  role?: string
  text?: string
  truncated?: true
  chars?: number
  tool?: string
  description?: string
  input?: string
  status?: string
  exitCode?: number
  durationMs?: number
  outputArtifactId?: string
  outputTail?: string
  phase?: string
  paths?: string[]
  outcome?: string
}

export const HISTORY_DEFAULT_LIMIT = 20, HISTORY_MAX_LIMIT = 100, HISTORY_TEXT = 2000
const PAGE = 400, SCAN = 5000
/** Stream plumbing a reader never needs: token counts, queue and steering bookkeeping. */
const SKIPPED = new Set<AgentEventData['type']>(['usage', 'queue', 'steering', 'input_delivery'])

const clip = (value: string, maximum: number): { text: string; truncated?: true; chars?: number } =>
  value.length > maximum ? { text: value.slice(0, maximum), truncated: true, chars: value.length } : { text: value }
const tail = (value: string, maximum: number): string => value.length > maximum ? '…' + value.slice(-maximum) : value
const oneLine = (value: unknown, maximum: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maximum ? text.slice(0, maximum) + '…' : text
}

/** Events of one item that follow each other fold into one entry; phases fold into the latest. */
const groupKey = (event: AgentEvent): string => event.data.type === 'session' ? 'session' : `${event.data.type}:${event.itemId ?? event.id}`

/** One entry out of the events of one item, oldest first. */
export function compactEntry(events: AgentEvent[]): HistoryEntry {
  const last = events[events.length - 1]!, first = events[0]!
  const entry: HistoryEntry = { sequence: last.sequence, ...(events.length > 1 ? { firstSequence: first.sequence } : {}), at: last.timestamp, type: last.data.type }
  const data = last.data
  if (data.type === 'text') {
    let text = ''
    for (const event of events) if (event.data.type === 'text') text = event.data.mode === 'snapshot' ? event.data.text : text + event.data.text
    return { ...entry, role: data.role, ...clip(text, HISTORY_TEXT) }
  }
  if (data.type === 'tool') {
    const tools = events.map(event => event.data).filter((value): value is Extract<AgentEventData, { type: 'tool' }> => value.type === 'tool')
    const find = <K extends keyof Extract<AgentEventData, { type: 'tool' }>>(key: K) => [...tools].reverse().find(value => value[key] !== undefined)?.[key]
    let output = ''
    for (const value of tools) if (value.output !== undefined) output = value.outputMode === 'delta' ? output + value.output : value.output
    const failed = data.status === 'failed' || (typeof find('exitCode') === 'number' && find('exitCode') !== 0)
    const stderr = find('stderr') as string | undefined
    return Object.assign(entry, {
      tool: find('name') as string, status: data.status,
      ...(find('description') ? { description: oneLine(find('description'), 200) } : {}),
      ...(find('input') !== undefined ? { input: oneLine(find('input'), 300) } : {}),
      ...(typeof find('exitCode') === 'number' ? { exitCode: find('exitCode') as number } : {}),
      ...(typeof find('durationMs') === 'number' ? { durationMs: find('durationMs') as number } : {}),
      ...(find('outputArtifactId') ? { outputArtifactId: find('outputArtifactId') as string } : {}),
      ...(failed && (stderr || output) ? { outputTail: tail(stderr || output, 500) } : {})
    })
  }
  if (data.type === 'session') return { ...entry, phase: data.phase, ...(data.message ? clip(data.message, HISTORY_TEXT) : {}) }
  if (data.type === 'changes') return { ...entry, paths: data.changes.slice(0, 20).map(change => `${change.kind} ${change.path}`), status: data.changes.map(change => change.status).at(-1) }
  if (data.type === 'interaction') return { ...entry, role: data.interaction.kind, ...clip(data.interaction.title, HISTORY_TEXT), status: data.interaction.status, ...(data.interaction.outcome ? { outcome: data.interaction.outcome } : {}) }
  if (data.type === 'plan') return { ...entry, ...clip(data.steps.map(step => `[${step.status}] ${step.text}`).join('\n'), HISTORY_TEXT) }
  if (data.type === 'error') return { ...entry, ...clip(data.message, HISTORY_TEXT) }
  if (data.type === 'notice') return { ...entry, ...clip(data.message, HISTORY_TEXT), ...(data.outputArtifactId ? { outputArtifactId: data.outputArtifactId } : {}) }
  if (data.type === 'subagent') return { ...entry, tool: data.name, status: data.status, ...(data.output ? clip(data.output, HISTORY_TEXT) : {}) }
  if (data.type === 'review') return { ...entry, outcome: data.outcome }
  return entry
}

const cursorOf = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ArgumentError(`${key} must be a sequence number (a whole number of 0 or more) from an earlier agents.history result`)
  return value
}

/** agents.history for one conversation; `args` are already checked for unknown keys. */
export function readHistory(agentSessionId: string, journal: HistoryJournal, args: Record<string, unknown>): unknown {
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1)) throw new ArgumentError(`limit must be a whole number from 1 to ${HISTORY_MAX_LIMIT}`)
  if (args.raw !== undefined && typeof args.raw !== 'boolean') throw new ArgumentError('raw must be true or false')
  const after = cursorOf(args, 'afterSequence'), before = cursorOf(args, 'before')
  if (after !== undefined && before !== undefined) throw new ArgumentError('pass before (page back from the newest) or afterSequence (read forward), not both')
  const requested = args.limit as number | undefined
  if (args.raw === true) {
    if (before !== undefined) throw new ArgumentError('raw:true reads forward with afterSequence; before pages the compact history')
    // The contract mirrors and the overseer page on: up to 100 native events after afterSequence.
    return journal.range((after ?? 0) + 1, Number.MAX_SAFE_INTEGER, Math.min(requested ?? HISTORY_MAX_LIMIT, HISTORY_MAX_LIMIT)).filter(event => !isControlActivityNotice(event.data))
  }
  const limit = Math.min(requested ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)
  const groups: Array<{ key: string; events: AgentEvent[] }> = []
  const forward = after !== undefined
  const take = (event: AgentEvent): void => {
    if (SKIPPED.has(event.data.type) || isControlActivityNotice(event.data)) return
    const key = groupKey(event), current = groups[groups.length - 1]
    if (current?.key === key) { if (forward) current.events.push(event); else current.events.unshift(event) }
    else groups.push({ key, events: [event] })
  }
  let scanned = 0, exhausted = false, lastScanned: number | undefined
  if (forward) {
    for (let from = after + 1; groups.length <= limit;) {
      if (scanned >= SCAN) break
      const page = journal.range(from, Number.MAX_SAFE_INTEGER, PAGE)
      scanned += page.length
      for (const event of page) take(event)
      lastScanned = page[page.length - 1]?.sequence ?? lastScanned
      if (page.length < PAGE) { exhausted = true; break }
      from = page[page.length - 1]!.sequence + 1
    }
  } else {
    const floor = journal.floor()
    if (floor === null) exhausted = true
    else {
      let to = before ?? (journal.latest() ?? floor) + 1
      while (groups.length <= limit && scanned < SCAN && to > floor) {
        const from = Math.max(floor, to - PAGE)
        const page = journal.range(from, to, PAGE)
        scanned += page.length
        for (let index = page.length - 1; index >= 0; index--) take(page[index]!)
        to = from
      }
      exhausted = to <= floor
    }
  }
  const kept = groups.slice(0, limit), entries = kept.map(group => compactEntry(group.events))
  const hasMore = groups.length > limit || !exhausted
  if (forward) {
    // Everything read counts as seen once nothing is held back, skipped bookkeeping included.
    const nextAfter = groups.length <= limit && lastScanned !== undefined ? lastScanned : kept.length ? Math.max(...kept.flatMap(group => group.events.map(event => event.sequence))) : after
    return { agentSessionId, order: 'oldest-first', entries, hasMore, nextAfter }
  }
  const oldest = kept.length ? Math.min(...kept[kept.length - 1]!.events.map(event => event.sequence)) : undefined
  return { agentSessionId, order: 'newest-first', entries, hasMore: hasMore && oldest !== undefined, ...(oldest !== undefined ? { before: oldest } : {}), ...(hasMore && oldest !== undefined ? { note: `Older entries: agents.history({agentSessionId:"${agentSessionId}",before:${oldest}})` } : {}) }
}
