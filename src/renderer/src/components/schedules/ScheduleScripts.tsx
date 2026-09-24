import { BotMessageSquare, FileCode2, LoaderCircle, Trash2 } from 'lucide-react'
import type { ScheduleDefinition, ScheduleScript } from '../../../../shared/schedules'
import { Chip } from './ScheduleParts'
import { busyKey, originLabel, runWhenLabel } from './schedule-helpers'

export interface ScheduleScriptsProps {
  schedule: ScheduleDefinition
  scripts: readonly ScheduleScript[]
  busy: string
  /** Why the assign button is disabled, or '' when it can be used. */
  assignBlocked: string
  onAssign(): void
  onDeleteScript(name: string): void
}

/** The task's scripts, collapsed by default; each one's code is viewable read-only. */
export function ScheduleScripts({ schedule, scripts, busy, assignBlocked, onAssign, onDeleteScript }: ScheduleScriptsProps): React.JSX.Element {
  const ordered = [...scripts].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return <details className="schedule-scripts">
    <summary><FileCode2 size={12} aria-hidden />Scripts<span className="schedule-count">{ordered.length ? ordered.length : 'none yet'}</span></summary>
    {!ordered.length && <div className="schedule-empty-scripts">
      <p>The assigned agent writes this task’s scripts through app control. Assign it and it opens in a tab with the task’s goal; its scripts appear here.</p>
      <button type="button" className="schedule-small" disabled={Boolean(busy) || Boolean(assignBlocked)} title={assignBlocked || undefined} onClick={onAssign}>
        <BotMessageSquare size={12} />{busy === busyKey('assign', schedule.id) ? 'Opening…' : 'Assign agent to write scripts'}
      </button>
    </div>}
    {schedule.delegateAgentSessionId && <p className="schedule-muted">A conversation has been asked to write and maintain these scripts.</p>}
    {ordered.length > 0 && <ul className="schedule-script-list">
      {ordered.map(script => <li key={script.name} className="schedule-script">
        <div className="schedule-script-head">
          <code>{script.name}</code>
          <Chip>{script.language}</Chip>
          <span title={script.runWhen === 'changed' ? 'Runs only when an earlier script in the same run changed or failed' : undefined}>{runWhenLabel(script.runWhen)}</span>
          <span className="schedule-script-origin">{originLabel(script)}</span>
          {script.origin !== 'conductor' && <button type="button" className="schedule-icon danger" aria-label={`Delete script ${script.name}`} title="Delete script"
            disabled={Boolean(busy)} onClick={() => onDeleteScript(script.name)}>{busy === busyKey('script', `${schedule.id}:${script.name}`) ? <LoaderCircle size={12} className="spin" /> : <Trash2 size={12} />}</button>}
        </div>
        {script.description && <p className="schedule-script-description">{script.description}</p>}
        <details className="schedule-output">
          <summary>View code</summary>
          <pre>{script.content}</pre>
        </details>
      </li>)}
    </ul>}
  </details>
}
