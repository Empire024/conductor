import { memo, useEffect, useId, useState } from 'react'
import { UsageGradient } from './UsageGradient'
import { usageColor } from './usage-color'
import { nextAllowanceReset, windowShortLabel, type AllowanceGauge, type ProviderAllowanceRow } from '../../../shared/provider-allowance'
import { allowancePacing, formatTimeLeft, pacingHint } from '../../../shared/allowance-pacing'
import './ProviderAllowance.css'

const W = 34, H = 11
const MINUTE_MS = 60_000

/** Pixel x for a point at `share` (0-1 fraction of the *whole* window), once the axis is
 *  rescaled to only the elapsed-so-far part of the window (0-`elapsed`) so it fills the slot.
 *  A weekly window read soon after it opens has `elapsed` near 0: plotting samples over the
 *  full 7-day width collapses them into the first few pixels with the rest of the slot empty.
 *  Rescaling to what the window actually covers so far keeps the slot readable throughout the
 *  window instead of only once it's nearly over. `elapsed` is always this share's own upper
 *  bound (points never fall after "now"), so the scaled result is always within [0, W]. */
export function sparklineX(share: number, elapsed: number): number {
  const scale = elapsed > 0 ? Math.min(1, Math.max(0, share) / elapsed) : 0
  return +(scale * W).toFixed(2)
}

/** Step line of the window's reported percentages, x-axis rescaled to the elapsed part. */
export function sparklinePath(gauge: Pick<AllowanceGauge, 'points' | 'elapsed' | 'usedPercent'>): string {
  const y = (percent: number): number => +(H - Math.min(100, Math.max(0, percent)) / 100 * (H - 1) - 0.5).toFixed(2)
  const x = (share: number): number => sparklineX(share, gauge.elapsed)
  let path = '', last = 0
  for (const [share, percent] of gauge.points) {
    path += path ? ` H${x(share)} V${y(percent)}` : `M${x(share)} ${y(percent)}`
    last = share
  }
  return path && `${path} H${x(Math.max(last, gauge.elapsed))}`
}

export const sparklineStart = (gauge: Pick<AllowanceGauge, 'points' | 'elapsed'>): number => sparklineX(gauge.points[0]?.[0] ?? 0, gauge.elapsed)

export function allowanceLevel(percent: number | null): 'ok' | 'warn' | 'high' | 'unknown' {
  if (percent === null) return 'unknown'
  return percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok'
}

export function relative(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

export function gaugeTitle(name: string, gauge: AllowanceGauge, now = Date.now()): string {
  const used = gauge.usedPercent === null ? 'reset since it was last reported; current use unknown until the next turn reports it' : `${Math.round(gauge.usedPercent)}% used`
  const reset = gauge.resetsAt ? ` · resets ${new Date(gauge.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${Date.parse(gauge.resetsAt) > now ? ` (in ${relative(Date.parse(gauge.resetsAt) - now)})` : ''}` : ' · reset time not reported'
  return `${name} ${gauge.label.toLowerCase()}: ${used}${reset} · reported ${relative(now - Date.parse(gauge.observedAt))} ago`
}

/** "1h 42m", "42m", "3d 4h": a stretch of a window (time to its reset, time elapsed), to the minute. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS)
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export interface WindowProgress { leftMs: number; spanMs: number; elapsedShare: number }

/** Where `now` falls in a window, from the reset time the provider reported: null when the reset
 *  or the window length is not reported, or the window already rolled over (its use is unknown
 *  until the next report, and the strip re-reads right after the reset). */
export function windowProgress(gauge: Pick<AllowanceGauge, 'resetsAt' | 'windowMinutes' | 'usedPercent'>, now = Date.now()): WindowProgress | null {
  if (!gauge.resetsAt || !gauge.windowMinutes || gauge.usedPercent === null) return null
  const reset = Date.parse(gauge.resetsAt)
  if (!Number.isFinite(reset) || reset <= now) return null
  const spanMs = gauge.windowMinutes * MINUTE_MS
  const leftMs = Math.min(spanMs, reset - now)
  return { leftMs, spanMs, elapsedShare: 1 - leftMs / spanMs }
}

/** Re-renders once a minute on the minute, so countdowns tick without polling anything. Read the
 *  time with Date.now() in the render: a render caused by a new report then counts from that
 *  moment, not from the last tick. */
export function useMinuteClock(): void {
  const [, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: number | undefined
    const schedule = (): void => { timer = window.setTimeout(() => { setNow(Date.now()); schedule() }, MINUTE_MS - Date.now() % MINUTE_MS + 50) }
    schedule()
    return () => window.clearTimeout(timer)
  }, [])
}

/** The last rows read, so a view mounted later (the usage overview) starts from them instead of empty. */
let lastRows: ProviderAllowanceRow[] = []

/** Each recently used paid provider's allowance rows. It reads only what conversations already
 *  report (no provider call, no token spent) and re-reads when one reports, or when a window resets. */
