/** The keys of a keydown the composer decides on. */
export interface ComposerEnterKey { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }

/**
 * Whether a keydown in a conversation's composer sends the draft. Enter sends when nothing is
 * running. While a turn runs the draft would go straight into it (steered, or queued behind it),
 * so there Enter stays a newline and only Ctrl+Enter (Cmd+Enter) or the Send button sends: a line
 * break typed mid-message once delivered the first line into the turn on its own (owner,
 * 2026-10-22: "i didnt send this message twice it auto sent"). Shift+Enter is always a newline.
 */
export function composerEnterSends(event: ComposerEnterKey, turnRunning: boolean): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return false
  return !turnRunning || event.ctrlKey || event.metaKey
}
