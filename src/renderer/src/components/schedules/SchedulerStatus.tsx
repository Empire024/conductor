import { CircleCheck, Hourglass, LoaderCircle } from 'lucide-react'
import type { ScheduleGateVerdict, ScheduleSnapshot } from '../../../../shared/schedules'
import { TimeAgo } from './ScheduleParts'
import { absoluteTime, relativeTime } from './schedule-helpers'

/** The scheduler's one verdict about starting due work, shown once above every task. */
export function SchedulerStatus({ gate, running, runningName, now }: { gate: ScheduleGateVerdict | null; running: ScheduleSnapshot['running']; runningName: string; now: number }): React.JSX.Element {
  const tone = running ? 'busy' : !gate ? 'quiet' : gate.allowed ? 'good' : 'waiting'
  const Icon = running ? LoaderCircle : gate?.allowed ? CircleCheck : Hourglass
  const signals = gate?.signals ?? []
  const retry = gate && !gate.allowed && gate.retryAt ? relativeTime(gate.retryAt, now) : ''
  return <div className={`schedules-status tone-${tone}`}>
    <p className="schedules-status-line" role="status" title={signals.length ? signals.join('\n') : undefined}>
      <Icon size={13} className={running ? 'spin' : undefined} aria-hidden />
      <span>
        {running
          ? <>Running “{runningName || 'a task'}”, started <TimeAgo iso={running.startedAt} now={now} /></>
          : !gate ? 'Scheduler: not checked yet'
          : `${gate.allowed ? 'Ready' : 'Waiting'}: ${gate.reason}`}
      </span>
    </p>
    {gate && (running || signals.length > 0 || retry) && <details className="schedules-status-details">
      <summary>
        {running ? `${gate.allowed ? 'Ready' : 'Waiting'}: ${gate.reason}` : 'Why'}
        <span className="schedule-muted"> · checked <time dateTime={gate.checkedAt} title={absoluteTime(gate.checkedAt)}>{relativeTime(gate.checkedAt, now) || 'just now'}</time>{retry ? `, looks again ${retry}` : ''}</span>
      </summary>
      {signals.length > 0 ? <ul>{signals.map(signal => <li key={signal}>{signal}</li>)}</ul> : <p className="schedule-muted">No signals recorded.</p>}
    </details>}
  </div>
}
