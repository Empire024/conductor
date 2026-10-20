import { grantCoversInteraction, permissionGrantOf, type PermissionGrantRequest } from '../../../shared/permission-grants'
import type { TimelineItem } from '../../../shared/structured-agent'

/** Keep the provider interaction in the projection for exact response checks. Suppress its
 * duplicate controls only when this rendered window contains the corresponding native card. */
export function singlePermissionCards(items: TimelineItem[]): TimelineItem[] {
  // The latest restatement of each native card: its answer decides whether it still stands in.
  const covered = new Map<string, PermissionGrantRequest>()
  for (const item of items) {
    const grant = permissionGrantOf(item.data)
    if (grant?.source === 'native' && grant.call?.requestId && grant.call.runtimeId === item.runtimeId)
      covered.set(JSON.stringify([item.runtimeId, grant.id, grant.call.requestId]), grant)
  }
  return items.filter(item => {
    if (item.data.type !== 'interaction') return true
    const request = item.data.interaction
    const key = JSON.stringify([item.runtimeId, request.permissionGrantId, request.id])
    return !request.permissionGrantId || !covered.has(key) || !grantCoversInteraction(covered.get(key), request.status)
  })
}
