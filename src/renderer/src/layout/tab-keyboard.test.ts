import { describe, expect, it } from 'vitest'
import { createDefaultLayout, makeLauncherTab } from '../../../shared/models'
import type { PaneGroupNode, WorkspaceLayout } from '../../../shared/models'
import { addTab, findGroup, listGroups, splitGroup } from './layout-operations'
import {
  moveFocusedTab,
  nextSnapStop,
  resizeFocusedGroup,
  snapFocusedGroup,
  splitAncestors,
  tabIdAtChromeIndex,
  tabIdByOffset
} from './tab-keyboard'

const groupOf = (layout: WorkspaceLayout, groupId: string): PaneGroupNode => {
  const group = findGroup(layout.root, groupId)
  if (!group) throw new Error('Expected group')
  return group
}

const withTabs = (count: number): { layout: WorkspaceLayout; groupId: string } => {
  let layout = createDefaultLayout()
  if (layout.root.type !== 'group') throw new Error('Expected group root')
  const groupId = layout.root.id
  for (let index = 1; index < count; index += 1) layout = addTab(layout, groupId, makeLauncherTab())
  return { layout, groupId }
}

describe('chrome-style tab selection', () => {
  it('maps Ctrl+1..8 to that position and Ctrl+9 to the last tab', () => {
    const { layout, groupId } = withTabs(4)
    const group = groupOf(layout, groupId)
    expect(tabIdAtChromeIndex(group, 1)).toBe(group.tabs[0]!.id)
    expect(tabIdAtChromeIndex(group, 3)).toBe(group.tabs[2]!.id)
    expect(tabIdAtChromeIndex(group, 9)).toBe(group.tabs[3]!.id)
  })

  it('returns null when the requested position does not exist', () => {
    const { layout, groupId } = withTabs(2)
    expect(tabIdAtChromeIndex(groupOf(layout, groupId), 5)).toBeNull()
  })

  it('wraps Ctrl+Tab forwards and backwards', () => {
    const { layout, groupId } = withTabs(3)
    const group = groupOf(layout, groupId)
    // addTab activates the tab it appends, so the last tab is active here.
    expect(group.activeTabId).toBe(group.tabs[2]!.id)
    expect(tabIdByOffset(group, 1)).toBe(group.tabs[0]!.id)
    expect(tabIdByOffset(group, -1)).toBe(group.tabs[1]!.id)
  })

  it('has no tab to pick in an empty group', () => {
    const empty: PaneGroupNode = { type: 'group', id: 'g', tabs: [], activeTabId: '' }
    expect(tabIdByOffset(empty, 1)).toBeNull()
    expect(tabIdAtChromeIndex(empty, 1)).toBeNull()
  })
})

describe('keyboard pane resizing', () => {
  const horizontal = (): { layout: WorkspaceLayout; left: string; right: string } => {
    const base = createDefaultLayout()
    if (base.root.type !== 'group') throw new Error('Expected group root')
    const layout = splitGroup(base, base.root.id, 'right', makeLauncherTab())
    const groups = listGroups(layout.root)
    return { layout, left: groups[0]!.id, right: groups[1]!.id }
  }

  it('finds the nearest ancestor split of the focused group', () => {
    const { layout, right } = horizontal()
    const ancestors = splitAncestors(layout.root, right)
    expect(ancestors).toHaveLength(1)
    expect(ancestors[0]!.branch).toBe(1)
  })

  it('moves the divider in the arrow direction regardless of which side is focused', () => {
    const { layout, left, right } = horizontal()
    const fromLeft = resizeFocusedGroup(layout, left, 'right')
    const fromRight = resizeFocusedGroup(layout, right, 'right')
    if (fromLeft.root.type !== 'split' || fromRight.root.type !== 'split') throw new Error('Expected split')
    expect(fromLeft.root.sizes[0]).toBe(55)
    expect(fromRight.root.sizes[0]).toBe(55)
  })

  it('leaves the layout untouched when no split exists on that axis', () => {
    const { layout, left } = horizontal()
    expect(resizeFocusedGroup(layout, left, 'down')).toBe(layout)
  })

  it('clamps rather than collapsing a pane', () => {
    const { layout, left } = horizontal()
    let next = layout
    for (let step = 0; step < 40; step += 1) next = resizeFocusedGroup(next, left, 'left')
    if (next.root.type !== 'split') throw new Error('Expected split')
    expect(next.root.sizes[0]).toBe(10)
    expect(next.root.sizes[1]).toBe(90)
  })

  it('steps through snap stops like Windows snap positions', () => {
    expect(nextSnapStop(50, true)).toBe(67)
    expect(nextSnapStop(50, false)).toBe(33)
    expect(nextSnapStop(90, true)).toBe(90)
    expect(nextSnapStop(10, false)).toBe(10)
  })

  it('snaps the divider to the next preset instead of nudging', () => {
    const { layout, left } = horizontal()
    const snapped = snapFocusedGroup(layout, left, 'right')
    if (snapped.root.type !== 'split') throw new Error('Expected split')
    expect(snapped.root.sizes).toEqual([67, 33])
  })

  it('ignores an unknown group', () => {
    const { layout } = horizontal()
    expect(resizeFocusedGroup(layout, 'missing', 'right')).toBe(layout)
    expect(snapFocusedGroup(layout, 'missing', 'right')).toBe(layout)
  })
})

