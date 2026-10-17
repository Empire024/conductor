/**
 * Waking the controller on a coworker's approval (feature-list wake-controller-on-approval, owner
 * 2026-10-17: an overseer polled agents.approvals on a cron and paid for every empty tick).
 *
 * - A coworker's pending native approval card, or its pending permissions.request / denial card,
 *   that nothing answers automatically (the stronger-model review, the owner's auto-approve policy,
 *   the wizard answering it by itself) within WAKE_GRACE_MS is delivered once to the conversation
 *   that controls it, as a report is: a turn starts when it is idle, and a running turn is steered
 *   or queued. Only a wizard controller is woken by default, because only a wizard (or the owner)
 *   can answer the card; any controller may opt in with agents.await({agents, approvals:true}).
 * - One wake per card (dedupe by conversation, runtime and request), and the cards a controller
 *   has waiting together go in one message: once any of its cards is due, every other unanswered
 *   card of its coworkers rides along (a burst of five cards is one turn, not five).
 * - A card under stronger review is not due while the review is still deciding; one the review
 *   handed to the owner (phase owner, paused or blocked) is.
 *
 * Before anything is woken, the owner's auto-approve policy (approval-policy.ts) answers a card it
 * covers, with no model turn; the adapters already ask it before a card is raised, so this only
 * catches a card raised before the policy changed or by a runtime that does not ask it.
 */

/** How long a card waits for an automatic answer before its controller is woken. */
export const WAKE_GRACE_MS = 5_000
/** Cards remembered as woken, so a re-shown card never wakes twice (bounded). */
const WOKEN_LIMIT = 4000
/** Review phases in which the stronger review is still answering by itself. */
const REVIEW_AUTOMATIC = new Set(['reviewing', 'approved', 'denied', 'responding', 'responded', 'execution-unknown', 'executed', 'execution-failed'])

export interface PendingCard {
  /** The coworker whose card it is. */
  agentSessionId: string
  title?: string
  /** A native approval answered by agents.approve, or a permission card answered by permissions.decide. */
  kind: 'approval' | 'permission'
  requestId: string
  runtimeId?: string
  tool: string
  /** The exact action in one line: the command, path or URL. */
  action: string
  class?: string
  attention?: string
  reason?: string
  /** When it was raised (ms), if known; otherwise when it was first seen. */
  requestedAt?: number
  /** The stronger review's phase, when one is bound to it. */
  reviewPhase?: string
  /** Whom it wakes: the coworker's controller (or its successor). */
  controller?: string
}

export const cardKey = (card: Pick<PendingCard, 'agentSessionId' | 'kind' | 'runtimeId' | 'requestId'>): string =>
  [card.agentSessionId, card.kind, card.runtimeId ?? '', card.requestId].join('\n')

/** Whether something automatic is still answering this card by itself. */
export const answeringAutomatically = (card: Pick<PendingCard, 'reviewPhase'>): boolean => card.reviewPhase !== undefined && REVIEW_AUTOMATIC.has(card.reviewPhase)

/** The in-memory ledger: when each card was first seen, and which cards already woke someone. */
export class ApprovalWakes {
  private readonly firstSeen = new Map<string, number>()
  private readonly woken = new Set<string>()
  constructor(private readonly options: { graceMs?: number; now?: () => number } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now() }

  /** Whether this card already woke someone. */
  wasWoken(card: PendingCard): boolean { return this.woken.has(cardKey(card)) }

  /** Records that the card is handled (woken, or answered by the policy): it never wakes again. */
  mark(card: PendingCard): void {
    const key = cardKey(card)
    this.woken.add(key)
    this.firstSeen.delete(key)
    if (this.woken.size > WOKEN_LIMIT) this.woken.delete(this.woken.values().next().value!)
  }

