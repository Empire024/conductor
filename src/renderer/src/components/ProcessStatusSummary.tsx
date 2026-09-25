import { useEffect, useMemo, useState } from 'react'
import { Flame, Gauge } from 'lucide-react'
import type { ProjectRecord, RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection } from '../../../shared/structured-agent'
import { processedTokens, summarizeUsageRun, type UsageCapSetting, type UsageScopeReport } from '../../../shared/usage-accounting'
import { evaluateUsageWarning, type UsageWarningLevel } from '../../../shared/usage-warning'
import { createSerialPoller, processTrackerState, type SerialPoller } from '../panes/ProcessDashboardPane.helpers'
import './ProcessStatusSummary.css'
import { WeeklyUsage } from './WeeklyUsage'

export interface ProcessUsage { costUsd?: number; totalTokens?: number; warning?: UsageWarningLevel; snapshotPhase?: SessionProjection['phase'] }
export interface ProcessSummaryFreshness { label: 'Stale'; title: string }
export interface ProjectProcessUsage {
  projectId: string
  projectName: string
  processes: number
  running: number
  attention: number
  paused: number
  disconnected: number
  costUsd: number
  totalTokens: number
  /** Highest warning level among this project's processes, so one expensive tab surfaces the
   *  whole project row instead of averaging away with the rest of its usage. */
  warning?: UsageWarningLevel
  /** Titles of the processes that triggered it, for a tooltip naming which tab(s). */
  expensiveTitles: string[]
}

const warningRank: Record<UsageWarningLevel, number> = { approaching: 1, high: 2 }
const strongerWarning = (a: UsageWarningLevel | undefined, b: UsageWarningLevel | undefined): UsageWarningLevel | undefined =>
  !a ? b : !b ? a : warningRank[a] >= warningRank[b] ? a : b

/** One line per project: how many of its processes are moving right now, what they have spent,
 *  and whether any of them is getting expensive, so the owner can watch every project's burn at
 *  once instead of opening each in turn. */
export function aggregateProjectProcessUsage(
  processes: readonly RuntimeProcessSummary[],
  projects: ReadonlyArray<Pick<ProjectRecord, 'id' | 'name'>>,
  usageByProcessId: ReadonlyMap<string, ProcessUsage>
): ProjectProcessUsage[] {
  const names = new Map(projects.map((project) => [project.id, project.name]))
  const totals = new Map<string, ProjectProcessUsage>()
  for (const process of processes) {
    const entry = totals.get(process.projectId) ?? {
      projectId: process.projectId,
      projectName: names.get(process.projectId) ?? 'Unknown project',
      processes: 0,
      running: 0,
      attention: 0,
      paused: 0,
      disconnected: 0,
      costUsd: 0,
      totalTokens: 0,
      expensiveTitles: []
    }
    entry.processes += 1
    const usage = usageByProcessId.get(process.id)
    const state = processTrackerState(process, usage?.snapshotPhase ? { phase: usage.snapshotPhase } : undefined)
    // A viewing agent's own background tasks are still running: it counts as running, not done.
    if (state === 'working' || state === 'viewing') entry.running += 1
    if (state === 'attention') entry.attention += 1
    if (state === 'paused') entry.paused += 1
    if (state === 'disconnected') entry.disconnected += 1
    entry.costUsd += usage?.costUsd ?? 0
    entry.totalTokens += usage?.totalTokens ?? 0
    if (state === 'working' && (!usage?.snapshotPhase || usage.snapshotPhase === 'running') && usage?.warning) { entry.warning = strongerWarning(entry.warning, usage.warning); entry.expensiveTitles.push(process.title) }
    totals.set(process.projectId, entry)
  }
  // A project with an expensive tab leads regardless of its raw totals -- that is the one
  // thing this corner exists to surface at a glance -- then the existing busiest-first order.
  const warningScore = (level: UsageWarningLevel | undefined): number => level ? warningRank[level] : 0
  return [...totals.values()].sort((left, right) =>
    (warningScore(right.warning) - warningScore(left.warning)) ||
    (right.attention - left.attention) || (right.running - left.running) || (right.costUsd - left.costUsd) || (right.totalTokens - left.totalTokens))
}

