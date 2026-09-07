import { Download, RefreshCw, RotateCcw } from 'lucide-react'
import type { AppUpdateState } from '../../../shared/models'

export const isUpdateActionVisible = (state: AppUpdateState): boolean =>
  ['available', 'downloading', 'ready', 'installing'].includes(state.phase) ||
  (state.phase === 'error' && Boolean(state.availableVersion))

export function AppUpdateButton({
  state,
  onAction
}: {
  state: AppUpdateState
  onAction(): void
}): React.JSX.Element | null {
  if (!isUpdateActionVisible(state)) return null

  const busy = state.phase === 'downloading' || state.phase === 'installing'
  const progress = typeof state.progress === 'number' && Number.isFinite(state.progress) ? Math.round(Math.max(0, Math.min(100, state.progress))) : undefined
  const label = state.phase === 'available'
    ? 'Update pending'
    : state.phase === 'downloading'
      ? progress === undefined ? 'Preparing download…' : `Downloading ${progress}%`
      : state.phase === 'ready'
        ? 'Restart to update'
        : state.phase === 'installing'
          ? 'Preparing restart…'
          : 'Retry update'
  const Icon = ['available', 'downloading'].includes(state.phase) ? Download : state.phase === 'ready' ? RotateCcw : RefreshCw

  return (
    <button
      className={`statusbar-update ${state.phase}`}
      onClick={onAction}
      disabled={busy}
      aria-busy={busy}
      title={state.message ?? (state.availableVersion ? `${label}: Conductor ${state.availableVersion}` : label)}
    >
      <Icon size={11} />
      <span aria-live="polite">{label}</span>
      {state.phase === 'downloading' && <progress aria-label="Update download progress" value={progress} max={100} />}
    </button>
  )
}
