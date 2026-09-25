import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Pause, Play, Rocket, Square, X } from 'lucide-react'
import { IDEA_RUN_FINAL, type IdeaRun } from '../../../../shared/idea-runs'
import { actionLabel, canStartRun, currentRun, runStatusLabel, stageLine } from './idea-run-model'

type Busy = 'start' | 'approve' | 'pause' | 'resume' | 'stop' | `decide:${string}` | null

/**
 * "Run this idea" (docs/idea-autopilot.md): starts a durable idea run in the chosen project, shows
 * the plan for approval, the stages as they go, and every checkpoint with the exact action and
 * Approve / Deny / Always approve. The phone answers the same checkpoints (#/idea-runs).
 */
export function IdeaRunPanel({ ideaId, projectId }: { ideaId: string; projectId: string }): React.JSX.Element {
  // Absent in a static render (IdeaDetailPanel.test.ts); the panel then shows nothing.
  const bridge = typeof window === 'undefined' ? undefined : window.conductor?.ideaRuns
  const [runs, setRuns] = useState<IdeaRun[]>([])
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [planner, setPlanner] = useState<'claude' | 'codex'>('claude')
  const [dryRun, setDryRun] = useState(false)

  const load = useCallback(() => { if (bridge) void bridge.list({ ideaId }).then(setRuns).catch(reason => setError(String(reason?.message ?? reason))) }, [bridge, ideaId])
  useEffect(() => {
    if (!bridge) return
    load()
    return bridge.onChanged(change => { if (change.ideaId === ideaId) load() })
  }, [bridge, ideaId, load])

  const act = async (kind: Exclude<Busy, null>, work: () => Promise<unknown>): Promise<void> => {
    setBusy(kind); setError(null)
    try { await work(); load() } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)) } finally { setBusy(null) }
  }
  const spin = (kind: Busy): React.JSX.Element | null => busy === kind ? <Loader2 size={12} className="ideas-spin" /> : null
  const run = currentRun(runs)
  if (!bridge) return <></>

  return (
    <section className="ideas-panel-section idea-run-panel" aria-label="Idea autopilot">
      <h4 className="idea-run-title"><Rocket size={12} /> Autopilot{run && <span className={`ideas-status idea-run-status status-${run.status}`}>{runStatusLabel(run)}</span>}</h4>
      {canStartRun(runs) && (
        <>
          <p className="ideas-muted">A frontier model writes a staged plan with done-criteria and budgets. Nothing runs until you approve it; accounts, posts, messages and purchases always wait for you.</p>
          <div className="ideas-action-row">
            <select aria-label="Planner" value={planner} onChange={event => setPlanner(event.target.value as 'claude' | 'codex')}>
              <option value="claude">Claude Opus plans</option>
              <option value="codex">Codex Astra plans</option>
            </select>
            <label className="idea-run-dry"><input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} /> Dry run</label>
            <button className="primary" disabled={busy !== null || !projectId} onClick={() => void act('start', () => bridge.start({ ideaId, projectId, planner: { provider: planner }, dryRun }))} title="Plan this idea as a durable run in the chosen project">
              {spin('start') ?? <Rocket size={13} />} Run this idea
            </button>
          </div>
        </>
      )}
      {error && <p className="idea-run-error" role="alert">{error}</p>}
      {run && <IdeaRunDetail run={run} busy={busy} spin={spin} act={act} bridge={bridge} />}
    </section>
  )
}