export function useProviderAllowance(): ProviderAllowanceRow[] {
  const [rows, setRows] = useState<ProviderAllowanceRow[]>(() => lastRows)
  useEffect(() => {
    const usage = window.conductor.usage
    if (!usage?.limits) return
    let disposed = false, pending = false, again = false
    let resetTimer: number | undefined
    const refresh = async (): Promise<void> => {
      if (pending) { again = true; return }
      pending = true
      try {
        const next = await usage.limits()
        if (disposed) return
        lastRows = next
        setRows(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
        window.clearTimeout(resetTimer)
        const reset = nextAllowanceReset(next)
        // A window that rolls over makes its percentage stale; re-read just after it does.
        if (reset !== undefined) resetTimer = window.setTimeout(() => { void refresh() }, Math.min(2 ** 31 - 1, reset - Date.now() + 1500))
      } catch { /* Keep the last reading; the next report retries. */ }
      finally { pending = false; if (again && !disposed) { again = false; void refresh() } }
    }
    void refresh()
    const off = usage.onLimitsChanged(() => { void refresh() })
    return () => { disposed = true; off(); window.clearTimeout(resetTimer) }
  }, [])
  return rows
}

/** Spoken name of the strip button: the same figures the strip shows, then what a click does. */
export function allowanceButtonLabel(rows: readonly ProviderAllowanceRow[], now = Date.now()): string {
  const percent = (gauge: AllowanceGauge): string => gauge.usedPercent === null ? 'unknown' : `${Math.round(gauge.usedPercent)}%`
  const parts = rows.map(row => {
    const windows: string[] = []
    if (row.weekly) windows.push(`weekly ${percent(row.weekly)}`)
    if (row.short) {
      const progress = windowProgress(row.short, now)
      windows.push(`${windowShortLabel(row.short.windowMinutes, 'short')} ${percent(row.short)}${progress ? `, resets in ${formatDuration(progress.leftMs)}` : ''}`)
    }
    return `${row.name} ${windows.join(', ')}`
  })
  return `Usage: ${parts.join('; ')}. Open the full usage view`
}

function Gauge({ name, gauge, fallback, now, pacing: withPacing, countdown }: { name: string; gauge: AllowanceGauge | undefined; fallback: string; now: number; pacing?: boolean; countdown?: boolean }): React.JSX.Element {
  const gradientId = `usage-spark-${useId().replace(/:/g, '')}`
  if (!gauge) return <span className="provider-allowance-gauge empty" />
  const level = allowanceLevel(gauge.usedPercent)
  const path = sparklinePath(gauge)
  // Weekly only: unused allowance against time left. Its orange/red marks tokens about to be
  // lost at the reset, a separate signal from the near-limit level colour of the line.
  const pacing = withPacing ? allowancePacing(gauge, now) : null
  const hint = pacing && pacingHint(pacing)
  const waste = pacing?.state === 'waste-high' || pacing?.state === 'waste-warn' ? ` ${pacing.state}` : ''
  // Short window only: how close its end is, as time left and an elapsed bar under the gauge.
  const progress = countdown ? windowProgress(gauge, now) : null
  const elapsed = progress ? ` · ${Math.round(progress.elapsedShare * 100)}% of the window elapsed` : ''
  const title = `${hint ? `${hint}\n` : ''}${gaugeTitle(name, gauge, now)}${elapsed}`
  return <span className={`provider-allowance-gauge ${level}${waste}`} title={title} data-window={fallback} data-pacing={pacing?.state}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <UsageGradient id={gradientId} bottom={H - 0.5} top={0.5} />
      <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="track" />
      {path && <path className="area" d={`${path} V${H - 0.5} H${sparklineStart(gauge)} Z`} fill={`url(#${gradientId})`} />}
      {path && <path className="line" d={path} stroke={`url(#${gradientId})`} />}
      {gauge.usedPercent !== null && <circle fill={usageColor(gauge.usedPercent)} cx={sparklineX(Math.max(gauge.points.at(-1)?.[0] ?? 0, gauge.elapsed), gauge.elapsed)} cy={H - Math.min(100, gauge.usedPercent) / 100 * (H - 1) - 0.5} r="1.6" />}
    </svg>
    <b>{gauge.usedPercent === null ? '–' : `${Math.round(gauge.usedPercent)}%`}</b>
    <small>{windowShortLabel(gauge.windowMinutes, fallback)}</small>
    {pacing && <i className="provider-allowance-left">{pacing.leftMs !== null && pacing.unusedPercent !== null ? formatTimeLeft(pacing.leftMs) : ''}</i>}
    {countdown && <i className="provider-allowance-left provider-allowance-reset">{progress ? formatDuration(progress.leftMs) : ''}</i>}
    {progress && <span className="provider-allowance-elapsed" aria-hidden="true"><span style={{ width: `${(progress.elapsedShare * 100).toFixed(1)}%` }} /></span>}
  </span>
}

/** Sidebar strip between "Needs attention" and the process summary: each recently used paid
 *  provider's weekly and short-window allowance, with the short window's time to its reset. The
 *  whole strip is one button that opens the full usage view (UsageOverview). */
export const ProviderAllowance = memo(function ProviderAllowance({ onOpen, expanded = false }: { onOpen?(anchor: HTMLElement): void; expanded?: boolean }): React.JSX.Element | null {
  const rows = useProviderAllowance()
  useMinuteClock()
  const now = Date.now()
  if (!rows.length) return null
  return <section className="provider-allowance" aria-label="Provider allowance">
    <button type="button" className="provider-allowance-open" aria-haspopup="dialog" aria-expanded={expanded} aria-label={allowanceButtonLabel(rows, now)} onClick={event => onOpen?.(event.currentTarget)}>
      {rows.map(row => <span key={row.provider} className="provider-allowance-row" data-provider={row.provider}>
        <span className="provider-allowance-name" title={row.planType ? `${row.name} (${row.planType} plan)` : row.name}>{row.name}</span>
        <Gauge name={row.name} gauge={row.weekly} fallback="wk" now={now} pacing />
        <Gauge name={row.name} gauge={row.short} fallback="short" now={now} countdown />
      </span>)}
    </button>
  </section>
})