describe('moving the focused tab', () => {
  const horizontal = (): { layout: WorkspaceLayout; left: string; right: string } => {
    const base = createDefaultLayout()
    if (base.root.type !== 'group') throw new Error('Expected group root')
    const layout = splitGroup(base, base.root.id, 'right', makeLauncherTab())
    const groups = listGroups(layout.root)
    return { layout, left: groups[0]!.id, right: groups[1]!.id }
  }

  it('relocates the tab into the neighbouring pane instead of resizing the divider', () => {
    const { layout, left, right } = horizontal()
    const moved = moveFocusedTab(layout, left, 'right')
    expect(findGroup(moved.layout.root, left)).toBeNull()
    expect(groupOf(moved.layout, right).tabs).toHaveLength(2)
    if (moved.layout.root.type !== 'split' && layout.root.type === 'split') expect(moved.layout.root).not.toEqual(layout.root)
  })

  it('leaves the sizes alone, unlike a resize on the same arrow', () => {
    const { layout, left } = horizontal()
    const resized = resizeFocusedGroup(layout, left, 'right')
    const moved = moveFocusedTab(layout, left, 'right')
    if (layout.root.type !== 'split' || resized.root.type !== 'split') throw new Error('Expected split')
    expect(resized.root.sizes).not.toEqual(layout.root.sizes)
    expect(moved.layout).not.toEqual(resized)
  })

  it('peels a tab into a new pane when nothing lies that way', () => {
    const { layout, groupId } = withTabs(2)
    const moved = moveFocusedTab(layout, groupId, 'right')
    expect(listGroups(moved.layout.root)).toHaveLength(2)
    expect(listGroups(moved.layout.root).map((group) => group.tabs.length)).toEqual([1, 1])
  })

  it('refuses to empty the only pane and ignores an unknown group', () => {
    const { layout, groupId } = withTabs(1)
    expect(moveFocusedTab(layout, groupId, 'right').layout).toBe(layout)
    expect(moveFocusedTab(layout, 'missing', 'left').layout).toBe(layout)
  })

  it('reports the pane the tab landed in, whether it docked or peeled', () => {
    const { layout, left, right } = horizontal()
    const docked = moveFocusedTab(layout, left, 'right')
    expect(docked.groupId).toBe(right)
    const peeled = moveFocusedTab(docked.layout, right, 'right')
    expect(peeled.groupId).not.toBe(right)
    expect(groupOf(peeled.layout, peeled.groupId).tabs).toHaveLength(1)
  })

  it('keeps moving the same tab down and back up however often the shortcut repeats', () => {
    const base = createDefaultLayout()
    if (base.root.type !== 'group') throw new Error('Expected group root')
    const start = splitGroup(base, base.root.id, 'below', makeLauncherTab())
    const top = listGroups(start.root)[0]!
    const moving = top.tabs[0]!.id
    let layout = start
    let focused = top.id
    for (let round = 0; round < 3; round += 1) {
      const down = moveFocusedTab(layout, focused, 'down')
      expect(down.layout).not.toBe(layout)
      expect(groupOf(down.layout, down.groupId).tabs.map((tab) => tab.id)).toContain(moving)
      const up = moveFocusedTab(down.layout, down.groupId, 'up')
      expect(up.layout).not.toBe(down.layout)
      expect(groupOf(up.layout, up.groupId).tabs.map((tab) => tab.id)).toContain(moving)
      expect(listGroups(up.layout.root)).toHaveLength(2)
      layout = up.layout
      focused = up.groupId
    }
  })
})
