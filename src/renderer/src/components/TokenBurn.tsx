import { useEffect, useState, useSyncExternalStore } from 'react'
import { Flame } from 'lucide-react'
import { formatBurn, TOKEN_BURN_ALERT_CHOICES, type TokenBurnRate, type TokenBurnSnapshot } from '../../../shared/token-burn'
import './UsageCapDefaultSetting.css'
import './TokenBurn.css'

/**
 * The per-tab token burn meter (src/main/token-burn.ts, feature-list codex-credit-burn 2). One
 * subscription per window feeds every tab badge; a tab crossing the owner's rate also raises a
 * toast once, so a relay tab spending millions an hour is seen the hour it happens.
 */
let current: TokenBurnSnapshot | null = null
let byId = new Map<string, TokenBurnRate>()
const listeners = new Set<() => void>()
let started = false
let alerting = new Set<string>()

const accept = (snapshot: TokenBurnSnapshot): void => {
  current = snapshot
  byId = new Map(snapshot.rates.map(rate => [rate.agentSessionId, rate]))
  const now = new Set(snapshot.rates.filter(rate => rate.alert).map(rate => rate.agentSessionId))
  for (const rate of snapshot.rates) {
    if (rate.alert && !alerting.has(rate.agentSessionId)) window.dispatchEvent(new CustomEvent('conductor:toast', { detail: `“${rate.title}” is burning ${formatBurn(rate.tokensPerHour)} tokens (alert at ${formatBurn(snapshot.alertPerHour)})` }))
  }
  alerting = now
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  if (!started && window.conductor?.tokenBurn) {
    started = true
    window.conductor.tokenBurn.onChanged(accept)
    void window.conductor.tokenBurn.snapshot().then(accept).catch(() => undefined)
  }
  return () => { listeners.delete(listener) }
}

export function useTokenBurn(): TokenBurnSnapshot | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}
export function useTokenBurnRate(agentSessionId: string | undefined): TokenBurnRate | undefined {
  return useSyncExternalStore(subscribe, () => agentSessionId ? byId.get(agentSessionId) : undefined, () => undefined)
}

/** Shown on a tab only while it burns faster than the owner's alert rate. */
export function TokenBurnBadge({ agentSessionId }: { agentSessionId?: string }): React.JSX.Element | null {
  const rate = useTokenBurnRate(agentSessionId)
  if (!rate?.alert) return null
  return <span className="pane-tab-burn" data-token-burn={rate.tokensPerHour} title={`Burning ${formatBurn(rate.tokensPerHour)} over the last hour: ${rate.inputPerHour.toLocaleString()} input (${rate.cachedPerHour.toLocaleString()} cached), ${rate.outputPerHour.toLocaleString()} output, ${rate.reports} calls`} aria-label={`token burn ${formatBurn(rate.tokensPerHour)}`}>
    <Flame size={11} />{formatBurn(rate.tokensPerHour)}
  </span>
}

const label = (value: number): string => value === 0 ? 'Off' : `${formatBurn(value).replace('/h', '')} tokens/hour`

/** Settings: the alert rate, and the meter itself - every live tab's last hour, highest first. */
export function TokenBurnSetting(): React.JSX.Element {
  const snapshot = useTokenBurn()
  const [alert, setAlert] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => { window.conductor.tokenBurn.alertPerHour().then(setAlert).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }, [])
  const save = (value: number): void => {
    setError(undefined); setAlert(value)
    window.conductor.tokenBurn.setAlertPerHour(value).then(setAlert).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const rates = snapshot?.rates ?? []
  return <section className="token-burn-setting">
    <div className="settings-section-title"><Flame size={14} /><div><strong>Token burn</strong><span>Tokens each live tab used in the last hour, input with cache reads plus output.</span></div></div>
    <label className="usage-cap-setting">
      <span><strong>Alert when a tab burns more than</strong><small>{alert === 0 ? 'No tab is marked, however fast it spends' : 'The tab gets a flame with its rate, and a notice appears once when it crosses'}</small></span>
      <select aria-label="Token burn alert" value={alert ?? 5_000_000} disabled={alert === null} onChange={event => save(Number(event.target.value))}>
        {TOKEN_BURN_ALERT_CHOICES.map(value => <option key={value} value={value}>{label(value)}</option>)}
      </select>
    </label>
    {error && <p className="usage-cap-error">{error}</p>}
    <ul className="token-burn-list" aria-label="Token burn by tab">
      {rates.length === 0 && <li className="token-burn-empty">No live tab reported usage in the last hour.</li>}
      {rates.slice(0, 12).map(rate => <li key={rate.agentSessionId} className={rate.alert ? 'alert' : ''} data-agent-session-id={rate.agentSessionId}>
        <span className="token-burn-title" title={rate.title}>{rate.title}</span>
        <span className="token-burn-provider">{rate.provider}</span>
        <span className="token-burn-rate">{formatBurn(rate.tokensPerHour)}</span>
      </li>)}
    </ul>
  </section>
}
