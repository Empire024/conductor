import type { LayoutNode, PaneGroupNode, PaneTab, WorkspaceLayout } from '../shared/models'

const groups = (node: LayoutNode): PaneGroupNode[] => node.type === 'group' ? [node] : node.children.flatMap(groups)

/** A stale renderer may omit live work; only an explicit close or a move may remove it. */
export function guardLayoutSave({ previous, next, closedTabs, elsewhereTabIds, elsewhereResourceIds = new Set<string>(), hasLiveWork }: {
  previous: WorkspaceLayout | null
  next: WorkspaceLayout
  closedTabs: PaneTab[]
  elsewhereTabIds: Set<string>
  elsewhereResourceIds?: Set<string>
  hasLiveWork(agentSessionId: string): boolean
}): { layout: WorkspaceLayout; restoredTabIds: string[] } {
  if (!previous) return { layout: next, restoredTabIds: [] }
  const targets = groups(next.root)
  const present = new Set([...targets.flatMap(group => group.tabs.map(tab => tab.id)), ...closedTabs.map(tab => tab.id), ...elsewhereTabIds])
  const resources = new Set([...targets.flatMap(group => group.tabs.filter(tab => tab.kind === 'agent').map(tab => tab.resourceId)), ...elsewhereResourceIds])
  const additions = new Map<string, PaneTab[]>()
  const restoredTabIds: string[] = []
  for (const group of groups(previous.root)) for (const tab of group.tabs) {
    if (present.has(tab.id) || tab.kind !== 'agent' || !tab.resourceId || resources.has(tab.resourceId) || !hasLiveWork(tab.resourceId)) continue
    const target = targets.find(candidate => candidate.id === group.id) ?? targets[0]
    if (!target) continue
    additions.set(target.id, [...(additions.get(target.id) ?? []), tab])
    present.add(tab.id)
    resources.add(tab.resourceId)
    restoredTabIds.push(tab.id)
  }
  if (!restoredTabIds.length) return { layout: next, restoredTabIds }
  const restore = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') return { ...node, children: [restore(node.children[0]), restore(node.children[1])] }
    const tabs = additions.get(node.id)
    return tabs ? { ...node, tabs: [...node.tabs, ...tabs], activeTabId: node.activeTabId || tabs[0]!.id } : node
  }
  return { layout: { ...next, root: restore(next.root) }, restoredTabIds }
}
