import type { SessionRecord } from '../../shared/models'
import { listGroups } from './layout/layout-operations'

export const getAttentionSessionIds = (
  sessions: SessionRecord[],
  attentionResourceIds: ReadonlySet<string>
): Set<string> => {
  const ids = new Set<string>()
  for (const session of sessions) {
    const hasVisibleAttention = listGroups(session.layout.root).some((group) =>
      group.tabs.some((tab) => tab.resourceId && attentionResourceIds.has(tab.resourceId))
    )
    if (hasVisibleAttention) ids.add(session.id)
  }
  return ids
}

export const retainVisibleAttentionResources = (
  sessions: SessionRecord[],
  attentionResourceIds: ReadonlySet<string>
): Set<string> => {
  const visibleResources = new Set(sessions.flatMap((session) =>
    listGroups(session.layout.root).flatMap((group) =>
      group.tabs.flatMap((tab) => tab.resourceId ? [tab.resourceId] : [])
    )
  ))
  return new Set([...attentionResourceIds].filter((id) => visibleResources.has(id)))
}
