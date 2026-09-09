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

export interface AgentConfirmBridge {
  onRequest(callback: (request: AgentConfirmRequest) => void): () => void
  respond(response: AgentConfirmResponse): void
}
