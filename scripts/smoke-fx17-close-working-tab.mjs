// FX17 confirm-close-working-tab: closing a tab whose agent is still working asks first, on every
// owner close path, naming the work with "Don't close" as the default; a confirmed close can be
// undone for a few seconds (the turn keeps running and the tab reattaches), and only a lapsed undo
// stops the turn. Settled tabs close without a question.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx17-close-working-tab.mjs
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, poll, record, shot, sleep, step, watchdog } from './verify-kit.mjs'

configure({ name: 'fx17-close-working-tab' })
watchdog(8 * 60)
await loadCheck()

// Streams for a minute on "stream slowly"; answers at once otherwise.
const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'fx17-smoke', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
let stop = false
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    if (message.request.subtype === 'interrupt') stop = true
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : blocks
  const slow = typeof prompt === 'string' && prompt.includes('stream slowly')
  stop = false
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  if (slow) { for (let i = 0; i < 240 && !stop; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) } }
  else emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: slow ? 'slow-done' : 'Short done.' }] } })
  emit({ type: 'result', subtype: stop ? 'error_during_execution' : 'success', is_error: stop, usage: {} })
})
`

const DIALOG = '.close-work-confirm'
const UNDO = '.close-work-undo'
const phase = async id => (await call('agents.status', { agentSessionId: id })).phase
const tabOf = (view, id) => view.locator(`.pane-tab[data-control-agent-id="${id}"]`)
const isOpen = async (view, id) => (await tabOf(view, id).count()) > 0
const dialogText = async view => (await view.locator(DIALOG).count()) ? (await view.locator(DIALOG).innerText()).replace(/\s+/g, ' ') : ''

async function working(title) {
  const tab = await openTab({ provider: 'claude', title })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'stream slowly' })
  await poll(async () => (await phase(tab.resourceId)) === 'running', { timeoutMs: 30_000, label: `${title} running` })
  return tab
}
async function dialogShown(view) {
  await view.locator(DIALOG).waitFor({ timeout: 10_000 })
  return dialogText(view)
}

try {
  const { page: view } = await launchParked({ mode: 'playwright', env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' }, fixtures: { 'fake-claude.mjs': fakeClaude } })
  await openProject({ name: 'FX17 close guard', git: true })

  step('C1: the tab x asks, naming the work; "Don\'t close" is the default and keeps the tab')
  const mac = await working('MAC mini as a Conductor node')
  await tabOf(view, mac.resourceId).locator('.tab-close').click()
  const text = await dialogShown(view)
  const focused = await view.evaluate(() => document.activeElement?.textContent ?? '')
  const c1Shot = await shot('C1-dialog')
  await view.keyboard.press('Enter')
  await view.locator(DIALOG).waitFor({ state: 'detached', timeout: 5000 })
  await sleep(500)
  const keptOpen = await isOpen(view, mac.resourceId), keptPhase = await phase(mac.resourceId)
  record('C1', text.includes('“MAC mini as a Conductor node” is still working — close and stop it?') && text.includes('running a turn') && focused === "Don't close" && keptOpen && keptPhase === 'running' ? 'PASS' : 'FAIL', { focused, keptOpen, keptPhase }, `${c1Shot} text=${JSON.stringify(text.slice(0, 240))}`)

  step('C2: Escape and a click outside also keep the tab')
  await tabOf(view, mac.resourceId).locator('.tab-close').click()
  await dialogShown(view)
  await view.keyboard.press('Escape')
  await view.locator(DIALOG).waitFor({ state: 'detached', timeout: 5000 })
  await tabOf(view, mac.resourceId).locator('.tab-close').click()
  await dialogShown(view)
  await view.mouse.click(5, 5)
  await view.locator(DIALOG).waitFor({ state: 'detached', timeout: 5000 })
  record('C2', await isOpen(view, mac.resourceId) && (await phase(mac.resourceId)) === 'running' ? 'PASS' : 'FAIL', {}, 'Escape, then a backdrop click')

  step('C3: middle-click asks; "Close and stop" closes; Undo restores the tab with its turn still running')
  await tabOf(view, mac.resourceId).dispatchEvent('pointerdown', { button: 1, bubbles: true })
  await dialogShown(view)
  await view.getByRole('button', { name: 'Close and stop' }).click()
  await poll(async () => !(await isOpen(view, mac.resourceId)), { timeoutMs: 5000, label: 'tab closed' })
  await view.locator(UNDO).waitFor({ timeout: 5000 })
  const undoShot = await shot('C3-undo')
  const closedPhase = await phase(mac.resourceId)
  await view.locator(UNDO).getByRole('button', { name: 'Undo' }).click()
  await poll(() => isOpen(view, mac.resourceId), { timeoutMs: 5000, label: 'tab restored' })
  await sleep(7000)
  const restoredPhase = await phase(mac.resourceId)
  await tabOf(view, mac.resourceId).click()
  const reattached = await view.getByText(/slow\d+ slow\d+/).first().isVisible().catch(() => false)
  const restoredShot = await shot('C3-restored')
  record('C3', closedPhase === 'running' && restoredPhase === 'running' && reattached ? 'PASS' : 'FAIL', { closedPhase, restoredPhase, reattached }, `${undoShot}, ${restoredShot}`)

  step('C4: a confirmed close whose undo lapses stops the turn')
  await tabOf(view, mac.resourceId).locator('.tab-close').click()
  await dialogShown(view)
  await view.getByRole('button', { name: 'Close and stop' }).click()
  await poll(async () => !(await isOpen(view, mac.resourceId)), { timeoutMs: 5000, label: 'tab closed' })
  await view.locator(UNDO).waitFor({ state: 'detached', timeout: 12_000 })
  const closedAfterLapse = !(await isOpen(view, mac.resourceId))
  await sleep(3000)
  // agents.status only answers for a visible tab: reopen the closed tab to read its turn.
  await view.keyboard.press('Control+Shift+T')
  await poll(() => isOpen(view, mac.resourceId), { timeoutMs: 5000, label: 'tab reopened with Ctrl+Shift+T' })
  const stopped = await poll(async () => { const value = await phase(mac.resourceId); return value !== 'running' && value !== 'interrupting' ? value : null }, { timeoutMs: 20_000, label: 'turn stopped' })
  record('C4', closedAfterLapse && stopped ? 'PASS' : 'FAIL', { closedAfterLapse, stopped }, `undo lapsed after ~6 s, then the closed tab's turn was interrupted; ${await shot('C4-stopped')}`)

  step('C5: a settled tab closes without a question')
  const plain = await openTab({ provider: 'claude', title: 'Settled tab' })
  await call('agents.submit', { agentSessionId: plain.resourceId, prompt: 'hello' })
  await poll(async () => (await phase(plain.resourceId)) === 'completed', { timeoutMs: 30_000, label: 'settled' })
  await tabOf(view, plain.resourceId).locator('.tab-close').click()
  await sleep(1500)
  record('C5', (await view.locator(DIALOG).count()) === 0 && !(await isOpen(view, plain.resourceId)) && (await view.locator(UNDO).count()) === 0 ? 'PASS' : 'FAIL', {}, 'no dialog, no undo, tab gone')

  step('C6: the tab menu "Close tab" and Ctrl+W ask too')
  const menuTab = await working('Menu close worker')
  await tabOf(view, menuTab.resourceId).click({ button: 'right' })
  await view.getByRole('menuitem', { name: 'Close tab', exact: true }).click()
  const menuText = await dialogShown(view)
  await view.getByRole('button', { name: "Don't close" }).click()
  await tabOf(view, menuTab.resourceId).click()
  await view.keyboard.press('Control+w')
  const keyText = await dialogShown(view).catch(() => '')
  if (keyText) await view.getByRole('button', { name: "Don't close" }).click()
  record('C6', menuText.includes('“Menu close worker”') && keyText.includes('“Menu close worker”') && await isOpen(view, menuTab.resourceId) ? 'PASS' : 'FAIL', { menu: Boolean(menuText), ctrlW: Boolean(keyText) }, await shot('C6-after'))

  step('C7: closing a tab group with a working tab asks, and "Close and stop" closes the group')
  await tabOf(view, menuTab.resourceId).click({ button: 'right' })
  await view.getByRole('menuitem', { name: 'Add tab to new group' }).click()
  await sleep(300)
  await view.keyboard.press('Escape')
  await view.locator('.tab-group-chip').first().click({ button: 'right' })
  await view.getByRole('menuitem', { name: 'Close group' }).click()
  const groupText = await dialogShown(view)
  await view.getByRole('button', { name: 'Close and stop' }).click()
  await poll(async () => !(await isOpen(view, menuTab.resourceId)), { timeoutMs: 5000, label: 'group closed' })
  await view.locator(UNDO).getByRole('button', { name: 'Undo' }).click()
  const groupRestored = await poll(() => isOpen(view, menuTab.resourceId), { timeoutMs: 5000, label: 'group tab restored' }).catch(() => false)
  record('C7', groupText.includes('“Menu close worker”') && groupRestored ? 'PASS' : 'FAIL', { groupRestored }, await shot('C7-group'))
} catch (error) {
  await failed(error)
}
await finish()
