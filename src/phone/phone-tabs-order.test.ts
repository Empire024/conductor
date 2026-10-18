import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The phone's Tabs list as the real app.js draws it, in a minimal fake DOM: projects, workspaces
// and tabs keep the computer's order however their activity ticks, cards keep their elements
// across stream updates, and an out-of-order picture of the computer is dropped.
// scripts/smoke-phone-tabs-order.mjs checks the same in a real parked phone window.
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')

class Node {
  className = ''; tagName: string; hidden = false; disabled = false; value = ''; type = ''; dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}; children: Node[] = []; parentNode: Node | null = null; text = ''; scrollTop = 0
  listeners: Record<string, Array<() => unknown>> = {}; style: Record<string, unknown> = { setProperty: () => undefined }
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(' ') }
  set textContent(value: string) { this.text = String(value); this.children = [] }
  get firstChild(): Node | null { return this.children[0] || null }
  get lastChild(): Node | null { return this.children[this.children.length - 1] || null }
  get childNodes() { return this.children }
  get classList() { return {
    add: (name: string) => { this.className += ' ' + name },
    remove: (name: string) => { this.className = this.className.split(' ').filter(entry => entry !== name).join(' ') },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, on: boolean) => { this.className = this.className.split(' ').filter(entry => entry !== name).concat(on ? [name] : []).join(' ') }
  } }
  appendChild(node: Node) { if (node.parentNode) node.parentNode.removeChild(node); this.children.push(node); node.parentNode = this; return node }
  insertBefore(node: Node, before: Node | null) { if (!before) return this.appendChild(node); if (node.parentNode) node.parentNode.removeChild(node); this.children.splice(this.children.indexOf(before), 0, node); node.parentNode = this; return node }
  removeChild(node: Node) { this.children = this.children.filter(entry => entry !== node); node.parentNode = null; return node }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
  getAttribute(name: string) { return this.attributes[name] }
  addEventListener(name: string, fn: () => unknown) { (this.listeners[name] ||= []).push(fn) }
  click() { for (const fn of this.listeners.click ?? []) fn() }
  all(): Node[] { return this.children.flatMap(node => [node, ...node.all()]) }
  querySelectorAll(selector: string) { return this.all().filter(node => node.className.split(' ').includes(selector.slice(1))) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null }
}

