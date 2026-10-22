import type { PromptOrigin } from './structured-agent'

/**
 * Who a user-role message in a conversation came from. Only `owner` is the owner typing in this
 * tab (or on the phone); everything else arrived from somewhere else and is drawn apart from the
 * owner's own messages everywhere: timeline, queued and steering lists, phone (owner, 2026-10-22:
 * "messages coming in from agents must be differentiated completely in the ui from my own
 * messages ... not like a queued message").
 *
 * - `agent`: another conversation (a coworker's report, a controller's steer, send_message from
 *   another tab, workspace or project's wizard). `agentSessionId` names it so it can be opened.
 * - `conductor`: Conductor itself (restart and login resumes, await wakes, limit continuations).
 * - `machine`: a paired machine (origin `remote:<peer>`).
 * - `schedule`: a scheduled task's turn.
 */
export type MessageSenderKind = 'owner' | 'agent' | 'conductor' | 'machine' | 'schedule'
export interface MessageSender { kind: MessageSenderKind; label: string; agentSessionId?: string }

/** The origin Conductor stamps on what it sends a conversation by itself. */
export const CONDUCTOR_ORIGIN: PromptOrigin = { agentSessionId: 'owner', label: 'Conductor' }

const OWNER: MessageSender = { kind: 'owner', label: 'You' }
/** `[From <title> (<agentSessionId>…)] …`, the prefix cross-workspace, cross-project and sibling
 *  deliveries carry in their text, for a journal entry that kept the text but not the origin. */
const FROM_PREFIX = /^\[From (.{1,200}?) \(([A-Za-z0-9_-]{4,160})(?:[,)])/

export function messageSenderOf(message: { text?: string; origin?: PromptOrigin | null }): MessageSender {
  const origin = message.origin
  if (origin && typeof origin.agentSessionId === 'string' && origin.agentSessionId) {
    const id = origin.agentSessionId, label = origin.label || 'Another conversation'
    if (id === 'owner' || id === 'durable-job') return { kind: 'conductor', label: label || 'Conductor' }
    if (id === 'scheduled-task') return { kind: 'schedule', label }
    if (id.startsWith('remote:') || origin.authority?.kind === 'remote-peer') return { kind: 'machine', label }
    return { kind: 'agent', label, agentSessionId: id }
  }
  const text = (message.text ?? '').trimStart()
  if (/^\[Conductor\]\s/.test(text)) return { kind: 'conductor', label: 'Conductor' }
  const from = FROM_PREFIX.exec(text)
  if (from) return { kind: 'agent', label: from[1]!, agentSessionId: from[2]! }
  return OWNER
}

export const isOwnMessage = (message: { text?: string; origin?: PromptOrigin | null }): boolean => messageSenderOf(message).kind === 'owner'
