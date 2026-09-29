import { useState } from 'react'
import { ENVIRONMENT_KINDS, type ProductionEnvironment } from '../../../../shared/production'
import { validateEnvironment, type EnvironmentDraft, type EnvironmentErrors } from './production-model'

/** Adds an environment to audit: a label, its kind, the base URL and any other origins the audit browser may navigate to. */
export function EnvironmentForm({ existing, busy, error, onSave, onCancel }: {
  existing: ProductionEnvironment[]
  busy: boolean
  error: string
  onSave(environment: ProductionEnvironment): void
  onCancel?(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<EnvironmentDraft>({ label: existing.length ? '' : 'Production', kind: existing.length ? 'staging' : 'production', baseUrl: '', extraOrigins: '' })
  const [errors, setErrors] = useState<EnvironmentErrors>({})
  const set = (key: keyof EnvironmentDraft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
    setDraft(current => ({ ...current, [key]: event.target.value }))
  return <form className="production-form" aria-label="Add environment" noValidate onSubmit={event => {
    event.preventDefault()
    const result = validateEnvironment(draft, existing)
    setErrors(result.errors)
    if (result.environment) onSave(result.environment)
  }}>
    <label><span>Label</span><input value={draft.label} onChange={set('label')} />{errors.label && <small className="production-error">{errors.label}</small>}</label>
    <label><span>Kind</span><select value={draft.kind} onChange={set('kind')}>{ENVIRONMENT_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
    <label><span>Base URL</span><input value={draft.baseUrl} onChange={set('baseUrl')} placeholder="https://shop.example.com" />{errors.baseUrl && <small className="production-error">{errors.baseUrl}</small>}</label>
    <label><span>Other allowed origins</span><input value={draft.extraOrigins} onChange={set('extraOrigins')} placeholder="https://checkout.example.com" />{errors.extraOrigins && <small className="production-error">{errors.extraOrigins}</small>}</label>
    <small className="production-muted">Production environments are audited read-only (GET and HEAD). Third-party requests are observed, never navigated to.</small>
    {error && <p className="production-error" role="alert">{error}</p>}
    <div className="production-form-actions">
      <button type="submit" className="primary" disabled={busy}>Add environment</button>
      {onCancel && <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
    </div>
  </form>
}

/** The project's environments with their allowlists; removing one keeps its past runs. */
export function EnvironmentList({ environments, designatedId, busy, onRemove }: {
  environments: ProductionEnvironment[]
  designatedId: string | null
  busy: string
  onRemove(environmentId: string): void
}): React.JSX.Element {
  if (!environments.length) return <p className="production-muted">No environments yet.</p>
  return <ul className="production-environments">
    {environments.map(environment => <li key={environment.id} data-environment-id={environment.id}>
      <div className="production-run-head">
        <strong>{environment.label}</strong> <span className="production-chip tone-quiet">{environment.kind}</span>
        {designatedId === environment.id && <span className="production-chip tone-good">production-ready</span>}
      </div>
      <small>{environment.baseUrl} · allowed {environment.allowedOrigins.join(', ')}</small>
      <button type="button" className="danger" disabled={Boolean(busy) || designatedId === environment.id} title={designatedId === environment.id ? 'Remove the designation first' : 'Remove this environment'} onClick={() => onRemove(environment.id)}>Remove</button>
    </li>)}
  </ul>
}
