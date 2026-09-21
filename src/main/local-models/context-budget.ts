import type { ChatMessage, ToolSpec } from './client.ts'

export const TOOL_RESULT_CHAR_LIMIT = 32_000

/** The timeline receives the full tool output before this representation enters history.
 * Include the marker itself in the limit; otherwise repeated clamping grows the request. */
export function boundedToolResult(output: string, limit = TOOL_RESULT_CHAR_LIMIT): string {
  if (!Number.isInteger(limit) || limit < 256) throw new Error('Tool result limit must be at least 256 characters')
  if (output.length <= limit) return output
  let kept = limit
  let marker = ''
  for (let pass = 0; pass < 8; pass++) {
    marker = `\n[... ${output.length - kept} characters omitted. Full output is available in the tool result for review. Retrieve missing file text with read_file using a positive 1-based offset and a smaller limit, or search for the needed text. ...]\n`
    const next = Math.max(0, limit - marker.length)
    if (next === kept) break
    kept = next
  }
  const head = Math.ceil(kept / 2)
  return output.slice(0, head) + marker + output.slice(output.length - (kept - head))
}

export interface RequestBudget { promptTokens: number; responseTokens: number; contextTokens: number; totalTokens: number }

/** Final wire-payload estimate, after every history transformation. This is deliberately
 * separate from trimming's selection heuristic: JSON overhead, ids, schema descriptions and
 * repaired tool results all count. UTF-8 avoids treating non-ASCII text as cheap characters.
 * Three bytes/token plus template padding is an estimate, not llama.cpp's tokenizer; the
 * server remains authoritative and its bounded context-error retry remains in place. */
export function requestBudget(messages: ChatMessage[], tools: ToolSpec[], contextTokens: number, responseTokens: number): RequestBudget {
  if (!Number.isInteger(contextTokens) || contextTokens <= 0 || !Number.isInteger(responseTokens) || responseTokens <= 0) throw new Error('Invalid local request context or response reserve')
  const bytes = Buffer.byteLength(JSON.stringify({ messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }), 'utf8')
  const promptTokens = Math.ceil(bytes / 3) + 256 + messages.length * 16
  return { promptTokens, responseTokens, contextTokens, totalTokens: promptTokens + responseTokens }
}

export class ContextBudgetError extends Error {
  constructor(budget: RequestBudget) {
    super(`This request no longer fits ${budget.contextTokens} tokens of local context: estimated ${budget.promptTokens} prompt tokens including messages and tool schemas, plus ${budget.responseTokens} reserved for the answer. Start a new conversation or send a smaller step. No request was sent.`)
    this.name = 'ContextBudgetError'
  }
}

export function assertRequestBudget(messages: ChatMessage[], tools: ToolSpec[], contextTokens: number, responseTokens: number): RequestBudget {
  const budget = requestBudget(messages, tools, contextTokens, responseTokens)
  if (budget.totalTokens > contextTokens) throw new ContextBudgetError(budget)
  return budget
}
