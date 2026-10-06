import type { StructuredProvider } from './structured-agent'
import type { AccountLimitsReport, AccountLimitWindow } from './usage-accounting'

/* ------------------------------------------------------------------------- *
 * Weekly allowance report: did a week's allowance get used up, or was some of
 * it left on the table? Every figure comes from the allowance readings the
 * providers reported to Conductor (usageLimits, structured-sessions.ts), split
 * into each provider's own windows by the reset time it reported - never by
 * calendar week. Nothing is interpolated: a stretch without readings is said
 * to have none, and a final figure is the last reading before the reset.
 * ------------------------------------------------------------------------- */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Two reported reset times this close name the same reset (providers round and jitter them). */
const SAME_RESET_MS = HOUR_MS
/** A last reading this far before the reset may miss use after it: the final figure is partial. */
export const FINAL_READING_TOLERANCE_MS = 12 * HOUR_MS
/** A stretch inside a window this long without readings is named in the week's notes. */
const READING_GAP_MS = 2 * DAY_MS
/** Too little of a window has passed for its pace to say anything about the end. */
const MIN_PROJECTION_MS = 6 * HOUR_MS
/** A falling reading is a reset only when it falls by more than rounding. */
const DROP_PERCENT = 0.5
/** A fall this large is a reset even when the provider kept the same reset time. */
const RESET_DROP_PERCENT = 10
/** A model-scoped bucket with no reading for this long is one the owner stopped using. */
const STALE_MODEL_BUCKET_MS = 14 * DAY_MS

/** One provider-reported reading of one weekly window. */
export interface AllowanceReading {
  provider: StructuredProvider
  /** The provider's window key: Claude `seven_day`, `seven_day_overage_included`; Codex `codex:primary`. */
  bucket: string
  label: string
  scope: 'provider' | 'model'
  models?: string[]
  at: number
  usedPercent: number
  resetsAt: number | null
  windowMinutes: number | null
}

export interface WeekModelTokens {
  model: string | null
  processedTokens?: number
  totalTokens?: number
  outputTokens?: number
  cachedTokens?: number
  costUsd?: number
  conversations: number
  estimated: boolean
}
/** Tokens and cost Conductor recorded for a window's provider (or the bucket's models). */
export interface WeekTokens {
  models: WeekModelTokens[]
  processedTokens: number
  totalTokens: number
  /** Sum of the cost reports the provider made (Claude's CLI estimates one); null when none did. */
  costUsd: number | null
  costEstimated: boolean
  complete: boolean
  notes: string[]
}

export interface AllowanceWeek {
  provider: StructuredProvider
  bucket: string
  label: string
  scope: 'provider' | 'model'
  models?: string[]
  /** `closed`: the reset passed. `current`: in progress. `no-data`: a stretch with no readings at all. */
  status: 'closed' | 'current' | 'no-data'
  /** The provider's window start (reset minus window length); null when the length was not reported. */
  startsAt: string | null
  /** The reset time the provider last reported for this window. */
  endsAt: string | null
  windowMinutes: number | null
  readings: number
  firstReadingAt: string | null
  lastReadingAt: string | null
  peakPercent: number | null
  /** The last reading in the window: the best estimate of its final figure. */
  finalPercent: number | null
  usedUp: boolean
  /** The first reading at 100%. */
  usedUpAt: string | null
  /** Closed windows only: 100 minus the last reading. With partial coverage the true figure may be lower. */
  unusedPercent: number | null
  coverage: 'complete' | 'partial' | 'none'
  notes: string[]
  /** Current window only: where this window's average pace so far would end it. */
  projection?: { percentAtReset: number; usedUpAt: string | null; basis: string } | null
  tokens?: WeekTokens | null
}

export interface AllowanceWeekReport {
  generatedAt: string
  /** Earliest reading Conductor holds; nothing before it is known. */
  recordedSince: string | null
  weeks: AllowanceWeek[]
  /** Providers with no weekly reading at all, and why (Grok reports none). */
  unknown: string[]
}

const iso = (ms: number | null | undefined): string | null => ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString()
export const round1 = (value: number): number => Math.round(value * 10) / 10

/** The readings a report carries: each weekly window (provider-wide and model-scoped) still current. */
export function allowanceReadings(report: AccountLimitsReport): AllowanceReading[] {
  return report.windows.filter(window => window.kind === 'weekly' && window.state === 'current').map(window => readingOf(report.provider, window))
}
function readingOf(provider: StructuredProvider, window: AccountLimitWindow): AllowanceReading {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  return {
    provider, bucket: window.key, label: window.label, scope: window.scope,
    ...(window.models?.length ? { models: window.models } : {}),
    at: Date.parse(window.observedAt), usedPercent: window.usedPercent,
    resetsAt: Number.isFinite(reset) ? reset : null, windowMinutes: window.windowMinutes
  }
}

