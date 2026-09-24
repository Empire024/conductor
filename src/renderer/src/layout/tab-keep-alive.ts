import type { AgentEffort, AgentProviderId, AgentSpec, PaneTab, ProjectRecord, SessionRecord } from '../../../shared/models'

/**
 * Which inactive tabs keep their React view mounted.
 *
 * Tabs are views of durable resources: a conversation runs in main whether or not a pane shows
 * it, and its pane rebuilds from the durable snapshot when selected. So an inactive structured
 * conversation is unmounted outright ('suspend'); a hidden one was the most expensive thing a
 * workspace carried, with its own event subscriptions, timeline state and composer listeners.
 *
 * Views whose remount would lose something stay mounted ('always'): xterm-backed tabs (a remounted
 * terminal replays its transcript lossily, and a placed remote terminal replays nothing), Monaco
 * (the model and its undo history are disposed on unmount), and the cheap panels whose local state
 * (tree expansion, filters) nobody wants reset. Views that only re-read what they show share a
 * small most-recently-used pool per group ('pool').
 */
export type TabViewRetention = 'suspend' | 'pool' | 'always'

export const TAB_VIEW_POOL_SIZE = 3
const STRUCTURED_PROVIDERS = new Set<AgentProviderId>(['codex', 'claude', 'grok', 'local'])

const structuredProvider = (tab: PaneTab): AgentProviderId | null => {
  const provider = (tab.state?.provider as AgentProviderId | undefined) ?? 'codex'
  return STRUCTURED_PROVIDERS.has(provider) ? provider : null
}

/** An agent tab whose view is the structured conversation pane rather than a terminal. */
export const isStructuredConversationTab = (tab: PaneTab): boolean =>
  tab.kind === 'agent' && Boolean(tab.resourceId) && structuredProvider(tab) !== null && tab.state?.viewMode !== 'cli' && tab.state?.archiveDormant !== true

export function tabViewRetention(tab: PaneTab): TabViewRetention {
  if (isStructuredConversationTab(tab)) return 'suspend'
  if (tab.kind === 'preview' || tab.kind === 'browser') return 'pool'
  return 'always'
}

/** The group's selection history, most recent first, with `activeId` moved to the front and
 *  closed tabs dropped. Returns `recent` itself when nothing changed, so it is safe to call on
 *  every render. */
export function touchRecentTabs(recent: readonly string[], activeId: string, tabIds: ReadonlySet<string>): readonly string[] {
  if (recent[0] === activeId && recent.every(id => tabIds.has(id))) return recent
  return [activeId, ...recent.filter(id => id !== activeId && tabIds.has(id))]
}

/** The tabs of one group whose views stay mounted: the active one, every 'always' view, and the
 *  most recently selected pool views. */
export function mountedTabIds(tabs: readonly PaneTab[], activeId: string, recent: readonly string[], poolSize = TAB_VIEW_POOL_SIZE): Set<string> {
  const mounted = new Set<string>([activeId])
  const byId = new Map(tabs.map(tab => [tab.id, tab]))
  for (const tab of tabs) if (tabViewRetention(tab) === 'always') mounted.add(tab.id)
  let pooled = 0
  for (const id of recent) {
    if (pooled >= poolSize) break
    const tab = byId.get(id)
    if (!tab || id === activeId || tabViewRetention(tab) !== 'pool') continue
    mounted.add(id)
    pooled++
  }
  return mounted
}

/** Exactly the spec a mounted StructuredAgentPane registers with main (StructuredAgentPane's
 *  mount and continuation effects), so a suspended conversation is registered, re-armed and kept
 *  on the workspace's continuation setting the same way. */
export function suspendedConversationSpec(tab: PaneTab, project: Pick<ProjectRecord, 'id' | 'path'>, session: Pick<SessionRecord, 'id' | 'continueOnLimit'>): AgentSpec | null {
  const provider = structuredProvider(tab)
  if (tab.kind !== 'agent' || !tab.resourceId || !provider) return null
  return {
    id: tab.resourceId,
    projectId: project.id,
    sessionId: session.id,
    title: tab.title,
    cwd: project.path,
    provider,
    model: (tab.state?.model as string | undefined) ?? 'default',
    effort: (tab.state?.effort as AgentEffort | undefined) ?? 'auto',
    continueOnLimit: tab.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(tab.state.continueOnLimit)
  }
}
