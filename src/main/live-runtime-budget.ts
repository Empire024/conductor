import type { SessionPhase } from '../shared/structured-agent'

export type LiveRuntimeBoundary = 'active-runtime' | 'human-wait'
export interface LiveRuntimeLimits {
  /** Overrides may tighten the suite defaults, never raise them. */
  activeMs?: number
  humanWaitMs?: number
  /** Monotonic clock; injectable for deterministic zero-inference tests. */
  now?: () => number
}
const ACTIVE_LIMIT_MS = 90_000
const HUMAN_WAIT_LIMIT_MS = 30_000
const finished = new Set<SessionPhase>(['idle', 'completed', 'failed', 'disconnected', 'interrupted'])
const waiting = new Set<SessionPhase>(['waiting_approval', 'waiting_input'])

/** Host-owned per-prompt allowance. Hidden panes do not pause either clock. */
export class LiveRuntimeBudget {
  private readonly activeLimit: number
  private readonly humanWaitLimit: number
  private readonly now: () => number
  private lastAccounted: number
  private activeConsumed = 0
  private humanWaitConsumed = 0
  private phase: SessionPhase = 'running'
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(private onBoundary: (boundary: LiveRuntimeBoundary) => void, limits: LiveRuntimeLimits = {}) {
    this.activeLimit = this.limit(limits.activeMs, ACTIVE_LIMIT_MS)
    this.humanWaitLimit = this.limit(limits.humanWaitMs, HUMAN_WAIT_LIMIT_MS)
    this.now = limits.now ?? (() => performance.now())
    this.lastAccounted = this.now()
    this.schedule()
  }

  /** Accrue the prior state before switching clocks; repeated phases never reset allowance. */
  setPhase(phase: SessionPhase): void {
    if (this.stopped) return
    this.account()
    if (this.checkBoundary()) return
    this.phase = phase
    if (finished.has(phase)) { this.dispose(); return }
    this.schedule()
  }

  dispose(): void {
    if (this.stopped) return
    this.account()
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private limit(requested: number | undefined, maximum: number): number {
    if (requested === undefined) return maximum
    if (!Number.isFinite(requested) || requested <= 0 || requested > maximum) throw new Error('Live runtime limits must be positive and may only tighten suite defaults')
    return requested
  }

  private account(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.lastAccounted)
    this.lastAccounted = now
    if (waiting.has(this.phase)) this.humanWaitConsumed += elapsed
    else this.activeConsumed += elapsed
  }

  private checkBoundary(): boolean {
    const boundary: LiveRuntimeBoundary | undefined = this.activeConsumed >= this.activeLimit ? 'active-runtime' : this.humanWaitConsumed >= this.humanWaitLimit ? 'human-wait' : undefined
    if (!boundary) return false
    // Claim termination before calling the host: cancellation can re-enter setPhase/dispose.
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.onBoundary(boundary)
    return true
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const remaining = waiting.has(this.phase) ? this.humanWaitLimit - this.humanWaitConsumed : this.activeLimit - this.activeConsumed
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      this.account()
      if (!this.checkBoundary()) this.schedule()
    }, Math.max(0, remaining))
    this.timer.unref?.()
  }
}
