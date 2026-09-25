import { useCallback, useEffect, useState } from 'react'
import { Power, RefreshCw } from 'lucide-react'
import type { AlwaysOnState } from '../../../shared/always-on'
import './AlwaysOnSettings.css'

const mark = (ok: boolean | null): string => ok === true ? 'ok' : ok === false ? 'missing' : 'unknown'

/**
 * Settings > Machines: "Start Conductor when I log in" and whether this PC comes back by itself
 * after a reboot or a power cut (src/main/machine-readiness.ts, docs/always-on.md). Conductor only
 * reads the power, sign-in and Tailscale state; every missing item is a step for the owner.
 */
export function AlwaysOnSettings(): React.JSX.Element {
  const [state, setState] = useState<AlwaysOnState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const load = useCallback((refresh = false): void => {
    setBusy(true)
    window.conductor.settings.alwaysOn(refresh).then(setState).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }, [])
  useEffect(() => { load() }, [load])
  const toggle = (enabled: boolean): void => {
    setError(undefined)
    window.conductor.settings.setStartAtLogin(enabled).then(() => load()).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const readiness = state?.readiness
  return <section className="always-on-settings" data-testid="always-on-settings">
    <div className="settings-section-title"><Power size={14} /><div><strong>Always on</strong><span>This PC comes back by itself after a reboot or a power cut.</span></div></div>
    <label className="theme-auto-setting">
      <span><strong>Start Conductor when I log in</strong><small>{state?.loginItem.backend === 'simulated'
        ? 'Development build: remembered here, not registered with the system'
        : 'Opens minimized, without taking focus'}</small></span>
      <input type="checkbox" aria-label="Start Conductor when I log in" checked={state?.loginItem.enabled === true} disabled={!state} onChange={event => toggle(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
    {readiness && <>
      <div className="always-on-summary" role="status">
        <strong>{readiness.ready ? 'Ready to run unattended' : `${readiness.missing.length} ${readiness.missing.length === 1 ? 'step' : 'steps'} left before this PC runs unattended`}</strong>
        <button type="button" aria-label="Check again" disabled={busy} onClick={() => load(true)}><RefreshCw size={12} /> Check again</button>
      </div>
      <ul className="always-on-checks">
        {readiness.checks.map(check => <li key={check.id} data-check={check.id} data-state={mark(check.ok)}>
          <span aria-hidden="true" />
          <div><strong>{check.label}</strong><small>{check.detail}</small></div>
        </li>)}
      </ul>
      {readiness.notes.map(note => <p key={note}>{note}</p>)}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
