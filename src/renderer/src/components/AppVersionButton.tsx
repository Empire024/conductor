import { Check, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { AppUpdateState } from '../../../shared/models'

export function AppVersionButton({ state, onCheck }: { state: AppUpdateState; onCheck(): Promise<unknown> }): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const last = state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : 'never'
  const checking = busy || state.phase === 'checking'
  const current = 'v' + state.currentVersion
  return <button className="status-version status-version-button" disabled={checking}
    title={'Installed: ' + current + '\nCheck for updates (last checked ' + last + ')'} onClick={() => {
      setBusy(true); setChecked(false)
      void onCheck().then(() => setChecked(true)).catch((error: unknown) => {
        window.dispatchEvent(new CustomEvent('conductor:toast', { detail: String(error) }))
      }).finally(() => setBusy(false))
    }}>
    <span className="status-version-number">{current}</span>
    {checking ? <span className="status-version-feedback"><RefreshCw size={11} /> Checking…</span>
      : checked && state.phase === 'idle' ? <span className="status-version-feedback"><Check size={12} /> Latest version already installed</span> : null}
  </button>
}
