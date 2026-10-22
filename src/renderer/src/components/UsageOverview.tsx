import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Flame, Gauge, X } from 'lucide-react'
import { windowShortLabel, type AllowanceGauge, type ProviderAllowanceRow } from '../../../shared/provider-allowance'
import { allowancePacing, pacingHint } from '../../../shared/allowance-pacing'
import { allowanceLevel, formatDuration, relative, useMinuteClock, useProviderAllowance, windowProgress } from './ProviderAllowance'
import { UsageGradient } from './UsageGradient'
import { usageColor } from './usage-color'
import { TokenBurnList, useTokenBurn } from './TokenBurn'
import { WeeklyAllowance } from './WeeklyAllowance'
import { WeeklyUsage } from './WeeklyUsage'
import './UsageOverview.css'

const CW = 300, CH = 56
const chartX = (share: number): number => +(Math.min(1, Math.max(0, share)) * CW).toFixed(1)
const chartY = (percent: number): number => +(CH - Math.min(100, Math.max(0, percent)) / 100 * (CH - 2) - 1).toFixed(1)

/** Step line of a window's reported percentages over the whole window: x 0 is where it opened,
 *  CW its reset, and the line ends at `elapsed` (now). Unlike the sidebar sparkline the axis is
 *  not rescaled, so the empty stretch to its right is the part of the window still to come. */
export function windowChartPath(points: ReadonlyArray<readonly [number, number]>, elapsed: number): string {
  let path = '', last = 0
  for (const [share, percent] of points) {
    path += path ? ` H${chartX(share)} V${chartY(percent)}` : `M${chartX(share)} ${chartY(percent)}`
    last = share
  }
  return path && `${path} H${chartX(Math.max(last, elapsed))}`
}

const clock = (at: number, withDay: boolean): string => new Date(at).toLocaleString(undefined, withDay ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })

function WindowCard({ name, gauge, kind, now }: { name: string; gauge: AllowanceGauge; kind: 'weekly' | 'short'; now: number }): React.JSX.Element {
  const gradientId = `usage-chart-${useId().replace(/:/g, '')}`
  const progress = windowProgress(gauge, now)
  const pacing = kind === 'weekly' ? allowancePacing(gauge, now) : null
  const hint = pacing && pacingHint(pacing)
  const elapsed = progress?.elapsedShare ?? gauge.elapsed
  const path = windowChartPath(gauge.points, elapsed)
  const span = windowShortLabel(gauge.windowMinutes, kind === 'weekly' ? 'week' : 'short')
  const resetAt = gauge.resetsAt ? Date.parse(gauge.resetsAt) : NaN
  const withDay = (gauge.windowMinutes ?? 0) > 1440
  const startAt = Number.isFinite(resetAt) && gauge.windowMinutes ? resetAt - gauge.windowMinutes * 60_000 : NaN
  const label = `${name} ${gauge.label.toLowerCase()}`
  return <article className={`usage-window ${allowanceLevel(gauge.usedPercent)}`} data-window={kind}>
    <header>
      <strong>{gauge.label}</strong>
      <small>{span} window</small>
      <b>{gauge.usedPercent === null ? '–' : `${Math.round(gauge.usedPercent)}%`}<small> used</small></b>
    </header>
    <svg className="usage-window-chart" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" role="img" aria-label={`${label}: use over the current window`}>
      <UsageGradient id={gradientId} bottom={chartY(0)} top={chartY(100)} />
      <line className="grid" x1="0" x2={CW} y1={chartY(50)} y2={chartY(50)} />
      <line className="grid" x1="0" x2={CW} y1={chartY(100)} y2={chartY(100)} />
      <line className="pace" x1="0" x2={CW} y1={chartY(0)} y2={chartY(100)} />
      {path && <path className="area" d={`${path} V${chartY(0)} H${chartX(gauge.points[0]?.[0] ?? 0)} Z`} fill={`url(#${gradientId})`} />}
      {path && <path className="line" d={path} stroke={`url(#${gradientId})`} />}
      <line className="now" x1={chartX(elapsed)} x2={chartX(elapsed)} y1="0" y2={CH} />
      {gauge.usedPercent !== null && <circle className="current" fill={usageColor(gauge.usedPercent)} cx={chartX(elapsed)} cy={chartY(gauge.usedPercent)} r="2.5" />}
    </svg>
    <div className="usage-window-axis"><span>{Number.isFinite(startAt) ? clock(startAt, withDay) : ''}</span><span>{Number.isFinite(resetAt) ? clock(resetAt, withDay) : ''}</span></div>
    <p className="usage-window-reset">
      {progress
        ? <>Resets in <b>{formatDuration(progress.leftMs)}</b>{Number.isFinite(resetAt) ? ` · ${clock(resetAt, true)}` : ''}</>
        : Number.isFinite(resetAt) ? `Reset ${clock(resetAt, true)}; current use unknown until the next turn reports it` : 'Reset time not reported'}
    </p>
    {progress && <>
      <div className="usage-window-progress" role="progressbar" aria-label={`${label} window elapsed`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.elapsedShare * 100)} aria-valuetext={`${formatDuration(progress.spanMs - progress.leftMs)} of ${span} elapsed, resets in ${formatDuration(progress.leftMs)}`}>
        <span style={{ width: `${(progress.elapsedShare * 100).toFixed(1)}%` }} />
      </div>
      <small className="usage-window-elapsed">{formatDuration(progress.spanMs - progress.leftMs)} of {span} elapsed</small>
    </>}
    {hint && <p className="usage-window-hint">{hint}</p>}
    <small className="usage-window-observed">Reported {relative(now - Date.parse(gauge.observedAt))} ago</small>
  </article>
}

