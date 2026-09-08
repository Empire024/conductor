import type { TimelineItem } from './structured-agent'

/** Old adapters counted hidden thinking in stream IDs but not in final IDs. */
export function recoverClaudeMessageDuplicates(items: TimelineItem[]): TimelineItem[] {
  return items.filter(item => {
    if (item.data.type !== 'text' || item.data.role !== 'assistant' || item.data.mode !== 'delta') return true
    const text = item.data.text
    const streamed = item.nativeItemId?.match(/^(msg_[^:]+):(\d+)$/)
    if (!streamed) return true
    return !items.some(final => {
      if (final.data.type !== 'text' || final.data.role !== 'assistant' || final.data.mode !== 'snapshot' || final.data.text !== text || final.runtimeId !== item.runtimeId || final.turnId !== item.turnId || final.parentId !== item.parentId) return false
      const complete = final.nativeItemId?.match(/^(msg_[^:]+):(\d+)$/)
      return complete?.[1] === streamed[1] && Number(complete?.[2]) < Number(streamed[2])
    })
  })
}
