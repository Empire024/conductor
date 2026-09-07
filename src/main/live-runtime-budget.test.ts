import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveRuntimeBudget } from './live-runtime-budget'

afterEach(() => { vi.useRealTimers() })
const fixture = () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  const budget = new LiveRuntimeBudget(stop, { now: () => Date.now() })
  return { stop, budget }
}
describe('host live runtime allowance — fake clock, zero inference', () => {
  it('stops at 90 seconds of active runtime exactly once', () => {
    const { stop, budget } = fixture()
    vi.advanceTimersByTime(89_999); expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(stop).toHaveBeenCalledExactlyOnceWith('active-runtime')
    budget.setPhase('running'); vi.advanceTimersByTime(180_000)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('excludes human approval waits and resumes the remaining active allowance', () => {
    const { stop, budget } = fixture()
    vi.advanceTimersByTime(60_000)
    budget.setPhase('waiting_approval')
    vi.advanceTimersByTime(20_000); expect(stop).not.toHaveBeenCalled()
    budget.setPhase('running')
    vi.advanceTimersByTime(29_999); expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(stop).toHaveBeenCalledExactlyOnceWith('active-runtime')
  })
  it('shares a cumulative 30-second human wait allowance across approval and question requests', () => {
    const { stop, budget } = fixture()
    budget.setPhase('waiting_approval'); vi.advanceTimersByTime(10_000)
    budget.setPhase('running'); vi.advanceTimersByTime(5_000)
    budget.setPhase('waiting_input'); vi.advanceTimersByTime(19_999)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(stop).toHaveBeenCalledExactlyOnceWith('human-wait')
  })
  it('does not reset allowance on repeated phase events or interrupting state', () => {
    const { stop, budget } = fixture()
    for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(10_000); budget.setPhase('running') }
    budget.setPhase('interrupting'); vi.advanceTimersByTime(10_000)
    expect(stop).toHaveBeenCalledExactlyOnceWith('active-runtime')
  })
  it.each(['idle', 'completed', 'failed', 'disconnected', 'interrupted'] as const)('clears timers on terminal %s without calling stop', (phase) => {
    const { stop, budget } = fixture()
    vi.advanceTimersByTime(1000); budget.setPhase(phase)
    vi.advanceTimersByTime(200_000)
    expect(stop).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('allows only stricter positive limits and uses an injected monotonic clock', () => {
    vi.useFakeTimers()
    for (const activeMs of [0, -1, 90_001, Infinity, NaN]) expect(() => new LiveRuntimeBudget(vi.fn(), { activeMs })).toThrow('only tighten')
    expect(() => new LiveRuntimeBudget(vi.fn(), { humanWaitMs: 30_001 })).toThrow('only tighten')
    const stop = vi.fn(), budget = new LiveRuntimeBudget(stop, { activeMs: 1000, humanWaitMs: 100, now: () => Date.now() })
    budget.setPhase('waiting_input'); vi.advanceTimersByTime(100)
    expect(stop).toHaveBeenCalledExactlyOnceWith('human-wait')
  })
  it('survives reentrant stop handling and explicit disposal', () => {
    vi.useFakeTimers()
    const stop = vi.fn(() => { budget.setPhase('interrupted'); budget.dispose() })
    const budget = new LiveRuntimeBudget(stop, { activeMs: 100, now: () => Date.now() })
    vi.advanceTimersByTime(100)
    expect(stop).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
    const disposed = new LiveRuntimeBudget(stop, { now: () => Date.now() })
    disposed.dispose(); disposed.dispose(); vi.advanceTimersByTime(200_000)
    expect(stop).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  })
})
