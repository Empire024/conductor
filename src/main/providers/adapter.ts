import type { AdapterEvent, ContextAttachment, InteractionResponse, Json, ProviderCapabilities, SessionSettings, StructuredProvider } from '../../shared/structured-agent'
import type { HostedRuntimeHandle } from './transport'
import type { DenialGrantRequest } from '../../shared/auto-mode-denial'
import type { PermissionGrantRequest } from '../../shared/permission-grants'
import type { NativeGrantCall } from '../permission-grants/identity'

/** What an adapter hands the next app process so it can continue a provider process the
 *  runtime host kept running (docs/runtime-host.md): its own protocol state and the process. */
export interface RuntimeDetachment { state: Json; transport: HostedRuntimeHandle }

export interface AdapterOptions {
  executable: string
  cwd: string
  runtimeId: string
  /** Registered conversation identity, stable across transport incarnations. */
  localTaskId?: string
  localCheckpoint?: import('../local-models/session-checkpoint').SessionCheckpoint
  /** Host-only evaluation override; never accepted from model tools or renderer settings. */
  localPolicy?: import('../local-models/agent-policy').LocalAgentPolicyOverrides
  nativeSessionId?: string
  newNativeSession?: boolean
  settings: SessionSettings
  emit(event: AdapterEvent): void
  /** Host-owned artifact capture hook: provider must call only on real lifecycle events. */
  beforeTool?(itemId: string, paths: string[]): Promise<void>
  afterTool?(itemId: string, paths: string[], success: boolean): Promise<void>
  environment?: NodeJS.ProcessEnv
  /** Backend-created provider-native MCP configuration file (or bounded inline fallback). */
  mcpConfig?: string
  /** The conductor-local MCP server (src/main/local-assist), in the same form as mcpConfig. */
  localAssistMcpConfig?: string
  /** The `conductor` MCP server (src/main/permission-grants/control-mcp.ts): tab messaging and
   *  permission requests as first-party tools, in the same form as mcpConfig. */
  conductorMcpConfig?: string
  /** Native allow rules the owner granted this one conversation (src/main/permission-grants):
   *  read at launch and whenever applyPermissionRules runs; used() when an approve-once rule's
   *  call has run, refused() when the classifier refused a call a rule was granted for. */
  /** denied: a classifier denial's card (its notice item) was shown, so it is a pending owner request from now on. */
  permissionGrants?: { rules(): Array<{ rule: string; once: boolean }>; used(rule: string): void; refused?(rule: string): void; denied?(itemId: string, request: DenialGrantRequest): void;
    nativePending?(call: NativeGrantCall): PermissionGrantRequest | undefined;
    executionStarted?(call: NativeGrantCall, evidence: 'tool-progress'): void;
    executionFinished?(call: NativeGrantCall, outcome: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown'): void }
  /** Host-only reviewer isolation; never accepted from worker settings or app-control input. */
  approvalReviewer?: boolean
  /** Trusted host policy, read at the moment a Claude permission transition is requested. */
  claudeFullAutoAuthorized?: () => boolean
  /** Host-only lean launch of a cloud evaluation turn (AgentSpec.profile): the adapter drops what the
   *  one prompt does not need (settings sources, skills, tools, optional features) before any turn. */
  profile?: import('../../shared/models').AgentLaunchProfile
  /** Delegated native approval events must pass the host reviewer gate, including Auto mode. */
  reviewApprovals?: boolean
  /** Host denial fence, including tools which native remembered rules would otherwise allow. */
  authorizeTool?(name: string, input: Json): Promise<string | undefined>
  /** Trusted, registered-session broker for the Local runtime only. Never a bearer token. */
  localControl?(method: string, args: Record<string, unknown>): Promise<unknown>
  /** Continue this provider process instead of starting one: start() restores the state and
   *  attaches, with no spawn and no handshake. */
  attach?: RuntimeDetachment
}
export interface ProviderAdapter {
  readonly provider: StructuredProvider
  readonly capabilities: ProviderCapabilities
  start(): Promise<void>
  submit(text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void>
  steer?(text: string, settings: SessionSettings, attachments?: ContextAttachment[], inputId?: string): Promise<void>
  respond(response: InteractionResponse): Promise<void>
  interrupt(): Promise<void>
  fork?(): Promise<string>
  archive?(archived: boolean): Promise<void>
  rename?(title: string): Promise<void>
  discover?(): Promise<Json>
  /** Refresh account allowance telemetry without starting or steering a model turn. */
  refreshUsage?(): Promise<void>
  /** How much provider-tracked work is outstanding that deliberately outlives the turn which
   *  started it - a backgrounded shell process, an armed watcher. A turn result says nothing
   *  about it: the tool call returned the moment the work was handed to the background. Only
   *  the runtime that reported the work can answer, so this is the live process' own count. */
  backgroundWork?(): number
  /** Stop every piece of that outstanding work through the runtime's own control, for a
   *  conversation that no longer owns it (agents.handoff successor). Returns how many it asked
   *  to stop; each retires from backgroundWork() as the runtime reports it stopped. */
  stopBackgroundWork?(): Promise<number>
  /** Hand the running provider its current owner-granted rules (options.permissionGrants).
   *  'unsupported' when it cannot take them live; they then apply from its next start. */
  applyPermissionRules?(): Promise<'applied' | 'unsupported'>
  /** Reconcile a changed host policy with a live Claude process. A process launched without the
   *  bypass capability reports restart-pending so its manager can resume it at a safe boundary. */
  refreshClaudeFullAutoPolicy?(settings?: SessionSettings): Promise<{ status: 'confirmed' | 'restart-pending' | 'blocked' | 'unchanged'; error?: string }>
  /** Fold the runtime's own transcript into its durable task state, keeping the same logical
   *  conversation (the local runtime; native CLIs compact themselves). Null when there is
   *  nothing to fold. */
  compactContext?(): Promise<Json | null>
  /** The runtime's compact view of where a run stands: stop reason, rounds, context figures,
   *  files changed. Null when the runtime does not keep one. */
  runStatus?(): Json | null
  stop?(): Promise<void>
  /** Let go of the provider process without ending it, so the next app process can continue it
   *  (docs/runtime-host.md). Null when the process is not held by the runtime host or a host
   *  call will not settle; the caller then stops the runtime as before. Afterwards the adapter
   *  is inert and must not be disposed of or used. */
  detach?(): Promise<RuntimeDetachment | null>
  history?(): Promise<import('../native-history').NativeHistoryItem[]>
  dispose(): void
}

/** Provider definitively rejected a response before answering the pending interaction. */
export class InteractionResponseRejectedError extends Error {}

/** Only a definite refusal permits automatically queueing the same input. */
export class SteeringUnavailableError extends Error {}
