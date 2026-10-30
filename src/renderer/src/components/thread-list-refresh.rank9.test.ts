import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadView } from '../../../shared/threads'
import { createThreadInvalidations, type ThreadInvalidationWindow } from '../../../main/thread-invalidations'
import { createThreadListRefresh, type ThreadListRefresh, type ThreadListRefreshEnvironment, type ThreadListRefreshOptions } from './thread-list-refresh'

const view = (label: string): ThreadView => ({ generalProjectId: null, groups: [], total: 0, hidden: 0, observedAt: label })

interface Deferred { query: string; resolve(label?: string): void; reject(error: unknown): void }

/** A window-less harness: a controllable environment, push bus and a reader whose answers the test settles. */
function harness(overrides: Partial<ThreadListRefreshOptions> = {}) {
  const log: string[] = []
  const pushes = new Set<() => void>()
  const focus = new Set<() => void>()
  const visibility = new Set<() => void>()
  let visible = true
  const environment: ThreadListRefreshEnvironment = {
    isVisible: () => visible,
    onFocus: listener => { focus.add(listener); return () => { focus.delete(listener) } },
    onVisibilityChange: listener => { visibility.add(listener); return () => { visibility.delete(listener) } }
  }
  const reads: Deferred[] = []
  let inFlight = 0, maxInFlight = 0
  const applied: string[] = []
  const options: ThreadListRefreshOptions = {
    environment,
    subscribe: listener => { log.push('subscribe'); pushes.add(listener); return () => { log.push('unsubscribe'); pushes.delete(listener) } },
    read: query => {
      log.push(`read:${query}`)
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<ThreadView>((resolve, reject) => {
        reads.push({
          query,
          resolve: label => { inFlight -= 1; resolve(view(label ?? query)) },
          reject: error => { inFlight -= 1; reject(error) }
        })
      })
    },
    onView: next => { applied.push(next.observedAt) },
    ...overrides
  }
  return {
    log, reads, applied, options, pushes,
    read: (index: number): Deferred => { const read = reads[index]; if (!read) throw new Error(`no read #${index}`); return read },
    get maxInFlight() { return maxInFlight },
    push: () => { for (const listener of [...pushes]) listener() },
    focus: () => { for (const listener of [...focus]) listener() },
    setVisible: (next: boolean) => { visible = next; for (const listener of [...visibility]) listener() },
    listenerCounts: () => ({ pushes: pushes.size, focus: focus.size, visibility: visibility.size })
  }
}

/** Let promise reactions run without moving the fake clock. */
const settled = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

