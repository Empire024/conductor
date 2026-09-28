// Tab selection, the per-workspace archive and the "continued from" / "opened by" line
// (feature-list 4538163d, src/shared/tab-archive.ts, src/renderer/src/layout/tab-selection.ts),
// driven in a parked Electron window with a synthetic Claude CLI (no inference):
//   L1 a coworker an agent opened starts with "Opened by <controller>";
//   S1 tab strip: Ctrl+click, Shift+click, Esc, Ctrl+A select like Explorer; the selection's menu
//      moves two tabs into a new pane; Delete closes the selection into the archive;
//   S2 dragging one tab of a selection moves the whole selection into another pane;
//   S3 "Open 2 tabs as a window" opens one window holding both;
//   S4 sidebar: click + Ctrl+click selects rows; the selection bar closes them into the archive;
//   A1 the Archive (linked from the sidebar's Done group) lists every closed tab, searches,
//      reopens one into its workspace and deletes one for good;
//   K1 Ctrl+K finds an archived tab and Enter reopens it;
//   E1 tabArchive.archive refuses a tab whose turn is running (and says why) and archives the rest;
//   L2 a handoff successor starts with "Continued from <predecessor>"; with the predecessor's tab
//      closed, the link brings it back from the archive.
// Screenshots: artifacts/tab-archive/*.png.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-tab-archive.mjs
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, openTab, page, poll, record, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'tab-archive', output: 'artifacts/tab-archive' })
watchdog(1200)

const capture = join(tmpdir(), `conductor-tab-archive-capture-${process.pid}.txt`)
const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const session = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }, { value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const prompt = Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text).join('') : String(blocks)
  if (process.env.CONDUCTOR_TEST_CONTROL_CAPTURE) writeFileSync(process.env.CONDUCTOR_TEST_CONTROL_CAPTURE, prompt)
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  if (prompt.includes('ARCHIVE HOLD')) return
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Done: ' + prompt.split('\\n', 1)[0].slice(0, 60) }] } })
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

const tabCall = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const body = await response.json()
  if (response.status !== 200 || body.error) throw new Error(`${method} -> ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 800)}`)
  return body.result
}
const settled = id => poll(async () => /^(completed|idle)$/.test((await call('agents.status', { agentSessionId: id })).phase ?? ''), { timeoutMs: 45_000, label: `${id} settles` })
const credentialAfter = async submit => {
  await rm(capture, { force: true })
  await submit()
  const briefing = await poll(async () => { const text = await readFile(capture, 'utf8').catch(() => ''); return text.includes('Conductor app control:') ? text : null }, { timeoutMs: 45_000, label: 'app-control briefing' })
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1], token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'The tab must receive an app-control briefing')
  return { endpoint, token }
}
const openIds = async () => (await call('tabs.list')).map(tab => tab.id)

