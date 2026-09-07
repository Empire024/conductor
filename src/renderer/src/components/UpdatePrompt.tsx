import { CheckCircle2, Download, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { AppUpdateState } from '../../../shared/models'

export function UpdatePrompt({
  state,
  autoDownload,
  onAutoDownload,
  onAction,
  onDismiss
}: {
  state: AppUpdateState
  autoDownload: boolean
  onAutoDownload(enabled: boolean): void
  onAction(): void
  onDismiss(): void
}): React.JSX.Element {
  const downloading = state.phase === 'downloading'
  const installing = state.phase === 'installing'
  const busy = downloading || installing
  const progress = typeof state.progress === 'number' && Number.isFinite(state.progress) ? Math.round(Math.max(0, Math.min(100, state.progress))) : undefined
  const ready = state.phase === 'ready'
  const failed = state.phase === 'error'
  const Icon = ready ? CheckCircle2 : busy || failed ? RefreshCw : Download
  const title = installing ? 'Preparing to restart Conductor' : ready
    ? 'Update ready to install'
    : failed
      ? 'The update needs another try'
      : 'A Conductor update is pending'
  const detail = installing ? state.message ?? 'Preparing restart…' : ready
    ? `Conductor ${state.availableVersion} is downloaded. Restart now, or it will install when Conductor next exits.`
    : downloading
      ? progress === undefined ? 'Preparing download…' : `Downloading Conductor ${state.availableVersion}… ${progress}%`
      : failed
        ? state.message ?? 'The update could not be downloaded.'
        : `Conductor ${state.availableVersion} is ready to download.`
  const action = installing ? 'Preparing restart…' : ready ? 'Restart to update' : failed ? 'Retry update' : 'Download update'

  return (
    <div className="update-prompt-backdrop" role="presentation">
      <section className="update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-prompt-title">
        <header>
          <span className={`update-prompt-icon ${ready ? 'ready' : ''}`}><Icon className={busy ? 'spin' : ''} size={20} /></span>
          <div>
            <strong id="update-prompt-title">{title}</strong>
            <span>{state.source === 'local' ? 'Local test build' : 'Installed-app update'} · {state.currentVersion} → {state.availableVersion}</span>
          </div>
          <button title="Not now" aria-label="Not now" onClick={onDismiss}><X size={15} /></button>
        </header>
        <p role={failed ? 'alert' : 'status'} aria-live="polite">{detail}</p>
        {downloading && progress !== undefined && <progress aria-label="Update download progress" value={progress} max={100} />}
        {state.source === 'local' && <p>This build was published locally on this PC for testing. It may contain unfinished features.</p>}
        <label className="update-auto-choice">
          <input type="checkbox" checked={autoDownload} onChange={(event) => onAutoDownload(event.target.checked)} />
          <span><strong>Download future updates automatically</strong><small>They install when you exit normally; active work is never interrupted.</small></span>
        </label>
        <footer>
          <button onClick={onDismiss}>Not now</button>
          <button className="primary" disabled={busy} aria-busy={busy} onClick={onAction}>
            {busy ? <RefreshCw className="spin" size={13} /> : ready ? <RotateCcw size={13} /> : <Download size={13} />}
            {downloading ? progress === undefined ? 'Preparing download…' : `Downloading ${progress}%` : action}
          </button>
        </footer>
      </section>
    </div>
  )
}
