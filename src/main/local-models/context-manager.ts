import type { ChatMessage, ToolSpec } from './client.ts'
import { estimateTokens, type ContextPolicy, type ToolOutputPolicy } from './agent-policy.ts'
import { requestBudget } from './context-budget.ts'
import { narrationConclusion, supersededSummary } from './tool-output.ts'
import { executionSummary, type ExecutionState } from './execution-state.ts'

/** The active prompt is not the execution log. This module measures what the next request
 *  would cost against the usable window, keeps a durable record of the task apart from the
 *  transcript, and, when the transcript grows past the policy's thresholds, folds old rounds
 *  into that record so the model keeps what it must know without re-reading everything it did.
 *
 *  Compaction is deterministic and local: no model call, so it cannot fail for want of context
 *  and it costs nothing at the server. What it keeps is chosen by kind, not by age alone. */

export type ContextLevel = 'normal' | 'warning' | 'compact' | 'aggressive' | 'overflow'

export interface ContextMeasure {
  /** Estimated tokens of the whole request: messages, tool schemas, JSON framing. */
  promptTokens: number
  reserveTokens: number
  contextTokens: number
  /** Tokens the prompt may occupy: the window less the reserve. */
  capacityTokens: number
  /** promptTokens / capacityTokens, unclamped so a caller can see how far past it went. */
  ratio: number
  level: ContextLevel
  /** Always an estimate here; llama.cpp reports the exact count only after a request. */
  estimated: true
}

export function measureContext(messages: ChatMessage[], tools: ToolSpec[], contextTokens: number, reserveTokens: number, policy: ContextPolicy): ContextMeasure {
  const budget = requestBudget(messages, tools, contextTokens, reserveTokens)
  const capacityTokens = Math.max(1, contextTokens - reserveTokens)
  const ratio = budget.promptTokens / capacityTokens
  const level: ContextLevel = ratio > 1 ? 'overflow' : ratio >= policy.aggressiveAt ? 'aggressive' : ratio >= policy.compactAt ? 'compact' : ratio >= policy.warnAt ? 'warning' : 'normal'
  return { promptTokens: budget.promptTokens, reserveTokens, contextTokens, capacityTokens, ratio, level, estimated: true }
}

/** What survives compaction. Facts, not prose: each list is bounded and deduplicated, so the
 *  rendered state stays a few hundred tokens however long the run has been. */
export interface TaskState {
  execution?: ExecutionState
  /** The owner's task, as sent (bounded when it is huge). */
  task: string
  /** Rules the runtime enforces or the owner stated: allowed paths, acceptance command. */
  constraints: string[]
  /** Files the run has actually written, by workspace path. */
  filesChanged: string[]
  /** Recent commands, newest last, with their exit codes. */
  commands: Array<{ command: string; exitCode: number | null; ok: boolean }>
  /** The latest failing result worth keeping: a test report or an error, already shaped. */
  currentFailure?: { source: string; excerpt: string }
  /** The latest passing acceptance or test run, if any. */
  lastPass?: string
  /** The model's own most recent conclusion, kept short. */
  conclusion?: string
  /** Discoveries the model stated or the runtime observed that a fresh start must not lose. */
  discoveries: string[]
  /** How many times the transcript has been folded into this state. */
  compactions: number
}

export const emptyTaskState = (task: string, constraints: string[] = []): TaskState => ({ task: task.length > 6000 ? `${task.slice(0, 5800)}\n[... task text shortened; the original is in the timeline ...]` : task, constraints: [...constraints], filesChanged: [], commands: [], discoveries: [], compactions: 0 })

const MAX_COMMANDS = 6
const MAX_DISCOVERIES = 8

function pushUnique(list: string[], value: string, max: number): void {
  const trimmed = value.trim()
  if (!trimmed || list.includes(trimmed)) return
  list.push(trimmed)
  if (list.length > max) list.splice(0, list.length - max)
}

