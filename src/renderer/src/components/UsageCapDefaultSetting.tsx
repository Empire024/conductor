import { useCallback, useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import type { UsageCap, UsageCapMetric, UsageCapSetting } from '../../../shared/usage-accounting'
import { describeUsageCap, parseUsageCapSetting } from '../../../shared/usage-accounting'
import './UsageCapDefaultSetting.css'

const metrics: Array<{ id: UsageCapMetric; label: string }> = [
  { id: 'weekly-percent', label: 'Weekly allowance' },
  { id: 'short-window-percent', label: 'Short rolling window' },
  { id: 'tokens', label: 'Tokens per conversation' }
]

/**
 * The account-wide fallback cap. A workspace or a single conversation can override it,
 * including opting out entirely, from that conversation's Usage & limits panel.
 */
export function UsageCapDefaultSetting(): React.JSX.Element {
  const [cap, setCap] = useState<UsageCap | null>(null)
  const [error, setError] = useState<string>()
  // This setting is not tied to any conversation, so only the default slot is requested.
  const read = useCallback(() => {
    window.conductor.usageCaps.read()
      .then(snapshot => setCap(snapshot.default && snapshot.default.metric !== 'none' ? snapshot.default : null))
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])
  useEffect(read, [read])

  const save = (setting: UsageCapSetting | null): void => {
    setError(undefined)
    window.conductor.usageCaps.write('default', null, setting)
      .then(read)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const update = (change: Partial<UsageCap>): void => {
    const next = parseUsageCapSetting({ metric: 'weekly-percent', limit: 25, basis: 'conversation', ...cap, ...change })
    if (next) save(next)
  }

  return <section>
    <div className="settings-section-title"><Gauge size={14} /><div><strong>Usage cap</strong><span>Stop a conversation once the provider reports it crossed your limit.</span></div></div>
    <label className="usage-cap-setting">
      <span><strong>Default cap</strong><small>{cap ? describeUsageCap(cap) : 'Conversations run until the provider stops them'}</small></span>
      <select value={cap?.metric ?? 'none'} onChange={event => {
        const value = event.target.value
        if (value === 'none') save(null)
        else update({ metric: value as UsageCapMetric, ...(value === 'tokens' ? { limit: 200_000, basis: 'conversation' as const } : { limit: 25 }) })
      }}>
        <option value="none">No cap</option>
        {metrics.map(metric => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
      </select>
    </label>
    {cap && <>
      <label className="usage-cap-setting">
        <span><strong>{cap.metric === 'tokens' ? 'Token budget' : cap.basis === 'account' ? 'Account level' : 'Points consumed'}</strong><small>{cap.metric === 'tokens' ? 'Total reported tokens in one conversation' : 'Percentage points of the reported allowance window'}</small></span>
        <input type="number" min={1} max={cap.metric === 'tokens' ? undefined : 100} step={cap.metric === 'tokens' ? 1000 : 1} value={cap.limit}
          onChange={event => { const limit = Number(event.target.value); if (Number.isFinite(limit) && limit > 0) update({ limit }) }} />
      </label>
      {cap.metric !== 'tokens' && <label className="usage-cap-setting">
        <span><strong>Measured against</strong><small>A share is the account-wide movement while a conversation is open, which bounds its own use from above</small></span>
        <select value={cap.basis} onChange={event => update({ basis: event.target.value as UsageCap['basis'] })}>
          <option value="conversation">What a conversation consumed</option>
          <option value="account">The absolute account level</option>
        </select>
      </label>}
    </>}
    <p>A cap is separate from limit continuation: continuation resumes work when the provider's own window reopens, while a cap you set stays stopped until you change it.</p>
    {error && <p className="usage-cap-error">{error}</p>}
  </section>
}
