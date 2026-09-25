import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowUpRight, Bot, Clock3, Gauge, History, Link2, PauseCircle, Play, TerminalSquare } from 'lucide-react'
import type { AgentProviderInfo, ProjectRecord, RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection, StructuredProvider } from '../../../shared/structured-agent'
import type { AgentCollaborationSnapshot } from '../../../shared/agent-collaboration'
import { cacheReadBilledEquivalent, summarizeUsageRun, tokenBreakdown, type TokenBreakdown, type UsageScopeReport } from '../../../shared/usage-accounting'
import { evaluateUsageWarning, type UsageWarningLevel } from '../../../shared/usage-warning'
import { processModelLabel } from '../agent-models'
import { createSerialPoller, currentTurnStartedAt, durationLabel, processTrackerState, reportedPlanProgress, selectProcessBoardProcesses, stuckBackgroundTask, type ProcessTrackerState } from './ProcessDashboardPane.helpers'
import { VIEWING_LABEL, viewingDescription } from '../../../shared/project-activity'
import './ProcessDashboardPane.css'
import { WeeklyUsage } from '../components/WeeklyUsage'
import { latestControlAction } from '../../../shared/control-activity'

interface ProcessFacts {
  snapshot?: SessionProjection
  usage?: UsageScopeReport
  warning?: UsageWarningLevel
}
interface DashboardSnapshot {
  processes: RuntimeProcessSummary[]
  projects: ProjectRecord[]
  hiddenOlder: number
  collaboration: AgentCollaborationSnapshot
  facts: Map<string, ProcessFacts>
  observedAt: number
}

