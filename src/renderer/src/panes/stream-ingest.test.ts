import { describe, expect, it } from 'vitest'
import { createStreamIngest } from './stream-ingest'

/** A fake clock and scheduler: each applied event costs `perEventMs`; frames, tasks and delays run
 *  when the test says. React commits a render in a later task unless `commits` is false. */
function harness(perEventMs: number, options: { budgetMs?: number; sliceSize?: number; renderEveryMs?: number; commits?: boolean; lastInputAt?(): number } = {}) {
  let time = 0
  const frames: Array<() => void> = [], tasks: Array<() => void> = [], delays: Array<{ at: number; run: () => void }> = []
  const applied: number[] = [], runs: Array<{ events: number; ms: number }> = []
  let renders = 0, renderedCount = 0, inFlight = 0, maxInFlight = 0
  let runStart = 0, runEvents = 0
  const wrap = (queue: Array<() => void>) => (run: () => void) => {
    const entry = () => { runStart = time; runEvents = 0; run(); runs.push({ events: runEvents, ms: time - runStart }) }
    queue.push(entry)
    return () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1) }
  }
  const ingest = createStreamIngest<number>({
    ...options,
    apply(events) { applied.push(...events); runEvents += events.length; time += events.length * perEventMs },
    render() {
      renders++; renderedCount = applied.length; time += 20
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      if (options.commits !== false) tasks.push(() => { inFlight--; ingest.committed() })
    },
    now: () => time,
    frame: wrap(frames),
    task: wrap(tasks),
    delay: (run, ms) => { const entry = { at: time + ms, run }; delays.push(entry); return () => { const index = delays.indexOf(entry); if (index >= 0) delays.splice(index, 1) } }
  })
  const drainAll = (): void => {
    for (let guard = 0; guard < 100_000; guard++) {
      const next = tasks.shift() ?? frames.shift()
      if (next) { next(); continue }
      const due = delays.sort((a, b) => a.at - b.at).shift()
      if (!due) return
      time = Math.max(time, due.at)
      due.run()
    }
  }
  return { ingest, frames, tasks, delays, applied, runs, drainAll, get time() { return time }, advance(ms: number) { time += ms }, get renders() { return renders }, get renderedCount() { return renderedCount }, get maxInFlight() { return maxInFlight } }
}

describe('stream ingest: streamed events never hold the keyboard', () => {
  it('works through a 20,000-event burst in budgeted slices, in order, rendering the end state', () => {
    const h = harness(0.05)
    h.ingest.start()
    const burst = Array.from({ length: 20_000 }, (_, index) => index)
    h.ingest.push(burst)
    expect(h.frames).toHaveLength(1)
    h.drainAll()
    expect(h.applied).toEqual(burst)
    // No run holds the thread much past its budget: one slice of overshoot at most, plus a render.
    expect(Math.max(...h.runs.map(run => run.ms))).toBeLessThanOrEqual(6 + 250 * 0.05 + 20)
    expect(h.runs.length).toBeGreaterThan(20)
    expect(h.renderedCount).toBe(20_000)
    // Rendering is throttled while the backlog lasts, not once per slice.
    expect(h.renders).toBeLessThan(h.runs.length / 3)
  })
  it('folds a frame of small pushes into one apply and one render', () => {
    const h = harness(0.01)
    h.ingest.start()
    for (let index = 0; index < 5; index++) h.ingest.push([index])
    expect(h.frames).toHaveLength(1)
    h.drainAll()
    expect(h.applied).toEqual([0, 1, 2, 3, 4])
    expect(h.renders).toBe(1)
  })
  it('keeps one render in flight: a stream arriving meanwhile is applied, then rendered once it commits', () => {
    const h = harness(0.01)
    h.ingest.start()
    h.ingest.push([0])
    h.frames.shift()!()
    expect(h.renders).toBe(1)
    // The commit has not happened yet; three more frames of events arrive.
    for (let index = 1; index < 4; index++) { h.ingest.push([index]); h.frames.shift()!() }
    expect(h.applied).toEqual([0, 1, 2, 3])
    expect(h.renders).toBe(1)
    h.drainAll()
    expect(h.renders).toBe(2)
    expect(h.renderedCount).toBe(4)
    expect(h.maxInFlight).toBe(1)
  })
  it('stops waiting for a commit that never comes', () => {
    const h = harness(0.01, { commits: false })
    h.ingest.start()
    h.ingest.push([0])
    h.frames.shift()!()
    h.ingest.push([1])
    h.drainAll()
    expect(h.renders).toBe(2)
    expect(h.renderedCount).toBe(2)
  })
  it('holds renders while the owner types, until a pause or at most 1.5 s, and never holds back events', () => {
    let typedAt = Number.NEGATIVE_INFINITY
    const h = harness(0.01, { lastInputAt: () => typedAt })
    h.ingest.start()
    // The owner types a key every 100 ms for 3 s while a stream arrives every frame.
    const renderTimes: number[] = []
    let renders = 0
    for (let step = 0; step < 30; step++) {
      typedAt = h.time
      h.ingest.push([step])
      for (let frame = 0; frame < 6; frame++) {
        while (h.frames.length || h.tasks.length) (h.tasks.shift() ?? h.frames.shift())!()
        for (const due of h.delays.filter(entry => entry.at <= h.time)) { h.delays.splice(h.delays.indexOf(due), 1); due.run() }
        while (h.frames.length || h.tasks.length) (h.tasks.shift() ?? h.frames.shift())!()
        if (h.renders !== renders) { renders = h.renders; renderTimes.push(h.time) }
        h.advance(100 / 6)
      }
    }
    expect(h.applied).toHaveLength(30)
    // Every event was applied on arrival; renders came in steps no more than 1.5 s apart.
    expect(renderTimes.length).toBeGreaterThanOrEqual(1)
    expect(renderTimes.length).toBeLessThanOrEqual(3)
    for (let index = 1; index < renderTimes.length; index++) expect(renderTimes[index]! - renderTimes[index - 1]!).toBeGreaterThanOrEqual(1400)
    // Typing stops: the stream catches up within the quiet period.
    const stoppedAt = h.time
    h.drainAll()
    expect(h.renderedCount).toBe(30)
    expect(h.time - stoppedAt).toBeLessThanOrEqual(420)
  })
  it('renders at once when nobody is typing', () => {
    const h = harness(0.01, { lastInputAt: () => -10_000 })
    h.ingest.start()
    h.ingest.push([1])
    h.frames.shift()!()
    expect(h.renders).toBe(1)
  })
  it('holds events until started, hands them to a snapshot load, and stops on dispose', () => {
    const h = harness(0.01)
    h.ingest.push([1, 2])
    expect(h.frames).toHaveLength(0)
    expect(h.ingest.drain()).toEqual([1, 2])
    h.ingest.push([3])
    h.ingest.start()
    h.drainAll()
    expect(h.applied).toEqual([3])
    h.ingest.push([4])
    h.ingest.dispose()
    h.drainAll()
    expect(h.applied).toEqual([3])
  })
  it('still makes progress when one slice alone exceeds the budget', () => {
    const h = harness(1, { budgetMs: 2, sliceSize: 10 })
    h.ingest.start()
    h.ingest.push(Array.from({ length: 35 }, (_, index) => index))
    h.drainAll()
    expect(h.applied).toHaveLength(35)
    expect(h.runs.every(run => run.events <= 10)).toBe(true)
  })
})
