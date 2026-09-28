import { useEffect, useMemo, useState } from 'react'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { AgentActivityPhase, WorkspaceLayout } from '../../../shared/models'
import { buildWorkspaceClarity, type AgentTabFacts, type WorkspaceClarity } from '../../../shared/workspace-clarity'
import { listGroups } from './layout-operations'

const EMPTY: ReadonlyMap<string, AgentActivityPhase> = new Map()

/**
 * The sidebar's and the tab strip's reading of one workspace (src/shared/workspace-clarity.ts):
 * which tab is MAIN, what is live, what is done, and which finished tabs the strip leaves out.
 * Facts main holds (wizard, handed off, when each settled) are fetched for the workspace's agent
 * tabs whenever their phases change, and every few seconds while the window is visible.
 */
export function useWorkspaceClarity(layout: WorkspaceLayout, links: readonly AgentControlLink[], phases: ReadonlyMap<string, AgentActivityPhase> | undefined, enabled = true): WorkspaceClarity {
  const [facts, setFacts] = useState<Record<string, AgentTabFacts>>({})
  const panes = useMemo(() => listGroups(layout.root).map(group => ({ groupId: group.id, tabs: group.tabs, activeTabId: group.activeTabId })), [layout])
  const ids = useMemo(() => [...new Set(panes.flatMap(pane => pane.tabs.flatMap(tab => tab.kind === 'agent' && tab.resourceId ? [tab.resourceId] : [])))].sort(), [panes])
  const idKey = ids.join('|')
  // Only the phases of this workspace's own conversations decide when to ask again.
  const phaseKey = ids.map(id => phases?.get(id) ?? '').join('|')
  useEffect(() => {
    if (!enabled || !ids.length) { setFacts({}); return }
    let disposed = false, loading = false
    const refresh = async (): Promise<void> => {
      if (loading) return
      loading = true
      try { const next = await window.conductor.workspaceClarity.facts(ids); if (!disposed) setFacts(next) }
      catch { /* transient; the next tick retries */ }
      finally { loading = false }
    }
    void refresh()
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
    return () => { disposed = true; clearInterval(interval) }
  }, [idKey, phaseKey, enabled])
  return useMemo(() => buildWorkspaceClarity({ panes, links, phases: phases ?? EMPTY, facts }), [panes, links, phases, facts])
}
