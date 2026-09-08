import type { AgentProviderId, LayoutNode, PaneGroupNode, PaneKind, SplitNode, WorkspaceLayout } from '../../../shared/models'
import { resizeSplit } from './layout-operations'

export type ResizeDirection = 'left' | 'right' | 'up' | 'down'

/** Second key of the Ctrl+T chord, mirroring Chrome's "new tab" muscle memory. */
export interface ChordTarget {
  kind: PaneKind
  provider?: AgentProviderId
  label: string
}

/** Ctrl+T alone opens a launcher; Ctrl+T then one of these opens that runtime directly. */
export const TAB_CHORD: Record<string, ChordTarget> = {
  x: { kind: 'agent', provider: 'codex', label: 'Codex' },
  c: { kind: 'agent', provider: 'claude', label: 'Claude Code' },
  q: { kind: 'agent', provider: 'qwen', label: 'Qwen Code' },
  k: { kind: 'agent', provider: 'kimi', label: 'Kimi Code' },
  g: { kind: 'agent', provider: 'gemini', label: 'Gemini CLI' },
  t: { kind: 'terminal', label: 'PowerShell' },
  n: { kind: 'launcher', label: 'New tab' }
}

export const CHORD_TIMEOUT_MS = 1600

/** Chrome semantics: Ctrl+1..8 pick that tab, Ctrl+9 always picks the last one. */
export const tabIdAtChromeIndex = (group: PaneGroupNode, digit: number): string | null => {
  if (group.tabs.length === 0) return null
  if (digit === 9) return group.tabs[group.tabs.length - 1]!.id
  return group.tabs[digit - 1]?.id ?? null
}

/** Ctrl+Tab / Ctrl+Shift+Tab wrap around the group, as browser tab strips do. */
export const tabIdByOffset = (group: PaneGroupNode, offset: number): string | null => {
  if (group.tabs.length === 0) return null
  const current = group.tabs.findIndex((tab) => tab.id === group.activeTabId)
  const from = current === -1 ? 0 : current
  const size = group.tabs.length
  return group.tabs[(((from + offset) % size) + size) % size]!.id
}

interface Ancestor {
  split: SplitNode
  /** Which side of `split` contains the focused group. */
  branch: 0 | 1
}

/** Ancestors of `groupId`, nearest first, so a resize can pick the closest matching axis. */
export const splitAncestors = (root: LayoutNode, groupId: string): Ancestor[] => {
  const walk = (node: LayoutNode, trail: Ancestor[]): Ancestor[] | null => {
    if (node.type === 'group') return node.id === groupId ? trail : null
    return (
      walk(node.children[0], [{ split: node, branch: 0 }, ...trail]) ??
      walk(node.children[1], [{ split: node, branch: 1 }, ...trail])
    )
  }
  return walk(root, []) ?? []
}

const axisOf = (direction: ResizeDirection): SplitNode['direction'] =>
  direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'

/** Arrow keys push the shared divider that way, matching the gutter's own arrow-key nudge. */
const towardsSecondChild = (direction: ResizeDirection): boolean =>
  direction === 'right' || direction === 'down'

const MIN_PERCENT = 10
const MAX_PERCENT = 90

const clampPercent = (value: number): number => Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, value))

/** Quarter-ish stops give Ctrl+Alt+Shift+Arrow the feel of Windows' snap positions. */
const SNAP_STOPS = [10, 25, 33, 50, 67, 75, 90]

export const nextSnapStop = (current: number, forward: boolean): number => {
  const stops = forward ? SNAP_STOPS : [...SNAP_STOPS].reverse()
  const target = stops.find((stop) => (forward ? stop > current + 0.5 : stop < current - 0.5))
  return target ?? clampPercent(current)
}

/**
 * Move the divider nearest to the focused group along the arrow's axis. Returns the
 * original layout when nothing on that axis can move, so callers can leave the key
 * unhandled instead of swallowing it.
 */
export const resizeFocusedGroup = (
  layout: WorkspaceLayout,
  groupId: string,
  direction: ResizeDirection,
  stepPercent = 5
): WorkspaceLayout => {
  const ancestor = splitAncestors(layout.root, groupId).find(
    (candidate) => candidate.split.direction === axisOf(direction)
  )
  if (!ancestor) return layout
  const delta = towardsSecondChild(direction) ? stepPercent : -stepPercent
  const first = clampPercent(ancestor.split.sizes[0] + delta)
  if (first === ancestor.split.sizes[0]) return layout
  return resizeSplit(layout, ancestor.split.id, [first, 100 - first])
}

/** Snap that same divider to the next preset stop rather than nudging it. */
export const snapFocusedGroup = (
  layout: WorkspaceLayout,
  groupId: string,
  direction: ResizeDirection
): WorkspaceLayout => {
  const ancestor = splitAncestors(layout.root, groupId).find(
    (candidate) => candidate.split.direction === axisOf(direction)
  )
  if (!ancestor) return layout
  const first = nextSnapStop(ancestor.split.sizes[0], towardsSecondChild(direction))
  if (first === ancestor.split.sizes[0]) return layout
  return resizeSplit(layout, ancestor.split.id, [first, 100 - first])
}

/**
 * Text inputs, editors, and terminals own their own keys. Shortcuts that collide with
 * ordinary editing (arrows, Tab, digits) must stay out of the way while one is focused.
 */
export const isEditingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return Boolean(target.closest('.monaco-editor, .xterm, [role="textbox"]'))
}
