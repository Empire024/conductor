import type { AgentActivityPhase } from '../shared/models'
import type { PhoneAutoModeDenial, PhoneNotification, PhoneSessionState, PhoneSessionSummary } from '../shared/phone-access'
import { autoModeDenialOf, autoModeDenialSummary } from '../shared/auto-mode-denial'
import type { PendingInteraction, SessionPhase, TimelineItem } from '../shared/structured-agent'

/** The projection fields the state word needs. Declared here rather than as a Pick so the rule
 *  reads the same whether or not the projection type in this tree already carries the usage
 *  window; a projection without one simply never reports it. */
export interface PhoneStateSource { phase: SessionPhase; limitResumeAt?: string | null }
/** Persisted phases, plus the background-work phase newer runtimes record. */
export type PhoneActivity = AgentActivityPhase | 'waiting_background'

/**
 * The one word a phone sees about a conversation, and the moments worth interrupting the owner
 * for. Pure so the rules can be read and tested without a session behind them.
 *
 * Two sources feed the word. The projection phase is what the conversation itself last said; the
 * persisted activity phase is the main process's refinement of it, which knows about work the
 * turn left running (a subagent, a backgrounded process) and about a provider usage window. When
 * they disagree it is because the activity phase knows more, so it wins for those cases only.
 */
export function phoneSessionState(projection: PhoneStateSource | null, activity: PhoneActivity | undefined): PhoneSessionState {
  const phase = projection?.phase
  if (phase === 'waiting_approval' || phase === 'waiting_input') return 'attention'
  if (activity === 'limited' || projection?.limitResumeAt) return 'limited'
  if (phase === 'running' || phase === 'starting' || phase === 'interrupting' || activity === 'working' || activity === 'waiting_background') return 'working'
  if (phase === 'failed' || activity === 'failed') return 'failed'
  if (phase === 'disconnected') return 'disconnected'
  if (phase === 'interrupted' || activity === 'stopped') return 'stopped'
  if (phase === 'completed' || activity === 'complete') return 'done'
  return 'idle'
}

/** The interaction the owner is being asked about right now, newest first. */
export function pendingInteraction(items: readonly TimelineItem[]): PendingInteraction | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const data = items[index]!.data
    if (data.type === 'interaction' && data.interaction.status === 'pending') return data.interaction
  }
  return undefined
}

/** The claude auto-mode classifier denials a conversation recorded, oldest first, the last 20. A
 *  confirmed re-emission updates the same timeline item, so one denial is one entry. */
export function autoModeDenials(items: readonly TimelineItem[]): PhoneAutoModeDenial[] {
  const denials: PhoneAutoModeDenial[] = []
  for (const item of items) {
    const denial = autoModeDenialOf(item.data)
    if (denial && !denials.some(entry => entry.id === item.id)) denials.push({ id: item.id, tool: denial.tool, reason: denial.reason })
  }
  return denials.slice(-20)
}

/**
 * A classifier denial is a "needs you" moment with no phase behind it: the turn keeps running,
 * so the state word never says 'attention'. Each denial is announced exactly once, on the way in,
 * and never for a conversation seen for the first time - the phone was not waiting on it.
 */
export function describeDenials(previous: Pick<PhoneSessionSummary, 'autoModeDenials'> | undefined, next: PhoneSessionSummary, at: string, nextId: () => string): PhoneNotification[] {
  if (!previous) return []
  const known = new Set((previous.autoModeDenials ?? []).map(denial => denial.id))
  const url = `/#/session/${encodeURIComponent(next.id)}`
  return (next.autoModeDenials ?? []).filter(denial => !known.has(denial.id)).map(denial => ({
    id: nextId(), kind: 'attention', sessionId: next.id, at, url,
    title: `Needs you: ${next.title || 'Conversation'}`,
    body: previewText(autoModeDenialSummary(denial), 160)
  }))
}

/** Collapses whitespace and trims to a preview that fits a notification or a list row. */
export function previewText(text: string, limit: number): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + '…' : flat
}

/** The most recent root-level text, which is what "what did it say" means on a list row. */
export function lastMessage(items: readonly TimelineItem[]): { text: string; role: 'user' | 'assistant' } | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.parentId || item.data.type !== 'text' || item.data.role === 'status' || !item.data.text.trim()) continue
    return { text: item.data.text, role: item.data.role }
  }
  return undefined
}

const clock = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * What changed that the owner would want to hear about, or null. A conversation is only ever
 * announced on the way *into* a state that asks something of them or ends their wait: a new
 * question (a second question in a row counts, which is why the pending id matters), a finished
 * turn, a failure, a closed usage window. Nothing is announced for a conversation seen for the
 * first time - the phone was not waiting on it - and nothing while it is merely working.
 */
export function describeTransition(previous: Pick<PhoneSessionSummary, 'state' | 'pendingId'> | undefined, next: PhoneSessionSummary, at: string, id: string): PhoneNotification | null {
  if (!previous) return null
  const url = `/#/session/${encodeURIComponent(next.id)}`
  const base = { id, sessionId: next.id, at, url }
  const title = next.title || 'Conversation'
  if (next.state === 'attention') {
    if (previous.state === 'attention' && previous.pendingId === next.pendingId) return null
    return { ...base, kind: 'attention', title: `Needs you: ${title}`, body: next.pendingTitle ? previewText(next.pendingTitle, 160) : next.needs === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer' }
  }
  if (next.state === previous.state) return null
  if (next.state === 'done') return { ...base, kind: 'done', title: `Done: ${title}`, body: next.lastRole === 'assistant' && next.lastText ? previewText(next.lastText, 180) : 'The turn finished.', isCoworker: Boolean(next.controllerId) }
  if (next.state === 'failed') return { ...base, kind: 'failed', title: `Failed: ${title}`, body: next.lastText ? previewText(next.lastText, 180) : 'The conversation reported an error.' }
  if (next.state === 'limited') {
    const when = next.limitResumeAt ? clock(next.limitResumeAt) : ''
    return { ...base, kind: 'limited', title: `Usage limit: ${title}`, body: when ? `Waiting for the provider window; resumes at ${when}.` : 'Waiting for the provider usage window to reopen.' }
  }
  return null
}
