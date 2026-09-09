import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, X } from 'lucide-react'
import type { AgentConfirmRequest } from '../../../shared/agent-confirm'
import './AgentConfirmDialog.css'

/** An agent asking the owner to approve something it cannot decide for itself — closing a tab,
 *  forgetting a memory — used to pop a native OS dialog that froze the window behind it. This is
 *  the in-app replacement, styled like Conductor's other confirm dialogs (see UpdateQuitConfirm). */
export function AgentConfirmDialog({ request, onRespond }: { request: AgentConfirmRequest; onRespond(allow: boolean): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button.primary')?.focus() }, [request.id])
  const decide = (allow: boolean): void => { setBusy(true); onRespond(allow) }
  return createPortal(<div className="agent-confirm-backdrop" role="presentation" onMouseDown={() => { if (!busy) decide(false) }}>
    <section ref={ref} className="agent-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agent-confirm-title" aria-describedby="agent-confirm-message" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) decide(false) }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        if (!buttons.length) { event.preventDefault(); return }
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
      }
    }}>
      <header>
        <span className="agent-confirm-icon"><Bot size={17} /></span>
        <strong id="agent-confirm-title">{request.title}</strong>
        <button type="button" aria-label="Decline" disabled={busy} onClick={() => decide(false)}><X size={15} /></button>
      </header>
      <p id="agent-confirm-message">{request.message}</p>
      <footer>
        <button type="button" disabled={busy} onClick={() => decide(false)}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={() => decide(true)}>Allow</button>
      </footer>
    </section>
  </div>, document.body)
}
