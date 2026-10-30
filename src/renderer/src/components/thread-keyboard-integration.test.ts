import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadSummary, ThreadView } from '../../../shared/threads'

// There is no DOM or React client in this repo's node test environment, so this file runs the REAL ThreadList
// component function (and through it the real sidebarThreadView, the real thread-list refresh lifecycle and the
// real thread-keyboard registration) on a small hooks runtime. React is passed through untouched except while a
// `Mounted` render is active, so nothing here re-implements the production wiring: ThreadList decides the rows
// and calls the registration; the tests only supply window, document and the element tree's own handlers.
const runtime = vi.hoisted(() => ({ active: null as null | { useState(init: unknown): unknown; useRef(init: unknown): unknown; effect(kind: 'layout' | 'passive', fn: () => unknown, deps?: unknown[]): void } }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  const real = actual as unknown as Record<string, (...args: unknown[]) => unknown>
  return {
    ...actual,
    useState: (init: unknown) => runtime.active ? runtime.active.useState(init) : real.useState!(init),
    useRef: (init: unknown) => runtime.active ? runtime.active.useRef(init) : real.useRef!(init),
    useEffect: (fn: () => unknown, deps?: unknown[]) => runtime.active ? runtime.active.effect('passive', fn, deps) : real.useEffect!(fn, deps),
    useLayoutEffect: (fn: () => unknown, deps?: unknown[]) => runtime.active ? runtime.active.effect('layout', fn, deps) : real.useLayoutEffect!(fn, deps)
  }
})

import { ThreadList } from './ThreadList'

interface Slot { value?: unknown; set?: (next: unknown) => void; current?: unknown; deps?: unknown[]; cleanup?: unknown; ran?: boolean }
class Mounted<P> {
  hooks: Slot[] = []
  cursor = 0
  rendering = false
  dirty = false
  unmounted = false
  layout: Array<() => void> = []
  passive: Array<() => void> = []
  output: unknown
  constructor(readonly component: (props: P) => unknown, public props: P) { this.flush() }
  setProps(next: P): void { this.props = next; this.flush() }
  unmount(): void {
    this.unmounted = true
    for (const slot of this.hooks) if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)()
  }
  schedule(): void { if (this.unmounted) return; if (this.rendering) this.dirty = true; else this.flush() }
  flush(): void {
    this.rendering = true
    try {
      for (let pass = 0; pass < 25; pass += 1) {
        this.dirty = false; this.cursor = 0; this.layout = []; this.passive = []
        const before = runtime.active
        runtime.active = this
        try { this.output = this.component(this.props) } finally { runtime.active = before }
        for (const job of this.layout) job()
        for (const job of this.passive) job()
        if (!this.dirty) return
      }
      throw new Error('render did not settle')
    } finally { this.rendering = false }
  }
  slot(make: () => Slot): Slot { const at = this.cursor++; if (!this.hooks[at]) this.hooks[at] = make(); return this.hooks[at]! }
  useState(init: unknown): [unknown, (next: unknown) => void] {
    const slot = this.slot(() => {
      const made: Slot = { value: typeof init === 'function' ? (init as () => unknown)() : init }
      made.set = next => {
        const value = typeof next === 'function' ? (next as (v: unknown) => unknown)(made.value) : next
        if (Object.is(value, made.value)) return
        made.value = value
        this.schedule()
      }
      return made
    })
    return [slot.value, slot.set!]
  }
  useRef(init: unknown): { current: unknown } { return this.slot(() => ({ current: init })) as { current: unknown } }
  effect(kind: 'layout' | 'passive', fn: () => unknown, deps?: unknown[]): void {
    const slot = this.slot(() => ({ deps: undefined, cleanup: undefined, ran: false }))
    const changed = !slot.ran || !deps || !slot.deps || deps.some((dep, index) => !Object.is(dep, slot.deps![index]))
    if (!changed) return
    ;(kind === 'layout' ? this.layout : this.passive).push(() => {
      if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)()
      slot.ran = true; slot.deps = deps; slot.cleanup = fn()
    })
  }
}

