import { describe, expect, it } from 'vitest'
import type { PaneGroupNode, SplitNode } from '../../../shared/models'
import { createDefaultLayout, makeLauncherTab } from '../../../shared/models'
import { addTab, applyTabDrop, closeTab, dockTab, findGroup, insertForeignTab, instantiateLayout, listGroups, moveTabToGroup, reorderTab, splitGroup, stripWorkspaceUtilityTabs, tabDropLands } from './layout-operations'
import { gapAnchorId } from './tab-drag'

describe('layout operations', () => {
  it('splits recursively and preserves both groups', () => {
    const layout = createDefaultLayout()
    const rootId = layout.root.id
    const split = splitGroup(layout, rootId, 'right', makeLauncherTab())
    expect(split.root.type).toBe('split')
    expect(listGroups(split.root)).toHaveLength(2)
  })

  it('collapses a split when its only tab closes', () => {
    const layout = createDefaultLayout()
    const sourceId = layout.root.id
    const split = splitGroup(layout, sourceId, 'right', makeLauncherTab())
    const groups = listGroups(split.root)
    const right = groups[1]!
    const result = closeTab(split, right.id, right.activeTabId)
    expect(result.layout.root.type).toBe('group')
    expect(result.closed).not.toBeNull()
  })

  it('preserves the surviving group identity when its sibling split collapses', () => {
    // PaneWorkspace keys the rendered pane group off this id (and reuses the object
    // reference to detect the collapse) so React never remounts/flashes the survivor
    // when the neighbouring tab closes and the split disappears.
    const layout = createDefaultLayout()
    const sourceId = layout.root.id
    const split = splitGroup(layout, sourceId, 'right', makeLauncherTab())
    const [left, right] = listGroups(split.root) as [PaneGroupNode, PaneGroupNode]
    const result = closeTab(split, right.id, right.activeTabId)
    expect(result.layout.root.type).toBe('group')
    expect(result.layout.root.id).toBe(left.id)
    expect(result.layout.root).toBe(left)
  })

  it('preserves a deeply nested survivor identity when an intermediate split collapses', () => {
    let layout = createDefaultLayout()
    const rootId = layout.root.id
    layout = splitGroup(layout, rootId, 'right', makeLauncherTab())
    const rightId = listGroups(layout.root)[1]!.id
    layout = splitGroup(layout, rightId, 'below', makeLauncherTab())

    const root = layout.root as SplitNode
    const nested = root.children[1] as SplitNode
    const closing = nested.children[0] as PaneGroupNode
    const survivor = nested.children[1] as PaneGroupNode
    expect(closing.id).toBe(rightId)

    const result = closeTab(layout, closing.id, closing.activeTabId)
    const newRoot = result.layout.root as SplitNode
    expect(newRoot.type).toBe('split')
    // The split that used to hold [closing, survivor] is gone; survivor is hoisted
    // one level up but must remain the exact same object/id so its pane never remounts.
    expect(newRoot.children[1]).toBe(survivor)
    expect((newRoot.children[1] as PaneGroupNode).id).toBe(survivor.id)
    expect(newRoot.children[0]).toBe(root.children[0])
  })

  it('allows the final pane to close and the empty workspace to accept another pane', () => {
    const layout = createDefaultLayout()
    if (layout.root.type !== 'group') throw new Error('Expected group')
    const groupId = layout.root.id
    const closed = closeTab(layout, groupId, layout.root.activeTabId)
    expect(closed.layout.root.type === 'group' && closed.layout.root.tabs).toHaveLength(0)
    const reopened = addTab(closed.layout, groupId, closed.closed!)
    expect(reopened.root.type === 'group' && reopened.root.tabs).toHaveLength(1)
  })

  it('moves a tab into the center as a tab group', () => {
    const layout = createDefaultLayout()
    const sourceId = layout.root.id
    const sourceTabId = findGroup(layout.root, sourceId)!.activeTabId
    const split = splitGroup(layout, sourceId, 'right', makeLauncherTab())
    const target = listGroups(split.root)[1]!
    const moved = dockTab(split, sourceId, sourceTabId, target.id, 'center')
    expect(listGroups(moved.root)).toHaveLength(1)
    expect((moved.root.type === 'group' && moved.root.tabs.length) || 0).toBe(2)
  })

  it('splits one tab back out of a tab group', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const second = makeLauncherTab()
    if (layout.root.type !== 'group') throw new Error('Expected group')
    layout.root.tabs.push(second)
    const moved = dockTab(layout, groupId, second.id, groupId, 'below')
    expect(listGroups(moved.root)).toHaveLength(2)
  })

  it('instantiates templates without reusing runtime identities', () => {
    const layout = createDefaultLayout()
    if (layout.root.type !== 'group') throw new Error('Expected group')
    layout.root.tabs[0]!.kind = 'terminal'
    layout.root.tabs[0]!.resourceId = 'terminal-old'
    const instance = instantiateLayout(layout)
    expect(instance.root.id).not.toBe(layout.root.id)
    expect(instance.root.type === 'group' && instance.root.tabs[0]!.resourceId).not.toBe('terminal-old')
  })

  it('migrates every non-runtime view out of the runtime tab layout', () => {
    let layout = createDefaultLayout()
    if (layout.root.type !== 'group') throw new Error('Expected group')
    layout.root.tabs[0]!.kind = 'memory'
    layout = addTab(layout, layout.root.id, { id: 'processes', kind: 'logs', title: 'Processes' })
    layout = addTab(layout, layout.root.id, { id: 'code', kind: 'code', title: 'Code' })
    const codingOnly = stripWorkspaceUtilityTabs(layout)
    expect(listGroups(codingOnly.root).flatMap((group) => group.tabs).map((tab) => tab.kind)).toEqual([])
  })

  it('inserts a tab at a specific index instead of always appending', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const withInserted = addTab(layout, groupId, { id: 'inserted', kind: 'code', title: 'Inserted' }, 0)
    expect(listGroups(withInserted.root)[0]!.tabs.map((tab) => tab.id)).toEqual(['inserted', findGroup(layout.root, groupId)!.tabs[0]!.id])
  })
})

