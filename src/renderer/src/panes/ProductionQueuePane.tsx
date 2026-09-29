import { useCallback, useEffect, useState } from 'react'
import type { ProductionBridge, ProductionQueueEntry } from '../../../shared/production'
import { GateBadge } from '../components/production/GateBadge'
import { errorText, formatTime, orderQueue, progressText } from '../components/production/production-model'
import { OPEN_PRODUCTION_EVENT } from '../components/ProductionPane'
import '../components/ProductionPane.css'

/**
 * The aggregate production queue (docs/production-agent.md section 9): one row per project the
 * owner designated production-ready, the ones that need attention first (BLOCKED, NEEDS_REVIEW,
 * STALE). A row switches to that project and opens its Production drawer.
 */

const POLL_WHILE_RUNNING_MS = 1_500

export function ProductionQueueView({ entries, currentProjectId, onOpen }: {
  entries: ProductionQueueEntry[]
  currentProjectId: string | null
  onOpen(projectId: string): void
}): React.JSX.Element {
  if (!entries.length) return <p className="production-muted">No project is designated production-ready. Open a project’s Production panel, add its environment and tick Production-ready.</p>
  return <table className="production-table production-queue">
    <thead><tr><th>Project</th><th>Audit state</th><th>Open critical / high</th><th>Questions</th><th>Active run</th><th>Last completed</th></tr></thead>
    <tbody>{orderQueue(entries).map(entry => <tr key={entry.projectId} data-project-id={entry.projectId} data-state={entry.gate.state}
      className={entry.projectId === currentProjectId ? 'current' : ''} tabIndex={0} role="button" aria-label={`Open Production for ${entry.projectName}`}
      onClick={() => onOpen(entry.projectId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(entry.projectId) } }}>
      <td><strong>{entry.projectName}</strong></td>
      <td><GateBadge gate={entry.gate} compact />{entry.gate.reasons[0] && <small>{entry.gate.reasons[0]}</small>}</td>
      <td data-fact="critical-high">{entry.openFindings.critical} / {entry.openFindings.high}</td>
      <td data-fact="questions">{entry.openQuestions}</td>
      <td>{entry.activeRun ? <small>{entry.activeRun.kind} {entry.activeRun.status} · {progressText(entry.activeRun)}</small> : <small className="production-muted">none</small>}</td>
      <td><small>{formatTime(entry.lastCompletedAt)}</small></td>
    </tr>)}</tbody>
  </table>
}

export function ProductionQueuePane({ currentProjectId = null, bridge = window.conductor.production }: { currentProjectId?: string | null; bridge?: ProductionBridge }): React.JSX.Element {
  const [entries, setEntries] = useState<ProductionQueueEntry[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setEntries(await bridge.queue()); setError('') }
    catch (reason) { setError(errorText(reason)) }
  }, [bridge])
  useEffect(() => { void load() }, [load])
  useEffect(() => bridge.onChanged(() => void load()), [bridge, load])
  const running = Boolean(entries?.some(entry => entry.activeRun))
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => void load(), POLL_WHILE_RUNNING_MS)
    return () => window.clearInterval(timer)
  }, [running, load])
  return <div className="production-pane production-queue-pane">
    <header className="production-header"><h2>Production queue</h2></header>
    {error && <p className="production-error" role="alert">{error}</p>}
    {entries
      ? <ProductionQueueView entries={entries} currentProjectId={currentProjectId}
          onOpen={projectId => window.dispatchEvent(new CustomEvent(OPEN_PRODUCTION_EVENT, { detail: { projectId } }))} />
      : !error && <p className="production-muted">Loading the production queue…</p>}
  </div>
}
