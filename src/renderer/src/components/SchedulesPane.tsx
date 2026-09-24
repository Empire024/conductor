import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { ScheduleDefinition, ScheduleSnapshot } from '../../../shared/schedules'
import { SchedulerStatus } from './schedules/SchedulerStatus'
import { ScheduleTaskCard } from './schedules/ScheduleTaskCard'
import { ScheduleTaskForm } from './schedules/ScheduleTaskForm'
import { agentLabel, busyKey, deleteScriptQuestion, deleteTaskQuestion, sortRuns, type TaskFormValue } from './schedules/schedule-helpers'
import { LogicLoopsSection } from './LogicLoopsSection'
import './SchedulesPane.css'

/**
 * Scheduled tasks (docs/schedules.md): goals an agent pursues on a cadence through scripts it
 * wrote, run at night or while the computer is idle. This pane lists a project's tasks, why due
 * work is waiting, and what each run found; it creates, edits, pauses, runs and deletes tasks.
 */

const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)

/** Where an error is shown: at the top ('pane'), in the new-task form ('create'), or on a task card (its id). */
interface Failure { scope: string; message: string }

const POLL_WHILE_RUNNING_MS = 1_500
const CLOCK_TICK_MS = 30_000

export function SchedulesPane({ projectId }: { projectId: string }): React.JSX.Element {
  const bridge = window.conductor.orchestration.schedules
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null)
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notices, setNotices] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // App renders this pane without a key, so a project switch arrives as a new prop: answers for
  // the previous project are dropped rather than shown under the new one.
  const shownProject = useRef(projectId)

  const load = useCallback(async () => {
    try {
      const next = await bridge.snapshot(projectId)
      if (shownProject.current !== projectId) return
      setSnapshot(next)
      setNow(Date.now())
      setFailure(current => current?.scope === 'pane' ? null : current)
    } catch (reason) {
      if (shownProject.current === projectId) setFailure({ scope: 'pane', message: errorText(reason) })
    }
  }, [bridge, projectId])

  useEffect(() => {
    shownProject.current = projectId
    setSnapshot(null); setFailure(null); setNotices({}); setCreating(false); setEditing(null); setBusy('')
    void load()
  }, [projectId, load])
  useEffect(() => bridge.onChanged(changedProjectId => { if (changedProjectId === projectId) void load() }), [bridge, load, projectId])
  const isRunning = Boolean(snapshot?.running)
  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => void load(), POLL_WHILE_RUNNING_MS)
    return () => window.clearInterval(timer)
  }, [isRunning, load])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const notify = (scheduleId: string, text: string): void => setNotices(current => ({ ...current, [scheduleId]: text }))
  /** Runs one action at a time with a busy key; an error lands where the action was started. */
  const act = async (key: string, scope: string, action: () => Promise<unknown>, reload = true): Promise<void> => {
    if (busy) return
    setBusy(key); setFailure(null)
    setNotices(current => { if (!(scope in current)) return current; const rest = { ...current }; delete rest[scope]; return rest })
    try { await action(); if (reload) await load() }
    catch (reason) { setFailure({ scope, message: errorText(reason) }) }
    finally { setBusy('') }
  }

  const create = (value: TaskFormValue): void => void act('create', 'create', async () => {
    await bridge.create({ projectId, ...value })
    setCreating(false)
  })
  const handlers = (schedule: ScheduleDefinition) => {
    const id = schedule.id
    return {
      onRunNow: () => void act(busyKey('run', id), id, async () => {
        const run = await bridge.runNow(projectId, id)
        if (run.outcome === 'skipped' || run.outcome === 'failed') notify(id, run.detail || 'The run did not start.')
      }),
      onToggleEnabled: () => void act(busyKey('toggle', id), id, () => bridge.update(projectId, id, { enabled: !schedule.enabled })),
      onEdit: () => { setFailure(null); setEditing(id) },
      onCancelEdit: () => { setFailure(null); setEditing(null) },
      onSave: (value: TaskFormValue) => void act(busyKey('save', id), id, async () => {
        await bridge.update(projectId, id, value)
        setEditing(null)
      }),
      onDelete: () => {
        if (!window.confirm(deleteTaskQuestion(schedule.name))) return
        void act(busyKey('delete', id), id, () => bridge.remove(projectId, id))
      },
      onAssign: () => void act(busyKey('assign', id), id, async () => {
        await bridge.assignScripts(projectId, id)
        notify(id, `Opened a tab with ${agentLabel(schedule.agent, snapshot?.agents ?? [])}. It writes this task’s scripts through app control; they appear under Scripts as it saves them.`)
      }),
      onDeleteScript: (name: string) => {
        if (!window.confirm(deleteScriptQuestion(name, schedule.name))) return
        void act(busyKey('script', `${id}:${name}`), id, () => bridge.deleteScript(projectId, id, name))
      },
      onOpenArtifact: (runId: string) => void act(busyKey('artifact', runId), id, () => bridge.openArtifact(projectId, runId), false),
      onOpenConversation: (runId: string) => void act(busyKey('conversation', runId), id, () => bridge.openConversation(projectId, runId), false)
    }
  }

  if (!snapshot) {
    return <div className="schedules-pane">
      {failure ? <p className="schedules-error" role="alert">{failure.message}</p> : <p className="schedule-muted">Loading scheduled tasks…</p>}
    </div>
  }

  const runningName = snapshot.running ? snapshot.schedules.find(schedule => schedule.id === snapshot.running?.scheduleId)?.name ?? '' : ''
  return <div className="schedules-pane">
    <div className="schedules-intro">
      <p>Scheduled tasks run their scripts on a cadence, at night or while this computer is idle. A run whose output has not changed costs no model tokens; changed output is summarized by a local model and, if you enable it, reviewed by the task’s assigned agent.</p>
      <SchedulerStatus gate={snapshot.gate} running={snapshot.running} runningName={runningName} now={now} />
      {!creating && <button type="button" className="primary schedules-new" disabled={Boolean(busy)} onClick={() => { setFailure(null); setCreating(true) }}><Plus size={13} />New task</button>}
    </div>
    {failure?.scope === 'pane' && <p className="schedules-error" role="alert">{failure.message}</p>}
    {creating && <section className="schedule-card editing" aria-label="New scheduled task">
      <ScheduleTaskForm agents={snapshot.agents} busy={busy === 'create'} error={failure?.scope === 'create' ? failure.message : ''}
        onSubmit={create} onCancel={() => { setFailure(null); setCreating(false) }} />
    </section>}
    {!snapshot.schedules.length && !creating && <p className="schedules-empty">No scheduled tasks yet. Create one here, or ask an agent in any conversation to schedule one for you, for example “every night, check the llama.cpp releases and tell me what changed”.</p>}
    <div className="schedules-list">
      {snapshot.schedules.map(schedule => <ScheduleTaskCard key={schedule.id}
        schedule={schedule}
        runs={sortRuns(snapshot.runs[schedule.id] ?? [])}
        scripts={snapshot.scripts[schedule.id] ?? []}
        agents={snapshot.agents}
        running={snapshot.running}
        runningElsewhere={snapshot.running && snapshot.running.scheduleId !== schedule.id ? runningName || 'another task' : ''}
        now={now}
        busy={busy}
        error={failure?.scope === schedule.id ? failure.message : ''}
        notice={notices[schedule.id] ?? ''}
        editing={editing === schedule.id}
        {...handlers(schedule)} />)}
    </div>
    <LogicLoopsSection projectId={projectId}/>
  </div>
}
