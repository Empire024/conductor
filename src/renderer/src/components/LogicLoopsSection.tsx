import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { LogicLoopsSnapshot } from '../../../shared/logic-loops'
import './LogicLoopsSection.css'

const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`
}

/**
 * Logic loops (docs/logic-loops.md): the saved, versioned procedures agents run, measure and
 * propose refinements to. Mounted in both the Scheduled tasks and Project tasks panels, since
 * loops have no sidebar tab of their own. Renders nothing once loaded if the project has none.
 */
export function LogicLoopsSection({ projectId }: { projectId: string }): React.JSX.Element | null {
  // window.conductor is only reached from inside effects and handlers, never at the top of the
  // render body: this component is mounted from ProjectBacklogPane, which a Node-environment test
  // renders with renderToStaticMarkup, where no window exists at all.
  const [snapshot, setSnapshot] = useState<LogicLoopsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => { window.conductor.logicLoops.snapshot(projectId).then(setSnapshot).catch(reason => setError(errorText(reason))) }, [projectId])
  useEffect(() => { setSnapshot(null); setError(''); load() }, [projectId, load])
  useEffect(() => window.conductor.logicLoops.onChanged(changed => { if (changed === projectId) load() }), [load, projectId])

  const act = (key: string, action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(key); setError('')
    action().then(load, reason => setError(errorText(reason))).finally(() => setBusy(''))
  }

  if (!snapshot || !snapshot.loops.length) return null

  return <section className="logic-loops-section" aria-label="Logic loops">
    <button type="button" className="logic-loops-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Logic loops <span>{snapshot.loops.length}</span>
      {snapshot.proposals.some(proposal => proposal.status === 'pending') && <span className="logic-loops-pending-dot" title="A proposal is waiting for review" />}
    </button>
    {error && <p className="logic-loops-error" role="alert">{error}</p>}
    {open && <div className="logic-loops-list">
      {snapshot.loops.map(loop => {
        const runs = snapshot.runs[loop.id] ?? []
        const proposals = snapshot.proposals.filter(entry => entry.loopId === loop.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        const pending = proposals.filter(entry => entry.status === 'pending')
        const decided = proposals.filter(entry => entry.status !== 'pending').slice(0, 3)
        return <div className="logic-loop-card" key={loop.id}>
          <header><strong>{loop.title}</strong><span className="logic-loop-version">v{loop.version}</span></header>
          {runs.length > 0 ? <ul className="logic-loop-runs">
            {runs.map(run => <li key={run.id}>
              <span className="logic-loop-run-time">{new Date(run.createdAt).toLocaleString()}</span>
              <span className="logic-loop-run-steps">
                {run.steps.length ? run.steps.map(step => <span key={step.id} className={'logic-loop-step' + (step.outcome === 'success' ? ' is-success' : ' is-failure')} title={step.note ?? ''}>
                  {step.stepId} · {step.model} · {formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))} · {step.outcome}
                </span>) : <span className="logic-loop-step-empty">no steps recorded yet</span>}
              </span>
            </li>)}
          </ul> : <p className="logic-loop-empty">No recorded runs yet.</p>}
          {pending.map(proposal => <div className="logic-loop-proposal" key={proposal.id}>
            <p className="logic-loop-proposal-evidence">{proposal.evidence}</p>
            <details><summary>Proposed change{proposal.metric ? ` (tracks ${proposal.metric})` : ''}</summary><pre>{proposal.change}</pre></details>
            <div className="logic-loop-proposal-actions">
              <button type="button" disabled={Boolean(busy)} onClick={() => act('apply:' + proposal.id, () => window.conductor.logicLoops.apply(projectId, proposal.id))}>{busy === 'apply:' + proposal.id ? 'Applying…' : 'Apply'}</button>
              <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => act('reject:' + proposal.id, () => window.conductor.logicLoops.reject(projectId, proposal.id))}>{busy === 'reject:' + proposal.id ? 'Rejecting…' : 'Reject'}</button>
            </div>
          </div>)}
          {decided.length > 0 && <ul className="logic-loop-history">
            {decided.map(proposal => <li key={proposal.id}>{proposal.status}{proposal.appliedVersion ? ` → v${proposal.appliedVersion}` : ''}{proposal.revertReason ? `: ${proposal.revertReason}` : ''}</li>)}
          </ul>}
        </div>
      })}
    </div>}
  </section>
}
