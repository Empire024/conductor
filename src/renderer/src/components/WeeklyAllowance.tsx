import { useEffect, useState } from 'react'
import { weekVerdict, type AllowanceWeek, type AllowanceWeekReport } from '../../../shared/usage-weeks'
import './WeeklyAllowance.css'

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }
const tokens = (value: number): string => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const cost = (value: number): string => `≈ $${value < 10 ? value.toFixed(2) : value.toFixed(0)}`
const day = (value: string | null): string => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '?'

export function weekDates(week: AllowanceWeek): string {
  if (week.status === 'no-data') return week.endsAt ? `${day(week.startsAt)} – ${day(week.endsAt)}` : `Since ${day(week.startsAt)}`
  return `${day(week.startsAt ?? week.firstReadingAt)} – ${day(week.endsAt)}`
}

/** A model-scoped bucket names its model unless its label already does ("Fable weekly"). */
export function bucketLabel(week: Pick<AllowanceWeek, 'label' | 'scope' | 'models'>): string {
  const model = week.scope === 'model' ? week.models?.at(-1) : undefined
  return model && !week.label.toLowerCase().includes(model.toLowerCase()) ? `${model} ${week.label.toLowerCase()}` : week.label
}

/** Each provider bucket's windows, in report order (newest first within a bucket). */
export function groupWeeks(weeks: readonly AllowanceWeek[]): Array<{ key: string; title: string; weeks: AllowanceWeek[] }> {
  const groups: Array<{ key: string; title: string; weeks: AllowanceWeek[] }> = []
  for (const week of weeks) {
    const key = `${week.provider}:${week.bucket}`
    let group = groups.find(entry => entry.key === key)
    if (!group) { group = { key, title: `${NAMES[week.provider] ?? week.provider} · ${bucketLabel(week)}`, weeks: [] }; groups.push(group) }
    group.weeks.push(week)
  }
  return groups
}

function WeekRow({ week, now }: { week: AllowanceWeek; now: number }): React.JSX.Element {
  const peak = week.peakPercent ?? 0
  const projected = week.status === 'current' && week.projection ? Math.min(100, week.projection.percentAtReset) : null
  const tone = week.status === 'no-data' ? 'none' : week.usedUp ? 'used-up' : week.status === 'current' ? 'current' : (week.unusedPercent ?? 0) >= 50 ? 'left' : 'ok'
  const spent = week.tokens
  return <div className={`weekly-allowance-row ${tone}`} role="row" data-status={week.status}>
    <span className="weekly-allowance-dates" role="cell">{week.status === 'current' ? <b>This week</b> : null}{weekDates(week)}</span>
    <span className="weekly-allowance-bar" role="cell" aria-label={week.peakPercent === null ? 'No readings' : `Peak ${week.peakPercent}% used`}>
      {projected !== null && projected > peak && <i className="projected" style={{ width: `${projected}%` }} />}
      {week.peakPercent !== null && <i className="peak" style={{ width: `${Math.min(100, peak)}%` }} />}
      <small>{week.peakPercent === null ? '–' : `${Math.round(peak)}%`}</small>
    </span>
    <span className="weekly-allowance-verdict" role="cell" title={week.notes.join('\n') || undefined}>
      {weekVerdict(week, now)}
      {week.coverage === 'partial' && <em>Partial data</em>}
    </span>
    <span className="weekly-allowance-spend" role="cell" title={spent?.models.map(model => `${model.model ?? 'model not reported'}: ${tokens(model.processedTokens ?? 0)} processed${model.costUsd !== undefined ? `, ${cost(model.costUsd)}` : ''}`).join('\n') || undefined}>
      {spent ? <>{tokens(spent.processedTokens)} tok{spent.costUsd !== null ? ` · ${cost(spent.costUsd)}` : ''}{!spent.complete && <em title={spent.notes.join(' ')}>partial</em>}</> : week.status === 'no-data' ? '' : '—'}
    </span>
  </div>
}

/** The report itself, pure so it renders the same in tests and in the pane. */
export function WeeklyAllowanceList({ report, now = Date.now() }: { report: AllowanceWeekReport; now?: number }): React.JSX.Element {
  const groups = groupWeeks(report.weeks)
  return <div className="weekly-allowance-list" role="table" aria-label="Weekly allowance by provider window">
    {groups.map(group => <section key={group.key} role="rowgroup" data-bucket={group.key}>
      <h4>{group.title}</h4>
      {group.weeks.map(week => <WeekRow key={`${week.status}:${week.startsAt}:${week.endsAt}`} week={week} now={now} />)}
    </section>)}
    {!groups.length && <p className="weekly-allowance-empty">No weekly allowance readings yet. Any Claude or Codex conversation reports its allowance as it runs.</p>}
    {report.unknown.map(line => <p key={line} className="weekly-allowance-note">{line}</p>)}
    <p className="weekly-allowance-note">
      Split at each provider’s own reset. A week’s final figure is its last reading before the reset; stretches without readings are shown as such.
      {report.recordedSince ? ` Readings since ${new Date(report.recordedSince).toLocaleDateString()}.` : ''} Cost is the provider CLI’s API-price estimate where it reports one, not a charge.
    </p>
  </div>
}

/** Dashboard "Weekly" view: did each week's allowance get used up or left on the table? */
export function WeeklyAllowance(): React.JSX.Element {
  const [report, setReport] = useState<AllowanceWeekReport>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const usage = window.conductor.usage
    if (!usage?.allowanceWeeks) return
    let disposed = false, pending = false, last = 0
    const refresh = async (): Promise<void> => {
      if (pending || disposed) return
      pending = true; last = Date.now()
      try { const next = await usage.allowanceWeeks(8); if (!disposed) { setReport(next); setFailed(false) } }
      catch { if (!disposed) setFailed(true) }
      finally { pending = false }
    }
    void refresh()
    // Closed weeks never change and the current one moves a point at a time: a reported
    // allowance re-reads at most once a minute, and a quiet app every ten.
    const off = usage.onLimitsChanged(() => { if (Date.now() - last > 60_000) void refresh() })
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 10 * 60_000)
    return () => { disposed = true; off(); clearInterval(timer) }
  }, [])
  return <section className="weekly-allowance" aria-label="Weekly allowance">
    <div className="weekly-allowance-heading"><span>Weekly</span><strong>Allowance used per provider week</strong>{failed && <small>{report ? 'Stale' : 'Unavailable'}</small>}</div>
    {report ? <WeeklyAllowanceList report={report} /> : !failed && <p className="weekly-allowance-empty">Reading weekly allowance…</p>}
  </section>
}
