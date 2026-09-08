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
  stop?(): Promise<void>
  history?(): Promise<import('../native-history').NativeHistoryItem[]>
  dispose(): void
}

/** Provider definitively rejected a response before answering the pending interaction. */
export class InteractionResponseRejectedError extends Error {}

/** Only a definite refusal permits automatically queueing the same input. */
export class SteeringUnavailableError extends Error {}