describe('rank9 thread list refresh lifecycle (renderer)', () => {
  let controller: ThreadListRefresh | undefined
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  beforeEach(() => { vi.useFakeTimers(); unhandled.length = 0; process.on('unhandledRejection', onUnhandled) })
  afterEach(async () => {
    controller?.dispose(); controller = undefined
    await vi.advanceTimersByTimeAsync(60_000)
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
    vi.useRealTimers()
  })

  it('subscribes to pushes before the first read and applies that read', async () => {
    const h = harness()
    controller = createThreadListRefresh(h.options)
    expect(h.log).toEqual(['subscribe', 'read:'])
    h.read(0).resolve('first'); await settled()
    expect(h.applied).toEqual(['first'])
  })

  it('a change that lands between the subscription and the first answer produces a trailing read of newer state', async () => {
    const h = harness()
    controller = createThreadListRefresh(h.options)
    h.push()
    h.read(0).resolve('stale'); await settled()
    expect(h.applied).toEqual(['stale'])
    await vi.advanceTimersByTimeAsync(400)
    expect(h.reads).toHaveLength(2)
    h.read(1).resolve('fresh'); await settled()
    expect(h.applied).toEqual(['stale', 'fresh'])
  })

  it('coalesces a burst of pushes into one read, and spaces consecutive bursts by the minimum interval', async () => {
    const h = harness({ coalesceMs: 60, minIntervalMs: 400 })
    controller = createThreadListRefresh(h.options)
    h.read(0).resolve('initial'); await settled()
    await vi.advanceTimersByTimeAsync(1000)
    for (let index = 0; index < 200; index += 1) { h.push(); controller.invalidate() }
    expect(h.reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(59)
    expect(h.reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.reads).toHaveLength(2)
    h.read(1).resolve('second'); await settled()
    // Another burst right after the read started: held until minIntervalMs after that start.
    for (let index = 0; index < 50; index += 1) h.push()
    await vi.advanceTimersByTimeAsync(300)
    expect(h.reads).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.reads).toHaveLength(3)
    h.read(2).resolve('third'); await settled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.reads).toHaveLength(3)
    expect(h.maxInFlight).toBe(1)
    expect(h.applied).toEqual(['initial', 'second', 'third'])
  })

  it('an invalidation during a request waits for it, then exactly one trailing read follows; reads never overlap', async () => {
    const h = harness()
    controller = createThreadListRefresh(h.options)
    for (let index = 0; index < 30; index += 1) { h.push(); controller.refreshNow(); await vi.advanceTimersByTimeAsync(20) }
    expect(h.reads).toHaveLength(1)
    h.read(0).resolve('during'); await settled()
    expect(h.applied).toEqual(['during'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.reads).toHaveLength(2)
    h.read(1).resolve('trailing'); await settled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.reads).toHaveLength(2)
    expect(h.maxInFlight).toBe(1)
    expect(h.applied).toEqual(['during', 'trailing'])
  })

  it('an async reader that resolves the current state when it finishes shows the latest of a rapid sequence', async () => {
    let state = 'v0'
    const h = harness({
      read: async () => { await Promise.resolve(); const seen = state; await new Promise(resolve => setTimeout(resolve, 100)); return view(`${seen}->${state}`) }
    })
    controller = createThreadListRefresh(h.options)
    state = 'v1'; controller.invalidate()
    await vi.advanceTimersByTimeAsync(50)
    state = 'v2'; controller.invalidate()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.applied.at(-1)).toBe('v2->v2')
  })

  it('drops an out-of-order answer for an old query and never overlaps the next query read', async () => {
    const h = harness()
    controller = createThreadListRefresh(h.options)
    h.read(0).resolve(); await settled()
    await vi.advanceTimersByTimeAsync(1000)
    controller.setQuery('a')
    expect(h.log.at(-1)).toBe('read:a')
    controller.setQuery('ab'); controller.setQuery('abc')
    expect(h.reads.map(read => read.query)).toEqual(['', 'a'])
    h.read(1).resolve('result-a'); await settled()
    expect(h.applied).toEqual(['']) // 'a' is no longer the query, so its answer is not shown
    expect(h.reads.map(read => read.query)).toEqual(['', 'a', 'abc']) // 'ab' was superseded unread
    h.read(2).resolve('result-abc'); await settled()
    expect(h.applied).toEqual(['', 'result-abc'])
    expect(h.maxInFlight).toBe(1)
  })

  it('does not show an old query result that arrives after a newer one was already shown', async () => {
    const h = harness({ readTimeoutMs: 1000 })
    controller = createThreadListRefresh(h.options)
    h.read(0).resolve(); await settled()
    controller.setQuery('slow')
    controller.setQuery('fast')
    await vi.advanceTimersByTimeAsync(1000) // 'slow' never answers in time and is abandoned
    expect(h.reads.map(read => read.query)).toContain('fast')
    h.reads.find(read => read.query === 'fast')!.resolve('fast-result'); await settled()
    h.reads.find(read => read.query === 'slow')!.resolve('slow-late'); await settled()
    expect(h.applied).toEqual(['', 'fast-result'])
  })

  it('collapsing or hiding suppresses reads and drops the answer that was in flight; showing again catches up', async () => {
    const h = harness()
    controller = createThreadListRefresh(h.options)
    controller.setCollapsed(true)
    h.read(0).resolve('arrives-after-collapse'); await settled()
    expect(h.applied).toEqual([])
    for (let index = 0; index < 20; index += 1) h.push()
    controller.invalidate(); controller.refreshNow(); controller.setQuery('typed while collapsed'); h.focus()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toHaveLength(1)
    controller.setCollapsed(false)
    expect(h.log.at(-1)).toBe('read:typed while collapsed')
    h.read(1).resolve('after-expand'); await settled()
    expect(h.applied).toEqual(['after-expand'])

    h.setVisible(false)
    for (let index = 0; index < 20; index += 1) h.push()
    h.focus()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toHaveLength(2)
    h.setVisible(true)
    expect(h.reads).toHaveLength(3)
    h.read(2).resolve('after-show'); await settled()
    expect(h.applied).toEqual(['after-expand', 'after-show'])
  })

  it('a window focus reads once while shown and not at all while hidden or collapsed', async () => {
    const h = harness()
    controller = createThreadListRefresh(h.options)
    h.read(0).resolve(); await settled()
    await vi.advanceTimersByTimeAsync(1000)
    h.focus()
    expect(h.reads).toHaveLength(2)
    h.read(1).resolve(); await settled()
    controller.setCollapsed(true)
    h.focus()
    expect(h.reads).toHaveLength(2)
  })

  it('does not read at all when it starts collapsed or hidden, and reads once when first shown', async () => {
    const hidden = harness()
    hidden.setVisible(false)
    controller = createThreadListRefresh({ ...hidden.options, collapsed: false, environment: { ...hidden.options.environment } })
    expect(hidden.reads).toHaveLength(0)
    hidden.setVisible(true)
    expect(hidden.reads).toHaveLength(1)
    controller.dispose()
    const collapsed = harness()
    controller = createThreadListRefresh({ ...collapsed.options, collapsed: true })
    expect(collapsed.log).toEqual(['subscribe'])
    controller.setCollapsed(false)
    expect(collapsed.reads).toHaveLength(1)
  })

  it('retries a rejected read with backoff, reports it, and recovers without unhandled rejections', async () => {
    const onError = vi.fn()
    const h = harness({ onError, retryMs: 1000, maxRetryMs: 3000 })
    controller = createThreadListRefresh(h.options)
    h.read(0).reject(new Error('ipc closed')); await settled()
    expect(h.applied).toEqual([])
    await vi.advanceTimersByTimeAsync(999)
    expect(h.reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.reads).toHaveLength(2)
    h.read(1).reject(new Error('still closed')); await settled()
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.reads).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.reads).toHaveLength(3)
    h.read(2).reject(new Error('third')); await settled()
    await vi.advanceTimersByTimeAsync(3000) // capped, not 4000
    expect(h.reads).toHaveLength(4)
    h.read(3).resolve('recovered'); await settled()
    expect(h.applied).toEqual(['recovered'])
    expect(onError).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toHaveLength(4)
  })

  it('stops retrying once the list is hidden and reads again when it is shown', async () => {
    const h = harness({ retryMs: 1000 })
    controller = createThreadListRefresh(h.options)
    h.read(0).reject(new Error('down')); await settled()
    controller.setCollapsed(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toHaveLength(1)
    controller.setCollapsed(false)
    expect(h.reads).toHaveLength(2)
  })

  it('treats a reader that throws synchronously, or returns a plain value, as a read', async () => {
    let mode: 'throw' | 'value' = 'throw'
    const onError = vi.fn()
    const h = harness({ onError, retryMs: 500, read: () => { if (mode === 'throw') throw new Error('bridge missing'); return view('plain') } })
    controller = createThreadListRefresh(h.options)
    expect(onError).toHaveBeenCalledTimes(0) // reported on the promise turn, not thrown at the caller
    await settled()
    expect(onError).toHaveBeenCalledTimes(1)
    mode = 'value'
    await vi.advanceTimersByTimeAsync(500)
    expect(h.applied).toEqual(['plain'])
  })

  it('a reader that never answers is abandoned after the timeout, retried, and its late answer is ignored', async () => {
    const h = harness({ readTimeoutMs: 5000, retryMs: 1000 })
    controller = createThreadListRefresh(h.options)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.reads).toHaveLength(2)
    h.read(1).resolve('current'); await settled()
    h.read(0).resolve('late'); await settled()
    expect(h.applied).toEqual(['current'])
  })

  it('a throwing onView or onError cannot break the lifecycle', async () => {
    const h = harness({ onView: () => { throw new Error('render') }, onError: () => { throw new Error('reporter') } })
    controller = createThreadListRefresh(h.options)
    h.read(0).resolve(); await settled()
    controller.refreshNow()
    expect(h.reads).toHaveLength(2)
    h.read(1).reject(new Error('x')); await settled()
  })

  it('a subscription that throws leaves the list working on focus and refreshKey, without pushes', async () => {
    const onError = vi.fn()
    const h = harness({ onError, subscribe: () => { throw new Error('old preload') } })
    controller = createThreadListRefresh(h.options)
    expect(onError).toHaveBeenCalledTimes(1)
    h.read(0).resolve('first'); await settled()
    await vi.advanceTimersByTimeAsync(1000)
    controller.invalidate()
    await vi.advanceTimersByTimeAsync(60)
    expect(h.reads).toHaveLength(2)
  })

  it('dispose drops the in-flight answer, clears every timer and listener, and ignores later input', async () => {
    const h = harness()
    controller = createThreadListRefresh({ ...h.options, onClock: vi.fn() })
    expect(h.listenerCounts()).toEqual({ pushes: 1, focus: 1, visibility: 1 })
    h.push() // pending trailing work
    controller.dispose()
    expect(h.listenerCounts()).toEqual({ pushes: 0, focus: 0, visibility: 0 })
    expect(h.log.filter(entry => entry === 'unsubscribe')).toHaveLength(1)
    h.read(0).resolve('after-unmount'); await settled()
    expect(h.applied).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    h.push(); h.focus(); h.setVisible(false); h.setVisible(true)
    controller.invalidate(); controller.refreshNow(); controller.setQuery('x'); controller.setCollapsed(true); controller.setCollapsed(false); controller.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a pending retry and a pending coalesced read are both cancelled by dispose', async () => {
    const h = harness({ retryMs: 1000 })
    controller = createThreadListRefresh(h.options)
    h.read(0).reject(new Error('down')); await settled()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toHaveLength(1)
  })

  it('keeps ages moving with a local clock that reads nothing, only while shown', async () => {
    const onClock = vi.fn()
    const h = harness({ onClock, clockMs: 30_000 })
    controller = createThreadListRefresh(h.options)
    h.read(0).resolve(); await settled()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(onClock).toHaveBeenCalledTimes(3)
    expect(h.reads).toHaveLength(1) // the clock is not a poll
    controller.setCollapsed(true)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(onClock).toHaveBeenCalledTimes(3)
    controller.setCollapsed(false)
    h.read(1).resolve(); await settled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onClock).toHaveBeenCalledTimes(4)
    h.setVisible(false)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(onClock).toHaveBeenCalledTimes(4)
  })

  it('has no timer-driven list polling: an idle, shown list makes no reads', async () => {
    const h = harness()
    controller = createThreadListRefresh({ ...h.options, onClock: vi.fn() })
    h.read(0).resolve(); await settled()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.reads).toHaveLength(1)
  })

  describe('with the real main-process invalidation module across windows', () => {
    it('one burst in main reaches every window as one read each; a closed window is skipped; a collapsed one reads later', async () => {
      interface Win extends ThreadInvalidationWindow { h: ReturnType<typeof harness>; destroyed: boolean; controller: ThreadListRefresh }
      const makeWindow = (collapsed = false): Win => {
        const h = harness({ collapsed })
        const window: Win = {
          h, destroyed: false, controller: undefined as unknown as ThreadListRefresh,
          isDestroyed: () => window.destroyed,
          webContents: { isDestroyed: () => false, send: () => h.push() }
        }
        window.controller = createThreadListRefresh(h.options)
        return window
      }
      const open = makeWindow(), second = makeWindow(), collapsedWindow = makeWindow(true), closed = makeWindow()
      const windows = [open, second, collapsedWindow, closed]
      for (const window of windows.filter(window => window !== collapsedWindow)) { window.h.read(0).resolve('initial'); await settled() }
      closed.destroyed = true
      closed.controller.dispose()
      await vi.advanceTimersByTimeAsync(1000)

      const invalidations = createThreadInvalidations({ windows: () => windows, intervalMs: 200 })
      for (let index = 0; index < 300; index += 1) invalidations.observe('structured:events', [{ sessionId: 's', sequence: index }])
      await vi.advanceTimersByTimeAsync(200 + 60)
      for (const window of [open, second]) {
        expect(window.h.reads).toHaveLength(2)
        window.h.read(1).resolve('pushed'); await settled()
        expect(window.h.applied).toEqual(['initial', 'pushed'])
      }
      expect(collapsedWindow.h.reads).toHaveLength(0)
      expect(closed.h.reads).toHaveLength(1)
      collapsedWindow.controller.setCollapsed(false)
      expect(collapsedWindow.h.reads).toHaveLength(1)
      invalidations.dispose()
      for (const window of windows) window.controller.dispose()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
