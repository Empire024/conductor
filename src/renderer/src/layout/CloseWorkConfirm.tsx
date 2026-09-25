import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TriangleAlert, Undo2 } from 'lucide-react'
import { answerCloseWork, closeWorkState, settleUndo, subscribeCloseWork, type CloseWorkState } from './close-work-guard'
import './coworker-tab-groups.css'

/** Mounted once per window: the "still working — close and stop it?" question every owner tab
 *  close asks (close-work-guard.ts), with "Don't close" as the default, and the few seconds of
 *  undo that follow a confirmed close. */
export function CloseWorkConfirm(): React.JSX.Element | null {
  const [state, setState] = useState<CloseWorkState>(closeWorkState)
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => subscribeCloseWork(setState), [])
  const request = state.request
  useEffect(() => {
    if (!request) return
    keep.current?.focus()
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); answerCloseWork(false) } }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [request])
  if (!request && !state.undo) return null
  return createPortal(<>
    {request && <div className="close-coworkers-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) answerCloseWork(false) }}>
      <section className="close-coworkers-confirm close-work-confirm" role="alertdialog" aria-modal="true" aria-labelledby="close-work-confirm-title" aria-describedby="close-work-confirm-message">
        <header>
          <span className="close-coworkers-confirm-icon"><TriangleAlert size={17} /></span>
          <strong id="close-work-confirm-title">Close while work is in progress?</strong>
        </header>
        <p id="close-work-confirm-message">{request.message}</p>
        <ul className="close-coworkers-confirm-list">{request.working.map(({ tab, work }) => <li key={tab.id}>{tab.title} · {work}</li>)}</ul>
        <p>{request.closing > request.working.length ? `This closes ${request.closing} tabs. ` : ''}You can undo the close for a few seconds.</p>
        <footer>
          <button type="button" ref={keep} autoFocus onClick={() => answerCloseWork(false)}>Don't close</button>
          <button type="button" className="primary" onClick={() => answerCloseWork(true)}>Close and stop</button>
        </footer>
      </section>
    </div>}
    {state.undo && <div className="close-work-undo" role="status">
      <span>{state.undo.message}</span>
      <button type="button" onClick={() => settleUndo(true)}><Undo2 size={13} /> Undo</button>
    </div>}
  </>, document.body)
}
