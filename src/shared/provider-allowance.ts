import type { StructuredProvider } from './structured-agent'
import type { AccountLimitsReport, AccountLimitWindow } from './usage-accounting'

/* ------------------------------------------------------------------------- *
 * Provider allowance at a glance (sidebar, between the processes and "Needs
 * attention"): each recently used cloud provider's weekly and short-window
 * percentage with a tiny history line. Everything here reads the allowance the
 * providers already report into `usageLimits.latest` (structured-sessions.ts);
 * nothing asks a provider, nothing reads the journal.
 * ------------------------------------------------------------------------- */

export type AllowancePoint = [atMs: number, percent: number]
/** provider -> series key (`weekly` or `short`) -> samples, oldest first. */
export type AllowanceHistory = Partial<Record<StructuredProvider, Partial<Record<AllowanceSeries, AllowancePoint[]>>>>
export type AllowanceSeries = 'weekly' | 'short'

const DAY_MS = 86_400_000
/** A provider that reported nothing for this long is not one the owner is using lately. */
export const RECENT_PROVIDER_MS = 7 * DAY_MS
const HISTORY_MS = 7 * DAY_MS
const MAX_POINTS = 96
/** Samples closer than this collapse into the newest one unless the percentage moved. */
const SAMPLE_SPACING_MS = 15 * 60_000

const PROVIDERS: StructuredProvider[] = ['claude', 'codex', 'grok']
const NAMES: Partial<Record<StructuredProvider, string>> = { claude: 'Claude', codex: 'GPT', grok: 'Grok' }

/** The plan-level window of a kind: provider-wide (a model-scoped bucket is not the account's), highest use. */
export function headlineWindow(windows: readonly AccountLimitWindow[], kind: AllowanceSeries): AccountLimitWindow | undefined {
  return windows
    .filter(window => window.kind === kind && window.scope === 'provider')
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'current' ? -1 : 1) || b.usedPercent - a.usedPercent || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))[0]
}

function appendPoint(points: readonly AllowancePoint[] | undefined, at: number, percent: number): AllowancePoint[] | null {
  const list = [...(points ?? [])]
  const last = list[list.length - 1]
  if (last && last[0] > at) return null
  if (last && last[1] === percent) return null
  // At most one point per spacing: a rise soon after the previous point moves the newest one
  // forward instead of adding another. A drop (the window rolled over) always adds a point.
  const previous = list[list.length - 2]
  if (last && previous && at - previous[0] < SAMPLE_SPACING_MS && percent >= last[1]) list[list.length - 1] = [at, percent]
  else list.push([at, percent])
  const cutoff = at - HISTORY_MS
  return list.filter(([time]) => time >= cutoff).slice(-MAX_POINTS)
}

/** Folds one provider's current report into the history; null when nothing changed (no write). */
export function recordAllowanceHistory(history: AllowanceHistory, report: AccountLimitsReport, now = Date.now()): AllowanceHistory | null {
  let series = history[report.provider], changed = false
  for (const kind of ['weekly', 'short'] as const) {
    const window = headlineWindow(report.windows, kind)
    if (!window || window.state !== 'current') continue
    const at = Math.min(now, Date.parse(window.observedAt) || now)
    const next = appendPoint(series?.[kind], at, window.usedPercent)
    if (!next) continue
    series = { ...series, [kind]: next }
    changed = true
  }
  return changed ? { ...history, [report.provider]: series } : null
}

export interface AllowanceGauge {
  label: string
  /** Null when the window rolled over after it was last observed: its current use is unknown. */
  usedPercent: number | null
  resetsAt: string | null
  windowMinutes: number | null
  observedAt: string
  /** Samples inside the current window, oldest first: [elapsed share of the window 0-1, percent]. */
  points: Array<[number, number]>
  /** Elapsed share of the window now, where the line ends. */
  elapsed: number
}
export interface ProviderAllowanceRow {
  provider: StructuredProvider
  name: string
  weekly?: AllowanceGauge
  short?: AllowanceGauge
  observedAt: string
  planType?: string
}

function gauge(window: AccountLimitWindow | undefined, points: readonly AllowancePoint[] | undefined, now: number): AllowanceGauge | undefined {
  if (!window) return undefined
  const minutes = window.windowMinutes ?? null
  // Only the current window's samples: an earlier week's climb is not this week's.
  const span = minutes ? minutes * 60_000 : HISTORY_MS
  const since = window.resetsAt && minutes ? Date.parse(window.resetsAt) - span : now - span
  const share = (at: number): number => Math.min(1, Math.max(0, (at - since) / span))
  const current = window.state === 'current'
  const series: Array<[number, number]> = (points ?? []).filter(([at]) => at >= since).map(([at, percent]) => [share(at), percent])
  const observed = share(Date.parse(window.observedAt) || now)
  if (current && series[series.length - 1]?.[1] !== window.usedPercent) series.push([observed, window.usedPercent])
  return { label: window.label, usedPercent: current ? window.usedPercent : null, resetsAt: window.resetsAt, windowMinutes: minutes, observedAt: window.observedAt, points: series, elapsed: share(now) }
}

/** One row per cloud provider that reported an allowance within the last week, in a fixed order. */
export function summarizeProviderAllowance(reports: readonly AccountLimitsReport[], history: AllowanceHistory, now = Date.now()): ProviderAllowanceRow[] {
  const rows: ProviderAllowanceRow[] = []
  for (const provider of PROVIDERS) {
    const report = reports.find(entry => entry.provider === provider)
    if (!report?.windows.length) continue
    const weekly = headlineWindow(report.windows, 'weekly'), short = headlineWindow(report.windows, 'short')
    if (!weekly && !short) continue
    const observedAt = [weekly, short].flatMap(window => window ? [window.observedAt] : []).sort().at(-1)!
    if (now - Date.parse(observedAt) > RECENT_PROVIDER_MS) continue
    const planType = report.credits?.find(credit => credit.planType)?.planType
    rows.push({
      provider, name: NAMES[provider] ?? provider, observedAt,
      ...(weekly ? { weekly: gauge(weekly, history[provider]?.weekly, now) } : {}),
      ...(short ? { short: gauge(short, history[provider]?.short, now) } : {}),
      ...(planType ? { planType } : {})
    })
  }
  return rows
}

/** The earliest reset still ahead, so a view can re-read exactly when a percentage goes stale. */
export function nextAllowanceReset(rows: readonly ProviderAllowanceRow[], now = Date.now()): number | undefined {
  const times = rows.flatMap(row => [row.weekly, row.short]).flatMap(entry => entry?.resetsAt && entry.usedPercent !== null ? [Date.parse(entry.resetsAt)] : []).filter(time => time > now)
  return times.length ? Math.min(...times) : undefined
}

/** "5h", "7d", "30m": the window's length as the row labels it. */
export function windowShortLabel(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}
