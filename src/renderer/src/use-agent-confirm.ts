import { useEffect, useState } from 'react'
import type { AgentConfirmRequest } from '../../shared/agent-confirm'

/** Queues agent confirm requests so a second one that arrives while the owner is still deciding
 *  the first is never silently dropped; only the head of the queue is ever shown. */
export function useAgentConfirm(): { request: AgentConfirmRequest | null; respond(allow: boolean): void } {
  const [queue, setQueue] = useState<AgentConfirmRequest[]>([])
  useEffect(() => window.conductor.agentConfirm.onRequest(request => setQueue(current => [...current, request])), [])
  const respond = (allow: boolean): void => {
    const request = queue[0]
    if (!request) return
    window.conductor.agentConfirm.respond({ id: request.id, allow })
    setQueue(current => current.slice(1))
  }
  return { request: queue[0] ?? null, respond }
}
