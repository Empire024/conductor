import type { Json, TimelineItem } from '../../../shared/structured-agent'

function object(value: Json | undefined): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export function StructuredUsageDetails({ items }: { items: TimelineItem[] }): React.JSX.Element {
  const usage = items.flatMap(item => item.data.type === 'usage' ? [item.data] : [])
  const latest = [...usage].reverse()
  const tokens = latest.find(value => value.inputTokens !== undefined || value.outputTokens !== undefined)
  const cost = latest.find(value => value.costUsd !== undefined)
  const limits = latest.find(value => object(value.limits).rateLimits !== undefined)?.limits
  const rateLimits = object(object(limits).rateLimits)
  const windows = ['primary', 'secondary'].flatMap(key => {
    const limit = object(rateLimits[key])
    if (typeof limit.usedPercent !== 'number') return []
    const minutes = limit.windowDurationMins
    const label = minutes === 10080 ? 'Weekly' : minutes === 1440 ? 'Daily' : typeof minutes === 'number' ? `${minutes / 60} hour` : 'Usage window'
    return [{ label, used: limit.usedPercent, reset: typeof limit.resetsAt === 'number' ? new Date(limit.resetsAt * 1000).toLocaleString() : undefined }]
  })
  return <details className="sa-usage-details"><summary>Usage & limits</summary>
    <p className="sa-detail-hint">Latest reported figures{tokens?.source === 'estimate' ? ' · estimated' : ''}.</p>
    {tokens ? <dl>{tokens.inputTokens !== undefined && <><dt>Input tokens</dt><dd>{tokens.inputTokens.toLocaleString()}</dd></>}{tokens.outputTokens !== undefined && <><dt>Output tokens</dt><dd>{tokens.outputTokens.toLocaleString()}</dd></>}{tokens.cachedTokens !== undefined && <><dt>Cached tokens</dt><dd>{tokens.cachedTokens.toLocaleString()}</dd></>}</dl> : <p className="sa-detail-hint">Token usage has not been reported.</p>}
    {cost?.costUsd !== undefined && <dl><dt>{cost.source === 'estimate' ? 'Estimated cost' : 'Reported cost'}</dt><dd>${cost.costUsd.toFixed(4)}</dd></dl>}
    {windows.map((window, index) => <div className="sa-limit-detail" key={index}><span>{window.label}</span><strong>{window.used}% used</strong>{window.reset && <small>Resets {window.reset}</small>}</div>)}
    {!windows.length && <p className="sa-detail-hint">Account limits have not been reported.</p>}
    {cost?.costUsd !== undefined && <p className="sa-detail-hint">Reported cost is not a subscription charge.</p>}
    {limits && <details><summary>Limit details</summary><pre>{JSON.stringify(limits, null, 2)}</pre></details>}
  </details>
}
