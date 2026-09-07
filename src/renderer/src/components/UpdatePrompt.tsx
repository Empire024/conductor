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
  const ready = state.phase === 'ready'
  const failed = state.phase === 'error'
  const Icon = ready ? CheckCircle2 : downloading || failed ? RefreshCw : Download
  const title = ready
    ? 'Update ready to install'
    : failed
      ? 'The update needs another try'
      : 'A Conductor update is pending'
  const detail = ready
    ? `Conductor ${state.availableVersion} is downloaded. Restart now, or it will install when Conductor next exits.`
    : downloading
      ? `Downloading Conductor ${state.availableVersion}… ${Math.round(state.progress ?? 0)}%`
      : failed
        ? state.message ?? 'The update could not be downloaded.'
        : `Conductor ${state.availableVersion} is ready to download.`
  const action = ready ? 'Restart to update' : failed ? 'Retry download' : 'Download update'

  return (
    <div className="update-prompt-backdrop" role="presentation">
      <section className="update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-prompt-title">
        <header>
          <span className={`update-prompt-icon ${ready ? 'ready' : ''}`}><Icon className={downloading ? 'spin' : ''} size={20} /></span>
          <div>
            <strong id="update-prompt-title">{title}</strong>
            <span>Installed-app update · {state.currentVersion} → {state.availableVersion}</span>
          </div>
          <button title="Not now" aria-label="Not now" onClick={onDismiss}><X size={15} /></button>
        </header>
        <p>{detail}</p>
        <label className="update-auto-choice">
          <input type="checkbox" checked={autoDownload} onChange={(event) => onAutoDownload(event.target.checked)} />
          <span><strong>Download future updates automatically</strong><small>They install when you exit normally; active work is never interrupted.</small></span>
        </label>
        <footer>
          <button onClick={onDismiss}>Not now</button>
          <button className="primary" disabled={downloading} onClick={onAction}>
            {ready ? <RotateCcw size={13} /> : <Download size={13} />}
            {downloading ? `Downloading ${Math.round(state.progress ?? 0)}%` : action}
          </button>
        </footer>
      </section>
    </div>
  )
}