const tokenLabel = (totalTokens: number): string =>
  totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(totalTokens >= 10_000 ? 0 : 1)}k tok` : `${totalTokens} tok`

export function projectTrackerLabel(entry: Pick<ProjectProcessUsage, 'running' | 'attention' | 'paused' | 'disconnected' | 'totalTokens'>): string {
  const state = entry.running > 0 ? `${entry.running} working`
    : entry.attention > 0 ? `${entry.attention} need you`
      : entry.paused > 0 ? `${entry.paused} paused`
        : entry.disconnected > 0 ? `${entry.disconnected} offline`
          : 'idle'
  return entry.totalTokens > 0 ? `${state} · ${tokenLabel(entry.totalTokens)}` : state
}

export function processSummaryFreshness(refreshFailed: boolean, observedAt: number | undefined): ProcessSummaryFreshness | undefined {
  if (!refreshFailed) return undefined
  return {
    label: 'Stale',
    title: observedAt === undefined
      ? 'Process refresh failed; no complete observation is available yet.'
      : `Process refresh failed; showing the last complete observation from ${new Date(observedAt).toLocaleTimeString()}.`
  }
}

export function createProcessSummaryPoller<T>(read: () => Promise<T>, commit: (value: T, observedAt: number) => void, setFailed: (failed: boolean) => void, clock = Date.now): SerialPoller {
  let disposed = false
  const poller = createSerialPoller(async () => ({ value: await read(), observedAt: clock() }), result => {
    commit(result.value, result.observedAt)
    setFailed(false)
  })
  return {
    async run() {
      try { await poller.run() }
      catch { if (!disposed) setFailed(true) }
    },
    dispose() { disposed = true; poller.dispose() }
  }
}

interface ProcessUsageSources {
  snapshot(id: string): Promise<SessionProjection | null | undefined>
  caps(id: string, sessionId: string): Promise<{ effective?: { setting: UsageCapSetting } | null }>
}
/** Computes the same thing the tab-level warning does, per running process: the conversation's
 *  own report and whichever cap actually applies to it (tab, then workspace, then default).
 *  The report is a pass over the conversation's whole projection, received over IPC: tens of
 *  milliseconds of the renderer's main thread for a long one, and polling every tab every few
 *  seconds made typing slower the more tabs were open. It only changes with the conversation's
 *  own events, so it is kept per process until one arrives (`changed`). */
export function createProcessUsageLoader(sources: ProcessUsageSources = {
  snapshot: id => window.conductor.structured.snapshot(id),
  caps: (id, sessionId) => window.conductor.usageCaps.read(id, sessionId)
}) {
  const reports = new Map<string, { report: UsageScopeReport; phase: SessionProjection['phase'] }>()
  // Bumped by every change, so a report fetched while an event arrived is not kept as current.
  const versions = new Map<string, number>()
  return {
    changed(ids: Iterable<string>): void {
      for (const id of ids) { reports.delete(id); versions.set(id, (versions.get(id) ?? 0) + 1) }
    },
    retain(ids: Set<string>): void {
      for (const id of reports.keys()) if (!ids.has(id)) reports.delete(id)
      for (const id of versions.keys()) if (!ids.has(id)) versions.delete(id)
    },
    async load(process: RuntimeProcessSummary): Promise<readonly [string, ProcessUsage | undefined]> {
      try {
        let entry = reports.get(process.id)
        if (!entry) {
          const version = versions.get(process.id)
          // This bounded projection is already required for reported usage. Its phase doubles as the
          // connection-state join, so the mini tracker does not fetch a second or unbounded transcript.
          const snapshot = await sources.snapshot(process.id)
          if (!snapshot) return [process.id, undefined] as const
          entry = { report: summarizeUsageRun(snapshot.items).conversation, phase: snapshot.phase }
          if (versions.get(process.id) === version) reports.set(process.id, entry)
        }
        const { report, phase } = entry
        try {
          const caps = await sources.caps(process.id, process.sessionId)
          const cap: UsageCapSetting | null = caps.effective?.setting ?? null
          return [process.id, { costUsd: report.costUsd, totalTokens: processedTokens(report.tokens), warning: evaluateUsageWarning(report, cap)?.level, snapshotPhase: phase }] as const
        } catch {
          return [process.id, { costUsd: report.costUsd, totalTokens: processedTokens(report.tokens), snapshotPhase: phase }] as const
        }
      } catch {
        return [process.id, undefined] as const
      }
    }
  }
}

/** Ultra-minified replacement for the old static "Local status / Local workspace" footer: this is
 *  a status bar corner, not a panel, so it shows only aggregate counts and cost per project and
 *  hands off to ProcessDashboardPane (via onOpen) for anything more detailed. */
export function ProcessStatusSummary({ projects, onOpen }: { projects: ProjectRecord[]; onOpen(): void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<{ processes: RuntimeProcessSummary[]; usageByProcessId: Map<string, ProcessUsage>; observedAt?: number }>({ processes: [], usageByProcessId: new Map() })
  const [refreshFailed, setRefreshFailed] = useState(false)

  useEffect(() => {
    const usage = createProcessUsageLoader()
    const offEvents = window.conductor.structured.onEvents(events => usage.changed(new Set(events.map(event => event.sessionId))))
    const poller = createProcessSummaryPoller(async () => {
      const processes = await window.conductor.agents.listProcesses()
      const agents = processes.filter(item => item.kind === 'agent')
      usage.retain(new Set(agents.map(item => item.id)))
      const entries = await Promise.all(agents.map(usage.load))
      return { processes, usageByProcessId: new Map(entries.filter((entry): entry is [string, ProcessUsage] => Boolean(entry[1]))) }
    }, (value, observedAt) => setSnapshot({ ...value, observedAt }), setRefreshFailed)
    const refresh = (): void => { void poller.run() }
    refresh()
    const timer = window.setInterval(() => { if (!document.hidden) refresh() }, 4000)
    return () => { poller.dispose(); offEvents(); window.clearInterval(timer) }
  }, [])

  const perProject = useMemo(
    () => aggregateProjectProcessUsage(snapshot.processes, projects, snapshot.usageByProcessId),
    [snapshot, projects]
  )
  const running = perProject.reduce((sum, entry) => sum + entry.running, 0)
  const attention = perProject.reduce((sum, entry) => sum + entry.attention, 0)
  const costUsd = perProject.reduce((sum, entry) => sum + entry.costUsd, 0)
  const expensive = perProject.filter((entry) => entry.warning)
  const visible = perProject.filter((entry) => entry.processes > 0)
  const expensiveLevel: UsageWarningLevel | undefined = expensive.some((entry) => entry.warning === 'high') ? 'high' : expensive.length ? 'approaching' : undefined
  const freshness = processSummaryFreshness(refreshFailed, snapshot.observedAt)

  return (
    <div
      className="process-status-summary"
      role="button"
      tabIndex={0}
      title="Open the process dashboard"
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
    >
      <div className="process-status-summary-head">
        <Gauge size={13} strokeWidth={1.75} />
        <strong>Processes</strong>
        {freshness && <span className="process-status-summary-stale" role="status" title={freshness.title}>{freshness.label}</span>}
        {expensiveLevel && (
          <span
            className={`process-status-summary-warning level-${expensiveLevel}`}
            title={`Getting expensive: ${expensive.flatMap((entry) => entry.expensiveTitles).join(', ')}`}
          >
            <Flame size={10} strokeWidth={2} />
          </span>
        )}
        <span className={running ? 'process-status-summary-running' : ''} title={`${running} working now; connected idle adapters are excluded`}><i /> {running}</span>
        {attention > 0 && <span className="process-status-summary-attention" title={`${attention} runtime${attention === 1 ? '' : 's'} need input`}>{attention} need you</span>}
        {costUsd > 0 && <span className="process-status-summary-cost">${costUsd < 10 ? costUsd.toFixed(2) : costUsd.toFixed(0)}</span>}
      </div>
      {visible.length > 0 && (
        <div className="process-status-summary-rows">
          {visible.slice(0, 3).map((entry) => (
            <div
              key={entry.projectId}
              className={entry.warning ? `process-status-summary-row level-${entry.warning}` : 'process-status-summary-row'}
              title={entry.warning ? `${entry.expensiveTitles.join(', ')} getting expensive` : undefined}
            >
              <span className="ellipsis">{entry.projectName}</span>
              <span>
                {entry.warning && <Flame size={9} className="process-status-summary-flame" aria-hidden="true" />}
                {projectTrackerLabel(entry)}
              </span>
            </div>
          ))}
        </div>
      )}
      {visible.length === 0 && <div className="process-status-summary-rows"><div className="process-status-summary-row process-status-summary-empty"><span>No retained processes</span></div></div>}
      <WeeklyUsage compact />
    </div>
  )
}
