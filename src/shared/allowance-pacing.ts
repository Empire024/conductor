/* ------------------------------------------------------------------------- *
 * Weekly allowance pacing (sidebar usage strip, ProviderAllowance.tsx): how
 * much of a provider's weekly allowance is still unused against how little
 * time is left before it resets. The owner's aim is to USE the allowance, so
 * the strip turns orange and then red when a large share would be lost at the
 * reset. This is the opposite of the near-limit warning (allowanceLevel), which
 * stays a separate signal.
 * ------------------------------------------------------------------------- */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const WEEK_MINUTES = 7 * 24 * 60

export type PacingState = 'unknown' | 'ok' | 'behind' | 'waste-warn' | 'waste-high'

/** Unused share (percent of the whole allowance) and time left that make a row orange or red.
 *  The first rule whose time and unused share both hold wins; red rules are checked first. */
export const PACING_RULES: ReadonlyArray<{ state: 'waste-high' | 'waste-warn'; maxLeftMs: number; minUnused: number }> = [
  { state: 'waste-high', maxLeftMs: 1 * DAY_MS, minUnused: 40 },
  { state: 'waste-high', maxLeftMs: 2 * DAY_MS, minUnused: 60 },
  { state: 'waste-warn', maxLeftMs: 2 * DAY_MS, minUnused: 25 },
  { state: 'waste-warn', maxLeftMs: 3 * DAY_MS, minUnused: 50 }
]
/** Use this many points under the straight-line pace counts as behind (informational, no colour). */
export const BEHIND_PACE_MARGIN = 10

export interface AllowancePacing {
  state: PacingState
  /** Milliseconds until the reset; null when unknown or already past. */
  leftMs: number | null
  /** Unused percent of the allowance; null when current use is unknown. */
  unusedPercent: number | null
  /** Straight-line pace: the share of the window already elapsed, in percent. */
  expectedPercent: number | null
}

export interface PacingInput {
  usedPercent: number | null
  resetsAt: string | null
  windowMinutes: number | null
}

/** Pure: pacing of a weekly window at `now`. Missing reset, unknown use or a window that has
 *  already reset are 'unknown' (no colour), never a guess. */
export function allowancePacing(gauge: PacingInput, now = Date.now()): AllowancePacing {
  const resetAt = gauge.resetsAt ? Date.parse(gauge.resetsAt) : NaN
  const leftMs = Number.isFinite(resetAt) && resetAt > now ? resetAt - now : null
  const unusedPercent = gauge.usedPercent === null ? null : Math.max(0, 100 - gauge.usedPercent)
  if (leftMs === null || unusedPercent === null || gauge.usedPercent === null) return { state: 'unknown', leftMs, unusedPercent, expectedPercent: null }
  const spanMs = (gauge.windowMinutes || WEEK_MINUTES) * 60_000
  const expectedPercent = Math.min(100, Math.max(0, (1 - leftMs / spanMs) * 100))
  // On or above the straight-line pace is fine however close the reset is.
  if (gauge.usedPercent >= expectedPercent) return { state: 'ok', leftMs, unusedPercent, expectedPercent }
  const rule = PACING_RULES.find(entry => leftMs <= entry.maxLeftMs && unusedPercent >= entry.minUnused)
  const state: PacingState = rule ? rule.state : expectedPercent - gauge.usedPercent >= BEHIND_PACE_MARGIN ? 'behind' : 'ok'
  return { state, leftMs, unusedPercent, expectedPercent }
}

/** "2.3d", "14h", "40m": time left, compact enough for the 16px row. */
export function formatTimeLeft(ms: number): string {
  if (ms >= DAY_MS) {
    const days = ms / DAY_MS
    return days >= 10 ? `${Math.round(days)}d` : `${(Math.floor(days * 10) / 10).toFixed(1)}d`
  }
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h`
  return `${Math.max(1, Math.floor(ms / 60_000))}m`
}

/** "62% unused, resets in 1.4 days — use it", or null when there is nothing to say. */
export function pacingHint(pacing: AllowancePacing): string | null {
  if (pacing.leftMs === null || pacing.unusedPercent === null) return null
  const days = pacing.leftMs / DAY_MS
  const left = days >= 1 ? `${(Math.floor(days * 10) / 10).toFixed(1)} days` : pacing.leftMs >= HOUR_MS ? `${Math.floor(pacing.leftMs / HOUR_MS)} h` : `${Math.max(1, Math.floor(pacing.leftMs / 60_000))} min`
  const base = `${Math.round(pacing.unusedPercent)}% unused, resets in ${left}`
  if (pacing.state === 'waste-high' || pacing.state === 'waste-warn') return `${base} — use it`
  if (pacing.state === 'behind') return `${base} — behind pace (${Math.round(pacing.expectedPercent ?? 0)}% of the week gone)`
  return base
}
