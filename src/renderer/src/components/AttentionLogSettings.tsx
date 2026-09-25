import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import type { AttentionLogEntry, AttentionOutcome, PhoneAccessState } from '../../../shared/phone-access'
import './AttentionLogSettings.css'

const OUTCOME_LABELS: Record<AttentionOutcome, string> = {
  notified: 'Sent',
  answered: 'Answered in time',
  reviewer: 'Reviewer answered',
  'routed-around': 'Went another way',
  closed: 'Tab closed',
  undecided: 'Never decided'
}
const KIND_LABELS: Record<AttentionLogEntry['kind'], string> = { approval: 'Approval', question: 'Question', denial: 'Refusal' }
const SHOWN = 50

const when = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
const waited = (ms: number): string => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`

/**
 * Settings > Notifications: every "needs you" moment and what became of it (src/main/attention-log.ts).
 * Only a moment still blocked on the owner after the grace period reaches the phones; the rest are
 * listed here so the rules can be tuned.
 */
export function AttentionLogSettings(): React.JSX.Element {
  const [log, setLog] = useState<AttentionLogEntry[] | null>(null)
  const [all, setAll] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const receive = (state: PhoneAccessState): void => setLog(state.attentionLog ?? [])
    window.conductor.phone.state().then(receive).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
    return window.conductor.phone.onChanged(receive)
  }, [])
  const newest = [...(log ?? [])].reverse()
  const shown = all ? newest : newest.slice(0, SHOWN)
  const held = newest.filter(entry => entry.outcome !== 'notified').length
  return <section className="attention-log-settings">
    <div className="settings-section-title"><BellRing size={14} /><div><strong>"Needs you" log</strong><span>A request is sent only if it still holds the turn 20 seconds later. Everything else is listed here instead.</span></div></div>
    {error && <p className="attention-log-error">{error}</p>}
    {log && !log.length && <p className="attention-log-empty">Nothing yet. Approvals, questions and auto-mode refusals appear here as they happen.</p>}
    {log && log.length > 0 && <>
      <p className="attention-log-summary">{newest.length - held} sent, {held} held back</p>
      <ol className="attention-log-list">
        {shown.map(entry => <li key={entry.id} className={`attention-log-entry attention-${entry.outcome}`}>
          <div className="attention-log-head">
            <span className={`attention-log-outcome attention-${entry.outcome}`}>{OUTCOME_LABELS[entry.outcome] ?? entry.outcome}</span>
            <strong title={entry.sessionId}>{entry.title}</strong>
            <small>{KIND_LABELS[entry.kind] ?? entry.kind} · {when(entry.at)} · after {waited(entry.waitedMs)}</small>
          </div>
          <div className="attention-log-detail">{entry.detail}</div>
          <div className="attention-log-next">{entry.next}</div>
        </li>)}
      </ol>
      {newest.length > SHOWN && <button type="button" className="attention-log-more" onClick={() => setAll(value => !value)}>{all ? 'Show fewer' : `Show all ${newest.length}`}</button>}
    </>}
  </section>
}
