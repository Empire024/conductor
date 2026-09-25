// FX23 (feature-list.md confirm-close-working-tab): a detached window's own close (title-bar x ->
// BrowserWindow.close) holding a working tab asks like the tab x does, and a confirmed close can be
// undone from the main window for a few seconds; the turn stops only when the undo lapses.
//   W1  "Close and stop", then Undo in the main window -> the tab is back in the main window, turn still running
//   W2  "Close and stop", undo left to lapse         -> the tab stays closed and its turn is stopped
//   W3  control: "Don't close"                        -> the window stays, the turn keeps running
//   node scripts/smoke-lock.mjs -- node scripts/smoke-fx23-window-close.mjs
import { call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'fx23-window-close', output: process.env.FX23_OUT ?? 'artifacts/verification/fx23-window-close' })
watchdog(8 * 60)

// Streams for two minutes on "stream slowly" until interrupted.
const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'fx23', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
let stop = false
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    if (message.request.subtype === 'interrupt') stop = true
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } })
  }
  if (message.type !== 'user') return
  stop = false
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (let i = 0; i < 480 && !stop; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'done' }] } })
  emit({ type: 'result', subtype: stop ? 'error_during_execution' : 'success', is_error: stop, usage: {} })
})
`

const DIALOG = '.close-work-confirm'
const UNDO = '.close-work-undo'
const phase = async id => (await call('agents.status', { agentSessionId: id }).catch(() => ({ phase: 'no status' }))).phase
const listed = async () => { const value = await call('tabs.list', {}); return Array.isArray(value) ? value : value.tabs ?? [] }
const isOpen = async id => (await listed()).some(entry => entry.resourceId === id)

try {
  await loadCheck()
  const inst = await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1' } })
  const view = await page()
  await openProject({ name: 'FX23 window close', git: true })
  const tab = await openTab({ provider: 'claude', title: 'FX23 worker' })
  await call('agents.submit', { agentSessionId: tab.resourceId, prompt: 'stream slowly' })
  await poll(async () => (await phase(tab.resourceId)) === 'running', { timeoutMs: 30_000, label: 'worker running' })

  /** Detaches the worker, closes its window with the frame's x and answers the question with `button`. */
  const closeDetached = async (button) => {
    const entry = (await listed()).find(item => item.resourceId === tab.resourceId)
    const before = inst.app.windows().length
    await call('tabs.detach', { tabId: entry?.tabId ?? entry?.id })
    await poll(() => inst.app.windows().length > before, { timeoutMs: 20_000, label: 'the detached window' })
    const detached = inst.app.windows().at(-1)
    await detached.locator(`.pane-tab[data-control-agent-id="${tab.resourceId}"]`).waitFor({ timeout: 20_000 })
    await sleep(800)
    await withDeadline(inst.app.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url)?.close() }, detached.url()), 10_000)
    const asked = await detached.locator(DIALOG).waitFor({ timeout: 8000 }).then(() => true, () => false)
    const text = asked ? (await detached.locator(DIALOG).innerText()).replace(/\s+/g, ' ').slice(0, 140) : ''
    if (asked) await detached.getByRole('button', { name: button }).click()
    await sleep(1500)
    return { detached, asked, text }
  }

  step('W3 control: Don\'t close keeps the window and the turn')
  const kept = await closeDetached("Don't close")
  const keptResult = { asked: kept.asked, windowOpen: !kept.detached.isClosed(), phase: await phase(tab.resourceId) }
  record('W3-dont-close (control)', keptResult.asked && keptResult.windowOpen && keptResult.phase === 'running' ? 'PASS' : 'FAIL', keptResult, kept.text)
  // Put the tab back into the main window for the next case: the window's own close with the settled question answered.
  await withDeadline(inst.app.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url)?.close() }, kept.detached.url()), 10_000)
  await kept.detached.locator(DIALOG).waitFor({ timeout: 8000 })
  await kept.detached.getByRole('button', { name: 'Close and stop' }).click()
  await view.locator(UNDO).waitFor({ timeout: 8000 })
  await view.locator(UNDO).getByRole('button', { name: 'Undo' }).click()
  await poll(() => isOpen(tab.resourceId), { timeoutMs: 10_000, label: 'the worker back in the main window' })

  step('W1 Close and stop, then Undo in the main window')
  const closed = await closeDetached('Close and stop')
  const undoShown = await view.locator(UNDO).waitFor({ timeout: 8000 }).then(() => true, () => false)
  const undoText = undoShown ? await view.locator(UNDO).innerText() : ''
  const w1Shot = await shot('W1-undo-offer')
  if (undoShown) await view.locator(UNDO).getByRole('button', { name: 'Undo' }).click()
  const back = await poll(() => isOpen(tab.resourceId), { timeoutMs: 10_000, label: 'undo' }).then(() => true, () => false)
  await sleep(7000)
  const w1 = { asked: closed.asked, windowClosed: closed.detached.isClosed(), undoShown, undoText, back, phaseAfterUndoWindow: await phase(tab.resourceId) }
  record('W1-close-then-undo', w1.asked && w1.windowClosed && undoShown && back && w1.phaseAfterUndoWindow === 'running' ? 'PASS' : 'FAIL', w1, w1Shot)

  step('W2 Close and stop, undo left to lapse')
  const lapsed = await closeDetached('Close and stop')
  const offered = await view.locator(UNDO).waitFor({ timeout: 8000 }).then(() => true, () => false)
  await sleep(9000)
  const stillClosed = !(await isOpen(tab.resourceId))
  // A closed tab has no status; bring it back (Reopen closed tab) to read whether its turn was stopped.
  await view.bringToFront().catch(() => {})
  await view.keyboard.press('Control+Shift+T')
  const reopened = await poll(() => isOpen(tab.resourceId), { timeoutMs: 10_000, label: 'reopen' }).then(() => true, () => false)
  const stopped = reopened && await poll(async () => !['running', 'interrupting', 'no status'].includes(await phase(tab.resourceId)), { timeoutMs: 20_000, label: 'the turn stopped' }).then(() => true, () => false)
  const w2 = { asked: lapsed.asked, windowClosed: lapsed.detached.isClosed(), offered, stillClosedAfterLapse: stillClosed, reopened, stopped, phase: await phase(tab.resourceId) }
  record('W2-close-undo-lapses', w2.asked && w2.windowClosed && offered && stillClosed && reopened && stopped ? 'PASS' : 'FAIL', w2, await shot('W2-after'))
} catch (error) {
  failed(error)
} finally {
  await finish()
}
