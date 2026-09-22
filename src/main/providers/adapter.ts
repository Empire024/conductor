import type { AdapterEvent, ContextAttachment, InteractionResponse, Json, ProviderCapabilities, SessionSettings, StructuredProvider } from '../../shared/structured-agent'

export interface AdapterOptions {
  executable: string
  cwd: string
  runtimeId: string
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
  /** Host-only reviewer isolation; never accepted from worker settings or app-control input. */
  approvalReviewer?: boolean
  /** Delegated native approval events must pass the host reviewer gate, including Auto mode. */
  reviewApprovals?: boolean
  /** Host denial fence, including tools which native remembered rules would otherwise allow. */
  authorizeTool?(name: string, input: Json): Promise<string | undefined>
  /** Trusted, registered-session broker for the Local runtime only. Never a bearer token. */
  localControl?(method: string, args: Record<string, unknown>): Promise<unknown>
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
  stop?(): Promise<void>
  history?(): Promise<import('../native-history').NativeHistoryItem[]>
  dispose(): void
}

/** Provider definitively rejected a response before answering the pending interaction. */
export class InteractionResponseRejectedError extends Error {}

/** Only a definite refusal permits automatically queueing the same input. */
export class SteeringUnavailableError extends Error {}
