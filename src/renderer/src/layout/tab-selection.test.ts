import { describe, expect, it } from 'vitest'
import type { PaneTab, SessionRecord, WorkspaceLayout } from '../../../shared/models'
import { listGroups } from './layout-operations'
import { applyBulkTabAction, dockTabsAt, EMPTY_SELECTION, insertForeignTabs, moveTabsToBar, pruneSelection, selectAll, selectionClick } from './tab-selection'

const order = ['a', 'b', 'c', 'd', 'e']
const ids = (selection: { ids: ReadonlySet<string> }): string[] => [...selection.ids].sort()
const tab = (id: string): PaneTab => ({ id, kind: 'terminal', title: id.toUpperCase(), resourceId: 'terminal_' + id })
const twoPanes = (): WorkspaceLayout => ({ version: 1, root: { type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [
  { type: 'group', id: 'left', tabs: ['a', 'b', 'c'].map(tab), activeTabId: 'a' },
  { type: 'group', id: 'right', tabs: ['d', 'e'].map(tab), activeTabId: 'd' }
] } })
const strip = (layout: WorkspaceLayout): Record<string, string[]> => Object.fromEntries(listGroups(layout.root).map(group => [group.id, group.tabs.map(item => item.id)]))
const session = (layout: WorkspaceLayout): SessionRecord => ({ id: 's', projectId: 'p', name: 'W', layout, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' })

describe('Explorer-style tab selection', () => {
  it('Ctrl+click adds to the tab on screen, and toggles', () => {
    let selection = selectionClick(order, EMPTY_SELECTION, 'c', 'a', { ctrl: true, shift: false })
    expect(ids(selection)).toEqual(['a', 'c'])
    selection = selectionClick(order, selection, 'a', 'a', { ctrl: true, shift: false })
    expect(ids(selection)).toEqual(['c'])
  })
  it('Shift+click selects the range from the anchor; Ctrl+Shift adds a range', () => {
    let selection = selectionClick(order, EMPTY_SELECTION, 'd', 'b', { ctrl: false, shift: true })
    expect(ids(selection)).toEqual(['b', 'c', 'd'])
    selection = selectionClick(order, selection, 'a', 'b', { ctrl: false, shift: true })
    expect(ids(selection)).toEqual(['a', 'b'])
    selection = selectionClick(order, { ids: new Set(['e']), anchor: 'e' }, 'c', 'b', { ctrl: true, shift: true })
    expect(ids(selection)).toEqual(['c', 'd', 'e'])
  })
  it('a plain click selects one; Ctrl+A all; closed tabs drop out', () => {
    expect(ids(selectionClick(order, selectAll(order), 'b', 'a', { ctrl: false, shift: false }))).toEqual(['b'])
    const all = selectAll(order)
    expect(ids(all)).toEqual(order)
    expect(ids(pruneSelection(all, ['a', 'e']))).toEqual(['a', 'e'])
    expect(pruneSelection(all, order)).toBe(all)
  })
})

describe('moving a selection', () => {
  it('drops a selection from two panes into a strip index, keeping its order', () => {
    const moved = moveTabsToBar(twoPanes(), ['a', 'e'], 'right', 0, 'e')
    expect(strip(moved)).toEqual({ left: ['b', 'c'], right: ['a', 'e', 'd'] })
  })
  it('reorders within one strip in front of the first unselected tab', () => {
    const moved = moveTabsToBar(twoPanes(), ['a', 'b'], 'left', 2, 'a')
    expect(strip(moved)).toEqual({ left: ['c', 'a', 'b'], right: ['d', 'e'] })
  })
  it('moves a whole pane into another, which collapses the split', () => {
    const moved = moveTabsToBar(twoPanes(), ['d', 'e'], 'left', 99)
    expect(strip(moved)).toEqual({ left: ['a', 'b', 'c', 'd', 'e'] })
  })
  it('docks a selection at a pane edge, but never empties the pane it splits', () => {
    const docked = dockTabsAt(twoPanes(), ['b', 'e'], 'left', 'below')
    expect(Object.values(strip(docked)).sort()).toEqual([['a', 'c'], ['b', 'e'], ['d']].sort())
    const whole = twoPanes()
    expect(dockTabsAt(whole, ['d', 'e'], 'right', 'left')).toBe(whole)
  })
  it('inserts tabs dragged in from another window together', () => {
    const layout = insertForeignTabs(twoPanes(), [tab('x'), tab('y'), tab('a')], { kind: 'bar', groupId: 'right', index: 1 })
    expect(strip(layout).right).toEqual(['d', 'x', 'y', 'e'])
  })
})

describe('bulk actions', () => {
  it('close returns every closed tab and keeps the reopen list capped', () => {
    const start = { ...session(twoPanes()), closedTabs: Array.from({ length: 19 }, (_, index) => tab('old' + index)) }
    const result = applyBulkTabAction(start, ['b', 'd', 'e'], { kind: 'close' })
    expect(result.removed.map(item => item.id)).toEqual(['b', 'd', 'e'])
    expect(strip(result.session.layout)).toEqual({ left: ['a', 'c'] })
    expect(result.session.closedTabs).toHaveLength(20)
    expect(result.session.closedTabs.at(-1)!.id).toBe('e')
  })
  it('detach takes the tabs out without adding them to the reopen list', () => {
    const result = applyBulkTabAction(session(twoPanes()), ['a', 'b'], { kind: 'detach' })
    expect(result.removed.map(item => item.id)).toEqual(['a', 'b'])
    expect(result.session.closedTabs).toEqual([])
  })
  it('move and new tab group', () => {
    expect(strip(applyBulkTabAction(session(twoPanes()), ['a', 'b'], { kind: 'move', groupId: 'right' }).session.layout)).toEqual({ left: ['c'], right: ['d', 'e', 'a', 'b'] })
    const grouped = applyBulkTabAction(session(twoPanes()), ['a', 'c'], { kind: 'new-tab-group' }).session.layout
    const left = listGroups(grouped.root).find(group => group.id === 'left')!
    expect(left.tabGroups).toHaveLength(1)
    expect(left.tabs.filter(item => item.tabGroupId).map(item => item.id)).toEqual(['a', 'c'])
  })
})
