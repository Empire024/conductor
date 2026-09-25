import type { AttentionLogEntry, AttentionOutcome, PhoneNotification, PhoneSessionState } from '../shared/phone-access'
import type { PendingInteraction, TimelineItem } from '../shared/structured-agent'

/**
 * "Needs you" only when a conversation is really waiting on the owner (feature
 * phone-needs-you-only-when-blocked). Every attention moment - an approval or question that holds
 * the turn, a Claude auto-mode refusal - is held for a grace period first. If it is still blocked on
 * the owner then, the phone hears about it; if the agent routed around it, a reviewer or wizard
 * answered it, or the owner answered on the desktop, nothing is sent. Either way the moment and what
 * happened next go to a bounded attention log (Settings > Notifications), so the rules can be tuned.
 */
export const ATTENTION_GRACE_MS = 20_000
/** How long a moment still undecided after its grace period (a reviewer still thinking, a turn
 *  still reasoning after a refusal) is watched before it is logged as undecided. */
export const ATTENTION_WATCH_MS = 30 * 60_000
export const ATTENTION_LOG_KEY = 'phone.attentionLog'
export const ATTENTION_LOG_LIMIT = 200

export type AttentionKind = AttentionLogEntry['kind']
export interface AttentionCandidate {
  sessionId: string
  title: string
  kind: AttentionKind
  /** What was asked or refused, one line. */
  detail: string
  /** The pending interaction an approval or question is about. */
  pendingId?: string
  /** The timeline item of a refusal. */
  denialItemId?: string
  notification: PhoneNotification
}
/** The conversation as it is now. `open` is false once no tab shows it. */
export interface AttentionView { open: boolean; state?: PhoneSessionState; pendingId?: string; items: readonly TimelineItem[] }
export type AttentionVerdict =
  | { verdict: 'blocked'; next: string }
  | { verdict: 'undecided' }
  | { verdict: 'settled'; outcome: Exclude<AttentionOutcome, 'notified' | 'undecided'>; next: string }

/** Review phases in which the reviewer (or a wizard tab answering for the owner) still holds the
 *  request; 'owner' means it was escalated, and anything else has an answer. */
const REVIEWER_HOLDS = new Set(['reviewing', 'approved', 'denied', 'responding'])
const key = (candidate: Pick<AttentionCandidate, 'sessionId' | 'pendingId' | 'denialItemId'>): string =>
  `${candidate.sessionId}\0${candidate.pendingId ?? ''}\0${candidate.denialItemId ?? ''}`

function interactionOf(items: readonly TimelineItem[], id: string | undefined): PendingInteraction | undefined {
  if (!id) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const data = items[index]!.data
    if (data.type === 'interaction' && data.interaction.id === id) return data.interaction
  }
  return undefined
}

/** Whether the moment still holds the turn on the owner. Pure, so each rule is testable alone. */
export function attentionVerdict(candidate: AttentionCandidate, view: AttentionView | undefined): AttentionVerdict {
  if (!view?.open) return { verdict: 'settled', outcome: 'closed', next: 'The tab was closed.' }
  if (candidate.kind === 'denial') {
    const at = view.items.findIndex(item => item.id === candidate.denialItemId)
    const since = at < 0 ? [] : view.items.slice(at + 1)
    const tools = since.filter(item => item.data.type === 'tool').length
    if (tools) return { verdict: 'settled', outcome: 'routed-around', next: `The agent went another way: ${tools} tool call${tools === 1 ? '' : 's'} since.` }
    if (view.state === 'attention') return { verdict: 'settled', outcome: 'routed-around', next: 'The agent asked the owner instead; that request is judged on its own.' }
    if (view.state === 'working' || view.state === 'limited') return { verdict: 'undecided' }
    return { verdict: 'blocked', next: 'The turn stopped after the refusal and is waiting for the owner.' }
  }
  const interaction = interactionOf(view.items, candidate.pendingId)
  if (view.state === 'attention' && view.pendingId === candidate.pendingId) {
    if (interaction?.review && REVIEWER_HOLDS.has(interaction.review.phase)) return { verdict: 'undecided' }
    return { verdict: 'blocked', next: interaction?.review?.phase === 'owner' ? 'The reviewer handed it to the owner; still waiting.' : 'Still waiting for the owner.' }
  }
  const answered = interaction?.answers ? Object.values(interaction.answers).flat().filter(Boolean).join(', ') : ''
  const answer = answered ? `: ${answered}` : interaction?.outcome ? `: ${interaction.outcome}` : ''
  if (interaction?.review && !/^owner/i.test(interaction.review.rationale) && interaction.review.phase !== 'owner') {
    return { verdict: 'settled', outcome: 'reviewer', next: `Answered by the reviewer${interaction.review.reviewerModel ? ` (${interaction.review.reviewerModel})` : ''}${answer}.` }
  }
  if (interaction?.status === 'resolved') return { verdict: 'settled', outcome: 'answered', next: `Answered within the grace period${answer}.` }
  if (interaction?.status === 'expired') return { verdict: 'settled', outcome: 'routed-around', next: 'The request was withdrawn; the turn moved on.' }
  return { verdict: 'settled', outcome: 'routed-around', next: `The turn moved on (${view.state ?? 'unknown'}).` }
}

