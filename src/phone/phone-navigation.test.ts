import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')

class Node {
  className = ''; tagName: string; hidden = false; disabled = false; value = ''; dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}; children: Node[] = []; parentNode: Node | null = null; text = ''
  listeners: Record<string, Array<() => unknown>> = {}; style = { setProperty: () => undefined }
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(' ') }
  set textContent(value: string) { this.text = String(value); this.children = [] }
  get firstChild(): Node | null { return this.children[0] || null }
  get childNodes() { return this.children }
  get classList() { return {
    add: (name: string) => { this.className += ' ' + name },
    toggle: (name: string, on: boolean) => { this.className = this.className.split(' ').filter(entry => entry !== name).concat(on ? [name] : []).join(' ') }
  } }
  appendChild(node: Node) { if (node.parentNode) node.parentNode.removeChild(node); this.children.push(node); node.parentNode = this; return node }
  insertBefore(node: Node, before: Node | null) { if (!before) return this.appendChild(node); if (node.parentNode) node.parentNode.removeChild(node); this.children.splice(this.children.indexOf(before), 0, node); node.parentNode = this; return node }
  removeChild(node: Node) { this.children = this.children.filter(entry => entry !== node); node.parentNode = null; return node }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
  addEventListener(name: string, fn: () => unknown) { (this.listeners[name] ||= []).push(fn) }
  async click() { for (const fn of this.listeners.click || []) await fn() }
  all(): Node[] { return this.children.flatMap(node => [node, ...node.all()]) }
  querySelectorAll(selector: string) { return this.all().filter(node => node.className.split(' ').includes(selector.slice(1))) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null }
}

const project = { id: 'project-a', name: 'Alpha', machineId: 'local', workspaces: [{ id: 'workspace-a', name: 'Alpha' }] }
const phone = () => ({ projects: [project], machines: [{ id: 'local', status: 'online', projectIds: [project.id], name: 'MAIN' }], sessions: [], providers: [
  { id: 'grok', available: true, models: [{ id: 'grok', label: 'Grok', isDefault: true }] },
  { id: 'claude', available: true, displayName: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true }, { id: 'opus', label: 'Claude Opus' }] },
  { id: 'codex', available: true, displayName: 'Codex', models: [{ id: 'sol', label: 'Sol', isDefault: true }] }
] })

