import type { Json, StructuredProvider } from '../shared/structured-agent'
import { describeAccountLimits, recordAccountLimits, usageWindowAppliesToModel, type AccountLimitRecord, type UsageWindow } from '../shared/usage-accounting'
import { allowanceReadings, summarizeAllowanceWeeks, type AllowanceReading, type AllowanceWeek, type AllowanceWeekReport, type WeekModelTokens, type WeekTokens } from '../shared/usage-weeks'
import { summarizeWeeklyModelUsage, type WeeklyUsageConversation } from '../shared/weekly-model-usage'
import type { UsageWeeksStore } from './usage-weeks-store'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/** The journal is read back this far for allowance readings that predate the readings table. */
export const BACKFILL_DAYS = 26 * 7 + 14
/** A cumulative counter's baseline: one window of lookback before a window opens. */
const BASELINE_MS = WEEK_MS
const MAX_WEEKS = 52
const BACKFILL_KEY = 'backfilled'

export interface UsageWeeksJournal {
  usageSessionProviders(): Array<{ id: string; provider: StructuredProvider }>
  usageConversation(sessionId: string, from: string, since: string): WeeklyUsageConversation | null
  allowanceObservations(sessionId: string, from: string): Array<{ at: string; limits: string }>
}

const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Weekly allowance report for desktop, phone and `usage.weekly`. Readings come from the small
 * `allowance_readings` table; tokens per window from the journal's accounting index, one
 * conversation per macrotask, measured once per closed window and kept in `usage_weeks`. The
 * first report after an upgrade backfills readings from the journal's own usage events.
 */
export class UsageWeeksService {
  private backfill?: Promise<void>
  private inflight = new Map<string, Promise<AllowanceWeekReport>>()
  private current = new Map<string, { at: number; tokens: WeekTokens }>()
  constructor(private readonly store: UsageWeeksStore, private readonly journal: UsageWeeksJournal, private readonly now: () => number = Date.now, private readonly currentCacheMs = 5 * 60_000) {}

  /** Replays allowance payloads the journal holds into readings, once per database. */
  ensureBackfill(): Promise<void> {
    if (this.store.meta(BACKFILL_KEY)) return Promise.resolve()
    this.backfill ??= this.runBackfill().catch(() => { this.backfill = undefined })
    return this.backfill
  }
  private async runBackfill(): Promise<void> {
    const from = new Date(this.now() - BACKFILL_DAYS * DAY_MS).toISOString()
    const observations: Array<{ provider: StructuredProvider; at: string; limits: string }> = []
    for (const session of this.journal.usageSessionProviders()) {
      if (session.provider !== 'claude' && session.provider !== 'codex') continue
      for (const row of this.journal.allowanceObservations(session.id, from)) if (row.at && row.limits) observations.push({ provider: session.provider, ...row })
      await yieldLoop()
    }
    observations.sort((a, b) => a.at.localeCompare(b.at))
    // Replayed in time order through the same record the live path keeps, so Codex's sparse
    // updates merge exactly as they did when they arrived.
    let record: AccountLimitRecord = {}
    const previous = new Map<string, AllowanceReading>()
    for (const [index, observation] of observations.entries()) {
      let limits: Json
      try { limits = JSON.parse(observation.limits) as Json } catch { continue }
      const next = recordAccountLimits(record, observation.provider, limits, { observedAt: observation.at, agentSessionId: '', projectId: '' })
      if (!next) continue
      record = next
      const at = Date.parse(observation.at)
      for (const reading of allowanceReadings(describeAccountLimits(record, observation.provider, at))) {
        if (reading.at !== at) continue
        const key = reading.provider + '\0' + reading.bucket
        if (this.store.add(reading, previous.get(key))) previous.set(key, reading)
      }
      if (index % 500 === 499) await yieldLoop()
    }
    this.store.setMeta(BACKFILL_KEY, JSON.stringify({ at: new Date(this.now()).toISOString(), observations: observations.length, from }))
  }

