import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Typing benchmark for the composer. Each scenario is a fresh, parked launch (CONDUCTOR_TEST_USER_DATA:
// the window sits off every display and never takes focus) of a project whose workspace holds one
// active Codex conversation plus N-1 inactive ones. The active conversation carries a realistic
// timeline (the synthetic:perf-stream turn: 150 tool activities and a long markdown reply); each
// inactive one has a short synthetic exchange, the way old tabs accumulate. After a restart-style
// reload the script types --chars characters into the active composer one key at a time, under
// CPU throttling, and records:
//   - input to next paint per keystroke (keydown timestamp -> the task after the next frame), p50/p95/p99/max
//   - Event Timing entries at or over 16 ms (the browser's own input-to-paint measure, INP-style)
//   - longtasks, React commits (a DevTools-style hook installed before React loads), and
//     localStorage.setItem/getItem calls during typing plus a settle window for debounced writes
//   - CDP Performance deltas (script/layout/style time) and DOM node / listener counts
//   - DOM mutations inside the active timeline while typing: a keystroke must not touch it, so
//     anything above zero on a settled conversation means the timeline re-rendered per key
// No thresholds: this is a measurement harness. Usage:
//   node scripts/smoke-lock.mjs -- node scripts/perf-input.mjs [--label=baseline] [--tabs=1,11,26]
//     [--chars=300] [--delay=50] [--throttle=4] [--prefill=0] [--history=150] [--profile]
//     [--provider=claude --events=10000]
// --provider=claude makes every tab a Claude conversation, and the active one replays the offline
// fixture's "SYNTHETIC LONG <events>" turn: <events> provider messages of long Markdown, hidden
// thinking, Bash/Read/Grep/Edit calls with multi-line output and diffs, and per-message usage,
// the owner's long 1M-context conversation rather than the 150-activity Codex one.
// --profile also samples a CPU profile while typing, writes <label>-<tabs>.cpuprofile (open it in
// Chrome DevTools' Performance panel) and adds the top functions by self time to the results.
// --trace records a devtools.timeline trace while typing and adds the renderer main thread's time by
// trace event (Paint, Layout, UpdateLayoutTree, accessibility...), which is where "(program)" in a
// CPU profile goes: browser work outside JavaScript.
// --profile-main samples the Electron main process (Node's inspector) from just before the live turn
// until typing ends, writes <label>-<tabs>-main.cpuprofile and adds its top functions: every input
// event passes through main's UI thread, so a busy main process delays keys the renderer never saw.
// --css="<rules>" injects a stylesheet before typing, to try a rendering hypothesis without a rebuild.
// --stream=<rate>x<seconds> (Claude only) types while a live turn streams at a real provider's pace:
// the fixture's "SYNTHETIC STREAM" emits about <rate> events a second (text deltas, whole messages
// with a tool call, tool output) for <seconds> s on top of the long history; typing (default 200
// characters) is spread across the stream. Default 20x60.
// --burst=<events> (Claude only) types while the fixture replays "SYNTHETIC LONG <events>" at its full
// speed (about 12,000 events a second), the worst case of a reconnect or a fast tool flood.
// --floor first measures the same typing on an empty conversation at 1 tab, the floor p95 the
// long-conversation rows are held to.
// --assert exits non-zero when a row misses its target: while streaming p95 < 32 ms and no key over
// 250 ms, during a burst no key over 1,000 ms, and at rest p95 within 5 ms of the floor (--floor).
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value = 'true'] = arg.slice(2).split('=')
  return [key, value]
}))
const label = args.label ?? 'latest'
const tabCounts = (args.tabs ?? '1,11,26').split(',').map(Number).filter(count => Number.isSafeInteger(count) && count > 0)
const [streamRate, streamSeconds] = args.stream ? (args.stream === 'true' ? '20x60' : args.stream).split('x').map(Number) : []
const burst = args.burst ? Number(args.burst === 'true' ? 20000 : args.burst) : 0
const floor = args.floor === 'true'
const assert = args.assert === 'true'
const chars = Number(args.chars ?? (streamRate ? 200 : 300))
// Spread the keys over most of the stream, so they land throughout it rather than in its first seconds.
const delay = Number(args.delay ?? (streamRate ? Math.floor(streamSeconds * 800 / chars) : 50))
const throttle = Number(args.throttle ?? 4)
const prefill = Number(args.prefill ?? 0)
const history = Number(args.history ?? 150)
const profile = args.profile === 'true'
const trace = args.trace === 'true'
const profileMain = args['profile-main'] === 'true'
const css = args.css
const provider = args.provider === 'claude' || streamRate || burst ? 'claude' : 'codex'
const events = Number(args.events ?? 3000)
const livePrompt = streamRate ? `SYNTHETIC STREAM ${streamRate} ${streamSeconds}` : burst ? `SYNTHETIC LONG ${burst}` : ''
const providerTitle = provider === 'claude' ? 'Claude' : 'Codex'
const output = resolve('artifacts/perf-input')
await mkdir(output, { recursive: true })

