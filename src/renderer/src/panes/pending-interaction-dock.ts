import type { TimelineItem } from '../../../shared/structured-agent'

/** Whether this pane can answer an interaction: the live runtime's own requests, plus a Codex
 *  async question, which is answered as a message and so outlives the runtime that asked it. */
export function answerableHere(item: TimelineItem, runtimeId: string, historical: boolean): boolean {
  if (historical) return false
  return item.runtimeId === runtimeId || item.data.type === 'interaction' && (item.data.interaction.input as { protocol?: string } | null)?.protocol === 'codex-async-question'
}

/**
 * The approvals and questions waiting for the owner in this conversation, oldest first: the dock
 * above the composer shows each with its buttons until it is answered or expires. A card used to
 * live only where it was raised in the timeline, so an agent that kept working (other tools,
 * subagents) scrolled it out of view, and the live window could page it out entirely; the dock
 * does not depend on where the timeline is scrolled.
 */
export function dockedInteractions(items: readonly TimelineItem[], runtimeId: string, historical: boolean): TimelineItem[] {
  if (historical) return []
  return items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending' && answerableHere(item, runtimeId, historical))
}
