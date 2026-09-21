import { useCallback, useEffect, useState } from 'react'
import { FileSearch, Play, Plus } from 'lucide-react'
import type { ScheduleDefinition, ScheduleSnapshot } from '../../../shared/schedules'
import './SchedulesPane.css'

const when = (value: string | null): string => value ? new Date(value).toLocaleString() : 'Never'
const stale = (value: string | null): boolean => Boolean(value && Date.parse(value) < Date.now())
function IntervalControl({ schedule, disabled, save }: {schedule:ScheduleDefinition;disabled:boolean;save(value:number):void}): React.JSX.Element {
  const [draft, setDraft] = useState(String(schedule.everyMinutes))
  useEffect(() => setDraft(String(schedule.everyMinutes)), [schedule.everyMinutes])
  const value = Number(draft), valid = Number.isInteger(value) && value >= 5 && value <= 525_600
  return <div className="schedule-interval"><label>Every <input aria-label={`Interval for ${schedule.name}`} type="number" min={5} max={525600} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={() => { if (valid && value !== schedule.everyMinutes) save(value) }}/><span>minutes</span></label><button type="button" disabled={disabled || !valid || value === schedule.everyMinutes} onMouseDown={event => event.preventDefault()} onClick={() => save(value)}>Save</button></div>
}

export function SchedulesPane({ projectId }: {projectId:string}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setSnapshot(await window.conductor.orchestration.schedules.snapshot(projectId)); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }, [projectId])
  useEffect(() => { void load() }, [load])
  useEffect(() => window.conductor.orchestration.schedules.onChanged(changedProjectId => { if (changedProjectId === projectId) void load() }), [load, projectId])
  useEffect(() => {
    if (!snapshot || !Object.values(snapshot.runs).flat().some(run => run.outcome === 'running')) return
    const timer = window.setInterval(() => void load(), 1_500)
    return () => window.clearInterval(timer)
  }, [load, snapshot])

  const act = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError('')
    try { await action(); await load() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy('') }
  }
  const update = (schedule: ScheduleDefinition, patch: {enabled?:boolean;everyMinutes?:number}): Promise<void> =>
    act(schedule.id, () => window.conductor.orchestration.schedules.update(projectId, schedule.id, patch))

  if (!snapshot && !error) return <div className="schedules-empty">Loading schedules...</div>
  return <div className="schedules-pane">
    <div className="schedules-intro">
      <p>Checks official model and runtime updates on this computer while Conductor is open. It uses no model tokens and saves a clear summary when something changes.</p>
      {!snapshot?.schedules.length && <button onClick={() => void act('create', () => window.conductor.orchestration.schedules.create({ projectId, jobId: 'latest-models-methods', everyMinutes: 1_440 }))} disabled={busy === 'create'}><Plus size={14}/>{busy === 'create' ? 'Creating...' : 'Add latest models check'}</button>}
    </div>
    {error && <p className="schedules-error" role="alert">{error}</p>}
    {snapshot?.schedules.map(schedule => {
      const runs = snapshot.runs[schedule.id] ?? [], latest = runs[0]
      return <section className="schedule-card" key={schedule.id}>
        <header><div><strong>{schedule.name}</strong></div><label className="schedule-toggle"><input type="checkbox" checked={schedule.enabled} disabled={busy === schedule.id} onChange={event => void update(schedule, { enabled: event.target.checked })}/> Enabled</label></header>
        <div className="schedule-controls">
          <IntervalControl schedule={schedule} disabled={busy === schedule.id} save={value => void update(schedule, { everyMinutes: value })}/>
          <button disabled={Boolean(busy)} onClick={() => void act(schedule.id, () => window.conductor.orchestration.schedules.runNow(projectId, schedule.id))}><Play size={13}/>Run now</button>
        </div>
        <dl className="schedule-facts"><div><dt>Next due</dt><dd>{when(schedule.nextDueAt)}</dd></div><div><dt>Last outcome</dt><dd className={`schedule-outcome outcome-${latest?.outcome ?? 'none'}`}>{latest?.outcome ?? 'Never run'}</dd></div></dl>
        <div className="schedule-history"><h4>History</h4>{!runs.length && <p>No runs yet.</p>}{runs.map(run => <article key={run.id}>
          <div><span className={`schedule-outcome outcome-${run.outcome}`}>{run.outcome}</span><time>{when(run.startedAt)}</time>{run.validUntil && <span className={stale(run.validUntil) ? 'schedule-stale' : ''}>{stale(run.validUntil) ? 'stale' : `valid until ${when(run.validUntil)}`}</span>}</div>
          <p>{run.detail}</p>
          {run.digest && <details><summary>Evidence details</summary><code title={run.digest}>{run.digest}</code></details>}
          {run.artifactPath && <button className="schedule-evidence" onClick={() => void act(`artifact:${run.id}`, () => window.conductor.orchestration.schedules.openArtifact(projectId, run.id))}><FileSearch size={13}/>Open saved evidence</button>}
        </article>)}</div>
        <p className="schedule-review-note">Changed evidence is saved for inspection. An agent review is an explicit follow-up; this schedule never starts one automatically.</p>
      </section>
    })}
  </div>
}
