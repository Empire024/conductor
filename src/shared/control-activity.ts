import type { AgentEventData, TimelineItem } from './structured-agent'

/**
 * What a conversation did through app control, recorded by Conductor (src/main/control-activity.ts)
 * as notices in timelines, never as prompt text: the caller's own timeline carries one chip row per
 * turn (payload key `controlActivity`, upserted in place under a stable item id), and the tab it
 * acted on gets a one-line notice (payload key `controlledBy`). No model reads any of it.
 */
export const CONTROL_ACTIVITY_KEY = 'controlActivity'
export const CONTROLLED_BY_KEY = 'controlledBy'
export const CONTROL_ACTIVITY_ITEM_PREFIX = 'control-activity:'
/** Settings key of the bounded app-wide history (restart, update install, rollback...). */
export const APP_CONTROL_HISTORY_KEY = 'control-activity:app-history'
export const APP_CONTROL_HISTORY_LIMIT = 30
/** Most actions one chip row keeps; older ones are counted in `dropped`. */
export const CONTROL_ROW_ACTION_LIMIT = 24

export type ControlActionKind = 'open' | 'steer' | 'close' | 'ship' | 'app' | 'decide' | 'write' | 'other'
export interface ControlTarget { agentSessionId?: string; tabId?: string; title?: string }
export interface ControlAction {
  method: string
  kind: ControlActionKind
  label: string
  at: string
  target?: ControlTarget
  runId?: string
  commit?: string
  failed?: boolean
  /** Short reason for a failed call, for the chip's tooltip. */
  error?: string
  appWide?: boolean
}
export interface ControlActivity { actions: ControlAction[]; reads: number; readMethods: Record<string, number>; dropped: number }
export interface ControlledBy { agentSessionId: string | null; tabId?: string; title: string; method: string; verb: string; at: string }
export interface AppControlEntry { method: string; label: string; at: string; by: { agentSessionId: string | null; title: string }; failed?: boolean }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

export function controlActivityOf(data: AgentEventData): ControlActivity | null {
  if (data.type !== 'notice') return null
  const value = record(record(data.payload)?.[CONTROL_ACTIVITY_KEY])
  if (!value || !Array.isArray(value.actions)) return null
  const actions = value.actions.filter((action): action is ControlAction => {
    const entry = record(action)
    return Boolean(entry && typeof entry.method === 'string' && typeof entry.label === 'string' && typeof entry.kind === 'string')
  })
  const readMethods = Object.fromEntries(Object.entries(record(value.readMethods) ?? {}).filter(([, count]) => typeof count === 'number')) as Record<string, number>
  return { actions, reads: typeof value.reads === 'number' ? value.reads : 0, readMethods, dropped: typeof value.dropped === 'number' ? value.dropped : 0 }
}

export function controlledByOf(data: AgentEventData): ControlledBy | null {
  if (data.type !== 'notice') return null
  const value = record(record(data.payload)?.[CONTROLLED_BY_KEY])
  if (!value || typeof value.title !== 'string' || typeof value.verb !== 'string') return null
  return {
    agentSessionId: typeof value.agentSessionId === 'string' ? value.agentSessionId : null,
    ...(typeof value.tabId === 'string' ? { tabId: value.tabId } : {}),
    title: value.title, verb: value.verb, method: typeof value.method === 'string' ? value.method : '', at: typeof value.at === 'string' ? value.at : ''
  }
}

/** A Conductor-side control record, which a controller reading this timeline has no use for. */
export function isControlActivityNotice(data: AgentEventData): boolean {
  if (data.type !== 'notice') return false
  const payload = record(data.payload)
  return Boolean(payload && (payload[CONTROL_ACTIVITY_KEY] !== undefined || payload[CONTROLLED_BY_KEY] !== undefined))
}

/** The chip text of a ship: `git.ship → 634b1fa` once the commit is known. */
export function controlActionText(action: ControlAction): string {
  if (action.kind === 'ship') return action.commit ? `git.ship → ${action.commit.slice(0, 7)}` : action.failed ? 'git.ship failed' : 'git.ship'
  return action.label
}

export function readChipText(reads: number): string { return `read ${reads} time${reads === 1 ? '' : 's'}` }

/** The notice text of a chip row, for surfaces that do not render the chips. */
export function controlActivitySummary(activity: ControlActivity): string {
  const parts = activity.actions.map(controlActionText)
  if (activity.dropped) parts.unshift(`${activity.dropped} earlier`)
  if (activity.reads) parts.push(readChipText(activity.reads))
  return 'Used Conductor: ' + (parts.join(' · ') || 'no calls')
}

/** One line for the Processes board: the latest control action a conversation took, or the latest
 *  one taken on it, whichever is newer. Reads alone are not an action. */
export function latestControlAction(items: readonly TimelineItem[]): { text: string; at: string; by?: string } | null {
  let best: { text: string; at: string; by?: string } | null = null
  for (let index = items.length - 1; index >= 0; index--) {
    const data = items[index]!.data
    if (data.type !== 'notice') continue
    const activity = controlActivityOf(data)
    const last = activity?.actions.at(-1)
    if (last && (!best || last.at > best.at)) best = { text: controlActionText(last), at: last.at }
    const driven = controlledByOf(data)
    if (driven && (!best || driven.at > best.at)) best = { text: `${driven.verb} by ${driven.title}`, at: driven.at, by: driven.title }
    // Rows are upserted in place, so the newest row is not always the last item; a few rows back
    // is enough to find the newest action without walking a 2,000-item timeline.
    if (best && items.length - index > 400) break
  }
  return best
}
