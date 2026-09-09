/** Chrome-style tab groups: the pure, pane-local half of the model. Membership lives on the
 * tabs themselves (`PaneTab.tabGroupId`) and the pane only carries the presentation records,
 * so every operation here reduces to "retag some tabs, then restore the invariant".
 *
 * The invariant, and Chrome's: a group's tabs are always one contiguous run in the strip, and
 * a group exists exactly as long as a tab points at it. `normalizeTabGroups` re-establishes
 * both, which is why the generic tab operations in layout-operations.ts can splice tabs around
 * freely and simply normalize afterwards.
 *
 * Beware the two meanings of "group" in this codebase: `PaneGroupNode` is a *pane*, and
 * `TabGroup` is the Chrome-style group. Parameters named `pane` are always the former. */
import type { PaneGroupNode, PaneTab, TabGroup, TabGroupColor } from '../../../shared/models'
import { TAB_GROUP_COLORS, makeId } from '../../../shared/models'

/** Everything the group menus can ask for. Group actions carry a target, so they travel
 * beside the plain `WorkspaceTabAction` string union rather than inside it; both are applied
 * through workspace-tab-actions.ts so the tab strip and the sidebar list behave identically. */
export type TabGroupAction =
  | { kind: 'new-group' }
  | { kind: 'join-group'; tabGroupId: string }
  | { kind: 'leave-group' }
  | { kind: 'rename'; tabGroupId: string; title: string }
  | { kind: 'recolor'; tabGroupId: string; color: TabGroupColor }
  | { kind: 'new-tab-in-group'; tabGroupId: string }
  | { kind: 'collapse'; tabGroupId: string; collapsed: boolean }
  | { kind: 'ungroup'; tabGroupId: string }
  | { kind: 'close-group'; tabGroupId: string }

export const tabGroupsOf = (pane: PaneGroupNode): TabGroup[] => pane.tabGroups ?? []

export const findTabGroup = (pane: PaneGroupNode, tabGroupId: string): TabGroup | undefined =>
  tabGroupsOf(pane).find((group) => group.id === tabGroupId)

export const tabsInGroup = (pane: PaneGroupNode, tabGroupId: string): PaneTab[] =>
  pane.tabs.filter((tab) => tab.tabGroupId === tabGroupId)

/** Pulls each group's tabs together into one run, anchored where the group's first member
 * already sits, so grouping a scattered selection moves tabs the shortest sensible distance. */
const orderByGroup = (tabs: PaneTab[]): PaneTab[] => {
  const ordered: PaneTab[] = []
  const emitted = new Set<string>()
  for (const tab of tabs) {
    const groupId = tab.tabGroupId
    if (!groupId) {
      ordered.push(tab)
      continue
    }
    if (emitted.has(groupId)) continue
    emitted.add(groupId)
    for (const member of tabs) if (member.tabGroupId === groupId) ordered.push(member)
  }
  return ordered
}

const sameOrder = (a: PaneTab[], b: PaneTab[]): boolean =>
  a.length === b.length && a.every((tab, index) => tab === b[index])

/** Restores the contiguity invariant and drops group records nothing points at any more.
 * Returns `pane` itself when it was already well formed: callers splice tabs and normalize
 * unconditionally, and the panes React renders must keep their identity when untouched. */
export const normalizeTabGroups = (pane: PaneGroupNode): PaneGroupNode => {
  const live = new Set(pane.tabs.map((tab) => tab.tabGroupId).filter(Boolean) as string[])
  const groups = tabGroupsOf(pane).filter((group) => live.has(group.id))
  // A tabGroupId with no record left (a group closed from under it, or a stale persisted
  // layout) would render as an invisible group, so strip it off the tab instead.
  const known = new Set(groups.map((group) => group.id))
  const tagged = pane.tabs.map((tab) =>
    tab.tabGroupId && !known.has(tab.tabGroupId) ? { ...tab, tabGroupId: undefined } : tab
  )
  const tabs = orderByGroup(tagged)
  const groupsUnchanged =
    groups.length === tabGroupsOf(pane).length && groups.every((group, index) => group === tabGroupsOf(pane)[index])
  if (sameOrder(tabs, pane.tabs) && groupsUnchanged) return pane
  const next: PaneGroupNode = { ...pane, tabs }
  if (groups.length) next.tabGroups = groups
  else delete next.tabGroups
  return next
}

/** Which group a tab dropped at `index` joins, where `tabs` is the strip *without* the tab
 * being placed and `currentGroupId` is the group it is coming from.
 *
 * Two Chrome rules meet here. A tab joining a group it is not in must land strictly inside
 * the run - landing on a boundary leaves it ungrouped, which is what makes it possible to
 * drag a tab out of a group along its own strip at all. A tab already in the group instead
 * keeps its membership anywhere it still touches the run, including at either end, so
 * reordering a tab within its own group never quietly ejects it. */
export const groupIdAtInsertion = (
  tabs: PaneTab[],
  index: number,
  currentGroupId?: string
): string | undefined => {
  const before = tabs[index - 1]?.tabGroupId
  const after = tabs[index]?.tabGroupId
  if (currentGroupId && (before === currentGroupId || after === currentGroupId)) return currentGroupId
  return before && before === after ? before : undefined
}