const words = 'the quick brown fox jumps over a lazy dog while conductor keeps every tab alive and the composer answers each key without waiting on storage or hidden panes'.split(' ')
let typed = ''
for (let word = 0; typed.length < chars; word++) typed += words[word % words.length] + ' '
typed = typed.slice(0, chars)

function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
const round = value => Number(value.toFixed(2))

// Installed into every document before React loads: react-dom reports each commit to a DevTools
// global hook when one exists, production builds included.
const initScript = () => {
  window.__inputPerfCommits = 0
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject() { return 1 },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberRoot() { window.__inputPerfCommits++ },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {}
    }
  }
}

async function scenario(tabCount, { historyEvents = events, live = livePrompt } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-perf-input-'))
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_PERF_STREAM_HISTORY: String(history) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  const errors = []
  try {
    await app.context().addInitScript(initScript)
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.conductor?.structured))
    await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
    const project = await page.evaluate(() => window.conductor.projects.create('Perf input fixture'))
    const ids = Array.from({ length: tabCount }, (_, index) => 'perf-input-' + (index + 1))
    await page.evaluate(async ({ projectId, ids, provider, providerTitle }) => {
      const [session] = await window.conductor.sessions.list(projectId)
      const layout = JSON.parse(JSON.stringify(session.layout))
      const find = node => Array.isArray(node?.tabs) ? node : (node?.children ?? []).map(find).find(Boolean)
      const group = find(layout.root)
      group.tabs = ids.map((id, index) => ({ id: 'pane-' + id, kind: 'agent', title: providerTitle + ' ' + (index + 1), resourceId: 'agent-' + id, state: { provider, resume: false, model: 'default', effort: 'auto' } }))
      group.activeTabId = 'pane-' + ids[0]
      await window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, session.closedTabs)
    }, { projectId: project.id, ids, provider, providerTitle })
    const open = async () => {
      await page.reload()
      await page.waitForFunction(() => Boolean(window.conductor?.structured))
      await page.getByText('Perf input fixture', { exact: true }).first().click()
      await page.locator('.pane-tab-content:visible .structured-agent-pane').waitFor()
    }
    await open()
    const visible = page.locator('.pane-tab-content:visible')
    const activeId = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
    const composer = () => visible.getByRole('textbox', { name: /message|prompt/i }).last()
    const phase = id => page.evaluate(agent => window.conductor.structured.snapshot(agent).then(state => state?.phase), id)

    // The active conversation's history, sent through the real composer.
    await composer().fill(provider === 'claude' ? 'SYNTHETIC LONG ' + historyEvents : 'synthetic:perf-stream')
    await visible.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => phase(activeId), { timeout: 600_000, intervals: [250] }).toBe('completed')
    // Every inactive conversation gets one short exchange straight through main, the same path a
    // controller's tabs.send takes, so it works whether or not the tab's view is mounted.
    for (const id of ids.slice(1)) {
      const agent = 'agent-' + id
      await page.evaluate(async ({ agent, projectId, provider }) => {
        const [session] = await window.conductor.sessions.list(projectId)
        const project = (await window.conductor.projects.list()).find(item => item.id === projectId)
        await window.conductor.agents.ensure({ id: agent, projectId, sessionId: session.id, title: agent, cwd: project.path, provider, model: 'default', effort: 'auto' })
        const state = await window.conductor.structured.snapshot(agent)
        await window.conductor.structured.submit(agent, 'SYNTHETIC B perf input history', state.settings, [])
      }, { agent, projectId: project.id, provider })
      await expect.poll(() => phase(agent), { timeout: 60_000, intervals: [100] }).toBe('completed')
    }

    // A restart-style reload: the owner coming back to a workspace full of old tabs.
    await open()
    const composerBox = composer()
    await expect(composerBox).toBeEnabled({ timeout: 30_000 })
    if (prefill > 0) {
      await composerBox.fill('x'.repeat(prefill - 1) + ' ')
    }
    if (css) await page.addStyleTag({ content: css })
    await composerBox.click()
    await page.keyboard.press('Control+End')
    // Let startup work (snapshot loads, catalog probes, recovery checkpoints) settle first.
    await page.waitForTimeout(3000)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    await page.evaluate(() => {
      const perf = window.__inputPerf = { active: false, samples: [], longtasks: [], events: [], setItem: 0, getItem: 0, removeItem: 0, commitsAtStart: 0 }
      if (!window.__inputPerfPatched) {
        window.__inputPerfPatched = true
        for (const name of ['setItem', 'getItem', 'removeItem']) {
          const original = Storage.prototype[name]
          Storage.prototype[name] = function (...values) {
            if (window.__inputPerf?.active && this === window.localStorage) window.__inputPerf[name]++
            return original.apply(this, values)
          }
        }
        document.addEventListener('keydown', event => {
          const current = window.__inputPerf
          if (!current?.active) return
          const start = event.timeStamp
          requestAnimationFrame(() => {
            const frame = performance.now()
            const channel = new MessageChannel()
            channel.port1.onmessage = () => current.samples.push({ start, frame, painted: performance.now() })
            channel.port2.postMessage(0)
          })
        }, true)
      }
      perf.longtaskObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) perf.longtasks.push({ start: entry.startTime, duration: entry.duration }) })
      perf.longtaskObserver.observe({ type: 'longtask' })
      perf.eventObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) perf.events.push({ name: entry.name, duration: entry.duration, inputDelay: entry.processingStart - entry.startTime, processing: entry.processingEnd - entry.processingStart })
      })
      perf.eventObserver.observe({ type: 'event', durationThreshold: 16 })
      perf.timelineMutations = 0
      perf.mutationObserver = new MutationObserver(records => { perf.timelineMutations += records.length })
      const timeline = [...document.querySelectorAll('.sa-timeline')].find(element => element.offsetParent !== null)
      if (timeline) perf.mutationObserver.observe(timeline, { subtree: true, childList: true, attributes: true, characterData: true })
      perf.commitsAtStart = window.__inputPerfCommits ?? 0
      perf.active = true
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
    const traceEvents = []
    if (trace) {
      cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value))
      await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'accessibility', 'toplevel', 'v8', 'renderer.scheduler'] } })
    }
    if (profile) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
      await cdp.send('Profiler.start')
    }
    let liveTurn
    if (profileMain) await app.evaluate(() => {
      const inspector = process.getBuiltinModule('node:inspector')
      const session = globalThis.__perfMainProfiler = new inspector.Session()
      session.connect()
      session.post('Profiler.enable')
      session.post('Profiler.setSamplingInterval', { interval: 500 })
      session.post('Profiler.start')
    })
    if (live) {
      // The live turn goes straight through main, like a controller's tabs.send, so the composer's
      // draft is left alone; the pane receives its events the way it would from a real provider.
      await page.evaluate(({ agent, prompt }) => {
        const received = window.__inputPerfLive = { events: 0, batches: 0, first: 0, last: 0 }
        window.__inputPerfLiveOff = window.conductor.structured.onEvents(batch => {
          const mine = batch.filter(event => event.sessionId === agent).length
          if (!mine) return
          received.events += mine
          received.batches++
          received.first ||= performance.now()
          received.last = performance.now()
        })
        return window.conductor.structured.snapshot(agent).then(state => window.conductor.structured.submit(agent, prompt, state.settings, []))
      }, { agent: activeId, prompt: live })
      // A burst can keep main too busy to answer a snapshot until the turn is over, so only the
      // paced stream waits to see its turn running; a burst is typed into straight away.
      if (streamRate) await expect.poll(() => phase(activeId), { timeout: 30_000, intervals: [100] }).toBe('running')
    }
    const before = (await cdp.send('Performance.getMetrics')).metrics
    const wallStart = Date.now()
    let typedText = typed
    if (burst && live) {
      // Main can take minutes to hand a burst to the renderer, and then hands it over at once; keep
      // typing until it has landed and 15 s more, so keys are in flight while the pane takes it in.
      typedText = ''
      let arrivedAt = 0
      for (let word = 0; Date.now() - wallStart < 15 * 60_000; word++) {
        const chunk = words[word % words.length] + ' '
        await page.keyboard.type(chunk, { delay })
        typedText += chunk
        if (!arrivedAt && await page.evaluate(() => window.__inputPerfLive.events > 0)) arrivedAt = Date.now()
        if (arrivedAt && Date.now() - arrivedAt > 15_000 && typedText.length >= chars) break
      }
    } else await page.keyboard.type(typed, { delay })
    const typingMs = Date.now() - wallStart
    if (live) {
      liveTurn = await page.evaluate(() => { window.__inputPerfLiveOff(); const { events, batches, first, last } = window.__inputPerfLive; return { events, batches, perSecond: Number((events / Math.max(1, (last - first) / 1000)).toFixed(1)) } })
      liveTurn.prompt = live
      liveTurn.phaseAfterTyping = await phase(activeId)
    }
    let mainHotspots
    if (profileMain) {
      const samples = await app.evaluate(() => new Promise((resolve, reject) => globalThis.__perfMainProfiler.post('Profiler.stop', (error, result) => { globalThis.__perfMainProfiler.disconnect(); error ? reject(error) : resolve(result.profile) })))
      await writeFile(join(output, `${label}-${tabCount}-main.cpuprofile`), JSON.stringify(samples))
      mainHotspots = selfTimeHotspots(samples)
    }
    // A settle window long enough for a debounced or idle-time draft write to land.
    await page.waitForTimeout(1500)
    const after = (await cdp.send('Performance.getMetrics')).metrics
    let hotspots
    if (profile) {
      const { profile: samples } = await cdp.send('Profiler.stop')
      await writeFile(join(output, `${label}-${tabCount}.cpuprofile`), JSON.stringify(samples))
      hotspots = selfTimeHotspots(samples)
    }
    let traceSummary
    if (trace) {
      const complete = new Promise(done => cdp.once('Tracing.tracingComplete', done))
      await cdp.send('Tracing.end')
      await complete
      traceSummary = summarizeTrace(traceEvents)
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const collected = await page.evaluate(() => {
      const perf = window.__inputPerf
      perf.active = false
      perf.longtaskObserver.disconnect()
      perf.eventObserver.disconnect()
      perf.mutationObserver.disconnect()
      return { timelineMutations: perf.timelineMutations, samples: perf.samples, longtasks: perf.longtasks, events: perf.events, setItem: perf.setItem, getItem: perf.getItem, removeItem: perf.removeItem, commits: (window.__inputPerfCommits ?? 0) - perf.commitsAtStart }
    })
    const value = await composerBox.inputValue()
    const expected = (prefill > 0 ? 'x'.repeat(prefill - 1) + ' ' : '') + typedText
    const panes = await page.locator('.structured-agent-pane').count()
    // Animations running while the owner types cost a style/paint pass every frame; list them by
    // name and element so a regression names its source.
    const animations = await page.evaluate(() => {
      const counts = {}
      for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running') continue
        const target = animation.effect?.target
        const element = target instanceof Element ? target.tagName.toLowerCase() + (target.classList.length ? '.' + [...target.classList].slice(0, 2).join('.') : '') : 'unknown'
        const key = (animation.animationName || animation.transitionProperty || animation.constructor.name) + ' @ ' + element
        counts[key] = (counts[key] ?? 0) + 1
      }
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
    })
    // What a suspended view costs: selecting another conversation and coming back to the long one,
    // timed from the click until its composer is usable and its timeline shows the latest reply.
    const switching = {}
    if (tabCount > 1 && !live) {
      const select = async (id, ready) => {
        const started = Date.now()
        await page.locator(`.pane-tab[data-control-tab-id="pane-${id}"]`).click()
        await expect(composer()).toBeEnabled({ timeout: 30_000 })
        await ready()
        return Date.now() - started
      }
      switching.toShortConversationMs = await select(ids[1], () => expect(visible.locator('.structured-agent-pane')).toHaveAttribute('data-structured-session', 'agent-' + ids[1]))
      switching.backToLongConversationMs = await select(ids[0], () => expect(visible.getByText(provider === 'claude' ? /Synthetic long conversation:/ : /^Paragraph 50:/).first()).toBeVisible({ timeout: 30_000 }))
      switching.draftKept = (await composer().inputValue()) === expected
    }
    const latencies = collected.samples.map(sample => sample.painted - sample.start).sort((a, b) => a - b)
    const metric = (list, name) => list.find(entry => entry.name === name)?.value
    const delta = {}
    for (const name of ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration']) delta[name + 'Ms'] = round((metric(after, name) - metric(before, name)) * 1000)
    const slowEvents = collected.events.filter(entry => ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'].includes(entry.name))
    const timelineItems = await page.evaluate(id => window.conductor.structured.snapshot(id).then(state => state?.items.length ?? 0), activeId)
    const renderedActivities = await visible.locator('[data-item-id]').count()
    return {
      tabs: tabCount,
      provider,
      timelineItems,
      renderedActivities,
      inactiveTabs: tabCount - 1,
      mountedStructuredPanes: panes,
      typedChars: typedText.length,
      textIntact: value === expected,
      typingWallMs: typingMs,
      keystrokesMeasured: latencies.length,
      inputToNextPaintMs: {
        p50: round(percentile(latencies, 50)),
        p95: round(percentile(latencies, 95)),
        p99: round(percentile(latencies, 99)),
        max: round(latencies.at(-1) ?? 0),
        mean: round(latencies.reduce((sum, item) => sum + item, 0) / Math.max(1, latencies.length))
      },
      eventTimingOver16ms: {
        count: slowEvents.length,
        over50ms: slowEvents.filter(entry => entry.duration > 50).length,
        maxMs: round(slowEvents.reduce((max, entry) => Math.max(max, entry.duration), 0)),
        maxProcessingMs: round(slowEvents.reduce((max, entry) => Math.max(max, entry.processing), 0))
      },
      longtasks: {
        count: collected.longtasks.length,
        totalMs: round(collected.longtasks.reduce((sum, entry) => sum + entry.duration, 0)),
        maxMs: round(collected.longtasks.reduce((max, entry) => Math.max(max, entry.duration), 0))
      },
      reactCommits: collected.commits,
      timelineMutations: collected.timelineMutations,
      localStorage: { setItem: collected.setItem, getItem: collected.getItem, removeItem: collected.removeItem },
      cdpDelta: delta,
      domNodes: metric(after, 'Nodes'),
      jsEventListeners: metric(after, 'JSEventListeners'),
      jsHeapUsedMb: round((metric(after, 'JSHeapUsedSize') ?? 0) / 1024 / 1024),
      switching,
      liveTurn,
      mainHotspots,
      animations,
      hotspots,
      trace: traceSummary,
      errors
    }
  } finally {
    // A close that waits on work still running must not hold the smoke lock forever.
    const closed = await Promise.race([app.close().then(() => true), new Promise(done => setTimeout(() => done(false), 30_000))])
    if (!closed) app.process().kill()
  }
}

