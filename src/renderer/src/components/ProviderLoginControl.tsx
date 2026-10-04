import { useEffect, useState } from 'react'
import type { LoginFlowView, LoginMode, LoginProvider, ProviderLoginState } from '../../../shared/claude-login'
import './ProviderLoginControl.css'

const RUNNING = new Set(['starting', 'awaiting-code', 'awaiting-device', 'verifying'])
const when = (iso: string | null | undefined): string => {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

/** What the token line says: which login new Claude processes get. */
export function tokenSummary(state: ProviderLoginState | undefined): { label: string; detail: string } {
  if (!state) return { label: 'Loading…', detail: '' }
  const token = state.token
  if (token.environmentOverride) return { label: 'Token from the environment', detail: 'CLAUDE_CODE_OAUTH_TOKEN is set for Conductor itself; it is used as is.' }
  if (!token.set) return { label: 'Normal login', detail: 'Claude tabs use the CLI login, which refreshes itself every few hours.' }
  if (!token.active) return { label: 'Token rejected', detail: `Refused ${when(token.rejectedAt)}${token.rejectedReason ? `: ${token.rejectedReason}` : ''}. New tabs use the normal login.` }
  return { label: 'Long-lived token', detail: `Set ${when(token.createdAt)}${token.expiresAt ? `, valid until ${when(token.expiresAt)}` : ''}. New Claude processes use it; it never refreshes.` }
}

export function ProviderLoginControl(): React.JSX.Element {
  const [state, setState] = useState<ProviderLoginState>()
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  useEffect(() => {
    let alive = true
    void window.conductor.providerLogin.state().then(value => { if (alive) setState(value) }).catch(reason => { if (alive) setError(String(reason)) })
    const unsubscribe = window.conductor.providerLogin.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; unsubscribe() }
  }, [])
  const flow: LoginFlowView | null = state?.flow ?? null
  const running = Boolean(flow && RUNNING.has(flow.phase))
  const act = (work: Promise<unknown>): void => { setError(''); void work.then(() => window.conductor.providerLogin.state()).then(value => setState(value as ProviderLoginState)).catch(reason => setError(String(reason instanceof Error ? reason.message : reason))) }
  const start = (provider: LoginProvider, mode: LoginMode) => (event: React.MouseEvent): void => { if (event.isTrusted) act(window.conductor.providerLogin.start({ provider, mode })) }
  const summary = tokenSummary(state)
  const outage = state?.outages ?? []
  return <section className="provider-login" aria-label="Provider login">
    <div className="settings-section-title"><div><strong>Claude login</strong><span>{summary.label}</span></div></div>
    <p className="provider-login-detail">{summary.detail}</p>
    {outage.map(entry => <p key={entry.provider} role="alert" className="provider-login-outage">{entry.provider === 'claude' ? 'Claude' : 'Codex'} lost its login at {when(entry.since)}; {entry.tabs} tab{entry.tabs === 1 ? '' : 's'} wait for it.</p>)}
    <div className="provider-login-actions">
      <button type="button" className="primary" disabled={running || !state?.token.storageAvailable} onClick={start('claude', 'setup-token')} title="Runs claude setup-token: sign in once, Conductor keeps a 1-year token that never refreshes">{state?.token.set ? 'Replace long-lived token' : 'Set up long-lived token'}</button>
      {state?.token.set && <button type="button" disabled={running} onClick={event => { if (event.isTrusted) act(window.conductor.providerLogin.removeToken()) }}>Remove token</button>}
      <button type="button" disabled={running} onClick={start('claude', 'login')}>Log in to Claude</button>
      <button type="button" disabled={running} onClick={start('codex', 'device')}>Log in to Codex</button>
    </div>
    {flow && <div className="provider-login-flow" data-phase={flow.phase}>
      <strong>{flow.provider === 'claude' ? (flow.mode === 'setup-token' ? 'Long-lived token' : 'Claude login') : 'Codex login'}{flow.origin === 'phone' ? ' (started on the phone)' : ''}</strong>
      {flow.message && <p role="status">{flow.message}</p>}
      {flow.url && running && <p><button type="button" className="link" onClick={() => void window.conductor.system.openExternal(flow.url!)}>Open the sign-in page</button></p>}
      {flow.userCode && running && <p>Code: <code className="provider-login-code">{flow.userCode}</code></p>}
      {flow.phase === 'awaiting-code' && !flow.codeUsed && <form onSubmit={event => { event.preventDefault(); const value = code; setCode(''); act(window.conductor.providerLogin.submitCode({ id: flow.id, code: value })) }}>
        <input aria-label="Code from the sign-in page" autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} placeholder="Paste the code the page shows" />
        <button type="submit" className="primary" disabled={!code.trim()}>Continue</button>
      </form>}
      {running && <button type="button" onClick={() => act(window.conductor.providerLogin.cancel(flow.id))}>Cancel</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <details className="provider-login-explain">
      <summary>About the long-lived token</summary>
      <p>The normal Claude login renews itself every 8 hours; when two copies of it renew separately the account can end up logged out. A long-lived token (claude setup-token, 1 year) never renews. Conductor keeps it encrypted with the OS credential store and hands it to every Claude process it starts; it is never shown, logged or sent to the phone.</p>
      <p>A token is limited to model use: claude.ai connectors and cloud sessions still need the normal login, and cloud runs keep using it. Tabs already running keep the login they started with until their CLI restarts. If the token is ever refused, Conductor stops using it, falls back to the normal login and tells you.</p>
    </details>
  </section>
}
