export type AgentCollaborationMessageKind =
  | 'activity'
  | 'intent'
  | 'question'
  | 'handoff'
  | 'warning'
  | 'completion'

export type FileWorkIntent = 'view' | 'edit' | 'create' | 'delete' | 'execute'
export type FilePresenceState = 'active' | 'idle' | 'blocked' | 'released' | 'expired'

export interface AgentCollaborationMessage {
  id: string
  projectId: string
  sessionId: string
  agentSessionId: string
  toAgentSessionId: string | null
  kind: AgentCollaborationMessageKind
  body: string
  paths: string[]
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface PostAgentCollaborationMessageInput {
  projectId: string
  sessionId: string
  agentSessionId: string
  toAgentSessionId?: string | null
  kind: AgentCollaborationMessageKind
  body: string
  paths?: string[]
  metadata?: Record<string, unknown>
}

export interface AgentCollaborationMessageQuery {
  projectId: string
  /** Restrict results to one workspace. Omit this for project-wide coordination. */
  sessionId?: string
  /** Includes broadcasts and messages addressed to this live agent session. */
  agentSessionId?: string
  limit?: number
}

export interface AgentFilePresence {
  id: string
  projectId: string
  sessionId: string
  agentSessionId: string
  path: string
  intent: FileWorkIntent
  state: FilePresenceState
  detail: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  releasedAt: string | null
}

export interface AnnounceFilePresenceInput {
  projectId: string
  sessionId: string
  agentSessionId: string
  path: string
  intent: FileWorkIntent
  state?: 'active' | 'idle'
  detail?: string
  /** Heartbeat lease duration, clamped to 15–900 seconds. */
  ttlSeconds?: number
}

export interface FileConflictQuery {
  projectId: string
  agentSessionId: string
  path: string
  intent: FileWorkIntent
}

export interface FileWorkConflict {
  path: string
  severity: 'advisory' | 'blocking'
  reason: string
  presence: AgentFilePresence
}

export interface FilePresenceAnnouncement {
  presence: AgentFilePresence
  /** False when another live agent already holds an exclusive write lease. */
  granted: boolean
  conflicts: FileWorkConflict[]
}

export interface AgentPresenceQuery {
  projectId: string
  /** Restrict to a workspace. Omit to include every workspace in the project. */
  sessionId?: string
  includeIdle?: boolean
}

export interface AgentCollaborationSnapshot {
  messages: AgentCollaborationMessage[]
  presence: AgentFilePresence[]
}

export interface AgentCollaborationBridge {
  snapshot(query: AgentCollaborationMessageQuery): Promise<AgentCollaborationSnapshot>
  briefing(agentSessionId: string): Promise<string>
  messages: {
    post(input: PostAgentCollaborationMessageInput): Promise<AgentCollaborationMessage>
    list(query: AgentCollaborationMessageQuery): Promise<AgentCollaborationMessage[]>
  }
  presence: {
    announce(input: AnnounceFilePresenceInput): Promise<FilePresenceAnnouncement>
    list(query: AgentPresenceQuery): Promise<AgentFilePresence[]>
    conflicts(query: FileConflictQuery): Promise<FileWorkConflict[]>
    release(agentSessionId: string, path?: string): Promise<void>
  }
}
