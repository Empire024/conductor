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
  const label = state.phase === 'available'
    ? 'Update available'
    : state.phase === 'downloading'
      ? `Downloading ${Math.round(state.progress ?? 0)}%`
      : state.phase === 'ready'
        ? 'Restart to update'
        : state.phase === 'installing'
          ? 'Restarting…'
          : 'Retry update'
  const Icon = state.phase === 'available' ? Download : state.phase === 'ready' ? RotateCcw : RefreshCw

  return (
    <button
      className={`statusbar-update ${state.phase}`}
      onClick={onAction}
      disabled={busy}
      title={state.availableVersion ? `${label}: Conductor ${state.availableVersion}` : state.message ?? label}
    >
      <Icon className={busy ? 'spin' : ''} size={11} />
      <span>{label}</span>
    </button>
  )
}
