/**
 * PTY applications generally repaint after a resize. Those bytes describe the
 * same screen at a new size and must not be treated as fresh agent work.
 */
export const AGENT_RESIZE_ACTIVITY_SUPPRESSION_MS = 850

export const extendResizeActivitySuppression = (
  currentUntil: number,
  now = Date.now(),
  duration = AGENT_RESIZE_ACTIVITY_SUPPRESSION_MS
): number => Math.max(currentUntil, now + duration)

export const shouldSignalAgentActivity = (suppressUntil: number, now = Date.now()): boolean =>
  now >= suppressUntil

/**
 * A PTY can emit bytes while its application is completely idle (cursor paint,
 * prompt animations, terminal capability replies, and full-screen redraws).
 * Those bytes only represent agent work after the user has actually submitted
 * something to the runtime.
 */
export const shouldSignalAgentOutput = (
  workPending: boolean,
  suppressUntil: number,
  now = Date.now()
): boolean => workPending && shouldSignalAgentActivity(suppressUntil, now)

/** Produces a stable semantic fingerprint, ignoring ANSI paint, spinner glyphs,
 * changing counters, and whitespace-only screen updates. */
export const normalizeAgentOutputSignal = (value: string): string => {
  const signal = value
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, ' ')
    .replace(/\d+(?:[.:/]\d+)*/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return signal.length >= 12 ? signal.slice(-1600) : ''
}
