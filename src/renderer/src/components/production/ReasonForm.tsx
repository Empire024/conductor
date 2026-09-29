import { useState } from 'react'
import { validateReason } from './production-model'

/**
 * An in-panel confirmation for an action that settles something (dismiss a question, revoke a
 * waiver, cancel a run, remove an environment). It opens under the item it acts on, says what the
 * action does, and takes the reason the record keeps; nothing is changed until it is submitted.
 */
export function ReasonForm({ label, consequence, reasonLabel, reasonRequired, initialReason = '', confirmLabel, busy, error, onSubmit, onCancel }: {
  /** Accessible name of the form, for example "Dismiss question". */
  label: string
  consequence: string
  /** Null for a plain confirmation without a reason field. */
  reasonLabel: string | null
  reasonRequired: boolean
  initialReason?: string
  confirmLabel: string
  busy: boolean
  error: string
  onSubmit(reason: string): void
  onCancel(): void
}): React.JSX.Element {
  const [reason, setReason] = useState(initialReason)
  const [invalid, setInvalid] = useState('')
  return <form className="production-form production-confirm" aria-label={label} noValidate onSubmit={event => {
    event.preventDefault()
    const problem = reasonLabel ? validateReason(reason, reasonRequired) : ''
    setInvalid(problem)
    if (!problem) onSubmit(reason.trim())
  }}>
    <p>{consequence}</p>
    {reasonLabel && <label className={invalid ? 'invalid' : ''}>
      <span>{reasonLabel}{reasonRequired ? '' : ' (optional)'}</span>
      <input value={reason} required={reasonRequired} onChange={event => setReason(event.target.value)} />
      {invalid && <small className="production-error" role="alert">{invalid}</small>}
    </label>}
    {error && <p className="production-error" role="alert">{error}</p>}
    <div className="production-form-actions">
      <button type="submit" className="danger" disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
      <button type="button" disabled={busy} onClick={onCancel}>Keep</button>
    </div>
  </form>
}