  /** One row per provider window, newest first, with tokens Conductor recorded in it. */
  report(options: { provider?: StructuredProvider; weeks?: number } = {}): Promise<AllowanceWeekReport> {
    const key = `${options.provider ?? ''}:${options.weeks ?? ''}`
    let pending = this.inflight.get(key)
    if (!pending) {
      pending = this.build(options).finally(() => this.inflight.delete(key))
      this.inflight.set(key, pending)
    }
    return pending
  }

  private async build({ provider, weeks: requested }: { provider?: StructuredProvider; weeks?: number }): Promise<AllowanceWeekReport> {
    await this.ensureBackfill()
    const now = this.now()
    const weeks = Math.max(1, Math.min(MAX_WEEKS, Math.floor(requested ?? 8)))
    const since = now - (weeks + 2) * 8 * DAY_MS
    const computed = summarizeAllowanceWeeks(this.store.readings(provider, since), now, weeks)
    // Closed weeks whose readings were pruned still have their stored summary.
    const seen = new Set(computed.map(week => `${week.provider}\0${week.bucket}\0${week.endsAt}`))
    const stored = this.store.closedWeeks(provider).filter(week => !seen.has(`${week.provider}\0${week.bucket}\0${week.endsAt}`) && week.endsAt && Date.parse(week.endsAt) >= since)
    const all = [...computed, ...stored]
    const result: AllowanceWeek[] = []
    for (const week of all) {
      if (week.status === 'no-data') { result.push(week); continue }
      if (week.status === 'closed') {
        const kept = week.endsAt ? this.store.closedWeek(week.provider, week.bucket, week.endsAt) : null
        result.push({ ...week, tokens: kept?.tokens ?? week.tokens ?? null })
      } else result.push({ ...week, tokens: this.current.get(currentKey(week))?.tokens ?? null })
    }
    await this.measure(result.filter(week => week.status === 'closed' ? !week.tokens : week.status === 'current' && !this.freshCurrent(week, now)), now)
    for (const week of result) {
      if (week.status === 'closed') {
        // A window measured above was written with its tokens; one that could not be measured
        // (no reported length or start) is still kept, once, so it outlives its readings.
        if (week.endsAt && !this.store.closedWeek(week.provider, week.bucket, week.endsAt)) this.store.writeClosedWeek(week, week.tokens ?? null, now)
      } else if (week.status === 'current') week.tokens = this.current.get(currentKey(week))?.tokens ?? null
    }
    const order = (value: StructuredProvider): number => ['claude', 'codex', 'grok'].indexOf(value)
    result.sort((a, b) => order(a.provider) - order(b.provider) || a.bucket.localeCompare(b.bucket) || weekTime(b) - weekTime(a))
    const providers = provider ? [provider] : (['claude', 'codex', 'grok'] as const)
    const unknown = providers.filter(id => !result.some(week => week.provider === id)).map(id => id === 'grok'
      ? 'Grok does not report an account allowance through its runtime, so its weekly use is unknown here; the Grok dashboard shows it.'
      : `${id === 'claude' ? 'Claude' : 'Codex'} has not reported a weekly allowance since Conductor began recording it.`)
    const earliest = this.store.earliestReading()
    return { generatedAt: new Date(now).toISOString(), recordedSince: earliest === null ? null : new Date(earliest).toISOString(), weeks: result, unknown }
  }

  private freshCurrent(week: AllowanceWeek, now: number): boolean {
    const cached = this.current.get(currentKey(week))
    return Boolean(cached && now - cached.at < this.currentCacheMs)
  }

