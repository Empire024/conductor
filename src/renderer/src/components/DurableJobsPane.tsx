import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileText, FolderOpen, Pause, Play, Plus, Square } from 'lucide-react'
import { canTransition, TERMINAL_JOB_STATUSES, type DurableJobEvent, type DurableJobReport, type DurableJobStage, type DurableJobStatus, type DurableJobSummary } from '../../../shared/durable-jobs'
import type { DurableJobDetail } from '../../../shared/durable-jobs-bridge'
import { LOCAL_QWEN_35B } from '../../../shared/local-models'
import './DurableJobsPane.css'

/**
 * Durable overnight jobs on a local model. A job is identified by its id alone: the sidebar
 * panel remembers which job it shows, and a job tab carries the id as its resourceId, so closing,
 * splitting, reopening or reloading any view never changes which job it is — and the job keeps
 * running whether any view is open or not.
 */

const errorText = (reason: unknown): string => reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60)
  if (hours) return `${hours} h ${minutes.toString().padStart(2, '0')} min`
  if (minutes) return `${minutes} min ${(seconds % 60).toString().padStart(2, '0')} s`
  return `${seconds} s`
}
const clock = (value?: string): string => value ? new Date(value).toLocaleString() : '—'

/** Wall-clock time since the job started, live while it is not finished. */
export const elapsedMs = (job: { startedAt?: string; finishedAt?: string }, now: number): number =>
  job.startedAt ? Math.max(0, (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) : 0

/** Which controls a status allows, straight from the contract's transition table. */
export const jobControls = (status: DurableJobStatus): { pause: boolean; resume: boolean; cancel: boolean } => ({
  pause: canTransition(status, 'paused'),
  resume: (status === 'paused' || status === 'blocked') && canTransition(status, 'running'),
  cancel: canTransition(status, 'cancelled')
})

const PROBLEM_KINDS: ReadonlyArray<DurableJobEvent['kind']> = ['recovery', 'retry', 'loop-detected', 'server', 'approval', 'escalation']
/** Errors and recoveries the owner should see in the morning, newest first. */
export const problems = (stages: readonly DurableJobStage[], events: readonly DurableJobEvent[]): Array<{ at: string; kind: string; message: string }> => [
  ...stages.filter(stage => stage.error).map(stage => ({ at: stage.completedAt ?? stage.startedAt ?? '', kind: 'error', message: `${stage.title}: ${stage.error}` })),
  ...events.filter(event => PROBLEM_KINDS.includes(event.kind)).map(event => ({ at: event.at, kind: event.kind, message: event.message }))
].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12)

export interface DurableJobViewProps {
  detail: DurableJobDetail
  now: number
  busy: string
  error: string
  report: (DurableJobReport & { reportPath: string }) | null
  onPause(): void
  onResume(): void
  onCancel(): void
  onReport(): void
  onReveal(target: 'logs' | 'report'): void
  onOpenTab?(): void
}

