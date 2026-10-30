import { useLayoutEffect, useRef } from 'react'
import type { ThreadSummary } from '../../../shared/threads'

/**
 * Keyboard selection for the sidebar Threads list: Alt+1..9 opens the nth rendered row, Alt+Shift+[ / ]
 * cycles to the previous / next one. It only chooses a row and hands it to the list's own `onOpenThread`
 * (the same callback a click uses, so cross-project navigation stays that callback's job).
 */
export interface ThreadKeyboardState {
  /** The rows exactly as rendered, in order (see `threadKeyboardRows`). Empty when there is nothing to select. */
  rows: readonly ThreadSummary[]
  activeThreadId?: string | null
  /** The sidebar is shown, not collapsed, and in workspace mode. */
  visible: boolean
  /** The thread context menu is open and owns the keyboard. */
  menuOpen: boolean
  onOpenThread(thread: ThreadSummary): void
}

export interface ThreadKeyboardEnvironment {
  target: {
    addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void
    removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void
  }
  /** A modal, dialog or menu elsewhere in the document owns the keyboard. */
  ownsKeyboard(): boolean
  now(): number
}

export interface ThreadKeyboardHandle {
  update(state: ThreadKeyboardState): void
  dispose(): void
}

export type ThreadKeyboardIntent = { kind: 'index'; index: number } | { kind: 'cycle'; step: 1 | -1 }

/** The rows `ThreadList` renders, in render order: current, then Older only while it is expanded. */
export function threadKeyboardRows(input: { current: readonly ThreadSummary[]; older: readonly ThreadSummary[]; olderOpen: boolean; collapsed: boolean }): ThreadSummary[] {
  if (input.collapsed) return []
  return [...input.current, ...(input.olderOpen ? input.older : [])]
}

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>
  & Partial<Pick<KeyboardEvent, 'repeat' | 'isComposing' | 'keyCode' | 'defaultPrevented' | 'getModifierState'>>

/** What the key asks for, or null. Says nothing about focus, modals or state. */
export function threadKeyboardIntent(event: KeyEventLike): ThreadKeyboardIntent | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return null
  if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return null
  if (!event.altKey || event.ctrlKey || event.metaKey) return null // Ctrl+Alt is how Windows reports AltGr
  if (!event.shiftKey) {
    // The produced key, not the physical one: layouts that need Shift for digits never reach here.
    return /^[1-9]$/.test(event.key) ? { kind: 'index', index: Number(event.key) - 1 } : null
  }
  // Shifted brackets produce "{" / "}", so cycling follows the physical key.
  if (event.code === 'BracketRight') return { kind: 'cycle', step: 1 }
  if (event.code === 'BracketLeft') return { kind: 'cycle', step: -1 }
  return null
}

interface NodeLike {
  tagName?: unknown
  isContentEditable?: boolean
  parentElement?: NodeLike | null
  parentNode?: NodeLike | null
  host?: NodeLike | null
  getAttribute?(name: string): string | null
  classList?: { contains(name: string): boolean }
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const hasClass = (node: NodeLike, name: string): boolean => Boolean(node.classList && typeof node.classList.contains === 'function' && node.classList.contains(name))
const attribute = (node: NodeLike, name: string): string | null => (typeof node.getAttribute === 'function' ? node.getAttribute(name) : null)

/** An editable surface, an editor/terminal widget, a dialog or the thread menu: they keep their own keys. */
function ownsKeys(node: NodeLike): boolean {
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (EDITABLE_TAGS.has(tag) || tag === 'DIALOG') return true
  if (node.isContentEditable === true) return true
  const editable = attribute(node, 'contenteditable')
  if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true
  const role = attribute(node, 'role')
  if (role === 'textbox' || role === 'dialog' || role === 'alertdialog') return true
  if (attribute(node, 'aria-modal') === 'true') return true
  return hasClass(node, 'monaco-editor') || hasClass(node, 'xterm') || hasClass(node, 'thread-menu')
}

/** Target and every ancestor, through shadow roots when the event offers its composed path. */
function eventNodes(event: KeyboardEvent): NodeLike[] {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  const nodes: NodeLike[] = path.filter((entry): entry is EventTarget & NodeLike => Boolean(entry) && typeof entry === 'object')
  const seen = new Set<NodeLike>(nodes)
  for (let node = event.target as unknown as NodeLike | null; node && !seen.has(node); node = node.parentElement ?? node.parentNode ?? node.host ?? null) {
    seen.add(node)
    nodes.push(node)
  }
  return nodes
}

/** A pressed key is still the previous press's destination until the active prop catches up. */
const PENDING_MS = 500
const MODAL_SELECTOR = 'dialog[open], [aria-modal="true"], .settings-scrim, .palette-backdrop, .thread-menu'

export function browserThreadKeyboardEnvironment(): ThreadKeyboardEnvironment {
  return {
    target: window,
    ownsKeyboard: () => document.querySelector(MODAL_SELECTOR) !== null,
    now: () => Date.now()
  }
}

/** One bubble-phase keydown listener that reads the latest state on every key. `dispose` removes it. */
export function registerThreadKeyboard(environment: ThreadKeyboardEnvironment, initial?: ThreadKeyboardState): ThreadKeyboardHandle {
  let state: ThreadKeyboardState | null = initial ?? null
  let pending: { id: string; from: string | null; at: number } | null = null
  let disposed = false

  const activeId = (current: ThreadKeyboardState): string | null => {
    const real = current.activeThreadId ?? null
    if (pending && (pending.from !== real || environment.now() - pending.at > PENDING_MS || !current.rows.some(row => row.id === pending!.id))) pending = null
    return pending ? pending.id : real
  }

  const listener = (event: KeyboardEvent): void => {
    const current = state
    if (disposed || !current || !current.visible || current.menuOpen || current.rows.length === 0) return
    const intent = threadKeyboardIntent(event)
    if (!intent) return
    if (eventNodes(event).some(ownsKeys) || environment.ownsKeyboard()) return
    const { rows } = current
    const active = activeId(current)
    let target: ThreadSummary | undefined
    if (intent.kind === 'index') target = rows[intent.index]
    else {
      const at = active === null ? -1 : rows.findIndex(row => row.id === active)
      target = rows[at < 0 ? (intent.step > 0 ? 0 : rows.length - 1) : (at + intent.step + rows.length) % rows.length]
    }
    if (!target || target.id === active) return
    pending = { id: target.id, from: current.activeThreadId ?? null, at: environment.now() }
    event.preventDefault()
    event.stopPropagation()
    current.onOpenThread(target)
  }

  environment.target.addEventListener('keydown', listener)
  return {
    update(next) { if (!disposed) state = next },
    dispose() {
      if (disposed) return
      disposed = true
      state = null
      pending = null
      environment.target.removeEventListener('keydown', listener)
    }
  }
}

/** The list's one registration: made on mount, fed the latest state after every render, removed on unmount. */
export function useThreadKeyboard(state: ThreadKeyboardState): void {
  const handle = useRef<ThreadKeyboardHandle | null>(null)
  useLayoutEffect(() => {
    const next = registerThreadKeyboard(browserThreadKeyboardEnvironment())
    handle.current = next
    return () => { next.dispose(); handle.current = null }
  }, [])
  useLayoutEffect(() => { handle.current?.update(state) })
}
