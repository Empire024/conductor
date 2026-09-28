import { describe, expect, it } from 'vitest'
import type { WorkspaceLayout } from '../../../shared/models'
import { tabPinned, tabSeenAt } from '../../../shared/workspace-clarity'
import { markTabsSeen, moveTabToFront, togglePinned } from './tab-seen'
import { applyWorkspaceTabAction } from './workspace-tab-actions'
import { listGroups } from './layout-operations'

const layout = (): WorkspaceLayout => ({ version: 1, root: { type: 'split', id: 's', direction: 'horizontal', sizes: [50, 50], children: [
  { type: 'group', id: 'a', activeTabId: 'one', tabs: [{ id: 'one', kind: 'agent', title: 'One', resourceId: 'agent_one' }, { id: 'file', kind: 'code', title: 'notes.md' }] },
  { type: 'group', id: 'b', activeTabId: 'two', tabs: [{ id: 'two', kind: 'agent', title: 'Two', resourceId: 'agent_two' }, { id: 'three', kind: 'agent', title: 'Three', resourceId: 'agent_three', tabGroupId: 'g' }, { id: 'four', kind: 'agent', title: 'Four', tabGroupId: 'g' }], tabGroups: [{ id: 'g', title: 'G', color: 'blue', collapsed: false }] }
] } })
const tab = (value: WorkspaceLayout, id: string) => listGroups(value.root).flatMap(group => group.tabs).find(item => item.id === id)!

describe('markTabsSeen', () => {
  it('stamps agent tabs in any pane, leaves other kinds and untouched panes alone', () => {
    const before = layout()
    const after = markTabsSeen(before, ['one', 'file', undefined], Date.parse('2026-09-28T10:00:00Z'))
    expect(tabSeenAt(tab(after, 'one'))).toBe(Date.parse('2026-09-28T10:00:00Z'))
    expect(tab(after, 'file').state).toBeUndefined()
    if (before.root.type !== 'split' || after.root.type !== 'split') throw new Error('split expected')
    expect(after.root.children[1]).toBe(before.root.children[1])
    expect(markTabsSeen(before, [])).toBe(before)
  })
  it('is what an owner focus does, for the tab shown and the one it replaces', () => {
    const session = { id: 'w', projectId: 'p', name: 'W', layout: layout(), maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' }
    const focused = applyWorkspaceTabAction(session, 'b', 'three', 'focus').session.layout
    expect(tabSeenAt(tab(focused, 'three'))).toBeDefined()
    expect(tabSeenAt(tab(focused, 'two'))).toBeDefined()
    expect(tabSeenAt(tab(focused, 'one'))).toBeUndefined()
  })
})

describe('togglePinned', () => {
  it('pins and unpins', () => {
    const pinned = togglePinned(layout(), 'two')
    expect(tabPinned(tab(pinned, 'two'))).toBe(true)
    expect(tabPinned(tab(togglePinned(pinned, 'two'), 'two'))).toBe(false)
  })
})

describe('moveTabToFront', () => {
  it('moves the MAIN to the front of its pane, taking its tab group along', () => {
    const moved = moveTabToFront(layout(), 'b', 'three')
    expect(listGroups(moved.root)[1]!.tabs.map(item => item.id)).toEqual(['three', 'four', 'two'])
    const already = layout()
    expect(moveTabToFront(already, 'b', 'two')).toStrictEqual(already)
  })
})