const nextColor = (pane: PaneGroupNode): TabGroupColor => {
  const used = new Set(tabGroupsOf(pane).map((group) => group.color))
  return TAB_GROUP_COLORS.find((color) => !used.has(color)) ?? TAB_GROUP_COLORS[0]
}

/** Puts `tabIds` in a brand new group. The caller gets the id back so it can immediately open
 * the rename editor on the new chip, as Chrome does. */
export const createTabGroup = (
  pane: PaneGroupNode,
  tabIds: string[],
  init: Partial<Omit<TabGroup, 'id'>> = {}
): { pane: PaneGroupNode; tabGroupId: string } => {
  const wanted = new Set(tabIds)
  if (!pane.tabs.some((tab) => wanted.has(tab.id))) return { pane, tabGroupId: '' }
  const group: TabGroup = {
    id: makeId('tabgroup'),
    title: init.title ?? '',
    color: init.color ?? nextColor(pane),
    collapsed: init.collapsed ?? false
  }
  const staged: PaneGroupNode = {
    ...pane,
    tabGroups: [...tabGroupsOf(pane), group],
    tabs: pane.tabs.map((tab) => (wanted.has(tab.id) ? { ...tab, tabGroupId: group.id } : tab))
  }
  return { pane: normalizeTabGroups(staged), tabGroupId: group.id }
}

/** Moves `tabIds` into `tabGroupId`, or out of any group when it is null. */
export const setTabsGroup = (
  pane: PaneGroupNode,
  tabIds: string[],
  tabGroupId: string | null
): PaneGroupNode => {
  if (tabGroupId !== null && !findTabGroup(pane, tabGroupId)) return pane
  const wanted = new Set(tabIds)
  const staged: PaneGroupNode = {
    ...pane,
    tabs: pane.tabs.map((tab) =>
      wanted.has(tab.id) ? { ...tab, tabGroupId: tabGroupId ?? undefined } : tab
    )
  }
  return normalizeTabGroups(staged)
}

export const updateTabGroup = (
  pane: PaneGroupNode,
  tabGroupId: string,
  patch: Partial<Omit<TabGroup, 'id'>>
): PaneGroupNode => {
  if (!findTabGroup(pane, tabGroupId)) return pane
  return {
    ...pane,
    tabGroups: tabGroupsOf(pane).map((group) =>
      group.id === tabGroupId ? { ...group, ...patch } : group
    )
  }
}

/** Collapsing the group that owns the active tab has to hand activation to a tab outside it,
 * or the pane would be showing a tab the strip no longer displays. Chrome picks the nearest
 * tab after the group, falling back to the one before it. */
export const setTabGroupCollapsed = (
  pane: PaneGroupNode,
  tabGroupId: string,
  collapsed: boolean
): PaneGroupNode => {
  const next = updateTabGroup(pane, tabGroupId, { collapsed })
  if (next === pane || !collapsed) return next
  const active = next.tabs.find((tab) => tab.id === next.activeTabId)
  if (!active || active.tabGroupId !== tabGroupId) return next
  const lastIndex = next.tabs.map((tab) => tab.tabGroupId).lastIndexOf(tabGroupId)
  const firstIndex = next.tabs.findIndex((tab) => tab.tabGroupId === tabGroupId)
  const outside =
    next.tabs.slice(lastIndex + 1).find((tab) => tab.tabGroupId !== tabGroupId) ??
    [...next.tabs.slice(0, firstIndex)].reverse().find((tab) => tab.tabGroupId !== tabGroupId)
  // A pane holding nothing but one collapsed group would have no tab to show, so keep it open.
  if (!outside) return updateTabGroup(pane, tabGroupId, { collapsed: false })
  return { ...next, activeTabId: outside.id }
}

/** Activating a tab inside a collapsed group expands it, exactly as Chrome does when you
 * reach one with Ctrl+Tab or the tab search menu. */
export const expandGroupContaining = (pane: PaneGroupNode, tabId: string): PaneGroupNode => {
  const tab = pane.tabs.find((item) => item.id === tabId)
  if (!tab?.tabGroupId || !findTabGroup(pane, tab.tabGroupId)?.collapsed) return pane
  return updateTabGroup(pane, tab.tabGroupId, { collapsed: false })
}

/** One entry of the rendered strip: either a lone tab, or a group (its chip plus the tabs it
 * still shows, which is none while collapsed). Both the renderer and the drag geometry read
 * the strip through this so they agree on what is on screen. */
export type TabStripSlot =
  | { kind: 'tab'; tab: PaneTab }
  | { kind: 'group'; group: TabGroup; tabs: PaneTab[]; collapsed: boolean }

export const tabStripSlots = (pane: PaneGroupNode): TabStripSlot[] => {
  const slots: TabStripSlot[] = []
  for (const tab of pane.tabs) {
    const group = tab.tabGroupId ? findTabGroup(pane, tab.tabGroupId) : undefined
    if (!group) {
      slots.push({ kind: 'tab', tab })
      continue
    }
    const last = slots.at(-1)
    if (last?.kind === 'group' && last.group.id === group.id) {
      last.tabs.push(tab)
      continue
    }
    slots.push({ kind: 'group', group, tabs: [tab], collapsed: group.collapsed })
  }
  return slots
}
