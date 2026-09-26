// FX36 (3477066e reopened by VR7 E2): the kWh price saved under View usage -> Energy (local model)
// reaches the timeline card and survives a reload. One short real local turn on the llama.cpp server
// the machine already runs (a server running before this smoke is used as it is and never stopped;
// one this run's app started is stopped at the end), then VR7's E2 steps with DOM diagnostics:
// where the price editor's form sits (a <form> nested in the composer's <form> was the suspect) and
// whether the Usage dialog is still open after Save.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-energy-price.mjs
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { call, configure, failed, finish, findProcesses, launchParked, openProject, openTab, page, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'energy-price', output: process.env.ENERGY_PRICE_OUT ?? 'artifacts/verification/fx36-energy-price' })
watchdog(12 * 60)
const MODEL = process.env.ENERGY_PRICE_MODEL ?? 'local/dolphin-x1-8b'
const serversBefore = new Set((await findProcesses('llama-server')).filter(entry => /^llama-server/i.test(entry.name)).map(entry => entry.pid))
let inst
try {
  inst = await launchParked({ mode: 'playwright', name: 'energy-price', env: { CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  await openProject({ name: 'Energy price' }, inst)
  const projection = id => { const db = new DatabaseSync(join(inst.profile, 'conductor.db'), { readOnly: true }); try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json) } finally { db.close() } }
  const tab = await openTab({ provider: 'local', model: MODEL, permission: 'accept-edits', exactPermission: true, title: 'energy-price' }, { inst, mountTimeoutMs: 60_000 })
  step('one short local turn')
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'Reply with the single word: ok' }, { inst })
  const energy = await poll(() => (projection(tab.resourceId).items ?? []).map(item => item.data).find(item => item?.type === 'notice' && item.payload?.localEnergy)?.payload.localEnergy ?? null, { timeoutMs: 6 * 60_000, intervalMs: 2000, label: 'energy notice' })
  record('turn-energy', energy.measured ? 'PASS' : 'FAIL', { totalWh: energy.totalWh ?? null })

  const view = await page(inst)
  await call('tabs.focus', { tabId: tab.id }, { inst }).catch(() => {})
  const card = view.locator('.sa-local-energy[data-energy="measured"]').first()
  await card.waitFor({ state: 'attached', timeout: 30_000 })
  const moneyOf = text => { const match = /≈\s*\$([\d.]+)\s*this turn/.exec(text); return match ? Number(match[1]) : null }
  const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= Math.max(b * 0.06, 1e-7)
  const shown = moneyOf((await card.textContent()) ?? '')

  step('E2: change the kWh price under Usage & limits')
  await view.locator('button.sa-usage-link:visible').first().click({ timeout: 15_000 })
  const usage = view.locator('.sa-local-energy-totals').first()
  await usage.waitFor({ timeout: 15_000 })
  const input = usage.getByLabel('Price per kWh')
  await input.waitFor({ timeout: 15_000 })
  const dom = await input.evaluate(element => {
    const editor = element.closest('.sa-energy-price')
    const save = [...(editor?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Save')
    return { editorTag: editor?.tagName ?? null, insideForm: Boolean(editor?.parentElement?.closest('form')), saveForm: save?.form?.className ?? null, saveType: save?.type ?? null }
  })
  console.log(`editor DOM: ${JSON.stringify(dom)}`)
  await input.fill('0.4')
  // Which submit fired, whether anything prevented it, and whether the page navigated away.
  await view.evaluate(() => {
    window.__energyMarker = true
    window.__submits = []
    window.addEventListener('submit', event => { window.__submits.push({ phase: 'capture', target: event.target?.className ?? null }) }, true)
    window.addEventListener('submit', event => { window.__submits.push({ phase: 'bubble', target: event.target?.className ?? null, prevented: event.defaultPrevented }) })
  })
  await usage.getByRole('button', { name: 'Save' }).click()
  await sleep(1000)
  const trace = await view.evaluate(() => ({ samePage: window.__energyMarker === true, submits: window.__submits ?? null }))
  console.log(`after Save: ${JSON.stringify(trace)}`)
  const dialogOpen = await view.locator('dialog.sa-dialog[open]').count()
  const after = moneyOf((await card.textContent()) ?? '')
  const storedNow = await view.evaluate(() => localStorage.getItem('conductor.localEnergyPrice'))
  await view.reload()
  await view.waitForFunction(() => Boolean(window.conductor))
  await call('tabs.focus', { tabId: tab.id }, { inst }).catch(() => {})
  const reloaded = view.locator('.sa-local-energy[data-energy="measured"]').first()
  await reloaded.waitFor({ state: 'attached', timeout: 30_000 })
  const afterReload = moneyOf((await reloaded.textContent()) ?? '')
  const stored = await view.evaluate(() => localStorage.getItem('conductor.localEnergyPrice'))
  const title = (await reloaded.getAttribute('title')) ?? ''
  const pass = close(after, shown * 2) && close(afterReload, shown * 2) && !/default price/.test(title) && JSON.parse(stored ?? 'null')?.perKwh === 0.4
  const e2Shot = await shot('e2-price-edited', inst)
  record('E2-price-editable', pass ? 'PASS' : 'FAIL', { before: shown, after, afterReload, dialogOpenAfterSave: dialogOpen, storedNow, stored, samePage: trace.samePage }, `editor ${JSON.stringify(dom)}; submits ${JSON.stringify(trace.submits)}; ${e2Shot}`)
} catch (error) { await failed(error, 'energy-price') }
const started = (await findProcesses('llama-server').catch(() => [])).filter(entry => /^llama-server/i.test(entry.name) && !serversBefore.has(entry.pid))
for (const entry of started) spawnSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
console.log(`llama-server started by this run and stopped: ${started.map(entry => entry.pid).join(', ') || 'none'}`)
await finish()
