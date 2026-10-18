import type { AgentActivityPhase } from '../shared/models'
import type { PhoneAutoModeDenial, PhoneNotification, PhoneSessionState, PhoneSessionSummary } from '../shared/phone-access'
import { autoModeDenialOf, autoModeDenialSummary } from '../shared/auto-mode-denial'
import { isViewing } from '../shared/project-activity'
import type { PendingInteraction, SessionPhase, TimelineItem } from '../shared/structured-agent'

/** The projection fields the state word needs. Declared here rather than as a Pick so the rule
 *  reads the same whether or not the projection type in this tree already carries the usage
 *  window; a projection without one simply never reports it. */
export interface PhoneStateSource { phase: SessionPhase; limitResumeAt?: string | null; backgroundTasks?: number }
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
  // A turn that ended while its own background tasks still run is viewing: ranked with working, never done.
  if (phase === 'running' || phase === 'starting' || phase === 'interrupting' || activity === 'working' || activity === 'waiting_background' || isViewing(phase, projection?.backgroundTasks)) return 'working'
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
  return describeDenialMoments(previous, next, at, nextId).map(moment => moment.notification)
}

/** Each new denial with the notification it would raise; the attention gate (attention-log.ts)
 *  sends it only if the turn then stops on it rather than going another way. */
export function describeDenialMoments(previous: Pick<PhoneSessionSummary, 'autoModeDenials'> | undefined, next: PhoneSessionSummary, at: string, nextId: () => string): Array<{ denial: PhoneAutoModeDenial; notification: PhoneNotification }> {
  if (!previous) return []
  const known = new Set((previous.autoModeDenials ?? []).map(denial => denial.id))
  const url = `/#/session/${encodeURIComponent(next.id)}`
  return (next.autoModeDenials ?? []).filter(denial => !known.has(denial.id)).map(denial => ({
    denial,
    notification: {
      id: nextId(), kind: 'attention', sessionId: next.id, at, url,
      title: `Needs you: ${next.title || 'Conversation'}`,
      body: previewText(autoModeDenialSummary(denial), 160)
    }
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

/** How long a burst of per-conversation notifications is gathered before it goes out. A swarm's
 *  tabs hit one provider's usage limit, finish or fail within a second or two of each other, and
 *  the phone should buzz once for that, not once per tab. */
export const NOTIFICATION_BATCH_MS = 2500
/** Two limits on one provider whose reset times are this close are the same usage window. */
const SAME_WINDOW_MS = 2 * 60_000
/** A limit that did not say when it resets is not announced again for this long. */
const UNKNOWN_RESET_HOLD_MS = 30 * 60_000

/** A notification about one conversation, with what the batcher groups it by. */
export interface NotificationMoment {
  notification: PhoneNotification
  /** The conversation's own title, for the combined notification's list. */
  title: string
  provider?: string
  resumeAt?: string | null
}

export interface NotificationBatcherOptions {
  emit: (notification: PhoneNotification) => void
  now: () => number
  nextId: () => string
  providerLabel?: (provider: string) => string
  windowMs?: number
}

interface MomentGroup { kind: 'done' | 'failed' | 'limited'; provider: string; resumeMs: number | null; coworker: boolean; moments: NotificationMoment[] }

const resumeMsOf = (value: string | null | undefined): number | null => {
  const ms = value ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? null : ms
}
const sameWindow = (left: number | null, right: number | null): boolean => left === null || right === null ? left === right : Math.abs(left - right) <= SAME_WINDOW_MS

/**
 * Turns bursts of per-conversation notifications into one. Done, failed and usage-limit moments
 * are held for NOTIFICATION_BATCH_MS from the first of them and then go out one per group: a lone
 * moment unchanged, several as "Usage limit: 5 tabs (Claude)" or "Done: 3 conversations". A usage
 * limit is also announced only once per provider and reset window, so tabs that reach the same
 * closed window later stay quiet. Anything else - above all a question or an approval that needs
 * the owner - is passed straight through, never held and never merged.
 */
export class NotificationBatcher {
  private groups: MomentGroup[] = []
  private announcedLimits: Array<{ provider: string; resumeMs: number | null; until: number }> = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: NotificationBatcherOptions) {}

  offer(moment: NotificationMoment): void {
    const { notification } = moment
    const kind = notification.kind
    if (kind !== 'done' && kind !== 'failed' && kind !== 'limited') { this.options.emit(notification); return }
    const provider = moment.provider ?? ''
    const resumeMs = kind === 'limited' ? resumeMsOf(moment.resumeAt) : null
    if (kind === 'limited') {
      const now = this.options.now()
      this.announcedLimits = this.announcedLimits.filter(entry => entry.until > now)
      if (this.announcedLimits.some(entry => entry.provider === provider && sameWindow(entry.resumeMs, resumeMs))) return
    }
    const coworker = Boolean(notification.isCoworker)
    let group = this.groups.find(entry => entry.kind === kind && (kind === 'limited' ? entry.provider === provider && sameWindow(entry.resumeMs, resumeMs) : entry.coworker === coworker))
    if (!group) this.groups.push(group = { kind, provider, resumeMs, coworker, moments: [] })
    // One conversation is one line, however often it moved inside the window.
    group.moments = group.moments.filter(entry => entry.notification.sessionId !== notification.sessionId || !notification.sessionId).concat([moment])
    this.timer ??= setTimeout(() => { this.timer = null; this.flush() }, this.options.windowMs ?? NOTIFICATION_BATCH_MS)
  }

  /** Sends whatever is held now. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const groups = this.groups
    this.groups = []
    for (const group of groups) {
      if (group.kind === 'limited') {
        const latest = group.moments.reduce<number | null>((best, moment) => { const ms = resumeMsOf(moment.resumeAt); return ms !== null && (best === null || ms > best) ? ms : best }, group.resumeMs)
        this.announcedLimits.push({ provider: group.provider, resumeMs: latest, until: latest ?? this.options.now() + UNKNOWN_RESET_HOLD_MS })
      }
      this.options.emit(this.combine(group))
    }
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.groups = []
  }

  private combine(group: MomentGroup): PhoneNotification {
    const first = group.moments[0]!.notification
    const tag = group.kind === 'limited' ? `usage-limit-${group.provider || 'provider'}` : undefined
    if (group.moments.length === 1) return tag ? { ...first, tag } : first
    const count = group.moments.length
    const titles = previewText(group.moments.map(moment => moment.title || 'Conversation').join(', '), 160)
    const base = { id: this.options.nextId(), sessionId: null, at: first.at, url: '/#/tabs' }
    if (group.kind === 'limited') {
      const label = group.provider ? this.options.providerLabel?.(group.provider) ?? group.provider : ''
      const latest = group.moments.map(moment => moment.resumeAt).filter((value): value is string => Boolean(value)).sort().at(-1)
      const when = latest ? clock(latest) : ''
      return { ...base, kind: 'limited', tag, title: `Usage limit: ${count} tabs${label ? ` (${label})` : ''}${when ? ` · resumes at ${when}` : ''}`, body: `${when ? 'Waiting for the provider window.' : 'Waiting for the provider usage window to reopen.'} ${titles}` }
    }
    if (group.kind === 'done') return { ...base, kind: 'done', title: `Done: ${count} conversations`, body: titles, isCoworker: group.coworker }
    return { ...base, kind: 'failed', title: `Failed: ${count} conversations`, body: titles }
  }
}
