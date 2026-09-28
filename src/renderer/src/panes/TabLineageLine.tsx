import { useEffect, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import type { TabLineage } from '../../../shared/tab-archive'
import { currentConversationDirectory, focusDirectoryEntry } from '../conversation-directory'

/** One read per conversation per window: who opened it does not change. */
const cache = new Map<string, Promise<TabLineage | null>>()
export function lineageOf(agentSessionId: string): Promise<TabLineage | null> {
  let pending = cache.get(agentSessionId)
  if (!pending) {
    pending = window.conductor.tabArchive.lineage(agentSessionId).catch(() => null)
    cache.set(agentSessionId, pending)
    // A miss may be a tab whose opener is recorded a moment later; it is asked again next time.
    void pending.then(lineage => { if (!lineage) cache.delete(agentSessionId) })
  }
  return pending
}

/**
 * Brings the opener's tab into view: an open one wherever it is, a closed one back from the
 * workspace archive, else the reopen list main still holds (focusOrigin).
 */
export async function showLineage(lineage: TabLineage): Promise<void> {
  const open = currentConversationDirectory().byAgent.get(lineage.agentSessionId)
  if (open) return focusDirectoryEntry(open)
  if (lineage.archived) { await window.conductor.tabArchive.reopen(lineage.archived.sessionId, [lineage.archived.tabId]); return }
  return window.conductor.agentControl.focusOrigin(lineage.agentSessionId)
}

/** The first line of a tab an agent opened: rendered from recorded link data, no model involved. */
export function TabLineageLine({ agentSessionId }: { agentSessionId: string }): React.JSX.Element | null {
  const [lineage, setLineage] = useState<TabLineage | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLineage(null)
    void lineageOf(agentSessionId).then(value => { if (live) setLineage(value) })
    return () => { live = false }
  }, [agentSessionId])
  if (!lineage) return null
  return <div className="sa-lineage-line" data-lineage={lineage.relation} data-lineage-agent={lineage.agentSessionId}>
    <CornerDownRight size={12} aria-hidden="true" />
    <span>{lineage.relation === 'continued' ? 'Continued from' : 'Opened by'}</span>
    <button type="button" title={`Show ${lineage.title}${lineage.archived ? ' (reopens it from the archive)' : ''}`} onClick={() => { setError(''); void window.conductor.tabArchive.lineage(agentSessionId).then(fresh => showLineage(fresh ?? lineage)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }}>{lineage.title}</button>
    {lineage.archived && <small>archived</small>}
    {error && <small role="status">{error}</small>}
  </div>
}
