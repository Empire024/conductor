import { permissionGrantOf } from '../../../shared/permission-grants'
import type { TimelineItem } from '../../../shared/structured-agent'

/** Keep the provider interaction in the projection for exact response checks. Suppress its
 * duplicate controls only when this rendered window contains the corresponding native card. */
export function singlePermissionCards(items: TimelineItem[]): TimelineItem[] {
  const covered = new Set<string>()
  for (const item of items) {
    const grant = permissionGrantOf(item.data)
    if (grant?.source === 'native' && grant.call?.requestId && grant.call.runtimeId === item.runtimeId)
      covered.add(JSON.stringify([item.runtimeId, grant.id, grant.call.requestId]))
  }
  return items.filter(item => {
    if (item.data.type !== 'interaction') return true
    const request = item.data.interaction
    return !request.permissionGrantId || !covered.has(JSON.stringify([item.runtimeId, request.permissionGrantId, request.id]))
  })
}
