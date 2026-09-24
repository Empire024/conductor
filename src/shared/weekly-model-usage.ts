import type { AgentEvent, AgentEventData, StructuredProvider } from './structured-agent'

export const WEEKLY_USAGE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The envelope fields weekly accounting actually reads. A durable `AgentEvent` satisfies it, and
 * so does a row the store projects straight out of SQLite: a seven-day total must never require
 * pulling whole transcript bodies - tool output and message text - back through the main process.
 */
export interface WeeklyUsageEvent {
  id: string
  sequence: number
  timestamp: string
  runtimeId: string
  provider?: StructuredProvider
  nativeSessionId?: string
  turnId?: string
  itemId?: string
  parentId?: string
  data: AgentEventData
}
const tokenFields = ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens'] as const
type TokenField = typeof tokenFields[number]

export interface WeeklyUsageConversation {
  sessionId: string
  provider: StructuredProvider
  model?: string
  events: WeeklyUsageEvent[]
  /** Earliest durable event timestamp for each runtime, read without parsing transcript bodies. */
  runtimeStarts?: Record<string, string>
  /** True when the durable journal hit its read cap, so older baselines may be missing. */
  truncated?: boolean
}

export interface WeeklyModelUsage extends Partial<Record<TokenField, number>> {
  provider: StructuredProvider
  /** Exact configured or provider-reported id. Missing model facts stay in an explicit bucket. */
  model: string | null
  conversations: number
  reports: number
  estimated: boolean
}

export interface WeeklyModelUsageReport {
  since: string
  through: string
  days: number
  models: WeeklyModelUsage[]
  coverage: {
    complete: boolean
    notes: string[]
    conversationsScanned: number
    conversationsWithUsage: number
    truncatedConversations: number
    /** Cumulative counters that could not be split at the boundary are excluded. */
    countersWithoutBaseline: number
    nestedReportsExcluded: number
  }
  /** Local assist calls over the same window (src/main/local-assist); absent where it is not running. */
  localSavings?: { tokensSaved: number; calls: number; modelCalls: number; localInputTokens: number; localOutputTokens: number }
}

interface Sample {
  sessionId: string
  provider: StructuredProvider
  model: string | null
  at: number
  source: 'provider' | 'estimate'
  values: Partial<Record<TokenField, number>>
  runtimeId: string
  counterKey: string
}

const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function values(data: Extract<AgentEvent['data'], { type: 'usage' }>): Sample['values'] {
  const result: Sample['values'] = {}
  for (const field of tokenFields) {
    const value = finite(data[field])
    if (value !== undefined) result[field] = value
  }
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) result.totalTokens = result.inputTokens + result.outputTokens
  return result
}

function sessionModel(event: WeeklyUsageEvent): string | undefined {
  if (event.data.type !== 'session') return undefined
  const effective = event.data.capabilities?.effectiveSettings
  const fromEffective = effective && typeof effective === 'object' && !Array.isArray(effective) && typeof effective.model === 'string' ? effective.model : undefined
  return fromEffective ?? event.data.settings?.model
}

function addSample(into: Map<string, { row: WeeklyModelUsage; sessions: Set<string> }>, sample: Sample): void {
  if (!Object.keys(sample.values).length) return
  const key = JSON.stringify([sample.provider, sample.model])
  const entry = into.get(key) ?? {
    row: { provider: sample.provider, model: sample.model, conversations: 0, reports: 0, estimated: false },
    sessions: new Set<string>()
  }
  for (const field of tokenFields) if (sample.values[field] !== undefined) entry.row[field] = (entry.row[field] ?? 0) + sample.values[field]!
  entry.row.reports += 1
  entry.row.estimated ||= sample.source === 'estimate'
  entry.sessions.add(sample.sessionId)
  into.set(key, entry)
}

/**
 * Totals durable usage reports in a rolling seven-day window. Session-scoped reports are
 * cumulative counters, so only their measured deltas are added. Turn totals replace message
 * snapshots for the same turn. Missing pre-window counter baselines are excluded rather than
 * relabelling a whole conversation total as weekly usage.
 */
