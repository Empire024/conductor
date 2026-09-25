import { describe, expect, it } from 'vitest'
import { BusyWork, wrapBridge, type BusyEnvironment } from './busy-work'

function rig() {
  let clock = 0
  const timers: { at: number; callback: () => void; id: number }[] = []
  let nextId = 1
  const log: string[] = []
  const env: BusyEnvironment<string> = {
    now: () => clock,
    setTimeout: (callback, ms) => { const id = nextId++; timers.push({ at: clock + ms, callback, id }); return id },
    clearTimeout: handle => { const index = timers.findIndex(timer => timer.id === handle); if (index >= 0) timers.splice(index, 1) },
    setAppBusy: busy => log.push(busy ? 'app:busy' : 'app:idle'),
    setControlBusy: (control, busy) => log.push(`${control}:${busy ? 'busy' : 'idle'}`)
  }
  const work = new BusyWork(env)
  const advance = async (ms: number) => {
    const until = clock + ms
    for (;;) {
      await Promise.resolve(); await Promise.resolve()
      const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      clock = due.at
      due.callback()
    }
    clock = until
    await Promise.resolve(); await Promise.resolve()
  }
  const deferred = () => { let resolve!: (value?: unknown) => void, reject!: (error: unknown) => void; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
  return { work, log, advance, deferred }
}

describe('BusyWork', () => {
  it('shows the progress cursor and the clicked control only after 100 ms of pending work', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('open-project')
    const slow = deferred()
    work.track(slow.promise)
    await advance(99)
    expect(log).toEqual([])
    await advance(1)
    expect(log).toEqual(['app:busy', 'open-project:busy'])
    await advance(900)
    slow.resolve()
    await advance(0)
    expect(log).toEqual(['app:busy', 'open-project:busy', 'app:idle', 'open-project:idle'])
    expect(work.inFlight).toBe(0)
  })

  it('never shows anything for fast work', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('send')
    const fast = deferred()
    work.track(fast.promise)
    await advance(60)
    fast.resolve()
    await advance(500)
    expect(log).toEqual([])
  })

  it('keeps a shown state briefly so it does not flash, and clears it on failure too', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('ship')
    const call = deferred()
    work.track(call.promise).then(() => {}, () => {})
    await advance(110)
    expect(log).toEqual(['app:busy', 'ship:busy'])
    call.reject(new Error('refused'))
    await advance(100)
    expect(log).toEqual(['app:busy', 'ship:busy'])
    await advance(50)
    expect(log).toEqual(['app:busy', 'ship:busy', 'app:idle', 'ship:idle'])
  })

  it('ignores background calls that are not part of a gesture', async () => {
    const { work, log, advance, deferred } = rig()
    const poll = deferred()
    work.track(poll.promise)
    work.gesture('tab')
    await advance(600)
    const later = deferred()
    work.track(later.promise)
    await advance(1000)
    expect(log).toEqual([])
    expect(work.inFlight).toBe(0)
    // Non-promise results pass through untouched.
    work.gesture('tab')
    expect(work.track(42)).toBe(42)
  })

  it('follows a chain of calls the gesture started, and gives up on a call that never settles', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('project')
    const first = deferred()
    work.track(first.promise)
    await advance(800)
    first.resolve()
    await advance(10)
    // Started after the first settled, 810 ms after the click: still the same gesture's work.
    const second = deferred()
    work.track(second.promise)
    await advance(200)
    expect(log.filter(entry => entry === 'app:busy')).toHaveLength(2)
    await advance(60_000)
    expect(log.at(-2)).toBe('app:idle')
    expect(work.inFlight).toBe(0)
  })
})

describe('wrapBridge', () => {
  it('wraps nested functions, keeps subscriptions and values as they are', async () => {
    const tracked: unknown[] = []
    const unsubscribe = (): void => {}
    const bridge = { platform: 'win32', projects: { list: async () => ['a'], onChanged: () => unsubscribe }, ping: (value: number) => value + 1 }
    const wrapped = wrapBridge(bridge, { track: <T>(result: T) => { tracked.push(result); return result } })
    expect(wrapped.platform).toBe('win32')
    expect(await wrapped.projects.list()).toEqual(['a'])
    expect(wrapped.projects.onChanged()).toBe(unsubscribe)
    expect(wrapped.ping(1)).toBe(2)
    expect(tracked).toHaveLength(3)
  })
})
