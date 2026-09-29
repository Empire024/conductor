import { useState } from 'react'
import { CONTROL_TITLES, type OwnerQuestion } from '../../../../shared/production'

/**
 * Facts only the owner can give. Each open question names the controls it keeps UNVERIFIED and is
 * answered inline; the answer becomes an owner fact and a new profile version.
 */
export function QuestionList({ questions, busy, error, onAnswer, onDismiss, confirmId = null, confirm = null }: {
  questions: OwnerQuestion[]
  busy: string
  error: string
  onAnswer(questionId: string, answer: string): void
  onDismiss(questionId: string): void
  /** The question whose dismissal is being confirmed, and the in-panel form that confirms it. */
  confirmId?: string | null
  confirm?: React.ReactNode
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const open = questions.filter(question => question.status === 'open')
  const settled = questions.filter(question => question.status !== 'open')
  return <div className="production-questions">
    {error && <p className="production-error" role="alert">{error}</p>}
    {!open.length && <p className="production-muted">No open owner questions.</p>}
    {open.map(question => {
      const draft = drafts[question.id] ?? ''
      const answering = busy === `answer:${question.id}`
      // The confirm form sits beside the answer form, never inside it: forms do not nest.
      return <div key={question.id} className="production-question" data-question-id={question.id}>
        <strong>{question.question}</strong>
        <small>{question.why}</small>
        <small className="production-blocks">Blocks {question.blocksControls.map(id => `${id} ${CONTROL_TITLES[id]}`).join(', ') || 'no control'}</small>
        <form className="production-question-answer" aria-label={`Answer ${question.factKey}`}
          onSubmit={event => { event.preventDefault(); if (draft.trim()) onAnswer(question.id, draft) }}>
          <input aria-label={`Answer: ${question.factKey}`} value={draft} disabled={Boolean(busy)} placeholder="Your answer"
            onChange={event => setDrafts(current => ({ ...current, [question.id]: event.target.value }))} />
          <button type="submit" className="primary" disabled={Boolean(busy) || !draft.trim()}>{answering ? 'Saving…' : 'Answer'}</button>
          <button type="button" disabled={Boolean(busy) || confirmId === question.id} onClick={() => onDismiss(question.id)} title="Dismiss: the controls it blocks stay unverified">Dismiss…</button>
        </form>
        {confirmId === question.id && confirm}
      </div>
    })}
    {settled.length > 0 && <details className="production-settled">
      <summary>Answered or dismissed ({settled.length})</summary>
      <ul>{settled.map(question => <li key={question.id} data-question-id={question.id} data-status={question.status}>
        <span>{question.question}</span> <em>{question.status === 'answered' ? `Answered: ${question.answer ?? ''}` : 'Dismissed'}</em>
      </li>)}</ul>
    </details>}
  </div>
}
