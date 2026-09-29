import { useState } from 'react'
import { CONTROL_TITLES, type ControlResult, type HumanReviewItem, type ReviewAnswer } from '../../../../shared/production'
import { formatTime, REVIEW_ANSWER_LABEL, sortResults, STATUS_LABEL, STATUS_TONE } from './production-model'

/**
 * Human-review items of the last completed run, grouped by control. The owner answers each one as
 * confirmed (the reviewed behaviour holds) or rejected (it does not), with an optional note. When
 * every item of a control is answered the gate lifts its NEEDS_HUMAN_REVIEW cap; a rejection makes
 * the control FAIL. An answer is changed by answering again.
 */
export function ReviewItems({ results, busy, error, errorId = null, changingId = null, onAnswer, onChange }: {
  results: ControlResult[]
  busy: string
  /** The bridge's refusal; shown under the item it names (errorId), else above the list. */
  error: string
  errorId?: string | null
  /** The answered item whose answer is being changed, if any. */
  changingId?: string | null
  onAnswer(itemId: string, answer: ReviewAnswer, note: string): void
  onChange(itemId: string | null): void
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const controls = sortResults(results.filter(result => result.humanReview.length > 0))
  const known = controls.some(result => result.humanReview.some(item => item.id === errorId))
  const itemError = (item: HumanReviewItem): React.ReactNode =>
    error && errorId === item.id ? <p className="production-error" role="alert">{error}</p> : null

  const answerForm = (item: HumanReviewItem): React.JSX.Element => {
    const draft = drafts[item.id] ?? ''
    const saving = busy.startsWith(`review:${item.id}:`)
    const send = (answer: ReviewAnswer): void => onAnswer(item.id, answer, draft)
    return <form className="production-question-answer production-review-answer" aria-label={`Review ${item.question}`}
      onSubmit={event => event.preventDefault()}>
      <input aria-label="Note (optional)" value={draft} disabled={Boolean(busy)} placeholder="Note (optional)" maxLength={500}
        onChange={event => setDrafts(current => ({ ...current, [item.id]: event.target.value }))} />
      <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => send('confirmed')} title="The reviewed behaviour holds">
        {busy === `review:${item.id}:confirmed` ? 'Saving…' : 'Confirm'}
      </button>
      <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => send('rejected')} title="The reviewed behaviour does not hold; the control fails">
        {busy === `review:${item.id}:rejected` ? 'Saving…' : 'Reject'}
      </button>
      {changingId === item.id && <button type="button" disabled={saving} onClick={() => onChange(null)}>Keep answer</button>}
    </form>
  }

  return <div className="production-questions production-reviews">
    {error && !known && <p className="production-error" role="alert">{error}</p>}
    {!controls.length && <p className="production-muted">No human-review items in the last run.</p>}
    {controls.map(result => <div key={result.controlId} className="production-review-control" data-review-control={result.controlId} data-status={result.status}>
      <h4>{result.controlId} {CONTROL_TITLES[result.controlId]} <span className={`production-chip tone-${STATUS_TONE[result.status]}`}>{STATUS_LABEL[result.status]}</span></h4>
      {result.humanReview.map(item => {
        const answer = item.answer ?? null
        const changing = changingId === item.id
        return <div key={item.id} className="production-question production-review" data-review-id={item.id} data-answer={answer ?? 'none'}>
          <strong data-audit-text>{item.question}</strong>
          <small data-audit-text>{item.why}</small>
          {item.route && <small>Route {item.route}</small>}
          {item.evidence.length > 0 && <small>Evidence {item.evidence.join(', ')}</small>}
          {answer && <div className="production-review-answered">
            <span className="production-chips">
              <span className={`production-chip tone-${REVIEW_ANSWER_LABEL[answer].tone}`}>{REVIEW_ANSWER_LABEL[answer].label}</span>
            </span>
            {item.note && <small data-audit-text>Note: {item.note}</small>}
            <small>By {item.answeredBy ?? 'unknown'} · {formatTime(item.answeredAt ?? null)}</small>
            {!changing && <button type="button" className="production-link" disabled={Boolean(busy)}
              onClick={() => { setDrafts(current => ({ ...current, [item.id]: item.note ?? '' })); onChange(item.id) }}>Change answer</button>}
          </div>}
          {(!answer || changing) && answerForm(item)}
          {itemError(item)}
        </div>
      })}
    </div>)}
  </div>
}
