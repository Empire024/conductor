// VR8d (verify loop v3): 3477066e local model energy price. Owner: "let's add a cost approximation to local
// models (watts used)". VR7 E2 reopened it: the kWh price could not be saved in the Usage dialog.
//   E1 one real local turn shows Wh and a cost; View usage -> Energy, price 0.4, click Save: same page, dialog
//      still open, the turn's cost doubles, the price is stored, the composer's draft is neither sent nor lost.
//   E2 price 0.6 and Enter in the price field: the same, cost x3, no new message and no second local turn.
//   E3 the price survives a reload and an owner app.restart; control: Default brings the cost back to x1.
// A llama-server already running is reused and never stopped; one this run's app started is stopped.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr8d-energy.mjs [--label L] [--keep]
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, findProcesses, launchParked, loadCheck, openProject, openTab, page, poll, record, relaunched, shot, sleep, step, watchdog } from './verify-kit.mjs'

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'E'
configure({ name: 'vr8d-energy-' + label, output: 'C:/Claude/conductor/artifacts/verification/2026-09-26-vr8d' })
watchdog(14 * 60)
await loadCheck()
const MODEL = process.env.VR8D_MODEL ?? 'local/dolphin-x1-8b'
const DRAFT = 'VR8D draft: do not send this'
const llamaPids = async () => (await findProcesses('llama-server')).filter(entry => /^llama-server/i.test(entry.name)).map(entry => entry.pid)
const serversBefore = new Set(await llamaPids())
console.log(`llama-server before: ${[...serversBefore].join(', ') || 'none'}`)

