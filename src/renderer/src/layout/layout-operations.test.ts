import { describe, expect, it } from 'vitest'
import { createDefaultLayout, makeLauncherTab } from '../../../shared/models'
import { addTab, closeTab, dockTab, findGroup, instantiateLayout, listGroups, splitGroup, stripWorkspaceUtilityTabs } from './layout-operations'

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
})