const harness = (hash = '#/', respond: (path: string) => unknown = () => ({})) => {
  const stored = new Map<string, string>()
  const entries: Array<{ hash: string; state: any }> = [{ hash, state: null }]
  let index = 0, historyBackCalls = 0
  const root = new Node('div'), documentElement = new Node('html')
  const location = { pathname: '/', search: '', origin: 'https://phone.test', get hash() { return entries[index]!.hash }, set hash(value: string) { entries[index]!.hash = value } }
  const history = {
    get state() { return entries[index]!.state },
    replaceState: (state: unknown, _: string, url: string) => { entries[index] = { hash: url.slice(url.indexOf('#')), state } },
    pushState: (state: unknown, _: string, url: string) => { entries.splice(index + 1); entries.push({ hash: url.slice(url.indexOf('#')), state }); index++ },
    back: () => { historyBackCalls++; if (index > 0) index-- },
    go: (delta: number) => { index = Math.max(0, Math.min(entries.length - 1, index + delta)) }
  }
  const document = { documentElement, createElement: (tag: string) => new Node(tag), createElementNS: (_: string, tag: string) => new Node(tag), activeElement: null }
  const fetch = async (path: string) => {
    const data = await respond(path)
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  }
  const window: any = { location, history, navigator: {}, localStorage: { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value) }, ConductorBoot: {}, document }
  const instrumented = source.replace(/  if \(document.readyState === 'loading'\)[\s\S]*?\n\}\)\(\)\s*$/, `
    window.test = { state, currentRoute, seedNavigation, restoreNavigation, go, goBack, reconcileForm, sessionPhase, groupSessions, sessionRow, newTaskScreen, usageScreen, activityScreen, applyTheme,
      init: () => { appRoot = window.root; tabBar = buildTabBar(); state.token = 'paired'; },
      tabs: () => tabBar, updateTabBar, buildScreen };
  })()`)
  window.root = root
  runInNewContext(instrumented, { window, document, navigator: window.navigator, fetch, setTimeout: () => 0, clearTimeout: () => undefined, AbortController })
  const api = window.test
  api.init(); api.state.phone = phone()
  return { api, stored, entries, location, root, documentElement, history, historyBackCalls: () => historyBackCalls }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('phone navigation and task defaults', () => {
  it('seeds a direct link with Home and uses real Back without appending entries', () => {
    const page = harness('#/more')
    page.api.seedNavigation()
    expect(page.entries.map(row => row.hash)).toEqual(['#/', '#/', '#/more'])
    page.api.goBack()
    expect(page.location.hash).toBe('#/')
    expect(page.historyBackCalls()).toBe(1)
    expect(page.entries).toHaveLength(3)
  })
  it('replaces Home on a root Back instead of reaching an external page', () => {
    const page = harness()
    page.api.seedNavigation(); page.api.goBack()
    expect(page.entries).toHaveLength(2)
    expect(page.historyBackCalls()).toBe(0)
    page.history.back(); page.api.restoreNavigation()
    expect(page.history.state.conductorPhone.depth).toBe(0)
    expect(page.location.hash).toBe('#/')
  })
  it('preserves five destinations on paired detail screens and protects the lock', () => {
    const { api } = harness()
    expect(api.tabs().children.map((row: Node) => row.dataset.tab)).toEqual(['home', 'tabs', 'attention', 'new', 'more'])
    for (const name of ['session', 'terminal', 'idea', 'diagnose']) {
      api.updateTabBar({ name }); expect(api.tabs().hidden).toBe(false)
    }
    api.state.locked = true; api.updateTabBar({ name: 'lock' }); expect(api.tabs().hidden).toBe(true)
  })
  it('adopts fragment-link popstate before hashchange without losing the Home boundary', () => {
    const page = harness()
    page.api.seedNavigation()
    page.history.pushState(null, '', '/#/more')
    page.api.restoreNavigation()
    expect(page.history.state.conductorPhone).toEqual({ depth: 1, bounded: true })
    page.api.go('#/')
    expect(page.history.state.conductorPhone.depth).toBe(0)
  })
  it('keeps project filters bookmarkable', () => {
    const { api } = harness('#/tabs?project=project%20a')
    expect(api.currentRoute()).toMatchObject({ name: 'tabs', projectId: 'project a' })
  })
  it('defaults to Opus regardless of provider order or missing Grok quota', () => {
    const { api } = harness()
    api.reconcileForm()
    expect(api.state.form).toMatchObject({ provider: 'claude', model: 'opus' })
    api.state.form.prompt = 'Keep this draft'; api.reconcileForm()
    expect(api.state.form.prompt).toBe('Keep this draft')
  })
  it('restores the last successful choice, then uses Codex if Claude is unavailable', () => {
    const { api, stored } = harness()
    stored.set('conductor.phone.lastAgent', JSON.stringify({ provider: 'codex', model: 'sol' }))
    api.reconcileForm(); expect(api.state.form).toMatchObject({ provider: 'codex', model: 'sol' })
    stored.clear(); api.state.form = null; api.state.phone.providers = api.state.phone.providers.filter((row: any) => row.id !== 'claude')
    api.reconcileForm(); expect(api.state.form.provider).toBe('codex')
    api.state.form = null; api.state.phone.providers = api.state.phone.providers.filter((row: any) => row.id === 'grok')
    api.reconcileForm(); expect(api.state.form.provider).toBe('')
  })
  it('keeps a failed task draft and saves successful model selection only after acknowledgement', async () => {
    let fail = true
    const page = harness('#/new', () => { if (fail) throw new Error('Try again'); return {} })
    page.api.reconcileForm(); page.api.state.form.prompt = 'Build the fix'
    const view = page.api.newTaskScreen()
    await view.root.querySelector('.new-task-primary')!.click()
    expect(page.api.state.form.prompt).toBe('Build the fix')
    expect(page.stored.has('conductor.phone.lastAgent')).toBe(false)
    view.update(); expect(view.root.textContent).toContain('Try again')
    fail = false; await view.root.querySelector('.new-task-primary')!.click()
    expect(page.api.state.form.prompt).toBe('')
    expect(JSON.parse(page.stored.get('conductor.phone.lastAgent')!)).toEqual({ provider: 'claude', model: 'opus' })
  })
  it('shows project and phase on every row, and orders groups by newest activity', () => {
    const { api } = harness()
    const old = { id: 'old', projectId: 'a', projectName: 'Alpha', state: 'done', updatedAt: '2026-01-01T00:00:00Z' }
    const latest = { ...old, id: 'new', projectId: 'b', projectName: 'Beta', state: 'working', updatedAt: '2026-10-03T00:00:00Z' }
    expect(api.groupSessions([old, latest]).map((row: any) => row.id)).toEqual(['b', 'a'])
    const row = api.sessionRow(latest)
    expect(row.querySelector('.project-badge').textContent).toBe('Beta')
    expect(row.querySelector('.phase-badge').textContent).toBe('Running')
    expect(api.sessionPhase({ state: 'working', activity: 'waiting_background' }).label).toBe('Waiting')
  })
  it('renders expired quotas as unknown and Activity newest first', async () => {
    const page = harness('#/usage', path => path === '/api/usage' ? {
      providers: [{ provider: 'claude', windows: [{ label: 'Weekly', usedPercent: 15, state: 'reset', observedAt: '2026-01-01T00:00:00Z', resetsAt: null }], unknown: ['Short window unknown'] }], allowance: []
    } : { items: [{ id: 'old', title: 'Old action', at: '2026-01-01' }, { id: 'new', title: 'New action', at: '2026-10-03' }], hasMore: true })
    const usage = page.api.usageScreen(); await settle()
    expect(usage.root.textContent).toContain('Current use unknown')
    expect(usage.root.textContent).toContain('Reset time unknown')
    expect(usage.root.textContent).not.toContain('15% used')
    const activity = page.api.activityScreen(); await settle()
    expect(activity.root.querySelectorAll('.activity-card').map((row: Node) => row.textContent)).toEqual([expect.stringContaining('New action'), expect.stringContaining('Old action')])
  })
  it('stores System, Light, and Dark appearance choices', () => {
    const page = harness()
    page.api.applyTheme('light'); expect(page.documentElement.attributes['data-theme']).toBe('light')
    page.api.applyTheme('system'); expect(page.stored.get('conductor.phone.theme')).toBe('system')
  })
})