const harness = () => {
  const location = { pathname: '/', search: '', origin: 'https://phone.test', hash: '#/tabs' }
  const history = { state: null, replaceState: () => undefined, pushState: () => undefined, back: () => undefined, go: () => undefined }
  const document = { documentElement: new Node('html'), createElement: (tag: string) => new Node(tag), createElementNS: (_: string, tag: string) => new Node(tag), activeElement: null, visibilityState: 'visible' }
  const storage = new Map<string, string>()
  const pending: Array<(value: unknown) => void> = []
  const fetch = () => new Promise(resolve => pending.push(resolve))
  const window: any = { location, history, navigator: {}, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, ConductorBoot: {}, document }
  let instrumented = source.replace('const render = () => {', 'const render = () => { if (window.__listOnly) { if (screen && screen.update) screen.update(currentRoute()); return }')
  instrumented = instrumented.replace(/  if \(document.readyState === 'loading'\)[\s\S]*?\n\}\)\(\)\s*$/, `
    window.test = { state, groupSessions, stalePhoneState, onStreamEvent, refreshPhoneState, open: () => { screen = sessionsScreen(currentRoute()); return screen } };
  })()`)
  window.__listOnly = true
  runInNewContext(instrumented, { window, document, navigator: window.navigator, fetch, setTimeout: () => 0, clearTimeout: () => undefined, AbortController, Intl, Date })
  window.test.state.token = 'paired'
  window.test.state.authReady = true
  window.test.state.filter = 'all'
  const answer = (body: unknown) => pending.shift()!({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  return { ...window.test, answer }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

const projects = [
  { id: 'p-conductor', name: 'conductor', machineId: 'local', workspaces: [{ id: 'w-c1', name: 'Workspace 1' }, { id: 'w-c2', name: 'Workspace 2' }] },
  { id: 'p-miron', name: 'miron rosin', machineId: 'local', workspaces: [{ id: 'w-m1', name: 'Workspace 1' }] }
]
const tab = (id: string, projectId: string, workspaceId: string, extra: Record<string, unknown> = {}) => {
  const project = projects.find(entry => entry.id === projectId)!
  return { id, title: 'Tab ' + id, projectId, projectName: project.name, workspaceId, workspaceName: project.workspaces.find(entry => entry.id === workspaceId)!.name, tabId: 'tab-' + id, provider: 'claude', model: 'opus', machineId: 'local', machineName: 'MAIN', state: 'working', phase: 'running', updatedAt: '2026-10-18T09:00:00.000Z', lastText: 'started', ...extra }
}
/* The computer's order: each workspace's tab order, the owner's project order. */
const sessions = (): Array<Record<string, unknown> & { id: string; projectId: string; tabId: string | null }> => [
  tab('wizard', 'p-conductor', 'w-c1'),
  tab('cw-1', 'p-conductor', 'w-c1', { controllerId: 'wizard' }),
  tab('cw-2', 'p-conductor', 'w-c1', { controllerId: 'wizard' }),
  tab('old-wizard', 'p-conductor', 'w-c1', { state: 'done', phase: 'idle' }),
  tab('notes', 'p-conductor', 'w-c2', { state: 'done', phase: 'idle' }),
  tab('miron-a', 'p-miron', 'w-m1'),
  tab('miron-b', 'p-miron', 'w-m1'),
  tab('history', 'p-miron', 'w-m1', { tabId: null, state: 'done', phase: 'idle' })
]
const snapshot = (revision: number, rows = sessions(), instance = 'run-1') => ({ observedAt: new Date().toISOString(), instance, revision, machineName: 'MAIN', projects, machines: [], providers: [], sessions: rows, usage: [], projectTaskMaxLength: 200000, counts: { attention: 0, working: 4 } })
/* Each update makes a different project's tab the most recently active one, as two busy projects do. */
const tick = (revision: number) => snapshot(revision, sessions().map((row, index) => index % 5 === revision % 5 || (row.projectId === 'p-miron') === (revision % 2 === 0)
  ? { ...row, updatedAt: new Date(Date.parse('2026-10-18T09:00:00.000Z') + revision * 1000).toISOString(), lastText: 'step ' + revision }
  : row))

const cards = (root: Node) => root.querySelectorAll('.session')
const order = (root: Node) => cards(root).map(card => card.dataset.sessionId)

describe('phone Tabs list order', () => {
  it('groups in the computer project, workspace and tab order, never by activity', () => {
    const api = harness()
    const rows = sessions()
    rows[6] = { ...rows[6]!, updatedAt: '2026-10-18T10:00:00.000Z' }
    rows[4] = { ...rows[4]!, updatedAt: '2026-10-18T11:00:00.000Z' }
    const stray = { ...tab('stray', 'p-miron', 'w-m1'), projectId: 'p-gone', projectName: 'gone', workspaceId: 'w-gone' }
    const groups = api.groupSessions([stray, ...rows.filter(row => row.tabId)], projects)
    expect(groups.map((group: any) => group.id)).toEqual(['p-conductor', 'p-miron', 'p-gone'])
    expect(groups[0].workspaces.map((workspace: any) => workspace.id)).toEqual(['w-c1', 'w-c2'])
    expect(groups[0].workspaces[0].entries.map((entry: any) => [entry.session.id, entry.coworkers.map((row: any) => row.id)])).toEqual([['wizard', ['cw-1', 'cw-2']], ['old-wizard', []]])
    expect(groups[1].workspaces[0].entries.map((entry: any) => entry.session.id)).toEqual(['miron-a', 'miron-b'])
  })

  it('keeps every card in place and the same element across 20 stream updates', () => {
    const api = harness()
    api.onStreamEvent('state', snapshot(1))
    const view = api.open()
    view.root.querySelector('.coworker-toggle')!.click()
    const first = order(view.root)
    expect(first).toEqual(['wizard', 'cw-1', 'cw-2', 'old-wizard', 'notes', 'miron-a', 'miron-b'])
    const elements = cards(view.root)
    const groups = view.root.querySelectorAll('.group').filter((node: Node) => node.dataset.projectId)
    for (let revision = 2; revision <= 21; revision++) {
      api.onStreamEvent('state', tick(revision))
      expect(order(view.root)).toEqual(first)
      expect(view.root.querySelectorAll('.group').filter((node: Node) => node.dataset.projectId).map((node: Node) => node.dataset.projectId)).toEqual(['p-conductor', 'p-miron'])
    }
    expect(cards(view.root)).toEqual(elements)
    expect(view.root.querySelectorAll('.group').filter((node: Node) => node.dataset.projectId)).toEqual(groups)
    expect(cards(view.root)[0]!.textContent).toContain('step 21')
  })

  it('needs-you only filters: it never reshuffles All', () => {
    const api = harness()
    api.onStreamEvent('state', snapshot(1))
    const view = api.open()
    const before = order(view.root)
    const rows = sessions()
    rows[6] = { ...rows[6]!, state: 'attention', phase: 'waiting_approval', pendingTitle: 'Approve?' }
    api.onStreamEvent('state', snapshot(2, rows))
    expect(order(view.root)).toEqual(before)
    api.state.filter = 'attention'
    view.update()
    expect(order(view.root)).toEqual(['miron-b'])
  })

  it('drops a stream frame or /api/state answer older than the picture on screen', async () => {
    const api = harness()
    expect(api.stalePhoneState(snapshot(5), snapshot(4))).toBe(true)
    expect(api.stalePhoneState(snapshot(5), snapshot(5))).toBe(true)
    expect(api.stalePhoneState(snapshot(5), snapshot(6))).toBe(false)
    expect(api.stalePhoneState(snapshot(5), snapshot(1, sessions(), 'run-2'))).toBe(false)
    expect(api.stalePhoneState({ ...snapshot(5), instance: undefined }, snapshot(1))).toBe(false)

    api.onStreamEvent('state', tick(6))
    api.onStreamEvent('state', tick(3))
    expect(api.state.phone.revision).toBe(6)

    // A read that started before the stream moved on, and answers after it, is not shown.
    const read = api.refreshPhoneState()
    api.answer(tick(4))
    await read
    await settle()
    expect(api.state.phone.revision).toBe(6)

    const newer = api.refreshPhoneState()
    api.answer(tick(7))
    await newer
    await settle()
    expect(api.state.phone.revision).toBe(7)

    // A restarted computer counts again from 1, under a new instance.
    api.onStreamEvent('state', snapshot(1, sessions(), 'run-2'))
    expect(api.state.phone.instance).toBe('run-2')
  })
})
