import { summarizeWeeklyModelUsage, type WeeklyModelUsageReport, type WeeklyUsageConversation } from '../shared/weekly-model-usage'

export interface WeeklyUsageSource {
  structured: {
    /** Usage and model-setting events for every durable conversation, with no history-list cap. */
    usageJournal(): WeeklyUsageConversation[]
  }
}

export function readWeeklyModelUsage(source: WeeklyUsageSource, throughMs = Date.now()): WeeklyModelUsageReport {
  return summarizeWeeklyModelUsage(source.structured.usageJournal(), throughMs)
}

/** One reusable main-process reader for phone, desktop and schedules surfaces. */
export class WeeklyUsageSummaryService {
  private cached: { at: number; report: WeeklyModelUsageReport } | null = null
  constructor(private readonly source: WeeklyUsageSource, private readonly now: () => number = Date.now, private readonly cacheMs = 30_000) {}
  read(): WeeklyModelUsageReport {
    const at = this.now()
    if (this.cached && at - this.cached.at < this.cacheMs) return this.cached.report
    const report = readWeeklyModelUsage(this.source, at)
    this.cached = { at, report }
    return report
  }
  invalidate(): void { this.cached = null }
}
