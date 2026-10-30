import { describe, expect, it, vi } from 'vitest'
import type { ThreadSummary, ThreadView } from '../../../shared/threads'
import { sidebarThreadView } from './sidebar-thread-view'
import {
  registerThreadKeyboard, threadKeyboardIntent, threadKeyboardRows,
  type ThreadKeyboardEnvironment, type ThreadKeyboardState
} from './thread-keyboard'

const thread = (id: string, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title: `Thread ${id}`, projectId: 'p1', projectName: 'Project', general: false, workspaceId: 'w1', workspaceName: 'main',
  tabId: `tab-${id}`, provider: 'claude', machineName: '', state: 'working', needs: null, updatedAt: '2026-10-30T10:00:00.000Z', ...over
})
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
const rows = (list: string[] = ids): ThreadSummary[] => list.map(id => thread(id))

interface FakeNode {
  tagName: string
  parentElement: FakeNode | null
  isContentEditable?: boolean
  getAttribute(name: string): string | null
  classList: { contains(name: string): boolean }
}
function node(tag: string, over: { attrs?: Record<string, string>; classes?: string[]; parent?: FakeNode | null; contentEditable?: boolean } = {}): FakeNode {
  return {
    tagName: tag.toUpperCase(), parentElement: over.parent ?? null, isContentEditable: over.contentEditable,
    getAttribute: name => over.attrs?.[name] ?? null,
    classList: { contains: name => (over.classes ?? []).includes(name) }
  }
}

interface KeyInit {
  key?: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean
  repeat?: boolean; isComposing?: boolean; keyCode?: number; altGraph?: boolean; defaultPrevented?: boolean
  target?: FakeNode | null; path?: FakeNode[]
}
interface FakeKeyEvent {
  type: 'keydown'; key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean
  repeat: boolean; isComposing: boolean; keyCode: number; defaultPrevented: boolean; target: FakeNode | null
  composedPath?: () => FakeNode[]
  getModifierState(name: string): boolean
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
}
function keydown(init: KeyInit = {}): FakeKeyEvent {
  const event: FakeKeyEvent = {
    type: 'keydown', key: init.key ?? '', code: init.code ?? '', altKey: init.altKey ?? false, ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false, shiftKey: init.shiftKey ?? false, repeat: init.repeat ?? false, isComposing: init.isComposing ?? false,
    keyCode: init.keyCode ?? 0, defaultPrevented: init.defaultPrevented ?? false, target: init.target ?? null,
    getModifierState: name => name === 'AltGraph' && Boolean(init.altGraph),
    preventDefault: vi.fn(() => { event.defaultPrevented = true }),
    stopPropagation: vi.fn()
  }
  if (init.path) event.composedPath = () => init.path!
  return event
}
const alt = (n: number, over: KeyInit = {}): FakeKeyEvent => keydown({ key: String(n), code: `Digit${n}`, altKey: true, ...over })
const next = (over: KeyInit = {}): FakeKeyEvent => keydown({ key: '}', code: 'BracketRight', altKey: true, shiftKey: true, ...over })
const previous = (over: KeyInit = {}): FakeKeyEvent => keydown({ key: '{', code: 'BracketLeft', altKey: true, shiftKey: true, ...over })

