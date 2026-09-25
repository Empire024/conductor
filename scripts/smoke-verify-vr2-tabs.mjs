// VR2 group tabs (feature-list.md confirm-close-working-tab, task-list-description-bullets).
//   C2  the owner's MAC-worker case from the controller's side: closing a settled controller tab
//       takes its coworker group with it, and its coworker is still running -> one confirmation
//       naming the coworker; "Don't close" keeps both and the turn. A tab waiting on a question
//       closed with the x -> the confirmation says it is waiting for an answer.
//       control: the same controller closes silently once its coworker has settled.
//   C3  "window close": closing a detached window that holds a working tab -> a confirmation, or at
//       least the turn keeps running and the tab can come back. control: a detached window with a
//       settled tab closes silently.
//   K2  over a copy of the real feature-list.md: tasks.update of an item with description bullets
//       changes one line and keeps its bullets. control: an item without a description.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-verify-vr2-tabs.mjs [--only=C2|C3|K2]
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, call, configure, failed, finish, launchParked, loadCheck, openProject, openTab, page, poll, record, shot, sleep, step, watchdog, withDeadline } from './verify-kit.mjs'

configure({ name: 'vr2-tabs', output: process.env.VR2_OUT ?? 'artifacts/verification/2026-09-25-vr2' })
watchdog(12 * 60)
const only = (process.argv.find(arg => arg.startsWith('--only=')) ?? '').slice(7)
const want = id => !only || only === id