export function summarizeWeeklyModelUsage(conversations: WeeklyUsageConversation[], throughMs = Date.now()): WeeklyModelUsageReport {
  const sinceMs = throughMs - WEEKLY_USAGE_DAYS * DAY_MS
  const totals = new Map<string, { row: WeeklyModelUsage; sessions: Set<string> }>()
  let conversationsWithUsage = 0, countersWithoutBaseline = 0, nestedReportsExcluded = 0

  for (const conversation of conversations) {
    const events = [...conversation.events].sort((a, b) => a.sequence - b.sequence)
    let model: string | null = conversation.model ?? null
    let used = false
    const countersBeforeWindow = new Set<string>()
    const cumulative = new Map<string, { values: Sample['values']; at: number }>()
    const covered = new Map<string, Array<{ start: number; end: number }>>()
    const turns = new Map<string, Sample>()
    const messages = new Map<string, Map<string, Sample>>()
    const latest = new Map<string, Sample>()

    for (const event of events) {
      const at = Date.parse(event.timestamp)
      if (!Number.isFinite(at) || at > throughMs) continue
      const provider = event.provider ?? conversation.provider
      // Codex's total_token_usage belongs to the native thread, which survives transport
      // reconnects. Counting a reconnect as a fresh counter re-adds the lifetime total.
      const counterKey = provider === 'codex' && event.nativeSessionId ? `native:${event.nativeSessionId}` : `runtime:${event.runtimeId}`
      if (at < sinceMs) countersBeforeWindow.add(counterKey)
      const changedModel = sessionModel(event)
      if (changedModel) model = changedModel
      if (event.data.type !== 'usage') continue
      if (event.parentId) { nestedReportsExcluded += 1; continue }
      const sample: Sample = { sessionId: conversation.sessionId, provider, model, at, source: event.data.source, values: values(event.data), runtimeId: event.runtimeId, counterKey }
      if (!Object.keys(sample.values).length) continue
      if (event.data.scope === 'session') {
        // A runtime counter remains cumulative when the owner changes model. The measured delta
        // belongs to the model active on this report; keying the baseline by model would either
        // drop or double-count the first report after a switch.
        const previous = cumulative.get(counterKey)
        cumulative.set(counterKey, { values: sample.values, at })
        if (at < sinceMs) continue
        const runtimePredatesWindow = countersBeforeWindow.has(counterKey)
        const declaredStart = Date.parse(conversation.runtimeStarts?.[event.runtimeId] ?? '')
        const runtimeStart = Number.isFinite(declaredStart) ? declaredStart : undefined
        if (!previous && (conversation.truncated || runtimePredatesWindow || runtimeStart === undefined || runtimeStart < sinceMs)) { countersWithoutBaseline += 1; continue }
        const delta: Sample['values'] = {}
        for (const field of tokenFields) {
          const current = sample.values[field], before = previous?.values[field]
          if (current === undefined) continue
          if (before !== undefined) delta[field] = current >= before ? current - before : current
          else if (!runtimePredatesWindow) delta[field] = current
        }
        if (Object.keys(delta).length) {
          const start = previous?.at ?? runtimeStart ?? at
          const intervals = covered.get(counterKey) ?? []
          intervals.push({ start, end: at }); covered.set(counterKey, intervals)
          addSample(totals, { ...sample, values: delta }); used = true
        }
        continue
      }
      if (at < sinceMs) continue
      const turnKey = JSON.stringify([event.runtimeId, event.turnId ?? event.itemId ?? event.id, model])
      if (event.data.scope === 'turn') turns.set(turnKey, sample)
      else if (event.data.scope === 'message') {
        const bucket = messages.get(turnKey) ?? new Map<string, Sample>()
        bucket.set(event.itemId ?? event.id, sample); messages.set(turnKey, bucket)
      } else latest.set(JSON.stringify([event.runtimeId, event.itemId ?? event.id, model]), sample)
    }
    const isCovered = (sample: Sample): boolean => (covered.get(sample.counterKey) ?? []).some(interval => sample.at > interval.start && sample.at <= interval.end)
    for (const [key, samples] of messages) if (!turns.has(key)) for (const sample of samples.values()) {
      if (!isCovered(sample)) { addSample(totals, sample); used = true }
    }
    for (const sample of turns.values()) if (!isCovered(sample)) { addSample(totals, sample); used = true }
    for (const sample of latest.values()) if (!isCovered(sample)) { addSample(totals, sample); used = true }
    if (used) conversationsWithUsage += 1
  }

  const models = [...totals.values()].map(entry => ({ ...entry.row, conversations: entry.sessions.size }))
    .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? ''))
  const truncatedConversations = conversations.filter(entry => entry.truncated).length
  const notes = [
    ...(truncatedConversations ? ['Some durable journals were compacted before the seven-day boundary.'] : []),
    ...(countersWithoutBaseline ? ['Cumulative counters without a pre-window baseline were excluded.'] : []),
    ...(nestedReportsExcluded ? ['Nested usage without an exact model attribution was excluded.'] : [])
  ]
  return {
    since: new Date(sinceMs).toISOString(), through: new Date(throughMs).toISOString(), days: WEEKLY_USAGE_DAYS, models,
    coverage: {
      complete: notes.length === 0,
      notes,
      conversationsScanned: conversations.length,
      conversationsWithUsage,
      truncatedConversations,
      countersWithoutBaseline,
      nestedReportsExcluded
    }
  }
}