/** `plannedEnd`: the reset the provider had announced for a window it then reset early at `end`. */
interface Group { readings: AllowanceReading[]; end: number | null; minutes: number | null; resetMoved: boolean; earlyReset?: boolean; plannedEnd?: number | null }

/**
 * Splits one bucket's readings into the provider's windows. A new window begins when a reading
 * arrives after the previous reset, or when the use falls (an early or moved reset). A reset time
 * that moves while the use keeps climbing is the same window with a moved end.
 */
export function splitWindows(readings: readonly AllowanceReading[]): Group[] {
  const sorted = [...readings].filter(reading => Number.isFinite(reading.at) && Number.isFinite(reading.usedPercent)).sort((a, b) => a.at - b.at)
  const groups: Group[] = []
  let current: Group | undefined
  for (const reading of sorted) {
    const last = current?.readings.at(-1)
    const passedReset = current?.end !== null && current?.end !== undefined && reading.at >= current.end
    // A small dip under the same reset time is two tabs' readings arriving out of step, not a reset.
    const movedReset = reading.resetsAt !== null && current?.end !== null && current?.end !== undefined && Math.abs(reading.resetsAt - current.end) > SAME_RESET_MS
    const dropped = last !== undefined && reading.usedPercent < last.usedPercent - DROP_PERCENT && (movedReset || reading.usedPercent <= last.usedPercent - RESET_DROP_PERCENT)
    if (!current || passedReset || dropped) {
      if (current && dropped && !passedReset) {
        // The early reset happened where the provider says the next window began (its reset minus
        // its length), never before the last reading of this one.
        const nextStart = reading.resetsAt !== null && reading.windowMinutes ? reading.resetsAt - reading.windowMinutes * 60_000 : reading.at
        current.earlyReset = true
        current.plannedEnd = current.end
        current.end = Math.max(last!.at, Math.min(current.end ?? nextStart, nextStart, reading.at))
      }
      current = { readings: [reading], end: reading.resetsAt, minutes: reading.windowMinutes, resetMoved: false }
      groups.push(current)
      continue
    }
    current.readings.push(reading)
    if (reading.resetsAt !== null) {
      if (current.end !== null && Math.abs(reading.resetsAt - current.end) > SAME_RESET_MS) current.resetMoved = true
      current.end = reading.resetsAt
    }
    if (reading.windowMinutes !== null) current.minutes = reading.windowMinutes
  }
  return groups
}

function weekOf(group: Group, now: number): AllowanceWeek {
  const { readings } = group
  const first = readings[0]!, last = readings.at(-1)!
  const peak = Math.max(...readings.map(reading => reading.usedPercent))
  const full = readings.find(reading => reading.usedPercent >= 100)
  const announced = group.earlyReset ? group.plannedEnd ?? null : group.end
  const start = announced !== null && group.minutes ? announced - group.minutes * 60_000 : null
  const closed = group.earlyReset || (group.end !== null && group.end <= now)
  const notes: string[] = []
  let coverage: AllowanceWeek['coverage'] = 'complete'
  if (group.end === null) { coverage = 'partial'; notes.push('The provider did not report when this window resets.') }
  // A week already used up cannot rise further, so a quiet stretch after 100% loses nothing.
  if (closed && !full && group.end !== null && group.end - last.at > FINAL_READING_TOLERANCE_MS) {
    coverage = 'partial'
    notes.push(`Last reading ${formatGap(group.end - last.at)} before the reset; use after it is not known.`)
  }
  if (group.earlyReset) notes.push(`The provider reset this window early${group.plannedEnd ? ` (it had announced ${iso(group.plannedEnd)})` : ''}: its use fell and a new window began.`)
  if (group.resetMoved) notes.push('The provider moved this window’s reset time while it ran.')
  if (start !== null && first.at - start > READING_GAP_MS) notes.push(`No readings for the first ${formatGap(first.at - start)} of this window.`)
  for (let index = 1; index < readings.length; index++) {
    const gap = readings[index]!.at - readings[index - 1]!.at
    if (gap > READING_GAP_MS) notes.push(`No readings from ${iso(readings[index - 1]!.at)} to ${iso(readings[index]!.at)}.`)
  }
  const week: AllowanceWeek = {
    provider: first.provider, bucket: first.bucket, label: last.label, scope: last.scope, ...(last.models?.length ? { models: last.models } : {}),
    status: closed ? 'closed' : 'current', startsAt: iso(start), endsAt: iso(group.end), windowMinutes: group.minutes,
    readings: readings.length, firstReadingAt: iso(first.at), lastReadingAt: iso(last.at),
    peakPercent: round1(peak), finalPercent: round1(last.usedPercent), usedUp: Boolean(full), usedUpAt: iso(full?.at),
    unusedPercent: closed ? round1(Math.max(0, 100 - last.usedPercent)) : null, coverage, notes
  }
  if (!closed) {
    week.projection = projectWindow(start, group.end, last)
    if (now - last.at > FINAL_READING_TOLERANCE_MS) notes.push(`No reading for ${formatGap(now - last.at)}; use since then is not known.`)
  }
  return week
}