interface El { type: unknown; props: Record<string, unknown> }
function elements(node: unknown, found: El[] = []): El[] {
  if (Array.isArray(node)) { for (const child of node) elements(child, found); return found }
  if (node && typeof node === 'object' && 'props' in node) {
    found.push(node as El)
    elements((node as El).props.children, found)
  }
  return found
}
const byClass = (mounted: { output: unknown }, className: string): El | undefined => elements(mounted.output).find(el => el.props.className === className)
const renderedIds = (mounted: { output: unknown }): string[] => elements(mounted.output).filter(el => el.type === 'button' && typeof el.props['data-thread-id'] === 'string').map(el => el.props['data-thread-id'] as string)
const call = (el: El | undefined, handler: string, ...args: unknown[]): void => {
  if (!el) throw new Error(`no element for ${handler}`)
  ;(el.props[handler] as (...a: unknown[]) => void)(...args)
}

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString()
const summary = (id: string, title: string, age: number, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title, projectId: `project-${id}`, projectName: `Project ${id}`, general: false, workspaceId: 'w', workspaceName: 'main', tabId: `tab-${id}`,
  provider: 'claude', machineName: '', state: 'working', needs: null, updatedAt: minutesAgo(age), ...over
})
const fixture = {
  threads: [] as ThreadSummary[],
  seed(): void {
    this.threads = [
      ...[1, 2, 3, 4, 5, 6].map(n => summary(`w${n}`, `Build w${n}`, n)),
      summary('w7', 'Review w7', 7),
      summary('s1', 'Build s1', 500, { state: 'done' })
    ]
  }
}
const viewFor = (query: string): ThreadView => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const threads = fixture.threads.filter(thread => words.every(word => thread.title.toLowerCase().includes(word)))
  return { generalProjectId: null, total: threads.length, hidden: 0, observedAt: new Date(NOW).toISOString(), groups: [{ bucket: 'working', label: 'Working', threads }] }
}

interface Listener { type: string; fn: (event: unknown) => void; options: unknown[] }
function installGlobals(initialCollapsed = false) {
  const listeners: Listener[] = []
  const pushes = new Set<() => void>()
  const storage = { collapsed: initialCollapsed ? 'true' : 'false' }
  const win = {
    innerWidth: 1280, innerHeight: 800,
    addEventListener: (type: string, fn: (event: unknown) => void, ...options: unknown[]) => { listeners.push({ type, fn, options }) },
    removeEventListener: (type: string, fn: (event: unknown) => void) => { const at = listeners.findIndex(entry => entry.type === type && entry.fn === fn); if (at >= 0) listeners.splice(at, 1) },
    conductor: { threads: { onChanged: (listener: () => void) => { pushes.add(listener); return () => { pushes.delete(listener) } }, list: vi.fn(async (query: string) => viewFor(query)) } }
  }
  const doc = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelector: vi.fn((_selector: string): unknown => null), body: { nodeType: 1 } }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('Element', class FakeElement {})
  vi.stubGlobal('localStorage', { getItem: () => storage.collapsed, setItem: (_key: string, value: string) => { storage.collapsed = value } })
  return {
    win, doc, listeners, pushes,
    count: (type = 'keydown'): number => listeners.filter(entry => entry.type === type).length,
    dispatch<E extends { type: string }>(event: E): E { for (const entry of [...listeners]) if (entry.type === event.type) entry.fn(event); return event }
  }
}

interface KeyInit { key?: string; code?: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; target?: unknown; repeat?: boolean }
function keydown(init: KeyInit = {}) {
  const event = {
    type: 'keydown', key: init.key ?? '', code: init.code ?? '', altKey: init.altKey ?? false, ctrlKey: init.ctrlKey ?? false, metaKey: false,
    shiftKey: init.shiftKey ?? false, repeat: init.repeat ?? false, isComposing: false, keyCode: 0, defaultPrevented: false, target: init.target ?? null,
    getModifierState: () => false,
    preventDefault: vi.fn(() => { event.defaultPrevented = true }),
    stopPropagation: vi.fn()
  }
  return event
}
const alt = (n: number, init: KeyInit = {}) => keydown({ key: String(n), code: `Digit${n}`, altKey: true, ...init })
const forward = () => keydown({ key: '}', code: 'BracketRight', altKey: true, shiftKey: true })
const backward = () => keydown({ key: '{', code: 'BracketLeft', altKey: true, shiftKey: true })
const consumed = (event: ReturnType<typeof keydown>): boolean => event.preventDefault.mock.calls.length + event.stopPropagation.mock.calls.length > 0

interface Callbacks { onOpenThread: ReturnType<typeof vi.fn>; onNewThread: ReturnType<typeof vi.fn>; onContinueInProject: ReturnType<typeof vi.fn>; onPromoteGeneral: ReturnType<typeof vi.fn> }

let env: ReturnType<typeof installGlobals>
let mounted: Mounted<Record<string, unknown>> | null = null
const inner = ThreadList as unknown as { type: (props: Record<string, unknown>) => unknown }

