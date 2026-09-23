import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Ban, Bot, Check, ChevronDown, ChevronRight, Circle, ExternalLink, GitBranch, GitCommitHorizontal, Github, LoaderCircle, RefreshCw, Rocket, SkipForward, User, X } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { DELIVERY_STAGES, type DeliveryBridge, type DeliveryRun, type DeliveryStage, type DeliveryStageId, type RepositoryFile, type RepositoryStatus } from '../../../shared/delivery'

// The bridge is wired into ConductorBridge by the main session; reading it through this accessor
// keeps the pane compiling whether or not the shared bridge type has caught up yet.
const deliveryBridge = (): DeliveryBridge => (window.conductor as unknown as { delivery: DeliveryBridge }).delivery
const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/* Pure helpers, exported for tests. */

export type FileBadge = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

/** One letter for a porcelain entry: untracked, conflicted, else the staged letter, else the worktree one. */
export function fileBadge(file: RepositoryFile): FileBadge {
  const index = file.index.trim(), worktree = file.worktree.trim()
  if (index === '?' || worktree === '?') return '?'
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) return 'U'
  const letter = index || worktree
  return (['M', 'A', 'D', 'R', 'C'] as const).find(item => item === letter) ?? 'M'
}

const badgeRank: Record<FileBadge, number> = { U: 0, M: 1, R: 2, C: 2, A: 3, D: 4, '?': 5 }

/** Tracked changes first (conflicts, then modified, renamed, added, deleted), untracked last; paths alphabetical within. */
export function groupFiles(files: RepositoryFile[]): Array<{ label: string; files: RepositoryFile[] }> {
  const sorted = [...files].sort((left, right) => badgeRank[fileBadge(left)] - badgeRank[fileBadge(right)] || left.path.localeCompare(right.path))
  const tracked = sorted.filter(file => fileBadge(file) !== '?')
  const untracked = sorted.filter(file => fileBadge(file) === '?')
  return [{ label: 'Changes', files: tracked }, { label: 'Untracked', files: untracked }].filter(group => group.files.length > 0)
}

/**
 * What Ship sends as `paths`: nothing (the whole tree) when every change is selected, else exactly
 * the selection - an empty list when only already-committed work is ahead and should be pushed.
 */
export function shipPaths(files: RepositoryFile[], selected: ReadonlySet<string>): string[] | undefined {
  const chosen = files.filter(file => selected.has(file.path)).map(file => file.path)
  return chosen.length === files.length ? undefined : chosen
}

export interface ShipGate {
  status: RepositoryStatus | null
  message: string
  selectedCount: number
  running: boolean
  shipping: boolean
}

/** Why Ship is disabled, or null when it can go. */
export function shipBlocker({ status, message, selectedCount, running, shipping }: ShipGate): string | null {
  if (!status) return 'Reading the repository…'
  if (!status.available) return status.reason ?? 'Delivery is unavailable for this project.'
  if (running) return 'A delivery is already running.'
  if (shipping) return 'Starting the delivery…'
  if (selectedCount === 0 && status.ahead === 0) return status.files.length ? 'Select at least one change to ship.' : 'Nothing to ship: the tree is clean and nothing is ahead.'
  if (!message.trim()) return 'Write a commit message.'
  return null
}

export function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Elapsed time of a stage that has started; empty while it is pending or was skipped without starting. */
export function stageElapsed(stage: Pick<DeliveryStage, 'startedAt' | 'finishedAt'>, now: number): string {
  if (!stage.startedAt) return ''
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : now
  return durationLabel(end - Date.parse(stage.startedAt))
}

/** The run's stages in pipeline order, filling any stage the host has not reported yet as pending. */
export function orderedStages(run: DeliveryRun): DeliveryStage[] {
  return DELIVERY_STAGES.map(({ id, label }) => run.stages.find(stage => stage.id === id)
    ?? { id, label, state: 'pending', startedAt: null, finishedAt: null, detail: '', log: [] })
}

export function requesterLabel(run: DeliveryRun): string {
  return run.requestedBy.kind === 'owner' ? 'You' : run.requestedBy.title || 'An agent'
}

export interface RunHeadline {
  tone: 'running' | 'delivered' | 'failed' | 'cancelled'
  title: string
  detail: string
}

