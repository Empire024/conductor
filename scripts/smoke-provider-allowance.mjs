// Provider allowance strip between "Needs attention" and the process summary (feature-list 2136b6ad,
// src/shared/provider-allowance.ts), in a parked Electron window with a synthetic Claude CLI (no inference):
//   P1 a turn that reports Claude's five-hour and weekly windows shows a Claude row with both percentages
//      and the reset time on hover; nothing is shown before any provider reported;
//   P2 the next turn's report moves the row and extends its line without any poll;
//   P3 typing in the composer does not touch the strip (no re-render per keystroke).
// Screenshots: artifacts/verification/2026-09-30-provider-allowance/*.png. CONDUCTOR_SMOKE_MAIN runs another build.
//   node scripts/smoke-lock.mjs --timeout-min 15 -- node scripts/smoke-provider-allowance.mjs
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, outputDir, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'provider-allowance', output: 'artifacts/verification/2026-09-30-provider-allowance' })
watchdog(600)

// "ALLOW <five-hour> <weekly>" reports those utilizations (percent) as Claude's rate_limit_event does.
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
  const match = prompt.match(/ALLOW (\\d+) (\\d+)/)
  if (match) {
    const now = Math.floor(Date.now() / 1000)
    emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: Number(match[1]) / 100, resetsAt: now + 3 * 3600 }, seven_day: { utilization: Number(match[2]) / 100, resetsAt: now + 4 * 86400 } } } })
  }
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Done.' }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const strip = view => view.evaluate(() => [...document.querySelectorAll('.provider-allowance-row')].map(row => ({
  provider: row.getAttribute('data-provider'),
  text: row.textContent,
  gauges: [...row.querySelectorAll('.provider-allowance-gauge:not(.empty)')].map(gauge => ({ value: gauge.querySelector('b')?.textContent, window: gauge.querySelector('small')?.textContent, title: gauge.getAttribute('title'), path: gauge.querySelector('path.line')?.getAttribute('d') ?? '' }))
})))
const settled = id => poll(async () => (await call('agents.status', { agentSessionId: id })).phase === 'completed', { timeoutMs: 45_000, label: 'turn completed' })

try {
  step('launch')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE } })
  await openProject({ name: 'Allowance' })
  const view = await page(inst)
  const tab = await openTab({ provider: 'claude', model: 'opus[1m]', title: 'Allowance reporter' })

  step('P1 a reported allowance shows a Claude row with both windows')
  assert.deepEqual(await strip(view), [], 'no row before any provider reported')
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'ALLOW 18 41 first turn' })
  await settled(tab.resourceId)
  const first = await poll(async () => { const rows = await strip(view); return rows.length ? rows : null }, { timeoutMs: 20_000, label: 'the Claude row' })
  assert.equal(first.length, 1, JSON.stringify(first))
  assert.equal(first[0].provider, 'claude')
  assert.deepEqual(first[0].gauges.map(gauge => [gauge.value, gauge.window]), [['41%', '7d'], ['18%', '5h']])
  assert.match(first[0].gauges[0].title, /^Claude weekly: 41% used · resets .+\(in [34] d/)
  assert.match(first[0].gauges[1].title, /^Claude 5 hour: 18% used · resets .+\(in [23] h/)
  record('P1', 'PASS', {}, `${JSON.stringify(first)}; ${await shot('p1-first-report')}`)

  step('P2 the next report moves the row without a poll')
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'ALLOW 57 44 second turn' })
  await settled(tab.resourceId)
  const second = await poll(async () => { const rows = await strip(view); return rows[0]?.gauges[1]?.value === '57%' ? rows : null }, { timeoutMs: 20_000, label: 'the moved row' })
  assert.equal(second[0].gauges[0].value, '44%')
  assert.ok(second[0].gauges[1].path.split('V').length > first[0].gauges[1].path.split('V').length, `the line gained a step: ${first[0].gauges[1].path} -> ${second[0].gauges[1].path}`)
  const crop = join(outputDir(), 'p2-strip.png')
  const box = await view.evaluate(() => { const rect = document.querySelector('.provider-allowance').getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.floor(rect.y) - 60), width: Math.ceil(rect.right) + 8, height: Math.ceil(rect.height) + 140 } })
  const png = await inst.app.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect)).toPNG().toString('base64'), box)
  await writeFile(crop, Buffer.from(png, 'base64'))
  record('P2', 'PASS', {}, `${JSON.stringify(second[0].gauges.map(gauge => [gauge.value, gauge.path]))}; ${await shot('p2-second-report')}`)

  step('P3 typing does not touch the strip')
  await view.evaluate(() => {
    window.__allowanceMutations = 0
    window.__allowanceObserver = new MutationObserver(records => { window.__allowanceMutations += records.length })
    window.__allowanceObserver.observe(document.querySelector('.provider-allowance'), { subtree: true, childList: true, attributes: true, characterData: true })
  })
  const composer = view.locator('.structured-agent-pane textarea[aria-label^="Message "]:not(:disabled)').first()
  await composer.click()
  await composer.pressSequentially('typing into the composer should leave the allowance strip alone', { delay: 15 })
  const mutations = await view.evaluate(() => { window.__allowanceObserver.disconnect(); return window.__allowanceMutations })
  assert.equal(mutations, 0, 'no DOM change in the strip while typing')
  record('P3', 'PASS', { mutations }, 'typed 64 characters; the strip did not change')

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
