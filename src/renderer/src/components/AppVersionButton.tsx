import { Check, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { AppUpdateState } from '../../../shared/models'

export function AppVersionButton({ state, onCheck }: { state: AppUpdateState; onCheck(): Promise<unknown> }): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const last = state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : 'never'
  return <button className="status-version status-version-button" disabled={busy || state.phase === 'checking'}
    title={'Check for updates (last checked ' + last + ')'} onClick={() => {
      setBusy(true); setChecked(false)
      void onCheck().then(() => setChecked(true)).catch((error: unknown) => {
        window.dispatchEvent(new CustomEvent('conductor:toast', { detail: String(error) }))
      }).finally(() => setBusy(false))
    }}>
    {busy ? <><RefreshCw size={11} /> Checking…</> : checked && state.phase === 'idle' ? <><Check size={12} /> Latest version already installed</> : 'v' + state.currentVersion}
  </button>
}
