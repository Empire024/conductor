import { useEffect, useState } from 'react'
import type { AgentConfirmRequest } from '../../shared/agent-confirm'

/** Queues agent confirm requests so a second one that arrives while the owner is still deciding
 *  the first is never silently dropped; only the head of the queue is ever shown. Each request is
 *  acknowledged to main, which otherwise reports it as never shown; requests still waiting are
 *  fetched on mount because a reloaded window missed their broadcast; and one that main cancels
 *  (it timed out) leaves the queue instead of lingering as a dialog nobody is listening to. */
export function useAgentConfirm(): { request: AgentConfirmRequest | null; respond(allow: boolean): void } {
  const [queue, setQueue] = useState<AgentConfirmRequest[]>([])
  useEffect(() => {
    const bridge = window.conductor.agentConfirm
    let live = true
    const add = (request: AgentConfirmRequest): void => {
      setQueue(current => current.some(queued => queued.id === request.id) ? current : [...current, request])
      bridge.received(request.id)
    }
    const offRequest = bridge.onRequest(add)
    const offCancel = bridge.onCancel(id => setQueue(current => current.filter(queued => queued.id !== id)))
    void bridge.pending().then(requests => { if (live) requests.forEach(add) }, () => undefined)
    return () => { live = false; offRequest(); offCancel() }
  }, [])
  const respond = (allow: boolean): void => {
    const request = queue[0]
    if (!request) return
    window.conductor.agentConfirm.respond({ id: request.id, allow })
    setQueue(current => current.filter(queued => queued.id !== request.id))
  }
  return { request: queue[0] ?? null, respond }
}
