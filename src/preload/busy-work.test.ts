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
    // A posted task: after the running one and its microtasks, in posting order (a stable sort keeps it).
    nextTask: callback => { timers.push({ at: clock, callback, id: nextId++ }) },
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
  /** Something else posts a task now (React's scheduler after a setState). */
  const post = (callback: () => void) => env.nextTask(callback)
  return { work, log, advance, deferred, post }
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
    const second = deferred()
    // The click handler awaits its first call and then starts the next: open a project, load its tabs.
    work.track(first.promise).then(() => work.track(second.promise))
    await advance(800)
    first.resolve()
    await advance(200)
    expect(log.filter(entry => entry === 'app:busy')).toHaveLength(2)
    await advance(60_000)
    expect(log.at(-2)).toBe('app:idle')
    expect(work.inFlight).toBe(0)
  })

  it('counts a render the handler scheduled (one posted task later), but not a timer that fires after it', async () => {
    const { work, log, advance, deferred, post } = rig()
    work.gesture('refresh')
    const rendered = deferred()
    post(() => { work.track(rendered.promise) })
    await advance(150)
    expect(log).toEqual(['app:busy', 'refresh:busy'])
    rendered.resolve()
    await advance(1)
    const timer = deferred()
    work.track(timer.promise)
    await advance(400)
    expect(log).toEqual(['app:busy', 'refresh:busy', 'app:idle', 'refresh:idle'])
    expect(work.inFlight).toBe(0)
    timer.resolve()
  })

  it('never lets a background poller near a click move the cursor, not even its first call (VR7 C2b, VR8d K3)', async () => {
    const { work, log, advance, deferred } = rig()
    const stamped: { at: number; entry: string }[] = []
    let clock = 0
    const tick = async (ms: number) => { await advance(ms); clock += ms; while (stamped.length < log.length) stamped.push({ at: clock, entry: log[stamped.length]! }) }
    // A slow click: its own call takes 190 ms.
    work.gesture('refresh')
    const own = deferred()
    work.track(own.promise)
    await tick(190)
    own.resolve()
    await tick(0)
    // Every 400 ms a 320 ms call, the first 10 ms after the click's work and 200 ms after the click.
    await tick(10)
    for (let started = 200; started < 8000; started += 400) {
      const poll = deferred()
      work.track(poll.promise)
      await tick(320)
      poll.resolve()
      await tick(80)
    }
    // Busy for the click's own work (100-250 ms), and nothing else.
    expect(log).toEqual(['app:busy', 'refresh:busy', 'app:idle', 'refresh:idle'])
    expect(stamped.filter(entry => entry.at > 600)).toEqual([])
    expect(work.inFlight).toBe(0)
  })

  it('never chains a poll that starts right after one of the gesture\'s calls settles, in another task', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('project')
    for (let link = 0; link < 4; link++) {
      const call = deferred()
      work.track(call.promise)
      await advance(300)
      call.resolve()
      await advance(1)
    }
    expect(log.filter(entry => entry === 'project:busy')).toHaveLength(1)
  })

  it('follows a longer chain of awaited calls, each started as the previous one settles', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('project')
    const calls = [deferred(), deferred(), deferred(), deferred(), deferred(), deferred()]
    void calls.reduce<Promise<unknown>>((previous, call) => previous.then(() => work.track(call.promise)), Promise.resolve())
    for (const call of calls) { await advance(300); call.resolve() }
    await advance(1000)
    expect(log.filter(entry => entry === 'project:busy')).toHaveLength(6)
    expect(work.inFlight).toBe(0)
  })

  it('keeps an old gesture\'s continuation on its own control, never on a newer gesture\'s', async () => {
    const { work, log, advance, deferred } = rig()
    work.gesture('a')
    const old = deferred()
    const next = deferred()
    work.track(old.promise).then(() => work.track(next.promise))
    await advance(1000)
    work.gesture('b')
    await advance(700)
    old.resolve()
    await advance(20)
    const background = deferred()
    work.track(background.promise)
    await advance(300)
    expect(log.filter(entry => entry === 'b:busy')).toEqual([])
    expect(log.filter(entry => entry === 'a:busy')).toHaveLength(2)
    background.resolve(); next.resolve()
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
