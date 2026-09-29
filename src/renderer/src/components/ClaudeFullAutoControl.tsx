import { useEffect, useRef, useState } from 'react'
import { CLAUDE_FULL_AUTO_ACTION, CLAUDE_FULL_AUTO_EXPLANATION, type ClaudeFullAutoState, type ClaudeFullAutoTab } from '../../../shared/claude-full-auto'
import './ClaudeFullAutoControl.css'

const DISABLE_ACTION = 'Disable Full Auto for Claude workers'

/** "29 Sep 2026, 08:12 (3 h ago)" — the owner reads when the policy last changed at a glance. */
export function fullAutoSince(iso: string | undefined, now = Date.now()): string | undefined {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at)) return undefined
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`
  return `${new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${ago})`
}

export function ClaudeFullAutoControl(): React.JSX.Element {
  const [state, setState] = useState<ClaudeFullAutoState>()
  const [tabs, setTabs] = useState<ClaudeFullAutoTab[]>()
  const [error, setError] = useState('')
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    let alive = true
    void window.conductor.claudeFullAuto.state().then(value => { if (alive) setState(value) }).catch(reason => { if (alive) setError(String(reason)) })
    const unsubscribe = window.conductor.claudeFullAuto.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; unsubscribe() }
  }, [])
  const enabled = state?.enabled === true
  useEffect(() => {
    if (!enabled) { setTabs(undefined); return }
    let alive = true
    // Read-only listing, refreshed only while the card is actually on screen (a collapsed
    // conversation disclosure or a hidden window does not poll).
    const refresh = (): void => {
      if (document.hidden || !root.current?.offsetParent) return
      void window.conductor.claudeFullAuto.tabs().then(value => { if (alive) setTabs(value) }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [enabled, state?.applying])
  const since = fullAutoSince(enabled ? state?.authorizedAt : state?.changedAt)
  const status = !state ? 'Loading…' : state.applying ? 'Applying…' : enabled ? 'On' : 'Off'
  return <section ref={root} className="sa-full-auto-control" data-state={!state ? 'loading' : state.applying ? 'applying' : enabled ? 'on' : 'off'} aria-label="Claude Full Auto authorization">
    <div className="sa-full-auto-head">
      <span className="sa-full-auto-dot" aria-hidden="true" />
      <div className="sa-full-auto-title">
        <strong>Claude Full Auto <span className="sa-full-auto-badge">{status}</span></strong>
        <small>{enabled ? `Authorized ${since ? `since ${since}` : ''}`.trim() : `Claude Auto uses Guarded Auto${since ? ` · off since ${since}` : ''}`}</small>
      </div>
      <button type="button" className={enabled ? 'sa-full-auto-disable' : 'primary'} aria-label={enabled ? DISABLE_ACTION : CLAUDE_FULL_AUTO_ACTION} aria-pressed={enabled} disabled={!state || state.applying} onClick={event => {
        // Synthetic DOM events (including replayed notifications) cannot authorize this action.
        if (!event.isTrusted || !state) return
        setError('')
        void window.conductor.claudeFullAuto.setEnabled(!state.enabled).then(setState).catch(reason => setError(String(reason)))
      }}>{enabled ? 'Disable' : 'Enable Full Auto'}</button>
    </div>
    {enabled && <div className="sa-full-auto-tabs">
      <span>Tabs on Full Auto now{tabs ? ` (${tabs.length})` : ''}</span>
      {tabs?.length
        ? <ul>{tabs.map(tab => <li key={tab.agentSessionId} title={tab.agentSessionId}>{tab.title || 'Untitled conversation'}{tab.runtime === 'cli' && <small>CLI</small>}</li>)}</ul>
        : <small>{tabs ? 'No live Claude tab has confirmed bypassPermissions yet. Idle or busy tabs switch at their next safe checkpoint.' : 'Checking live Claude tabs…'}</small>}
    </div>}
    {state?.applying && <p role="status">Applying the owner policy to eligible Claude runtimes…</p>}
    {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    <details className="sa-full-auto-explain">
      <summary>What Full Auto allows</summary>
      <p>{CLAUDE_FULL_AUTO_EXPLANATION}</p>
      <p>Each conversation shows its confirmed runtime mode; busy sessions may be awaiting a safe resume.</p>
    </details>
  </section>
}