function IdeaRunDetail({ run, busy, spin, act, bridge }: {
  run: IdeaRun; busy: Busy; spin(kind: Busy): React.JSX.Element | null
  act(kind: Exclude<Busy, null>, work: () => Promise<unknown>): Promise<void>; bridge: Window['conductor']['ideaRuns']
}): React.JSX.Element {
  const pending = run.checkpoints.filter(checkpoint => checkpoint.status === 'pending')
  const answered = run.checkpoints.filter(checkpoint => checkpoint.status !== 'pending').slice(-5).reverse()
  const final = IDEA_RUN_FINAL.has(run.status)
  const stages = run.stages.length ? run.stages : null
  return (
    <div className="idea-run-detail" data-run-id={run.id} data-status={run.status}>
      {run.reason && <p className="idea-run-reason">{run.reason}</p>}
      {run.plan && <p className="idea-run-summary">{run.plan.summary}</p>}
      {run.plan && run.plan.warnings.length > 0 && <ul className="idea-run-warnings">{run.plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {!stages && run.plan && (
        <ol className="idea-run-stages">
          {run.plan.stages.map(stage => (
            <li key={stage.id}>
              <strong>{stage.title}</strong> <span className="ideas-status">{stage.kind}</span>
              <p>{stage.goal}</p>
              <small>Done when: {stage.doneCriteria.join('; ')}</small>
              <small>{stage.agent.provider} {stage.agent.model} · {stage.budget.maxMinutes} min · {stage.budget.maxTurns} turns · €{stage.budget.maxEur.toFixed(2)}{stage.checkpoints.length ? ` · asks you before: ${stage.checkpoints.map(actionLabel).join(', ')}` : ''}{stage.recurrence ? ` · every ${stage.recurrence.everyMinutes} min × ${stage.recurrence.times} (loop: ${stage.recurrence.loop.steps.map(step => step.id).join(' → ')})` : ''}</small>
            </li>
          ))}
        </ol>
      )}
      {stages && (
        <ol className="idea-run-stages">
          {stages.map(stage => (
            <li key={stage.id} className={`stage-${stage.status}`} data-stage-id={stage.id}>
              <strong>{stage.title}</strong>
              <small>{stageLine(stage)}</small>
              {stage.summary && <p>{stage.summary}</p>}
            </li>
          ))}
        </ol>
      )}
      {pending.map(checkpoint => (
        <div key={checkpoint.id} className="idea-run-checkpoint" data-checkpoint-id={checkpoint.id}>
          <p className="idea-run-checkpoint-head"><strong>{actionLabel(checkpoint.action.type)}</strong>{run.dryRun && <span className="ideas-status">dry run</span>}</p>
          <p>{checkpoint.action.summary}{checkpoint.action.target ? ` → ${checkpoint.action.target}` : ''}{checkpoint.action.amountEur ? ` (€${checkpoint.action.amountEur.toFixed(2)})` : ''}</p>
          <pre className="idea-run-action-detail">{checkpoint.action.detail}</pre>
          <div className="ideas-action-row">
            <button className="primary" data-decision="approve" disabled={busy !== null} onClick={() => void act(`decide:${checkpoint.id}`, () => bridge.decide({ checkpointId: checkpoint.id, decision: 'approve' }))}>{spin(`decide:${checkpoint.id}`) ?? <Check size={12} />} Approve</button>
            <button className="danger" data-decision="deny" disabled={busy !== null} onClick={() => void act(`decide:${checkpoint.id}`, () => bridge.decide({ checkpointId: checkpoint.id, decision: 'deny' }))}><X size={12} /> Deny</button>
            <button data-decision="standing" disabled={busy !== null} onClick={() => void act(`decide:${checkpoint.id}`, () => bridge.decide({ checkpointId: checkpoint.id, decision: 'approve', standing: true }))} title="Approve this and every later action of the same type in this run">Always approve {actionLabel(checkpoint.action.type).toLowerCase()}</button>
          </div>
        </div>
      ))}
      {answered.length > 0 && (
        <ul className="idea-run-answered">
          {answered.map(checkpoint => <li key={checkpoint.id}>{checkpoint.status === 'approved' ? 'Approved' : 'Denied'}: {checkpoint.action.summary} <small>({checkpoint.decidedBy})</small></li>)}
        </ul>
      )}
      {run.rules.length > 0 && <p className="ideas-muted">Standing rules: {run.rules.map(rule => `always ${rule.decision} ${actionLabel(rule.actionType).toLowerCase()}`).join('; ')}</p>}
      {!final && (
        <div className="ideas-action-row">
          {run.status === 'awaiting-approval' && <button className="primary" disabled={busy !== null} onClick={() => void act('approve', () => bridge.approve(run.id))}>{spin('approve') ?? <Check size={12} />} Approve plan</button>}
          {(run.status === 'running' || run.status === 'waiting-owner' || run.status === 'planning') && <button disabled={busy !== null} onClick={() => void act('pause', () => bridge.pause(run.id))}>{spin('pause') ?? <Pause size={12} />} Pause</button>}
          {run.status === 'paused' && <button disabled={busy !== null} onClick={() => void act('resume', () => bridge.resume(run.id))}>{spin('resume') ?? <Play size={12} />} Resume</button>}
          <button className="danger" disabled={busy !== null} onClick={() => { if (window.confirm('Stop this idea run for good?')) void act('stop', () => bridge.stop(run.id)) }}>{spin('stop') ?? <Square size={12} />} Stop</button>
        </div>
      )}
    </div>
  )
}