/** A one-glance summary of a run for its banner. */
export function runHeadline(run: DeliveryRun): RunHeadline {
  const stages = orderedStages(run)
  if (run.state === 'running') {
    const active = stages.find(stage => stage.state === 'running') ?? stages.find(stage => stage.state === 'pending')
    const done = stages.filter(stage => stage.state === 'passed' || stage.state === 'skipped').length
    return { tone: 'running', title: active ? `${active.label}…` : 'Delivering…', detail: `Stage ${Math.min(done + 1, stages.length)} of ${stages.length}` }
  }
  if (run.state === 'delivered') {
    const commit = run.commit ? run.commit.slice(0, 7) : null
    if (run.publish === false) return { tone: 'delivered', title: 'Committed locally', detail: [commit && `commit ${commit}`, 'not pushed; publish when other devices need it'].filter(Boolean).join(' · ') }
    return { tone: 'delivered', title: run.releaseTag ? `Delivered ${run.releaseTag}` : 'Delivered', detail: [commit && `commit ${commit}`, run.releaseTag ? 'release verified' : 'pushed'].filter(Boolean).join(' · ') }
  }
  if (run.state === 'failed') {
    const failed = stages.find(stage => stage.state === 'failed')
    return { tone: 'failed', title: failed ? `Failed at ${failed.label.toLowerCase()}` : 'Delivery failed', detail: run.error ?? failed?.detail ?? 'The delivery stopped without a reason.' }
  }
  return { tone: 'cancelled', title: 'Cancelled', detail: run.error ?? 'The delivery was cancelled.' }
}

/** A stage's log is open while it runs or after it failed, unless the owner toggled it. */
export function stageExpanded(stage: DeliveryStage, overrides: Partial<Record<DeliveryStageId, boolean>>): boolean {
  return overrides[stage.id] ?? (stage.state === 'running' || stage.state === 'failed')
}

/* Presentation, stateless so every state can be rendered in tests. */

