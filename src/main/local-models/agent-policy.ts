/** Every knob of the local coding-agent loop, in one typed object with defaults sized for a 32K
 *  window on a 9B model. Nothing below is a user-facing setting yet; callers pass a partial
 *  override (a task contract, the research grant, a test) and get a complete, validated policy.
 *
 *  The order of defence is the point of the numbers: avoid injecting data (file-read window,
 *  scoped tools), shape tool results (output budgets), keep durable state apart from the
 *  transcript (compaction), notice loops, and make a finished agent stop. A larger window is the
 *  last resort, not the first. */

export interface ContextPolicy {
  /** Fraction of the usable window at which the model is told, once, to wrap up exploration. */
  warnAt: number
  /** Fraction at which older rounds are folded into the durable task state before the request. */
  compactAt: number
  /** Fraction at which compaction keeps only the newest round and the task state. */
  aggressiveAt: number
  /** Held back for the answer on an ordinary tool round. llama.cpp refuses a prompt that leaves
   *  no room to generate into, so this is subtracted from the window before anything is sent. */
  toolRoundReserveTokens: number
  /** Held back once the loop is asking for the final answer or a long-form reply. */
  finalAnswerReserveTokens: number
  /** Tool-call groups kept verbatim after an ordinary compaction; the aggressive form keeps one. */
  keepRecentGroups: number
}

export interface ToolOutputPolicy {
  /** Characters of one shell result that enter the active prompt. The full result stays in the
   *  timeline and the raw-output log. */
  commandChars: number
  /** Characters of a shaped test report. Failing tests are kept whole up to this size. */
  testReportChars: number
  /** Lines read_file returns when the model names no range. The header says the total. */
  readWindowLines: number
  /** Hard cap on lines per read_file call, whatever the model asks for. */
  readMaxLines: number
  /** Characters of a search, listing or web result kept in the prompt. */
  otherChars: number
  /** Characters an old tool result shrinks to once a newer round has superseded it. */
  supersededChars: number
  /** Characters an old assistant narration shrinks to; its conclusion, not its deliberation. */
  narrationChars: number
}

export interface RoundPolicy {
  /** First nudge: reassess the remaining work, stop exploring. */
  softWarningAt: number
  /** Second nudge: name the unresolved failure and drive at it. */
  strongWarningAt: number
  /** Finish phase: one decisive validation, then the final answer. */
  finishAt: number
  /** The loop stops here whatever the model still wants to do. */
  hardLimit: number
}

export interface StagnationPolicy {
  /** Identical tool calls (same tool, same normalised arguments) before the model is corrected. */
  repeatWarnAt: number
  /** Identical calls before the run is ended with a blocker report. */
  repeatStopAt: number
  /** Rounds without any new evidence (a new file changed, a new command result) before a warning. */
  idleRoundsWarnAt: number
}

export interface GenerationPolicy {
  /** Characters of one streamed answer after which self-corrections are counted. */
  ruminationMinChars: number
  /** Self-correction phrases ("Wait", "Actually", "Hmm") per 1000 characters that end generation. */
  ruminationDensity: number
  /** Hard stop for one streamed answer that is all narration and no call. */
  ruminationMaxChars: number
}

export interface LocalAgentPolicy {
  context: ContextPolicy
  toolOutput: ToolOutputPolicy
  rounds: RoundPolicy
  stagnation: StagnationPolicy
  generation: GenerationPolicy
  /** Cumulative task budget. A reasoning segment never resets these counters. */
  task: { maxRounds: number; maxRequests: number; maxRecoveries: number; maxMilliseconds: number; maxTokens: number }
}

export const DEFAULT_LOCAL_AGENT_POLICY: LocalAgentPolicy = {
  context: { warnAt: 0.70, compactAt: 0.78, aggressiveAt: 0.90, toolRoundReserveTokens: 2560, finalAnswerReserveTokens: 1536, keepRecentGroups: 2 },
  toolOutput: { commandChars: 6000, testReportChars: 6000, readWindowLines: 200, readMaxLines: 800, otherChars: 8000, supersededChars: 400, narrationChars: 500 },
  rounds: { softWarningAt: 10, strongWarningAt: 16, finishAt: 20, hardLimit: 24 },
  stagnation: { repeatWarnAt: 3, repeatStopAt: 6, idleRoundsWarnAt: 6 },
  generation: { ruminationMinChars: 2500, ruminationDensity: 4, ruminationMaxChars: 9000 },
  task: { maxRounds: 72, maxRequests: 96, maxRecoveries: 3, maxMilliseconds: 1_200_000, maxTokens: 1_000_000 }
}

