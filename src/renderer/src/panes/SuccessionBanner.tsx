import { ArrowRight, GitBranchPlus } from 'lucide-react'
import type { SessionProjection } from '../../../shared/structured-agent'

export type Succession = { agentSessionId: string; tabId: string; title: string }

/** The successor a main brain handed itself on to (agents.handoff successor:true), from the
 *  Conductor notice main posted in this conversation's timeline; null if it never did. */
export function successionOf(items: SessionProjection['items']): Succession | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const data = items[index]!.data
    if (data.type !== 'notice' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) continue
    const value = data.payload.succession
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { agentSessionId, tabId, title } = value as Record<string, unknown>
    if (typeof agentSessionId === 'string' && agentSessionId && typeof title === 'string') return { agentSessionId, tabId: typeof tabId === 'string' ? tabId : '', title }
  }
  return null
}

/** Shown over a conversation that continued in a successor: it is read-only from here on, and
 *  the way to where the work went is one click. */
export function SuccessionBanner({ succession, running }: { succession: Succession; running: boolean }) {
  return <div className="sa-runtime-banner sa-runtime-succeeded" role="status">
    <GitBranchPlus size={15} aria-hidden="true" />
    <span><strong>Continued in {succession.title}</strong><small>{running ? 'This conversation is finishing its current step, then stops. ' : ''}It is read-only; its coworkers, wizard mode and remaining work moved to the successor.</small></span>
    <button className="sa-runtime-resume" onClick={() => void window.conductor.agentControl.focusOrigin(succession.agentSessionId).catch(() => undefined)}><ArrowRight size={13} />Open {succession.title}</button>
  </div>
}
