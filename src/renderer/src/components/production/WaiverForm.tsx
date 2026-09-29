import { useState } from 'react'
import type { Finding, Waiver, WaiverRequest } from '../../../../shared/production'
import { formatTime, validateWaiver, type WaiverDraft, type WaiverErrors } from './production-model'

/**
 * Accepting a finding's risk: reason, scope, owner and an expiry are all required. The finding is
 * kept; the waiver only lets the gate read VERIFIED_WITH_WAIVERS while it lasts.
 */
export function WaiverForm({ finding, busy, error, now, initialDraft, initialErrors, onSubmit, onCancel }: {
  finding: Pick<Finding, 'id' | 'title'>
  busy: boolean
  error: string
  now: number
  initialDraft?: Partial<WaiverDraft>
  initialErrors?: WaiverErrors
  onSubmit(request: WaiverRequest): void
  onCancel(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<WaiverDraft>({ reason: '', scope: '', owner: '', expiresOn: '', ...initialDraft })
  const [errors, setErrors] = useState<WaiverErrors>(initialErrors ?? {})
  const field = (key: keyof WaiverDraft, label: string, input: React.JSX.Element): React.JSX.Element =>
    <label className={errors[key] ? 'invalid' : ''}>
      <span>{label}</span>
      {input}
      {errors[key] && <small className="production-error" role="alert">{errors[key]}</small>}
    </label>
  const set = (key: keyof WaiverDraft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
    setDraft(current => ({ ...current, [key]: event.target.value }))
  return <form className="production-form production-waiver-form" aria-label={`Waive ${finding.title}`} noValidate
    onSubmit={event => {
      event.preventDefault()
      const result = validateWaiver(finding.id, draft, now)
      setErrors(result.errors)
      if (result.request) onSubmit(result.request)
    }}>
    <strong data-audit-text>Waive: {finding.title}</strong>
    {field('reason', 'Reason', <textarea rows={2} value={draft.reason} onChange={set('reason')} />)}
    {field('scope', 'Scope', <input value={draft.scope} onChange={set('scope')} placeholder="For example /checkout on desktop" />)}
    {field('owner', 'Risk owner', <input value={draft.owner} onChange={set('owner')} />)}
    {field('expiresOn', 'Expires on', <input type="date" required value={draft.expiresOn} onChange={set('expiresOn')} />)}
    {error && <p className="production-error" role="alert">{error}</p>}
    <div className="production-form-actions">
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Grant waiver'}</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>
}

/** Waivers of the project, live ones first; revoking keeps the record and reopens the finding. */
export function WaiverList({ waivers, findings, busy, now, onRevoke, confirmId = null, confirm = null }: {
  waivers: Waiver[]
  findings: Finding[]
  busy: string
  now: number
  onRevoke(waiverId: string): void
  confirmId?: string | null
  confirm?: React.ReactNode
}): React.JSX.Element {
  if (!waivers.length) return <p className="production-muted">No waivers.</p>
  const title = (findingId: string): string => findings.find(finding => finding.id === findingId)?.title ?? findingId
  const state = (waiver: Waiver): string => waiver.revokedAt ? 'revoked' : Date.parse(waiver.expiresAt) <= now ? 'expired' : 'live'
  return <ul className="production-waivers">
    {[...waivers].sort((a, b) => Number(state(a) !== 'live') - Number(state(b) !== 'live')).map(waiver => <li key={waiver.id} data-waiver-id={waiver.id} data-state={state(waiver)}>
      <strong>{title(waiver.findingId)}</strong>
      <small>{waiver.reason} · scope {waiver.scope} · owner {waiver.owner} · granted by {waiver.grantedBy.kind} {formatTime(waiver.grantedAt)}</small>
      <small>{state(waiver) === 'revoked' ? `Revoked ${formatTime(waiver.revokedAt)}${waiver.revokedReason ? `: ${waiver.revokedReason}` : ''}` : `${state(waiver) === 'expired' ? 'Expired' : 'Expires'} ${formatTime(waiver.expiresAt)}`}</small>
      {state(waiver) === 'live' && confirmId !== waiver.id && <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => onRevoke(waiver.id)}>Revoke…</button>}
      {confirmId === waiver.id && confirm}
    </li>)}
  </ul>
}
