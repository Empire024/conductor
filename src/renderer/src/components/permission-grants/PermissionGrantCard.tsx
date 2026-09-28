import { useEffect, useState } from 'react'
import { grantHolderLabel, type GrantDecision, type GrantStatus, type PermissionGrant, type PermissionGrantRequest, type PermissionGrantsState } from '../../../../shared/permission-grants'
import './permission-grants.css'

/** The fields a card needs: a denial's request (auto-mode-denial.ts) or an agent's own request. */
export type GrantCardRequest = Pick<PermissionGrantRequest, 'tool' | 'action' | 'resource' | 'class'> & Partial<Pick<PermissionGrantRequest, 'host' | 'category' | 'rule' | 'refusal' | 'reason' | 'rollback' | 'status' | 'holder' | 'source' | 'call' | 'nativeAvailable' | 'execution'>>

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
  ineffective: 'Provider refused after approval',
  moved: 'Moved to the tab that continued this conversation'
}

function statusWords(status: GrantStatus, execution?: PermissionGrantRequest['execution']): string {
  switch (execution?.status) {
    case 'succeeded': return 'Action succeeded'
    case 'failed': return 'Action failed'
    case 'blocked': return 'Provider blocked the call'
    case 'cancelled': return 'Request cancelled'
    case 'unknown': return 'Execution outcome unknown'
    default: return STATUS_WORDS[status]
  }
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
export function PermissionGrantCard({ request, status, grant, busy, error, onDecide, onRevoke, onSwitchToEdit, onInterrupt }: {
  request: GrantCardRequest
  status: GrantStatus
  grant?: PermissionGrant
  busy?: boolean
  error?: string
  onDecide?(decision: GrantDecision): void
  onRevoke?(): void
  onSwitchToEdit?(): void
  /** The approved retry has waited behind a running turn past the waiting notice (H06). */
  onInterrupt?(): void
}): React.JSX.Element {
  const pending = status === 'pending'
  const nativeOnce = pending && request.source === 'native' && request.nativeAvailable === true && Boolean(request.call?.requestId)
  const needsOwner = pending && !(request.source === 'native' && !request.nativeAvailable)
  return <section className={'sa-interaction sa-grant-card' + (needsOwner ? ' needs-attention' : '')} role={needsOwner ? 'alert' : undefined} aria-label={'Permission: ' + request.action} data-grant-status={status} data-grant-class={request.class}>
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
      {request.rule ? <><dt>Rule</dt><dd><code>{request.rule}</code></dd></> : <><dt>No rule</dt><dd>{request.refusal ?? 'No narrow rule can cover this call.'}{nativeOnce && ' The exact provider request is still pending and can be allowed once.'}</dd></>}
      {request.execution && <><dt>Execution</dt><dd>{request.execution.status}{request.execution.detail ? `: ${request.execution.detail}` : ''}</dd></>}
    </dl>
    {pending && request.rule && <p className="sa-muted">Approving hands this one conversation exactly this rule and tells it to retry the call. Nothing else is allowed, and the grant ends with this tab.</p>}
    {pending && request.source === 'native' && !request.nativeAvailable && <p className="sa-muted">Waiting for this exact provider request to be confirmed again. It cannot be answered from an old card.</p>}
    {pending && onDecide && <div className="sa-interaction-actions">
      {request.rule && <button type="button" className="sa-grant-once" disabled={busy} onClick={() => onDecide('approve-once')}>Approve once</button>}
      {nativeOnce && <button type="button" className="sa-grant-once" disabled={busy} onClick={() => onDecide('approve-once')}>Allow this provider request once</button>}
      {request.rule && <button type="button" className="sa-grant-session" disabled={busy} onClick={() => onDecide('approve-session')}>Approve for this session</button>}
      <button type="button" className="sa-grant-deny" disabled={busy} onClick={() => onDecide('deny')}>Deny</button>
      {!request.rule && !nativeOnce && onSwitchToEdit && <button type="button" className="sa-auto-denial-switch" disabled={busy} onClick={onSwitchToEdit}>Switch to Edit mode</button>}
    </div>}
    {!pending && <p className="sa-grant-status">{statusWords(status, request.execution)}{grant ? ` · ${grant.delivery === 'live' ? 'in force now' : grant.delivery === 'restart' ? 'applies when the conversation restarts' : 'applies when the conversation starts'}` : ''}
      {grant && onRevoke && <button type="button" className="sa-grant-revoke" disabled={busy} onClick={onRevoke}>Revoke</button>}</p>}
    {!pending && onInterrupt && <div className="sa-interaction-actions sa-grant-waiting">
      <span className="sa-muted">The retry is queued behind a turn that is still running.</span>
      <button type="button" className="sa-grant-interrupt" disabled={busy} onClick={onInterrupt} title="Stops the running turn; the queued retry then runs at once">Interrupt and retry</button>
    </div>}
    {error && <p className="sa-error" role="alert">{error}</p>}
  </section>
}

/** What a card in the history shows: the main process's request if it holds one; else the answer
 *  given before the app restarted (settled); else an agent's request it no longer holds ended with
 *  its tab, so the card stops asking rather than offering buttons nothing answers. `loaded`: the
 *  main process's state has arrived at least once. */
export function liveGrantStatus(state: PermissionGrantsState, agentSessionId: string, requestId: string, recorded: GrantStatus = 'pending', loaded = true): GrantStatus {
  const known = state.requests.find(entry => entry.agentSessionId === agentSessionId && entry.id === requestId)
  const answered = state.settled?.find(entry => entry.agentSessionId === agentSessionId && entry.id === requestId)?.status
  return known?.status ?? answered ?? (loaded && recorded === 'pending' && requestId.startsWith('grant:') ? 'expired' : recorded)
}

/** Whether the card offers its answers. The pane allows answers only on the current runtime's
 *  items (interactive), but a grant is answered by the main process, not the runtime: a request it
 *  holds pending for this conversation stays answerable on a card drawn before the CLI restarted
 *  (an app restart, an idle CLI given back and reconnected). */
export function grantAnswerable(state: PermissionGrantsState, agentSessionId: string, requestId: string, interactive: boolean): boolean {
  return interactive || state.requests.some(entry => entry.agentSessionId === agentSessionId && entry.id === requestId && entry.status === 'pending')
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
  const status = liveGrantStatus(state, agentSessionId, requestId, request.status, loaded)
  const answerable = grantAnswerable(state, agentSessionId, requestId, interactive)
  const grant = state.grants.find(entry => entry.agentSessionId === agentSessionId && entry.requestId === requestId)
  const currentRequest = state.requests.find(entry => entry.agentSessionId === agentSessionId && entry.id === requestId)
  const act = (work: () => Promise<unknown>): void => {
    setBusy(true); setError(undefined)
    void work().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }
  const bridge = window.conductor?.permissionGrants
  return <PermissionGrantCard request={currentRequest ?? request} status={status} grant={grant} busy={busy} error={error}
    onDecide={answerable && bridge && !(currentRequest?.source === 'native' && !currentRequest.nativeAvailable) ? decision => act(() => bridge.decide(agentSessionId, requestId, decision)) : undefined}
    onRevoke={grant && bridge ? () => act(() => bridge.revoke(agentSessionId, grant.id)) : undefined}
    onSwitchToEdit={interactive ? onSwitchToEdit : undefined}
    onInterrupt={grant && bridge && retryWaiting(state, grant) ? () => act(() => bridge.interrupt(agentSessionId, grant.id)) : undefined} />
}

/** Whether this grant's approved retry waits behind a running turn past the waiting notice, so the
 *  card offers "Interrupt and retry". */
export function retryWaiting(state: PermissionGrantsState, grant: Pick<PermissionGrant, 'agentSessionId' | 'id'>): boolean {
  return Boolean(state.waiting?.some(entry => entry.agentSessionId === grant.agentSessionId && entry.grantIds.includes(grant.id)))
}
