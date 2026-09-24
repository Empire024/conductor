import type { AgentEventData, Json } from './structured-agent'

/** Why a local model turn ended, with the numbers behind it. The local runtime emits one of
 *  these on every turn as a notice payload; the conversation shows it as a card when the reason
 *  is anything but an ordinary completion, and a controller reads it from agents.status. The
 *  owner should never have to guess from a generic failure whether it was tokens or rounds. */
export type LocalStopReason =
  | 'completed'
  | 'interrupted'
  | 'round_limit'
  | 'stagnation'
  | 'context_limit'
  | 'output_limit'
  /** A tool call was cut off at the output limit again after the runtime asked for smaller parts. */
  | 'output_budget_loop'
  | 'unverified_claim'
  | 'provider_error'
  | 'empty_answer'

export interface LocalContextFigures {
  /** Tokens the last request occupied (exact, from the server) or the next one would (estimated). */
  usedTokens: number
  /** The window less the reserve: what the prompt may occupy. */
  capacityTokens: number
  reserveTokens: number
  windowTokens: number
  percent: number
  estimated: boolean
}

export interface LocalRoundEntry {
  round: number
  promptTokens: number
  outputTokens?: number
  level: string
  tools: string[]
  /** Raw tool-output characters this round kept out of the active prompt. */
  excludedChars: number
  event?: 'compaction' | 'warning' | 'stagnation' | 'finish' | 'acceptance'
}

export interface LocalStopReport {
  reason: LocalStopReason
  /** One sentence for a person. */
  detail: string
  rounds: number
  hardLimit: number
  context: LocalContextFigures
  compactions: number
  recoveredTokens: number
  loopWarnings: number
  filesChanged: string[]
  commandsRun: number
  excludedOutputChars: number
  acceptance?: { command: string; passed: boolean; exitCode: number }
  /** Set for unverified_claim: what was claimed without evidence. */
  unverified?: string
  timeline: LocalRoundEntry[]
  task?: { lifecycle: string; requests: number; recoveries: number; elapsedMs: number; tokens: number; segmentLimit: number; maxRounds: number }
}

export const LOCAL_STOP_KEY = 'localStop'

export const localStopLabels: Record<LocalStopReason, string> = {
  completed: 'Completed',
  interrupted: 'Interrupted',
  round_limit: 'Tool-round limit reached',
  stagnation: 'Stopped: repeating without progress',
  context_limit: 'Context limit reached',
  output_limit: 'Model output limit reached',
  output_budget_loop: 'Stopped: tool call too large for the output limit twice',
  unverified_claim: 'Unverified completion claim',
  provider_error: 'Local server error',
  empty_answer: 'No answer produced'
}

/** The one-line form the timeline notice and a controller summary use. */
export function localStopSummary(report: LocalStopReport): string {
  const context = `${report.context.usedTokens.toLocaleString()} / ${report.context.capacityTokens.toLocaleString()} tokens (${Math.round(report.context.percent)}%${report.context.estimated ? ', estimated' : ''})`
  return `${localStopLabels[report.reason]} after ${report.rounds} of ${report.hardLimit} tool rounds; context ${context}${report.compactions ? `; compacted ${report.compactions}×` : ''}${report.loopWarnings ? `; ${report.loopWarnings} loop warning${report.loopWarnings === 1 ? '' : 's'}` : ''}.`
}

export const localStopPayload = (report: LocalStopReport): Json => ({ [LOCAL_STOP_KEY]: report as unknown as Json })

/** The report a notice item carries, if it is one. Shape-checked because the payload is Json. */
export function localStopOf(data: AgentEventData): LocalStopReport | undefined {
  if (data.type !== 'notice' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return undefined
  const report = data.payload[LOCAL_STOP_KEY]
  if (!report || typeof report !== 'object' || Array.isArray(report)) return undefined
  const value = report as Record<string, Json>
  if (typeof value.reason !== 'string' || !(value.reason in localStopLabels) || typeof value.detail !== 'string' || typeof value.rounds !== 'number' || typeof value.hardLimit !== 'number') return undefined
  const context = value.context
  if (!context || typeof context !== 'object' || Array.isArray(context) || typeof context.usedTokens !== 'number' || typeof context.capacityTokens !== 'number') return undefined
  return value as unknown as LocalStopReport
}
