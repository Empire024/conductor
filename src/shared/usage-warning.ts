import { evaluateUsageCap, isUsageCap, type UsageCapSetting, type UsageScopeReport } from './usage-accounting'

/*
 * "Becoming expensive" while a conversation is still running -- well before any cap would stop
 * it outright. One shared definition so a tab and the Processes summary always agree on what
 * counts, instead of each guessing its own number.
 */

export type UsageWarningLevel = 'approaching' | 'high'

/** Fractions of the applicable stop rule at which a running conversation gets flagged.
 *  Two steps: worth a glance, then worth a look before it goes further. */
export const USAGE_WARNING_FRACTIONS: Record<UsageWarningLevel, number> = { approaching: 0.7, high: 0.9 }

/** Only used when no usage cap is configured at any scope (tab, workspace or default), so the
 *  warning still means something instead of staying silent until a provider-side limit lands. */
export const DEFAULT_COST_WARNING_USD: Record<UsageWarningLevel, number> = { approaching: 2, high: 5 }

export interface UsageWarning {
  level: UsageWarningLevel
  /** 0-1, how far past the fired level's own boundary; drives a meter fill, never above 1. */
  fraction: number
  /** Names the figure this rests on, for a tooltip -- never just a bare percentage. */
  detail: string
}

function levelFor(value: number, thresholds: Record<UsageWarningLevel, number>): UsageWarningLevel | undefined {
  return value >= thresholds.high ? 'high' : value >= thresholds.approaching ? 'approaching' : undefined
}

/**
 * Expressed as a fraction of the cap already in effect for this conversation, so raising or
 * clearing that cap moves this warning with it instead of tracking an unrelated number. With no
 * cap configured anywhere, falls back to a flat cost figure -- the owner's own rough sense of
 * "expensive" -- so an uncapped conversation still warns instead of staying silent indefinitely.
 * Never fires on a figure the provider has not reported, matching how a cap itself behaves.
 */
export function evaluateUsageWarning(report: UsageScopeReport, cap: UsageCapSetting | null | undefined): UsageWarning | null {
  if (isUsageCap(cap)) {
    const status = evaluateUsageCap(cap, report)
    if (status.value === undefined || status.limit <= 0) return null
    const fraction = status.value / status.limit
    const level = levelFor(fraction, USAGE_WARNING_FRACTIONS)
    if (!level) return null
    return { level, fraction: Math.min(1, fraction), detail: `${Math.round(Math.min(1, fraction) * 100)}% of the usage cap: ${status.detail}` }
  }
  const costUsd = report.costUsd
  if (costUsd === undefined) return null
  const level = levelFor(costUsd, DEFAULT_COST_WARNING_USD)
  if (!level) return null
  return {
    level, fraction: Math.min(1, costUsd / DEFAULT_COST_WARNING_USD.high),
    detail: `$${costUsd.toFixed(2)} spent in this conversation${report.costEstimated ? ' (estimated)' : ''}. No usage cap is configured.`
  }
}
