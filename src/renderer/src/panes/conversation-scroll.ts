import type { TimelineItem } from '../../../shared/structured-agent'

/** Ignore selections in editors and other panes when following this conversation. */
export function hasTimelineSelection(element: HTMLElement | null, selection: Selection | null): boolean {
  return Boolean(element && selection?.toString() && (element.contains(selection.anchorNode) || element.contains(selection.focusNode)))
}

export interface OwnerPrompt { id: string; text: string; sequence: number }

/** The prompt to pin at the top of the conversation: the owner's own most recent message.
 *  A reply is not a prompt, and a prompt another Conductor tab dispatched through app control
 *  (`data.origin` set) is not one the owner typed here, so both are skipped. */
export function latestOwnerPrompt(items: TimelineItem[]): OwnerPrompt | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.data.type === 'text' && item.data.role === 'user' && !item.data.origin) return { id: item.id, text: item.data.text, sequence: item.sequence }
  }
  return null
}

const PINNED_PROMPT_BUDGET = 160
/** Collapse whitespace (a pasted multi-line prompt should still read as one line) before
 *  cutting it down to a character budget so the pinned bar stays a single compact row. */
export function truncatePromptPreview(text: string, limit = PINNED_PROMPT_BUDGET): string {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  return collapsed.length > limit ? collapsed.slice(0, limit).trimEnd() + '…' : collapsed
}

export type ScrollGeometry = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>

/** Forgiving distance that still counts as "at bottom" while already following, so a few
 * trailing pixels of layout noise don't cost the user their place. */
const FOLLOW_THRESHOLD_PX = 80
/** Tight distance required to count as "returned" once the user has deliberately left, so a
 * single wheel tick that still lands inside the loose follow band can't cancel the release. */
const RETURN_THRESHOLD_PX = 4

export function isAtConversationBottom(element: ScrollGeometry, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold
}

/**
 * A deliberate scroll up (wheel/keyboard) must win immediately and stay won until the user
 * actually scrolls back to the end, or the caller resets `wasFollowing` directly (the "jump to
 * latest" button). Using one loose threshold both ways lets a single wheel tick that still lands
 * inside that band flip following back on before the view has moved anywhere; the next auto-scroll
 * then yanks the timeline back down - the "stutters and won't let us leave bottom" fight.
 */
export function followsBottomAfterScroll(wasFollowing: boolean, geometry: ScrollGeometry): boolean {
  return isAtConversationBottom(geometry, wasFollowing ? FOLLOW_THRESHOLD_PX : RETURN_THRESHOLD_PX)
}