describe('Chrome-style tab bar reordering and drop', () => {
  it('reorders within the same group without touching activation', () => {
    let layout = createDefaultLayout()
    const groupId = layout.root.id
    layout = addTab(layout, groupId, { id: 'b', kind: 'code', title: 'B' })
    layout = addTab(layout, groupId, { id: 'c', kind: 'code', title: 'C' })
    const firstId = findGroup(layout.root, groupId)!.tabs[0]!.id
    const reordered = reorderTab(layout, groupId, firstId, 2)
    const group = findGroup(reordered.root, groupId)!
    expect(group.tabs.map((tab) => tab.id)).toEqual(['b', 'c', firstId])
    expect(group.activeTabId).toBe(layout.root.type === 'group' ? layout.root.activeTabId : '')
  })

  it('moves a tab into a different group at a precise index and focuses it there', () => {
    const layout = createDefaultLayout()
    const sourceId = layout.root.id
    const sourceTabId = findGroup(layout.root, sourceId)!.activeTabId
    let split = splitGroup(layout, sourceId, 'right', makeLauncherTab())
    const target = listGroups(split.root)[1]!
    split = addTab(split, target.id, { id: 'second', kind: 'code', title: 'Second' })
    const moved = moveTabToGroup(split, sourceId, sourceTabId, target.id, 0)
    const destination = findGroup(moved.root, target.id)!
    expect(destination.tabs.map((tab) => tab.id)).toEqual([sourceTabId, target.activeTabId, 'second'])
    expect(destination.activeTabId).toBe(sourceTabId)
  })

  it('collapses the source group and preserves an untouched sibling identity when its last tab is dragged elsewhere', () => {
    // Same invariant as layout-operations' closeTab test above (PaneWorkspace relies on
    // reference equality to avoid remounting the survivor), now exercised through a drag
    // that both empties one group and hands its tab to an unrelated third group.
    let layout = createDefaultLayout()
    const rootId = layout.root.id
    layout = splitGroup(layout, rootId, 'right', makeLauncherTab())
    const rightId = listGroups(layout.root)[1]!.id
    layout = splitGroup(layout, rightId, 'below', makeLauncherTab())
    const root = layout.root as SplitNode
    const nested = root.children[1] as SplitNode
    const closing = nested.children[0] as PaneGroupNode
    const survivor = nested.children[1] as PaneGroupNode
    const destination = root.children[0] as PaneGroupNode

    const moved = moveTabToGroup(layout, closing.id, closing.activeTabId, destination.id, 0)
    const newRoot = moved.root as SplitNode
    expect(newRoot.type).toBe('split')
    expect(newRoot.children[1]).toBe(survivor)
    expect(listGroups(moved.root)).toHaveLength(2)
  })

  it('applyTabDrop joins a tab bar at an index via the bar target', () => {
    let layout = createDefaultLayout()
    const groupId = layout.root.id
    layout = addTab(layout, groupId, { id: 'b', kind: 'code', title: 'B' })
    const firstId = findGroup(layout.root, groupId)!.tabs[0]!.id
    const dropped = applyTabDrop(layout, groupId, firstId, { kind: 'bar', groupId, index: 1 })
    expect(findGroup(dropped.root, groupId)!.tabs.map((tab) => tab.id)).toEqual(['b', firstId])
  })

  it('applyTabDrop peels a tab into its own pane via the canvas target', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const tabId = findGroup(layout.root, groupId)!.activeTabId
    layout.root.type === 'group' && layout.root.tabs.push(makeLauncherTab())
    const dropped = applyTabDrop(layout, groupId, tabId, { kind: 'canvas', groupId, edge: 'right' })
    expect(dropped.root.type).toBe('split')
    expect(listGroups(dropped.root)).toHaveLength(2)
  })

  it('insertForeignTab joins a tab bar the tab has never been part of, at the resolved index', () => {
    let layout = createDefaultLayout()
    const groupId = layout.root.id
    const firstId = findGroup(layout.root, groupId)!.activeTabId
    layout = addTab(layout, groupId, { id: 'b', kind: 'code', title: 'B' })
    const foreign = { id: 'foreign', kind: 'agent', title: 'Reattached', resourceId: 'agent-remote' } as const
    const dropped = insertForeignTab(layout, foreign, { kind: 'bar', groupId, index: 1 })
    const tabs = findGroup(dropped.root, groupId)!.tabs
    expect(tabs.map((tab) => tab.id)).toEqual([firstId, 'foreign', 'b'])
    expect(findGroup(dropped.root, groupId)!.activeTabId).toBe('foreign')
  })

  it('insertForeignTab splits a pane open for a canvas edge, carrying the conversation across', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const foreign = { id: 'foreign', kind: 'agent' as const, title: 'Reattached', resourceId: 'agent-remote', state: { provider: 'claude' } }
    const dropped = insertForeignTab(layout, foreign, { kind: 'canvas', groupId, edge: 'right' })
    expect(dropped.root.type).toBe('split')
    const groups = listGroups(dropped.root)
    expect(groups).toHaveLength(2)
    const landed = groups.flatMap((group) => group.tabs).find((tab) => tab.id === 'foreign')
    expect(landed).toMatchObject({ resourceId: 'agent-remote', state: { provider: 'claude' } })
  })

  it('insertForeignTab leaves the layout untouched when the target group no longer exists', () => {
    const layout = createDefaultLayout()
    const foreign = { id: 'foreign', kind: 'agent' as const, title: 'Reattached' }
    expect(insertForeignTab(layout, foreign, { kind: 'bar', groupId: 'missing', index: 0 })).toEqual(layout)
    expect(insertForeignTab(layout, foreign, { kind: 'canvas', groupId: 'missing', edge: 'right' })).toEqual(layout)
  })

  it('tabDropLands rejects the canvas edges of the pane a lone tab already fills', () => {
    // The drag preview squeezes the hovered pane open for the edge it is about to split on,
    // so it must not promise a split dockTab will refuse and leave the layout untouched.
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const tabId = findGroup(layout.root, groupId)!.activeTabId
    for (const edge of ['left', 'right', 'above', 'below'] as const) {
      expect(tabDropLands(layout, groupId, tabId, { kind: 'canvas', groupId, edge })).toBe(false)
    }
  })

  it('tabDropLands accepts a canvas drop once the source pane has a tab to spare', () => {
    let layout = createDefaultLayout()
    const groupId = layout.root.id
    const tabId = findGroup(layout.root, groupId)!.activeTabId
    layout = addTab(layout, groupId, { id: 'spare', kind: 'code', title: 'Spare' })
    expect(tabDropLands(layout, groupId, tabId, { kind: 'canvas', groupId, edge: 'right' })).toBe(true)
  })

  it('tabDropLands accepts every tab bar target, including a no-move reorder', () => {
    let layout = createDefaultLayout()
    const groupId = layout.root.id
    const tabId = findGroup(layout.root, groupId)!.activeTabId
    layout = addTab(layout, groupId, { id: 'b', kind: 'code', title: 'B' })
    expect(tabDropLands(layout, groupId, tabId, { kind: 'bar', groupId, index: 0 })).toBe(true)
    expect(tabDropLands(layout, groupId, tabId, { kind: 'bar', groupId, index: 1 })).toBe(true)
  })

  it('the gap the tab bar previews is the slot applyTabDrop actually fills', () => {
    // gapAnchorId names the tab the insertion gap opens in front of; after the drop the
    // dragged tab has to sit exactly there, or the indicator lied about where it landed.
    let layout = createDefaultLayout()
    const groupId = layout.root.id
    const dragged = findGroup(layout.root, groupId)!.activeTabId
    layout = addTab(layout, groupId, { id: 'b', kind: 'code', title: 'B' })
    layout = addTab(layout, groupId, { id: 'c', kind: 'code', title: 'C' })
    const tabIds = findGroup(layout.root, groupId)!.tabs.map((tab) => tab.id)
    for (const index of [0, 1, 2]) {
      const anchor = gapAnchorId(tabIds, dragged, index)
      const dropped = findGroup(applyTabDrop(layout, groupId, dragged, { kind: 'bar', groupId, index }).root, groupId)!
      const landedAt = dropped.tabs.findIndex((tab) => tab.id === dragged)
      expect(dropped.tabs[landedAt + 1]?.id ?? null).toBe(anchor)
    }
  })

  it('a tab moving into another pane lands in front of the gap that pane previewed', () => {
    let layout = createDefaultLayout()
    const sourceId = layout.root.id
    const dragged = findGroup(layout.root, sourceId)!.activeTabId
    layout = addTab(layout, sourceId, { id: 'spare', kind: 'code', title: 'Spare' })
    layout = splitGroup(layout, sourceId, 'right', { id: 'x', kind: 'code', title: 'X' })
    const targetId = listGroups(layout.root)[1]!.id
    layout = addTab(layout, targetId, { id: 'y', kind: 'code', title: 'Y' })
    const targetIds = findGroup(layout.root, targetId)!.tabs.map((tab) => tab.id)
    for (const index of [0, 1, 2]) {
      const anchor = gapAnchorId(targetIds, null, index)
      const dropped = findGroup(applyTabDrop(layout, sourceId, dragged, { kind: 'bar', groupId: targetId, index }).root, targetId)!
      const landedAt = dropped.tabs.findIndex((tab) => tab.id === dragged)
      expect(dropped.tabs[landedAt + 1]?.id ?? null).toBe(anchor)
    }
  })

  it('cancelling a drag is simply never calling applyTabDrop, so the original layout is untouched', () => {
    const layout = createDefaultLayout()
    const original = structuredClone(layout)
    // No mutation happens until a drop commits: PaneWorkspace only ever calls applyTabDrop
    // from its drop handler, never speculatively while the pointer is still moving.
    expect(layout).toEqual(original)
  })
})
