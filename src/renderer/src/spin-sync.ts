/** Every indeterminate spinner (stop button orbit, top tab ring, left-side tab ring, tree/app
 *  loaders) shares this one duration so `--spin-duration` in styles.css can drive them all. */
export const SPIN_DURATION_MS = 900

/** A spinner that mounts mid-cycle must join in step with spinners that mounted earlier. Anchoring
 *  every spinner to the same epoch (the Unix epoch, via the caller's clock reading) instead of its
 *  own mount time means any two spinners computed from the same duration land on the same phase,
 *  no matter when each one actually appears. A negative delay rewinds the animation to where it
 *  would already be if it had started at that epoch. */
export const spinPhaseDelayMs = (clockMs: number, durationMs: number = SPIN_DURATION_MS): number => {
  const elapsed = ((clockMs % durationMs) + durationMs) % durationMs
  return elapsed === 0 ? 0 : -elapsed
}

export const spinPhaseStyle = (clockMs: number, durationMs: number = SPIN_DURATION_MS): { animationDelay: string } => ({
  animationDelay: `${spinPhaseDelayMs(clockMs, durationMs)}ms`
})