export function DurableJobView({ detail, now, busy, error, report, onPause, onResume, onCancel, onReport, onReveal, onOpenTab }: DurableJobViewProps): React.JSX.Element {
  const { job, summary, events, checkpoints } = detail
  const stages = [...job.stages].sort((a, b) => a.index - b.index)
  const current = stages.find(stage => stage.id === job.currentStageId)
  const milestones = stages.filter(stage => stage.status === 'completed')
  const controls = jobControls(job.status)
  const issues = problems(stages, events)
  const reportPath = report?.reportPath ?? job.reportPath
  return <section className="durable-job" data-job-id={job.id} aria-label={`Durable job ${job.title}`}>
    <header className="durable-job-header">
      <div>
        <strong title={job.objective}>{job.title}</strong>
        <small>{job.id}</small>
      </div>
      <span className={`durable-job-status status-${job.status}`} data-status={job.status}>{job.status}</span>
    </header>
    {job.statusReason && <p className={`durable-job-reason ${job.status === 'blocked' || job.status === 'failed' ? 'problem' : ''}`}>{job.statusReason}</p>}
    <div className="durable-job-controls">
      <button type="button" disabled={!controls.pause || Boolean(busy)} onClick={onPause}><Pause size={13} />{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>
      <button type="button" disabled={!controls.resume || Boolean(busy)} onClick={onResume}><Play size={13} />{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>
      <button type="button" className="danger" disabled={!controls.cancel || Boolean(busy)} onClick={onCancel}><Square size={12} />{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
      {onOpenTab && <button type="button" onClick={onOpenTab} title="Open this job in a workspace tab"><ExternalLink size={13} />Tab</button>}
    </div>
    {error && <p className="durable-job-error" role="alert">{error}</p>}
    <dl className="durable-job-facts">
      <div><dt>Elapsed</dt><dd data-fact="elapsed">{formatDuration(elapsedMs(job, now))}</dd></div>
      <div><dt>Active</dt><dd data-fact="active">{formatDuration(job.activeMs)}</dd></div>
      <div><dt>Stage</dt><dd data-fact="stage">{current ? `${current.index + 1}/${stages.length} ${current.title} · attempt ${current.attempt}/${job.budgets.maxStageAttempts}` : `${summary.stagesCompleted}/${summary.stagesTotal} done`}</dd></div>
      <div><dt>Model</dt><dd data-fact="model">{job.model.model}</dd></div>
      <div><dt>Retries</dt><dd data-fact="retries">{job.counters.retries} (max {job.budgets.maxStageAttempts} attempts a stage)</dd></div>
      <div><dt>Recoveries</dt><dd data-fact="recoveries">{job.counters.recoveries} · rollovers {job.counters.contextRollovers} · loops {job.counters.loopsDetected}</dd></div>
      <div><dt>Started</dt><dd>{clock(job.startedAt)}</dd></div>
      <div><dt>Cloud escalation</dt><dd data-fact="escalation">{job.counters.cloudEscalations ? `${job.counters.cloudEscalations} recorded` : 'none'}</dd></div>
    </dl>
    <div className="durable-job-section">
      <h4>Milestones</h4>
      {!milestones.length && <p className="durable-job-muted">No stage completed yet.</p>}
      <ol>{milestones.map(stage => <li key={stage.id}><span>{stage.title}</span>{stage.result && <p>{stage.result}</p>}<time>{clock(stage.completedAt)}</time></li>)}</ol>
    </div>
    <div className="durable-job-section">
      <h4>Models by stage</h4>
      <table><tbody>{stages.map(stage => <tr key={stage.id} className={`stage-${stage.status}`}>
        <td>{stage.index + 1}. {stage.title}</td><td>{stage.status}</td><td>{stage.model ?? (stage.attempt ? job.model.model : '—')}</td><td>{stage.attempt ? `×${stage.attempt}` : ''}</td>
      </tr>)}</tbody></table>
    </div>
    <div className="durable-job-section">
      <h4>Checkpoints</h4>
      {!checkpoints.length && <p className="durable-job-muted">None yet.</p>}
      <ul>{checkpoints.slice(-5).reverse().map(checkpoint => <li key={checkpoint.id}>
        {checkpoint.commit && <code title={checkpoint.commit}>{checkpoint.commit.slice(0, 10)}</code>}<span>{checkpoint.reason}</span><time>{clock(checkpoint.createdAt)}</time>
      </li>)}</ul>
    </div>
    <div className="durable-job-section">
      <h4>Errors and recoveries</h4>
      {!issues.length && <p className="durable-job-muted">None.</p>}
      <ul>{issues.map((issue, index) => <li key={`${issue.at}:${index}`} className={`issue-${issue.kind}`}><span className="durable-job-kind">{issue.kind}</span><span>{issue.message}</span><time>{clock(issue.at)}</time></li>)}</ul>
    </div>
    <div className="durable-job-section durable-job-report">
      <h4>Report and logs</h4>
      <div className="durable-job-controls">
        <button type="button" disabled={Boolean(busy)} onClick={onReport}><FileText size={13} />{busy === 'report' ? 'Writing…' : TERMINAL_JOB_STATUSES.includes(job.status) || job.status === 'blocked' ? 'Write report' : 'Write interim report'}</button>
        <button type="button" onClick={() => onReveal('logs')}><FolderOpen size={13} />Logs</button>
        {reportPath && <button type="button" onClick={() => onReveal('report')}><FileText size={13} />Show report</button>}
      </div>
      <p className="durable-job-path" title={job.logDir}>{job.logDir}</p>
      {reportPath && <p className="durable-job-path" title={reportPath}>{reportPath}</p>}
      {report && <p className="durable-job-muted">{report.results.length} results · {report.filesChanged.length} files · {report.tests.filter(test => test.outcome === 'pass').length}/{report.tests.length} tests passed · {report.remainingWork.length} remaining</p>}
    </div>
  </section>
}

export function DurableJobList({ jobs, selected, now, onSelect }: { jobs: DurableJobSummary[]; selected: string | null; now: number; onSelect(jobId: string): void }): React.JSX.Element {
  if (!jobs.length) return <p className="durable-job-muted">No durable jobs in this project yet.</p>
  return <ul className="durable-job-list">{jobs.map(job => <li key={job.id}>
    <button type="button" className={job.id === selected ? 'active' : ''} onClick={() => onSelect(job.id)} data-job-id={job.id}>
      <span className={`durable-job-status status-${job.status}`}>{job.status}</span>
      <strong>{job.title}</strong>
      <small>{job.currentStage ? `${job.currentStage.title} · attempt ${job.currentStage.attempt}` : `${job.stagesCompleted}/${job.stagesTotal} stages`} · {formatDuration(job.status === 'running' ? job.elapsedMs + Math.max(0, now - Date.parse(job.updatedAt)) : job.elapsedMs)}</small>
    </button>
  </li>)}</ul>
}

export function DurableJobCreateForm({ models, busy, onCreate }: { models: Array<{ id: string; label: string }>; busy: boolean; onCreate(input: { title: string; objective: string; model: string; constraints: string[] }): void }): React.JSX.Element {
  const preferred = models.find(model => model.id === LOCAL_QWEN_35B)?.id ?? models[0]?.id ?? ''
  const [objective, setObjective] = useState(''), [title, setTitle] = useState(''), [model, setModel] = useState(preferred), [constraints, setConstraints] = useState('')
  useEffect(() => { if (!models.some(entry => entry.id === model)) setModel(preferred) }, [model, models, preferred])
  const ready = Boolean(objective.trim() && model)
  return <form className="durable-job-create" onSubmit={event => {
    event.preventDefault()
    if (!ready) return
    onCreate({ title: title.trim(), objective: objective.trim(), model, constraints: constraints.split(/\r?\n/).map(line => line.trim()).filter(Boolean) })
    setObjective(''); setTitle(''); setConstraints('')
  }}>
    <label>Objective<textarea aria-label="Job objective" rows={4} value={objective} onChange={event => setObjective(event.target.value)} placeholder="What should the local model finish by morning?" /></label>
    <label>Title<input aria-label="Job title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Optional" /></label>
    <label>Local model<select aria-label="Job model" value={model} onChange={event => setModel(event.target.value)} disabled={!models.length}>
      {!models.length && <option value="">No local model is configured</option>}
      {models.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
    </select></label>
    <label>Constraints<textarea aria-label="Job constraints" rows={2} value={constraints} onChange={event => setConstraints(event.target.value)} placeholder="Optional, one per line" /></label>
    <button type="submit" disabled={!ready || busy}><Plus size={13} />{busy ? 'Starting…' : 'Start job'}</button>
  </form>
}

/** Compact launcher-local creation UI. The selected tile supplies the exact local model, while
 * the resulting job immediately replaces the launcher with its durable conversation tab. */
export function DurableJobLauncherOption({ model, busy, error = '', onCreate }: {
  model: { id: string; label: string }
  busy: boolean
  error?: string
  onCreate(input: { title: string; objective: string; model: string; constraints: string[] }): void
}): React.JSX.Element {
  const [objective, setObjective] = useState(''), [title, setTitle] = useState('')
  return <details className="durable-job-launcher">
    <summary>Run as durable job (staged, resumable, overnight)</summary>
    <form onSubmit={event => { event.preventDefault(); if (objective.trim()) onCreate({ title: title.trim(), objective: objective.trim(), model: model.id, constraints: [] }) }}>
      <input type="hidden" name="model" value={model.id} />
      <strong>{model.label}</strong>
      <label>Job objective<textarea aria-label="Job objective" rows={3} value={objective} onChange={event => setObjective(event.target.value)} placeholder="What should this local model finish?" /></label>
      <label>Title<input aria-label="Job title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Optional" /></label>
      {error && <p className="durable-job-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !objective.trim()}><Plus size={13} />{busy ? 'Startingâ€¦' : 'Start durable job'}</button>
    </form>
  </details>
}

/** Loads one job and follows it: the detail refreshes on every change the service publishes. */
function useDurableJob(projectId: string, jobId: string | null) {
  const [detail, setDetail] = useState<DurableJobDetail | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [report, setReport] = useState<(DurableJobReport & { reportPath: string }) | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const bridge = window.conductor.durableJobs
  const load = useCallback(async () => {
    if (!jobId) { setDetail(null); return }
    try { setDetail(await bridge.detail(projectId, jobId)); setError('') }
    catch (reason) { setDetail(null); setError(errorText(reason)) }
  }, [bridge, jobId, projectId])
  useEffect(() => { setReport(null); void load() }, [load])
  useEffect(() => bridge.onChanged(summary => { if (summary.id === jobId) void load() }), [bridge, jobId, load])
  useEffect(() => {
    if (!detail || TERMINAL_JOB_STATUSES.includes(detail.job.status)) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [detail])
  const act = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError('')
    try { await action(); await load() } catch (reason) { setError(errorText(reason)) } finally { setBusy('') }
  }
  const handlers = jobId ? {
    onPause: () => void act('pause', () => bridge.pause(projectId, jobId, 'Paused from the job view')),
    onResume: () => void act('resume', () => bridge.resume(projectId, jobId)),
    onCancel: () => { if (window.confirm('Cancel this job for good? Its worktree, checkpoints and logs stay for inspection.')) void act('cancel', () => bridge.cancel(projectId, jobId, 'Cancelled from the job view')) },
    onReport: () => void act('report', async () => setReport(await bridge.report(projectId, jobId))),
    onReveal: (target: 'logs' | 'report') => void bridge.reveal(projectId, jobId, target).catch(reason => setError(errorText(reason)))
  } : null
  return { detail, busy, error, report, now, handlers }
}

/** A job tab: the view of exactly the job its resourceId names. */
export function DurableJobPanel({ projectId, jobId }: { projectId: string; jobId: string }): React.JSX.Element {
  const { detail, busy, error, report, now, handlers } = useDurableJob(projectId, jobId)
  if (!detail || !handlers) return <div className="durable-jobs-pane"><p className={error ? 'durable-job-error' : 'durable-job-muted'}>{error || 'Loading job…'}</p></div>
  return <div className="durable-jobs-pane"><DurableJobView detail={detail} now={now} busy={busy} error={error} report={report} {...handlers} /></div>
}

const selectionKey = (projectId: string): string => `conductor.durableJob.selected:${projectId}`

/** The sidebar panel: every job of the project, a create form, and the selected job's view. */
export function DurableJobsPane({ projectId, workspaceId, onOpenJob }: { projectId: string; workspaceId?: string; onOpenJob?(job: { id: string; title: string }): void }): React.JSX.Element {
  const [jobs, setJobs] = useState<DurableJobSummary[]>([])
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(selectionKey(projectId)))
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [creating, setCreating] = useState(false), [listError, setListError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const bridge = window.conductor.durableJobs
  const refresh = useCallback(async () => {
    try { setJobs(await bridge.list(projectId)); setListError('') } catch (reason) { setListError(errorText(reason)) }
  }, [bridge, projectId])
  useEffect(() => { setSelected(localStorage.getItem(selectionKey(projectId))); void refresh() }, [projectId, refresh])
  useEffect(() => bridge.onChanged(summary => { if (summary.projectId === projectId) void refresh() }), [bridge, projectId, refresh])
  useEffect(() => {
    void window.conductor.agents.listProviders().then(providers => setModels(providers.find(provider => provider.id === 'local')?.models.filter(model => !['default', 'auto'].includes(model.id)) ?? [])).catch(() => setModels([]))
  }, [])
  useEffect(() => {
    if (!jobs.some(job => job.status === 'running')) return
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [jobs])
  const select = (jobId: string): void => { localStorage.setItem(selectionKey(projectId), jobId); setSelected(jobId) }
  const sorted = useMemo(() => [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [jobs])
  const shown = selected && jobs.some(job => job.id === selected) ? selected : null
  const { detail, busy, error, report, now: tick, handlers } = useDurableJob(projectId, shown)
  return <div className="durable-jobs-pane">
    <p className="durable-jobs-intro">A durable job runs on a local model through the night in its own worktree, one stage at a time, and survives closing this view, a reload and a server restart. It never switches to a cloud model on its own.</p>
    <DurableJobCreateForm models={models} busy={creating} onCreate={input => {
      setCreating(true); setListError('')
      void bridge.create({ projectId, ...(workspaceId ? { workspaceId } : {}), ...input, ...(input.title ? {} : { title: '' }) })
        .then(summary => { select(summary.id); return refresh() })
        .catch(reason => setListError(errorText(reason)))
        .finally(() => setCreating(false))
    }} />
    {listError && <p className="durable-job-error" role="alert">{listError}</p>}
    <DurableJobList jobs={sorted} selected={shown} now={now} onSelect={select} />
    {detail && handlers && <DurableJobView detail={detail} now={tick} busy={busy} error={error} report={report} {...handlers}
      {...(onOpenJob ? { onOpenTab: () => onOpenJob({ id: detail.job.id, title: detail.job.title }) } : {})} />}
  </div>
}
