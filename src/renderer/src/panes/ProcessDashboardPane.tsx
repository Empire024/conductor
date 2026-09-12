import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowUpRight, Bot, Clock3, Gauge, History, Link2, PauseCircle, Play, TerminalSquare } from 'lucide-react'
import type { AgentProviderInfo, ProjectRecord, RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection } from '../../../shared/structured-agent'
import type { AgentCollaborationSnapshot } from '../../../shared/agent-collaboration'
import { summarizeUsageRun, type UsageScopeReport } from '../../../shared/usage-accounting'
import { evaluateUsageWarning, type UsageWarningLevel } from '../../../shared/usage-warning'
import { processModelLabel } from '../agent-models'
import { createSerialPoller, currentTurnStartedAt, durationLabel, processTrackerState, reportedPlanProgress, type ProcessTrackerState } from './ProcessDashboardPane.helpers'
import './ProcessDashboardPane.css'

interface ProcessFacts {
  snapshot?: SessionProjection
  usage?: UsageScopeReport
  warning?: UsageWarningLevel
}
interface DashboardSnapshot {
  processes: RuntimeProcessSummary[]
  collaboration: AgentCollaborationSnapshot
  facts: Map<string, ProcessFacts>
  observedAt: number
}

const emptyDashboard = (): DashboardSnapshot => ({ processes: [], collaboration: { messages: [], presence: [] }, facts: new Map(), observedAt: Date.now() })
const relativeTime = (timestamp: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}
const tokenLabel = (tokens: number): string => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}m` : tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens)
const stateLabel: Record<ProcessTrackerState, string> = {
  attention: 'Needs input', working: 'Working', paused: 'Limit pause', disconnected: 'Disconnected', ready: 'Connected · idle', finished: 'Finished'
}
const stateRank: Record<ProcessTrackerState, number> = { attention: 0, working: 1, paused: 2, disconnected: 3, ready: 4, finished: 5 }

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
  const [dashboard, setDashboard] = useState<DashboardSnapshot>(emptyDashboard)
  const [providers, setProviders] = useState<AgentProviderInfo[]>([])
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
      const [processes, collaboration] = await Promise.all([
        window.conductor.agents.listProcesses(project.id),
        window.conductor.collaboration.snapshot({ projectId: project.id, limit: 30 })
      ])
      const facts = new Map(await Promise.all(processes.map(readFacts)))
      return { processes, collaboration, facts, observedAt: Date.now() }
    }, value => { setDashboard(value); setNow(value.observedAt); setError('') })
    const refresh = (): void => { void poller.run().catch(reason => { if (active) setError(`Process refresh failed: ${reason instanceof Error ? reason.message : String(reason)}`) }) }
    refresh()
    const timer = window.setInterval(() => { setNow(Date.now()); if (!document.hidden) refresh() }, 2500)
    return () => { active = false; poller.dispose(); window.clearInterval(timer) }
  }, [project.id])

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
  }, { attention: 0, working: 0, paused: 0, disconnected: 0, ready: 0, finished: 0 } as Record<ProcessTrackerState, number>), [rows])
  const totalUsage = useMemo(() => [...dashboard.facts.values()].reduce((total, facts) => ({
    tokens: total.tokens + (facts.usage?.tokens?.totalTokens ?? 0),
    cost: total.cost + (facts.usage?.costUsd ?? 0)
  }), { tokens: 0, cost: 0 }), [dashboard.facts])

  const focus = (process: RuntimeProcessSummary): void => { window.dispatchEvent(new CustomEvent('conductor:focus-process', { detail: process })) }
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
      <div><Gauge size={20} /><span><strong>Processes</strong><small>Observed runtime facts · {project.name}</small></span></div>
      <span className="pd-observed"><i /> Updated {relativeTime(new Date(dashboard.observedAt).toISOString(), now)}</span>
    </header>
    <section className="pd-overview" aria-label="Project process summary">
      <span className={counts.working ? 'working' : ''}><b>{counts.working}</b><small>Working now</small></span>
      <span className={counts.attention ? 'attention' : ''}><b>{counts.attention}</b><small>Need you</small></span>
      <span><b>{counts.paused}</b><small>Limit paused</small></span>
      <span><b>{counts.disconnected}</b><small>Disconnected</small></span>
      <span><b>{tokenLabel(totalUsage.tokens)}</b><small>Reported tokens</small></span>
      <span><b>{totalUsage.cost ? `$${totalUsage.cost < 10 ? totalUsage.cost.toFixed(2) : totalUsage.cost.toFixed(0)}` : '—'}</b><small>Estimated cost</small></span>
    </section>

    {error && <p className="pd-error" role="alert">{error}</p>}
    <div className="pd-table" role="table" aria-label="Project runtimes">
      <div className="pd-table-head" role="row"><span>Runtime</span><span>State</span><span>Progress</span><span>Usage</span><span>Activity</span><span /></div>
      {rows.map(({ process, facts, state }) => {
        const finishedExecution = state === 'disconnected' && processTrackerState(process) === 'finished'
        const plan = reportedPlanProgress(facts.snapshot)
        const turnTime = durationLabel(currentTurnStartedAt(facts.snapshot), now)
        const reportedModel = facts.snapshot?.settings.model ? new Map([[process.id, facts.snapshot.settings.model]]) : new Map<string, string>()
        const model = process.kind === 'agent' ? processModelLabel(process, providers, reportedModel) : undefined
        const usageTokens = facts.usage?.tokens?.totalTokens
        const canReconnect = state === 'disconnected' && Boolean(facts.snapshot?.capabilities?.resume && facts.snapshot.nativeSessionId && !facts.snapshot.archived)
        const RuntimeIcon = process.kind === 'agent' ? Bot : TerminalSquare
        return <article key={process.id} role="row" data-process-id={process.id} className={`pd-row state-${state}`} onDoubleClick={() => focus(process)}>
          <div className="pd-runtime" role="cell"><span className="pd-runtime-icon"><RuntimeIcon size={15} /></span><span><strong>{process.title}</strong><small>{process.kind === 'agent' ? `${process.provider ?? 'agent'} · ${model ?? 'model unavailable'}` : 'PowerShell process'}</small></span></div>
          <div className="pd-state" role="cell"><span className={`pd-state-marker ${state}`} title={`${stateLabel[state]}. ${state === 'ready' ? 'The adapter is connected but no turn is working.' : state === 'disconnected' ? 'Conversation history remains available; reconnect only when you choose.' : 'Reported by the runtime.'}`} /><span><strong>{stateLabel[state]}</strong>{finishedExecution ? <small>Last execution finished</small> : turnTime && state === 'working' ? <small>Latest prompt {turnTime} ago</small> : null}</span></div>
          <div className="pd-progress-cell" role="cell">{plan ? <><span>{plan.label}</span><progress max={plan.total} value={plan.completed} aria-label={`${process.title}: ${plan.label}`} /></> : <span className="pd-unreported">No plan reported</span>}</div>
          <div className={`pd-usage${facts.warning ? ` warning-${facts.warning}` : ''}`} role="cell" title={facts.warning ? `${process.title} usage is ${facts.warning === 'high' ? 'high' : 'rising'}` : undefined}><strong>{usageTokens === undefined ? '—' : `${tokenLabel(usageTokens)} tok`}</strong><small>{facts.usage?.costUsd ? `$${facts.usage.costUsd.toFixed(2)}` : 'No cost reported'}</small></div>
          <div className="pd-activity" role="cell"><strong>{relativeTime(process.updatedAt, now)}</strong><small>Last runtime change</small></div>
          <div className="pd-actions" role="cell">
            <button type="button" title={`Open ${process.title}${facts.snapshot?.items.length ? ' history' : ' tab'}`} onClick={() => focus(process)}>{facts.snapshot?.items.length ? <History size={13} /> : <ArrowUpRight size={13} />}<span>Open</span></button>
            {canReconnect && <button type="button" className="reconnect" disabled={reconnecting === process.id} title="Reconnect this saved conversation intentionally" onClick={() => void reconnect(process, facts)}><Play size={12} /><span>{reconnecting === process.id ? 'Connecting' : 'Reconnect'}</span></button>}
          </div>
        </article>
      })}
      {!rows.length && <div className="pd-empty"><Clock3 size={18} /><strong>No retained runtimes</strong><small>Started conversations and terminals will appear here.</small></div>}
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
