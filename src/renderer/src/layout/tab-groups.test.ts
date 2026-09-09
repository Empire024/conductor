import { describe, expect, it } from 'vitest'
import type { PaneGroupNode, PaneTab, WorkspaceLayout } from '../../../shared/models'
import {
  addTab,
  applyTabDrop,
  closeTab,
  closeTabGroup,
  collapseTabGroup,
  findGroup,
  groupTabs,
  instantiateLayout,
  activateTab,
  assignTabsToGroup,
  reorderTab,
  ungroupTabGroup
} from './layout-operations'
import {
  createTabGroup,
  groupIdAtInsertion,
  normalizeTabGroups,
  setTabGroupCollapsed,
  tabStripSlots
} from './tab-groups'

const tab = (id: string, tabGroupId?: string): PaneTab => ({ id, kind: 'agent', title: id.toUpperCase(), tabGroupId })

const pane = (tabs: PaneTab[], activeTabId = tabs[0]!.id, tabGroups?: PaneGroupNode['tabGroups']): PaneGroupNode => ({
  type: 'group',
  id: 'pane1',
  tabs,
  activeTabId,
  ...(tabGroups ? { tabGroups } : {})
})

const layoutOf = (node: PaneGroupNode): WorkspaceLayout => ({ version: 1, root: node })

const group = (id: string, patch: Partial<{ title: string; collapsed: boolean }> = {}): NonNullable<PaneGroupNode['tabGroups']>[number] =>
  ({ id, title: patch.title ?? id, color: 'blue', collapsed: patch.collapsed ?? false })

const titlesOf = (node: PaneGroupNode): string[] => node.tabs.map((item) => item.id)

describe('tab group invariants', () => {
  it('pulls a scattered group into one run anchored at its first member', () => {
    const next = normalizeTabGroups(pane([tab('a', 'g'), tab('b'), tab('c', 'g')], 'a', [group('g')]))
    expect(titlesOf(next)).toEqual(['a', 'c', 'b'])
  })

  it('leaves an already contiguous pane exactly as it found it', () => {
    // PaneWorkspace renders panes by identity, so a no-op normalize must not remount them.
    const original = pane([tab('a', 'g'), tab('b', 'g'), tab('c')], 'a', [group('g')])
    expect(normalizeTabGroups(original)).toBe(original)
  })

  it('drops a group record once its last tab has left, and untags orphans', () => {
    const emptied = normalizeTabGroups(pane([tab('a'), tab('b')], 'a', [group('g')]))
    expect(emptied.tabGroups).toBeUndefined()
    const orphan = normalizeTabGroups(pane([tab('a', 'ghost')], 'a'))
    expect(orphan.tabs[0]!.tabGroupId).toBeUndefined()
  })
})

describe('where a dropped tab lands', () => {
  const strip = [tab('a'), tab('b', 'g'), tab('c', 'g'), tab('d')]

  it('absorbs a foreign tab only when it lands strictly inside the run', () => {
    expect(groupIdAtInsertion(strip, 2)).toBe('g')
    expect(groupIdAtInsertion(strip, 1)).toBeUndefined()
    expect(groupIdAtInsertion(strip, 3)).toBeUndefined()
  })

  it('keeps a member of the group grouped anywhere it still touches the run', () => {
    expect(groupIdAtInsertion(strip, 1, 'g')).toBe('g')
    expect(groupIdAtInsertion(strip, 3, 'g')).toBe('g')
    // Past the run entirely, the tab has genuinely been dragged out.
    expect(groupIdAtInsertion(strip, 4, 'g')).toBeUndefined()
    expect(groupIdAtInsertion(strip, 0, 'g')).toBeUndefined()
  })
})

