// The sidebar's usage corner opens the full usage view (feature-list 153a7424, UsageOverview.tsx), in a parked
// Electron window with a synthetic Claude CLI (no inference):
//   U1 a turn that reports Claude's five-hour window (reset in 102 min) and weekly window shows, in the corner,
//      the five-hour countdown ("1h 41m") and an elapsed bar about two thirds full;
//   U2 clicking the corner strip opens the usage dialog: both windows with history lines, "Resets in 1h 4xm",
//      the elapsed progressbar, the week-by-week allowance, the 7-day tokens and the token burn list;
//   U3 Escape closes it and returns focus to the corner; Enter on the corner reopens it; an outside click closes it;
//   U4 the "Last 7 days" bar under the process summary opens the same view;
//   U5 within two minutes the countdown ticks down and the elapsed bar grows, in the corner and in the dialog,
//      without a new report.
// Screenshots: artifacts/verification/2026-10-18-usage-corner/*.png. CONDUCTOR_SMOKE_MAIN runs another build.
//   node scripts/smoke-lock.mjs --timeout-min 15 -- node scripts/smoke-usage-corner.mjs
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'usage-corner', output: 'artifacts/verification/2026-10-18-usage-corner' })
watchdog(600)

// "ALLOW <five-hour %> <weekly %> <five-hour reset in minutes>" reports those windows as Claude's rate_limit_event does.
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'opus[1m]', displayName: 'Claude Opus 5.5' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  emit({ type: 'system', subtype: 'init', model: 'opus[1m]' })
  const match = prompt.match(/ALLOW (\\d+) (\\d+) (\\d+)/)
  if (match) {
    const now = Math.floor(Date.now() / 1000)
    emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: Number(match[1]) / 100, resetsAt: now + Number(match[3]) * 60 }, seven_day: { utilization: Number(match[2]) / 100, resetsAt: now + 4 * 86400 } } } })
  }
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const corner = view => view.evaluate(() => {
  const gauge = document.querySelector('.provider-allowance-row[data-provider="claude"] .provider-allowance-gauge[data-window="short"]')
  const button = document.querySelector('.provider-allowance-open')
  return {
    countdown: gauge?.querySelector('.provider-allowance-reset')?.textContent ?? null,
    elapsed: parseFloat(gauge?.querySelector('.provider-allowance-elapsed > span')?.style.width ?? 'NaN'),
    title: gauge?.getAttribute('title') ?? '',
    tag: button?.tagName ?? null,
    label: button?.getAttribute('aria-label') ?? '',
    expanded: button?.getAttribute('aria-expanded') ?? null
  }
})
const dialog = view => view.evaluate(() => {
  const root = document.querySelector('[role="dialog"][aria-label="Usage"]')
  if (!root) return null
  const rect = root.getBoundingClientRect()
  const short = root.querySelector('.usage-provider[data-provider="claude"] .usage-window[data-window="short"]')
  const bar = short?.querySelector('[role="progressbar"]')
  return {
    width: rect.width, height: rect.height,
    windows: [...root.querySelectorAll('.usage-provider[data-provider="claude"] .usage-window')].map(card => ({ window: card.getAttribute('data-window'), used: card.querySelector('header b')?.textContent, line: card.querySelector('path.line')?.getAttribute('d') ?? '' })),
    reset: short?.querySelector('.usage-window-reset')?.textContent ?? '',
    elapsedText: short?.querySelector('.usage-window-elapsed')?.textContent ?? '',
    progress: bar ? Number(bar.getAttribute('aria-valuenow')) : null,
    progressText: bar?.getAttribute('aria-valuetext') ?? '',
    weeklyAllowance: Boolean(root.querySelector('.weekly-allowance')),
    weeklyUsage: Boolean(root.querySelector('.weekly-usage:not(.compact)')),
    burn: Boolean(root.querySelector('.usage-overview-burn .token-burn-list')),
    focusInside: root.contains(document.activeElement)
  }
})
const minutes = text => { const match = /(?:(\d+)h )?(\d+)m/.exec(text ?? ''); return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : NaN }
const settled = id => poll(async () => (await call('agents.status', { agentSessionId: id })).phase === 'completed', { timeoutMs: 45_000, label: 'turn completed' })

