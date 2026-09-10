/**
 * Turns a raw prompt into a short, readable name for a tab strip or a history row. The first
 * message an owner sends is usually the clearest one-line summary of what a conversation is for,
 * but at up to 60,000 characters it is nowhere near tab-strip length. This is the one place that
 * decides what that name looks like — used by the renderer's tab auto-naming
 * (panes/conversation-tab.ts) and, where safe, by the session title the main process stores, so
 * the two never drift apart.
 */
const MAX_LENGTH = 40
// Below this, cutting mid-word reads better than leaving only a few words before the ellipsis.
const MIN_WORD_BREAK = 16

export function deriveConversationTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  // A slash command names the action; whatever follows it is the readable summary. A bare
  // command with nothing after it is all there is to show, so fall back to the whole thing.
  const withoutCommand = collapsed.replace(/^\/\S+\s*/, '').trim()
  const body = withoutCommand || collapsed
  if (body.length <= MAX_LENGTH) return body
  const cut = body.slice(0, MAX_LENGTH)
  const breakAt = cut.lastIndexOf(' ')
  return (breakAt >= MIN_WORD_BREAK ? cut.slice(0, breakAt) : cut).trimEnd() + '…'
}
