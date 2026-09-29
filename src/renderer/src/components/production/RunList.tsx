import { CircleStop, FileText, Pause, Play } from 'lucide-react'
import type { ProductionRunSummary } from '../../../../shared/production'
import { formatTime, ledgerText, progressText, runControls, shortCommit } from './production-model'

const STATUS_TONE: Record<ProductionRunSummary['status'], string> = {
  queued: 'busy', running: 'busy', paused: 'warn', recovering: 'busy', blocked: 'bad', completed: 'good', failed: 'bad', cancelled: 'quiet',
}

/** Runs of the chosen environment, newest first: progress in steps, the budget ledger, and the controls the status allows. */
export function RunList({ runs, busy, onPause, onResume, onCancel, onOpenReport, confirmId = null, confirm = null }: {
  runs: ProductionRunSummary[]
  busy: string
  onPause(runId: string): void
  onResume(runId: string): void
  onCancel(runId: string): void
  onOpenReport(runId: string): void
  confirmId?: string | null
  confirm?: React.ReactNode
}): React.JSX.Element {
  if (!runs.length) return <p className="production-muted">No runs yet.</p>
  return <ul className="production-runs">
    {[...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(run => {
      const controls = runControls(run.status)
      return <li key={run.id} data-run-id={run.id} data-status={run.status}>
        <div className="production-run-head">
          <strong>{run.kind}</strong>
          <span className={`production-chip tone-${STATUS_TONE[run.status]}`}>{run.status}</span>
          <small>{run.trigger.kind} by {run.trigger.by.title ?? run.trigger.by.kind} · {formatTime(run.createdAt)}</small>
        </div>
        <small data-fact="progress">{progressText(run)}</small>
        <small data-fact="ledger">{ledgerText(run)}</small>
        <small>commit {shortCommit(run.fingerprint.commit)}{run.finishedAt ? ` · finished ${formatTime(run.finishedAt)}` : ''}</small>
        {run.statusReason && <small className="production-reason">{run.statusReason}</small>}
        <div className="production-run-actions">
          {controls.pause && <button type="button" disabled={Boolean(busy)} onClick={() => onPause(run.id)}><Pause size={11} />Pause</button>}
          {controls.resume && <button type="button" disabled={Boolean(busy)} onClick={() => onResume(run.id)}><Play size={11} />Resume</button>}
          {controls.cancel && <button type="button" className="danger" disabled={Boolean(busy) || confirmId === run.id} onClick={() => onCancel(run.id)}><CircleStop size={11} />Cancel run…</button>}
          {run.reportPaths && <button type="button" disabled={Boolean(busy)} onClick={() => onOpenReport(run.id)}><FileText size={11} />Report</button>}
        </div>
        {confirmId === run.id && confirm}
      </li>
    })}
  </ul>
}
