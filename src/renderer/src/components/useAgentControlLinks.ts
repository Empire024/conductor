import { useEffect, useState } from 'react'
import type { AgentControlLink } from '../../../shared/agent-control'

/**
 * Reads the same agent-control link bridge AgentControlLinks draws as cable markers, so other
 * surfaces (like the workspace sidebar) can show controller/controlled state without a second
 * source of truth. Pass `enabled: false` to skip fetching while a consumer isn't visible.
 */
export function useAgentControlLinks(projectId: string, sessionId: string, enabled = true): AgentControlLink[] {
  const [links, setLinks] = useState<AgentControlLink[]>([])
  useEffect(() => {
    if (!enabled) { setLinks([]); return }
    let disposed = false, loading = false
    const refresh = async (): Promise<void> => {
      if (loading) return
      loading = true
      try { const next = await window.conductor.agentControl.links(projectId, sessionId); if (!disposed) setLinks(next) }
      catch { /* transient; the next interval tick or links-changed event retries */ }
      finally { loading = false }
    }
    void refresh()
    const off = window.conductor.agentControl.onLinksChanged(scope => { if (scope.projectId === projectId && scope.sessionId === sessionId) void refresh() })
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
    return () => { disposed = true; off(); clearInterval(interval) }
  }, [projectId, sessionId, enabled])
  return links
}
