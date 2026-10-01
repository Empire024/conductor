// Dragging tabs between workspaces of one project (feature-list ee0fbf15,
// src/renderer/src/layout/workspace-tab-move.ts, src/main/workspace-tab-move.ts), driven in a
// parked Electron window with a synthetic Claude CLI (no inference):
//   T1 tab view: a conversation tab dragged from the pane strip onto another workspace's tab in the
//      session bar lights it, moves there with its history and unsent draft, and is on disk;
//   R1 a tab drag this window cannot place (another project's, a detached window's) is refused
//      with the not-allowed cursor and a red outline, and nothing moves;
//   T2 projects view: a sidebar tab row whose turn is still running, dropped on another
//      workspace's row, moves there mid-turn; the turn keeps running on the same conversation;
//   T3 a sidebar selection of two tabs dropped into another workspace's tab list moves together;
//   P1 leaving the project and coming back reloads every moved tab where it was dropped.
// A synthetic DataTransfer outside an OS drag session does not keep dropEffect, so acceptance is
// read from preventDefault and the zone's lit/refused outline.
// Screenshots: artifacts/tab-workspace-move/*.png.
//   node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-tab-workspace-move.mjs
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { BUILD, call, configure, failed, finish, launchParked, openProject, page, poll, record, retryAck, step, watchdog } from './verify-kit.mjs'

const build = process.env.CONDUCTOR_SMOKE_MAIN ? resolve(process.env.CONDUCTOR_SMOKE_MAIN) : BUILD
configure({ name: 'tab-workspace-move', output: 'artifacts/tab-workspace-move' })
watchdog(900)

const FIXTURE = `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
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
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  const first = prompt.split('\\n').find(line => line.startsWith('MOVE')) ?? prompt.split('\\n', 1)[0]
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'Heard: ' + first.slice(0, 60) }] } })
  if (prompt.includes('MOVE HOLD')) return
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})
`

let view
const snap = async name => { const file = join('artifacts', 'tab-workspace-move', name + '.png'); await view.screenshot({ path: file }); return file.split('\\').join('/') }
const composer = () => view.getByRole('textbox', { name: /^Message / }).last()

/** A drag the way Chromium delivers one: dragstart on the source, dragover and drop on whatever
 *  is under the drop point, dragend on the source. Split in two so the lit target can be shot. */
const dragStart = (from, to, { start = true, types } = {}) => view.evaluate(({ from, to, start, types }) => {
  const source = from ? document.querySelector(from) : null, goal = document.querySelector(to)
  if (!goal || start && !source) throw new Error('missing ' + (goal ? from : to))
  const end = goal.getBoundingClientRect(), transfer = new DataTransfer()
  for (const [type, value] of Object.entries(types ?? {})) transfer.setData(type, value)
  const x = end.x + end.width / 2, y = end.y + end.height / 2
  const fire = (element, type) => element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: type === 'dragstart' ? source.getBoundingClientRect().x + 5 : x, clientY: type === 'dragstart' ? source.getBoundingClientRect().y + 5 : y }))
  if (start) fire(source, 'dragstart')
  const over = document.elementFromPoint(x, y) ?? goal
  const accepted = !fire(over, 'dragover')
  window.__smokeDrag = { fire, source, over }
  return { accepted, dropEffect: transfer.dropEffect, lit: goal.classList.contains('workspace-drop-target'), refused: goal.classList.contains('workspace-drop-refused'), title: goal.getAttribute('title') }
}, { from, to, start, types })
const dragFinish = () => view.evaluate(() => {
  const { fire, source, over } = window.__smokeDrag
  fire(over, 'drop')
  if (source) fire(source, 'dragend')
  window.__smokeDrag = null
})
const drag = async (from, to) => { const hover = await dragStart(from, to); await dragFinish(); return hover }

