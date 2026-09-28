import { _electron as electron, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { priorityName, restoreNormalPriority } from './lib/background-priority.mjs'
import { killTree } from './smoke-lock.mjs'

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
// CPU profile goes: browser work outside JavaScript. It also counts the elements each style recalc
// touched and the objects each layout had to lay out, and names what invalidated them: a key that
// restyles or relays the whole timeline shows up there as thousands per recalc.
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
// --background=<tabs>x<rate>x<seconds> (Claude only) is the owner's usual case: the long active
// conversation sits idle while <tabs> inactive tabs (coworkers) each stream a live turn at <rate>
// events a second for <seconds> s, and typing is spread across their streams. Default 3x20x60.
// --floor first measures the same typing on an empty conversation at 1 tab, the floor p95 the
// long-conversation rows are held to.
// --assert exits non-zero when a row misses its target: while streaming p95 < 32 ms and no key over
// 250 ms, during a burst no key over 1,000 ms, and at rest or with background streams p95 within
// 5 ms of the floor (--floor) and, with background streams, no key over 100 ms.
//
// --load=launch,vitest types into one parked "owner" instance while test work runs next to it
// (docs/perf/typing-under-load.md). Each round is a quiet typing window (the same-run floor) and
// then one window per load, typed from the moment the load starts until it has finished:
//   launch: what a smoke or verifier does, `electron-vite build` into out/ and a parked Conductor
//           launched from it, left up for --load-idle seconds (default 8) and killed;
//   vitest: `vitest run` over the whole suite for --load-seconds (default 60), then killed;
//   swarm:  launch, vitest and `tsc --noEmit` at once, four coworkers' worth: the machine saturates.
// --repeat=N rounds (default 3). The owner stand-in runs at normal priority from a copy of out/
// (the launch load rebuilds out/ under it); --load-priority=normal starts the load the way it was
// started before typing-lag-under-test-load (normal priority, the parked instance does not lower
// itself: the "before" numbers), the default starts it the way smoke-lock does now.
// With --assert, a load fails when the median over the rounds of its p95 or p99 exceeds the quiet
// median by more than --bound-ms (default 25): the regression guard. Before the fix a swarm load
// missed it by 4x (p99 +108 ms), after it passes with room (+12 ms); docs/perf/typing-under-load.md.
//   node scripts/smoke-lock.mjs --priority normal --timeout-min 60 -- node scripts/perf-input.mjs
//     --label=under-load --load=launch,vitest --repeat=3 --throttle=1 --assert
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value = 'true'] = arg.slice(2).split('=')
  return [key, value]
}))
const label = args.label ?? 'latest'
const tabCounts = (args.tabs ?? '1,11,26').split(',').map(Number).filter(count => Number.isSafeInteger(count) && count > 0)
const [streamRate, streamSeconds] = args.stream ? (args.stream === 'true' ? '20x60' : args.stream).split('x').map(Number) : []
const [backgroundTabs, backgroundRate, backgroundSeconds] = args.background ? (args.background === 'true' ? '3x20x60' : args.background).split('x').map(Number) : []
const burst = args.burst ? Number(args.burst === 'true' ? 20000 : args.burst) : 0
const floor = args.floor === 'true'
const assert = args.assert === 'true'
const spreadSeconds = streamSeconds ?? backgroundSeconds
const chars = Number(args.chars ?? (spreadSeconds ? 200 : 300))
// Spread the keys over most of the stream, so they land throughout it rather than in its first seconds.
const delay = Number(args.delay ?? (spreadSeconds ? Math.floor(spreadSeconds * 800 / chars) : 50))
const throttle = Number(args.throttle ?? 4)
const prefill = Number(args.prefill ?? 0)
const history = Number(args.history ?? 150)
const profile = args.profile === 'true'
const trace = args.trace === 'true'
const profileMain = args['profile-main'] === 'true'
const css = args.css
const provider = args.provider === 'claude' || streamRate || burst || backgroundTabs ? 'claude' : 'codex'
const events = Number(args.events ?? 3000)
const livePrompt = streamRate ? `SYNTHETIC STREAM ${streamRate} ${streamSeconds}` : burst ? `SYNTHETIC LONG ${burst}` : ''
const providerTitle = provider === 'claude' ? 'Claude' : 'Codex'
const LOADS = { launch: startLaunchLoad, vitest: startVitestLoad, swarm: startSwarmLoad }
const loads = args.load ? args.load.split(',').filter(Boolean) : []
for (const kind of loads) if (!(kind in LOADS)) throw new Error(`--load=${kind}: expected one of ${Object.keys(LOADS).join(', ')}`)
const repeat = Math.max(1, Number(args.repeat ?? 3))
const loadPriority = args['load-priority'] === 'normal' ? 'normal' : 'background'
const loadSeconds = Number(args['load-seconds'] ?? 60)
const loadIdleSeconds = Number(args['load-idle'] ?? 8)
const boundMs = Number(args['bound-ms'] ?? 25)
const output = resolve('artifacts/perf-input')
await mkdir(output, { recursive: true })
// The measuring process and the stand-in it launches play the owner's app: normal priority, even
// when smoke-lock started this run lowered (Windows lets a process raise itself back to normal).
const standInPriority = restoreNormalPriority()
if (standInPriority.startsWith('failed')) console.warn(`[perf-input] could not restore normal priority (${standInPriority}): run under smoke-lock --priority normal`)
// The launch load rebuilds out/, so the stand-in runs from a copy inside the checkout (node_modules
// still resolves by walking up). --app points it at any other build.
let appMain = resolve(args.app ?? 'out/main/index.js')
let standInCopy
if (!args.app && loads.includes('launch')) {
  standInCopy = resolve('.conductor-scratch/perf-input/stand-in-' + process.pid)
  await rm(standInCopy, { recursive: true, force: true })
  await cp(resolve('out'), join(standInCopy, 'out'), { recursive: true })
  appMain = join(standInCopy, 'out', 'main', 'index.js')
}

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