  /** Measures tokens for each listed window: one journal pass per provider, every window from it. */
  private async measure(weeks: AllowanceWeek[], now: number): Promise<void> {
    const byProvider = new Map<StructuredProvider, AllowanceWeek[]>()
    for (const week of weeks) {
      const bounds = windowBounds(week, now)
      if (!bounds) continue
      byProvider.set(week.provider, [...(byProvider.get(week.provider) ?? []), week])
    }
    for (const [provider, list] of byProvider) {
      const spans = list.map(week => ({ week, ...windowBounds(week, now)!, selector: week.scope === 'model' ? modelSelector(week) : null }))
      const since = Math.min(...spans.map(span => span.start))
      const from = new Date(since - BASELINE_MS).toISOString(), sinceIso = new Date(since).toISOString()
      const totals = spans.map(() => ({ models: new Map<string, WeekModelTokens>(), notes: new Set<string>(), complete: true }))
      for (const session of this.journal.usageSessionProviders()) {
        if (session.provider !== provider) continue
        const conversation = this.journal.usageConversation(session.id, from, sinceIso)
        if (conversation) spans.forEach((span, index) => {
          const report = summarizeWeeklyModelUsage([conversation], span.end, span.end - span.start)
          const total = totals[index]!
          // Only what this window lost counts against it: a counter whose baseline is missing
          // (which is also all a compacted journal can cost). Nested reports are named, not counted.
          if (report.coverage.countersWithoutBaseline) { total.complete = false; total.notes.add('Cumulative counters without a baseline before this window were excluded.') }
          if (report.coverage.nestedReportsExcluded && report.models.length) total.notes.add('Nested (subagent) usage without an exact model attribution is not included.')
          for (const model of report.models) {
            if (span.selector && !usageWindowAppliesToModel(span.selector, model.model ?? undefined)) continue
            const key = model.model ?? ''
            const row = total.models.get(key) ?? { model: model.model, conversations: 0, estimated: false }
            for (const field of ['processedTokens', 'totalTokens', 'outputTokens', 'cachedTokens', 'costUsd'] as const) if (model[field] !== undefined) row[field] = (row[field] ?? 0) + model[field]!
            row.conversations += model.conversations
            row.estimated ||= model.estimated || Boolean(model.costEstimated)
            total.models.set(key, row)
          }
        })
        await yieldLoop()
      }
      spans.forEach((span, index) => {
        const total = totals[index]!
        const models = [...total.models.values()].sort((a, b) => (b.processedTokens ?? 0) - (a.processedTokens ?? 0))
        const costs = models.filter(model => model.costUsd !== undefined)
        const tokens: WeekTokens = {
          models,
          processedTokens: models.reduce((sum, model) => sum + (model.processedTokens ?? 0), 0),
          totalTokens: models.reduce((sum, model) => sum + (model.totalTokens ?? 0), 0),
          costUsd: costs.length ? costs.reduce((sum, model) => sum + model.costUsd!, 0) : null,
          costEstimated: costs.some(model => model.estimated),
          complete: total.complete && !span.clipped,
          notes: [...total.notes, ...(span.clipped ? ['The provider did not report this window’s length; tokens are counted from its first reading.'] : [])]
        }
        if (span.week.status === 'closed') { span.week.tokens = tokens; this.store.writeClosedWeek(span.week, tokens, now) }
        else this.current.set(currentKey(span.week), { at: now, tokens })
      })
    }
  }
}

const currentKey = (week: AllowanceWeek): string => `${week.provider}\0${week.bucket}`
const weekTime = (week: AllowanceWeek): number => Date.parse(week.endsAt ?? '') || Date.parse(week.startsAt ?? '') || Number.MAX_SAFE_INTEGER

function windowBounds(week: AllowanceWeek, now: number): { start: number; end: number; clipped: boolean } | null {
  const start = Date.parse(week.startsAt ?? '') || Date.parse(week.firstReadingAt ?? '')
  const end = week.status === 'current' ? now : Date.parse(week.endsAt ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end: Math.min(end, now), clipped: !week.startsAt }
}

/** A model-scoped bucket's selectors as the window shape the shared matcher reads. */
function modelSelector(week: AllowanceWeek): UsageWindow {
  return { key: week.bucket, kind: 'weekly', label: week.label, usedPercent: 0, overage: false, scope: 'model', modelSelectors: week.models ?? [] }
}
