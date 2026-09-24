import type { CompletionRequest, CompletionResult } from '../local-models/client.ts'
import type { LocalModelConfig } from '../local-models/config.ts'
import type { LocalServerEntry } from '../local-models/servers.ts'

/**
 * Local assist: bounded jobs a frontier coworker (Claude, Codex) hands to the local model in the
 * same turn — summarising a long test run, reading a large file — so the frontier model reads a
 * few dozen lines instead of the raw output. Served as the `conductor-local` MCP server
 * (mcp-server.ts); every call is measured in the savings ledger (savings.ts).
 */

/** The MCP server name. Tools reach an agent as `mcp__conductor-local__<tool>`. */
export const LOCAL_ASSIST_MCP_SERVER_NAME = 'conductor-local'

/** How long a caller waits for the GPU (a busy slot, or a server that is still loading) before
 *  it gets the raw tail and a note instead. The frontier caller is never blocked on the model. */
export const MODEL_WAIT_BUDGET_MS = 20_000
/** One summary is a few hundred tokens; a generation still running after this is abandoned. */
export const GENERATION_TIMEOUT_MS = 90_000

export interface LocalModelAnswer {
  text: string
  model: string
  /** Prompt tokens the local server processed (usage, or chars/4 when it reports none). */
  inputTokens: number
  outputTokens: number
  durationMs: number
}

/** `ok: false` names why the local model was not used; the tool then returns raw lines and says so. */
export type LocalModelOutcome = { ok: true; answer: LocalModelAnswer } | { ok: false; reason: string }

export interface LocalModelRequest {
  system: string
  user: string
  maxTokens: number
  /** Overrides MODEL_WAIT_BUDGET_MS (tests). */
  waitBudgetMs?: number
  signal?: AbortSignal
}

export interface LocalModelRunner {
  /** One bounded, non-streaming answer. Never throws. Waits at most the wait budget for a server
   *  and a free slot, and at most GENERATION_TIMEOUT_MS for the answer. */
  ask(request: LocalModelRequest): Promise<LocalModelOutcome>
}

/** What the runner needs from the app; index.ts wires the real ones (model-runner.ts has a
 *  default factory over the real local-models modules). */
export interface LocalModelRunnerPorts {
  now(): number
  sleep(ms: number): Promise<void>
  /** Running llama.cpp servers (listLocalServers). */
  servers(): LocalServerEntry[]
  /** Configured local models (loadConfig().models); [] when the stack is not set up. */
  models(): LocalModelConfig[]
  /** The local API key; '' when missing. */
  apiKey(): string
  /** An unpackaged test endpoint that stands in for every server, or null. */
  endpointOverride(): string | null
  /** A server is healthy and answering for this model on this port. */
  healthy(port: number): Promise<boolean>
  /** The server's single slot is generating for someone right now (slotsProcessing). */
  slotBusy(port: number): Promise<boolean>
  /** An interactive local conversation is mid-turn in this Conductor (localTurnsInFlight() > 0). */
  interactiveBusy(): boolean
  /** startServer under the machine-wide admission lock; resolves once it answers. */
  start(model: LocalModelConfig): Promise<{ port: number }>
  complete(request: CompletionRequest): Promise<CompletionResult>
}

export type LocalAssistTool = 'run_and_summarize' | 'local_ask' | 'summarize_file'

export interface SavingsRecord {
  at: string
  tool: LocalAssistTool
  projectId: string
  agentSessionId: string
  provider: string
  /** Characters the frontier model would have read without this call. */
  rawChars: number
  /** Characters this call returned to it. */
  returnedChars: number
  localInputTokens: number
  localOutputTokens: number
  /** False when the call fell back to raw lines without the local model. */
  usedModel: boolean
  model?: string
}

export interface SavingsSummary {
  since: string
  through: string
  days: number
  calls: number
  modelCalls: number
  rawChars: number
  returnedChars: number
  localInputTokens: number
  localOutputTokens: number
  /** ≈ frontier tokens saved: Σ max(0, raw/4 − returned/4). */
  tokensSaved: number
}

/** ≈ frontier tokens one call saved. */
export const savedTokens = (rawChars: number, returnedChars: number): number => Math.max(0, Math.round(rawChars / 4 - returnedChars / 4))

export interface SavingsLedger {
  record(entry: Omit<SavingsRecord, 'at'> & { at?: string }): void
  /** Rolling window ending now (default 7 days). Never throws: an unreadable ledger is zero. */
  summary(days?: number, now?: Date): SavingsSummary
}
