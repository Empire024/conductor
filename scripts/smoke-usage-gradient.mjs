// Usage graphs shade blue low and red sharply near 100% (usage-color.ts), parked Electron window, synthetic Claude CLI:
//   G1 after reports of 20/60/88/97% the corner sparkline and the dialog chart stroke through a gradient whose top stop is red and bottom stop blue.
// Screenshots: artifacts/verification/2026-10-22-usage-gradient/*.png.
//   node scripts/smoke-lock.mjs --timeout-min 10 -- node scripts/smoke-usage-gradient.mjs
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'usage-gradient', output: 'artifacts/verification/2026-10-22-usage-gradient' })
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

const settled = id => poll(async () => (await call('agents.status', { agentSessionId: id })).phase === 'completed', { timeoutMs: 45_000, label: 'turn completed' })
try {
  step('launch')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE } })
  await openProject({ name: 'Usage gradient' })
  const view = await page(inst)
  const tab = await openTab({ provider: 'claude', model: 'opus[1m]', title: 'Usage reporter' })
  for (const [short, weekly] of [[20, 20], [60, 55], [88, 80], [97, 93]]) {
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt: `ALLOW ${short} ${weekly} 102 turn` })
    await settled(tab.resourceId)
  }
  step('G1 gradient colours')
  await poll(async () => (await view.locator('.provider-allowance-gauge b').allTextContents()).some(text => text.includes('97')), { timeoutMs: 20_000, label: '97% shown' })
  await view.locator('.provider-allowance-open').click()
  await poll(() => view.locator('.usage-window-chart path.line').count().then(count => count > 0), { timeoutMs: 10_000, label: 'chart' })
  const read = await view.evaluate(() => [...document.querySelectorAll('svg')].filter(svg => svg.querySelector('linearGradient')).map(svg => ({ stops: [...svg.querySelectorAll('stop')].map(stop => stop.getAttribute('stop-color')), stroke: svg.querySelector('path.line')?.getAttribute('stroke') ?? null })))
  assert.ok(read.length >= 2, 'sparkline and chart both have gradients ' + JSON.stringify(read))
  for (const entry of read) {
    assert.equal(entry.stops[0], 'rgb(79, 143, 239)')
    assert.equal(entry.stops.at(-1), 'rgb(229, 57, 53)')
    assert.match(entry.stroke ?? '', /^url\(#usage-/)
  }
  record('G1', 'PASS', { gradients: read.length }, await shot('g1-gradient'))
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
