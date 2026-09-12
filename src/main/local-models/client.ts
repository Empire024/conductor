/** Minimal OpenAI-compatible client for the local llama.cpp servers. Conductor already speaks
 *  this protocol shape to other providers, so nothing new is invented here: one streaming chat
 *  completion endpoint, tool calls in the standard function-call form, and the local API key on
 *  every request. */

export interface ToolCall { id: string; name: string; arguments: string }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number }

export interface CompletionResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string
  usage?: Usage
  /** Stream shape, for diagnostics only: how many SSE payloads arrived and how many could not be
   *  parsed. Lets a caller tell an empty answer apart from a malformed or truncated stream. */
  stream: { events: number; malformed: number }
}

type Delta = {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
}

/** Streamed tool calls arrive as fragments keyed by index: the id and name usually come in the
 *  first fragment and the JSON arguments accumulate across later ones. Kept separate from the
 *  transport so the assembly is unit-testable without a server. */
export class StreamAccumulator {
  content = ''
  reasoning = ''
  finishReason = ''
  usage: Usage | undefined
  events = 0
  malformed = 0
  private calls = new Map<number, ToolCall>()

  /** Returns the visible text delta, if any, so the caller can stream it onward. */
  push(delta: Delta | undefined, finishReason?: string | null): { text?: string; reasoning?: string } {
    this.events++
    if (finishReason) this.finishReason = finishReason
    const result: { text?: string; reasoning?: string } = {}
    if (typeof delta?.content === 'string' && delta.content) { this.content += delta.content; result.text = delta.content }
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) { this.reasoning += delta.reasoning_content; result.reasoning = delta.reasoning_content }
    for (const [position, fragment] of (delta?.tool_calls ?? []).entries()) {
      const index = Number.isInteger(fragment.index) ? fragment.index! : position
      const call = this.calls.get(index) ?? { id: '', name: '', arguments: '' }
      if (fragment.id) call.id = fragment.id
      if (fragment.function?.name) call.name = fragment.function.name
      if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments
      this.calls.set(index, call)
    }
    return result
  }

  toolCalls(): ToolCall[] {
    return [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([index, call]) => ({ ...call, id: call.id || `call_${index}` })).filter(call => call.name)
  }

  result(): CompletionResult {
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls: this.toolCalls(),
      finishReason: this.finishReason || 'stop',
      usage: this.usage,
      stream: { events: this.events, malformed: this.malformed }
    }
  }
}

export interface CompletionRequest {
  endpoint: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  /** Passed through to llama.cpp as `reasoning_effort`. 'none' makes the model answer without a
   *  thinking pass, which is what the smoke probe wants: a tiny token budget spent on the answer
   *  rather than on reasoning it never gets to finish. Left unset for real sessions. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
  signal?: AbortSignal
  onText?(delta: string): void
  onReasoning?(delta: string): void
}

const readUsage = (value: unknown): Usage | undefined => {
  const usage = value as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
  if (!usage || typeof usage !== 'object') return undefined
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
}

export async function chatCompletion(request: CompletionRequest): Promise<CompletionResult> {
  const response = await fetch(`${request.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.apiKey}` },
    signal: request.signal,
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 4096,
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.tools?.length ? { tools: request.tools, tool_choice: 'auto' } : {})
    })
  })
  if (response.status === 401 || response.status === 403) throw new Error('Local model rejected the API key; regenerate it with setup and restart the servers')
  if (!response.ok || !response.body) {
    // Server error bodies can echo the prompt back; only the status is reported.
    throw new Error(`Local model request failed with HTTP ${response.status}`)
  }
  const accumulator = new StreamAccumulator()
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let event: { choices?: Array<{ delta?: Delta; finish_reason?: string | null }>; usage?: unknown }
      try { event = JSON.parse(payload) } catch { accumulator.malformed++; continue }
      const usage = readUsage(event.usage)
      if (usage) accumulator.usage = usage
      for (const choice of event.choices ?? []) {
        const emitted = accumulator.push(choice.delta, choice.finish_reason)
        if (emitted.text) request.onText?.(emitted.text)
        if (emitted.reasoning) request.onReasoning?.(emitted.reasoning)
      }
    }
  }
  return accumulator.result()
}
