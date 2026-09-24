import { useEffect, useState } from 'react'
import { Download, RefreshCw, RotateCcw } from 'lucide-react'
import type { AppUpdateState, RestorePoint } from '../../../shared/models'
import { useAppUpdates } from '../use-app-updates'
import { UpdateQuitConfirm } from './UpdateQuitConfirm'
import './AppUpdateButton.css'

export const isUpdateActionVisible = (state: AppUpdateState): boolean =>
  ['available', 'downloading', 'ready', 'installing'].includes(state.phase) ||
  (state.phase === 'error' && Boolean(state.availableVersion))

/** A wizard tab's app.restart.request, as the owner's update control shows it. */
export const restartRequestLabel = (state: AppUpdateState): string | undefined =>
  state.restartRequest && `Restart requested by ${state.restartRequest.title} — ${state.restartRequest.reason}`

const shortCli = (label: string, value: string | null): string => `${label} ${value ?? 'unknown'}`

export function VersionsMenu({ currentVersion, versions, busy, onRollback, onPin }: {
  currentVersion: string
  versions: RestorePoint[]
  busy: boolean
  onRollback(version: string): void
  onPin(version: string, pinned: boolean): void
}): React.JSX.Element {
  return <details className="update-versions-menu">
    <summary>Versions</summary>
    <div className="update-versions-popover">
      <strong>Restore points</strong>
      {!versions.length && <p>No local restore points yet.</p>}
      <ul>{versions.map(point => <li key={point.version}>
        <div><b>{point.version}</b>{point.version === currentVersion && <em>Current</em>}{point.knownGood && <em>Known good</em>}</div>
        <small>{new Date(point.createdAt).toLocaleString()} · {point.commit?.slice(0, 10) ?? 'uncommitted'}{point.dirty ? ' · dirty build' : ''}</small>
        <small>{shortCli('Claude', point.cliVersions.claude)} · {shortCli('Codex', point.cliVersions.codex)} · {shortCli('Grok', point.cliVersions.grok)}</small>
        <div className="update-version-actions">
          <button type="button" disabled={busy || point.version === currentVersion} onClick={() => onRollback(point.version)}>Roll back to this version</button>
          <button type="button" disabled={busy} onClick={() => onPin(point.version, !point.pinned)}>{point.pinned ? 'Unpin' : 'Pin as known good'}</button>
        </div>
      </li>)}</ul>
    </div>
  </details>
}

export function AppUpdateButton({ state, onAction }: { state: AppUpdateState; onAction(): void }): React.JSX.Element | null {
  const { pendingQuitConfirm, confirmQuitAndInstall, cancelQuitConfirm } = useAppUpdates()
  const [versions, setVersions] = useState<RestorePoint[]>([])
  const [versionBusy, setVersionBusy] = useState(false)
  const [versionError, setVersionError] = useState('')
  const refreshVersions = (): void => { void window.conductor.updates.versions().then(setVersions).catch(() => setVersions([])) }
  useEffect(refreshVersions, [])
  const confirm = pendingQuitConfirm && <UpdateQuitConfirm running={pendingQuitConfirm} onConfirm={() => void confirmQuitAndInstall()} onCancel={cancelQuitConfirm} />
  const requested = restartRequestLabel(state)
  const menu = <VersionsMenu currentVersion={state.currentVersion} versions={versions} busy={versionBusy} onPin={(version, pinned) => {
    setVersionBusy(true); setVersionError('')
    void window.conductor.updates.pinVersion(version, pinned).then(refreshVersions).catch(reason => setVersionError(reason instanceof Error ? reason.message : String(reason))).finally(() => setVersionBusy(false))
  }} onRollback={version => {
    if (!window.confirm(`Roll back Conductor to ${version}? The saved build will install through the local update feed and restart the app.`)) return
    setVersionBusy(true); setVersionError('')
    void window.conductor.updates.rollback(version).catch(reason => setVersionError(reason instanceof Error ? reason.message : String(reason))).finally(() => setVersionBusy(false))
  }} />
  const extras = <>{menu}{versionError && <span className="update-version-error" role="alert">{versionError}</span>}{confirm}</>
  if (!isUpdateActionVisible(state)) {
    if (!requested) return extras
    return <>
      <button className="statusbar-update ready" onClick={() => void window.conductor.updates.restart()} title={requested}>
        <RotateCcw size={11} /><span aria-live="polite">{requested.length > 90 ? requested.slice(0, 89) + '…' : requested}</span>
      </button>
      {extras}
    </>
  }

  const busy = state.phase === 'downloading' || state.phase === 'installing'
  const progress = typeof state.progress === 'number' && Number.isFinite(state.progress) ? Math.round(Math.max(0, Math.min(100, state.progress))) : undefined
  const label = state.phase === 'available' ? 'Update pending'
    : state.phase === 'downloading' ? progress === undefined ? 'Preparing download…' : `Downloading ${progress}%`
      : state.phase === 'ready' ? 'Restart to update'
        : state.phase === 'installing' ? 'Preparing restart…' : 'Retry update'
  const Icon = ['available', 'downloading'].includes(state.phase) ? Download : state.phase === 'ready' ? RotateCcw : RefreshCw
  return <>
    <button className={`statusbar-update ${state.phase}`} onClick={onAction} disabled={busy} aria-busy={busy}
      title={[requested, state.message ?? (state.availableVersion ? `${label}: Conductor ${state.availableVersion}` : label)].filter(Boolean).join('\n')}>
      <Icon size={11} /><span aria-live="polite">{label}</span>
      {requested && <span>· {requested.length > 90 ? requested.slice(0, 89) + '…' : requested}</span>}
      {state.phase === 'downloading' && <progress aria-label="Update download progress" value={progress} max={100} />}
    </button>
    {extras}
  </>
}