async function settle(ms = 0): Promise<void> {
  if (ms) await vi.advanceTimersByTimeAsync(ms)
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
}
async function mount(over: Record<string, unknown> = {}, callbacks: Partial<Callbacks> = {}) {
  const fns: Callbacks = {
    onOpenThread: vi.fn(), onNewThread: vi.fn(), onContinueInProject: vi.fn(), onPromoteGeneral: vi.fn(async () => undefined), ...callbacks
  }
  const base = { projects: [], refreshKey: '1', visible: true, activeAgentSessionId: null, ...fns, ...over }
  const next = new Mounted(inner.type, base as Record<string, unknown>)
  mounted = next
  await settle()
  return {
    fns, mounted: next,
    set: async (patch: Record<string, unknown>) => { next.setProps({ ...next.props, ...patch }); await settle() },
    older: async () => { call(byClass(next, 'threads-older'), 'onClick'); await settle() },
    search: async (value: string) => { call(byClass(next, 'threads-search'), 'onChange', { target: { value } }); await settle() },
    toggle: async () => { call(byClass(next, 'threads-toggle'), 'onClick'); await settle() },
    rendered: () => renderedIds(next),
    press: (event: ReturnType<typeof keydown>) => env.dispatch(event),
    opened: () => fns.onOpenThread.mock.calls.map(args => (args[0] as ThreadSummary).id)
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  fixture.seed()
  env = installGlobals()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ThreadList registers the production thread keyboard', () => {
  it('registers exactly one bubble-phase keydown listener, keeps it through refreshes and removes it on unmount', async () => {
    const list = await mount()
    expect(env.count()).toBe(1)
    expect(env.listeners.find(entry => entry.type === 'keydown')!.options.filter(option => option === true || (typeof option === 'object' && option !== null && (option as { capture?: boolean }).capture))).toEqual([])
    await list.set({ activeAgentSessionId: 'w2' })
    await list.set({ refreshKey: '2' }); await settle(600)
    await list.older(); await list.search('build'); await list.older()
    expect(env.count()).toBe(1)
    list.mounted.unmount()
    expect(env.count()).toBe(0)
  })

  it('is inert before the first view arrives', async () => {
    let release: (view: ThreadView) => void = () => undefined
    env.win.conductor.threads.list.mockImplementationOnce(() => new Promise<ThreadView>(resolve => { release = resolve }))
    const list = await mount()
    expect(list.rendered()).toEqual([])
    expect(consumed(list.press(alt(1)))).toBe(false)
    expect(consumed(list.press(forward()))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
    release(viewFor(''))
    await settle()
    list.press(alt(1))
    expect(list.opened()).toEqual(['w1'])
  })

  it('opens the rendered row through the existing onOpenThread, once, with the thread itself', async () => {
    const list = await mount()
    expect(list.rendered()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    const event = list.press(alt(2))
    expect(list.fns.onOpenThread).toHaveBeenCalledTimes(1)
    const opened = list.fns.onOpenThread.mock.calls[0]![0] as ThreadSummary
    expect(opened).toEqual(fixture.threads.find(thread => thread.id === 'w2'))
    // cross-project navigation stays the callback's job: the thread's own project travels with it
    expect(opened.projectId).toBe('project-w2')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(list.fns.onNewThread).not.toHaveBeenCalled()
    expect(list.fns.onContinueInProject).not.toHaveBeenCalled()
    expect(list.fns.onPromoteGeneral).not.toHaveBeenCalled()
  })

  it('selects the same row a click would open', async () => {
    const list = await mount()
    call(elements(list.mounted.output).find(el => el.props['data-thread-id'] === 'w3'), 'onClick')
    list.press(alt(3))
    expect(list.opened()).toEqual(['w3', 'w3'])
    expect(list.fns.onOpenThread.mock.calls[1]![0]).toBe(list.fns.onOpenThread.mock.calls[0]![0])
  })

  it('is off unless the sidebar says it is visible in workspace mode', async () => {
    const list = await mount({ visible: undefined })
    expect(consumed(list.press(alt(1)))).toBe(false)
    await list.set({ visible: false })
    expect(consumed(list.press(alt(1)))).toBe(false)
    expect(consumed(list.press(forward()))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
    await list.set({ visible: true })
    list.press(alt(1))
    expect(list.opened()).toEqual(['w1'])
    await list.set({ visible: false })
    list.press(alt(2))
    expect(list.opened()).toEqual(['w1'])
  })
})

describe('rows follow what ThreadList renders', () => {
  it('leaves Older out until it is expanded, then appends it in rendered order', async () => {
    const list = await mount()
    expect(consumed(list.press(alt(6)))).toBe(false)
    await list.older()
    expect(list.rendered()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 's1'])
    for (let digit = 1; digit <= 8; digit += 1) list.press(alt(digit))
    expect(list.opened()).toEqual(list.rendered())
    expect(consumed(list.press(alt(9)))).toBe(false)
    await list.older()
    expect(list.rendered()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(consumed(list.press(alt(6)))).toBe(false)
    expect(list.opened()).toHaveLength(8)
  })

  it('never expands Older or reads history on its own', async () => {
    const list = await mount()
    const reads = env.win.conductor.threads.list.mock.calls.length
    list.press(alt(9)); list.press(forward()); list.press(backward())
    await settle(1000)
    expect(list.rendered()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(env.win.conductor.threads.list.mock.calls.length).toBe(reads)
  })

  it('applies the current search query to the keyboard rows', async () => {
    const list = await mount()
    await list.older()
    await list.search('review')
    expect(env.win.conductor.threads.list).toHaveBeenLastCalledWith('review')
    expect(list.rendered()).toEqual(['w7'])
    expect(consumed(list.press(alt(2)))).toBe(false)
    list.press(alt(1))
    expect(list.opened()).toEqual(['w7'])
    await list.search('nothing matches')
    expect(list.rendered()).toEqual([])
    expect(consumed(list.press(alt(1)))).toBe(false)
    await list.search('build')
    expect(list.rendered()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 's1'])
    list.press(alt(7))
    expect(list.opened()).toEqual(['w7', 's1'])
    await list.older()
    expect(list.rendered()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(consumed(list.press(alt(6)))).toBe(false)
  })

  it('has no targets while the Threads section is collapsed, and recovers when it opens', async () => {
    const list = await mount()
    await list.toggle()
    expect(list.rendered()).toEqual([])
    for (const event of [alt(1), forward(), backward()]) expect(consumed(list.press(event))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
    await list.toggle()
    list.press(alt(1))
    expect(list.opened()).toEqual(['w1'])
  })

  it('starts collapsed windows with no targets', async () => {
    vi.unstubAllGlobals()
    env = installGlobals(true)
    const list = await mount()
    expect(consumed(list.press(alt(1)))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
  })

  it('resolves against rows refreshed and reordered after mount', async () => {
    const list = await mount()
    list.press(alt(1))
    expect(list.opened()).toEqual(['w1'])
    fixture.threads = [summary('z9', 'Build z9', 0), ...fixture.threads]
    for (const push of [...env.pushes]) push()
    await settle(600)
    expect(list.rendered()).toEqual(['z9', 'w1', 'w2', 'w3', 'w4'])
    list.press(alt(1))
    list.press(alt(2))
    expect(list.opened()).toEqual(['w1', 'z9', 'w1'])
  })

  it('drops a thread that left the list, and a stale active id restarts the cycle', async () => {
    const list = await mount({ activeAgentSessionId: 'w2' })
    fixture.threads = fixture.threads.filter(thread => thread.id !== 'w2')
    await list.set({ refreshKey: '2' }); await settle(600)
    expect(list.rendered()).toEqual(['w1', 'w3', 'w4', 'w5', 'w6'])
    list.press(forward())
    list.press(backward())
    expect(list.opened()).toEqual(['w1', 'w6'])
  })
})

describe('active thread and rapid presses', () => {
  it('cycles from the current active thread, forward and backward, wrapping', async () => {
    const list = await mount({ activeAgentSessionId: 'w5' })
    list.press(forward())
    expect(list.opened()).toEqual(['w1'])
    await list.set({ activeAgentSessionId: 'w1' })
    list.press(backward())
    expect(list.opened()).toEqual(['w1', 'w5'])
    await list.set({ activeAgentSessionId: 'w3' })
    list.press(forward())
    expect(list.opened()).toEqual(['w1', 'w5', 'w4'])
  })

  it('treats an absent or null active id as nothing active, in both directions', async () => {
    for (const activeAgentSessionId of [undefined, null, 'not-listed']) {
      mounted?.unmount(); env.listeners.length = 0
      const list = await mount({ activeAgentSessionId })
      list.press(forward()); list.press(backward())
      expect(list.opened()).toEqual(['w1', 'w5'])
    }
  })

  it('ignores the already-active row and a single remaining row', async () => {
    const list = await mount({ activeAgentSessionId: 'w2' })
    expect(consumed(list.press(alt(2)))).toBe(false)
    fixture.threads = [summary('only', 'Build only', 1)]
    await list.set({ refreshKey: '2', activeAgentSessionId: 'only' }); await settle(600)
    expect(list.rendered()).toEqual(['only'])
    expect(consumed(list.press(forward()))).toBe(false)
    expect(consumed(list.press(backward()))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
  })

  it('resolves rapid different presses against the thread just focused, then the real active prop', async () => {
    const list = await mount({ activeAgentSessionId: 'w1' })
    list.press(forward())
    list.press(forward())
    list.press(forward())
    expect(list.opened()).toEqual(['w2', 'w3', 'w4'])
    await list.set({ activeAgentSessionId: 'w4' })
    list.press(backward())
    expect(list.opened()).toEqual(['w2', 'w3', 'w4', 'w3'])
  })

  it('does not open the same thread twice when the same digit is pressed again before focus follows', async () => {
    const list = await mount({ activeAgentSessionId: 'w1' })
    list.press(alt(3))
    const second = list.press(alt(3))
    expect(list.opened()).toEqual(['w3'])
    expect(consumed(second)).toBe(false)
  })
})

describe('events the keyboard must leave alone', () => {
  it('rejects wrong modifiers, repeats and non-digit keys on a Digit code', async () => {
    const list = await mount()
    for (const event of [
      alt(2, { ctrlKey: true }), alt(2, { shiftKey: true }), alt(2, { repeat: true }), keydown({ key: '2', code: 'Digit2' }),
      keydown({ key: '@', code: 'Digit2', altKey: true }), alt(9), alt(7)
    ]) expect(consumed(list.press(event))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
  })

  const fakeNode = (tag: string, over: { attrs?: Record<string, string>; classes?: string[]; parent?: unknown } = {}) => ({
    tagName: tag.toUpperCase(), parentElement: over.parent ?? null,
    getAttribute: (name: string) => over.attrs?.[name] ?? null,
    classList: { contains: (name: string) => (over.classes ?? []).includes(name) }
  })

  it('rejects the search box, a Monaco editor and an xterm terminal, by descendant', async () => {
    const list = await mount()
    await list.older()
    const owners = [
      fakeNode('input', { attrs: { type: 'search' } }),
      fakeNode('div', { parent: fakeNode('div', { classes: ['monaco-editor'] }) }),
      fakeNode('div', { parent: fakeNode('section', { parent: fakeNode('div', { classes: ['xterm'] }) }) })
    ]
    for (const target of owners) expect(consumed(list.press(alt(2, { target })))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
    list.press(alt(2, { target: fakeNode('button', { parent: fakeNode('section', { classes: ['threads-section'] }) }) }))
    expect(list.opened()).toEqual(['w2'])
  })

  it('rejects while the document has an open modal, and again accepts when it closes', async () => {
    const list = await mount()
    env.doc.querySelector.mockImplementation(() => ({}))
    expect(consumed(list.press(alt(2)))).toBe(false)
    expect(env.doc.querySelector).toHaveBeenCalled()
    env.doc.querySelector.mockImplementation(() => null)
    list.press(alt(2))
    expect(list.opened()).toEqual(['w2'])
  })

  it('belongs to the thread context menu while it is open, and returns when it closes', async () => {
    const list = await mount()
    const row = elements(list.mounted.output).find(el => el.props['data-thread-id'] === 'w1')
    call(row, 'onContextMenu', { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 40, clientY: 40 })
    await settle()
    expect(env.count()).toBe(2) // the list's own plus the open menu's Escape handler
    expect(consumed(list.press(alt(2)))).toBe(false)
    expect(consumed(list.press(forward()))).toBe(false)
    expect(list.fns.onOpenThread).not.toHaveBeenCalled()
    env.dispatch({ type: 'mousedown', target: {} })
    await settle()
    list.press(alt(2))
    expect(list.opened()).toEqual(['w2'])
  })

  it('also returns after Escape closes the menu', async () => {
    const list = await mount()
    const row = elements(list.mounted.output).find(el => el.props['data-thread-id'] === 'w1')
    call(row, 'onContextMenu', { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 40, clientY: 40 })
    await settle()
    expect(consumed(list.press(alt(3)))).toBe(false)
    env.dispatch({ type: 'keydown', key: 'Escape' })
    await settle()
    list.press(alt(3))
    expect(list.opened()).toEqual(['w3'])
  })
})
