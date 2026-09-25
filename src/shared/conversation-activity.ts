import type { TimelineItem } from './structured-agent'
import { localStopOf } from './local-stop'
import { isControlActivityNotice } from './control-activity'

/** Claude's CLI keeps a long-running tool visible by re-emitting it under a synthetic
 *  `<toolUseId>-heartbeat-N` item that carries no input and repeats its parent's name. Those
 *  are liveness pings rather than activity, and a single skill can produce dozens of them. */
export function isRuntimeHeartbeat(item: TimelineItem): boolean {
  if (item.data.type !== 'tool' || !item.nativeItemId || !item.parentId) return false
  const suffix = item.nativeItemId.slice((item.parentId + '-heartbeat-').length)
  return item.nativeItemId.startsWith(item.parentId + '-heartbeat-') && /^\d+$/.test(suffix)
}
/** Claude represents "ask the user a question" as both a real `AskUserQuestion` tool call and a
 *  separate interaction request, correlated by sharing the same native tool_use id. The tool
 *  call's own row only ever repeats the question and the provider's raw, unreadable echo of the
 *  answer, so once a sibling question interaction shares that id the bare tool call is a
 *  duplicate rather than new information. */
export function isAnsweredThroughInteraction(item: TimelineItem, items: TimelineItem[]): boolean {
  if (item.data.type !== 'tool' || !item.nativeItemId) return false
  return questionKeys(items).has(item.runtimeId + '\n' + item.nativeItemId)
}
// Filtering a timeline asks this of every tool call, so scanning the whole timeline each time made
// a 2,000-item conversation cost millions of comparisons per streamed frame. The question
// interactions of one timeline array are indexed once; a projection never changes an array in
// place, and a different length rebuilds the index regardless.
const questionIndex = new WeakMap<TimelineItem[], { length: number; keys: Set<string> }>()
function questionKeys(items: TimelineItem[]): Set<string> {
  const cached = questionIndex.get(items)
  if (cached?.length === items.length) return cached.keys
  const keys = new Set<string>()
  for (const other of items) if (other.data.type === 'interaction' && other.data.interaction.kind === 'question' && other.nativeItemId) keys.add(other.runtimeId + '\n' + other.nativeItemId)
  questionIndex.set(items, { length: items.length, keys })
  return keys
}
/** Diagnostics remain in the event inspector, not the conversation timeline. `items` is only
 *  supplied when called through `Array.prototype.filter`, which passes it as the third argument. */
export function isConversationActivity(item: TimelineItem, _index?: number, items: TimelineItem[] = []): boolean {
  const data = item.data
  if (data.type === 'session' || data.type === 'usage') return false
  if (isRuntimeHeartbeat(item)) return false
  if (data.type === 'subagent') return ['failed', 'interrupted', 'rejected'].includes(data.status)
  if (isAnsweredThroughInteraction(item, items)) return false
  if (data.type !== 'notice') return true
  if (data.outputArtifactId) return true
  if (/^(?:Snapshot unavailable:|Unsupported .*control request:|Live retry stopped:|Incomplete tool input JSON;)/.test(data.message) || data.message.includes('Interruption requested;')) return true
  if (/^(?:Codex event:|Grok event:|Codex process diagnostic|Claude process diagnostic|Grok process diagnostic|Codex effective thread settings|Native Codex settings updated|Current turn diff \(provider aggregate\)|Codex live fixture isolation|Claude runtime capabilities|Claude reported a lower cumulative cost)/.test(data.message)) return false
  // A local run's stop report is conversation activity whenever it is not the model's own final
  // answer: the owner must see "round limit" or "context limit" where a failure would otherwise be.
  const stop = localStopOf(data)
  if (stop) return stop.reason !== 'completed'
  // What a conversation did through app control, and who drove this one (control-activity.ts).
  if (isControlActivityNotice(data)) return true
  return data.payload === undefined
}