/** Where the window ends at its average pace so far; null when it is too early to say. */
export function projectWindow(start: number | null, end: number | null, last: Pick<AllowanceReading, 'at' | 'usedPercent'>): AllowanceWeek['projection'] {
  if (start === null || end === null) return null
  const elapsed = last.at - start, span = end - start
  if (elapsed < MIN_PROJECTION_MS || span <= 0) return null
  if (last.usedPercent >= 100) return { percentAtReset: 100, usedUpAt: null, basis: 'Already used up.' }
  const percentAtReset = last.usedPercent * span / elapsed
  const usedUpAt = last.usedPercent > 0 && percentAtReset >= 100 ? start + elapsed * 100 / last.usedPercent : null
  return { percentAtReset: round1(percentAtReset), usedUpAt: iso(usedUpAt), basis: `${round1(last.usedPercent)}% in ${formatGap(elapsed)}, the window's average pace so far` }
}

/** "3 d 4 h", "11 h", "40 min". */
export function formatGap(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/**
 * Every bucket's windows, newest first per bucket, with a `no-data` row for each stretch between
 * windows (and after the last reset) that no reading covers. `weeks` bounds how many closed or
 * current windows each bucket returns.
 */
export function summarizeAllowanceWeeks(readings: readonly AllowanceReading[], now = Date.now(), weeks = 8): AllowanceWeek[] {
  const buckets = new Map<string, AllowanceReading[]>()
  for (const reading of readings) {
    const key = reading.provider + '\0' + reading.bucket
    buckets.set(key, [...(buckets.get(key) ?? []), reading])
  }
  const result: AllowanceWeek[] = []
  const order = (key: string): number => ['claude', 'codex', 'grok'].indexOf(key.split('\0')[0]!)
  for (const key of [...buckets.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const windows = splitWindows(buckets.get(key)!).map(group => weekOf(group, now))
    const rows: AllowanceWeek[] = []
    for (let index = 0; index < windows.length; index++) {
      const week = windows[index]!
      rows.push(week)
      const next = windows[index + 1]
      const end = week.endsAt ? Date.parse(week.endsAt) : null
      const nextStart = next ? next.startsAt ? Date.parse(next.startsAt) : Date.parse(next.firstReadingAt!) : week.status === 'closed' ? now : null
      const stale = !next && week.scope === 'model' && end !== null && now - end > STALE_MODEL_BUCKET_MS
      if (week.status === 'closed' && end !== null && nextStart !== null && nextStart - end >= DAY_MS && !stale) rows.push(noData(week, end, nextStart, !next))
    }
    // Newest first, bounded to the requested number of real windows (gap rows ride along).
    rows.reverse()
    let kept = 0
    for (const row of rows) {
      if (row.status !== 'no-data') kept++
      if (kept > weeks) break
      result.push(row)
    }
  }
  return result
}

function noData(after: AllowanceWeek, from: number, until: number, open: boolean): AllowanceWeek {
  return {
    provider: after.provider, bucket: after.bucket, label: after.label, scope: after.scope, ...(after.models ? { models: after.models } : {}),
    status: 'no-data', startsAt: iso(from), endsAt: open ? null : iso(until), windowMinutes: after.windowMinutes, readings: 0,
    firstReadingAt: null, lastReadingAt: null, peakPercent: null, finalPercent: null, usedUp: false, usedUpAt: null, unusedPercent: null,
    coverage: 'none',
    notes: [open ? `No readings since the reset at ${iso(from)}; this window's use is unknown until the provider reports again.` : `No readings from ${iso(from)} to ${iso(until)}; use in this stretch is unknown.`]
  }
}

/** The one-line verdict every surface shows for a week. */
export function weekVerdict(week: AllowanceWeek, now = Date.now()): string {
  if (week.status === 'no-data') return 'No readings'
  if (week.usedUp) return `Used up ${week.usedUpAt ? 'on ' + new Date(week.usedUpAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}`.trim()
  if (week.status === 'current') {
    const projection = week.projection
    if (!projection) return `${week.finalPercent}% used so far`
    if (projection.usedUpAt && Date.parse(projection.usedUpAt) > now) return `${week.finalPercent}% so far · on pace to run out ${new Date(projection.usedUpAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    return `${week.finalPercent}% so far · on pace for ${Math.round(projection.percentAtReset)}% at reset`
  }
  return `${Math.round(week.unusedPercent ?? 0)}% left unused${week.coverage === 'partial' ? ' (at last reading)' : ''}`
}
