import type { AgentControlLink } from '../../../shared/agent-control'
import type { PaneTab } from '../../../shared/models'

export interface CoworkerTabGroup {
  controller: PaneTab
  coworkers: PaneTab[]
  /** The first member's persisted position. Rendering the group here avoids activity-driven moves. */
  insertionTabId: string
}

export interface CoworkerTabPresentation {
  groups: CoworkerTabGroup[]
  groupByTabId: ReadonlyMap<string, CoworkerTabGroup>
}

/**
 * Builds a render-only hierarchy from live control links. Explicit tab groups are left alone,
 * and links whose other endpoint is detached or in another pane degrade to standalone tabs.
 */
export function coworkerTabGroups(tabs: readonly PaneTab[], links: readonly AgentControlLink[]): CoworkerTabPresentation {
  const eligible = new Map(tabs.filter(tab => tab.kind === 'agent' && !tab.tabGroupId).map(tab => [tab.id, tab]))
  const parent = new Map<string, string>()
  for (const link of links) {
    if (eligible.has(link.controllerTabId) && eligible.has(link.controlledTabId) && link.controllerTabId !== link.controlledTabId) {
      parent.set(link.controlledTabId, link.controllerTabId)
    }
  }

  const rootOf = (tabId: string): string | undefined => {
    const seen = new Set<string>()
    let cursor = tabId
    while (parent.has(cursor)) {
      if (seen.has(cursor)) return undefined
      seen.add(cursor)
      cursor = parent.get(cursor)!
    }
    return seen.has(cursor) ? undefined : cursor
  }

  const members = new Map<string, PaneTab[]>()
  for (const tab of tabs) {
    if (!eligible.has(tab.id)) continue
    const root = rootOf(tab.id)
    if (!root || root === tab.id) continue
    const list = members.get(root) ?? []
    list.push(tab)
    members.set(root, list)
  }

  const index = new Map(tabs.map((tab, position) => [tab.id, position]))
  const groups: CoworkerTabGroup[] = []
  const groupByTabId = new Map<string, CoworkerTabGroup>()
  for (const [rootId, coworkers] of members) {
    const controller = eligible.get(rootId)
    if (!controller || !coworkers.length) continue
    const all = [controller, ...coworkers]
    const insertionTabId = all.reduce((first, tab) => (index.get(tab.id) ?? Infinity) < (index.get(first.id) ?? Infinity) ? tab : first).id
    const group = { controller, coworkers, insertionTabId }
    groups.push(group)
    for (const tab of all) groupByTabId.set(tab.id, group)
  }
  groups.sort((a, b) => (index.get(a.insertionTabId) ?? 0) - (index.get(b.insertionTabId) ?? 0))
  return { groups, groupByTabId }
}

/** Closing a controller closes its whole coworker group by default, the way closing a browser
 *  window closes its tabs - the group reads as one unit of work. Closing any other tab, or a
 *  controller through the "close this tab only" opt-out, affects only that one tab. */
export function coworkerCloseTargets(tab: PaneTab, presentation: CoworkerTabPresentation): PaneTab[] {
  const group = presentation.groupByTabId.get(tab.id)
  return group && group.controller.id === tab.id ? [group.controller, ...group.coworkers] : [tab]
}