const openLink = (event: React.MouseEvent<HTMLAnchorElement>): void => {
  event.preventDefault()
  void window.conductor.system.openExternal(event.currentTarget.href)
}
const ExternalAnchor = ({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element =>
  <a href={href} target="_blank" rel="noreferrer" onClick={openLink}>{children}<ExternalLink size={10} /></a>

const stageIcon = (stage: DeliveryStage): React.JSX.Element => {
  switch (stage.state) {
    case 'running': return <LoaderCircle size={13} className="spin" aria-label="Running" />
    case 'passed': return <Check size={13} aria-label="Passed" />
    case 'failed': return <X size={13} aria-label="Failed" />
    case 'skipped': return <SkipForward size={12} aria-label="Skipped" />
    default: return <Circle size={9} aria-label="Pending" />
  }
}

export interface SourceControlViewProps {
  status: RepositoryStatus | null
  run: DeliveryRun | null
  message: string
  selected: ReadonlySet<string>
  shipping: boolean
  refreshing: boolean
  error: string
  now: number
  expanded: Partial<Record<DeliveryStageId, boolean>>
  onMessage(value: string): void
  onToggleFile(path: string): void
  onSelectAll(all: boolean): void
  /** Push and publish a GitHub release after the commit; off by default. */
  publish: boolean
  onPublish(publish: boolean): void
  onShip(): void
  onCancel(): void
  onRefresh(): void
  onToggleStage(id: DeliveryStageId, open: boolean): void
}

export function SourceControlView(props: SourceControlViewProps): React.JSX.Element {
  const { status, run, message, selected, shipping, refreshing, error, now, expanded } = props
  const running = run?.state === 'running'
  const files = status?.files ?? []
  const selectedCount = files.filter(file => selected.has(file.path)).length
  const blocker = shipBlocker({ status, message, selectedCount, running, shipping })
  const partial = selectedCount > 0 && selectedCount < files.length

  const header = <header className="scp-header">
    <div className="scp-branch">
      <GitBranch size={14} />
      <strong>{status?.branch ?? (status ? 'No branch' : 'Reading repository…')}</strong>
      {status?.available && status.upstream && <span className="scp-sync" title={`Compared with ${status.upstream}`}>
        <ArrowUp size={10} />{status.ahead}<ArrowDown size={10} />{status.behind}
      </span>}
      <button type="button" className="scp-icon-button" title="Refresh repository status" aria-label="Refresh repository status" disabled={refreshing} onClick={props.onRefresh}>
        <RefreshCw size={12} className={refreshing ? 'spin' : undefined} />
      </button>
    </div>
    {status?.available && <div className="scp-facts">
      {status.head && <span title={status.head}><GitCommitHorizontal size={11} /><code>{status.head.slice(0, 7)}</code>{status.headSubject}</span>}
      {status.github && <span><Github size={11} />{status.github.owner}/{status.github.repo}</span>}
      <span className={status.releaseWorkflow && props.publish ? 'scp-release-on' : undefined}>
        <Rocket size={11} />{!props.publish ? 'Local commit; no push or release' : status.releaseWorkflow ? 'Release workflow will be started and verified' : 'No release workflow; the push is the delivery'}
      </span>
      {!status.upstream && <span className="scp-warn"><AlertCircle size={11} />No upstream branch</span>}
    </div>}
  </header>

  if (status && !status.available) {
    return <div className="source-control-pane">
      {header}
      <p className="scp-unavailable" role="status"><AlertCircle size={14} />{status.reason ?? 'Delivery is unavailable for this project.'}</p>
    </div>
  }

  const headline = run ? runHeadline(run) : null
  return <div className="source-control-pane">
    {header}
    {error && <p className="scp-error" role="alert">{error}</p>}

    {run && headline && <section className={`scp-run tone-${headline.tone}`} aria-label="Delivery progress">
      <div className="scp-banner">
        <span className="scp-banner-icon">{headline.tone === 'running' ? <LoaderCircle size={15} className="spin" /> : headline.tone === 'delivered' ? <Check size={15} /> : headline.tone === 'failed' ? <AlertCircle size={15} /> : <Ban size={15} />}</span>
        <span className="scp-banner-text">
          <strong>{headline.title}</strong>
          <small className={headline.tone === 'failed' ? 'scp-banner-error' : undefined}>{headline.detail}</small>
        </span>
        {running && <button type="button" className="scp-cancel" onClick={props.onCancel}><X size={12} />Cancel</button>}
      </div>
      <div className="scp-run-meta">
        {run.requestedBy.kind === 'owner' ? <User size={11} /> : <Bot size={11} />}
        <span>{requesterLabel(run)}</span>
        <span>·</span>
        <span>{durationLabel((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt))}</span>
        {run.paths && <><span>·</span><span>{run.paths.length} selected path{run.paths.length === 1 ? '' : 's'}</span></>}
      </div>
      {run.message && <p className="scp-run-message" title={run.message}>{run.message.split(/\r?\n/)[0]}</p>}
      {(run.releaseUrl || run.workflowRunUrl) && <div className="scp-links">
        {run.releaseUrl && <ExternalAnchor href={run.releaseUrl}>{run.releaseTag ?? 'Release'}</ExternalAnchor>}
        {run.workflowRunUrl && <ExternalAnchor href={run.workflowRunUrl}>Workflow run</ExternalAnchor>}
      </div>}
      <ol className="scp-stages">
        {orderedStages(run).map(stage => {
          const open = stageExpanded(stage, expanded)
          const elapsed = stageElapsed(stage, now)
          return <li key={stage.id} className={`scp-stage state-${stage.state}`} data-stage={stage.id}>
            <button type="button" className="scp-stage-row" aria-expanded={stage.log.length ? open : undefined} disabled={!stage.log.length} onClick={() => props.onToggleStage(stage.id, !open)}>
              <span className="scp-stage-icon">{stageIcon(stage)}</span>
              <span className="scp-stage-label">{stage.label}</span>
              {elapsed && <span className="scp-stage-time">{elapsed}</span>}
              {stage.log.length > 0 && (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
            </button>
            {stage.detail && <p className="scp-stage-detail">{stage.detail}</p>}
            {open && stage.log.length > 0 && <pre className="scp-log">{stage.log.join('\n')}</pre>}
          </li>
        })}
      </ol>
    </section>}

    {status && <section className="scp-changes" aria-label="Changes">
      <div className="scp-section-head">
        <strong>{files.length ? `${selectedCount} of ${files.length} change${files.length === 1 ? '' : 's'} selected` : 'Working tree clean'}</strong>
        {files.length > 0 && <span>
          <button type="button" disabled={running} onClick={() => props.onSelectAll(true)}>All</button>
          <button type="button" disabled={running} onClick={() => props.onSelectAll(false)}>None</button>
        </span>}
      </div>
      {groupFiles(files).map(group => <div key={group.label} className="scp-group">
        <small>{group.label}</small>
        {group.files.map(file => {
          const badge = fileBadge(file)
          const slash = file.path.lastIndexOf('/')
          return <label key={file.path} className="scp-file" title={file.path}>
            <input type="checkbox" checked={selected.has(file.path)} disabled={running} onChange={() => props.onToggleFile(file.path)} />
            <span className="scp-file-name">{file.path.slice(slash + 1)}</span>
            {slash > 0 && <span className="scp-file-dir">{file.path.slice(0, slash)}</span>}
            <b className={`scp-badge badge-${badge === '?' ? 'untracked' : badge.toLowerCase()}`}>{badge}</b>
          </label>
        })}
      </div>)}
      {partial && <p className="scp-hint">Only the selected files are committed. Tests and build run against an isolated copy holding just this selection, so unrelated work in the tree cannot pass or fail them.</p>}
    </section>}

    {status && <form className="scp-compose" onSubmit={(event) => { event.preventDefault(); if (!blocker) props.onShip() }}>
      <textarea
        value={message}
        placeholder="Commit message"
        aria-label="Commit message"
        rows={3}
        disabled={running}
        onChange={(event) => props.onMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            if (!blocker) props.onShip()
          }
        }}
      />
      <div className="scp-ship-row">
        <button type="submit" className="scp-ship" disabled={Boolean(blocker)} title={blocker ?? (props.publish ? 'Test, build, commit, push and verify the release · Ctrl+Enter' : 'Test, build and commit on this machine · Ctrl+Enter')}>
          {shipping ? <LoaderCircle size={13} className="spin" /> : <Rocket size={13} />}{props.publish ? 'Ship & publish' : 'Ship'}
        </button>
        <label className="scp-publish" title="Off: the commit stays on this machine and the installed app updates through app.update. On: push main and build a GitHub release for other devices; it costs a hosted build, so use it for bigger, tested states rather than every delivery.">
          <input type="checkbox" checked={props.publish} disabled={running} onChange={event => props.onPublish(event.target.checked)} />Publish release
        </label>
        <small className="scp-ship-reason">{blocker ?? (props.publish ? 'Test → build → commit → push → start & verify release' : 'Test → build → commit (local)')}</small>
      </div>
    </form>}
  </div>
}

/* The live pane: reads the host, follows delivery events, and owns the draft. */

export function SourceControlPane({ project }: { project: ProjectRecord }): React.JSX.Element {
  const [status, setStatus] = useState<RepositoryStatus | null>(null)
  const [run, setRun] = useState<DeliveryRun | null>(null)
  const [message, setMessage] = useState('')
  // Tracked as exclusions so every change is selected by default, including ones that appear later.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set())
  const [shipping, setShipping] = useState(false)
  const [publish, setPublish] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [expanded, setExpanded] = useState<Partial<Record<DeliveryStageId, boolean>>>({})
  const projectIdRef = useRef(project.id)
  projectIdRef.current = project.id
  const runRef = useRef<DeliveryRun | null>(null)
  runRef.current = run

  const refresh = useCallback(async (): Promise<void> => {
    const projectId = project.id
    setRefreshing(true)
    try {
      const next = await deliveryBridge().status(projectId)
      if (projectIdRef.current === projectId) { setStatus(next); setError('') }
    } catch (reason) {
      if (projectIdRef.current === projectId) setError(`Could not read the repository: ${errorText(reason)}`)
    } finally {
      if (projectIdRef.current === projectId) setRefreshing(false)
    }
  }, [project.id])

  useEffect(() => {
    let active = true
    setStatus(null); setRun(null); setMessage(''); setExcluded(new Set()); setExpanded({}); setError('')
    void refresh()
    void deliveryBridge().current(project.id).then(value => { if (active) setRun(value) }).catch(() => {})
    const unsubscribe = deliveryBridge().onChanged(next => {
      if (!active || next.projectId !== project.id) return
      const previous = runRef.current
      if (previous?.id !== next.id) setExpanded({})
      // A run that just finished changed the tree or the branch; re-read it once.
      if (next.state !== 'running' && (previous?.id !== next.id || previous.state === 'running')) {
        void refresh()
        if (next.state === 'delivered' && next.requestedBy.kind === 'owner') setMessage('')
      }
      runRef.current = next
      setRun(next)
    })
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [project.id, refresh])

  const running = run?.state === 'running'
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const selected = useMemo(() => new Set((status?.files ?? []).map(file => file.path).filter(path => !excluded.has(path))), [status, excluded])

  const ship = async (): Promise<void> => {
    if (!status) return
    setShipping(true); setError('')
    try {
      const paths = shipPaths(status.files, selected)
      const started = await deliveryBridge().ship({ projectId: project.id, message: message.trim(), ...(paths ? { paths } : {}), publish })
      setExpanded({})
      setRun(started)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setShipping(false)
    }
  }
  const cancel = async (): Promise<void> => {
    try {
      const cancelled = await deliveryBridge().cancel(project.id)
      if (cancelled) setRun(cancelled)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  return <SourceControlView
    status={status}
    run={run}
    message={message}
    selected={selected}
    shipping={shipping}
    refreshing={refreshing}
    error={error}
    now={now}
    expanded={expanded}
    onMessage={setMessage}
    onToggleFile={(path) => setExcluded(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })}
    onSelectAll={(all) => setExcluded(all ? new Set() : new Set((status?.files ?? []).map(file => file.path)))}
    publish={publish}
    onPublish={setPublish}
    onShip={() => void ship()}
    onCancel={() => void cancel()}
    onRefresh={() => void refresh()}
    onToggleStage={(id, open) => setExpanded(current => ({ ...current, [id]: open }))}
  />
}