try {
  step('launch')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE } })
  await openProject({ name: 'Usage corner' })
  const view = await page(inst)
  const tab = await openTab({ provider: 'claude', model: 'opus[1m]', title: 'Usage reporter' })

  step('U1 the corner counts down to the end of the five-hour window')
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'ALLOW 18 41 102 first turn' })
  await settled(tab.resourceId)
  const first = await poll(async () => { const value = await corner(view); return value.countdown ? value : null }, { timeoutMs: 20_000, label: 'the five-hour countdown' })
  assert.equal(first.tag, 'BUTTON', 'the corner is a real button')
  assert.match(first.countdown, /^1h 4[01]m$/, `countdown ${first.countdown}`)
  assert.ok(first.elapsed > 64 && first.elapsed < 68, `elapsed bar ${first.elapsed}% (expected ~66%)`)
  assert.match(first.title, /of the window elapsed$/)
  assert.match(first.label, /^Usage: Claude weekly 41%, 5h 18%, resets in 1h 4[01]m\. Open the full usage view$/)
  assert.equal(first.expanded, 'false')
  record('U1', 'PASS', { countdown: first.countdown, elapsed: first.elapsed }, `${first.label}; ${await shot('u1-corner')}`)

  step('U2 a click on the corner opens the full usage view')
  await view.locator('.provider-allowance-open').click()
  const opened = await poll(() => dialog(view), { timeoutMs: 10_000, label: 'the usage dialog' })
  assert.ok(opened.width > 300 && opened.height > 200, `dialog size ${opened.width}x${opened.height}`)
  assert.deepEqual(opened.windows.map(entry => [entry.window, entry.used]), [['weekly', '41% used'], ['short', '18% used']])
  assert.ok(opened.windows.every(entry => entry.line.startsWith('M')), `history lines ${JSON.stringify(opened.windows)}`)
  assert.match(opened.reset, /^Resets in 1h 4[01]m · /)
  assert.ok(opened.progress >= 65 && opened.progress <= 67, `progress ${opened.progress}`)
  assert.match(opened.progressText, /^3h 1[89]m of 5h elapsed, resets in 1h 4[01]m$/)
  assert.ok(opened.weeklyAllowance && opened.weeklyUsage && opened.burn, `sections ${JSON.stringify(opened)}`)
  assert.ok(opened.focusInside, 'focus moved into the dialog')
  assert.equal((await corner(view)).expanded, 'true')
  record('U2', 'PASS', { progress: opened.progress }, `${JSON.stringify(opened)}; ${await shot('u2-usage-dialog')}`)

  step('U3 Escape closes, Enter reopens, an outside click closes')
  await view.keyboard.press('Escape')
  await poll(async () => (await dialog(view)) === null, { timeoutMs: 5000, label: 'closed by Escape' })
  assert.equal(await view.evaluate(() => document.activeElement?.classList.contains('provider-allowance-open')), true, 'focus back on the corner')
  await view.keyboard.press('Enter')
  await poll(() => dialog(view), { timeoutMs: 5000, label: 'reopened by Enter' })
  const outside = await view.evaluate(() => { const rect = document.querySelector('[role="dialog"][aria-label="Usage"]').getBoundingClientRect(); return { x: Math.round((rect.right + window.innerWidth) / 2), y: Math.round(window.innerHeight / 3) } })
  await view.mouse.click(outside.x, outside.y)
  await poll(async () => (await dialog(view)) === null, { timeoutMs: 5000, label: 'closed by an outside click' })
  record('U3', 'PASS', {}, 'Escape, Enter and outside click behave')

  step('U4 the 7-day bar under the process summary opens the same view')
  await view.locator('.process-status-summary-usage').click()
  // Opened again, the view starts from the last reading: no empty 'no provider reported' flash.
  const fromSummary = await poll(() => dialog(view), { timeoutMs: 5000, label: 'the dialog from the 7-day bar' })
  assert.equal(fromSummary.windows.length, 2)
  record('U4', 'PASS', {}, await shot('u4-from-summary'))
  await view.keyboard.press('Escape')
  await poll(async () => (await dialog(view)) === null, { timeoutMs: 5000, label: 'closed' })

  step('U5 the countdown ticks without a new report')
  await view.locator('.provider-allowance-open').click()
  const before = { corner: await corner(view), dialog: await poll(() => dialog(view), { timeoutMs: 5000, label: 'dialog' }) }
  const after = await poll(async () => {
    const now = await corner(view)
    return minutes(now.countdown) < minutes(before.corner.countdown) ? { corner: now, dialog: await dialog(view) } : null
  // The clock ticks on the wall-clock minute and the countdown turns at the reset's own second, so up to two minutes.
  }, { timeoutMs: 135_000, intervalMs: 1000, label: 'the minute tick' })
  assert.equal(minutes(before.corner.countdown) - minutes(after.corner.countdown), 1, `${before.corner.countdown} -> ${after.corner.countdown}`)
  assert.ok(after.corner.elapsed > before.corner.elapsed, `corner bar ${before.corner.elapsed} -> ${after.corner.elapsed}`)
  assert.ok(after.dialog, 'the dialog stayed open')
  assert.ok(minutes(after.dialog.reset.replace('Resets in ', '')) < minutes(before.dialog.reset.replace('Resets in ', '')), `dialog ${before.dialog.reset} -> ${after.dialog.reset}`)
  record('U5', 'PASS', {}, `${before.corner.countdown} -> ${after.corner.countdown}; bar ${before.corner.elapsed}% -> ${after.corner.elapsed}%; ${await shot('u5-ticked')}`)

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
