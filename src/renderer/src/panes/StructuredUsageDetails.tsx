import type { Json, TimelineItem } from '../../../shared/structured-agent'
import { summarizeContext, summarizeUsage } from './usage-summary'

function object(value: Json | undefined): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function StructuredUsageContent({ items, truncated = false, modelLabel }: { items: TimelineItem[]; truncated?: boolean; modelLabel?: string }): React.JSX.Element {
  const usage = summarizeUsage(items)
  const tokens = usage.tokens
  const context = summarizeContext(items)
  const rateLimits = object(object(usage.limits).rateLimits)
  const windows = ['primary', 'secondary'].flatMap(key => {
    const limit = object(rateLimits[key])
    if (typeof limit.usedPercent !== 'number' || !Number.isFinite(limit.usedPercent)) return []
    const minutes = limit.windowDurationMins
    const label = minutes === 10080 ? 'Weekly' : minutes === 1440 ? 'Daily' : typeof minutes === 'number' ? `${minutes / 60} hour` : 'Usage window'
    const reset = typeof limit.resetsAt === 'number' ? new Date(limit.resetsAt * 1000) : undefined
    return [{ label, used: limit.usedPercent, reset: reset && !Number.isNaN(reset.getTime()) ? reset.toLocaleString() : undefined }]
  })
  return <div className="sa-usage-content">
    {modelLabel && <dl><dt>Conversation model</dt><dd>{modelLabel}</dd></dl>}
    {context && <section className="sa-context-details"><h4>Context window</h4><p><strong>{Math.floor(context.percent)}% used</strong> &middot; {context.used.toLocaleString()} / {context.capacity.toLocaleString()} usable tokens</p><progress max={100} value={context.percent} aria-label="Context used" /><p className="sa-detail-hint">Latest context snapshot, including cached input. This is separate from cumulative token usage. The usable budget reflects the provider's reserved space.</p>{context.percent >= 90 && <p className="sa-context-guidance">{context.percent >= 100 ? 'Context is full.' : 'Context is nearly full.'} Use <code>/compact</code> to make room before continuing.</p>}</section>}
    <p className="sa-detail-hint">{usage.scope === 'session' ? 'Conversation totals' : usage.scope === 'reported' ? 'Reported turn totals' : 'Latest reported figures'}{usage.estimated ? ' · estimated' : ''}. Updates when the provider reports usage.</p>
    {truncated && usage.scope === 'reported' && <p className="sa-detail-hint">Earlier turns are outside the loaded history; these totals cover the available reports.</p>}
    {tokens ? <dl>
      {tokens.totalTokens !== undefined && <><dt>Total tokens</dt><dd>{tokens.totalTokens.toLocaleString()}</dd></>}
      {tokens.inputTokens !== undefined && <><dt>Input tokens</dt><dd>{tokens.inputTokens.toLocaleString()}</dd></>}
      {tokens.outputTokens !== undefined && <><dt>Output tokens</dt><dd>{tokens.outputTokens.toLocaleString()}</dd></>}
      {tokens.reasoningTokens !== undefined && <><dt>Reasoning tokens</dt><dd>{tokens.reasoningTokens.toLocaleString()}</dd></>}
      {tokens.cachedTokens !== undefined && <><dt>Cached input tokens</dt><dd>{tokens.cachedTokens.toLocaleString()}</dd></>}
      {tokens.cacheCreationTokens !== undefined && <><dt>Cache creation tokens</dt><dd>{tokens.cacheCreationTokens.toLocaleString()}</dd></>}
    </dl> : <p className="sa-detail-hint">Token usage has not been reported.</p>}
    {tokens?.reasoningTokens !== undefined && <p className="sa-detail-hint">Reasoning is included in output tokens.</p>}
    {usage.contextWindow !== undefined && <dl><dt>Model context window</dt><dd>{usage.contextWindow.toLocaleString()} tokens</dd></dl>}
    {usage.costUsd !== undefined && <dl><dt>{usage.costEstimated ? 'Estimated cost' : 'Reported cost'}{usage.costScope === 'latest' ? ' (latest report)' : ''}</dt><dd>${usage.costUsd.toFixed(4)}</dd></dl>}
    {windows.map((window, index) => <div className="sa-limit-detail" key={index}><span>{window.label}</span><strong>{window.used}% used</strong><progress max={100} value={Math.max(0, Math.min(100, window.used))} aria-label={`${window.label} usage`} />{window.reset && <small>Resets {window.reset}</small>}</div>)}
    {!windows.length && <p className="sa-detail-hint">Account limits have not been reported.</p>}
    {usage.costUsd !== undefined && <p className="sa-detail-hint">Reported cost is not a subscription charge.</p>}
    {usage.limits && <details><summary>Limit details</summary><pre>{JSON.stringify(usage.limits, null, 2)}</pre></details>}
  </div>
}

export function StructuredUsageDetails({ items }: { items: TimelineItem[] }): React.JSX.Element {
  return <details className="sa-usage-details"><summary>Usage &amp; limits</summary><StructuredUsageContent items={items} /></details>
}
