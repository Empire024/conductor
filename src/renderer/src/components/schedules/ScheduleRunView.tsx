import { useState } from 'react'
import { Bot, ChevronRight, Cpu, FileSearch, MessageSquare } from 'lucide-react'
import type { ScheduleAgentOption, ScheduleModelStep, ScheduleRun, ScheduleScriptResult } from '../../../../shared/schedules'
import { Chip, ClampedText, TimeAgo } from './ScheduleParts'
import {
  absoluteTime,
  agentLabel,
  busyKey,
  firstLine,
  formatDuration,
  outcomeLabel,
  outcomeTone,
  runDurationMs,
  SCRIPT_STATUS_LABELS,
  scriptStatusTone
} from './schedule-helpers'

export interface ScheduleRunViewProps {
  run: ScheduleRun
  agents: readonly ScheduleAgentOption[]
  now: number
  busy: string
  onOpenArtifact(runId: string): void
  onOpenConversation(runId: string): void
  /** History rows already show the outcome and time in their summary. */
  showOutcome?: boolean
}

function ScriptResult({ result }: { result: ScheduleScriptResult }): React.JSX.Element {
  return <li className="schedule-result">
    <div className="schedule-result-head">
      <Chip tone={scriptStatusTone(result.status)}>{SCRIPT_STATUS_LABELS[result.status] ?? result.status}</Chip>
      <code>{result.name}</code>
      {result.status !== 'skipped' && <span className={result.changed ? 'schedule-changed' : ''}>{result.changed ? 'changed' : 'unchanged'}</span>}
      {result.exitCode !== null && <span>exit {result.exitCode}</span>}
      {result.status !== 'skipped' && <span>{formatDuration(result.durationMs)}</span>}
    </div>
    {result.error && <p className="schedule-result-error">{result.error}</p>}
    {result.excerpt && <details className="schedule-output">
      <summary>Output</summary>
      <pre>{result.excerpt}</pre>
    </details>}
  </li>
}

function ModelStep({ kind, step, agents, children }: { kind: 'churn' | 'brain'; step: ScheduleModelStep; agents: readonly ScheduleAgentOption[]; children?: React.ReactNode }): React.JSX.Element {
  const Icon = kind === 'churn' ? Cpu : Bot
  return <div className={`schedule-step step-${kind}`}>
    <div className="schedule-step-head">
      <Icon size={12} aria-hidden />
      <span className="schedule-step-kind">{kind === 'churn' ? 'Local summary' : 'Agent review'}</span>
      <span className="schedule-step-model">{agentLabel({ provider: step.provider, model: step.model }, agents)}</span>
      <Chip tone={step.ok ? 'good' : 'bad'}>{step.ok ? 'OK' : 'No result'}</Chip>
      {children}
    </div>
    {step.note && <p className="schedule-step-note">{step.note}</p>}
  </div>
}

/** One run: its outcome, the result text, per-script evidence and the model steps it took. */
export function ScheduleRunView({ run, agents, now, busy, onOpenArtifact, onOpenConversation, showOutcome = true }: ScheduleRunViewProps): React.JSX.Element {
  const duration = runDurationMs(run)
  const expired = Boolean(run.validUntil && Date.parse(run.validUntil) < now)
  return <div className="schedule-run" data-run-id={run.id}>
    <div className="schedule-run-head">
      {showOutcome && <Chip tone={outcomeTone(run.outcome)}>{outcomeLabel(run.outcome)}</Chip>}
      {showOutcome && <TimeAgo iso={run.startedAt} now={now} />}
      <span>{run.trigger === 'manual' ? 'Run manually' : 'Scheduled'}</span>
      {duration !== null && <span>took {formatDuration(duration)}</span>}
      {expired && <span className="schedule-expired" title={`Valid until ${absoluteTime(run.validUntil)}`}>out of date</span>}
    </div>
    {run.detail.trim() ? <ClampedText text={run.detail} className="schedule-run-detail" /> : run.outcome === 'running' ? <p className="schedule-muted">Running its scripts…</p> : null}
    {run.scripts.length > 0 && <ul className="schedule-results" aria-label="Script results">
      {run.scripts.map(result => <ScriptResult key={result.name} result={result} />)}
    </ul>}
    {run.churn && <ModelStep kind="churn" step={run.churn} agents={agents} />}
    {run.brain && <ModelStep kind="brain" step={run.brain} agents={agents}>
      {run.brain.agentSessionId && <button type="button" className="schedule-small" disabled={Boolean(busy)} onClick={() => onOpenConversation(run.id)}>
        <MessageSquare size={12} />{busy === busyKey('conversation', run.id) ? 'Opening…' : 'Open conversation'}
      </button>}
    </ModelStep>}
    {run.artifactPath && <button type="button" className="schedule-small" title={run.artifactPath} disabled={Boolean(busy)} onClick={() => onOpenArtifact(run.id)}>
      <FileSearch size={12} />{busy === busyKey('artifact', run.id) ? 'Opening…' : 'Open saved evidence'}
    </button>}
  </div>
}

const HISTORY_PAGE = 5

/** Older runs as compact rows; each expands to the full run view. */
export function ScheduleRunHistory({ runs, ...view }: Omit<ScheduleRunViewProps, 'run' | 'showOutcome'> & { runs: readonly ScheduleRun[] }): React.JSX.Element | null {
  const [limit, setLimit] = useState(HISTORY_PAGE)
  if (!runs.length) return null
  return <div className="schedule-history">
    <h4>History</h4>
    <ul>
      {runs.slice(0, limit).map(run => <li key={run.id}>
        <details>
          <summary>
            <ChevronRight size={11} className="schedule-chevron" aria-hidden />
            <Chip tone={outcomeTone(run.outcome)}>{outcomeLabel(run.outcome)}</Chip>
            <TimeAgo iso={run.startedAt} now={view.now} />
            <span className="schedule-history-line">{firstLine(run.detail) || (run.trigger === 'manual' ? 'Run manually' : 'Scheduled run')}</span>
          </summary>
          <ScheduleRunView run={run} showOutcome={false} {...view} />
        </details>
      </li>)}
    </ul>
    {runs.length > limit && <button type="button" className="schedule-link" onClick={() => setLimit(runs.length)}>Show {runs.length - limit} older</button>}
  </div>
}
