import { BotMessageSquare, Coffee, Hourglass, LoaderCircle, Moon, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { describeCadence, type ScheduleAgentOption, type ScheduleDefinition, type ScheduleRun, type ScheduleScript, type ScheduleSnapshot } from '../../../../shared/schedules'
import { Chip, TimeAgo } from './ScheduleParts'
import { ScheduleRunHistory, ScheduleRunView } from './ScheduleRunView'
import { ScheduleScripts } from './ScheduleScripts'
import { ScheduleTaskForm } from './ScheduleTaskForm'
import {
  absoluteTime,
  agentLabel,
  busyKey,
  canReview,
  churnModelLabel,
  creatorLabel,
  deferralText,
  nextRunText,
  timingLabel,
  type TaskFormValue
} from './schedule-helpers'

export interface ScheduleTaskCardProps {
  schedule: ScheduleDefinition
  /** Newest first. */
  runs: readonly ScheduleRun[]
  scripts: readonly ScheduleScript[]
  agents: readonly ScheduleAgentOption[]
  running: ScheduleSnapshot['running']
  /** The name of the task holding the run slot when it is another task. */
  runningElsewhere: string
  now: number
  busy: string
  error: string
  notice: string
  editing: boolean
  onRunNow(): void
  onToggleEnabled(): void
  onEdit(): void
  onCancelEdit(): void
  onSave(value: TaskFormValue): void
  onDelete(): void
  onAssign(): void
  onDeleteScript(name: string): void
  onOpenArtifact(runId: string): void
  onOpenConversation(runId: string): void
}

/** One scheduled task: what it is, when it runs next, why it waits, and what it found last. */
export function ScheduleTaskCard(props: ScheduleTaskCardProps): React.JSX.Element {
  const { schedule, runs, scripts, agents, running, runningElsewhere, now, busy, error, notice, editing } = props
  const builtIn = schedule.kind !== 'agent'
  const isRunning = running?.scheduleId === schedule.id
  const latest = runs[0]
  const deferral = deferralText(schedule, now)
  const pending = (verb: string): boolean => busy === busyKey(verb, schedule.id)
  const assignBlocked = schedule.agent ? '' : 'Choose an assigned agent first (Edit).'
  const runBlocked = isRunning ? 'This task is running.' : runningElsewhere ? `Waiting for “${runningElsewhere}” to finish.` : ''
  const TimingIcon = schedule.timing === 'night' ? Moon : Coffee

  if (editing) {
    return <section className="schedule-card editing" aria-label={`Edit scheduled task ${schedule.name}`} data-schedule-id={schedule.id}>
      <ScheduleTaskForm schedule={schedule} agents={agents} busy={pending('save')} error={error} onSubmit={props.onSave} onCancel={props.onCancelEdit} />
    </section>
  }

  return <section className={`schedule-card${schedule.enabled ? '' : ' paused'}${isRunning ? ' running' : ''}`} aria-label={`Scheduled task ${schedule.name}`} data-schedule-id={schedule.id}>
    <header className="schedule-card-head">
      <strong title={schedule.name}>{schedule.name}</strong>
      <div className="schedule-badges">
        {builtIn && <Chip title="Conductor keeps this task’s scripts current. It can be paused and edited, not deleted.">Built-in</Chip>}
        {!schedule.enabled && <Chip tone="quiet" title="Not scheduled until you resume it">Paused</Chip>}
        {schedule.urgent && <Chip tone="news" title="Runs when due even while you are working">Urgent</Chip>}
        <Chip><TimingIcon size={10} aria-hidden />{timingLabel(schedule.timing)}</Chip>
      </div>
    </header>
    {schedule.prompt.trim() && <p className="schedule-goal" title={schedule.prompt}>{schedule.prompt}</p>}

    <dl className="schedule-facts">
      <div><dt>Cadence</dt><dd>{describeCadence(schedule.everyMinutes)}</dd></div>
      <div><dt>Next run</dt><dd title={absoluteTime(schedule.nextDueAt) || undefined}>{nextRunText(schedule, now)}</dd></div>
      <div><dt>Agent</dt><dd>{agentLabel(schedule.agent, agents)}{schedule.agent && <small>{schedule.brain && canReview(schedule.agent) ? 'reviews changes' : 'no review'}</small>}</dd></div>
      <div><dt>Local summary</dt><dd>{churnModelLabel(schedule.churnModel, agents)}</dd></div>
    </dl>

    {isRunning && running && <p className="schedule-running" role="status"><LoaderCircle size={12} className="spin" aria-hidden />Running, started <TimeAgo iso={running.startedAt} now={now} /></p>}
    {deferral && <p className="schedule-deferred" title={schedule.deferredAt ? `Held back since ${absoluteTime(schedule.deferredAt)}` : undefined}><Hourglass size={12} aria-hidden />{deferral}</p>}

    <div className="schedule-actions">
      <button type="button" disabled={Boolean(busy) || Boolean(runBlocked)} title={runBlocked || 'Run this task now, whatever the time and activity'} onClick={props.onRunNow}>
        <Play size={12} />{pending('run') ? 'Starting…' : 'Run now'}
      </button>
      <button type="button" disabled={Boolean(busy)} onClick={props.onToggleEnabled}>
        {schedule.enabled ? <Pause size={12} /> : <Play size={12} />}
        {pending('toggle') ? (schedule.enabled ? 'Pausing…' : 'Resuming…') : schedule.enabled ? 'Pause' : 'Resume'}
      </button>
      <button type="button" disabled={Boolean(busy)} onClick={props.onEdit}><Pencil size={12} />Edit</button>
      {!builtIn && <button type="button" className="danger" disabled={Boolean(busy)} onClick={props.onDelete}><Trash2 size={12} />{pending('delete') ? 'Deleting…' : 'Delete'}</button>}
      <button type="button" disabled={Boolean(busy) || Boolean(assignBlocked)} title={assignBlocked || `Open a tab with ${agentLabel(schedule.agent, agents)} to write this task’s scripts`} onClick={props.onAssign}>
        <BotMessageSquare size={12} />{pending('assign') ? 'Opening…' : 'Assign agent to write scripts'}
      </button>
    </div>
    {notice && <p className="schedule-notice" role="status">{notice}</p>}
    {error && <p className="schedules-error" role="alert">{error}</p>}

    <ScheduleScripts schedule={schedule} scripts={scripts} busy={busy} assignBlocked={assignBlocked} onAssign={props.onAssign} onDeleteScript={props.onDeleteScript} />

    <div className="schedule-last">
      <h4>Last result</h4>
      {latest
        ? <ScheduleRunView run={latest} agents={agents} now={now} busy={busy} onOpenArtifact={props.onOpenArtifact} onOpenConversation={props.onOpenConversation} />
        : <p className="schedule-muted">Not run yet.{schedule.enabled && schedule.nextDueAt ? ` First run ${nextRunText(schedule, now).replace(/^D/, 'd')}.` : ''}</p>}
    </div>
    <ScheduleRunHistory runs={runs.slice(1)} agents={agents} now={now} busy={busy} onOpenArtifact={props.onOpenArtifact} onOpenConversation={props.onOpenConversation} />
    <p className="schedule-created">Created by {creatorLabel(schedule.createdBy)} <TimeAgo iso={schedule.createdAt} now={now} /></p>
  </section>
}