let view
// The first BrowserWindow is not the main one once S3 opens a detached window; shoot the main page.
const snap = async name => { const file = join('artifacts', 'tab-archive', name + '.png'); await view.screenshot({ path: file }); return file.split('\\').join('/') }
try {
  step('launch and open the project')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE }, env: { CONDUCTOR_TEST_CONTROL_CAPTURE: capture } })
  await openProject({ name: 'tab archive', git: true })
  view = await page(inst)
  await view.evaluate(() => Promise.all([window.conductor.settings.setFinishedTabSweep(0), window.conductor.settings.setCoworkerAutoClose(0)]))
  const sessionId = inst.workspaceId
  const archive = () => view.evaluate(id => window.conductor.tabArchive.list(id, '', 500), sessionId)
  const archivedIds = async () => (await archive()).tabs.map(entry => entry.tab.id)

  step('a controller opens two coworkers')
  const boss = await openTab({ provider: 'claude', model: 'claude-fable-5-1', title: 'Archive boss' })
  const bossAuth = await credentialAfter(() => call('agents.submit', { agentSessionId: boss.resourceId, prompt: 'ARCHIVE plan the work' }))
  await settled(boss.resourceId)
  const coworkers = []
  for (const topic of ['strip selection', 'sidebar selection']) {
    const tab = await tabCall(bossAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'Coworker: ' + topic, prompt: 'ARCHIVE ' + topic })
    coworkers.push(tab)
  }
  for (const tab of coworkers) await settled(tab.resourceId)

  // ------------------------------------------------------------------ L1 opened by
  step('L1 a coworker starts with "Opened by <controller>"')
  await call('tabs.focus', { tabId: coworkers[0].id })
  const openedLine = view.locator(`.pane-tab-content:visible .sa-lineage-line`).first()
  await openedLine.waitFor({ timeout: 20_000 })
  const openedText = (await openedLine.innerText()).replace(/\s+/g, ' ')
  assert.equal(await openedLine.getAttribute('data-lineage'), 'opened')
  assert.match(openedText, /Opened by Archive boss/)
  record('L1', 'PASS', { line: openedText }, await snap('l1-opened-by'))

  // ------------------------------------------------------------------ S1 strip selection
  step('S1 strip: Explorer-style selection, move to a new pane, Delete to the archive')
  const shells = []
  for (let index = 1; index <= 6; index++) shells.push(await call('tabs.open', { kind: 'terminal', title: `Shell ${index}` }))
  const chip = tab => view.locator(`.pane-tabs .pane-tab[data-control-tab-id="${tab.id}"]`)
  const selectedIds = () => view.locator('.pane-tabs .pane-tab.multi-selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-control-tab-id')))
  await chip(shells[0]).click()
  await chip(shells[2]).click({ modifiers: ['Control'] })
  assert.deepEqual(new Set(await selectedIds()), new Set([shells[0].id, shells[2].id]), 'Ctrl+click adds to the tab on screen')
  assert.equal((await view.locator('.pane-tabs-selection-count').innerText()).trim(), '2 selected')
  await chip(shells[3]).click({ modifiers: ['Shift'] })
  assert.deepEqual(new Set(await selectedIds()), new Set([shells[2].id, shells[3].id]), 'Shift+click selects the range from the anchor')
  await snap('s1-strip-selection')
  await view.keyboard.press('Escape')
  assert.equal((await selectedIds()).length, 0, 'Esc clears')
  await chip(shells[0]).click()
  await view.keyboard.press('Control+a')
  const all = await view.locator('.pane-tabs .pane-tab').count()
  assert.equal((await selectedIds()).length, all, 'Ctrl+A in the strip selects every tab')
  await view.keyboard.press('Escape')
  await chip(shells[0]).click()
  await chip(shells[1]).click({ modifiers: ['Control'] })
  await chip(shells[1]).click({ button: 'right' })
  await snap('s1-selection-menu')
  await view.getByRole('menuitem', { name: 'Move to a new pane' }).click()
  await poll(async () => await view.locator('.pane-group').count() === 2, { timeoutMs: 10_000, label: 'a second pane' })
  const newPane = view.locator('.pane-group').filter({ has: chip(shells[0]) })
  assert.deepEqual(await newPane.locator('.pane-tab').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-control-tab-id'))), [shells[0].id, shells[1].id])
  await snap('s1-moved-to-new-pane')
  await chip(shells[0]).click()
  await chip(shells[1]).click({ modifiers: ['Control'] })
  await view.keyboard.press('Delete')
  await poll(async () => { const open = await openIds(); return !open.includes(shells[0].id) && !open.includes(shells[1].id) }, { timeoutMs: 15_000, label: 'the selection closed' })
  await poll(async () => { const ids = await archivedIds(); return ids.includes(shells[0].id) && ids.includes(shells[1].id) }, { timeoutMs: 15_000, label: 'the closed selection archived' })
  record('S1', 'PASS', { strip: all }, 'Ctrl+click {1,3}; Shift+click range {3,4}; Esc clears; Ctrl+A selects all; the menu moved {1,2} into a new pane; Delete closed both into the archive')

  // ------------------------------------------------------------------ S2 drag a selection
  step('S2 dragging one tab of a selection moves them all')
  await call('tabs.split', { tabId: boss.id, direction: 'horizontal' })
  await poll(async () => await view.locator('.pane-group').count() === 2, { timeoutMs: 10_000, label: 'a split to drag into' })
  const targetGroup = await view.locator('.pane-group').filter({ hasNot: chip(shells[2]) }).first().getAttribute('data-group-id')
  const target = view.locator(`.pane-group[data-group-id="${targetGroup}"]`)
  await chip(shells[2]).click()
  await chip(shells[3]).click({ modifiers: ['Control'] })
  await view.evaluate(({ from, to }) => {
    const source = document.querySelector(`.pane-tabs .pane-tab[data-control-tab-id="${from}"]`)
    const goal = document.querySelector(`.pane-group[data-group-id="${to}"] .pane-add-tab`).getBoundingClientRect()
    const start = source.getBoundingClientRect(), transfer = new DataTransfer()
    const x = goal.x + goal.width / 2, y = goal.y + goal.height / 2
    const fire = (element, type, clientX, clientY) => element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY }))
    fire(source, 'dragstart', start.x + 5, start.y + 5)
    fire(document.elementFromPoint(x, y) ?? document.body, 'dragover', x, y)
    fire(document.elementFromPoint(x, y) ?? document.body, 'drop', x, y)
    fire(source, 'dragend', x, y)
  }, { from: shells[3].id, to: targetGroup })
  const landed = await poll(async () => {
    const ids = await target.locator('.pane-tab').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-control-tab-id')))
    return ids.includes(shells[2].id) && ids.includes(shells[3].id) ? ids : null
  }, { timeoutMs: 10_000, label: 'both selected tabs in the other pane' }).catch(() => null)
  record('S2', landed ? 'PASS' : 'FAIL', { target: landed }, await snap('s2-dragged-selection'))

  // ------------------------------------------------------------------ S3 detach a selection
  step('S3 open a selection as one window')
  const beforeWindows = await view.evaluate(() => window.conductor.window.listDetached())
  await chip(shells[2]).click()
  await chip(shells[3]).click({ modifiers: ['Control'] })
  await chip(shells[3]).click({ button: 'right' })
  await view.getByRole('menuitem', { name: 'Open 2 tabs as a window' }).click()
  const detached = await poll(async () => (await view.evaluate(() => window.conductor.window.listDetached())).find(record => !beforeWindows.some(old => old.id === record.id)) ?? null, { timeoutMs: 15_000, label: 'a detached window' })
  const detachedTabs = detached.layout.root.type === 'group' ? detached.layout.root.tabs.map(tab => tab.id) : []
  record('S3', detachedTabs.length === 2 && detachedTabs.includes(shells[2].id) && detachedTabs.includes(shells[3].id) ? 'PASS' : 'FAIL', { detachedTabs }, 'one new window holds both selected tabs')

  // ------------------------------------------------------------------ S4 sidebar selection
  step('S4 sidebar: click, Ctrl+click and close the selection')
  const tree = view.locator('.session-tree .workspace-tab-tree').first()
  const row = tab => tree.locator(`[data-clarity-row="${tab.id}"] .workspace-tab-select`)
  await row(shells[4]).click()
  await row(shells[5]).click({ modifiers: ['Control'] })
  const bar = tree.locator('.workspace-selection-bar')
  await bar.waitFor({ timeout: 5000 })
  assert.match(await bar.innerText(), /2 selected/)
  await snap('s4-sidebar-selection')
  await bar.getByRole('button', { name: 'Close 2' }).click()
  await poll(async () => { const open = await openIds(); return !open.includes(shells[4].id) && !open.includes(shells[5].id) }, { timeoutMs: 15_000, label: 'sidebar selection closed' })
  await poll(async () => { const ids = await archivedIds(); return ids.includes(shells[4].id) && ids.includes(shells[5].id) }, { timeoutMs: 15_000, label: 'sidebar selection archived' })
  record('S4', 'PASS', {}, 'two sidebar rows selected with click + Ctrl+click; "Close 2" closed both into the archive')

  // ------------------------------------------------------------------ A1 archive
  step('A1 the Archive: list, search, reopen, delete for good')
  const archiveLink = tree.locator('.workspace-archive-link').first()
  await archiveLink.waitFor({ timeout: 15_000 })
  const linkText = await archiveLink.getAttribute('aria-label')
  await archiveLink.click()
  const dialog = view.locator('.tab-archive')
  await dialog.waitFor({ timeout: 5000 })
  await poll(async () => await dialog.locator('.tab-archive-row').count() >= 4, { timeoutMs: 10_000, label: 'archive rows' })
  const listed = await dialog.locator('.tab-archive-title').allTextContents()
  await snap('a1-archive')
  await dialog.getByRole('textbox', { name: 'Search closed tabs' }).fill('Shell 5')
  await poll(async () => await dialog.locator('.tab-archive-row').count() === 1, { timeoutMs: 5000, label: 'one search hit' })
  await dialog.locator('.tab-archive-row').first().click()
  await dialog.getByRole('button', { name: /^Reopen/ }).last().click()
  await poll(async () => (await openIds()).includes(shells[4].id), { timeoutMs: 15_000, label: 'Shell 5 reopened' })
  await poll(async () => !(await archivedIds()).includes(shells[4].id), { timeoutMs: 10_000, label: 'Shell 5 left the archive' })
  await archiveLink.click()
  await dialog.waitFor({ timeout: 5000 })
  await dialog.getByRole('textbox', { name: 'Search closed tabs' }).fill('Shell 6')
  await poll(async () => await dialog.locator('.tab-archive-row').count() === 1, { timeoutMs: 5000, label: 'Shell 6 found' })
  await dialog.locator('.tab-archive-row').first().click()
  await dialog.getByRole('button', { name: 'Delete forever' }).click()
  await snap('a1-delete-confirm')
  await dialog.getByRole('button', { name: 'Delete 1' }).click()
  await poll(async () => !(await archivedIds()).includes(shells[5].id), { timeoutMs: 10_000, label: 'Shell 6 deleted for good' })
  await view.keyboard.press('Escape')
  record('A1', 'PASS', { link: linkText, listed }, 'the Done group\'s Archive link opened every closed tab; search found Shell 5 and Reopen put it back; Shell 6 was deleted for good')

  // ------------------------------------------------------------------ K1 Ctrl+K
  step('K1 Ctrl+K finds an archived tab')
  await view.locator('.pane-tabs .pane-tab').first().click()
  await view.keyboard.press('Control+k')
  const palette = view.locator('.command-palette')
  await palette.waitFor({ timeout: 5000 })
  await palette.locator('input').fill('Shell 1')
  const hit = palette.locator('.palette-list button').filter({ hasText: 'Archived' }).first()
  await hit.waitFor({ timeout: 5000 })
  await snap('k1-palette-archived')
  await hit.click()
  await poll(async () => (await openIds()).includes(shells[0].id), { timeoutMs: 15_000, label: 'Shell 1 reopened from Ctrl+K' })
  record('K1', 'PASS', {}, 'Ctrl+K "Shell 1" listed the archived tab; choosing it reopened it')

  // ------------------------------------------------------------------ E1 atomic archive
  step('E1 tabArchive.archive refuses a running tab and archives the rest')
  const busy = await tabCall(bossAuth, 'tabs.open', { provider: 'claude', model: 'synthetic-claude', title: 'Busy coworker', prompt: 'ARCHIVE HOLD keep working' })
  await poll(async () => (await call('agents.status', { agentSessionId: busy.resourceId })).phase === 'running', { timeoutMs: 30_000, label: 'busy coworker running' })
  const archived = await view.evaluate(({ projectId, sessionId, ids }) => window.conductor.tabArchive.archive(projectId, sessionId, ids), { projectId: inst.projectId, sessionId, ids: [busy.id, shells[4].id] })
  assert.deepEqual(archived.archived.map(entry => entry.tabId), [shells[4].id], JSON.stringify(archived))
  assert.equal(archived.refused.length, 1)
  assert.equal(archived.refused[0].reason, 'its turn is still running')
  assert.equal(archived.refused[0].message, '“Busy coworker” was not archived: its turn is still running.')
  await poll(async () => (await archivedIds()).includes(shells[4].id), { timeoutMs: 15_000, label: 'Shell 5 archived by the API' })
  assert.ok((await openIds()).includes(busy.id), 'the running tab stays open')
  record('E1', 'PASS', archived, 'the running coworker was refused with its reason; the idle shell closed into the archive')
  await call('agents.interrupt', { agentSessionId: busy.resourceId }).catch(() => undefined)

  // ------------------------------------------------------------------ L2 continued from
  step('L2 a successor starts with "Continued from", and the link reopens the closed predecessor')
  const handoff = 'ARCHIVE successor: continue the tab work.\n\n' + [['Objective', 'Continue the tab work.'], ['Constraints', 'None.'], ['Owned files', 'None.'], ['Verified findings', 'The coworkers finished.'], ['Remaining work', 'Nothing.'], ['Artifact references', 'artifacts/tab-archive']].map(([h, l]) => h + '\n- ' + l).join('\n\n')
  const successor = await tabCall(bossAuth, 'agents.handoff', { handoff, successor: true })
  await settled(successor.agentSessionId)
  await settled(boss.resourceId)
  await call('tabs.focus', { tabId: successor.tabId })
  const continuedLine = view.locator(`.pane-tab-content:visible .sa-lineage-line[data-lineage="continued"]`).first()
  await continuedLine.waitFor({ timeout: 20_000 })
  const continuedText = (await continuedLine.innerText()).replace(/\s+/g, ' ')
  assert.match(continuedText, /Continued from Archive boss/)
  await snap('l2-continued-from')
  await call('tabs.close', { tabId: boss.id })
  await poll(async () => !(await call('tabs.list')).some(tab => tab.resourceId === boss.resourceId), { timeoutMs: 15_000, label: 'predecessor closed' })
  await poll(async () => (await archive()).tabs.some(entry => entry.tab.resourceId === boss.resourceId), { timeoutMs: 15_000, label: 'predecessor archived' })
  await continuedLine.locator('button').click()
  await poll(async () => (await call('tabs.list')).some(tab => tab.resourceId === boss.resourceId), { timeoutMs: 15_000, label: 'predecessor back from the archive' })
  const history = await view.evaluate(id => window.conductor.structured.snapshot(id), boss.resourceId)
  await snap('l2-predecessor-reopened')
  record('L2', history.items.length > 0 ? 'PASS' : 'FAIL', { line: continuedText, historyItems: history.items.length }, 'the successor reads "Continued from Archive boss"; with that tab closed, its link reopened it from the archive with its history')

  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await rm(capture, { force: true }).catch(() => {})
await finish()
