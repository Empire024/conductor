import { isUsageCap, parseUsageCapSetting, type UsageCapScope, type UsageCapSetting } from '../shared/usage-accounting'

export type { UsageCapScope } from '../shared/usage-accounting'

const LIMIT_LANGUAGE = /\b(?:(?:usage|rate)[\s-]*)?limit\b|\bquota\b/i
const RESET_LANGUAGE = /\b(?:reset(?:s|ting)?|try again|retry|available(?: again)?|continue)\b/i
const AVAILABLE_RESET_CREDITS = /\b(?:you\s+have\s+)?\d+\s+(?:usage[\s-]+)?limit\s+resets?\s+available\b/i
const BLOCKED_LIMIT_LANGUAGE = /\b(?:hit|reached|exceeded|exhausted|blocked)\b|\btoo many requests\b/i
const PUNCTUATED_LIMIT_RESET = /(?:\b(?:(?:usage|rate)[\s-]*)?limit\b|\bquota\b)\s*[,;:.\u2013\u2014-]\s*(?:reset|try again|retry|available again|continue)/i
const DURATION_PART = String.raw`\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`

const parseDuration = (value: string): number => {
  let milliseconds = 0
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    const amount = Number(match[1])
    const unit = match[2]!.toLowerCase()[0]
    milliseconds += amount * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000)
  }
  return milliseconds
}

/**
 * Extract the next usable time from the short limit messages emitted by coding
 * agent CLIs. Clock-only values intentionally use the machine's local timezone,
 * matching the timezone in which the desktop UI and provider process run.
 */
export const parseUsageLimitReset = (text: string, from = new Date()): Date | null => {
  // Codex offers a limited number of manual usage-window reset credits. That
  // notice contains all of the generic words below (usage, limit, reset and a
  // number), but it means the user can continue now -- not that they are
  // blocked until a future time.
  if (AVAILABLE_RESET_CREDITS.test(text)) return null
  if (
    !LIMIT_LANGUAGE.test(text) ||
    !RESET_LANGUAGE.test(text) ||
    (!BLOCKED_LIMIT_LANGUAGE.test(text) && !PUNCTUATED_LIMIT_RESET.test(text))
  ) return null

  const durationPattern = new RegExp(
    String.raw`\b(?:reset(?:s|ting)?|try again|retry|available(?: again)?|continue)[^.\r\n]{0,80}?\b(?:in|after)\s+((?:${DURATION_PART})(?:[\s,]*(?:and\s+)?(?:${DURATION_PART}))*)`,
    'i'
  )
  const durationText = durationPattern.exec(text)?.[1]
  const duration = durationText ? parseDuration(durationText) : 0
  if (duration > 0) return new Date(from.getTime() + duration)

  const iso = text.match(/\b20\d\d-\d\d-\d\d(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:?\d\d)?)?\b/)?.[0]
  if (iso) {
    const parsed = new Date(iso)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  const clock = text.match(
    /\b(?:reset(?:s|ting)?|try again|retry|available(?: again)?|continue)[^0-9\r\n]{0,20}(?:at\s*)?([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\b/i
  )?.[1]
  if (!clock) return null

  const parts = clock.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!parts) return null
  let hour = Number(parts[1])
  const minute = Number(parts[2] ?? 0)
  const meridiem = parts[3]?.toLowerCase()
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  } else if (hour > 23) {
    return null
  }

  const result = new Date(from)
  result.setHours(hour, minute, 0, 0)
  if (result.getTime() <= from.getTime() + 30_000) result.setDate(result.getDate() + 1)
  return result
}

/* ------------------------------------------------------------------------- *
 * Usage caps
 *
 * A cap is the owner's own stop rule, evaluated against the same provider-reported
 * figures the usage panel shows. It is deliberately separate from `continueOnLimit`,
 * which reacts to the provider's own limit by resuming later: a cap the owner set is
 * never auto-resumed, because resuming is the exact thing it was configured to prevent.
 * ------------------------------------------------------------------------- */

export interface ResolvedUsageCap { setting: UsageCapSetting; scope: UsageCapScope }

/** Keys in the existing settings table; no schema change and no parallel store. */
export const usageCapKey = (scope: UsageCapScope, id?: string): string =>
  scope === 'default' ? 'usageCap:default' : `usageCap:${scope}:${id}`

/**
 * Most specific wins, and an explicit "none" at a narrower scope opts that conversation
 * out of a broader cap instead of silently inheriting it.
 */
export function resolveUsageCap(stored: Partial<Record<UsageCapScope, string | null>>): ResolvedUsageCap | null {
  for (const scope of ['tab', 'workspace', 'default'] as const) {
    const setting = parseUsageCapSetting(stored[scope] ?? null)
    if (setting) return { setting, scope }
  }
  return null
}

/** The cap that actually stops work, or null when nothing applies. */
export function activeUsageCap(stored: Partial<Record<UsageCapScope, string | null>>): ResolvedUsageCap | null {
  const resolved = resolveUsageCap(stored)
  return resolved && isUsageCap(resolved.setting) ? resolved : null
}