try {
  step('launch and open the project')
  const inst = await launchParked({ mode: 'playwright', build, fixtures: { 'fake-claude.mjs': FIXTURE } })
  const project = await openProject({ name: 'tab move', git: true })
  view = await page(inst)
  await view.evaluate(() => Promise.all([window.conductor.settings.setFinishedTabSweep(0), window.conductor.settings.setCoworkerAutoClose(0)]))
  const first = inst.workspaceId
  await view.locator('.session-add').click()
  await poll(async () => await view.locator('.session-tab').count() === 2, { timeoutMs: 15_000, label: 'a second workspace' })
  const workspaces = await view.evaluate(id => window.conductor.sessions.list(id), project.id)
  const second = workspaces.find(item => item.id !== first)
  assert.ok(second, 'the second workspace exists')
  await view.locator('.session-tab').first().click()
  await view.locator('.session-tab.active').first().filter({ hasText: workspaces.find(item => item.id === first).name }).waitFor({ timeout: 10_000 })

  const inFirst = { workspaceId: first }
  const tabsIn = async workspaceId => (await call('tabs.list', {}, { workspaceId })).filter(tab => !tab.detachedId).map(tab => tab.id)
  const onDisk = async workspaceId => {
    const listed = await view.evaluate(id => window.conductor.sessions.list(id), project.id)
    const walk = node => node.type === 'split' ? node.children.flatMap(walk) : node.tabs.map(tab => tab.id)
    return walk(listed.find(item => item.id === workspaceId).layout.root)
  }
  const open = args => retryAck(() => call('tabs.open', args, inFirst))
  const phase = async (id, workspaceId = first) => (await call('agents.status', { agentSessionId: id }, { workspaceId })).phase
  const settled = id => poll(async () => /^(completed|idle)$/.test(await phase(id) ?? ''), { timeoutMs: 45_000, label: `${id} settles` })
  const items = async id => (await view.evaluate(agent => window.conductor.structured.snapshot(agent), id)).items.length

  step('a finished conversation with an unsent draft, a running one, two shells')
  const mover = await open({ provider: 'claude', model: 'claude-fable-5-1', title: 'Mover A' })
  await call('agents.submit', { agentSessionId: mover.resourceId, prompt: 'MOVE first words' }, inFirst)
  await settled(mover.resourceId)
  await call('tabs.focus', { tabId: mover.id }, inFirst)
  await view.locator('.structured-agent-pane:visible').filter({ hasText: 'Heard: MOVE first words' }).first().waitFor({ timeout: 20_000 })
  const draft = 'Unsent draft that has to travel with the tab'
  await composer().fill(draft)
  const runner = await open({ provider: 'claude', model: 'claude-fable-5-1', title: 'Runner B' })
  await call('agents.submit', { agentSessionId: runner.resourceId, prompt: 'MOVE HOLD keep working' }, inFirst)
  await poll(async () => await phase(runner.resourceId) === 'running', { timeoutMs: 30_000, label: 'runner mid-turn' })
  const shells = [await open({ kind: 'terminal', title: 'Shell C' }), await open({ kind: 'terminal', title: 'Shell D' })]
  await call('tabs.focus', { tabId: mover.id }, inFirst)
  const moverItems = await items(mover.resourceId)

  // ------------------------------------------------------------------ T1 tab view
  step('T1 tab view: drag a strip tab onto another workspace in the session bar')
  const secondTab = `.session-tab[data-workspace-drop="${second.id}"]`
  const hover = await dragStart(`.pane-tabs .pane-tab[data-control-tab-id="${mover.id}"]`, secondTab)
  assert.ok(hover.accepted && hover.lit, `the other workspace takes the tab: ${JSON.stringify(hover)}`)
  const hoverShot = await snap('t1-hover-session-bar')
  await dragFinish()
  await poll(async () => (await tabsIn(second.id)).includes(mover.id), { timeoutMs: 15_000, label: 'the tab in the second workspace' })
  assert.ok(!(await tabsIn(first)).includes(mover.id), 'the tab left the first workspace')
  assert.ok((await onDisk(second.id)).includes(mover.id) && !(await onDisk(first)).includes(mover.id), 'both layouts are on disk')
  await view.locator(secondTab).click()
  await call('tabs.focus', { tabId: mover.id }, { workspaceId: second.id })
  await view.locator('.structured-agent-pane:visible').filter({ hasText: 'Heard: MOVE first words' }).first().waitFor({ timeout: 20_000 })
  assert.equal(await composer().inputValue(), draft, 'the unsent draft came along')
  assert.equal(await items(mover.resourceId), moverItems, 'the history is the same conversation')
  record('T1', 'PASS', { items: moverItems, hoverTitle: hover.title }, `${hoverShot}; ${await snap('t1-moved-with-draft')}`)

  // ------------------------------------------------------------------ R1 refusal
  step('R1 a tab drag this window cannot place is refused')
  const firstTab = `.session-tab[data-workspace-drop="${first}"]`
  const refused = await dragStart('', firstTab, { start: false, types: { 'application/x-conductor-pane': JSON.stringify({ tab: { id: 'foreign', kind: 'agent', title: 'Foreign' }, sourceGroupId: 'g', projectId: 'other-project', sessionId: 'other' }) } })
  const refusedShot = await snap('r1-refused')
  await dragFinish()
  assert.ok(refused.refused && !refused.lit, `refused: ${JSON.stringify(refused)}`)
  assert.ok(!(await tabsIn(first)).includes('foreign'), 'nothing moved')
  record('R1', 'PASS', refused, refusedShot)

  // ------------------------------------------------------------------ T2 projects view, mid-turn
  step('T2 projects view: a running tab row dropped on another workspace row')
  await view.locator(firstTab).click()
  await view.locator(`[data-clarity-row="${runner.id}"]`).waitFor({ timeout: 15_000 })
  const runnerItems = await items(runner.resourceId)
  const rowHover = await drag(`[data-clarity-row="${runner.id}"]`, `.sidebar-session-row[data-workspace-drop="${second.id}"]`)
  assert.ok(rowHover.accepted && rowHover.lit, `the workspace row takes the tab: ${JSON.stringify(rowHover)}`)
  await poll(async () => (await tabsIn(second.id)).includes(runner.id), { timeoutMs: 15_000, label: 'the running tab in the second workspace' })
  assert.equal(await phase(runner.resourceId, second.id), 'running', 'the turn is still running')
  assert.ok(await items(runner.resourceId) >= runnerItems, 'the same conversation')
  assert.ok((await onDisk(second.id)).includes(runner.id), 'on disk')
  record('T2', 'PASS', { phase: 'running', items: runnerItems }, await snap('t2-moved-mid-turn'))

  // ------------------------------------------------------------------ T3 a selection into a tab list
  step('T3 a sidebar selection dropped into another workspace\'s tab list')
  const secondName = workspaces.find(item => item.id === second.id).name
  await view.getByRole('button', { name: `List tabs in ${secondName}`, exact: true }).click()
  await view.locator(`.workspace-tab-tree[data-workspace-drop="${second.id}"] [data-clarity-row="${runner.id}"]`).waitFor({ timeout: 10_000 })
  await view.locator(`[data-clarity-row="${shells[0].id}"] .workspace-tab-select`).click()
  await view.locator(`[data-clarity-row="${shells[1].id}"] .workspace-tab-select`).click({ modifiers: ['Control'] })
  await view.locator('.workspace-selection-bar').waitFor({ timeout: 10_000 })
  const listHover = await drag(`[data-clarity-row="${shells[0].id}"]`, `.workspace-tab-tree[data-workspace-drop="${second.id}"]`)
  assert.ok(listHover.accepted && listHover.lit, `the tab list takes the selection: ${JSON.stringify(listHover)}`)
  await poll(async () => { const ids = await tabsIn(second.id); return shells.every(shell => ids.includes(shell.id)) }, { timeoutMs: 15_000, label: 'both shells in the second workspace' })
  const firstNow = await tabsIn(first)
  assert.ok(shells.every(shell => !firstNow.includes(shell.id)), 'the selection left the first workspace')
  record('T3', 'PASS', { moved: shells.length, hoverTitle: listHover.title }, await snap('t3-selection-moved'))

  // ------------------------------------------------------------------ P1 persistence
  step('P1 leaving the project and coming back keeps every move')
  await openProject({ name: 'elsewhere', git: true })
  await view.locator('.project-row').filter({ hasText: 'tab move' }).first().click()
  await view.locator('.project-row.active').filter({ hasText: 'tab move' }).first().waitFor({ timeout: 30_000 })
  inst.projectId = project.id
  const moved = [mover.id, runner.id, ...shells.map(shell => shell.id)]
  const secondAfter = await tabsIn(second.id), firstAfter = await tabsIn(first)
  assert.ok(moved.every(id => secondAfter.includes(id)) && moved.every(id => !firstAfter.includes(id)), `after reload: first=${firstAfter} second=${secondAfter}`)
  assert.equal(await items(mover.resourceId), moverItems)
  record('P1', 'PASS', { second: secondAfter.length, first: firstAfter.length }, await snap('p1-after-project-switch'))

  await call('agents.interrupt', { agentSessionId: runner.resourceId }, { workspaceId: second.id }).catch(() => undefined)
  assert.deepEqual(inst.errors, [], 'no renderer errors')
} catch (error) {
  await failed(error)
}
await finish()
