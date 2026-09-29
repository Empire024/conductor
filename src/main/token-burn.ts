import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { normalizeTokenBurnAlert, TOKEN_BURN_ALERT_SETTING, TOKEN_BURN_WINDOW_MS, tokenBurnAlertPerHour, type TokenBurnRate, type TokenBurnSnapshot } from '../shared/token-burn'
import { summarizeWeeklyModelUsage, type WeeklyUsageConversation } from '../shared/weekly-model-usage'

/**
 * The per-tab token burn meter (feature-list codex-credit-burn 2): each live conversation's
 * provider-reported usage over the last hour, measured by the same summarizer as the weekly
 * usage report, so cumulative Codex counters and Claude's per-message snapshots are counted
 * exactly once. The journal is multi-gigabyte: every read is StructuredStore.usageBurn, a range
 * scan of the accounting index for one conversation and a few hours, and results are cached.
 */

/** A cumulative counter's first report in the hour is measured against the last one before it. */
const BASELINE_LOOKBACK_MS = 3 * TOKEN_BURN_WINDOW_MS
const CACHE_MS = 55_000
const PUBLISH_MS = 60_000

export interface TokenBurnSource {
  usageBurn(sessionId: string, from: string): WeeklyUsageConversation | null
}
export type BurnMeasure = Omit<TokenBurnRate, 'agentSessionId' | 'title' | 'provider' | 'alert'>
export interface LiveConversation { agentSessionId: string; title: string; provider: string }

/** The last hour of one conversation's usage, or null when it reported none. */
export function measureBurn(conversation: WeeklyUsageConversation | null, throughMs: number): BurnMeasure | null {
  if (!conversation?.events.length) return null
  const report = summarizeWeeklyModelUsage([conversation], throughMs, TOKEN_BURN_WINDOW_MS)
  let input = 0, cached = 0, output = 0, total = 0, reports = 0
  for (const row of report.models) {
    input += row.inputTokens ?? 0; cached += row.cachedTokens ?? 0; output += row.outputTokens ?? 0
    total += row.totalTokens ?? (row.inputTokens ?? 0) + (row.outputTokens ?? 0); reports += row.reports
  }
  if (!reports) return null
  return { tokensPerHour: input || output ? input + output : total, inputPerHour: input, cachedPerHour: cached, outputPerHour: output, reports }
}

export class TokenBurnService {
  private readonly cache = new Map<string, { at: number; value: BurnMeasure | null }>()
  constructor(private readonly source: TokenBurnSource, private readonly getSetting: (key: string) => string | null, private readonly now: () => number = Date.now) {}

  alertPerHour(): number { return tokenBurnAlertPerHour(this.getSetting) }

  measure(agentSessionId: string): BurnMeasure | null {
    const at = this.now(), cached = this.cache.get(agentSessionId)
    if (cached && at - cached.at < CACHE_MS) return cached.value
    const value = measureBurn(this.source.usageBurn(agentSessionId, new Date(at - TOKEN_BURN_WINDOW_MS - BASELINE_LOOKBACK_MS).toISOString()), at)
    this.cache.set(agentSessionId, { at, value })
    return value
  }

  /** One conversation's rate with its alert, as agents.status reports it. */
  rate(agentSessionId: string): (BurnMeasure & { alert: boolean; alertPerHour: number }) | null {
    const measured = this.measure(agentSessionId)
    if (!measured) return null
    const alertPerHour = this.alertPerHour()
    return { ...measured, alert: alertPerHour > 0 && measured.tokensPerHour >= alertPerHour, alertPerHour }
  }

  snapshot(conversations: LiveConversation[]): TokenBurnSnapshot {
    const alertPerHour = this.alertPerHour()
    const live = new Set(conversations.map(entry => entry.agentSessionId))
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id)
    const rates = conversations.flatMap(entry => {
      const measured = this.measure(entry.agentSessionId)
      return measured ? [{ ...entry, ...measured, alert: alertPerHour > 0 && measured.tokensPerHour >= alertPerHour }] : []
    }).sort((a, b) => b.tokensPerHour - a.tokensPerHour)
    return { observedAt: new Date(this.now()).toISOString(), alertPerHour, rates }
  }
}

/** The minute-by-minute broadcast the tab strip listens to, and the alert setting. */
export class TokenBurnMeter {
  private last = ''
  private timer?: NodeJS.Timeout
  constructor(private readonly options: {
    service: TokenBurnService
    live: () => LiveConversation[]
    setSetting: (key: string, value: string) => void
    publish: (channel: string, payload: unknown) => void
    intervalMs?: number
  }) {}

  snapshot(): TokenBurnSnapshot { return this.options.service.snapshot(this.options.live()) }
  alertPerHour(): number { return this.options.service.alertPerHour() }
  setAlertPerHour(value: unknown): number {
    const next = normalizeTokenBurnAlert(value)
    this.options.setSetting(TOKEN_BURN_ALERT_SETTING, String(next))
    this.publish(true)
    return next
  }
  /** Broadcasts when a rate moved by 10k/h or more, or an alert turned on or off. */
  publish(force = false): TokenBurnSnapshot {
    const snapshot = this.snapshot()
    const key = JSON.stringify([snapshot.alertPerHour, snapshot.rates.map(rate => [rate.agentSessionId, Math.round(rate.tokensPerHour / 10_000), rate.alert])])
    if (force || key !== this.last) { this.last = key; this.options.publish('token-burn:changed', snapshot) }
    return snapshot
  }
  start(): void {
    this.timer ??= setInterval(() => { try { this.publish() } catch { /* the meter never takes the main process down */ } }, this.options.intervalMs ?? PUBLISH_MS)
    this.timer.unref?.()
  }
  dispose(): void { clearInterval(this.timer); this.timer = undefined }
}

/** The renderer's reads and the alert setting; the meter is started later, with the app. */
export function registerTokenBurnIpc(ipcMain: Pick<IpcMain, 'handle'>, meter: () => TokenBurnMeter | undefined, trusted: (event: IpcMainInvokeEvent) => void): void {
  const started = (): TokenBurnMeter => {
    const current = meter()
    if (!current) throw new Error('The token burn meter is still starting; try again in a moment')
    return current
  }
  ipcMain.handle('token-burn:snapshot', event => { trusted(event); return started().snapshot() })
  ipcMain.handle('token-burn:alert', event => { trusted(event); return started().alertPerHour() })
  ipcMain.handle('token-burn:set-alert', (event, value: unknown) => { trusted(event); return started().setAlertPerHour(value) })
}
