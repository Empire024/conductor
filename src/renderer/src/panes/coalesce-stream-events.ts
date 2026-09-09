import type { AgentEvent } from '../../../shared/structured-agent'

/** A frame's worth of provider events is reduced through projectAgentEvent one at a time,
 * and each text-delta event rebuilds the entire items array (O(items)). A fast stream can
 * queue dozens of deltas for the very same message before the next animation frame, so that
 * rebuild happens dozens of times for one visible update. Concatenating delta text is
 * associative, so merging an adjacent run of same-item deltas into one event before reducing
 * yields the identical projection in a single O(items) pass — no event is dropped or delayed,
 * they are combined inside the same already-coalesced frame.
 * Never merges across an event carrying nativeSessionId: structured-agent-reducer resolves a
 * delta to a different timeline item once a native session id is first revealed on it, so such
 * an event must stay its own boundary rather than blend into a neighbor. */
export function coalesceTextDeltas(events: AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = []
  for (const event of events) {
    const previous = merged.at(-1)
    if (previous && event.itemId !== undefined && event.nativeSessionId === undefined && event.data.type === 'text' && event.data.mode === 'delta' &&
        previous.nativeSessionId === undefined && previous.data.type === 'text' && previous.data.mode === 'delta' &&
        previous.itemId === event.itemId && previous.runtimeId === event.runtimeId && previous.turnId === event.turnId) {
      merged[merged.length - 1] = { ...event, data: { ...event.data, text: previous.data.text + event.data.text } }
    } else merged.push(event)
  }
  return merged
}
