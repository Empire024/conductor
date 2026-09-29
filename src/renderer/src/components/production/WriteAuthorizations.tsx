import { useState } from 'react'
import { MUTATION_KINDS, type MutationKind, type ProductionEnvironment, type SandboxWriteAuthorization, type WriteAuthorizationRequest } from '../../../../shared/production'
import { formatTime, validateWrites, type WritesDraft } from './production-model'

/**
 * Sandbox write authorizations: each names a non-production environment, the mutation kinds a
 * check may perform there and an expiry. Without one every journey stops before its first
 * mutation; production is never offered.
 */
export function WriteAuthorizations({ authorizations, environments, busy, now, onGrant, onRevoke }: {
  authorizations: SandboxWriteAuthorization[]
  environments: ProductionEnvironment[]
  busy: string
  now: number
  onGrant(request: WriteAuthorizationRequest): void
  onRevoke(authorizationId: string): void
}): React.JSX.Element {
  const writable = environments.filter(environment => environment.kind !== 'production')
  const [draft, setDraft] = useState<WritesDraft>({ environmentId: writable[0]?.id ?? '', mutations: [], expiresOn: '', note: '' })
  const [error, setError] = useState('')
  const label = (environmentId: string): string => environments.find(environment => environment.id === environmentId)?.label ?? environmentId
  const toggle = (mutation: MutationKind): void => setDraft(current => ({
    ...current, mutations: current.mutations.includes(mutation) ? current.mutations.filter(item => item !== mutation) : [...current.mutations, mutation]
  }))
  return <div className="production-writes">
    {authorizations.length
      ? <ul>{authorizations.map(authorization => <li key={authorization.id} data-authorization-id={authorization.id}>
          <strong>{label(authorization.environmentId)}</strong>
          <small>{authorization.mutations.join(', ')} · until {formatTime(authorization.expiresAt)} · by {authorization.grantedBy.kind}{authorization.note ? ` · ${authorization.note}` : ''}</small>
          <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => onRevoke(authorization.id)}>Revoke</button>
        </li>)}</ul>
      : <p className="production-muted">No sandbox writes are authorized; audits stay read-only everywhere.</p>}
    {writable.length
      ? <details className="production-writes-grant">
          <summary>Authorize sandbox writes</summary>
          <form className="production-form" aria-label="Authorize sandbox writes" noValidate onSubmit={event => {
            event.preventDefault()
            const result = validateWrites(draft, environments, now)
            setError(result.error)
            if (result.request) onGrant(result.request)
          }}>
            <label><span>Environment</span><select value={draft.environmentId} onChange={event => setDraft(current => ({ ...current, environmentId: event.target.value }))}>
              {writable.map(environment => <option key={environment.id} value={environment.id}>{environment.label} ({environment.kind})</option>)}
            </select></label>
            <fieldset><legend>Mutations</legend>{MUTATION_KINDS.map(mutation => <label key={mutation} className="production-check">
              <input type="checkbox" checked={draft.mutations.includes(mutation)} onChange={() => toggle(mutation)} />{mutation}
            </label>)}</fieldset>
            <label><span>Expires on</span><input type="date" value={draft.expiresOn} onChange={event => setDraft(current => ({ ...current, expiresOn: event.target.value }))} /></label>
            <label><span>Note</span><input value={draft.note} onChange={event => setDraft(current => ({ ...current, note: event.target.value }))} /></label>
            {error && <p className="production-error" role="alert">{error}</p>}
            <div className="production-form-actions"><button type="submit" className="primary" disabled={Boolean(busy)}>Authorize</button></div>
          </form>
        </details>
      : <p className="production-muted">Add a staging, sandbox or local environment to authorize test mutations.</p>}
  </div>
}
