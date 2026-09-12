import type { AgentChangeHistory, RevertOutcome, RevertScope } from './agent-change-history'
/** Versioned, provider-neutral envelope. Native IDs never double as Conductor IDs. */
export type StructuredProvider = 'codex' | 'claude' | 'local'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type SessionPhase = 'idle' | 'starting' | 'running' | 'waiting_approval' | 'waiting_input' | 'interrupting' | 'completed' | 'failed' | 'disconnected' | 'interrupted'
/** The true native CLI/API ceiling. Text, attachment expansion and recalled memory context
 *  together must stay under this or the provider refuses the whole turn with an opaque error. */
export const MAX_PROMPT_CHARS = 600_000
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
  /** A provider-offered Edit-mode grant lasts only for this runtime, never a resume. */
  temporaryPermission?: { runtimeId: string; restore: SessionSettings['permission'] }
  sandbox?: 'inherit' | 'read-only' | 'workspace-write'
  approvalPolicy?: 'inherit' | 'untrusted' | 'on-request' | 'never'
  /** Explicit opt-in to Conductor's project browser MCP for the next provider connection. */
  browserMcp?: boolean
  /** Local models only, off unless the owner grants it in this conversation: repository writes
   *  inside the sandbox (commit and branch on local history; the container still has no network)
   *  and a wide web research mode (a search tool and the tool rounds to use it). */
  localGit?: boolean
  localResearch?: boolean
  plan: boolean
}
/** The only real permission literals a session ever carries. Shared by the renderer's per-provider
 *  memory (permission-memory.ts) and the main-process mirror (app-settings.ts) so both sides
 *  reject the same junk instead of keeping two independent notions of "valid". */