/** Research is search, read, re-search: the rounds are the work, so every stage moves out. */
export const RESEARCH_ROUNDS: RoundPolicy = { softWarningAt: 24, strongWarningAt: 36, finishAt: 42, hardLimit: 48 }

export type LocalAgentPolicyOverrides = { [K in keyof LocalAgentPolicy]?: Partial<LocalAgentPolicy[K]> }

/** A complete policy from partial overrides, checked so a misordered threshold cannot make the
 *  loop compact after it warned about the hard limit or reserve more than the window holds. */
export function resolveLocalAgentPolicy(overrides: LocalAgentPolicyOverrides = {}, base: LocalAgentPolicy = DEFAULT_LOCAL_AGENT_POLICY): LocalAgentPolicy {
  const policy: LocalAgentPolicy = {
    context: { ...base.context, ...overrides.context },
    toolOutput: { ...base.toolOutput, ...overrides.toolOutput },
    rounds: { ...base.rounds, ...overrides.rounds },
    stagnation: { ...base.stagnation, ...overrides.stagnation },
    generation: { ...base.generation, ...overrides.generation },
    task: { ...base.task, ...overrides.task }
  }
  const { context, rounds, stagnation, toolOutput } = policy
  const fraction = (value: number, name: string): void => { if (!(value > 0 && value <= 1)) throw new Error(`Local agent policy: ${name} must be a fraction between 0 and 1`) }
  fraction(context.warnAt, 'context.warnAt'); fraction(context.compactAt, 'context.compactAt'); fraction(context.aggressiveAt, 'context.aggressiveAt')
  if (!(context.warnAt <= context.compactAt && context.compactAt <= context.aggressiveAt)) throw new Error('Local agent policy: context thresholds must be ordered warn <= compact <= aggressive')
  const positive = (value: number, name: string): void => { if (!Number.isInteger(value) || value <= 0) throw new Error(`Local agent policy: ${name} must be a positive integer`) }
  positive(context.toolRoundReserveTokens, 'context.toolRoundReserveTokens'); positive(context.finalAnswerReserveTokens, 'context.finalAnswerReserveTokens'); positive(context.keepRecentGroups, 'context.keepRecentGroups')
  positive(rounds.softWarningAt, 'rounds.softWarningAt'); positive(rounds.strongWarningAt, 'rounds.strongWarningAt'); positive(rounds.finishAt, 'rounds.finishAt'); positive(rounds.hardLimit, 'rounds.hardLimit')
  if (!(rounds.softWarningAt <= rounds.strongWarningAt && rounds.strongWarningAt <= rounds.finishAt && rounds.finishAt <= rounds.hardLimit)) throw new Error('Local agent policy: round thresholds must be ordered soft <= strong <= finish <= hard')
  positive(stagnation.repeatWarnAt, 'stagnation.repeatWarnAt'); positive(stagnation.repeatStopAt, 'stagnation.repeatStopAt'); positive(stagnation.idleRoundsWarnAt, 'stagnation.idleRoundsWarnAt')
  if (stagnation.repeatWarnAt > stagnation.repeatStopAt) throw new Error('Local agent policy: stagnation warning must come before the stop')
  for (const key of Object.keys(toolOutput) as Array<keyof ToolOutputPolicy>) positive(toolOutput[key], `toolOutput.${key}`)
  for (const [key, value] of Object.entries(policy.task)) positive(value, `task.${key}`)
  if (toolOutput.readWindowLines > toolOutput.readMaxLines) throw new Error('Local agent policy: the default read window cannot exceed the read cap')
  return policy
}

/** Sizes in tokens are a heuristic for llama.cpp's tokenizer: three characters per token is
 *  the pessimistic end for code and JSON, which is what this loop mostly carries. The server
 *  stays authoritative and reports the real count after each request. */
export const CHARS_PER_TOKEN = 3
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)
