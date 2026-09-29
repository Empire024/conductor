import { useState } from 'react'
import type { DriftSettings } from '../../../../shared/production'

/**
 * Opt-in drift checks: how often the fingerprint is recomputed and what a change does (mark the
 * gate STALE, or also start an audit). Nothing recurring is enabled without this form.
 */
export function DriftSettingsForm({ drift, busy, error, onSave, onCancel }: {
  drift: DriftSettings
  busy: boolean
  error: string
  onSave(drift: DriftSettings): void
  onCancel(): void
}): React.JSX.Element {
  // The form is opened to enable or retune drift checks, so it starts checked; unchecking turns them off.
  const [enabled, setEnabled] = useState(true)
  const [hours, setHours] = useState(String(Math.max(1, Math.round(drift.everyMinutes / 60))))
  const [onChange, setOnChange] = useState<DriftSettings['onChange']>(drift.onChange)
  const parsed = Number(hours)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 * 30
  return <form className="production-form" aria-label="Drift checks" noValidate onSubmit={event => {
    event.preventDefault()
    if (valid) onSave({ enabled, everyMinutes: parsed * 60, onChange })
  }}>
    <label className="production-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Run drift checks</label>
    <label><span>Every (hours)</span><input type="number" min={1} max={720} value={hours} onChange={event => setHours(event.target.value)} />
      {!valid && <small className="production-error">Whole hours from 1 to 720.</small>}</label>
    <label><span>When the target changed</span><select value={onChange} onChange={event => setOnChange(event.target.value as DriftSettings['onChange'])}>
      <option value="mark-stale">Mark the audit stale</option>
      <option value="audit">Mark stale and start an audit</option>
    </select></label>
    <small className="production-muted">Drift checks run under the schedule gate (night or idle, machine not busy).</small>
    {error && <p className="production-error" role="alert">{error}</p>}
    <div className="production-form-actions">
      <button type="submit" className="primary" disabled={busy || !valid}>Save drift checks</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>
}