try {
  const inst = await launchParked({ mode: 'spawn', env: { CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'VR8d energy' })
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'vr8d-energy' }, { mountTimeoutMs: 60_000 })
  const id = tab.resourceId
  const userMessages = () => (projection(id).items ?? []).filter(item => item.data?.type === 'text' && item.data.role === 'user').length
  const energyNotices = () => (projection(id).items ?? []).filter(item => item.data?.type === 'notice' && item.data.payload?.localEnergy).length

  step('E1: one real local turn')
  await call('agents.submit', { agentSessionId: id, prompt: 'Reply with the single word: ok' })
  const energy = await poll(() => (projection(id).items ?? []).map(item => item.data).find(item => item?.type === 'notice' && item.payload?.localEnergy)?.payload.localEnergy ?? null, { timeoutMs: 6 * 60_000, intervalMs: 2000, label: 'energy notice' })
  await poll(async () => /^(completed|idle)$/.test((await call('agents.status', { agentSessionId: id })).phase ?? ''), { timeoutMs: 60_000, label: 'turn settled' }).catch(() => null)
  const extra = [...await llamaPids()].filter(pid => !serversBefore.has(pid))
  if (extra.length) console.log(`WARNING: llama-server started by this run: ${extra.join(', ')}`)

  let view = await page()
  const pane = () => view.locator(`.structured-agent-pane[data-structured-session="${id}"]`)
  const focus = async () => { await call('tabs.focus', { tabId: tab.id }).catch(() => {}); await pane().locator('.sa-local-energy[data-energy="measured"]').first().waitFor({ state: 'attached', timeout: 30_000 }) }
  await focus()
  const moneyOf = text => { const match = /≈\s*\$([\d.]+)\s*this turn/.exec(text); return match ? Number(match[1]) : null }
  const cost = async () => moneyOf((await pane().locator('.sa-local-energy[data-energy="measured"]').first().textContent()) ?? '')
  const near = (a, b) => a !== null && b !== null && Math.abs(a - b) <= Math.max(b * 0.06, 1e-7)
  const base = await cost()
  const composer = pane().locator('textarea[aria-label^="Message"]').first()
  await composer.fill(DRAFT)
  const usersBefore = userMessages(), noticesBefore = energyNotices()

  const openUsage = async () => {
    if (!await pane().locator('.sa-local-energy-totals').first().isVisible().catch(() => false)) await pane().locator('button.sa-usage-link:visible').first().click({ timeout: 15_000 })
    const usage = pane().locator('.sa-local-energy-totals').first()
    await usage.waitFor({ timeout: 15_000 })
    return usage
  }
  const mark = () => view.evaluate(() => { window.__vr8dMarker = true })
  const after = async () => ({
    samePage: await view.evaluate(() => window.__vr8dMarker === true).catch(() => false),
    dialogOpen: await pane().locator('.sa-local-energy-totals').first().isVisible().catch(() => false),
    cost: await cost().catch(() => null),
    stored: JSON.parse(await view.evaluate(() => localStorage.getItem('conductor.localEnergyPrice')).catch(() => 'null') ?? 'null'),
    draft: await composer.inputValue().catch(() => null),
    userMessages: userMessages(),
    energyNotices: energyNotices()
  })

  step('E1: price 0.4, click Save')
  let usage = await openUsage()
  await mark()
  await usage.getByLabel('Price per kWh').fill('0.4')
  await usage.getByRole('button', { name: 'Save' }).click()
  await sleep(1500)
  const e1 = await after()
  const e1Shot = await shot(`${label}1-save-click`)
  record(label + '1', energy.measured && energy.totalWh > 0 && base > 0 && e1.samePage && e1.dialogOpen && near(e1.cost, base * 2) && e1.stored?.perKwh === 0.4 && e1.draft === DRAFT && e1.userMessages === usersBefore ? 'PASS' : 'FAIL',
    { totalWh: energy.totalWh ?? null, measured: energy.measured ?? null, base, ...e1, stored: e1.stored?.perKwh ?? null, draftKept: e1.draft === DRAFT, usersBefore, extraLlama: extra.length }, e1Shot)

  step('E2: price 0.6, Enter in the price field')
  view = await page()
  usage = await openUsage()
  await mark()
  const price = usage.getByLabel('Price per kWh')
  await price.fill('0.6')
  await price.press('Enter')
  await sleep(1500)
  const e2 = await after()
  await sleep(3000)
  const e2late = { userMessages: userMessages(), energyNotices: energyNotices(), phase: (await call('agents.status', { agentSessionId: id })).phase }
  const e2Shot = await shot(`${label}2-save-enter`)
  record(label + '2', e2.samePage && e2.dialogOpen && near(e2.cost, base * 3) && e2.stored?.perKwh === 0.6 && e2.draft === DRAFT && e2late.userMessages === usersBefore && e2late.energyNotices === noticesBefore ? 'PASS' : 'FAIL',
    { base, ...e2, stored: e2.stored?.perKwh ?? null, draftKept: e2.draft === DRAFT, usersBefore, noticesBefore, late: e2late }, e2Shot)

  step('E3: reload, then owner app.restart')
  view = await page()
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor), null, { timeout: 30_000 })
  await focus()
  const reloadCost = await cost()
  const oldPid = inst.credential.pid
  await call('app.restart', { force: true }, { projectId: null })
  const seconds = await relaunched(inst, oldPid, { timeoutMs: 60_000 })
  view = await page()
  await poll(async () => (await call('tabs.list', {}).catch(() => [])).some(entry => entry.id === tab.id) || null, { timeoutMs: 60_000, label: 'tab restored' }).catch(() => null)
  await focus()
  const restartCost = await cost()
  usage = await openUsage()
  const restartField = await usage.getByLabel('Price per kWh').inputValue()
  const restartStored = JSON.parse(await view.evaluate(() => localStorage.getItem('conductor.localEnergyPrice')) ?? 'null')
  const e3Shot = await shot(`${label}3-after-restart`)
  await usage.getByRole('button', { name: /^Default/ }).click()
  await sleep(1000)
  const defaultCost = await cost()
  record(label + '3', near(reloadCost, base * 3) && near(restartCost, base * 3) && Number(restartField) === 0.6 && restartStored?.perKwh === 0.6 && near(defaultCost, base) ? 'PASS' : 'FAIL',
    { base, reloadCost, restartSeconds: seconds, restartCost, restartField, restartStored: restartStored?.perKwh ?? null, controlDefaultCost: defaultCost }, e3Shot)
} catch (error) { await failed(error, label + '-error') }

const started = (await llamaPids().catch(() => [])).filter(pid => !serversBefore.has(pid))
for (const pid of started) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
console.log(`llama-server started by this run and stopped: ${started.join(', ') || 'none'}`)
await finish()
