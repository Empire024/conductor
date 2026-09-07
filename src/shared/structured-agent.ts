/** Versioned, provider-neutral envelope. Native IDs never double as Conductor IDs. */
export type StructuredProvider = 'codex' | 'claude'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type SessionPhase = 'idle' | 'starting' | 'running' | 'waiting_approval' | 'waiting_input' | 'interrupting' | 'completed' | 'failed' | 'disconnected' | 'interrupted'
export type ActivityStatus = 'preparing' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected' | 'interrupted'
export interface ProviderCapabilities {
  provider: StructuredProvider
  runtimeVersion: string
  adapterVersion: 1
  authentication: 'cli' | 'api' | 'unknown'
  textStreaming: boolean
  steering: boolean
  toolInputStreaming: boolean
  toolOutputStreaming: boolean
  approvals: boolean
  questions: boolean
  resume: boolean
  fork: boolean
  plans: boolean
  imageAttachments?: boolean
  permissions?: SessionSettings['permission'][]
  sandboxModes?: NonNullable<SessionSettings['sandbox']>[]
  approvalPolicies?: NonNullable<SessionSettings['approvalPolicy']>[]
  effectiveSettings?: Json
  effort: string[]
  models: Array<{ id: string; label: string; effort?: string[]; defaultEffort?: string; isDefault?: boolean }>
  limitations: string[]
}
export interface SessionSettings {
  model?: string
  effort?: string
  permission: 'default' | 'read-only' | 'accept-edits' | 'auto'
  sandbox?: 'inherit' | 'read-only' | 'workspace-write'
  approvalPolicy?: 'inherit' | 'untrusted' | 'on-request' | 'never'
  plan: boolean
}
export interface ContextAttachment {
  id: string
  kind: 'file' | 'selection' | 'editor' | 'terminal' | 'diagnostics' | 'image'
  name: string
  path?: string
  content?: string
  startLine?: number
  endLine?: number
}
export interface InputQuestion {
  id: string
  header?: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  isSecret?: boolean
  allowCustom?: boolean
}
export interface PendingInteraction {
  id: string
  kind: 'approval' | 'question'
  title: string
  input: Json
  choices: Array<{ id: string; label: string }>
  questions?: InputQuestion[]
  status: 'pending' | 'resolved' | 'expired'
  outcome?: string
}
export interface FileChange {
  path: string
  oldPath?: string
  kind: 'add' | 'update' | 'delete' | 'rename'
  patch?: string
  artifactId?: string
  additions?: number
  deletions?: number
  status: 'proposed' | 'applied' | 'failed' | 'rejected' | 'reverted'
  limitation?: string
}
export interface QueuedPrompt { id: string; text: string; settings: SessionSettings; attachments: ContextAttachment[] }
export type AgentEventData =
  | { type: 'queue'; prompt: QueuedPrompt | null; prompts?: QueuedPrompt[] }
  | { type: 'session'; phase: SessionPhase; view?: 'visual' | 'cli'; nativeSessionId?: string; message?: string; capabilities?: ProviderCapabilities; title?: string; archived?: boolean; settings?: SessionSettings }
  | { type: 'text'; role: 'user' | 'assistant' | 'status'; text: string; mode: 'delta' | 'snapshot'; attachments?: Omit<ContextAttachment, 'content'>[] }
  | { type: 'tool'; name: string; description?: string; input?: Json; inputDelta?: string; status: ActivityStatus; output?: string; outputMode?: 'delta' | 'snapshot'; stderr?: string; exitCode?: number; durationMs?: number; outputArtifactId?: string }
  | { type: 'changes'; changes: FileChange[] }
  | { type: 'interaction'; interaction: PendingInteraction }
  | { type: 'plan'; steps: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>; explanation?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number; reasoningTokens?: number; totalTokens?: number; costUsd?: number; scope?: 'session' | 'turn' | 'message'; source: 'provider' | 'estimate'; limits?: Json }
  | { type: 'error'; message: string; code?: string }
  | { type: 'notice'; message: string; payload?: Json; outputArtifactId?: string }
  | { type: 'subagent'; name: string; nativeSessionId?: string; status: ActivityStatus }
  | { type: 'review'; artifactId: string; outcome: 'kept' | 'reverted' }
export interface AgentEvent {
  schemaVersion: 1
  id: string
  sequence: number
  sessionId: string
  runtimeId: string
  provider: StructuredProvider
  projectId: string
  workspaceId: string
  cwd: string
  nativeSessionId?: string
  turnId?: string
  itemId?: string
  parentId?: string
  requestId?: string
  timestamp: string
  data: AgentEventData
  native?: { method: string; payload?: Json }
}
/** Adapter emits only provider facts; the backend assigns durable envelope fields. */
export type AdapterEvent = Pick<AgentEvent, 'data'> & Partial<Pick<AgentEvent, 'nativeSessionId' | 'turnId' | 'itemId' | 'parentId' | 'requestId' | 'native'>>
export interface TimelineItem {
  updatedSequence?: number
  id: string
  runtimeId: string
  turnId?: string
  nativeItemId?: string
  parentId?: string
  sequence: number
  timestamp: string
  data: AgentEventData
}
export interface SessionProjection {
  view?: 'visual' | 'cli'
  queued?: QueuedPrompt | null
  queuedPrompts?: QueuedPrompt[]
  sessionId: string
  runtimeId: string
  nativeSessionId?: string
  phase: SessionPhase
  sequence: number
  items: TimelineItem[]
  capabilities?: ProviderCapabilities
  settings: SessionSettings
  title: string
  archived: boolean
  truncated: boolean
}
export interface DiffArtifact {
  id: string
  sessionId: string
  path: string
  oldPath?: string
  before: string | null
  after: string | null
  patch: string
  additions: number
  deletions: number
  canUndo: boolean
  limitation?: string
}
export interface InteractionResponse {
  sessionId: string
  runtimeId: string
  requestId: string
  decision?: string
  answers?: Record<string, string[]>
}
export interface StructuredAgentBridge {
  steer(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  queue(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  cancelQueued(id: string, promptId?: string): Promise<QueuedPrompt | null>
  connect(id: string): Promise<void>
  snapshot(id: string): Promise<SessionProjection | null>
  events(id: string, after?: number): Promise<AgentEvent[]>
  submit(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  respond(response: InteractionResponse): Promise<void>
  interrupt(id: string): Promise<void>
  resume(id: string, settings?: SessionSettings): Promise<void>
  fork(id: string): Promise<string>
  discover(id: string): Promise<Json>
  rename(id: string, title: string): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  history(projectId: string, query?: string): Promise<Array<{ id: string; title: string; provider: StructuredProvider; archived: boolean; phase: SessionPhase }>>
  artifact(id: string, artifactId: string): Promise<DiffArtifact>
  output(id: string, artifactId: string): Promise<string>
  review(id: string, artifactId: string, action: 'keep' | 'undo'): Promise<{ outcome: 'kept' | 'reverted' | 'conflict'; message?: string }>
  onEvents(callback: (events: AgentEvent[]) => void): () => void
}
