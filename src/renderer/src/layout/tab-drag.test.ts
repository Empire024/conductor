import { describe, expect, it } from 'vitest'
import { dropTargetAt, gapAnchorId, nearestEdge, tabInsertionIndex, type PaneGeometry, type TabRect } from './tab-drag'

const rects: TabRect[] = [
  { id: 'a', left: 0, right: 100 },
  { id: 'b', left: 100, right: 200 },
  { id: 'c', left: 200, right: 300 }
]

describe('tabInsertionIndex', () => {
  it('lands at 0 on the left edge of the first tab', () => {
    expect(tabInsertionIndex(5, rects)).toBe(0)
  })
  it('lands between two tabs once past their shared midpoint', () => {
    expect(tabInsertionIndex(149, rects)).toBe(1)
    expect(tabInsertionIndex(151, rects)).toBe(2)
  })
  it('lands at the end past the last tab', () => {
    expect(tabInsertionIndex(295, rects)).toBe(3)
  })
  it('is 0 for an empty bar', () => {
    expect(tabInsertionIndex(50, [])).toBe(0)
  })
})

describe('gapAnchorId', () => {
  it('anchors before the tab currently at that index', () => {
    expect(gapAnchorId(['a', 'b', 'c'], null, 0)).toBe('a')
    expect(gapAnchorId(['a', 'b', 'c'], null, 1)).toBe('b')
  })
  it('returns null (open end) once the index reaches the tab count', () => {
    expect(gapAnchorId(['a', 'b', 'c'], null, 3)).toBeNull()
  })
  it('excludes the dragged tab before indexing, so reordering within its own bar skips its own slot', () => {
    // Dragging "b" to index 0 of the remaining [a, c] should anchor before "a", not itself.
    expect(gapAnchorId(['a', 'b', 'c'], 'b', 0)).toBe('a')
    expect(gapAnchorId(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(gapAnchorId(['a', 'b', 'c'], 'b', 2)).toBeNull()
  })
})

describe('nearestEdge', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 }
  it('picks left near the left edge', () => {
    expect(nearestEdge({ x: 10, y: 50 }, rect)).toBe('left')
  })
  it('picks right near the right edge', () => {
    expect(nearestEdge({ x: 190, y: 50 }, rect)).toBe('right')
  })
  it('picks above near the top edge', () => {
    expect(nearestEdge({ x: 100, y: 5 }, rect)).toBe('above')
  })
  it('picks below near the bottom edge', () => {
    expect(nearestEdge({ x: 100, y: 95 }, rect)).toBe('below')
  })
})

describe('dropTargetAt', () => {
  // A 400x300 pane at the origin with a 34px tab strip holding three 100px tabs.
  const pane: PaneGeometry = {
    groupId: 'g1',
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    headerBottom: 34,
    tabs: [
      { id: 'a', left: 0, right: 100 },
      { id: 'b', left: 100, right: 200 },
      { id: 'c', left: 200, right: 300 }
    ]
  }

  it('reads a pointer in the tab strip as an insertion index, ignoring the dragged tab', () => {
    expect(dropTargetAt({ x: 5, y: 16 }, pane, 'c')).toEqual({ kind: 'bar', groupId: 'g1', index: 0 })
    expect(dropTargetAt({ x: 149, y: 16 }, pane, 'c')).toEqual({ kind: 'bar', groupId: 'g1', index: 1 })
    // 'c' is lifted out, so past the middle of 'b' is the end of the remaining strip.
    expect(dropTargetAt({ x: 250, y: 16 }, pane, 'c')).toEqual({ kind: 'bar', groupId: 'g1', index: 2 })
  })

  it('treats the last row of the tab strip as the strip, and the row below it as the body', () => {
    expect(dropTargetAt({ x: 200, y: 34 }, pane, 'c').kind).toBe('bar')
    expect(dropTargetAt({ x: 200, y: 35 }, pane, 'c').kind).toBe('canvas')
  })

  it('measures canvas edges from the body below the strip, not the whole pane', () => {
    // 12px under the strip is nearer the body's top edge than its left edge (200 across).
    expect(dropTargetAt({ x: 200, y: 46 }, pane, 'c')).toEqual({ kind: 'canvas', groupId: 'g1', edge: 'above' })
    expect(dropTargetAt({ x: 390, y: 170 }, pane, 'c')).toEqual({ kind: 'canvas', groupId: 'g1', edge: 'right' })
    expect(dropTargetAt({ x: 10, y: 170 }, pane, 'c')).toEqual({ kind: 'canvas', groupId: 'g1', edge: 'left' })
    expect(dropTargetAt({ x: 200, y: 292 }, pane, 'c')).toEqual({ kind: 'canvas', groupId: 'g1', edge: 'below' })
  })

  it('names the edge from the pane, not from the box the dock preview squeezed it into', () => {
    // Regression: the resolver used to measure .pane-content, which dock-hover-above scales to
    // 54% and slides down. Re-measuring the previewed box put the pointer above the shrunken
    // body forever, so a pointer parked at the right edge kept re-answering 'above' and the
    // drag latched onto the first edge it happened to pick.
    const point = { x: 390, y: 170 }
    const body = { left: pane.left, top: pane.headerBottom, width: pane.width, height: pane.height - pane.headerBottom }
    // dock-hover-above is `transform-origin: center bottom; transform: translateY(23%) scaleY(.54)`.
    const previewed = {
      left: body.left,
      top: body.top + body.height - body.height * 0.54 + body.height * 0.23,
      width: body.width,
      height: body.height * 0.54
    }
    expect(nearestEdge(point, body)).toBe('right')
    expect(nearestEdge(point, previewed)).toBe('above')
    // dropTargetAt is handed the pane's real box, so it keeps answering 'right'.
    expect(dropTargetAt(point, pane, 'c')).toEqual({ kind: 'canvas', groupId: 'g1', edge: 'right' })
  })

  it('reports an empty pane bar as index 0 so the first tab can be dropped in', () => {
    expect(dropTargetAt({ x: 200, y: 16 }, { ...pane, tabs: [] }, 'c')).toEqual({ kind: 'bar', groupId: 'g1', index: 0 })
  })
})