const emptyDashboard = (project: ProjectRecord): DashboardSnapshot => ({ processes: [], projects: [project], hiddenOlder: 0, collaboration: { messages: [], presence: [] }, facts: new Map(), observedAt: Date.now() })
const relativeTime = (timestamp: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}
const tokenLabel = (tokens: number): string => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}m` : tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens)
const costLabel = (cost: number): string => `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`
/** Every figure the provider reported, kept apart: the headline leaves out re-read cache. */
const breakdownTitle = (tokens: TokenBreakdown, provider?: string): string => {
  const billed = cacheReadBilledEquivalent(tokens, provider as StructuredProvider | undefined)
  return [
    'Processed = new input + cache write + output.',
    tokens.newInput !== undefined ? `New input ${tokens.newInput.toLocaleString()}` : undefined,
    `Cache write ${tokens.cacheWrite.toLocaleString()}`,
    tokens.output !== undefined ? `Output ${tokens.output.toLocaleString()}${tokens.reasoning ? ` (${tokens.reasoning.toLocaleString()} reasoning)` : ''}` : undefined,
    `Cache reads ${tokens.cacheRead.toLocaleString()}${billed !== undefined ? ` (≈ ${billed.toLocaleString()} billed-equivalent)` : ''}, the context re-read on every call`,
    tokens.total !== undefined ? `Provider total ${tokens.total.toLocaleString()}` : undefined
  ].filter(Boolean).join('\n')
}
const stateLabel: Record<ProcessTrackerState, string> = {
  attention: 'Needs input', working: 'Working', viewing: VIEWING_LABEL, paused: 'Limit pause', disconnected: 'Disconnected', ready: 'Connected · idle', finished: 'Finished'
}
const stateRank: Record<ProcessTrackerState, number> = { attention: 0, working: 1, viewing: 1, paused: 2, disconnected: 3, ready: 4, finished: 5 }

async function readFacts(process: RuntimeProcessSummary): Promise<readonly [string, ProcessFacts]> {
  if (process.kind !== 'agent') return [process.id, {}] as const
  try {
    const snapshot = await window.conductor.structured.snapshot(process.id)
    if (!snapshot) return [process.id, {}] as const
    const usage = summarizeUsageRun(snapshot.items).conversation
    try {
      const caps = await window.conductor.usageCaps.read(process.id, process.sessionId)
      return [process.id, { snapshot, usage, warning: evaluateUsageWarning(usage, caps.effective?.setting ?? null)?.level }] as const
    } catch {
      // Quota decoration is optional; never discard authoritative connection state or usage when
      // only its cap lookup failed.
      return [process.id, { snapshot, usage }] as const
    }
  } catch {
    return [process.id, {}] as const
  }
}

export function ProcessDashboardPane({ project }: { project: ProjectRecord }): React.JSX.Element {
  const [dashboard, setDashboard] = useState<DashboardSnapshot>(() => emptyDashboard(project))
  const [providers, setProviders] = useState<AgentProviderInfo[]>([])
  const [olderLimit, setOlderLimit] = useState(0)
  const [reconnecting, setReconnecting] = useState<string>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let active = true
    void window.conductor.agents.listProviders().then(items => { if (active) setProviders(items) }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    const poller = createSerialPoller(async () => {
      const observedAt = Date.now()
      const projects = await window.conductor.projects.list()
      const [inventory, collaboration] = await Promise.all([
        olderLimit > 0
          ? Promise.all(projects.map(item => window.conductor.agents.listProcesses(item.id))).then(items => items.flat())
          : window.conductor.agents.listProcesses(),
        window.conductor.collaboration.snapshot({ projectId: project.id, limit: 30 })
      ])
      // Filter lightweight runtime rows before asking for any conversation projection. The
      // initial open therefore cannot transfer weeks of retained sessions into the renderer.
      const selected = selectProcessBoardProcesses(inventory, observedAt, olderLimit)
      const processes = selected.processes
      const facts = new Map(await Promise.all(processes.map(readFacts)))
      return { processes, projects, hiddenOlder: selected.hiddenOlder, collaboration, facts, observedAt }
    }, value => { setDashboard(value); setNow(value.observedAt); setError('') })
    const refresh = (): void => { void poller.run().catch(reason => { if (active) setError(`Process refresh failed: ${reason instanceof Error ? reason.message : String(reason)}`) }) }
    refresh()
    const timer = window.setInterval(() => { setNow(Date.now()); if (!document.hidden) refresh() }, 2500)
    return () => { active = false; poller.dispose(); window.clearInterval(timer) }
  }, [olderLimit, project.id])

  const rows = useMemo(() => dashboard.processes.map(process => {
    const facts = dashboard.facts.get(process.id) ?? {}
    return { process, facts, state: processTrackerState(process, facts.snapshot) }
  }).sort((left, right) => {
    const rank = stateRank[left.state] - stateRank[right.state]
    return rank || right.process.updatedAt.localeCompare(left.process.updatedAt)
  }), [dashboard.processes, dashboard.facts])
  const counts = useMemo(() => rows.reduce((result, row) => {
    result[row.state] += 1
    return result
  }, { attention: 0, working: 0, viewing: 0, paused: 0, disconnected: 0, ready: 0, finished: 0 } as Record<ProcessTrackerState, number>), [rows])
  const totalUsage = useMemo(() => [...dashboard.facts.values()].reduce((total, facts) => {
    const tokens = tokenBreakdown(facts.usage?.tokens)
    return {
      processed: total.processed + (tokens?.processed ?? 0),
      output: total.output + (tokens?.output ?? 0),
      cacheRead: total.cacheRead + (tokens?.cacheRead ?? 0),
      cost: total.cost + (facts.usage?.costUsd ?? 0)
    }
  }, { processed: 0, output: 0, cacheRead: 0, cost: 0 }), [dashboard.facts])
  const groups = useMemo(() => {
    const names = new Map(dashboard.projects.map(item => [item.id, item.name]))
    const grouped = new Map<string, typeof rows>()
    for (const row of rows) grouped.set(row.process.projectId, [...(grouped.get(row.process.projectId) ?? []), row])
    return [...grouped].map(([projectId, projectRows]) => ({
      projectId,
      name: names.get(projectId) ?? 'Unknown project',
      rows: projectRows,
      needsOwner: projectRows.filter(row => ['attention', 'paused', 'disconnected'].includes(row.state)).length,
      active: projectRows.filter(row => row.state === 'working').length
    })).sort((a, b) => b.needsOwner - a.needsOwner || b.active - a.active || a.name.localeCompare(b.name))
  }, [dashboard.projects, rows])

  const focus = (process: RuntimeProcessSummary): void => {
    if (process.kind === 'agent') {
      void window.conductor.agentControl.focusOrigin(process.id).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      return
    }
    window.dispatchEvent(new CustomEvent('conductor:focus-process', { detail: process }))
  }
  const reconnect = async (process: RuntimeProcessSummary, facts: ProcessFacts): Promise<void> => {
    setReconnecting(process.id); setError('')
    try {
      await window.conductor.structured.resume(process.id, facts.snapshot?.settings)
      focus(process)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setReconnecting(undefined)
    }
  }

  return <div className="process-dashboard pd-dashboard">
    <header className="pd-header">
      <div><Gauge size={20} /><span><strong>Processes</strong><small>All open projects · recent 24 hours</small></span></div>
      <span className="pd-observed"><i /> Updated {relativeTime(new Date(dashboard.observedAt).toISOString(), now)}</span>
    </header>
    <section className="pd-overview" aria-label="Project process summary">
      <span className={counts.working ? 'working' : ''}><b>{counts.working}</b><small>Working now</small></span>
      {counts.viewing > 0 && <span title={viewingDescription()}><b>{counts.viewing}</b><small>{VIEWING_LABEL}</small></span>}
      <span className={counts.attention ? 'attention' : ''}><b>{counts.attention}</b><small>Need you</small></span>
      <span><b>{counts.paused}</b><small>Limit paused</small></span>
      <span><b>{counts.disconnected}</b><small>Disconnected</small></span>
      <span title={`New input + cache write + output. ${tokenLabel(totalUsage.cacheRead)} cache reads (context re-read on every call) are not in this figure.`}><b>{tokenLabel(totalUsage.processed)}</b><small>Processed tokens</small></span>
      <span><b>{tokenLabel(totalUsage.output)}</b><small>Output tokens</small></span>
      <span><b>{totalUsage.cost ? costLabel(totalUsage.cost) : '—'}</b><small>Estimated cost</small></span>
    </section>

    <WeeklyUsage />
    {error && <p className="pd-error" role="alert">{error}</p>}
    <div className="pd-table" role="table" aria-label="Project runtimes">
      <div className="pd-table-head" role="row"><span>Runtime</span><span>State</span><span>Progress</span><span>Usage</span><span>Activity</span><span /></div>
      {groups.map(group => <section className="pd-project-group" role="rowgroup" key={group.projectId}>
        <header className="pd-project-heading" role="row">
          <span><strong>{group.name}</strong><small>{group.rows.length} visible</small></span>
          <span className={group.needsOwner ? 'needs-owner' : group.active ? 'active' : ''}>{group.needsOwner ? `${group.needsOwner} need${group.needsOwner === 1 ? 's' : ''} owner` : group.active ? `${group.active} working` : 'Recent activity'}</span>
        </header>
        {group.rows.map(({ process, facts, state }) => {
        const finishedExecution = state === 'disconnected' && processTrackerState(process) === 'finished'
        const plan = reportedPlanProgress(facts.snapshot)
        const turnTime = durationLabel(currentTurnStartedAt(facts.snapshot), now)
        const reportedModel = facts.snapshot?.settings.model ? new Map([[process.id, facts.snapshot.settings.model]]) : new Map<string, string>()
        const model = process.kind === 'agent' ? processModelLabel(process, providers, reportedModel) : undefined
        const tokens = tokenBreakdown(facts.usage?.tokens)
        const stuck = state === 'viewing' ? stuckBackgroundTask(facts.snapshot, now, process.updatedAt) : undefined
        const canReconnect = state === 'disconnected' && Boolean(facts.snapshot?.capabilities?.resume && facts.snapshot.nativeSessionId && !facts.snapshot.archived)
        const RuntimeIcon = process.kind === 'agent' ? Bot : TerminalSquare
        const control = facts.snapshot ? latestControlAction(facts.snapshot.items) : null
        return <article key={process.id} role="row" data-process-id={process.id} className={`pd-row state-${state}`} onDoubleClick={() => focus(process)}>
          <div className="pd-runtime" role="cell"><span className="pd-runtime-icon"><RuntimeIcon size={15} /></span><span><strong>{process.title}</strong><small>{process.kind === 'agent' ? `${process.provider ?? 'agent'} · ${model ?? 'model unavailable'}` : 'PowerShell process'}</small></span></div>
          <div className="pd-state" role="cell"><span className={`pd-state-marker ${state}`} title={`${stateLabel[state]}. ${state === 'ready' ? 'The adapter is connected but no turn is working.' : state === 'viewing' ? viewingDescription(facts.snapshot?.backgroundTasks) + '.' : state === 'disconnected' ? 'Conversation history remains available; reconnect only when you choose.' : 'Reported by the runtime.'}`} /><span><strong>{stateLabel[state]}</strong>{finishedExecution ? <small>Last execution finished</small> : turnTime && state === 'working' ? <small>Latest prompt {turnTime} ago</small> : stuck ? <small className="pd-stuck">{stuck}</small> : state === 'finished' ? <small>{relativeTime(process.updatedAt, now)}</small> : null}</span></div>
          <div className="pd-progress-cell" role="cell">{plan ? <><span>{plan.label}</span><progress max={plan.total} value={plan.completed} aria-label={`${process.title}: ${plan.label}`} /></> : <span className="pd-unreported">No plan reported</span>}</div>
          <div className={`pd-usage${facts.warning ? ` warning-${facts.warning}` : ''}`} role="cell" title={[facts.warning ? `${process.title} usage is ${facts.warning === 'high' ? 'high' : 'rising'}.` : '', tokens ? breakdownTitle(tokens, process.provider) : ''].filter(Boolean).join('\n') || undefined}><strong>{tokens?.processed === undefined ? '—' : `${tokenLabel(tokens.processed)} tok`}</strong><small>{[tokens?.output !== undefined ? `${tokenLabel(tokens.output)} out` : undefined, tokens?.cacheRead ? `${tokenLabel(tokens.cacheRead)} cache reads` : undefined, facts.usage?.costUsd ? costLabel(facts.usage.costUsd) : 'no cost reported'].filter(Boolean).join(' · ')}</small></div>
          <div className="pd-activity" role="cell"><strong>{relativeTime(process.updatedAt, now)}</strong><small>Last runtime change</small>{control && <small className="pd-control-action" title={`Latest app-control action, ${relativeTime(control.at, now)}`}>{control.text}</small>}</div>
          <div className="pd-actions" role="cell">
            <button type="button" title={`Open ${process.title}${facts.snapshot?.items.length ? ' history' : ' tab'}`} onClick={() => focus(process)}>{facts.snapshot?.items.length ? <History size={13} /> : <ArrowUpRight size={13} />}<span>Open</span></button>
            {canReconnect && <button type="button" className="reconnect" disabled={reconnecting === process.id} title="Reconnect this saved conversation intentionally" onClick={() => void reconnect(process, facts)}><Play size={12} /><span>{reconnecting === process.id ? 'Connecting' : 'Reconnect'}</span></button>}
          </div>
        </article>
      })}
      </section>)}
      {!rows.length && <div className="pd-empty"><Clock3 size={18} /><strong>No recent or active runtimes</strong><small>{dashboard.hiddenOlder ? 'Older settled work is available on demand.' : 'Started conversations and terminals will appear here.'}</small></div>}
      <div className="pd-older-controls">
        {olderLimit === 0 && <button type="button" onClick={() => setOlderLimit(25)}>Show older</button>}
        {olderLimit > 0 && dashboard.hiddenOlder > 0 && <button type="button" onClick={() => setOlderLimit(limit => limit + 25)}>Show more <span>{Math.min(25, dashboard.hiddenOlder)} of {dashboard.hiddenOlder}</span></button>}
        {olderLimit > 0 && <button type="button" className="quiet" onClick={() => setOlderLimit(0)}>Hide older</button>}
      </div>
    </div>

    {dashboard.collaboration.presence.length > 0 && <section className="pd-presence">
      <header><Link2 size={13} /><strong>Files being coordinated</strong><span>reported project intent</span></header>
      <div>{dashboard.collaboration.presence.slice(0, 8).map(presence => {
        const row = rows.find(item => item.process.id === presence.agentSessionId)
        return <article key={presence.id} className={presence.state} title={presence.detail}><span>{presence.intent}</span><strong>{presence.path}</strong><small>{row?.process.title ?? presence.agentSessionId}</small></article>
      })}</div>
    </section>}
    {(counts.attention > 0 || counts.paused > 0) && <footer className="pd-footer"><AlertCircle size={13} /><span>{counts.attention ? `${counts.attention} runtime${counts.attention === 1 ? '' : 's'} waiting for you.` : ''}{counts.attention && counts.paused ? ' ' : ''}{counts.paused ? `${counts.paused} paused by a reported limit.` : ''}</span>{counts.paused > 0 && <PauseCircle size={12} />}</footer>}
  </div>
}
