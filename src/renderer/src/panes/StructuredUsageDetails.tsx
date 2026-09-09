import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StructuredProvider, TimelineItem } from '../../../shared/structured-agent'
import type { UsageCap, UsageCapMetric, UsageCapScope, UsageCapSetting, UsageCapSnapshot, UsageScopeReport, UsageWindowMovement } from '../../../shared/usage-accounting'
import { describeUsageCap, evaluateUsageCap, shortWindow, summarizeContext, summarizeUsage, summarizeUsageRun, weeklyWindow } from './usage-summary'
import './StructuredUsageDetails.css'

const providerNames: Record<StructuredProvider, string> = { codex: 'Codex', claude: 'Claude' }
const percent = (value: number): string => `${Math.round(value * 10) / 10}%`
const points = (value: number): string => `${Math.round(value * 10) / 10}`

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
const instant = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
}

/**
 * The headline sentence. It only ever names a figure two provider reports support: the
 * account window level when this conversation opened and its level now. Conductor cannot
 * see which conversation moved the account counter, so the sentence says "while this
 * conversation was open" rather than claiming the conversation caused all of it.
 */
function HeadlineUsage({ report, name }: { report: UsageScopeReport; name: string }): React.JSX.Element | null {
  const moved = report.windows.filter(window => window.consumedPercent !== undefined && window.consumedPercent > 0)
  const lead = weeklyWindow(moved) ?? moved[0]
  if (!lead || lead.consumedPercent === undefined) return null
  return <p className="sa-usage-headline">
    <strong>{name}</strong> used <strong>{points(lead.consumedPercent)} points</strong> of your {lead.label.toLowerCase()} allowance while this conversation was open
    {' '}({percent(lead.startPercent)} → {percent(lead.usedPercent)} account-wide).
  </p>
}

function WindowMovement({ window: usage }: { window: UsageWindowMovement }): React.JSX.Element {
  const reset = instant(usage.resetsAt)
  return <div className="sa-limit-detail">
    <span>{usage.label}</span>
    <strong>{percent(usage.usedPercent)} used</strong>
    <progress max={100} value={Math.max(0, Math.min(100, usage.usedPercent))} aria-label={`${usage.label} usage`} />
    {usage.consumedPercent !== undefined
      ? <small>{usage.samples > 1
        ? `${points(usage.consumedPercent)} points moved while this conversation was open (from ${percent(usage.startPercent)})`
        : 'Only one report so far, so no movement can be attributed to this conversation yet'}</small>
      : <small>This window reset while the conversation was open; the earlier share cannot be attributed.</small>}
    {reset && <small>Resets {reset}</small>}
  </div>
}

function ScopeFigures({ report, label }: { report: UsageScopeReport; label: string }): React.JSX.Element {
  const tokens = report.tokens
  return <section className="sa-usage-scope">
    <h4>{label}</h4>
    {tokens ? <dl>
      {tokens.totalTokens !== undefined && <><dt>Total tokens</dt><dd>{tokens.totalTokens.toLocaleString()}</dd></>}
      {tokens.inputTokens !== undefined && <><dt>Input tokens</dt><dd>{tokens.inputTokens.toLocaleString()}</dd></>}
      {tokens.outputTokens !== undefined && <><dt>Output tokens</dt><dd>{tokens.outputTokens.toLocaleString()}</dd></>}
      {tokens.reasoningTokens !== undefined && <><dt>Reasoning tokens</dt><dd>{tokens.reasoningTokens.toLocaleString()}</dd></>}
      {tokens.cachedTokens !== undefined && <><dt>Cached input tokens</dt><dd>{tokens.cachedTokens.toLocaleString()}</dd></>}
      {tokens.cacheCreationTokens !== undefined && <><dt>Cache creation tokens</dt><dd>{tokens.cacheCreationTokens.toLocaleString()}</dd></>}
    </dl> : <p className="sa-detail-hint">Token usage has not been reported.</p>}
    {(report.turns > 0 || report.usageReports > 0 || report.wallMs !== undefined) && <dl>
      {report.turns > 0 && <><dt>Turns</dt><dd>{report.turns.toLocaleString()}</dd></>}
      {report.usageReports > 0 && <><dt>Provider usage reports</dt><dd>{report.usageReports.toLocaleString()}</dd></>}
      {report.wallMs !== undefined && <><dt>Wall time</dt><dd>{duration(report.wallMs)}</dd></>}
    </dl>}
    {report.windows.map(usage => <WindowMovement key={usage.key} window={usage} />)}
  </section>
}

