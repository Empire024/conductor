import type { TimelineItem } from '../shared/structured-agent'

/**
 * A provider that is out of capacity right now ("Selected model is at capacity", OpenAI
 * server_overloaded or a 503, Anthropic 529 overloaded_error) refused this turn, not this
 * conversation: the same request goes through minutes later. StructuredSessions retries such a
 * turn on its own with these waits, then stops and says to switch model
 * (feature provider-capacity-retry). A usage limit is a different thing with a known end
 * (usage-limit.ts), and is never classified here.
 */
export const OVERLOAD_RETRY_DELAYS_MS: readonly number[] = [20_000, 60_000, 180_000]

/** What a turn that already did work is asked when the retry goes out: Codex and Claude keep
 *  the thread, so the model sees what it ran and need not run it again. */
export const OVERLOAD_CONTINUE_PROMPT = 'The provider was at capacity and cut your previous turn off. Continue where you left off; do not repeat tool calls or edits that already completed.'

const OVERLOADED_LANGUAGE = [
  // Codex: "Selected model is at capacity. Please try a different model."
  /\bat capacity\b/i,
  // OpenAI's error code, and Codex's own codexErrorInfo spelling of it.
  /\bserver[_\s-]?overloaded\b/i,
  // Anthropic's 529 body: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
  /\boverloaded[_\s-]error\b/i,
  /\b(?:is|are|currently|temporarily)\s+overloaded\b/i,
  /^\W*overloaded\W*$/i,
  /\b(?:api\s+error|status(?:\s+code)?|http)\W{0,3}529\b/i,
  /\b503\b[^\r\n]{0,80}\b(?:service\s+unavailable|overloaded|capacity)\b/i,
  /\bservice\s+unavailable\b[^\r\n]{0,40}\b503\b/i
]

/** Codex's structured classification, when the app-server sends one: serverOverloaded, or any
 *  variant whose upstream HTTP status was 503 or 529. */
export const isOverloadedErrorInfo = (info: unknown): boolean => {
  if (info === 'serverOverloaded') return true
  if (!info || typeof info !== 'object') return false
  return Object.values(info as Record<string, unknown>).some(value => {
    const status = value && typeof value === 'object' ? (value as { httpStatusCode?: unknown }).httpStatusCode : undefined
    return status === 503 || status === 529
  })
}

/** Whether a provider error event's text says it is out of capacity. Read only from error
 *  events: a tool's output can quote the same words without this turn being refused. */
export const isProviderOverloadedMessage = (message: string): boolean => OVERLOADED_LANGUAGE.some(pattern => pattern.test(message))

const PROVIDER_NAMES: Record<string, string> = { codex: 'OpenAI', claude: 'Anthropic', grok: 'xAI', local: 'The local model server' }
const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider
const modelName = (model: string | undefined): string => model?.trim() || 'the model'
const delayText = (ms: number): string => { const seconds = Math.round(ms / 1000); return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min` }

/** The one line a refused turn shows while a retry remains, in place of the raw error. */
export const overloadRetryNotice = (provider: string, model: string | undefined, delayMs: number, attempt: number, total = OVERLOAD_RETRY_DELAYS_MS.length): string =>
  `${providerName(provider)} says ${modelName(model)} is at capacity; retrying in ${delayText(delayMs)} (${attempt}/${total}).`

/** The error a turn ends with once every retry was refused too. */
export const overloadExhaustedMessage = (provider: string, model: string | undefined, original: string, retries = OVERLOAD_RETRY_DELAYS_MS.length): string =>
  `${providerName(provider)} kept refusing ${modelName(model)} as at capacity after ${retries} automatic ${retries === 1 ? 'retry' : 'retries'} ("${original.replace(/\s+/g, ' ').trim().slice(0, 200)}"). Switch this conversation to another model or provider and send it again; nothing more is retried automatically.`

/** Whether the turn that began after `since` did anything a resend would repeat or lose: an
 *  answer, a tool call, a file change or a subagent. A turn refused before any of that is sent
 *  again as it was; one that did work is asked to continue instead. */
export const turnProducedOutput = (items: readonly TimelineItem[], since: number): boolean => items.some(item => {
  if (item.sequence <= since) return false
  const data = item.data
  if (data.type === 'tool' || data.type === 'changes' || data.type === 'subagent') return true
  return data.type === 'text' && data.role === 'assistant' && Boolean(data.text.trim())
})