function fakeWindow() {
  const listeners: Array<{ type: string; fn: (event: FakeKeyEvent) => void; options: unknown[] }> = []
  return {
    addEventListener: vi.fn((type: string, fn: (event: FakeKeyEvent) => void, ...options: unknown[]) => { listeners.push({ type, fn, options }) }),
    removeEventListener: vi.fn((type: string, fn: (event: FakeKeyEvent) => void) => {
      const at = listeners.findIndex(entry => entry.type === type && entry.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    }),
    count: (type = 'keydown'): number => listeners.filter(entry => entry.type === type).length,
    listeners,
    dispatch(event: FakeKeyEvent): FakeKeyEvent { for (const entry of [...listeners]) if (entry.type === event.type) entry.fn(event); return event }
  }
}

function setup(over: Partial<ThreadKeyboardState> = {}) {
  const win = fakeWindow()
  const onOpenThread = vi.fn<(thread: ThreadSummary) => void>()
  const control = { modal: false, clock: 1000 }
  const environment: ThreadKeyboardEnvironment = { target: win as unknown as ThreadKeyboardEnvironment['target'], ownsKeyboard: () => control.modal, now: () => control.clock }
  const state: ThreadKeyboardState = { rows: rows(), activeThreadId: 'c', visible: true, menuOpen: false, onOpenThread, ...over }
  const handle = registerThreadKeyboard(environment, state)
  const press = (event: FakeKeyEvent): FakeKeyEvent => win.dispatch(event)
  const opened = (): string[] => onOpenThread.mock.calls.map(call => call[0].id)
  return { win, handle, state, press, opened, onOpenThread, control }
}
const consumed = (event: FakeKeyEvent): boolean => event.preventDefault.mock.calls.length > 0 || event.stopPropagation.mock.calls.length > 0

describe('thread keyboard: Alt+digit', () => {
  it.each(ids.slice(0, 9).map((id, index) => [index + 1, id]))('Alt+%i selects the %i-th rendered row (%s)', (digit, id) => {
    const harness = setup({ activeThreadId: 'j' })
    const event = harness.press(alt(Number(digit)))
    expect(harness.opened()).toEqual([id])
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('Alt+9 is the ninth row, not the tenth', () => {
    const harness = setup({ activeThreadId: 'a' })
    harness.press(alt(9))
    expect(harness.opened()).toEqual(['i'])
  })

  it('hands the whole row to the existing callback exactly once', () => {
    const harness = setup()
    harness.press(alt(2))
    expect(harness.onOpenThread).toHaveBeenCalledTimes(1)
    expect(harness.onOpenThread.mock.calls[0]![0]).toBe(harness.state.rows[1])
  })

  it.each([
    ['Ctrl+Alt', { ctrlKey: true }], ['Meta+Alt', { metaKey: true }], ['Shift+Alt', { shiftKey: true }],
    ['Ctrl+Meta+Alt', { ctrlKey: true, metaKey: true }]
  ])('rejects %s with a digit', (_name, over) => {
    const harness = setup()
    const event = harness.press(alt(2, over))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(consumed(event)).toBe(false)
  })

  it('rejects the digit without Alt', () => {
    const harness = setup()
    const event = harness.press(keydown({ key: '2', code: 'Digit2' }))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(consumed(event)).toBe(false)
  })

  it.each(['¡', '@', 'a', '0', '10', 'Dead', ''])('matches the produced key, so key %j on a Digit code is ignored', key => {
    const harness = setup()
    const event = harness.press(keydown({ key, code: 'Digit2', altKey: true }))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(consumed(event)).toBe(false)
  })

  it('selects by the produced digit even when the physical code is another key (AZERTY-style layouts)', () => {
    const harness = setup()
    harness.press(keydown({ key: '3', code: 'KeyZ', altKey: true }))
    expect(harness.opened()).toEqual([]) // key "3" is the already-active third row
    harness.press(keydown({ key: '4', code: 'KeyZ', altKey: true }))
    expect(harness.opened()).toEqual(['d'])
  })

  it('leaves an out-of-range digit unhandled and unconsumed', () => {
    const harness = setup({ rows: rows(['a', 'b', 'c']), activeThreadId: 'a' })
    const event = harness.press(alt(5))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(consumed(event)).toBe(false)
  })

  it('is a silent no-op when the digit names the already-active row', () => {
    const harness = setup({ activeThreadId: 'c' })
    const event = harness.press(alt(3))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(consumed(event)).toBe(false)
  })

  it('treats an absent, null or filtered-out active id as nothing active for a digit', () => {
    for (const activeThreadId of [undefined, null, 'not-in-the-rows']) {
      const harness = setup({ activeThreadId })
      harness.press(alt(1))
      expect(harness.opened()).toEqual(['a'])
    }
  })
})

describe('thread keyboard: Alt+Shift+bracket cycling', () => {
  it('moves forward on the physical BracketRight code even though the produced key is "}"', () => {
    const harness = setup({ activeThreadId: 'c' })
    const event = harness.press(next())
    expect(harness.opened()).toEqual(['d'])
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('moves backward on the physical BracketLeft code even though the produced key is "{"', () => {
    const harness = setup({ activeThreadId: 'c' })
    harness.press(previous())
    expect(harness.opened()).toEqual(['b'])
  })

  it('does not care what key the bracket produces, only the code', () => {
    const up = setup({ activeThreadId: 'c' })
    up.press(keydown({ key: 'ü', code: 'BracketRight', altKey: true, shiftKey: true }))
    const down = setup({ activeThreadId: 'c' })
    down.press(keydown({ key: '¨', code: 'BracketLeft', altKey: true, shiftKey: true }))
    expect([...up.opened(), ...down.opened()]).toEqual(['d', 'b'])
  })

  it('ignores brackets identified only by key, with the wrong or no code', () => {
    const harness = setup()
    for (const event of [
      keydown({ key: '}', code: 'KeyX', altKey: true, shiftKey: true }),
      keydown({ key: ']', code: '', altKey: true, shiftKey: true }),
      keydown({ key: '{', code: 'Digit9', altKey: true, shiftKey: true })
    ]) expect(consumed(harness.press(event))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it.each([
    ['Ctrl', { ctrlKey: true }], ['Meta', { metaKey: true }], ['Ctrl+Meta', { ctrlKey: true, metaKey: true }]
  ])('rejects %s on top of Alt+Shift', (_name, over) => {
    const harness = setup()
    expect(consumed(harness.press(next(over)))).toBe(false)
    expect(consumed(harness.press(previous(over)))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('requires both Alt and Shift', () => {
    const harness = setup()
    expect(consumed(harness.press(keydown({ key: ']', code: 'BracketRight', altKey: true })))).toBe(false)
    expect(consumed(harness.press(keydown({ key: '}', code: 'BracketRight', shiftKey: true })))).toBe(false)
    expect(consumed(harness.press(keydown({ key: ']', code: 'BracketRight' })))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('wraps in both directions', () => {
    const forward = setup({ activeThreadId: 'j' })
    forward.press(next())
    expect(forward.opened()).toEqual(['a'])
    const backward = setup({ activeThreadId: 'a' })
    backward.press(previous())
    expect(backward.opened()).toEqual(['j'])
  })

  it.each([undefined, null, 'filtered-away'])('with active id %j, forward is the first row and backward the last', activeThreadId => {
    const forward = setup({ activeThreadId })
    forward.press(next())
    expect(forward.opened()).toEqual(['a'])
    const backward = setup({ activeThreadId })
    backward.press(previous())
    expect(backward.opened()).toEqual(['j'])
  })

  it('is a no-op, unconsumed, for a single row that is already active', () => {
    const harness = setup({ rows: rows(['a']), activeThreadId: 'a' })
    expect(consumed(harness.press(next()))).toBe(false)
    expect(consumed(harness.press(previous()))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('selects the only row when it is not the active one', () => {
    const harness = setup({ rows: rows(['a']), activeThreadId: 'elsewhere' })
    harness.press(next())
    expect(harness.opened()).toEqual(['a'])
  })

  it('cycles through exactly the supplied order, one step per press', () => {
    const harness = setup({ rows: rows(['x', 'y', 'z']), activeThreadId: 'x' })
    let active = 'x'
    const seen: string[] = []
    for (let step = 0; step < 4; step += 1) {
      harness.onOpenThread.mockClear()
      harness.handle.update({ ...harness.state, rows: rows(['x', 'y', 'z']), activeThreadId: active })
      harness.press(next())
      active = harness.opened()[0]!
      seen.push(active)
    }
    expect(seen).toEqual(['y', 'z', 'x', 'y'])
  })
})

describe('thread keyboard: rejected events', () => {
  it.each([
    ['defaultPrevented', { defaultPrevented: true }], ['repeat', { repeat: true }], ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }], ['AltGraph state', { altGraph: true }]
  ])('rejects an event that is %s', (_name, over) => {
    const harness = setup()
    const digit = harness.press(alt(2, over))
    const forward = harness.press(next(over))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(digit.stopPropagation).not.toHaveBeenCalled()
    expect(forward.stopPropagation).not.toHaveBeenCalled()
  })

  it('rejects Ctrl+Alt (how Windows reports AltGr) for digits and brackets alike', () => {
    const harness = setup()
    harness.press(alt(2, { ctrlKey: true }))
    harness.press(next({ ctrlKey: true }))
    harness.press(previous({ ctrlKey: true }))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('does not call preventDefault on an event that was already prevented', () => {
    const harness = setup()
    const event = harness.press(alt(2, { defaultPrevented: true }))
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  const editors: Array<[string, () => FakeNode]> = [
    ['input', () => node('input')], ['textarea', () => node('textarea')], ['select', () => node('select')],
    ['contenteditable="true"', () => node('div', { attrs: { contenteditable: 'true' } })],
    ['contenteditable=""', () => node('div', { attrs: { contenteditable: '' } })],
    ['contenteditable="plaintext-only"', () => node('div', { attrs: { contenteditable: 'plaintext-only' } })],
    ['isContentEditable', () => node('div', { contentEditable: true })],
    ['role=textbox', () => node('div', { attrs: { role: 'textbox' } })],
    ['monaco-editor', () => node('div', { classes: ['monaco-editor'] })],
    ['xterm', () => node('div', { classes: ['xterm'] })]
  ]
  it.each(editors)('rejects a %s target', (_name, build) => {
    const harness = setup()
    for (const event of [alt(2, { target: build() }), next({ target: build() }), previous({ target: build() })]) {
      expect(consumed(harness.press(event))).toBe(false)
    }
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it.each(editors)('rejects a descendant of a %s (parent chain, no composedPath)', (_name, build) => {
    const harness = setup()
    const leaf = node('span', { parent: node('div', { parent: build() }) })
    expect(consumed(harness.press(alt(2, { target: leaf })))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it.each(editors)('rejects a %s found only on the composedPath (shadow DOM)', (_name, build) => {
    const harness = setup()
    const leaf = node('span')
    expect(consumed(harness.press(alt(2, { target: leaf, path: [leaf, build(), node('body')] })))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('does not treat contenteditable="false" or an ordinary button as an editor', () => {
    const harness = setup()
    harness.press(alt(1, { target: node('div', { attrs: { contenteditable: 'false' } }) }))
    harness.press(alt(2, { target: node('button', { parent: node('section', { classes: ['threads-section'] }) }) }))
    harness.press(alt(4, { target: node('body'), path: [node('body'), node('html')] }))
    expect(harness.opened()).toEqual(['a', 'b', 'd'])
  })

  it('rejects when the target sits inside a modal or alert dialog', () => {
    const harness = setup()
    for (const owner of [
      node('section', { attrs: { role: 'dialog' } }), node('section', { attrs: { role: 'alertdialog' } }),
      node('section', { attrs: { 'aria-modal': 'true' } }), node('dialog')
    ]) expect(consumed(harness.press(alt(2, { target: node('button', { parent: owner }) })))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('rejects when the thread context menu is the target or an ancestor', () => {
    const harness = setup()
    const menu = node('div', { classes: ['thread-menu'] })
    expect(consumed(harness.press(alt(2, { target: node('button', { parent: menu }) })))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('rejects while the document reports an open modal, and recovers when it closes', () => {
    const harness = setup()
    harness.control.modal = true
    expect(consumed(harness.press(alt(2)))).toBe(false)
    harness.control.modal = false
    harness.press(alt(2))
    expect(harness.opened()).toEqual(['b'])
  })

  it('rejects while the list itself has its thread menu open', () => {
    const harness = setup({ menuOpen: true })
    expect(consumed(harness.press(alt(2)))).toBe(false)
    harness.handle.update({ ...harness.state, menuOpen: false })
    harness.press(alt(2))
    expect(harness.opened()).toEqual(['b'])
  })
})

describe('thread keyboard: no targets', () => {
  it.each([
    ['the sidebar is hidden, collapsed or not in workspace mode', { visible: false }],
    ['there are no rows', { rows: [] }]
  ])('does nothing when %s', (_name, over) => {
    const harness = setup(over)
    for (const event of [alt(1), alt(2), next(), previous()]) expect(consumed(harness.press(event))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('starts working again as soon as the list becomes visible', () => {
    const harness = setup({ visible: false })
    harness.press(alt(1))
    harness.handle.update({ ...harness.state, visible: true })
    harness.press(alt(1))
    expect(harness.opened()).toEqual(['a'])
  })
})

describe('thread keyboard: bubble listener, consumption and cleanup', () => {
  it('registers one bubble-phase keydown listener, however often the state is refreshed', () => {
    const harness = setup()
    expect(harness.win.count()).toBe(1)
    expect(harness.win.addEventListener).toHaveBeenCalledTimes(1)
    expect(harness.win.listeners[0]!.options.filter(option => option === true || (typeof option === 'object' && option !== null && (option as { capture?: boolean }).capture))).toEqual([])
    for (let round = 0; round < 5; round += 1) harness.handle.update({ ...harness.state, activeThreadId: ids[round]! })
    expect(harness.win.count()).toBe(1)
    expect(harness.win.addEventListener).toHaveBeenCalledTimes(1)
  })

  it('removes exactly that listener on dispose, idempotently, and then ignores keys and updates', () => {
    const harness = setup()
    harness.handle.dispose()
    harness.handle.dispose()
    expect(harness.win.count()).toBe(0)
    expect(harness.win.removeEventListener).toHaveBeenCalledTimes(1)
    harness.handle.update(harness.state)
    expect(consumed(harness.press(alt(2)))).toBe(false)
    expect(harness.onOpenThread).not.toHaveBeenCalled()
  })

  it('leaves other listeners on the target alone', () => {
    const win = fakeWindow()
    const other = vi.fn()
    win.addEventListener('keydown', other)
    const handle = registerThreadKeyboard({ target: win as unknown as ThreadKeyboardEnvironment['target'], ownsKeyboard: () => false, now: () => 0 })
    handle.dispose()
    expect(win.count()).toBe(1)
    win.dispatch(alt(2))
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('consumes only a valid, changed selection', () => {
    const harness = setup({ activeThreadId: 'c' })
    const rejected = [
      harness.press(alt(3)), harness.press(alt(9, { ctrlKey: true })), harness.press(alt(2, { repeat: true })),
      harness.press(alt(2, { target: node('input') })), harness.press(keydown({ key: 'x', altKey: true })), harness.press(alt(1, { isComposing: true }))
    ]
    expect(rejected.map(consumed)).toEqual([false, false, false, false, false, false])
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    const accepted = harness.press(alt(1))
    expect(consumed(accepted)).toBe(true)
    expect(harness.opened()).toEqual(['a'])
  })

  it('has nothing to consume without a state yet', () => {
    const win = fakeWindow()
    registerThreadKeyboard({ target: win as unknown as ThreadKeyboardEnvironment['target'], ownsKeyboard: () => false, now: () => 0 })
    expect(consumed(win.dispatch(alt(1)))).toBe(false)
  })
})

describe('thread keyboard: always the current list', () => {
  it('resolves against rows refreshed and reordered after registration', () => {
    const harness = setup({ activeThreadId: 'x' })
    harness.press(alt(1))
    expect(harness.opened()).toEqual(['a'])
    harness.handle.update({ ...harness.state, rows: rows(['q', 'b', 'a']), activeThreadId: 'x' })
    harness.press(alt(1))
    harness.press(alt(3))
    expect(harness.opened()).toEqual(['a', 'q', 'a'])
    harness.press(alt(4))
    expect(harness.opened()).toHaveLength(3)
  })

  it('uses the callback of the latest refresh, never an earlier one', () => {
    const harness = setup()
    const replacement = vi.fn<(thread: ThreadSummary) => void>()
    harness.handle.update({ ...harness.state, onOpenThread: replacement })
    harness.press(alt(1))
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(replacement.mock.calls[0]![0].id).toBe('a')
  })

  it('follows active changes between presses', () => {
    const harness = setup({ activeThreadId: 'a' })
    harness.press(next())
    harness.handle.update({ ...harness.state, activeThreadId: 'f' })
    harness.press(next())
    harness.handle.update({ ...harness.state, activeThreadId: 'g' })
    harness.press(previous())
    expect(harness.opened()).toEqual(['b', 'g', 'f'])
  })

  it('a refresh that removes the active thread restarts the cycle at the ends', () => {
    const harness = setup({ activeThreadId: 'c' })
    harness.handle.update({ ...harness.state, rows: rows(['a', 'b', 'd']), activeThreadId: 'c' })
    harness.press(next())
    harness.press(previous())
    expect(harness.opened()).toEqual(['a', 'd'])
  })

  describe('rapid presses before the active prop catches up', () => {
    it('continue from the thread just opened instead of the stale active one', () => {
      const harness = setup({ activeThreadId: 'a' })
      harness.press(next())
      harness.control.clock += 30
      harness.press(next())
      harness.control.clock += 30
      harness.press(next())
      expect(harness.opened()).toEqual(['b', 'c', 'd'])
    })

    it('do not reopen a thread that a previous press already opened', () => {
      const harness = setup({ activeThreadId: 'a' })
      harness.press(alt(2))
      harness.control.clock += 20
      const second = harness.press(alt(2))
      expect(harness.opened()).toEqual(['b'])
      expect(consumed(second)).toBe(false)
    })

    it('can go back to the thread the focus has not yet left', () => {
      const harness = setup({ activeThreadId: 'a' })
      harness.press(alt(2))
      harness.control.clock += 20
      harness.press(alt(1))
      expect(harness.opened()).toEqual(['b', 'a'])
    })

    it('hand back to the real active thread as soon as the prop changes', () => {
      const harness = setup({ activeThreadId: 'a' })
      harness.press(next())
      harness.handle.update({ ...harness.state, activeThreadId: 'h' })
      harness.press(next())
      expect(harness.opened()).toEqual(['b', 'i'])
    })

    it('forget the optimistic target when the prop never followed', () => {
      const harness = setup({ activeThreadId: 'a' })
      harness.press(next())
      harness.control.clock += 5000
      harness.press(next())
      expect(harness.opened()).toEqual(['b', 'b'])
    })

    it('forget the optimistic target when its row left the list', () => {
      const harness = setup({ activeThreadId: 'a' })
      harness.press(next())
      harness.handle.update({ ...harness.state, rows: rows(['a', 'c', 'd']), activeThreadId: 'a' })
      harness.control.clock += 10
      harness.press(next())
      expect(harness.opened()).toEqual(['b', 'c'])
    })
  })
})

describe('threadKeyboardIntent', () => {
  it('names the digit index or the cycle step, and nothing else', () => {
    expect(threadKeyboardIntent(alt(1))).toEqual({ kind: 'index', index: 0 })
    expect(threadKeyboardIntent(alt(9))).toEqual({ kind: 'index', index: 8 })
    expect(threadKeyboardIntent(next())).toEqual({ kind: 'cycle', step: 1 })
    expect(threadKeyboardIntent(previous())).toEqual({ kind: 'cycle', step: -1 })
    expect(threadKeyboardIntent(alt(1, { ctrlKey: true }))).toBeNull()
    expect(threadKeyboardIntent(keydown({ key: 'a', altKey: true }))).toBeNull()
    expect(threadKeyboardIntent(alt(1, { altGraph: true }))).toBeNull()
    expect(threadKeyboardIntent(alt(1, { keyCode: 229 }))).toBeNull()
  })
})

describe('threadKeyboardRows: exactly what the list renders', () => {
  const current = rows(['c1', 'c2', 'c3'])
  const older = rows(['o1', 'o2'])
  const ids_ = (list: ThreadSummary[]): string[] => list.map(row => row.id)

  it('is the current rows alone while Older is collapsed', () => {
    expect(ids_(threadKeyboardRows({ current, older, olderOpen: false, collapsed: false }))).toEqual(['c1', 'c2', 'c3'])
  })

  it('appends Older, in order, only while it is expanded', () => {
    expect(ids_(threadKeyboardRows({ current, older, olderOpen: true, collapsed: false }))).toEqual(['c1', 'c2', 'c3', 'o1', 'o2'])
  })

  it('has no rows when the Threads section is collapsed, whatever Older says', () => {
    expect(threadKeyboardRows({ current, older, olderOpen: true, collapsed: true })).toEqual([])
    expect(threadKeyboardRows({ current, older, olderOpen: false, collapsed: true })).toEqual([])
  })

  it('has no rows for an absent view', () => {
    const { current: none, older: noneOlder } = sidebarThreadView(null, Date.now())
    expect(threadKeyboardRows({ current: none, older: noneOlder, olderOpen: true, collapsed: false })).toEqual([])
  })

  describe('over the real sidebarThreadView', () => {
    const now = Date.parse('2026-10-30T12:00:00.000Z')
    const minutes = (n: number): string => new Date(now - n * 60_000).toISOString()
    const working = (id: string, age: number): ThreadSummary => thread(id, { updatedAt: minutes(age) })
    const view = (list: ThreadSummary[], hidden = 0): ThreadView => ({
      generalProjectId: null, total: list.length, hidden, observedAt: new Date(now).toISOString(),
      groups: [{ bucket: 'working', label: 'Working', threads: list }]
    })
    // seven working threads: five fit the sidebar's current list, two spill into Older with the stopped one.
    const all = [...Array.from({ length: 7 }, (_, index) => working(`w${index + 1}`, index + 1)), thread('s1', { state: 'done', updatedAt: minutes(500) })]

    it('keeps Older rows out until Older is expanded and counts rows below the fold', () => {
      const { current: shown, older: spilled } = sidebarThreadView(view(all, 12), now)
      expect(shown.map(row => row.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
      expect(spilled.map(row => row.id)).toEqual(['w6', 'w7', 's1'])
      expect(threadKeyboardRows({ current: shown, older: spilled, olderOpen: false, collapsed: false }).map(row => row.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
      const expanded = threadKeyboardRows({ current: shown, older: spilled, olderOpen: true, collapsed: false }).map(row => row.id)
      expect(expanded).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 's1'])
      // omitted server rows (hidden: 12) never appear; the ninth key has nothing to open.
      expect(expanded).toHaveLength(8)
    })

    it('applies the current query, because the view it is handed is the query result', () => {
      const { current: shown, older: spilled } = sidebarThreadView(view(all.filter(row => /w[2-6]/.test(row.id))), now)
      expect(threadKeyboardRows({ current: shown, older: spilled, olderOpen: true, collapsed: false }).map(row => row.id)).toEqual(['w2', 'w3', 'w4', 'w5', 'w6'])
    })

    it('drives the key handler to the same row the list renders at every position', () => {
      const { current: shown, older: spilled } = sidebarThreadView(view(all), now)
      const keyed = threadKeyboardRows({ current: shown, older: spilled, olderOpen: true, collapsed: false })
      for (let digit = 1; digit <= 8; digit += 1) {
        const harness = setup({ rows: keyed, activeThreadId: null })
        harness.press(alt(digit))
        expect(harness.opened()).toEqual([[...shown, ...spilled][digit - 1]!.id])
      }
    })
  })
})