describe('dragging tabs in and out of a group', () => {
  const start = layoutOf(pane([tab('a'), tab('b', 'g'), tab('c', 'g'), tab('d')], 'a', [group('g')]))

  it('joins the group when dropped between two of its tabs', () => {
    // Index 1 of the strip with 'a' lifted out, i.e. the gap between 'b' and 'c'.
    const next = reorderTab(start, 'pane1', 'a', 1)
    const pane1 = findGroup(next.root, 'pane1')!
    expect(pane1.tabs.find((item) => item.id === 'a')!.tabGroupId).toBe('g')
    expect(titlesOf(pane1)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('leaves the group when its own tab is dragged clear of the run', () => {
    const next = reorderTab(start, 'pane1', 'b', 3)
    expect(findGroup(next.root, 'pane1')!.tabs.find((item) => item.id === 'b')!.tabGroupId).toBeUndefined()
  })

  it('stays in the group when reordered against the run edge', () => {
    const next = reorderTab(start, 'pane1', 'c', 1)
    const pane1 = findGroup(next.root, 'pane1')!
    expect(pane1.tabs.find((item) => item.id === 'c')!.tabGroupId).toBe('g')
    expect(titlesOf(pane1)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('drops the group when the tab peels off into a pane of its own', () => {
    const next = applyTabDrop(start, 'pane1', 'b', { kind: 'canvas', groupId: 'pane1', edge: 'right' })
    const peeled = findGroup(next.root, 'pane1')
    const other = [next.root].flatMap((node) => (node.type === 'split' ? node.children : [node]))
    expect(peeled).not.toBeNull()
    const landed = other.map((node) => (node.type === 'group' ? node : null)).find((node) => node?.tabs.some((item) => item.id === 'b'))
    expect(landed!.tabs[0]!.tabGroupId).toBeUndefined()
    expect(landed!.tabGroups).toBeUndefined()
  })

  it('adopts the group of the slot a new tab is inserted into', () => {
    const next = addTab(start, 'pane1', tab('new'), 2)
    expect(findGroup(next.root, 'pane1')!.tabs.find((item) => item.id === 'new')!.tabGroupId).toBe('g')
  })
})

describe('collapsing', () => {
  it('renders a collapsed group as a single slot standing for all its tabs', () => {
    const collapsed = pane([tab('a'), tab('b', 'g'), tab('c', 'g')], 'a', [group('g', { collapsed: true })])
    const slots = tabStripSlots(collapsed)
    expect(slots).toHaveLength(2)
    expect(slots[1]).toMatchObject({ kind: 'group', collapsed: true })
    expect(slots[1]!.kind === 'group' && slots[1]!.tabs).toHaveLength(2)
  })

  it('hands activation to a tab outside the group it is hiding', () => {
    const next = setTabGroupCollapsed(pane([tab('a', 'g'), tab('b', 'g'), tab('c')], 'a', [group('g')]), 'g', true)
    expect(next.activeTabId).toBe('c')
  })

  it('refuses to collapse when it would leave the pane with nothing to show', () => {
    const next = setTabGroupCollapsed(pane([tab('a', 'g'), tab('b', 'g')], 'a', [group('g')]), 'g', true)
    expect(next.tabGroups![0]!.collapsed).toBe(false)
  })

  it('expands the group again when one of its tabs is activated', () => {
    const start = layoutOf(pane([tab('a'), tab('b', 'g')], 'a', [group('g', { collapsed: true })]))
    const next = activateTab(start, 'pane1', 'b')
    const pane1 = findGroup(next.root, 'pane1')!
    expect(pane1.tabGroups![0]!.collapsed).toBe(false)
    expect(pane1.activeTabId).toBe('b')
  })
})

describe('group commands', () => {
  const start = layoutOf(pane([tab('a'), tab('b'), tab('c')], 'a'))

  it('creates a group and reports its id so the chip can be named', () => {
    const result = groupTabs(start, 'pane1', ['a', 'c'])
    const pane1 = findGroup(result.layout.root, 'pane1')!
    expect(result.tabGroupId).toBeTruthy()
    expect(titlesOf(pane1)).toEqual(['a', 'c', 'b'])
    expect(pane1.tabGroups).toHaveLength(1)
  })

  it('gives each new group a colour the pane is not already using', () => {
    const first = createTabGroup(pane([tab('a'), tab('b')], 'a'), ['a'])
    const second = createTabGroup(first.pane, ['b'])
    expect(second.pane.tabGroups![0]!.color).not.toBe(second.pane.tabGroups![1]!.color)
  })

  it('ungroups without closing anything', () => {
    const grouped = groupTabs(start, 'pane1', ['a', 'b'])
    const next = ungroupTabGroup(grouped.layout, 'pane1', grouped.tabGroupId)
    const pane1 = findGroup(next.root, 'pane1')!
    expect(pane1.tabs).toHaveLength(3)
    expect(pane1.tabGroups).toBeUndefined()
  })

  it('closes every tab in the group and reports them for the reopen stack', () => {
    const grouped = groupTabs(start, 'pane1', ['a', 'b'])
    const result = closeTabGroup(grouped.layout, 'pane1', grouped.tabGroupId)
    expect(result.closed.map((item) => item.id).sort()).toEqual(['a', 'b'])
    expect(findGroup(result.layout.root, 'pane1')!.tabs.map((item) => item.id)).toEqual(['c'])
  })

  it('moves a tab between existing groups', () => {
    const first = groupTabs(start, 'pane1', ['a'])
    const second = groupTabs(first.layout, 'pane1', ['c'])
    const next = assignTabsToGroup(second.layout, 'pane1', ['a'], second.tabGroupId)
    const pane1 = findGroup(next.root, 'pane1')!
    expect(pane1.tabs.find((item) => item.id === 'a')!.tabGroupId).toBe(second.tabGroupId)
    // The group 'a' left behind held nothing else, so it is gone.
    expect(pane1.tabGroups).toHaveLength(1)
  })

  it('forgets a group once its last tab closes', () => {
    const grouped = groupTabs(start, 'pane1', ['a'])
    const next = closeTab(grouped.layout, 'pane1', 'a').layout
    expect(findGroup(next.root, 'pane1')!.tabGroups).toBeUndefined()
  })
})

describe('persistence', () => {
  it('survives a save/load round trip through JSON', () => {
    const grouped = groupTabs(layoutOf(pane([tab('a'), tab('b'), tab('c')], 'a')), 'pane1', ['a', 'b'], { title: 'Bug 42' })
    const restored = JSON.parse(JSON.stringify(grouped.layout)) as WorkspaceLayout
    const pane1 = findGroup(restored.root, 'pane1')!
    expect(pane1.tabGroups![0]).toMatchObject({ title: 'Bug 42', collapsed: false })
    expect(pane1.tabs.filter((item) => item.tabGroupId === grouped.tabGroupId)).toHaveLength(2)
  })

  it('keeps a collapsed group collapsed across a reload', () => {
    const grouped = groupTabs(layoutOf(pane([tab('a'), tab('b'), tab('c')], 'c')), 'pane1', ['a', 'b'])
    const collapsed = collapseTabGroup(grouped.layout, 'pane1', grouped.tabGroupId, true)
    const restored = JSON.parse(JSON.stringify(collapsed)) as WorkspaceLayout
    expect(findGroup(restored.root, 'pane1')!.tabGroups![0]!.collapsed).toBe(true)
  })

  it('copies groups rather than sharing them when a template is instantiated', () => {
    const grouped = groupTabs(layoutOf(pane([tab('a'), tab('b'), tab('c')], 'a')), 'pane1', ['a', 'b'], { title: 'Docs' })
    const copy = instantiateLayout(grouped.layout)
    const copied = copy.root as PaneGroupNode
    expect(copied.tabGroups![0]!.title).toBe('Docs')
    expect(copied.tabGroups![0]!.id).not.toBe(grouped.tabGroupId)
    expect(copied.tabs.filter((item) => item.tabGroupId === copied.tabGroups![0]!.id)).toHaveLength(2)
  })

  it('loads a layout saved before tab groups existed', () => {
    const legacy = JSON.parse(JSON.stringify(layoutOf(pane([tab('a'), tab('b')], 'a')))) as WorkspaceLayout
    const next = addTab(legacy, 'pane1', tab('c'))
    const pane1 = findGroup(next.root, 'pane1')!
    expect(pane1.tabGroups).toBeUndefined()
    expect(pane1.tabs).toHaveLength(3)
  })
})