const capMetrics: Array<{ id: UsageCapMetric; label: string }> = [
  { id: 'weekly-percent', label: 'Weekly allowance' },
  { id: 'short-window-percent', label: 'Short rolling window' },
  { id: 'tokens', label: 'Tokens in this conversation' }
]

function UsageCapEditor({ agentSessionId, workspaceId, report }: {
  agentSessionId: string
  workspaceId: string
  report: UsageScopeReport
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageCapSnapshot | null>(null)
  const [scope, setScope] = useState<Exclude<UsageCapScope, 'default'>>('tab')
  const [error, setError] = useState<string>()
  const read = useCallback(() => {
    window.conductor.usageCaps.read(agentSessionId, workspaceId).then(setSnapshot).catch(reason => setError(String(reason)))
  }, [agentSessionId, workspaceId])
  useEffect(read, [read])

  const configured = snapshot?.[scope] ?? null
  const cap: UsageCap | null = configured && configured.metric !== 'none' ? configured : null
  const save = (setting: UsageCapSetting | null): void => {
    setError(undefined)
    window.conductor.usageCaps.write(scope, scope === 'tab' ? agentSessionId : workspaceId, setting)
      .then(read).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const update = (change: Partial<UsageCap>): void => save({ metric: 'weekly-percent', limit: 25, basis: 'conversation', ...cap, ...change })
  // The same evaluation the main process enforces, over the same reported figures.
  const effective = snapshot?.effective?.setting
  const status = effective && effective.metric !== 'none' ? evaluateUsageCap(effective, report) : undefined

  return <section className="sa-usage-cap">
    <h4>Usage cap</h4>
    <p className="sa-detail-hint">A cap stops this conversation once the provider's own reported figures cross it. It is not automatic limit continuation: continuation resumes when the provider's window reopens, while a cap you set stays stopped until you change it.</p>
    <div className="sa-usage-cap-scope">
      {(['tab', 'workspace'] as const).map(option => <button key={option} type="button" className={scope === option ? 'active' : ''} aria-pressed={scope === option} onClick={() => setScope(option)}>
        {option === 'tab' ? 'This conversation' : 'Whole workspace'}
      </button>)}
    </div>
    <label className="sa-usage-cap-row">
      <span>Cap</span>
      <select value={configured === null ? 'inherit' : configured.metric} onChange={event => {
        const value = event.target.value
        if (value === 'inherit') save(null)
        else if (value === 'none') save({ metric: 'none' })
        else update({ metric: value as UsageCapMetric, ...(value === 'tokens' ? { limit: 200_000, basis: 'conversation' as const } : { limit: 25 }) })
      }}>
        <option value="inherit">{scope === 'tab' ? 'Inherit from workspace' : 'No workspace cap'}</option>
        <option value="none">Never stop for usage</option>
        {capMetrics.map(metric => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
      </select>
    </label>
    {cap && <>
      <label className="sa-usage-cap-row">
        <span>{cap.metric === 'tokens' ? 'Tokens' : cap.basis === 'account' ? 'Account reaches' : 'Points consumed'}</span>
        <input type="number" min={1} max={cap.metric === 'tokens' ? undefined : 100} step={cap.metric === 'tokens' ? 1000 : 1} value={cap.limit}
          onChange={event => { const limit = Number(event.target.value); if (Number.isFinite(limit) && limit > 0) update({ limit }) }} />
      </label>
      {cap.metric !== 'tokens' && <label className="sa-usage-cap-row">
        <span>Measured against</span>
        <select value={cap.basis} onChange={event => update({ basis: event.target.value as UsageCap['basis'] })}>
          <option value="conversation">What this conversation consumed</option>
          <option value="account">The absolute account level</option>
        </select>
      </label>}
    </>}
    {snapshot?.effective && <p className="sa-detail-hint">In effect: {describeUsageCap(snapshot.effective.setting, report.windows)} ({snapshot.effective.scope} setting).</p>}
    {status && <p className={status.reached ? 'sa-usage-cap-reached' : 'sa-detail-hint'}>{status.reached ? 'Cap reached. ' : ''}{status.detail}</p>}
    {error && <p className="sa-usage-cap-reached">{error}</p>}
  </section>
}

export function StructuredUsageContent({ items, truncated = false, modelLabel, agentSessionId, workspaceId }: {
  items: TimelineItem[]
  truncated?: boolean
  modelLabel?: string
  agentSessionId?: string
  workspaceId?: string
}): React.JSX.Element {
  const usage = summarizeUsage(items)
  const report = useMemo(() => summarizeUsageRun(items), [items])
  const context = summarizeContext(items)
  const providerName = report.provider ? providerNames[report.provider] : undefined
  const name = [providerName, modelLabel ?? report.model, report.effort && report.effort !== 'auto' ? `(${report.effort})` : '']
    .filter(Boolean).join(' ') || 'This conversation'
  const sameRun = report.run && report.run.usageReports === report.conversation.usageReports && report.run.turns === report.conversation.turns

  return <div className="sa-usage-content">
    {(modelLabel || report.model) && <dl><dt>Conversation model</dt><dd>{[providerName, modelLabel ?? report.model].filter(Boolean).join(' · ')}</dd></dl>}
    <HeadlineUsage report={report.conversation} name={name} />
    {context && <section className="sa-context-details"><h4>Context window</h4><p><strong>{Math.floor(context.percent)}% used</strong> &middot; {context.used.toLocaleString()} / {context.capacity.toLocaleString()} usable tokens</p><progress max={100} value={context.percent} aria-label="Context used" /><p className="sa-detail-hint">Latest context snapshot, including cached input. This is separate from cumulative token usage. The usable budget reflects the provider's reserved space.</p>{context.percent >= 90 && <p className="sa-context-guidance">{context.percent >= 100 ? 'Context is full.' : 'Context is nearly full.'} Use <code>/compact</code> to make room before continuing.</p>}</section>}
    <p className="sa-detail-hint">{usage.scope === 'session' ? 'Conversation totals' : usage.scope === 'reported' ? 'Reported turn totals' : 'Latest reported figures'}{usage.estimated ? ' · estimated' : ''}. Updates when the provider reports usage.</p>
    {truncated && usage.scope === 'reported' && <p className="sa-detail-hint">Earlier turns are outside the loaded history; these totals cover the available reports.</p>}
    <ScopeFigures report={report.conversation} label="This conversation" />
    {report.run && !sameRun && <ScopeFigures report={report.run} label="Current provider run" />}
    {usage.contextWindow !== undefined && <dl><dt>Model context window</dt><dd>{usage.contextWindow.toLocaleString()} tokens</dd></dl>}
    {usage.costUsd !== undefined && <dl><dt>{usage.costEstimated ? 'Estimated cost' : 'Reported cost'}{usage.costScope === 'latest' ? ' (latest report)' : ''}</dt><dd>${usage.costUsd.toFixed(4)}</dd></dl>}
    {!report.currentWindows.length && <p className="sa-detail-hint">Account limits have not been reported.</p>}
    {usage.costUsd !== undefined && <p className="sa-detail-hint">Reported cost is not a subscription charge.</p>}
    {report.conversation.tokens?.reasoningTokens !== undefined && <p className="sa-detail-hint">Reasoning is included in output tokens.</p>}
    {agentSessionId && workspaceId && <UsageCapEditor agentSessionId={agentSessionId} workspaceId={workspaceId} report={report.conversation} />}
    {(report.measured.length > 0 || report.derived.length > 0) && <details className="sa-usage-provenance"><summary>Where these numbers come from</summary>
      {report.measured.length > 0 && <><h5>Reported by the provider</h5><ul>{report.measured.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
      {report.derived.length > 0 && <><h5>Computed by Conductor from those reports</h5><ul>{report.derived.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
    </details>}
    {usage.limits && <details><summary>Limit details</summary><pre>{JSON.stringify(usage.limits, null, 2)}</pre></details>}
  </div>
}

export function StructuredUsageDetails({ items }: { items: TimelineItem[] }): React.JSX.Element {
  return <details className="sa-usage-details"><summary>Usage &amp; limits</summary><StructuredUsageContent items={items} /></details>
}