export interface AttentionGateDeps {
  view(sessionId: string): AttentionView | undefined
  send(notification: PhoneNotification): void
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
  /** The log changed, for the desktop's Settings view. */
  changed?(): void
  now?(): number
  graceMs?: number
  watchMs?: number
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}
interface Pending { candidate: AttentionCandidate; raisedAt: number; graceOver: boolean; timer?: unknown }

export class AttentionGate {
  private pending = new Map<string, Pending>()
  private disposed = false
  constructor(private readonly deps: AttentionGateDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Holds an attention moment for the grace period. The same moment offered again is ignored. */
  offer(candidate: AttentionCandidate): void {
    if (this.disposed) return
    const id = key(candidate)
    if (this.pending.has(id)) return
    const entry: Pending = { candidate, raisedAt: this.now(), graceOver: false }
    this.pending.set(id, entry)
    const set = this.deps.setTimer ?? ((callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); (timer as { unref?: () => void }).unref?.(); return timer })
    entry.timer = set(() => { entry.timer = undefined; entry.graceOver = true; this.judge(id) }, this.deps.graceMs ?? ATTENTION_GRACE_MS)
  }

  /** Re-judges every held moment against the conversation as it is now: one that resolved is
   *  logged and dropped at once; one past its grace that is blocked on the owner is sent. */
  review(): void {
    for (const id of [...this.pending.keys()]) this.judge(id)
  }

  entries(): AttentionLogEntry[] {
    try {
      const parsed = JSON.parse(this.deps.store.getSetting(ATTENTION_LOG_KEY) ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed.filter((entry): entry is AttentionLogEntry => Boolean(entry && typeof entry === 'object' && typeof (entry as AttentionLogEntry).outcome === 'string')) : []
    } catch { return [] }
  }

  clear(): void { this.deps.store.setSetting(ATTENTION_LOG_KEY, '[]'); this.deps.changed?.() }

  /** Moments still held, for tests and diagnostics. */
  held(): number { return this.pending.size }

  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) if (entry.timer !== undefined) (this.deps.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout)))(entry.timer)
    this.pending.clear()
  }

  private judge(id: string): void {
    const entry = this.pending.get(id)
    if (!entry || this.disposed) return
    let verdict: AttentionVerdict
    try { verdict = attentionVerdict(entry.candidate, this.deps.view(entry.candidate.sessionId)) } catch { return }
    if (verdict.verdict === 'undecided') {
      if (!entry.graceOver || this.now() - entry.raisedAt < (this.deps.watchMs ?? ATTENTION_WATCH_MS)) return
      this.drop(id, entry)
      this.log(entry, 'undecided', 'Still undecided when the watch ended; not notified.')
      return
    }
    if (verdict.verdict === 'blocked') {
      if (!entry.graceOver) return
      this.drop(id, entry)
      this.log(entry, 'notified', verdict.next)
      this.deps.send({ ...entry.candidate.notification, at: new Date(this.now()).toISOString() })
      return
    }
    this.drop(id, entry)
    this.log(entry, verdict.outcome, verdict.next)
  }

  private drop(id: string, entry: Pending): void {
    if (entry.timer !== undefined) { (this.deps.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout)))(entry.timer); entry.timer = undefined }
    this.pending.delete(id)
  }

  private log(entry: Pending, outcome: AttentionOutcome, next: string): void {
    const { candidate } = entry
    const at = new Date(entry.raisedAt).toISOString()
    const record: AttentionLogEntry = {
      id: candidate.notification.id, at, sessionId: candidate.sessionId, title: candidate.title, kind: candidate.kind, detail: candidate.detail,
      outcome, next, waitedMs: Math.max(0, this.now() - entry.raisedAt)
    }
    try {
      this.deps.store.setSetting(ATTENTION_LOG_KEY, JSON.stringify([...this.entries(), record].slice(-ATTENTION_LOG_LIMIT)))
      this.deps.changed?.()
    } catch { /* the log is diagnostics; never fail a notification over it */ }
  }
}
