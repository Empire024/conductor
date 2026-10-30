import type { ThreadSummary, ThreadView } from '../../../shared/threads'

const RECENT_MS = 24 * 60 * 60 * 1000
const time = (thread: ThreadSummary): number => Date.parse(thread.updatedAt) || 0
const working = (thread: ThreadSummary): boolean => thread.state === 'working' || thread.state === 'limited'
const leader = (thread: ThreadSummary): boolean => Boolean(thread.wizard || thread.coworkers)

/** A small navigation helper; attention lives in its own dock. History stays explicitly reachable. */
export function sidebarThreadView(view: ThreadView | null, now: number): { current: ThreadSummary[]; older: ThreadSummary[] } {
  const rows = [...new Map((view?.groups.flatMap(group => group.threads) ?? []).map(thread => [thread.id, thread])).values()]
  const eligible = rows.filter(thread => thread.tabId && thread.state !== 'disconnected' && thread.state !== 'failed'
    && (working(thread) || (leader(thread) && now - time(thread) <= RECENT_MS)))
  eligible.sort((a, b) => Number(leader(b)) - Number(leader(a)) || Number(working(b)) - Number(working(a)) || time(b) - time(a) || a.id.localeCompare(b.id))
  const current = eligible.slice(0, 5)
  const kept = new Set(current.map(thread => thread.id))
  return { current, older: rows.filter(thread => !kept.has(thread.id)).sort((a, b) => time(b) - time(a)) }
}