  /**
   * The cards to deliver now, from every card pending right now. A card is due once it has waited
   * the grace period with nothing automatic answering it; the other unanswered cards of the same
   * group (`group`, by default the controller) ride along so a burst is one message. Cards no longer
   * pending are forgotten. Nothing is marked: the caller marks what it delivered.
   */
  due(cards: readonly PendingCard[], group: (card: PendingCard) => string = card => card.controller ?? ''): PendingCard[] {
    const now = this.now(), grace = this.options.graceMs ?? WAKE_GRACE_MS
    const present = new Set(cards.map(cardKey))
    for (const key of this.firstSeen.keys()) if (!present.has(key)) this.firstSeen.delete(key)
    const open = cards.filter(card => !this.woken.has(cardKey(card)) && !answeringAutomatically(card))
    const ripe = new Set<string>()
    for (const card of open) {
      const key = cardKey(card)
      if (!this.firstSeen.has(key)) this.firstSeen.set(key, now)
      // A card raised before Conductor first saw it (a review that escalated, a restart) counts
      // from when it was raised: the automatic answer already had its chance.
      const since = Math.min(this.firstSeen.get(key)!, card.requestedAt ?? Infinity)
      if (now - since >= grace) ripe.add(group(card))
    }
    return open.filter(card => ripe.has(group(card)))
  }
}

const line = (value: string, limit: number): string => { const flat = value.replace(/\s+/g, ' ').trim(); return flat.length > limit ? flat.slice(0, limit) + '…' : flat }
const quote = (value: string): string => JSON.stringify(value)

/** One card as the wake lists it, with the exact call that answers it. */
export function cardLine(card: PendingCard, options: { canAnswer: boolean; sealed?: boolean }): string {
  const what = options.sealed ? `${card.tool} (an anonymous conversation's action; read it in its tab)` : `${card.tool} ${quote(line(card.action, 300))}`
  const facts = [card.class ? `class ${card.class}` : '', card.attention ? `needs a careful look: ${card.attention}` : '', card.reason && !options.sealed ? `reason: ${line(card.reason, 200)}` : '', card.reviewPhase ? `stronger review: ${card.reviewPhase}` : ''].filter(Boolean).join('; ')
  const answer = !options.canAnswer ? 'the owner answers it in that tab'
    : card.kind === 'approval'
      ? `agents.approve({agentSessionId:${quote(card.agentSessionId)}, requestId:${quote(card.requestId)}, decision:"allow"|"deny", reason:"…"})`
      : `permissions.decide({agentSessionId:${quote(card.agentSessionId)}, requestId:${quote(card.requestId)}, decision:"approve-once"|"approve-session"|"deny"})`
  return `- "${card.title || 'Coworker'}" (${card.agentSessionId}) ${card.kind === 'approval' ? 'approval' : 'permission request'} ${card.requestId}: ${what}${facts ? ` (${facts})` : ''}. Answer: ${answer}`
}

/** The message that wakes a controller for its coworkers' cards. */
export function controllerWakeText(cards: readonly PendingCard[], options: { canAnswer: boolean; sealed?: (card: PendingCard) => boolean }): string {
  const lines = cards.map(card => cardLine(card, { canAnswer: options.canAnswer, sealed: options.sealed?.(card) })).join('\n')
  const head = cards.length === 1 ? 'A coworker you control is waiting on an approval nothing answered automatically:' : `Your coworkers are waiting on ${cards.length} approvals nothing answered automatically:`
  const tail = options.canAnswer ? 'Review the exact action first (agents.approvals shows it in full), answer each, then end your turn; do not poll agents.approvals.' : 'Only the owner (or a wizard tab) can answer them; carry on with other work or tell the owner.'
  return `[Conductor] ${head}\n${lines}\n${tail}`
}

/** The message that ends an agents.await({approvals:true}) because an awaited conversation asked. */
export function awaitWakeText(cards: readonly PendingCard[], options: { canAnswer: boolean; reason?: string; sealed?: (card: PendingCard) => boolean }): string {
  const lines = cards.map(card => cardLine(card, { canAnswer: options.canAnswer, sealed: options.sealed?.(card) })).join('\n')
  return `[Conductor] Your wait${options.reason ? ` (${options.reason})` : ''} ended because a conversation you wait for is asking for an approval:\n${lines}\nAnswer it${options.canAnswer ? '' : ' (or ask the owner to)'}, then declare agents.await again if you still wait for its result.`
}
