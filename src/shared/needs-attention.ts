/**
 * "Needs attention" (feature-list eb5faab5): the agent tabs across every open project that need
 * the owner right now, listed under the projects in the sidebar. Built on the same persisted
 * activity phases as the project roll-up (src/main/project-activity.ts), and honest about it:
 *
 * - approval: its turn waits on an approval card;
 * - question: it asked the owner a question (waiting_input);
 * - permission: it filed a request_permission card that is still pending;
 * - limit: it stopped on a usage limit and nothing resumes it (limit continuation off);
 * - failed / interrupted: its turn failed, or its connection was lost mid-turn, and the owner has
 *   not looked at the tab since (a look is an answer; a superseded or handed-off tab is not listed).
 *
 * Not listed: running tabs, a limit wait that continues by itself, finished tabs, and a tab that
 * ended its turn waiting for other conversations' results (src/shared/awaiting-results.ts): those
 * wake by themselves.
 */

export type AttentionReason = 'approval' | 'question' | 'permission' | 'limit' | 'failed' | 'interrupted'

export interface AttentionEntry {
  projectId: string
  projectName: string
  workspaceId: string
  workspaceName: string
  tabId: string
  agentSessionId: string
  title: string
  reason: AttentionReason
  /** One line for the tooltip, e.g. the failure or the permission asked for. */
  detail?: string
  /** When it started needing the owner (ISO), when known. */
  since?: string
}

export interface AttentionSnapshot { entries: AttentionEntry[]; total: number; observedAt: string }

export const ATTENTION_LIMIT = 50

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
  approval: 'approval',
  question: 'question',
  permission: 'permission',
  limit: 'usage limit',
  failed: 'failed',
  interrupted: 'interrupted'
}

/** Blocking asks first (a turn is held on them), then stops, newest first within each. */
const RANK: Record<AttentionReason, number> = { approval: 0, permission: 1, question: 2, limit: 3, failed: 4, interrupted: 5 }

export function sortAttention(entries: AttentionEntry[]): AttentionEntry[] {
  return [...entries].sort((a, b) => RANK[a.reason] - RANK[b.reason] || (Date.parse(b.since ?? '') || 0) - (Date.parse(a.since ?? '') || 0) || a.title.localeCompare(b.title))
}

export interface NeedsAttentionBridge {
  snapshot(): Promise<AttentionSnapshot>
  onChanged(callback: (snapshot: AttentionSnapshot) => void): () => void
}
