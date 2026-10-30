import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Timer } from 'lucide-react'
import { formatToolMs, type DurationStats, type ToolTimingsReport } from '../../../shared/tool-timings'
import './ToolTimings.css'

/**
 * Settings → Usage: where recorded structured tool-call time goes (src/main/tool-timings.ts). What is
 * not recorded is stated beside the numbers, not behind them.
 * A time nobody measured shows as “n/a” with how many calls were measured, never as zero.
 */
const WINDOWS = [{ label: 'Last hour', ms: 3_600_000 }, { label: 'Last 24 hours', ms: 86_400_000 }, { label: 'Last 7 days', ms: 7 * 86_400_000 }, { label: 'Everything kept', ms: 0 }] as const
const PROVIDERS = ['', 'claude', 'codex', 'grok', 'local'] as const
const percent = (share: number): string => `${Math.round(share * 100)}%`

function Stat({ stats, label }: { stats: DurationStats; label: string }): React.JSX.Element {
  const total = stats.measured + stats.unavailable
  return <span className="tool-timings-stat" title={`${label}: measured on ${stats.measured} of ${total} calls${stats.max !== null ? `, max ${formatToolMs(stats.max)}` : ''}`}>
    {stats.measured ? `${formatToolMs(stats.p50)} / ${formatToolMs(stats.p95)}` : 'n/a'}
    {stats.unavailable > 0 && stats.measured > 0 && <small> ({stats.measured}/{total})</small>}
  </span>
}

export function ToolTimingsSetting(): React.JSX.Element {
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[1].ms)
  const [provider, setProvider] = useState<string>('')
  const [report, setReport] = useState<ToolTimingsReport | null>(null)
  const [error, setError] = useState<string>()
  const load = useCallback(() => {
    if (!window.conductor?.toolTimings) return
    setError(undefined)
    window.conductor.toolTimings.report({ ...(windowMs ? { since: new Date(Date.now() - windowMs).toISOString() } : {}), ...(provider ? { provider } : {}), limit: 8 })
      .then(setReport).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [windowMs, provider])
  useEffect(load, [load])
  const review = Boolean(report?.tools.some(tool => tool.review.measured > 0))

  return <section className="tool-timings-setting" aria-label="Tool timings">
    <div className="settings-section-title"><Timer size={14} /><div><strong>Tool timings</strong><span>Structured tool calls recorded from Claude, Codex, Grok and local-model tabs. p50 / p95; a time nobody measured shows as n/a.</span></div></div>
    <div className="tool-timings-controls">
      <select aria-label="Tool timings window" value={windowMs} onChange={event => setWindowMs(Number(event.target.value))}>
        {WINDOWS.map(choice => <option key={choice.label} value={choice.ms}>{choice.label}</option>)}
      </select>
      <select aria-label="Tool timings provider" value={provider} onChange={event => setProvider(event.target.value)}>
        {PROVIDERS.map(choice => <option key={choice} value={choice}>{choice || 'All providers'}</option>)}
      </select>
      <button type="button" onClick={load} title="Refresh"><RefreshCw size={12} /> Refresh</button>
    </div>
    <p className="tool-timings-scope">Not recorded: Codex and Grok CLI-view tabs and conversations mirrored from another machine. Claude CLI-view calls (read when the tab returns to Chat) and cloud coworkers' calls (from pulled transcripts) are kept apart (tools.timings origin "cli-transcript" / "cloud-transcript"). Execution and approval wait are shown only where a provider or Conductor observed them.</p>
    {error && <p className="usage-cap-error">{error}</p>}
    {report && <>
      <p className="tool-timings-summary" data-calls={report.totals.calls}>
        {report.totals.calls} calls · {report.totals.failures} failed{report.totals.failureRate !== null ? ` (${percent(report.totals.failureRate)})` : ''} · {report.totals.inFlight} running
        {report.totals.abandoned > 0 && ` · ${report.totals.abandoned} never ended`}
        <br /><small>Measured: elapsed {percent(report.coverage.elapsed)}, approval wait {percent(report.coverage.wait)}, execution {percent(report.coverage.exec)} of calls{report.coverage.review > 0 && `; provider auto-review ${percent(report.coverage.review)}, shown apart from approval wait`}</small>
      </p>
      {report.totals.calls === 0 && <p className="tool-timings-empty">No tool calls recorded in this window.</p>}
      {report.tools.length > 0 && <table className="tool-timings-table">
        <thead><tr><th>Tool</th><th>Calls</th><th>Failed</th><th>Elapsed</th><th>Execution</th><th>Approval wait</th>{review && <th title="The provider's own automatic approval review, on its clock: not part of approval wait">Auto-review</th>}</tr></thead>
        <tbody>{report.tools.map(tool => <tr key={tool.tool} data-tool={tool.tool}>
          <td title={tool.providers.join(', ')}>{tool.tool}</td><td>{tool.calls}</td><td className={tool.failures ? 'failed' : ''}>{tool.failures}</td>
          <td><Stat stats={tool.elapsed} label="Elapsed" /></td><td><Stat stats={tool.exec} label="Execution" /></td><td><Stat stats={tool.wait} label="Approval wait" /></td>
          {review && <td><Stat stats={tool.review} label="Provider auto-review" /></td>}
        </tr>)}</tbody>
      </table>}
      {report.offenders.length > 0 && <>
        <h4>Top offenders</h4>
        <ul className="tool-timings-offenders">{report.offenders.map(offender => <li key={`${offender.kind}:${offender.provider}:${offender.tool}`} className={offender.severity} data-kind={offender.kind}>
          <strong>{offender.summary}</strong>{offender.provider && <span className="tool-timings-provider">{offender.provider}</span>}
          <p>{offender.suggestion}</p>
          {offender.evidence.examples.length > 0 && <code>{offender.evidence.examples.join('  ·  ')}</code>}
        </li>)}</ul>
      </>}
      {report.slowest.length > 0 && <>
        <h4>Slowest calls</h4>
        <ul className="tool-timings-slowest">{report.slowest.slice(0, 5).map(record => <li key={record.key}>
          <span>{record.tool}</span><code title={record.args}>{record.args || '—'}</code>
          <span title={record.elapsedMs !== null ? `elapsed (${record.elapsedSource})` : `execution (${record.execSource}); elapsed not measured`}>{formatToolMs(record.elapsedMs ?? record.execMs)} <small>{record.elapsedMs !== null ? record.elapsedSource === 'provider' ? 'elapsed · provider' : 'elapsed' : `exec · ${record.execSource}`}</small></span>
        </li>)}</ul>
      </>}
      <details className="tool-timings-gaps" open><summary>What each provider cannot report</summary><ul>{report.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        <p>Kept: {report.storage.records} of {report.storage.capacity} calls for {report.storage.retentionDays} days; {report.storage.deduplicated} restated events dropped.</p></details>
    </>}
  </section>
}