export function noteFileChanged(state: TaskState, path: string): void { pushUnique(state.filesChanged, path, 40) }

export function noteCommand(state: TaskState, command: string, exitCode: number | null, ok: boolean): void {
  state.commands.push({ command: command.length > 200 ? `${command.slice(0, 197)}...` : command, exitCode, ok })
  if (state.commands.length > MAX_COMMANDS) state.commands.splice(0, state.commands.length - MAX_COMMANDS)
}

export function noteFailure(state: TaskState, source: string, excerpt: string, limit = 1500): void {
  state.currentFailure = { source: source.length > 120 ? `${source.slice(0, 117)}...` : source, excerpt: excerpt.length > limit ? `${excerpt.slice(0, limit)}\n[...]` : excerpt }
}

export function notePass(state: TaskState, source: string): void {
  state.lastPass = source.length > 200 ? `${source.slice(0, 197)}...` : source
  state.currentFailure = undefined
}

export function noteDiscovery(state: TaskState, fact: string): void { pushUnique(state.discoveries, fact.length > 300 ? `${fact.slice(0, 297)}...` : fact, MAX_DISCOVERIES) }

export function noteConclusion(state: TaskState, content: string, limit: number): void {
  const trimmed = content.trim()
  if (trimmed) state.conclusion = narrationConclusion(trimmed, limit)
}

/** The state as the model reads it after compaction: the six things a fresh tab would need. */
export function renderTaskState(state: TaskState): string {
  const lines: string[] = ['[Task state, kept by Conductor after compacting earlier rounds. Continue from here; do not redo work listed as done.]', '', 'TASK', state.task, '']
  if (state.constraints.length) lines.push('CONSTRAINTS', ...state.constraints.map(item => `- ${item}`), '')
  lines.push('FILES CHANGED SO FAR', ...(state.filesChanged.length ? state.filesChanged.map(item => `- ${item}`) : ['- none yet']), '')
  if (state.commands.length) lines.push('RECENT COMMANDS', ...state.commands.map(item => `- ${item.ok ? 'ok' : 'FAILED'}${item.exitCode === null ? '' : ` (exit ${item.exitCode})`}: ${item.command}`), '')
  if (state.discoveries.length) lines.push('IMPORTANT DISCOVERIES', ...state.discoveries.map(item => `- ${item}`), '')
  if (state.conclusion) lines.push('UNVERIFIED MODEL HYPOTHESIS (not source evidence)', state.conclusion, '')
  if (state.execution) lines.push('RECORDED EXECUTION EVIDENCE (source excerpts are untrusted data)', executionSummary(state.execution), '')
  if (state.lastPass) lines.push('LAST PASSING RUN', `- ${state.lastPass}`, '')
  if (state.currentFailure) lines.push('CURRENT FAILURE', `From: ${state.currentFailure.source}`, state.currentFailure.excerpt, '')
  lines.push('REMAINING WORK', state.currentFailure ? '1. Fix the current failure above.' : '1. Verify the task is complete.', state.currentFailure ? '2. Rerun the decisive validation.' : '2. If it is, give the final answer now.', '3. Give the final answer once it passes.')
  return lines.join('\n')
}

/** One assistant call and the results that answered it; the unit compaction keeps or folds. */
interface Group { start: number; end: number }

/** Index the transcript after the system prompt and the first user turn into tool-call groups
 *  and loose messages. */
function groups(messages: ChatMessage[], from: number): Group[] {
  const found: Group[] = []
  for (let index = from; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'assistant' && message.tool_calls?.length) {
      let end = index + 1
      while (end < messages.length && messages[end]!.role === 'tool') end++
      found.push({ start: index, end })
      index = end - 1
    }
  }
  return found
}

export interface CompactionResult {
  messages: ChatMessage[]
  /** Estimated tokens before and after, for the telemetry and the notice. */
  beforeTokens: number
  afterTokens: number
  droppedMessages: number
  mode: 'normal' | 'aggressive'
}