const results = { label, synthetic: true, recordedAt: new Date().toISOString(), config: { chars, delay, throttle, prefill, history, provider, events, css, live: livePrompt || undefined }, scenarios: [], failures: [] }
// What each row is held to under --assert (see the header).
const misses = (result) => {
  const { p95, max } = result.inputToNextPaintMs
  const missed = []
  if (!result.textIntact) missed.push('typed text was not intact')
  if (streamRate) { if (p95 >= 32) missed.push(`p95 ${p95} ms >= 32 ms while streaming`); if (max > 250) missed.push(`a key took ${max} ms > 250 ms while streaming`) }
  else if (burst) { if (max > 1000) missed.push(`input froze ${max} ms > 1000 ms during the burst`) }
  else if (results.floor && p95 > results.floor.inputToNextPaintMs.p95 + 5) missed.push(`p95 ${p95} ms > floor ${results.floor.inputToNextPaintMs.p95} + 5 ms`)
  return missed
}
try {
  if (floor) {
    results.floor = await scenario(1, { historyEvents: 4, live: '' })
    console.log(`floor: empty ${provider} conversation, 1 tab: input->paint p50 ${results.floor.inputToNextPaintMs.p50} / p95 ${results.floor.inputToNextPaintMs.p95} / p99 ${results.floor.inputToNextPaintMs.p99} ms; commits ${results.floor.reactCommits}`)
  }
  for (const count of tabCounts) {
    const result = await scenario(count)
    result.misses = misses(result)
    results.scenarios.push(result)
    console.log(`${provider}${provider === 'claude' ? ' ' + events + ' events' : ''}${livePrompt ? ' + ' + livePrompt + ' (' + JSON.stringify(result.liveTurn) + ')' : ''}, ${count} tab(s), ${result.timelineItems} items (${result.renderedActivities} rendered): input->paint p50 ${result.inputToNextPaintMs.p50} / p95 ${result.inputToNextPaintMs.p95} / p99 ${result.inputToNextPaintMs.p99} ms; longtasks ${result.longtasks.count} (${result.longtasks.totalMs} ms); commits ${result.reactCommits}; timeline mutations ${result.timelineMutations}; setItem ${result.localStorage.setItem}; getItem ${result.localStorage.getItem}; panes ${result.mountedStructuredPanes}; intact ${result.textIntact}; switch ${JSON.stringify(result.switching)}; max ${result.inputToNextPaintMs.max} ms${result.misses.length ? '; MISSED: ' + result.misses.join(', ') : ''}`)
  }
  if (assert && results.scenarios.some(result => result.misses.length)) process.exitCode = 1
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  throw error
} finally {
  await writeFile(join(output, label + '.json'), JSON.stringify(results, null, 2))
}

