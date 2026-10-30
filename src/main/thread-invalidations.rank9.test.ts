import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THREADS_CHANGED_CHANNEL } from '../shared/threads'
import { createThreadInvalidations, THREAD_INVALIDATING_CHANNELS, type ThreadInvalidationWindow } from './thread-invalidations'

const fakeWindow = (state: { destroyed?: boolean; contentsDestroyed?: boolean; throws?: boolean } = {}): ThreadInvalidationWindow & { send: ReturnType<typeof vi.fn> } => {
  const send = vi.fn((_channel: string) => { if (state.throws) throw new Error('window gone') })
  return {
    send,
    isDestroyed: () => Boolean(state.destroyed),
    webContents: { isDestroyed: () => Boolean(state.contentsDestroyed), send }
  }
}

describe('rank9 thread invalidations (main)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('turns a burst of structured events into one payload-free notice per live window', () => {
    const first = fakeWindow(), second = fakeWindow()
    const invalidations = createThreadInvalidations({ windows: () => [first, second], intervalMs: 200 })
    for (let index = 0; index < 500; index += 1) invalidations.observe('structured:events', [{ sessionId: 's', sequence: index, data: { type: 'text', text: 'a secret token' } }])
    expect(first.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(199)
    expect(first.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    for (const window of [first, second]) {
      expect(window.send).toHaveBeenCalledTimes(1)
      // Only the channel: no event data, and so nothing to validate or leak.
      expect(window.send.mock.calls[0]).toEqual([THREADS_CHANGED_CHANNEL])
    }
    vi.advanceTimersByTime(10_000)
    expect(first.send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends at most one notice per interval while events keep coming, and a trailing one after the last', () => {
    const window = fakeWindow()
    const invalidations = createThreadInvalidations({ windows: () => [window], intervalMs: 200 })
    for (let tick = 0; tick < 10; tick += 1) { invalidations.observe('agent:status', { id: 'a', status: 'running' }); vi.advanceTimersByTime(50) }
    // 500 ms of events: notices at 200 and 400, then the one held at 400..500 leaves at 600.
    expect(window.send).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(200)
    expect(window.send).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(5_000)
    expect(window.send).toHaveBeenCalledTimes(3)
  })

  it('covers the structural channels main broadcasts and ignores the rest', () => {
    const window = fakeWindow()
    const invalidations = createThreadInvalidations({ windows: () => [window], intervalMs: 10 })
    for (const channel of ['structured:events', 'agent:status', 'projects:changed', 'remote:changed', 'session-archive:changed', 'sessions:restored']) {
      expect(THREAD_INVALIDATING_CHANNELS.has(channel)).toBe(true)
      expect(invalidations.observe(channel, [{}])).toBe(true)
      vi.advanceTimersByTime(10)
    }
    expect(window.send).toHaveBeenCalledTimes(6)
    window.send.mockClear()
    // phone:changed is the desktop's phone-access settings and status, not a conversation event.
    for (const channel of ['phone:changed', 'agent:data', 'agent:event', 'files:changed', 'usage:limits-changed', 'browser:state']) {
      expect(invalidations.observe(channel, {})).toBe(false)
    }
    expect(invalidations.observe('structured:events', [])).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(window.send).not.toHaveBeenCalled()
  })

  it('skips destroyed windows and survives one that throws', () => {
    const gone = fakeWindow({ destroyed: true }), orphan = fakeWindow({ contentsDestroyed: true }), broken = fakeWindow({ throws: true }), live = fakeWindow()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const invalidations = createThreadInvalidations({ windows: () => [gone, orphan, broken, live], intervalMs: 5 })
    expect(() => { invalidations.observe('projects:changed'); vi.advanceTimersByTime(5) }).not.toThrow()
    expect(gone.send).not.toHaveBeenCalled()
    expect(orphan.send).not.toHaveBeenCalled()
    expect(live.send).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('does not throw when the window list itself fails, and recovers on the next burst', () => {
    const live = fakeWindow()
    let broken = true
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const invalidations = createThreadInvalidations({ windows: () => { if (broken) throw new Error('app closing'); return [live] }, intervalMs: 5 })
    expect(() => { invalidations.notify(); vi.advanceTimersByTime(5) }).not.toThrow()
    broken = false
    invalidations.notify(); vi.advanceTimersByTime(5)
    expect(live.send).toHaveBeenCalledTimes(1)
  })

  it('notify() invalidates for structural handlers that broadcast nothing, and flush() sends a held notice now', () => {
    const window = fakeWindow()
    const invalidations = createThreadInvalidations({ windows: () => [window], intervalMs: 1000 })
    invalidations.flush()
    expect(window.send).not.toHaveBeenCalled()
    invalidations.notify(); invalidations.notify()
    invalidations.flush()
    expect(window.send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose() cancels a held notice and ignores everything after it', () => {
    const window = fakeWindow()
    const invalidations = createThreadInvalidations({ windows: () => [window], intervalMs: 200 })
    invalidations.observe('agent:status', { id: 'a' })
    invalidations.dispose()
    expect(vi.getTimerCount()).toBe(0)
    invalidations.observe('agent:status', { id: 'a' }); invalidations.notify(); invalidations.flush()
    vi.advanceTimersByTime(5000)
    expect(window.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
