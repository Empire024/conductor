import type { TimelineItem } from './structured-agent'
import { localStopOf } from './local-stop'

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
  return items.some((other) => other !== item && other.runtimeId === item.runtimeId && other.nativeItemId === item.nativeItemId && other.data.type === 'interaction' && other.data.interaction.kind === 'question')
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
  return data.payload === undefined
}
