import { useEffect, useRef, useState } from 'react'
import type { PermissionGrantRequest, PermissionGrantsState } from '../../../../shared/permission-grants'
import { LivePermissionGrantCard, usePermissionGrants } from './PermissionGrantCard'

/** Asks the conversation pane showing `agentSessionId` to bring its waiting permission cards into
 *  view: a conversation link or a Needs attention row that lands on the tab already on screen
 *  still shows the owner what it pointed at. */
export const REVEAL_CONVERSATION_EVENT = 'conductor:reveal-conversation'
export function revealConversation(agentSessionId: string | undefined): void {
  if (!agentSessionId || typeof window === 'undefined') return
  const send = (): boolean => window.dispatchEvent(new CustomEvent(REVEAL_CONVERSATION_EVENT, { detail: { agentSessionId } }))
  send()
  // A tab that was not on screen mounts its pane only now (tab-keep-alive.ts); tell it again then.
  window.setTimeout(send, 300)
}

/**
 * The requests still waiting for the owner in this conversation whose card is not in the rendered
 * window of the timeline. A card is an ordinary timeline item, so it pages out of a long
 * conversation (a successor that took its predecessor's cards at handoff has them among its first
 * items) and may never have been written at all (a runtime not live in this process when the main
 * process wrote it). The main process's state is the authority, so the dock reads that, not the
 * timeline: after a handoff, an app restart or three hundred later items the owner still has the
 * buttons. Oldest first, the order they were asked in.
 */
export function dockedGrantRequests(state: PermissionGrantsState, agentSessionId: string, rendered: ReadonlySet<string> = new Set()): PermissionGrantRequest[] {
  return state.requests
    .filter(request => request.agentSessionId === agentSessionId && request.status === 'pending' && !rendered.has(request.id))
    .sort((a, b) => (Date.parse(a.requestedAt) || 0) - (Date.parse(b.requestedAt) || 0))
}

/** Pinned above the composer: every waiting request this conversation holds that the visible
 *  timeline does not already show, each as the same live card with its buttons. Not in a wizard
 *  tab, which answers its own requests. */
export function PendingGrantDock({ agentSessionId, rendered }: { agentSessionId: string; rendered: ReadonlySet<string> }): React.JSX.Element | null {
  const state = usePermissionGrants()
  const waiting = dockedGrantRequests(state, agentSessionId, rendered)
  const [open, setOpen] = useState(true)
  const [pulse, setPulse] = useState(false)
  const dock = useRef<HTMLElement>(null)
  useEffect(() => {
    const reveal = (event: Event): void => {
      if ((event as CustomEvent<{ agentSessionId?: string }>).detail?.agentSessionId !== agentSessionId) return
      setOpen(true); setPulse(true)
      requestAnimationFrame(() => dock.current?.scrollIntoView?.({ block: 'nearest' }))
    }
    window.addEventListener(REVEAL_CONVERSATION_EVENT, reveal)
    return () => window.removeEventListener(REVEAL_CONVERSATION_EVENT, reveal)
  }, [agentSessionId])
  useEffect(() => {
    if (!pulse) return
    const timer = window.setTimeout(() => setPulse(false), 1600)
    return () => window.clearTimeout(timer)
  }, [pulse])
  if (!waiting.length) return null
  return <section ref={dock} className={'sa-grant-dock' + (pulse ? ' sa-grant-dock-pulse' : '')} aria-label={`${waiting.length} permission request${waiting.length === 1 ? '' : 's'} waiting for you`} data-grant-dock={waiting.length}>
    <button type="button" className="sa-grant-dock-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>{waiting.length === 1 ? 'Permission request waiting' : `${waiting.length} permission requests waiting`}</strong>
      <span className="sa-muted">{open ? 'Hide' : 'Show'}</span>
    </button>
    {open && <div className="sa-grant-dock-cards">
      {waiting.map(request => <LivePermissionGrantCard key={request.id} agentSessionId={agentSessionId} requestId={request.id} request={request} interactive={false} />)}
    </div>}
  </section>
}
