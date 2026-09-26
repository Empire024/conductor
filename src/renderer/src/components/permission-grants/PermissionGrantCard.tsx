import { useEffect, useState } from 'react'
import { grantHolderLabel, type GrantDecision, type GrantStatus, type PermissionGrant, type PermissionGrantRequest, type PermissionGrantsState } from '../../../../shared/permission-grants'
import './permission-grants.css'

/** The fields a card needs: a denial's request (auto-mode-denial.ts) or an agent's own request. */
export type GrantCardRequest = Pick<PermissionGrantRequest, 'tool' | 'action' | 'resource' | 'class'> & Partial<Pick<PermissionGrantRequest, 'host' | 'category' | 'rule' | 'refusal' | 'reason' | 'rollback' | 'status' | 'holder'>>

const CLASS_WORDS: Record<PermissionGrantRequest['class'], string> = {
  local: 'Local: this machine, reversible',
  shared: 'Shared: something other people or programs depend on',
  destructive: 'Destructive: deletes or overwrites',
  external: 'External: reaches another machine or service'
}
const STATUS_WORDS: Record<GrantStatus, string> = {
  pending: 'Waiting for you',
  'approved-once': 'Approved once',
  'approved-session': 'Approved for this session',
  denied: 'Denied',
  used: 'Approved once, and used',
  revoked: 'Revoked',
  expired: 'Expired',
  ineffective: 'Approved, but the classifier still refused it',
  moved: 'Moved to the tab that continued this conversation'
}

let cached: PermissionGrantsState = { requests: [], grants: [] }
const listeners = new Set<(state: PermissionGrantsState) => void>()
let subscribed = false
/** Whether the main process's state has arrived at least once, so a missing request means gone. */
let loaded = false
function subscribe(listener: (state: PermissionGrantsState) => void): () => void {
  listeners.add(listener)
  const bridge = typeof window !== 'undefined' ? window.conductor?.permissionGrants : undefined
  if (bridge && !subscribed) {
    subscribed = true
    bridge.onChanged(state => { cached = state; loaded = true; for (const entry of listeners) entry(state) })
    void bridge.state().then(state => { cached = state; loaded = true; for (const entry of listeners) entry(state) }).catch(() => undefined)
  }
  return () => { listeners.delete(listener) }
}

/** Every open request and live grant, kept current from the main process. */
export function usePermissionGrants(): PermissionGrantsState {
  const [state, setState] = useState(cached)
  useEffect(() => subscribe(setState), [])
  return state
}

/**
 * One narrow approval for one refused (or about to be refused) call: exactly what, exactly where,
 * what kind of resource, and the single rule approving hands this conversation. Kept free of
 * pane imports; the actions are props so it renders in a plain unit test.
 */
export function PermissionGrantCard({ request, status, grant, busy, error, onDecide, onRevoke, onSwitchToEdit }: {
  request: GrantCardRequest
  status: GrantStatus
  grant?: PermissionGrant
  busy?: boolean
  error?: string
  onDecide?(decision: GrantDecision): void
  onRevoke?(): void
  onSwitchToEdit?(): void
}): React.JSX.Element {
  const pending = status === 'pending'
  return <section className={'sa-interaction sa-grant-card' + (pending ? ' needs-attention' : '')} role={pending ? 'alert' : undefined} aria-label={'Permission: ' + request.action} data-grant-status={status} data-grant-class={request.class}>
    <header className="sa-grant-header">
      <strong>{request.category ? `Auto mode refused ${request.tool}` : `Permission requested: ${request.action}`}</strong>
      {request.category && <span className="sa-auto-denial-reason">{request.category}</span>}
      <span className={'sa-grant-class sa-grant-class-' + request.class}>{CLASS_WORDS[request.class]}</span>
    </header>
    <dl className="sa-grant-fields">
      <dt>Action</dt><dd>{request.action} ({request.tool})</dd>
      <dt>Resource</dt><dd><code>{request.resource}</code></dd>
      {request.host && <><dt>Host</dt><dd><code>{request.host}</code></dd></>}
      {request.reason && <><dt>Why</dt><dd>{request.reason}</dd></>}
      {request.rollback && <><dt>Rollback</dt><dd>{request.rollback}</dd></>}
      {request.holder && <><dt>{status === 'moved' ? 'Moved to' : 'Holder'}</dt><dd title={request.holder.agentSessionId}>{grantHolderLabel(request.holder)}</dd></>}
      {request.rule ? <><dt>Rule</dt><dd><code>{request.rule}</code></dd></> : <><dt>No rule</dt><dd>{request.refusal ?? 'No narrow rule can cover this call.'}</dd></>}
    </dl>
    {pending && request.rule && <p className="sa-muted">Approving hands this one conversation exactly this rule and tells it to retry the call. Nothing else is allowed, and the grant ends with this tab.</p>}
    {pending && onDecide && <div className="sa-interaction-actions">
      {request.rule && <button type="button" className="sa-grant-once" disabled={busy} onClick={() => onDecide('approve-once')}>Approve once</button>}
      {request.rule && <button type="button" className="sa-grant-session" disabled={busy} onClick={() => onDecide('approve-session')}>Approve for this session</button>}
      <button type="button" className="sa-grant-deny" disabled={busy} onClick={() => onDecide('deny')}>Deny</button>
      {!request.rule && onSwitchToEdit && <button type="button" className="sa-auto-denial-switch" disabled={busy} onClick={onSwitchToEdit}>Switch to Edit mode</button>}
    </div>}
    {!pending && <p className="sa-grant-status">{STATUS_WORDS[status]}{grant ? ` · ${grant.delivery === 'live' ? 'in force now' : grant.delivery === 'restart' ? 'applies when the conversation restarts' : 'applies when the conversation starts'}` : ''}
      {grant && onRevoke && <button type="button" className="sa-grant-revoke" disabled={busy} onClick={onRevoke}>Revoke</button>}</p>}
    {error && <p className="sa-error" role="alert">{error}</p>}
  </section>
}

/** The card wired to the main process for one conversation's request. */
export function LivePermissionGrantCard({ agentSessionId, requestId, request, interactive, onSwitchToEdit }: {
  agentSessionId: string
  requestId: string
  request: GrantCardRequest
  interactive: boolean
  onSwitchToEdit?(): void
}): React.JSX.Element {
  const state = usePermissionGrants()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const known = state.requests.find(entry => entry.agentSessionId === agentSessionId && entry.id === requestId)
  // An agent's request the main process no longer holds ended with its tab or this app: the card
  // in the history stops asking rather than offering buttons nothing answers.
  const recorded = request.status ?? 'pending'
  const status = known?.status ?? (loaded && recorded === 'pending' && requestId.startsWith('grant:') ? 'expired' : recorded)
  const grant = state.grants.find(entry => entry.agentSessionId === agentSessionId && entry.requestId === requestId)
  const act = (work: () => Promise<unknown>): void => {
    setBusy(true); setError(undefined)
    void work().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }
  const bridge = window.conductor?.permissionGrants
  return <PermissionGrantCard request={request} status={status} grant={grant} busy={busy} error={error}
    onDecide={interactive && bridge ? decision => act(() => bridge.decide(agentSessionId, requestId, decision)) : undefined}
    onRevoke={grant && bridge ? () => act(() => bridge.revoke(agentSessionId, grant.id)) : undefined}
    onSwitchToEdit={interactive ? onSwitchToEdit : undefined} />
}
