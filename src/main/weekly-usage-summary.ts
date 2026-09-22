import { summarizeWeeklyModelUsage, WEEKLY_USAGE_DAYS, type WeeklyModelUsageReport, type WeeklyUsageConversation } from '../shared/weekly-model-usage'

const DAY_MS = 24 * 60 * 60 * 1000
/** A cumulative counter's baseline is the last report before the window opened. One extra window
 *  of lookback keeps a runtime that straddles the boundary attributable without reading history. */
export const WEEKLY_USAGE_BASELINE_DAYS = WEEKLY_USAGE_DAYS

export interface WeeklyUsageSource {
  structured: {
    /** Usage and model-setting events from `from` onwards, with no history-list cap. */
    usageJournal(from: string, since: string): WeeklyUsageConversation[]
    /** Conversation ids, so the same window can be read one conversation at a time. */
    usageSessions?(): string[]
    usageConversation?(sessionId: string, from: string, since: string): WeeklyUsageConversation | null
  }
}

const bounds = (throughMs: number): { from: string; since: string } => {
  const sinceMs = throughMs - WEEKLY_USAGE_DAYS * DAY_MS
  return { from: new Date(sinceMs - WEEKLY_USAGE_BASELINE_DAYS * DAY_MS).toISOString(), since: new Date(sinceMs).toISOString() }
}

export function readWeeklyModelUsage(source: WeeklyUsageSource, throughMs = Date.now()): WeeklyModelUsageReport {
  const { from, since } = bounds(throughMs)
  return summarizeWeeklyModelUsage(source.structured.usageJournal(from, since), throughMs)
}

/**
 * One reusable main-process reader for phone, desktop and schedules surfaces.
 *
 * Reading the journal is synchronous SQLite work on the process that also serves every window's
 * IPC, so two things keep it off the owner's keystrokes: the shared report is memoized well past
 * any surface's refresh interval, and {@link readAsync} reads one conversation per macrotask so
 * the scan never holds the loop for more than a conversation's worth of rows.
 */
export class WeeklyUsageSummaryService {
  private cached: { at: number; report: WeeklyModelUsageReport } | null = null
  private inflight: Promise<WeeklyModelUsageReport> | null = null
  constructor(private readonly source: WeeklyUsageSource, private readonly now: () => number = Date.now, private readonly cacheMs = 5 * 60_000) {}
  private fresh(at: number): WeeklyModelUsageReport | null {
    return this.cached && at - this.cached.at < this.cacheMs ? this.cached.report : null
  }
  read(): WeeklyModelUsageReport {
    const at = this.now()
    const cached = this.fresh(at)
    if (cached) return cached
    const report = readWeeklyModelUsage(this.source, at)
    this.cached = { at, report }
    return report
  }
  /** The desktop path. Yields between conversations, and collapses concurrent callers onto one scan. */
  async readAsync(): Promise<WeeklyModelUsageReport> {
    const cached = this.fresh(this.now())
    if (cached) return cached
    this.inflight ??= this.scan().finally(() => { this.inflight = null })
    return this.inflight
  }
  private async scan(): Promise<WeeklyModelUsageReport> {
    const { structured } = this.source
    const at = this.now()
    const { from, since } = bounds(at)
    if (!structured.usageSessions || !structured.usageConversation) return this.read()
    const conversations: WeeklyUsageConversation[] = []
    for (const sessionId of structured.usageSessions()) {
      const conversation = structured.usageConversation(sessionId, from, since)
      if (conversation) conversations.push(conversation)
      await new Promise(resolve => setImmediate(resolve))
    }
    const report = summarizeWeeklyModelUsage(conversations, at)
    this.cached = { at, report }
    return report
  }
  invalidate(): void { this.cached = null }
}
