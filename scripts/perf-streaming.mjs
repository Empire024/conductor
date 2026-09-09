import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Drives a realistic streaming assistant reply (scripts/fixtures/codex-app-server.mjs
// scenario "synthetic:perf-stream": CONDUCTOR_PERF_STREAM_HISTORY prior tool activities
// (default 150) + a long markdown reply with two code blocks and a table, delivered as
// hundreds of small deltas back to back) through the real renderer under 4x CPU throttling,
// and records objective jank numbers: rAF inter-frame intervals, PerformanceObserver
// longtasks, and CDP Performance.getMetrics scripting/layout time. No thresholds are
// asserted here; this is a measurement harness, not a pass/fail smoke test.
const root = await mkdtemp(join(tmpdir(), 'conductor-perf-'))
const output = resolve('artifacts/perf-streaming')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, runs: [], failures: [] }

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function analyze(sample) {
  const frames = sample.frames
  const intervals = []
  for (let i = 1; i < frames.length; i++) intervals.push(frames[i] - frames[i - 1])
  const sorted = [...intervals].sort((a, b) => a - b)
  const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
  const dropped33 = intervals.filter((value) => value > 33.3).length
  const dropped50 = intervals.filter((value) => value > 50).length
  const third = Math.max(1, Math.floor(intervals.length / 3))
  const bucketMean = (part) => part.length ? part.reduce((a, b) => a + b, 0) / part.length : 0
  const buckets = {
    firstThirdMeanIntervalMs: Number(bucketMean(intervals.slice(0, third)).toFixed(2)),
    middleThirdMeanIntervalMs: Number(bucketMean(intervals.slice(third, 2 * third)).toFixed(2)),
    lastThirdMeanIntervalMs: Number(bucketMean(intervals.slice(2 * third)).toFixed(2))
  }
  const longtasks = sample.longtasks
  const metricsDelta = {}
  if (sample.before && sample.after) {
    const before = Object.fromEntries(sample.before.map((entry) => [entry.name, entry.value]))
    const after = Object.fromEntries(sample.after.map((entry) => [entry.name, entry.value]))
    for (const name of ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']) {
      if (before[name] === undefined || after[name] === undefined) continue
      const delta = after[name] - before[name]
      metricsDelta[name] = name.endsWith('Duration') ? Number((delta * 1000).toFixed(2)) : Math.round(delta)
    }
  }
  return {
    label: sample.label,
    wallMs: sample.wallMs,
    frameCount: frames.length,
    intervalCount: intervals.length,
    meanIntervalMs: Number(mean.toFixed(2)),
    medianIntervalMs: Number(percentile(sorted, 50).toFixed(2)),
    p95IntervalMs: Number(percentile(sorted, 95).toFixed(2)),
    maxIntervalMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    droppedFramesOver33ms: dropped33,
    droppedFramesOver50ms: dropped50,
    ...buckets,
    longtaskCount: longtasks.length,
    longtaskTotalMs: Number(longtasks.reduce((sum, entry) => sum + entry.duration, 0).toFixed(2)),
    longtaskMaxMs: Number(longtasks.reduce((max, entry) => Math.max(max, entry.duration), 0).toFixed(2)),
    cdpMetricsDeltaMs: metricsDelta
  }
}

try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Perf streaming fixture'))
  await page.reload()
  await page.getByText('Perf streaming fixture', { exact: true }).first().click()
  if (await page.locator('.launcher-grid').count()) await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  await page.locator('.structured-agent-pane').waitFor()
  const sessionId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()

  let cdp = null
  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    // This dev machine is far faster than a typical owner laptop; throttle so
    // main-thread cost that would be invisible here shows up as real dropped frames.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  } catch { /* CDP unavailable; longtask/rAF data still collected. */ }

  const runOnce = async (label) => {
    await composer.fill('synthetic:perf-stream')
    await page.evaluate(() => {
      window.__perf = { frames: [], longtasks: [] }
      window.__perfRaf = true
      const loop = (time) => { window.__perf.frames.push(time); if (window.__perfRaf) requestAnimationFrame(loop) }
      requestAnimationFrame(loop)
      window.__perfObserver = new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__perf.longtasks.push({ start: entry.startTime, duration: entry.duration }) })
      window.__perfObserver.observe({ entryTypes: ['longtask'] })
    })
    const before = cdp ? (await cdp.send('Performance.getMetrics')).metrics : null
    const wallStart = Date.now()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((id) => window.conductor.structured.snapshot(id), sessionId))?.phase, { timeout: 120_000, intervals: [50] }).toBe('completed')
    // Let the final commit's frame land before sampling, without adding any reply latency.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const wallEnd = Date.now()
    const after = cdp ? (await cdp.send('Performance.getMetrics')).metrics : null
    const collected = await page.evaluate(() => { window.__perfRaf = false; window.__perfObserver.disconnect(); return window.__perf })
    return { label, wallMs: wallEnd - wallStart, before, after, ...collected }
  }

  // Three sequential turns in the same pane: run1 is the clean baseline (fair before/after
  // comparison), run2/run3 carry a growing timeline to reveal whether cost scales with history.
  for (const label of ['run1', 'run2', 'run3']) results.runs.push(analyze(await runOnce(label)))

  const finalSnapshot = await page.evaluate((id) => window.conductor.structured.snapshot(id), sessionId)
  results.finalItemCount = finalSnapshot.items.length
  results.renderedActivities = await page.locator('.sa-activity').count()
  assertNoErrors(errors)
  console.log(JSON.stringify(results, null, 2))
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  throw error
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close()
}

function assertNoErrors(errors) {
  if (errors.length) throw new Error('Renderer errors during perf run: ' + errors.join('; '))
}