/** Main-thread time of the busiest renderer main thread (CrRendererMain) by trace event name: total (nested events
 *  included) and top-level only (children of a task), heaviest first. */
function summarizeTrace(events, count = 30) {
  const mains = new Set(events.filter(event => event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => event.pid + ':' + event.tid))
  const busy = new Map()
  for (const event of events) if (event.ph === 'X' && event.name === 'RunTask' && (!mains.size || mains.has(event.pid + ':' + event.tid))) { const key = event.pid + ':' + event.tid; busy.set(key, (busy.get(key) ?? 0) + (event.dur ?? 0)) }
  const main = [...busy].sort((a, b) => b[1] - a[1])[0]?.[0]
  const thread = events.filter(event => event.ph === 'X' && event.pid + ':' + event.tid === main && typeof event.dur === 'number').sort((a, b) => a.ts - b.ts || b.dur - a.dur)
  const total = new Map(), topLevel = new Map()
  const stack = []
  for (const event of thread) {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop()
    total.set(event.name, (total.get(event.name) ?? 0) + event.dur / 1000)
    if (stack.length === 1 && stack[0].name === 'RunTask') topLevel.set(event.name, (topLevel.get(event.name) ?? 0) + event.dur / 1000)
    stack.push(event)
  }
  const top = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => ({ name, ms: Number(ms.toFixed(1)) }))
  return { runTaskMs: Number(((busy.get(main) ?? 0) / 1000).toFixed(1)), topLevel: top(topLevel), total: top(total) }
}

/** Self time per function across the sampled profile, heaviest first. */
function selfTimeHotspots(samples, count = 25) {
  const nodes = new Map(samples.nodes.map(node => [node.id, node]))
  const self = new Map()
  samples.samples.forEach((id, index) => {
    const frame = nodes.get(id)?.callFrame
    if (!frame) return
    const where = frame.url ? frame.url.replace(/^.*\/(?=[^/]+$)/, '') + ':' + (frame.lineNumber + 1) : ''
    const key = (frame.functionName || '(anonymous)') + (where ? ' ' + where : '')
    self.set(key, (self.get(key) ?? 0) + (samples.timeDeltas[index] ?? 0) / 1000)
  })
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => ({ name, ms: Number(ms.toFixed(1)) }))
}