/** Every provider's allowance windows at full size, pure so tests render it with a fixed clock. */
export function UsageAllowanceDetails({ rows, now = Date.now() }: { rows: readonly ProviderAllowanceRow[]; now?: number }): React.JSX.Element {
  return <section className="usage-overview-allowance" aria-label="Allowance windows by provider">
    {rows.map(row => <div key={row.provider} className="usage-provider" data-provider={row.provider}>
      <h4>{row.name}{row.planType && <small>{row.planType} plan</small>}</h4>
      <div className="usage-provider-windows">
        {row.weekly && <WindowCard name={row.name} gauge={row.weekly} kind="weekly" now={now} />}
        {row.short && <WindowCard name={row.name} gauge={row.short} kind="short" now={now} />}
      </div>
    </div>)}
    {!rows.length && <p className="usage-overview-empty">No provider has reported an allowance yet. Any Claude or Codex conversation reports it as it runs.</p>}
  </section>
}

/** The full usage view the sidebar's usage corner opens: allowance windows with their reset
 *  countdowns and history lines, week by week allowance with tokens and cost, the last seven days
 *  of tokens per model, and each live tab's burn. Everything comes from the readers those
 *  widgets already use; nothing here asks a provider. */
export function UsageOverview({ anchor, onClose }: { anchor: HTMLElement; onClose(): void }): React.JSX.Element {
  const rows = useProviderAllowance()
  useMinuteClock()
  const now = Date.now()
  const burn = useTokenBurn()
  const ref = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<CSSProperties>({ left: 8, bottom: 8 })

  useLayoutEffect(() => {
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(660, window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.left + 6, window.innerWidth - width - 8))
      const above = rect.top - 14
      setPosition(above >= 320 ? { left, width, bottom: window.innerHeight - rect.top + 6, maxHeight: above } : { left, width, bottom: 8, maxHeight: window.innerHeight - 16 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => { ref.current?.focus() }, [])

  useEffect(() => {
    const dismiss = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node) || anchor.contains(event.target as Node)) return
      onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target as Node | null
      // Escape is the dialog's while focus is in it or on its trigger; elsewhere it still closes
      // the dialog but stays with whatever owns the focus (a composer, another dialog).
      if (target && (ref.current?.contains(target) || anchor.contains(target))) { event.preventDefault(); event.stopPropagation(); anchor.focus() }
      onClose()
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape, true) }
  }, [anchor, onClose])

  return createPortal(
    <section ref={ref} className="usage-overview" style={position} role="dialog" aria-label="Usage" tabIndex={-1}>
      <header className="usage-overview-head">
        <span><Gauge size={14} /><strong>Usage</strong></span>
        <button type="button" aria-label="Close usage" title="Close (Esc)" onClick={() => { anchor.focus(); onClose() }}><X size={13} /></button>
      </header>
      <UsageAllowanceDetails rows={rows} now={now} />
      <WeeklyAllowance />
      <WeeklyUsage />
      <section className="usage-overview-burn" aria-label="Token burn">
        <div className="usage-overview-burn-head"><Flame size={12} /><span>Token burn</span><strong>Last hour per live tab, input with cache reads plus output</strong></div>
        <TokenBurnList rates={burn?.rates ?? []} />
      </section>
      <footer>Read from what conversations already report on this computer; nothing asks a provider. Cost is the provider CLI’s API-price estimate where it reports one, not a charge.</footer>
    </section>,
    document.body
  )
}
