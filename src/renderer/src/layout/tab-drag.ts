/** Pure geometry for Chrome-style tab dragging: where a dragged tab lands, kept free of
 * DOM/React so the maths can be unit tested without mounting anything. */
import type { TabDropTarget } from './layout-operations'

export type CanvasEdge = 'left' | 'right' | 'above' | 'below'

/** One drop slot in a rendered tab strip. `span` is how many tabs of the underlying strip the
 * slot stands for: 1 for an ordinary tab, and the whole membership for a collapsed group's
 * chip, which occupies one position on screen but several in `PaneGroupNode.tabs`. */
export interface TabRect { id: string; left: number; right: number; span?: number }

/** One pane measured in client coordinates. `headerBottom` is where its tab strip ends and
 * its body begins. */
export interface PaneGeometry {
  groupId: string
  left: number
  top: number
  width: number
  height: number
  headerBottom: number
  tabs: TabRect[]
}

/** How many tabs (by centre point) sit left of the pointer, i.e. the index a dropped tab
 * would land at. 0 = before the first tab, the strip's length = after the last. Slots count
 * for their `span`, so dropping past a collapsed group lands after every tab it hides rather
 * than in the middle of them. */
export const tabInsertionIndex = (pointerX: number, rects: TabRect[]): number =>
  rects.reduce(
    (index, rect) => (pointerX > (rect.left + rect.right) / 2 ? index + (rect.span ?? 1) : index),
    0
  )

/** Which real tab the insertion gap should open in front of; null means "at the end",
 * so the caller can put the gap on the trailing add-tab button instead. */
export const gapAnchorId = (tabIds: string[], draggedTabId: string | null, index: number): string | null => {
  const rest = draggedTabId ? tabIds.filter((id) => id !== draggedTabId) : tabIds
  return rest[Math.max(0, Math.min(index, rest.length))] ?? null
}

/** Nearest edge of `rect` to `point`, used when a tab is dropped away from any tab bar and
 * needs to peel off into its own pane rather than join one. */
export const nearestEdge = (point: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }): CanvasEdge => {
  const left = point.x - rect.left
  const right = rect.left + rect.width - point.x
  const top = point.y - rect.top
  const bottom = rect.top + rect.height - point.y
  const min = Math.min(left, right, top, bottom)
  if (min === left) return 'left'
  if (min === right) return 'right'
  return min === top ? 'above' : 'below'
}

/** Where a pointer over `pane` drops the tab: an insertion index in that pane's tab strip,
 * or the nearest edge of its body. Everything is measured from the pane's own untransformed
 * layout box - never from the dock preview's squeezed one, or the answer would chase the
 * preview it just triggered and latch onto whichever edge happened to win first. */
export const dropTargetAt = (
  point: { x: number; y: number },
  pane: PaneGeometry,
  draggedTabId: string
): TabDropTarget =>
  point.y <= pane.headerBottom
    ? {
        kind: 'bar',
        groupId: pane.groupId,
        index: tabInsertionIndex(point.x, pane.tabs.filter((tab) => tab.id !== draggedTabId))
      }
    : {
        kind: 'canvas',
        groupId: pane.groupId,
        edge: nearestEdge(point, {
          left: pane.left,
          top: pane.headerBottom,
          width: pane.width,
          height: pane.top + pane.height - pane.headerBottom
        })
      }