export const SESSION_PERMISSIONS: SessionSettings['permission'][] = ['default', 'read-only', 'accept-edits', 'auto']
export const isSessionPermission = (value: unknown): value is SessionSettings['permission'] => SESSION_PERMISSIONS.includes(value as SessionSettings['permission'])
/** Expire a session approval whenever a new provider process takes ownership. */
export function settingsForRuntime(settings: SessionSettings, runtimeId?: string): SessionSettings {
  const { temporaryPermission, ...permanent } = settings
  if (!temporaryPermission) return settings
  if (settings.permission !== 'accept-edits') return permanent
  if (temporaryPermission.runtimeId === runtimeId) return settings
  return { ...permanent, permission: temporaryPermission.restore }
}
export interface ContextAttachment {
  id: string
  kind: 'file' | 'selection' | 'editor' | 'terminal' | 'diagnostics' | 'image' | 'media'
  name: string
  path?: string
  content?: string
  /** Opaque media is described by verified metadata and a workspace path; its bytes are never
   * decoded as text or implied to be native model input. */
  mimeType?: string
  size?: number
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
  choices: Array<{ id: string; label: string; description?: string; disabled?: boolean }>
  questions?: InputQuestion[]
  status: 'pending' | 'resolved' | 'expired'
  outcome?: string
  /** What the owner actually answered, kept on the resolved interaction so a conversation
   *  reloaded from history still shows the answer rather than only that one was given. */
  answers?: Record<string, string | string[]>
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
/** Who actually sent a prompt. Absent means the owner typed it in this tab's composer;
 *  present means another Conductor tab dispatched it through the app control protocol. */
export interface PromptDispatchAuthority { kind: 'remote-peer'; peerId: string; projectId: string }
export interface PromptOrigin { agentSessionId: string; label: string; authority?: PromptDispatchAuthority }
export interface QueuedPrompt { id: string; text: string; settings: SessionSettings; attachments: ContextAttachment[]; steer?: boolean; origin?: PromptOrigin }
export interface PendingSteering extends QueuedPrompt { runtimeId: string; turnId?: string; status: 'sending' | 'accepted' | 'cancelled' | 'uncertain' }
export type AgentEventData =
  | { type: 'steering'; prompts: PendingSteering[] }
  | { type: 'input_delivery'; inputId: string; status: 'accepted' | 'delivered' | 'cancelled' | 'uncertain' }
  | { type: 'queue'; prompt: QueuedPrompt | null; prompts?: QueuedPrompt[] }
  | { type: 'session'; phase: SessionPhase; view?: 'visual' | 'cli'; nativeSessionId?: string; message?: string; capabilities?: ProviderCapabilities; title?: string; archived?: boolean; settings?: SessionSettings }
  | { type: 'text'; role: 'user' | 'assistant' | 'status'; text: string; mode: 'delta' | 'snapshot'; attachments?: Omit<ContextAttachment, 'content'>[]; origin?: PromptOrigin }
  /** `detached` is true only for provider-confirmed background work that can outlive its parent
   * turn. It remains a tool/process, not a subagent, but terminal parent phases must not end it. */
  | { type: 'tool'; name: string; description?: string; input?: Json; inputDelta?: string; status: ActivityStatus; detached?: boolean; output?: string; outputMode?: 'delta' | 'snapshot'; stderr?: string; exitCode?: number; durationMs?: number; outputArtifactId?: string }
  | { type: 'changes'; changes: FileChange[] }
  | { type: 'interaction'; interaction: PendingInteraction }
  | { type: 'plan'; steps: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>; explanation?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number; reasoningTokens?: number; totalTokens?: number; costUsd?: number; scope?: 'session' | 'turn' | 'message'; source: 'provider' | 'estimate'; limits?: Json }
  | { type: 'error'; message: string; code?: string }
  | { type: 'notice'; message: string; payload?: Json; outputArtifactId?: string }
  /** `detached` marks background work that deliberately outlives the turn that started it.
   *  `model`/`effort`/`modelProvider` are only present when the provider actually reports them for
   *  this child (Codex's spawned agent threads); a bash background task has no model to report. */
  | { type: 'subagent'; name: string; nativeSessionId?: string; status: ActivityStatus; detached?: boolean; outputFile?: string; output?: string; outputTruncated?: boolean; outputError?: string; model?: string; effort?: string; modelProvider?: string }
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
  pendingSteering?: PendingSteering[]
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
/** One matching message: the snippet is flattened context around the first match, with
 *  `matchStart` an offset into that snippet so the renderer can mark it without re-searching. */
export interface ConversationSearchHit {
  itemId: string
  sequence: number
  role: 'user' | 'assistant' | 'status'
  snippet: string
  matchStart: number
  matchLength: number
  matches: number
}
export interface ConversationSearchGroup {
  sessionId: string
  title: string
  provider: StructuredProvider
  archived: boolean
  /** Matching messages in this conversation, including any beyond the returned `hits`. */
  messages: number
  hits: ConversationSearchHit[]
}
export interface ConversationSearchResult { groups: ConversationSearchGroup[]; truncated: boolean }
export interface InteractionResponse {
  sessionId: string
  runtimeId: string
  requestId: string
  decision?: string
  answers?: Record<string, string[]>
}
export interface StructuredAgentBridge {
  bindWorkspace(id: string, sessionId: string): Promise<void>
  steer(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  queue(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  cancelQueued(id: string, promptId?: string): Promise<QueuedPrompt | null>
  connect(id: string): Promise<void>
  snapshot(id: string): Promise<SessionProjection | null>
  events(id: string, after?: number): Promise<AgentEvent[]>
  submit(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  respond(response: InteractionResponse): Promise<void>
  interrupt(id: string, expediteSubmittedInput?: boolean): Promise<void>
  resume(id: string, settings?: SessionSettings): Promise<void>
  saveSettings(id: string, settings: SessionSettings): Promise<void>
  fork(id: string): Promise<string>
  discover(id: string): Promise<Json>
  rename(id: string, title: string): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  history(projectId: string, query?: string): Promise<Array<{ id: string; title: string; provider: StructuredProvider; archived: boolean; phase: SessionPhase }>>
  /** Message-level find across every conversation of a workspace, answered from the main
   *  process so no other conversation's projection is ever shipped to the renderer. */
  searchMessages(projectId: string, query: string, excludeId?: string): Promise<ConversationSearchResult>
  artifact(id: string, artifactId: string): Promise<DiffArtifact>
  output(id: string, artifactId: string): Promise<string>
  review(id: string, artifactId: string, action: 'keep' | 'undo'): Promise<{ outcome: 'kept' | 'reverted' | 'conflict'; message?: string }>
  /** Local, pre-git change history for this conversation, and the restores it allows. */
  changeHistory(id: string): Promise<AgentChangeHistory>
  revertChanges(id: string, scope: RevertScope): Promise<RevertOutcome>
  onEvents(callback: (events: AgentEvent[]) => void): () => void
}
