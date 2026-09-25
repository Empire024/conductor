/**
 * Whether the owner is typing right now, so a focus change an agent asked for can wait for a
 * pause instead of pulling the caret out from under a half-written sentence (FX21).
 *
 * Two signals: the last key the owner pressed in any Conductor window (before-input-event, which
 * also sees the keys a parked smoke sends), and the system-wide idle time, which covers typing in
 * another application that Conductor would otherwise raise itself over.
 */
export interface OwnerInput {
  /** Epoch ms of the last key pressed in a Conductor window; 0 when none yet. */
  lastKeyAt(): number
  /** Whole seconds since the last keyboard or mouse input anywhere; undefined when unknown. */
  systemIdleSeconds(): number | undefined
}

/** How long the keyboard has to be still before a deferred focus goes ahead. */
export const TYPING_PAUSE_MS = 1500
/** A focus request still waiting after this long is dropped: the tab is already open, and moving
 *  the owner there minutes later would be a surprise rather than a convenience. */
export const FOCUS_WAIT_LIMIT_MS = 5 * 60_000

export function ownerIsTyping(input: OwnerInput, now = Date.now()): boolean {
  if (now - input.lastKeyAt() < TYPING_PAUSE_MS) return true
  const idle = input.systemIdleSeconds()
  return idle !== undefined && idle < 1
}

/** Resolves true once the owner pauses, false when they are still typing at `limitMs`. */
export async function waitForOwnerPause(input: OwnerInput, options: { now?: () => number; sleep?: (ms: number) => Promise<void>; limitMs?: number; pollMs?: number } = {}): Promise<boolean> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (options.limitMs ?? FOCUS_WAIT_LIMIT_MS)
  while (ownerIsTyping(input, now())) {
    if (now() >= deadline) return false
    await sleep(options.pollMs ?? 250)
  }
  return true
}
