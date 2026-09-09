import { useEffect, useMemo, useState } from 'react'
import { Gauge } from 'lucide-react'
import type { ProjectRecord, RuntimeProcessSummary } from '../../../shared/models'
import { summarizeUsage, type UsageSummary } from '../../../shared/usage-accounting'
import './ProcessStatusSummary.css'

export interface ProjectProcessUsage {
  projectId: string
  projectName: string
  running: number
  costUsd: number
  totalTokens: number
}

/** A process counts as moving for the same reason ProcessDashboardPane's "In progress" section
 *  does: actually producing output right now, not merely connected and idle. */
const isRunning = (process: RuntimeProcessSummary): boolean =>
  !process.needsInput && (process.status === 'starting' || process.activityPhase === 'working' || process.activityPhase === 'limited')

/** One line per project: how many of its processes are moving right now, and what they have
 *  spent, so the owner can watch every project's burn at once instead of opening each in turn. */
export function aggregateProjectProcessUsage(
  processes: readonly RuntimeProcessSummary[],
  projects: ReadonlyArray<Pick<ProjectRecord, 'id' | 'name'>>,
  usageByProcessId: ReadonlyMap<string, { costUsd?: number; totalTokens?: number }>
): ProjectProcessUsage[] {
  const names = new Map(projects.map((project) => [project.id, project.name]))
  const totals = new Map<string, ProjectProcessUsage>()
  for (const process of processes) {
    const entry = totals.get(process.projectId) ?? {
      projectId: process.projectId,
      projectName: names.get(process.projectId) ?? 'Unknown project',
      running: 0,
      costUsd: 0,
      totalTokens: 0
    }
    if (isRunning(process)) entry.running += 1
    const usage = usageByProcessId.get(process.id)
    entry.costUsd += usage?.costUsd ?? 0
    entry.totalTokens += usage?.totalTokens ?? 0
    totals.set(process.projectId, entry)
  }
  return [...totals.values()].sort((left, right) =>
    (right.running - left.running) || (right.costUsd - left.costUsd) || (right.totalTokens - left.totalTokens))
}

const tokenLabel = (totalTokens: number): string =>
  totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(totalTokens >= 10_000 ? 0 : 1)}k tok` : `${totalTokens} tok`

/** Ultra-minified replacement for the old static "Local status / Local workspace" footer: this is
 *  a status bar corner, not a panel, so it shows only aggregate counts and cost per project and
 *  hands off to ProcessDashboardPane (via onOpen) for anything more detailed. */
export function ProcessStatusSummary({ projects, onOpen }: { projects: ProjectRecord[]; onOpen(): void }): React.JSX.Element {
  const [processes, setProcesses] = useState<RuntimeProcessSummary[]>([])
  const [usageByProcessId, setUsageByProcessId] = useState<Map<string, UsageSummary>>(new Map())

  useEffect(() => {
    let active = true
    const load = (): void => {
      void window.conductor.agents.listProcesses().then((items) => {
        if (!active) return
        setProcesses(items)
        void Promise.all(items.filter((item) => item.kind === 'agent').map((item) =>
          window.conductor.structured.snapshot(item.id)
            .then((snapshot) => [item.id, snapshot ? summarizeUsage(snapshot.items) : undefined] as const)
            .catch(() => [item.id, undefined] as const)
        )).then((entries) => {
          if (!active) return
          setUsageByProcessId(new Map(entries.filter((entry): entry is [string, UsageSummary] => Boolean(entry[1]))))
        })
      })
    }
    load()
    const timer = window.setInterval(load, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const usageTotals = useMemo(
    () => new Map([...usageByProcessId].map(([id, usage]) => [id, { costUsd: usage.costUsd, totalTokens: usage.tokens?.totalTokens }])),
    [usageByProcessId]
  )
  const perProject = useMemo(
    () => aggregateProjectProcessUsage(processes, projects, usageTotals),
    [processes, projects, usageTotals]
  )
  const running = perProject.reduce((sum, entry) => sum + entry.running, 0)
  const costUsd = perProject.reduce((sum, entry) => sum + entry.costUsd, 0)
  const visible = perProject.filter((entry) => entry.running > 0 || entry.costUsd > 0 || entry.totalTokens > 0)

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
        <span className={running ? 'process-status-summary-running' : ''}><i /> {running}</span>
        {costUsd > 0 && <span className="process-status-summary-cost">${costUsd < 10 ? costUsd.toFixed(2) : costUsd.toFixed(0)}</span>}
      </div>
      {visible.length > 0 && (
        <div className="process-status-summary-rows">
          {visible.slice(0, 3).map((entry) => (
            <div key={entry.projectId} className="process-status-summary-row">
              <span className="ellipsis">{entry.projectName}</span>
              <span>{entry.totalTokens > 0 ? tokenLabel(entry.totalTokens) : entry.running > 0 ? `${entry.running} running` : 'idle'}</span>
            </div>
          ))}
        </div>
      )}
      {visible.length === 0 && <div className="process-status-summary-rows"><div className="process-status-summary-row process-status-summary-empty"><span>Nothing running</span></div></div>}
    </div>
  )
}
