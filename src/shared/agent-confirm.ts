/** An agent, acting through app control, is asking the owner to approve something it cannot
 *  decide for itself (closing a tab, forgetting a memory). `message` is already the full,
 *  human-readable ask; nothing else needs to be looked up to answer it. */
export interface AgentConfirmRequest {
  id: string
  title: string
  message: string
}

export interface AgentConfirmResponse {
  id: string
  allow: boolean
}

/** How a request ended: only `allowed` and `declined` are the owner's answer. `timeout` means it
 *  was shown but not answered, `undelivered` that the window never acknowledged it, and
 *  `unavailable` that there was no window to ask in. */
export type AgentConfirmOutcome = 'allowed' | 'declined' | 'timeout' | 'undelivered' | 'unavailable'

export interface AgentConfirmBridge {
  onRequest(callback: (request: AgentConfirmRequest) => void): () => void
  /** A request that stopped counting (timed out or was never acknowledged) leaves the queue. */
  onCancel(callback: (id: string) => void): () => void
  /** Requests still waiting, for a renderer that just loaded and missed their broadcast. */
  pending(): Promise<AgentConfirmRequest[]>
  received(id: string): void
  respond(response: AgentConfirmResponse): void
}
