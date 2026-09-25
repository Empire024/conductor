import { useEffect, useState } from 'react'
import type { WeeklyModelUsageReport } from '../../../shared/weekly-model-usage'
import './WeeklyUsage.css'

const label = (value: number): string => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
/** The headline leaves out cache reads, the context every call re-reads (usage-accounting.ts). */
const processed = (model: WeeklyModelUsageReport['models'][number]): number => model.processedTokens ?? model.totalTokens ?? 0
const colors = ['var(--accent)', 'var(--blue)', '#a78bfa', '#d8a657', '#7fb8a0', '#c8799d']

/** Recorded token traffic, separate from providers' percentage allowance windows. */
export function WeeklyUsage({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const [report, setReport] = useState<WeeklyModelUsageReport>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false, pending = false
    const refresh = async (): Promise<void> => {
      if (pending || !window.conductor.usage) return
      pending = true
      try { const next = await window.conductor.usage.weekly(); if (!disposed) { setReport(next); setFailed(false) } }
      catch { if (!disposed) setFailed(true) }
      finally { pending = false }
    }
    void refresh()
    // A rolling seven-day total does not move visibly in half a minute, and every read is a
    // synchronous journal scan on the main process. This widget is mounted in the always-present
    // sidebar summary, so its interval is what the app pays, not what the pane pays.
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 5 * 60_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [])
  const models = report?.models.filter(model => processed(model) > 0) ?? []
  const total = models.reduce((sum, model) => sum + processed(model), 0)
  const partial = Boolean(report && !report.coverage.complete)
  return <section className={`weekly-usage${compact ? ' compact' : ''}`} aria-label="Weekly token usage">
    <div className="weekly-usage-heading"><span>Last 7 days</span><strong>{report ? `${label(total)} processed` : failed ? 'Unavailable' : 'Loading…'}</strong>{failed && report && <small>Stale</small>}{partial && <small title={report?.coverage.notes.join(' ')}>Partial</small>}</div>
    <div className="weekly-usage-bar" role="img" aria-label={models.length ? models.map(model => `${model.model ?? model.provider}: ${label(processed(model))} processed tokens`).join('; ') : 'No recorded token usage'}>
      {models.map((model, index) => <span key={`${model.provider}:${model.model}`} title={`${model.model ?? model.provider}: ${processed(model).toLocaleString()} processed (new input + cache write + output)${model.outputTokens !== undefined ? `, ${model.outputTokens.toLocaleString()} output` : ''}${model.cachedTokens ? `, ${model.cachedTokens.toLocaleString()} cache reads not counted` : ''}${model.estimated ? ' (estimated)' : ''}`} style={{ width: `${100 * processed(model) / total}%`, background: colors[index % colors.length] }} />)}
    </div>
    {!compact && <div className="weekly-usage-models">{models.map((model, index) => <span key={`${model.provider}:${model.model}`}><i style={{ background: colors[index % colors.length] }} /><b>{model.model ?? `${model.provider} · model unavailable`}</b><span>{model.estimated ? '~' : ''}{label(processed(model))}{model.outputTokens !== undefined ? ` · ${label(model.outputTokens)} out` : ''}</span></span>)}</div>}
    {report?.localSavings && (!compact || report.localSavings.tokensSaved > 0) && <div className="weekly-usage-local" title={`${report.localSavings.calls} local assist calls (${report.localSavings.modelCalls} answered by the local model), which read ${label(report.localSavings.localInputTokens)} tokens locally. Saved ≈ raw characters ÷ 4 − returned characters ÷ 4.`}>Local models saved ≈ {label(report.localSavings.tokensSaved)} tokens this week</div>}
    {!compact && <small className="weekly-usage-note">Recorded on this computer across projects. {partial ? 'Incomplete counters are excluded. ' : ''}Provider allowance is shown separately.</small>}
  </section>
}