async function scenario(tabCount, { historyEvents = events, live = livePrompt, background = backgroundTabs } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conductor-perf-input-'))
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_PERF_STREAM_HISTORY: String(history), CONDUCTOR_BACKGROUND_PRIORITY: '0', CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [appMain], env, timeout: 30_000 })
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
    if (loads.length) return await loadRounds(app, page, composerBox, { tabCount, errors })

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
      await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking', 'blink.animations', 'devtools.timeline.animations', 'blink', 'cc', 'accessibility', 'toplevel', 'v8', 'renderer.scheduler'] } })
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
    let backgroundTurns
    if (background) {
      // Coworkers' turns go straight through main, the way a dispatched tab's would, into tabs whose
      // views are suspended; the owner types into the long conversation, which stays idle.
      const streaming = ids.slice(1, 1 + backgroundTabs).map(id => 'agent-' + id)
      if (streaming.length < backgroundTabs) throw new Error(`--background=${backgroundTabs}x...: needs --tabs of at least ${backgroundTabs + 1}`)
      await page.evaluate(({ agents, prompt }) => {
        const received = window.__inputPerfBackground = { events: 0, batches: 0 }
        window.__inputPerfBackgroundOff = window.conductor.structured.onEvents(batch => {
          const theirs = batch.filter(event => agents.includes(event.sessionId)).length
          if (theirs) { received.events += theirs; received.batches++ }
        })
        return Promise.all(agents.map(agent => window.conductor.structured.snapshot(agent).then(state => window.conductor.structured.submit(agent, prompt, state.settings, []))))
      }, { agents: streaming, prompt: `SYNTHETIC STREAM ${backgroundRate} ${backgroundSeconds}` })
      for (const agent of streaming) await expect.poll(() => phase(agent), { timeout: 30_000, intervals: [100] }).toBe('running')
      backgroundTurns = { agents: streaming }
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
    if (backgroundTurns) {
      Object.assign(backgroundTurns, await page.evaluate(() => { window.__inputPerfBackgroundOff(); return window.__inputPerfBackground }))
      backgroundTurns.phasesAfterTyping = await Promise.all(backgroundTurns.agents.map(phase))
    }
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
    if (tabCount > 1 && !live && !background) try {
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
    } catch (error) {
      // A tab strip that changed shape must not throw away the typing numbers measured above.
      switching.error = String(error.message ?? error).split(/\r?\n/)[0]
    }
    const latencies = collected.samples.map(sample => sample.painted - sample.start).sort((a, b) => a - b)
    const metric = (list, name) => list.find(entry => entry.name === name)?.value
    const delta = {}
    for (const name of ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration']) delta[name + 'Ms'] = round((metric(after, name) - metric(before, name)) * 1000)
    const slowEvents = collected.events.filter(entry => ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'].includes(entry.name))
    const timelineItems = await page.evaluate(id => window.conductor.structured.snapshot(id).then(state => state?.items.length ?? 0), activeId)
    const renderedActivities = await visible.locator('[data-item-id]').count()
    // What the rendered timeline carries into every frame: elements, and the ones Blink walks on
    // each lifecycle whatever changed (paint layers from position/overflow/transform/opacity,
    // images and inline SVGs).
    const timelineCost = await page.evaluate(() => {
      const timeline = [...document.querySelectorAll('.sa-timeline')].find(element => element.offsetParent !== null)
      if (!timeline) return undefined
      const counts = { elements: 0, positioned: 0, overflowClip: 0, transformOrOpacity: 0, images: 0, svgs: 0, contentVisibilityAuto: 0 }
      const layerSources = {}
      for (const element of timeline.querySelectorAll('*')) {
        counts.elements++
        if (element instanceof HTMLImageElement) counts.images++
        if (element instanceof SVGSVGElement) counts.svgs++
        const style = getComputedStyle(element)
        const source = style.position !== 'static' ? 'position:' + style.position : style.overflowX !== 'visible' || style.overflowY !== 'visible' ? 'overflow' : style.transform !== 'none' || style.opacity !== '1' || style.willChange !== 'auto' || style.filter !== 'none' ? 'transform/opacity' : ''
        if (style.position !== 'static') counts.positioned++
        else if (source === 'overflow') counts.overflowClip++
        else if (source) counts.transformOrOpacity++
        if (style.contentVisibility === 'auto') counts.contentVisibilityAuto++
        if (source) { const key = source + ' ' + element.tagName.toLowerCase() + (element.classList.length ? '.' + [...element.classList].slice(0, 2).join('.') : ''); layerSources[key] = (layerSources[key] ?? 0) + 1 }
      }
      return { ...counts, layerSources: Object.entries(layerSources).sort((a, b) => b[1] - a[1]).slice(0, 25) }
    })
    return {
      tabs: tabCount,
      provider,
      timelineItems,
      renderedActivities,
      timelineCost,
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
      backgroundTurns,
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

const results = { label, synthetic: true, recordedAt: new Date().toISOString(), config: { chars, delay, throttle, prefill, history, provider, events, css, live: livePrompt || undefined, background: backgroundTabs ? { tabs: backgroundTabs, rate: backgroundRate, seconds: backgroundSeconds } : undefined }, scenarios: [], failures: [] }
// What each row is held to under --assert (see the header).
const misses = (result) => {
  const { p95, max } = result.inputToNextPaintMs
  const missed = []
  if (!result.textIntact) missed.push('typed text was not intact')
  if (streamRate) { if (p95 >= 32) missed.push(`p95 ${p95} ms >= 32 ms while streaming`); if (max > 250) missed.push(`a key took ${max} ms > 250 ms while streaming`) }
  else if (burst) { if (max > 1000) missed.push(`input froze ${max} ms > 1000 ms during the burst`) }
  else {
    if (results.floor && p95 > results.floor.inputToNextPaintMs.p95 + 5) missed.push(`p95 ${p95} ms > floor ${results.floor.inputToNextPaintMs.p95} + 5 ms`)
    if (backgroundTabs && max > 100) missed.push(`a key took ${max} ms > 100 ms while coworkers streamed`)
  }
  return missed
}
try {
  if (loads.length) {
    results.config.load = { kinds: loads, repeat, priority: loadPriority, loadSeconds, loadIdleSeconds, boundMs, standIn: standInPriority }
    results.load = await scenario(tabCounts[0])
    for (const row of results.load.summary) console.log(`${row.kind}: p95 ${row.p95.join(' / ')} (median ${row.medianP95}) · p99 ${row.p99.join(' / ')} (median ${row.medianP99}) · max ${row.max.join(' / ')} ms · machine CPU ${row.cpuPercent.join(' / ')}%${row.misses.length ? ' · MISSED: ' + row.misses.join(', ') : ''}`)
    if (assert && results.load.summary.some(row => row.misses.length)) process.exitCode = 1
  } else if (floor) {
    results.floor = await scenario(1, { historyEvents: 4, live: '', background: 0 })
    console.log(`floor: empty ${provider} conversation, 1 tab: input->paint p50 ${results.floor.inputToNextPaintMs.p50} / p95 ${results.floor.inputToNextPaintMs.p95} / p99 ${results.floor.inputToNextPaintMs.p99} ms; commits ${results.floor.reactCommits}`)
  }
  if (!loads.length) for (const count of tabCounts) {
    const result = await scenario(count)
    result.misses = misses(result)
    results.scenarios.push(result)
    console.log(`${provider}${provider === 'claude' ? ' ' + events + ' events' : ''}${livePrompt ? ' + ' + livePrompt + ' (' + JSON.stringify(result.liveTurn) + ')' : ''}${result.backgroundTurns ? ' + ' + backgroundTabs + ' background streams (' + result.backgroundTurns.events + ' events)' : ''}, ${count} tab(s), ${result.timelineItems} items (${result.renderedActivities} rendered): input->paint p50 ${result.inputToNextPaintMs.p50} / p95 ${result.inputToNextPaintMs.p95} / p99 ${result.inputToNextPaintMs.p99} ms; longtasks ${result.longtasks.count} (${result.longtasks.totalMs} ms); commits ${result.reactCommits}; timeline mutations ${result.timelineMutations}; setItem ${result.localStorage.setItem}; getItem ${result.localStorage.getItem}; panes ${result.mountedStructuredPanes}; intact ${result.textIntact}; switch ${JSON.stringify(result.switching)}; max ${result.inputToNextPaintMs.max} ms${result.misses.length ? '; MISSED: ' + result.misses.join(', ') : ''}`)
  }
  if (assert && results.scenarios.some(result => result.misses.length)) process.exitCode = 1
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  throw error
} finally {
  await writeFile(join(output, label + '.json'), JSON.stringify(results, null, 2))
  if (standInCopy) await rm(standInCopy, { recursive: true, force: true }).catch(() => {})
}

// ------------------------------------------------------------------ typing under load (--load)

/** Round after round: a quiet window, then one window per load, all typed into the same composer
 *  of the same stand-in, so the quiet p95/p99 is the floor every load row is compared with. */
async function loadRounds(app, page, composerBox, { tabCount, errors }) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  const rows = []
  for (let round = 1; round <= repeat; round++) {
    for (const kind of ['quiet', ...loads]) {
      await composerBox.fill('')
      await composerBox.click()
      await page.waitForTimeout(1500)
      await page.evaluate(() => {
        const perf = window.__inputPerf = { active: true, samples: [], longtasks: [] }
        if (!window.__inputPerfPatched) {
          window.__inputPerfPatched = true
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
        perf.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) perf.longtasks.push(entry.duration) })
        perf.observer.observe({ type: 'longtask' })
      })
      if (profileMain) await app.evaluate(() => {
        const session = globalThis.__perfMainProfiler = new (process.getBuiltinModule('node:inspector').Session)()
        session.connect(); session.post('Profiler.enable'); session.post('Profiler.setSamplingInterval', { interval: 500 }); session.post('Profiler.start')
      })
      const cpuBefore = cpus()
      const started = Date.now()
      const load = kind === 'quiet' ? null : LOADS[kind]({ round })
      let typedText = ''
      for (let word = 0; Date.now() - started < 15 * 60_000; word++) {
        const chunk = words[word % words.length] + ' '
        await page.keyboard.type(chunk, { delay })
        typedText += chunk
        if (typedText.length >= chars && (!load || load.settled)) break
      }
      const typingMs = Date.now() - started
      const cpuPercent = machineCpuPercent(cpuBefore, cpus())
      const loadResult = load ? await load.done : undefined
      let mainHotspots
      if (profileMain) {
        const samples = await app.evaluate(() => new Promise((done, fail) => globalThis.__perfMainProfiler.post('Profiler.stop', (error, result) => { globalThis.__perfMainProfiler.disconnect(); error ? fail(error) : done(result.profile) })))
        await writeFile(join(output, `${label}-${kind}-${round}-main.cpuprofile`), JSON.stringify(samples))
        mainHotspots = selfTimeHotspots(samples, 12)
      }
      await page.waitForTimeout(500)
      const collected = await page.evaluate(() => { const perf = window.__inputPerf; perf.active = false; perf.observer.disconnect(); return { samples: perf.samples, longtasks: perf.longtasks } })
      const latencies = collected.samples.map(sample => sample.painted - sample.start).sort((a, b) => a - b)
      const row = {
        round, kind, typedChars: typedText.length, keystrokesMeasured: latencies.length, typingWallMs: typingMs, cpuPercent,
        textIntact: (await composerBox.inputValue()) === typedText,
        inputToNextPaintMs: { p50: round2(percentile(latencies, 50)), p95: round2(percentile(latencies, 95)), p99: round2(percentile(latencies, 99)), max: round2(latencies.at(-1) ?? 0), mean: round2(latencies.reduce((sum, item) => sum + item, 0) / Math.max(1, latencies.length)) },
        over50ms: latencies.filter(value => value > 50).length,
        over100ms: latencies.filter(value => value > 100).length,
        longtasks: { count: collected.longtasks.length, totalMs: round2(collected.longtasks.reduce((sum, value) => sum + value, 0)), maxMs: round2(Math.max(0, ...collected.longtasks)) },
        load: loadResult,
        mainHotspots
      }
      rows.push(row)
      console.log(`round ${round} ${kind}: ${row.keystrokesMeasured} keys over ${Math.round(typingMs / 1000)} s, input->paint p50 ${row.inputToNextPaintMs.p50} / p95 ${row.inputToNextPaintMs.p95} / p99 ${row.inputToNextPaintMs.p99} / max ${row.inputToNextPaintMs.max} ms, >100 ms ${row.over100ms}, machine CPU ${cpuPercent}%${loadResult ? ', load ' + JSON.stringify(loadResult) : ''}`)
    }
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  return { tabs: tabCount, provider, rows, summary: summarizeLoadRows(rows), errors }
}

function round2(value) { return Number(value.toFixed(2)) }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? round2(sorted[Math.floor((sorted.length - 1) / 2)]) : 0 }

/** Per kind: every round's p95/p99, their medians, and what --assert holds a load to: its median p95
 *  and p99 each within --bound-ms of the quiet medians. */
function summarizeLoadRows(rows) {
  const kinds = [...new Set(rows.map(row => row.kind))]
  const summary = kinds.map(kind => {
    const mine = rows.filter(row => row.kind === kind)
    return { kind, p95: mine.map(row => row.inputToNextPaintMs.p95), p99: mine.map(row => row.inputToNextPaintMs.p99), max: mine.map(row => row.inputToNextPaintMs.max), over100ms: mine.map(row => row.over100ms), cpuPercent: mine.map(row => row.cpuPercent), medianP95: median(mine.map(row => row.inputToNextPaintMs.p95)), medianP99: median(mine.map(row => row.inputToNextPaintMs.p99)), misses: [] }
  })
  const quiet = summary.find(row => row.kind === 'quiet')
  for (const row of summary) {
    if (!rows.filter(item => item.kind === row.kind).every(item => item.textIntact)) row.misses.push('typed text was not intact')
    if (row === quiet || !quiet) continue
    if (row.medianP99 > quiet.medianP99 + boundMs) row.misses.push(`median p99 ${row.medianP99} ms > quiet ${quiet.medianP99} + ${boundMs} ms`)
    if (row.medianP95 > quiet.medianP95 + boundMs) row.misses.push(`median p95 ${row.medianP95} ms > quiet ${quiet.medianP95} + ${boundMs} ms`)
  }
  return summary
}

function machineCpuPercent(before, after) {
  let idle = 0, total = 0
  after.forEach((cpu, index) => {
    const prior = before[index]?.times
    if (!prior) return
    for (const key of Object.keys(cpu.times)) total += cpu.times[key] - prior[key]
    idle += cpu.times.idle - prior.idle
  })
  return total ? Math.round(100 * (1 - idle / total)) : 0
}

/** A deadline for Promise.race that never keeps the process alive once the race is decided. */
function after(ms, value) { return new Promise(done => setTimeout(done, ms, value).unref()) }

/** Starts a load command. Background (the default): through scripts/lib/background-priority.mjs,
 *  the way smoke-lock starts a smoke now. Normal: straight at normal priority with the in-app
 *  lowering switched off, the way test work ran before typing-lag-under-test-load. */
function spawnLoad(command, env, logName) {
  const log = join(output, logName)
  const loadEnv = { ...env }
  if (loadPriority === 'normal') loadEnv.CONDUCTOR_BACKGROUND_PRIORITY = '0'
  else delete loadEnv.CONDUCTOR_BACKGROUND_PRIORITY
  const argv = loadPriority === 'normal' ? command : [process.execPath, resolve('scripts/lib/background-priority.mjs'), '--', ...command]
  const child = spawn(argv[0], argv.slice(1), { env: loadEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const chunks = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => chunks.push(chunk))
  const exited = new Promise(done => { child.on('exit', code => done(code)); child.on('error', () => done(-1)) })
  exited.then(() => writeFile(log, Buffer.concat(chunks)).catch(() => {}))
  return { child, exited }
}

/** A smoke's own work: rebuild out/, launch a parked Conductor from it, wait until it is up (its
 *  control-owner.json), leave it running --load-idle seconds, kill its tree. */
function startLaunchLoad({ round }) {
  const load = { settled: false }
  load.done = (async () => {
    const result = { steps: [] }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    let started = Date.now()
    const build = spawnLoad([process.execPath, resolve('node_modules/electron-vite/bin/electron-vite.js'), 'build'], env, `${label}-launch-${round}-build.log`)
    const buildCode = await Promise.race([build.exited, after(5 * 60_000, 'timeout')])
    if (buildCode === 'timeout') killTree(build.child.pid)
    result.steps.push({ step: 'build', ms: Date.now() - started, exitCode: buildCode })
    const root = await mkdtemp(join(tmpdir(), 'conductor-perf-load-'))
    const profileDir = join(root, 'profile')
    started = Date.now()
    const launched = spawnLoad([createRequire(import.meta.url)('electron'), resolve('out/main/index.js')], { ...env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profileDir, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_PARENT_PID: String(process.pid) }, `${label}-launch-${round}-app.log`)
    const credential = join(profileDir, 'control-owner.json')
    while (!existsSync(credential) && Date.now() - started < 120_000) await new Promise(done => setTimeout(done, 250))
    result.steps.push({ step: 'launch', ms: Date.now() - started, ready: existsSync(credential) })
    await new Promise(done => setTimeout(done, 2000))
    result.priorities = processTreePriorities(launched.child.pid)
    await new Promise(done => setTimeout(done, Math.max(0, loadIdleSeconds * 1000 - 2000)))
    killTree(launched.child.pid)
    await Promise.race([launched.exited, after(10_000)])
    await rm(root, { recursive: true, force: true }).catch(() => {})
    return result
  })().finally(() => { load.settled = true })
  return load
}

/** Agent-style test run: the whole vitest suite for --load-seconds, then its tree is killed. */
function startVitestLoad({ round }) {
  const load = { settled: false }
  load.done = (async () => {
    const started = Date.now()
    const run = spawnLoad([process.execPath, resolve('node_modules/vitest/vitest.mjs'), 'run'], { ...process.env }, `${label}-vitest-${round}.log`)
    await new Promise(done => setTimeout(done, 10_000))
    const priorities = processTreePriorities(run.child.pid)
    const code = await Promise.race([run.exited, after(Math.max(0, loadSeconds * 1000 - 10_000), 'stopped')])
    if (code === 'stopped') { killTree(run.child.pid); await Promise.race([run.exited, after(10_000)]) }
    return { steps: [{ step: 'vitest', ms: Date.now() - started, exitCode: code }], priorities }
  })().finally(() => { load.settled = true })
  return load
}

/** Four coworkers' worth at once, the way a swarm lands on this machine: one builds and launches a
 *  parked instance, one runs vitest, one runs tsc; the machine saturates. */
function startSwarmLoad({ round }) {
  const load = { settled: false }
  load.done = (async () => {
    const started = Date.now()
    const tsc = spawnLoad([process.execPath, resolve('node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'], { ...process.env }, `${label}-swarm-${round}-tsc.log`)
    const [launch, vitest, tscCode] = await Promise.all([startLaunchLoad({ round }).done, startVitestLoad({ round }).done, tsc.exited])
    return { ms: Date.now() - started, launch, vitest, tsc: { exitCode: tscCode } }
  })().finally(() => { load.settled = true })
  return load
}

/** How many processes of each name run at which priority under `rootPid`, the evidence that a
 *  load's GPU, renderer and worker processes really are below normal. */
function processTreePriorities(rootPid) {
  try {
    let list
    if (process.platform === 'win32') {
      const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,Priority | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      // Win32_Process.Priority is the base priority: 4 idle, 6 below normal, 8 normal, 10 above normal.
      const names = { 4: 'low', 6: 'below_normal', 8: 'normal', 10: 'above_normal', 13: 'high' }
      list = JSON.parse(query.stdout).map(entry => ({ pid: entry.ProcessId, ppid: entry.ParentProcessId, name: entry.Name, priority: names[entry.Priority] ?? String(entry.Priority) }))
    } else {
      const query = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,ni=,comm='], { encoding: 'utf8' })
      list = query.stdout.trim().split('\n').map(line => line.trim().split(/\s+/)).map(([pid, ppid, ni, ...name]) => ({ pid: Number(pid), ppid: Number(ppid), name: name.join(' ').split('/').pop(), priority: priorityName(Number(ni)) }))
    }
    const tree = new Set([rootPid])
    for (let grew = true; grew;) { grew = false; for (const entry of list) if (!tree.has(entry.pid) && tree.has(entry.ppid)) { tree.add(entry.pid); grew = true } }
    const counts = {}
    for (const entry of list) if (tree.has(entry.pid)) counts[`${entry.name} ${entry.priority}`] = (counts[`${entry.name} ${entry.priority}`] ?? 0) + 1
    return counts
  } catch (error) { return { error: String(error.message ?? error) } }
}

/** Main-thread time of the busiest renderer main thread (CrRendererMain) by trace event name: total (nested events
 *  included) and top-level only (children of a task), heaviest first. */
function summarizeTrace(events, count = 80) {
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
  // How much of the document each style recalc and layout covered, per event.
  const spread = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, total: sorted.reduce((sum, value) => sum + value, 0), p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? 0 } }
  const mine = events.filter(event => event.pid + ':' + event.tid === main)
  const styleElements = spread(mine.filter(event => event.name === 'UpdateLayoutTree' && event.ph === 'X').map(event => event.args?.elementCount ?? 0))
  const layouts = mine.filter(event => event.name === 'Layout' && event.args?.beginData)
  const layoutObjects = { dirty: spread(layouts.map(event => event.args.beginData.dirtyObjects ?? 0)), total: spread(layouts.map(event => event.args.beginData.totalObjects ?? 0)) }
  // Blink's invalidation tracking: which node and why, most frequent first.
  const reasons = new Map()
  for (const event of events) {
    if (!/InvalidationTracking$/.test(event.name)) continue
    const data = event.args?.data ?? {}
    const key = event.name.replace('InvalidationTracking', '') + ' · ' + (data.nodeName ?? '?') + ' · ' + (data.reason ?? data.invalidationList?.map(entry => entry.classes?.join('.') || entry.id || entry.attribute || entry.tagName || '?').join(',') ?? data.changedClass ?? data.changedAttribute ?? data.changedPseudo ?? data.changedId ?? '')
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }
  const invalidations = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, n]) => ({ name, count: n }))
  // Animations Chrome could not hand to the compositor run on the renderer's main thread every
  // frame (style, and layout or paint): its own reasons, per animation name.
  const animationRuns = new Map()
  for (const event of events) {
    if (event.name !== 'Animation' || !event.args?.data) continue
    const data = event.args.data
    const key = (data.name || data.id || '?') + (data.compositeFailed ? ' · not composited (reasons ' + data.compositeFailed + (data.unsupportedProperties?.length ? ': ' + data.unsupportedProperties.join(',') : '') + ')' : '')
    if (data.compositeFailed !== undefined || data.name) animationRuns.set(key, (animationRuns.get(key) ?? 0) + 1)
  }
  const animations = [...animationRuns].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, n]) => ({ name, events: n }))
  return { runTaskMs: Number(((busy.get(main) ?? 0) / 1000).toFixed(1)), topLevel: top(topLevel), total: top(total), styleElements, layoutObjects, invalidations, animations }
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
