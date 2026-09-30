import { memo, useEffect, useState } from 'react'
import { nextAllowanceReset, windowShortLabel, type AllowanceGauge, type ProviderAllowanceRow } from '../../../shared/provider-allowance'
import './ProviderAllowance.css'

const W = 34, H = 11

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

function relative(ms: number): string {
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

function Gauge({ name, gauge, fallback }: { name: string; gauge: AllowanceGauge | undefined; fallback: string }): React.JSX.Element {
  if (!gauge) return <span className="provider-allowance-gauge empty" />
  const level = allowanceLevel(gauge.usedPercent)
  const path = sparklinePath(gauge)
  return <span className={`provider-allowance-gauge ${level}`} title={gaugeTitle(name, gauge)} data-window={fallback}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="track" />
      {path && <path className="area" d={`${path} V${H - 0.5} H${sparklineStart(gauge)} Z`} />}
      {path && <path className="line" d={path} />}
      {gauge.usedPercent !== null && <circle cx={sparklineX(Math.max(gauge.points.at(-1)?.[0] ?? 0, gauge.elapsed), gauge.elapsed)} cy={H - Math.min(100, gauge.usedPercent) / 100 * (H - 1) - 0.5} r="1.6" />}
    </svg>
    <b>{gauge.usedPercent === null ? '–' : `${Math.round(gauge.usedPercent)}%`}</b>
    <small>{windowShortLabel(gauge.windowMinutes, fallback)}</small>
  </span>
}

/** Sidebar strip between "Needs attention" and the process summary: each recently used paid
 *  provider's weekly and short-window allowance. It reads only what conversations already report
 *  (no provider call, no token spent) and re-reads when one reports, or when a window resets. */
export const ProviderAllowance = memo(function ProviderAllowance(): React.JSX.Element | null {
  const [rows, setRows] = useState<ProviderAllowanceRow[]>([])
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
  if (!rows.length) return null
  return <section className="provider-allowance" aria-label="Provider allowance">
    {rows.map(row => <div key={row.provider} className="provider-allowance-row" data-provider={row.provider}>
      <span className="provider-allowance-name" title={row.planType ? `${row.name} (${row.planType} plan)` : row.name}>{row.name}</span>
      <Gauge name={row.name} gauge={row.weekly} fallback="wk" />
      <Gauge name={row.name} gauge={row.short} fallback="short" />
    </div>)}
  </section>
})
