/**
 * Per-tab token burn (feature-list codex-credit-burn 2). On 2026-09-29 the owner's Codex
 * credits vanished: 262M input tokens in 24 h, a pure relay tab alone 12.2M. Nothing showed
 * which tab was spending them, so each live conversation's last hour of provider-reported usage
 * is metered, and a tab above the owner's rate is marked on the tab strip.
 */

/** Settings key: tokens per hour (input, cache reads included, plus output) that raise the alert; 0 is Off. */
export const TOKEN_BURN_ALERT_SETTING = 'tokenBurnAlertPerHour'
export const DEFAULT_TOKEN_BURN_ALERT_PER_HOUR = 5_000_000
export const TOKEN_BURN_ALERT_CHOICES = [1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 0] as const
/** The metered window. */
export const TOKEN_BURN_WINDOW_MS = 60 * 60 * 1000

export interface TokenBurnRate {
  agentSessionId: string
  title: string
  provider: string
  /** Input (cache reads included) plus output over the last hour: what a provider meters. */
  tokensPerHour: number
  inputPerHour: number
  cachedPerHour: number
  outputPerHour: number
  /** Provider usage reports counted in the window (about one per model call). */
  reports: number
  alert: boolean
}

export interface TokenBurnSnapshot {
  observedAt: string
  /** 0 when the alert is off. */
  alertPerHour: number
  /** Live conversations with any usage in the last hour, highest burn first. */
  rates: TokenBurnRate[]
}

export interface TokenBurnBridge {
  snapshot(): Promise<TokenBurnSnapshot>
  alertPerHour(): Promise<number>
  setAlertPerHour(value: number): Promise<number>
  onChanged(callback: (snapshot: TokenBurnSnapshot) => void): () => void
}

export function tokenBurnAlertPerHour(getSetting: (key: string) => string | null): number {
  const stored = getSetting(TOKEN_BURN_ALERT_SETTING)
  const value = Number(stored)
  return stored !== null && (TOKEN_BURN_ALERT_CHOICES as readonly number[]).includes(value) ? value : DEFAULT_TOKEN_BURN_ALERT_PER_HOUR
}

export function normalizeTokenBurnAlert(value: unknown): number {
  if (typeof value !== 'number' || !(TOKEN_BURN_ALERT_CHOICES as readonly number[]).includes(value)) throw new Error(`Choose one of ${TOKEN_BURN_ALERT_CHOICES.join(', ')} tokens per hour (0 is Off)`)
  return value
}

/** "4.1M/h", "820k/h". */
export function formatBurn(tokensPerHour: number): string {
  if (tokensPerHour >= 1_000_000) return `${(tokensPerHour / 1_000_000).toFixed(tokensPerHour >= 10_000_000 ? 0 : 1)}M/h`
  if (tokensPerHour >= 1000) return `${Math.round(tokensPerHour / 1000)}k/h`
  return `${Math.round(tokensPerHour)}/h`
}