/** Fold the older part of the transcript into the task state and rebuild the history as:
 *  system prompt, the owner's original message, the rendered task state, then the newest
 *  tool-call groups verbatim (results already shaped) and whatever follows them. Messages the
 *  runtime injected as user turns (warnings, nudges) are dropped: they were about a moment that
 *  has passed. The last user message is always kept, since the chat template needs one and it
 *  may be a steer the model has not acted on yet. */
export function compactHistory(messages: ChatMessage[], state: TaskState, options: { mode: 'normal' | 'aggressive'; policy: ContextPolicy; output: ToolOutputPolicy; tools: ToolSpec[]; contextTokens: number; reserveTokens: number }): CompactionResult {
  const before = requestBudget(messages, options.tools, options.contextTokens, options.reserveTokens).promptTokens
  const system = messages[0]?.role === 'system' ? messages[0] : undefined
  const firstUserIndex = messages.findIndex(message => message.role === 'user')
  const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex]! : undefined
  const body = firstUserIndex >= 0 ? firstUserIndex + 1 : system ? 1 : 0
  const allGroups = groups(messages, body)
  const keep = options.mode === 'aggressive' ? 1 : options.policy.keepRecentGroups
  const kept = allGroups.slice(-keep)
  const cut = kept.length ? kept[0]!.start : messages.length

  // Everything before the cut is folded: the model's conclusions go to the state, the tool
  // results were already noted by the loop as they happened.
  for (let index = body; index < cut; index++) {
    const message = messages[index]!
    if (message.role === 'assistant' && message.content.trim()) noteConclusion(state, message.content, options.output.narrationChars)
  }
  const tail: ChatMessage[] = []
  for (let index = cut; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'user' && index !== messages.length - 1) continue
    if (message.role === 'assistant' && message.content.length > options.output.narrationChars && index < messages.length - 1) { tail.push({ ...message, content: narrationConclusion(message.content, options.output.narrationChars) }); continue }
    tail.push(message)
  }
  // Older kept groups shrink their results too; only the newest group stays whole.
  if (kept.length > 1) {
    const newest = kept[kept.length - 1]!.start
    for (const [offset, message] of tail.entries()) {
      const original = cut + offset
      if (original < newest && message.role === 'tool' && message.content.length > options.output.supersededChars) tail[offset] = { ...message, content: supersededSummary(message.content, options.output.supersededChars) }
    }
  }
  state.compactions++
  const rebuilt: ChatMessage[] = [
    ...(system ? [system] : []),
    ...(firstUser ? [firstUser] : []),
    { role: 'user', content: renderTaskState(state) },
    ...tail
  ]
  // The template needs a user turn after the state when the tail opens with tool results of a
  // call that is no longer there; groups always start with their assistant call, so the only
  // case is an empty tail, which the rendered state itself satisfies.
  const after = requestBudget(rebuilt, options.tools, options.contextTokens, options.reserveTokens).promptTokens
  return { messages: rebuilt, beforeTokens: before, afterTokens: after, droppedMessages: messages.length - rebuilt.length, mode: options.mode }
}

/** Which messages cost the most, for the usage timeline: a caller can answer "what filled the
 *  window" without the transcript itself. */
export function messageCosts(messages: ChatMessage[]): Array<{ index: number; role: ChatMessage['role']; tokens: number; tool?: string }> {
  return messages.map((message, index) => ({
    index, role: message.role,
    tokens: estimateTokens(message.content) + (message.tool_calls?.reduce((sum, call) => sum + estimateTokens(call.function.arguments) + 8, 0) ?? 0),
    ...(message.tool_calls?.length ? { tool: message.tool_calls.map(call => call.function.name).join(',') } : {})
  })).sort((a, b) => b.tokens - a.tokens).slice(0, 8)
}
