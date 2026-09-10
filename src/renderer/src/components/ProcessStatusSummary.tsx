import { useEffect, useMemo, useState } from 'react'
import { Flame, Gauge } from 'lucide-react'
import type { ProjectRecord, RuntimeProcessSummary } from '../../../shared/models'
import { summarizeUsageRun, type UsageCapSetting, type UsageScopeReport } from '../../../shared/usage-accounting'
import { evaluateUsageWarning, type UsageWarningLevel } from '../../../shared/usage-warning'
import './ProcessStatusSummary.css'

export interface ProcessUsage { costUsd?: number; totalTokens?: number; warning?: UsageWarningLevel }
export interface ProjectProcessUsage {
  projectId: string
  projectName: string
  running: number
  costUsd: number
  totalTokens: number
  /** Highest warning level among this project's processes, so one expensive tab surfaces the
   *  whole project row instead of averaging away with the rest of its usage. */
  warning?: UsageWarningLevel
  /** Titles of the processes that triggered it, for a tooltip naming which tab(s). */
  expensiveTitles: string[]
}

/** A process counts as moving for the same reason ProcessDashboardPane's "In progress" section
 *  does: actually producing output right now, not merely connected and idle. */
const isRunning = (process: RuntimeProcessSummary): boolean =>
  !process.needsInput && (process.status === 'starting' || process.activityPhase === 'working' || process.activityPhase === 'limited')

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
      running: 0,
      costUsd: 0,
      totalTokens: 0,
      expensiveTitles: []
    }
    if (isRunning(process)) entry.running += 1
    const usage = usageByProcessId.get(process.id)
    entry.costUsd += usage?.costUsd ?? 0
    entry.totalTokens += usage?.totalTokens ?? 0
    if (usage?.warning) { entry.warning = strongerWarning(entry.warning, usage.warning); entry.expensiveTitles.push(process.title) }
    totals.set(process.projectId, entry)
  }
  // A project with an expensive tab leads regardless of its raw totals -- that is the one
  // thing this corner exists to surface at a glance -- then the existing busiest-first order.
  const warningScore = (level: UsageWarningLevel | undefined): number => level ? warningRank[level] : 0
  return [...totals.values()].sort((left, right) =>
    (warningScore(right.warning) - warningScore(left.warning)) ||
    (right.running - left.running) || (right.costUsd - left.costUsd) || (right.totalTokens - left.totalTokens))
}

const tokenLabel = (totalTokens: number): string =>
  totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(totalTokens >= 10_000 ? 0 : 1)}k tok` : `${totalTokens} tok`

/** Computes the same thing the tab-level warning does, per running process: the conversation's
 *  own report and whichever cap actually applies to it (tab, then workspace, then default). */
async function loadProcessUsage(process: RuntimeProcessSummary): Promise<readonly [string, ProcessUsage | undefined]> {
  try {
    const [snapshot, caps] = await Promise.all([
      window.conductor.structured.snapshot(process.id),
      window.conductor.usageCaps.read(process.id, process.sessionId)
    ])
    if (!snapshot) return [process.id, undefined] as const
    const report: UsageScopeReport = summarizeUsageRun(snapshot.items).conversation
    const cap: UsageCapSetting | null = caps.effective?.setting ?? null
    return [process.id, { costUsd: report.costUsd, totalTokens: report.tokens?.totalTokens, warning: evaluateUsageWarning(report, cap)?.level }] as const
  } catch {
    return [process.id, undefined] as const
  }
}

/** Ultra-minified replacement for the old static "Local status / Local workspace" footer: this is
 *  a status bar corner, not a panel, so it shows only aggregate counts and cost per project and
 *  hands off to ProcessDashboardPane (via onOpen) for anything more detailed. */
export function ProcessStatusSummary({ projects, onOpen }: { projects: ProjectRecord[]; onOpen(): void }): React.JSX.Element {
  const [processes, setProcesses] = useState<RuntimeProcessSummary[]>([])
  const [usageByProcessId, setUsageByProcessId] = useState<Map<string, ProcessUsage>>(new Map())

  useEffect(() => {
    let active = true
    const load = (): void => {
      void window.conductor.agents.listProcesses().then((items) => {
        if (!active) return
        setProcesses(items)
        void Promise.all(items.filter((item) => item.kind === 'agent').map(loadProcessUsage)).then((entries) => {
          if (!active) return
          setUsageByProcessId(new Map(entries.filter((entry): entry is [string, ProcessUsage] => Boolean(entry[1]))))
        })
      })
    }
    load()
    const timer = window.setInterval(load, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const perProject = useMemo(
    () => aggregateProjectProcessUsage(processes, projects, usageByProcessId),
    [processes, projects, usageByProcessId]
  )
  const running = perProject.reduce((sum, entry) => sum + entry.running, 0)
  const costUsd = perProject.reduce((sum, entry) => sum + entry.costUsd, 0)
  const expensive = perProject.filter((entry) => entry.warning)
  const visible = perProject.filter((entry) => entry.running > 0 || entry.costUsd > 0 || entry.totalTokens > 0)
  const expensiveLevel: UsageWarningLevel | undefined = expensive.some((entry) => entry.warning === 'high') ? 'high' : expensive.length ? 'approaching' : undefined

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
        {expensiveLevel && (
          <span
            className={`process-status-summary-warning level-${expensiveLevel}`}
            title={`Getting expensive: ${expensive.flatMap((entry) => entry.expensiveTitles).join(', ')}`}
          >
            <Flame size={10} strokeWidth={2} />
          </span>
        )}
        <span className={running ? 'process-status-summary-running' : ''}><i /> {running}</span>
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
                {entry.totalTokens > 0 ? tokenLabel(entry.totalTokens) : entry.running > 0 ? `${entry.running} running` : 'idle'}
              </span>
            </div>
          ))}
        </div>
      )}
      {visible.length === 0 && <div className="process-status-summary-rows"><div className="process-status-summary-row process-status-summary-empty"><span>Nothing running</span></div></div>}
    </div>
  )
}