// Streams for a minute on "stream slowly", asks a question on "ask me", answers at once otherwise;
// writes every prompt to CONDUCTOR_TEST_CONTROL_CAPTURE (the first one carries the tab's control credential).
const fakeClaude = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'vr2-tabs', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
let stop = false, pending = null
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    if (message.request.subtype === 'interrupt') stop = true
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } })
  }
  if (message.type === 'control_response' && pending && message.response?.request_id === pending) { pending = null; emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Answered.' }] } }); return emit({ type: 'result', subtype: 'success', is_error: false, usage: {} }) }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('') : String(blocks)
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  stop = false
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (prompt.includes('ask me')) {
    pending = 'q-' + randomUUID()
    return send({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: pending, input: { questions: [{ header: 'Target', question: 'Which machine should I set up?', multiSelect: false, options: [{ label: 'MAC mini' }, { label: 'MAIN' }] }] } } })
  }
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  if (prompt.includes('stream slowly')) { for (let i = 0; i < 480 && !stop; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow' + i + ' ' } } }); await wait(250) } }
  else emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Short done.' } } })
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'done' }] } })
  emit({ type: 'result', subtype: stop ? 'error_during_execution' : 'success', is_error: stop, usage: {} })
})
`

const DIALOG = '.close-work-confirm'
const phase = async id => (await call('agents.status', { agentSessionId: id })).phase
const tabOf = (view, id) => view.locator(`.pane-tab[data-control-agent-id="${id}"]`)
const isOpen = async (_view, id) => { const listed = await call('tabs.list', {}); return (Array.isArray(listed) ? listed : listed.tabs ?? []).some(entry => entry.resourceId === id) }
const closeX = (view, id) => tabOf(view, id).locator('.tab-close').first().dispatchEvent('click')
const dialogText = async view => (await view.locator(DIALOG).count()) ? (await view.locator(DIALOG).innerText()).replace(/\s+/g, ' ') : ''
const credentialOf = async (capture, id) => {
  await call('agents.submit', { agentSessionId: id, prompt: 'hello' })
  await poll(async () => (await phase(id)) === 'completed', { timeoutMs: 30_000, label: `${id} completed` })
  const briefing = await readFile(capture, 'utf8')
  const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
  if (!auth.endpoint || !auth.token) throw new Error('no control credential in the briefing of ' + id)
  return auth
}
const asAgent = async (auth, method, args) => { const body = await (await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })).json(); if (body.error) throw new Error(`${method} as agent: ${JSON.stringify(body.error).slice(0, 300)}`); return body.result }
const settled = id => poll(async () => (await phase(id)) === 'completed', { timeoutMs: 30_000, label: `${id} completed` })

try {
  await loadCheck()
  const capture = join(await mkdtemp(join(tmpdir(), 'vr2-capture-')), 'prompt.txt')
  const real = await readFile(join(REPO, 'feature-list.md'), 'utf8')
  const inst = await launchParked({ mode: 'playwright', fixtures: { 'fake-claude.mjs': fakeClaude }, env: { CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  const view = await page()
  await openProject({ name: 'VR2 tabs', git: true, files: { 'feature-list.md': real } })

  if (want('C2')) {
    step('C2 a settled controller whose coworker is still working')
    const controller = await openTab({ provider: 'claude', title: 'VR2 controller' })
    await call('agents.submit', { agentSessionId: controller.resourceId, prompt: 'hello' })
    await settled(controller.resourceId)
    const briefing = await readFile(capture, 'utf8')
    const auth = { endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token: briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] }
    if (!auth.endpoint || !auth.token) throw new Error('no control credential in the controller briefing')
    const opened = await (await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tabs.open', args: { kind: 'agent', provider: 'claude', title: 'MAC mini as a Conductor node' } }) })).json()
    const worker = opened.result?.resourceId
    if (!worker) throw new Error('the controller could not open a coworker: ' + JSON.stringify(opened).slice(0, 300))
    await poll(() => call('agents.status', { agentSessionId: worker }), { timeoutMs: 30_000, label: 'coworker status' })
    await call('agents.submit', { agentSessionId: worker, prompt: 'stream slowly' })
    await poll(async () => (await phase(worker)) === 'running', { timeoutMs: 30_000, label: 'coworker running' })
    await closeX(view, controller.resourceId)
    const shown = await view.locator(DIALOG).waitFor({ timeout: 10_000 }).then(() => true, () => false)
    const text = await dialogText(view)
    const c2Shot = await shot('C2-controller-close')
    if (shown) await view.getByRole('button', { name: "Don't close" }).click()
    await sleep(800)
    const kept = { controller: await isOpen(view, controller.resourceId), worker: await isOpen(view, worker), workerPhase: await phase(worker) }

    step('C2 a tab waiting on a question')
    const asking = await openTab({ provider: 'claude', title: 'VR2 asking' })
    await call('agents.submit', { agentSessionId: asking.resourceId, prompt: 'ask me' })
    await poll(async () => ['waiting_input', 'waiting_approval'].includes(await phase(asking.resourceId)), { timeoutMs: 30_000, label: 'the question to hold the turn' })
    await closeX(view, asking.resourceId)
    const askShown = await view.locator(DIALOG).waitFor({ timeout: 10_000 }).then(() => true, () => false)
    const askText = await dialogText(view)
    if (askShown) await view.getByRole('button', { name: "Don't close" }).click()

    step('C2 control: the controller closes silently once the coworker settled')
    await call('agents.interrupt', { agentSessionId: worker }).catch(() => null)
    await poll(async () => !['running', 'interrupting'].includes(await phase(worker)), { timeoutMs: 20_000, label: 'coworker stopped' })
    await sleep(1000)
    await closeX(view, controller.resourceId)
    await sleep(1500)
    const controlDialog = (await view.locator(DIALOG).count()) > 0
    if (controlDialog) await view.getByRole('button', { name: "Don't close" }).click()
    const controlClosed = !(await isOpen(view, controller.resourceId))
    record('C2', shown && text.includes('“MAC mini as a Conductor node”') && kept.controller && kept.worker && kept.workerPhase === 'running' && askShown && /waiting for your answer/.test(askText) && !controlDialog && controlClosed ? 'PASS' : 'FAIL',
      { dialogOnControllerClose: shown, kept, dialogOnQuestionTab: askShown, controlDialog, controlClosed },
      `controller close: ${JSON.stringify(text.slice(0, 200))}; question tab: ${JSON.stringify(askText.slice(0, 200))}; ${c2Shot}`)
  }

  if (want('C3')) {
    step('C3 closing a detached window that holds a working tab')
    const detachAndClose = async (title, prompt) => {
      const tab = await openTab({ provider: 'claude', title })
      await call('agents.submit', { agentSessionId: tab.resourceId, prompt })
      if (prompt === 'stream slowly') await poll(async () => (await phase(tab.resourceId)) === 'running', { timeoutMs: 30_000, label: `${title} running` })
      else await settled(tab.resourceId)
      const listed = await call('tabs.list', {})
      const entry = (Array.isArray(listed) ? listed : listed.tabs ?? []).find(item => item.resourceId === tab.resourceId)
      const tabId = entry?.tabId ?? entry?.id
      if (!tabId) throw new Error('tabs.list has no tab id for ' + tab.resourceId + ': ' + JSON.stringify(entry).slice(0, 200))
      const windowsBefore = inst.app.windows().length
      await call('tabs.detach', { tabId })
      await poll(() => inst.app.windows().length > windowsBefore, { timeoutMs: 20_000, label: 'the detached window' })
      const detached = inst.app.windows().at(-1)
      await detached.waitForLoadState('domcontentloaded')
      await detached.locator(`.pane-tab[data-control-agent-id="${tab.resourceId}"]`).waitFor({ timeout: 20_000 })
      await sleep(1000)
      let neighbour = null
      if (prompt === 'stream slowly') {
        await detached.locator(`.pane-tab[data-control-agent-id="${tab.resourceId}"] .tab-close`).first().dispatchEvent('click')
        neighbour = await detached.locator(DIALOG).waitFor({ timeout: 8000 }).then(() => true, () => false)
        if (neighbour) { await detached.getByRole('button', { name: "Don't close" }).click(); await sleep(800) }
      }
      // The owner clicks the detached window's own close button (the OS frame's X): BrowserWindow.close().
      const closed = await withDeadline(inst.app.evaluate(({ BrowserWindow }, url) => { const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url); if (!win) return 'no window'; win.close(); return 'close sent' }, detached.url()), 10_000)
      await sleep(2500)
      const stillThere = !detached.isClosed()
      const confirm = stillThere ? await detached.locator(DIALOG).count().catch(() => 0) : 0
      const confirmText = confirm ? (await detached.locator(DIALOG).innerText()).replace(/\s+/g, ' ') : ''
      const evidence = stillThere ? await withDeadline(detached.screenshot({ path: join(inst.root, `${title}.png`) }), 5000) : null
      if (confirm) await detached.getByRole('button', { name: "Don't close" }).click().catch(() => {})
      await sleep(4000)
      const after = await phase(tab.resourceId).catch(error => 'no status: ' + String(error.message).slice(0, 80))
      const inMain = await isOpen(view, tab.resourceId)
      let reopened = null
      if (!inMain) {
        await view.bringToFront().catch(() => {})
        await view.keyboard.press('Control+Shift+T')
        reopened = await poll(() => isOpen(view, tab.resourceId), { timeoutMs: 8000, label: 'reopen' }).then(async () => ({ phase: await phase(tab.resourceId).catch(error => String(error.message).slice(0, 80)) }), () => 'not reopened by Ctrl+Shift+T')
      }
      return { neighbourXAsked: neighbour, reopened, closeSent: closed.ok ? closed.value : 'no answer', windowStillOpen: stillThere, confirm: Boolean(confirm), confirmText: confirmText.slice(0, 160), phaseAfter: after, tabInMainWindow: inMain, screenshot: Boolean(evidence?.ok) }
    }
    const working = await detachAndClose('VR2 detached worker', 'stream slowly')
    const settledCase = await detachAndClose('VR2 detached settled', 'hello')
    const asked = working.confirm && working.phaseAfter === 'running'
    const harmless = !working.confirm && working.phaseAfter === 'running' && working.tabInMainWindow
    // Without the neighbour (the same window's tab x asking) the harness cannot see a confirmation there at all.
    record('C3', working.neighbourXAsked !== true ? 'NOT RUN (harness)' : (asked || harmless) && !settledCase.confirm ? 'PASS' : 'FAIL', { working, control: settledCase }, `${asked ? 'asked before closing' : harmless ? 'no question, but the turn kept running and the tab is back in the main window' : 'the window closed without a question'}; ${await shot('C3-main-after')}`)
  }

  if (want('K2')) {
    step('K2 tasks.update over the real task list keeps description bullets')
    const lines = real.split(/\r?\n/)
    const agentTab = await openTab({ provider: 'claude', title: 'VR2 task agent' })
    const auth = await credentialOf(capture, agentTab.resourceId)
    const listed = await asAgent(auth, 'tasks.list', {})
    const tasks = listed.tasks ?? []
    const open = tasks.filter(task => task.status === 'todo' && task.line)
    const withBullets = open.find(task => /^\s+\S/.test(lines[task.line] ?? '') && /^- \[ \]/.test(lines[task.line - 1]))
    const plain = open.find(task => task !== withBullets && /^- \[ \]/.test(lines[task.line - 1]) && !/^\s+\S/.test(lines[task.line] ?? ''))
    if (!withBullets || !plain) throw new Error(`no suitable items: withBullets ${Boolean(withBullets)}, plain ${Boolean(plain)}`)
    const file = join(inst.projectPath, 'feature-list.md')
    const diff = (before, after) => { const a = before.split(/\r?\n/), b = after.split(/\r?\n/); const changed = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(i + 1); return { changed, linesBefore: a.length, linesAfter: b.length } }
    const update = async task => {
      const before = await readFile(file, 'utf8')
      const { revision } = await asAgent(auth, 'tasks.list', {})
      await asAgent(auth, 'tasks.update', { revision, id: task.id, status: 'done' })
      const after = await poll(async () => { const text = await readFile(file, 'utf8'); return text !== before ? text : null }, { timeoutMs: 15_000, label: `${task.id} written` })
      const d = diff(before, after)
      const line = after.split(/\r?\n/)[task.line - 1]
      return { ...d, line: line?.slice(0, 50), oneLine: d.changed.length === 1 && d.changed[0] === task.line && d.linesBefore === d.linesAfter && /^- \[x\]/.test(line) }
    }
    const beforeCounts = { total: listed.summary?.total ?? tasks.length, done: listed.summary?.completed ?? tasks.filter(task => task.status === 'done').length }
    const bullets = await update(withBullets)
    const control = await update(plain)
    const afterList = await asAgent(auth, 'tasks.list', {})
    const afterCounts = { total: afterList.summary?.total ?? afterList.tasks.length, done: afterList.summary?.completed ?? afterList.tasks.filter(task => task.status === 'done').length }
    record('K2', bullets.oneLine && control.oneLine && afterCounts.total === beforeCounts.total && afterCounts.done === beforeCounts.done + 2 ? 'PASS' : 'FAIL',
      { withBullets: { id: withBullets.id, line: withBullets.line, ...bullets }, control: { id: plain.id, line: plain.line, ...control }, beforeCounts, afterCounts },
      'pass: each update changes exactly its own checkbox line; the total stays, done goes up by 2')
  }
} catch (error) {
  await failed(error, 'vr2-tabs')
}
await finish()
