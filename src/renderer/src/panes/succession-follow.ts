import type { ContextAttachment } from '../../../shared/structured-agent'

// feature-list conductor-task:3a590e76. A main brain that hands itself on (agents.handoff
// successor:true) used to disable its composer the moment the "Continued in" notice arrived: the
// owner's half-typed message froze in place, focus dropped out of the textarea, and the words had
// to be copied over by hand. Now the conversation the owner is looking at takes them to the
// successor, and the unsent draft (text, attachments and caret) goes with them.

/** A draft never holds more attachments than this (composer-draft-store refuses more). */
export const MAX_DRAFT_ATTACHMENTS = 20

export interface DraftParts { message: string; attachments: ContextAttachment[] }

/** Whether a mounted pane takes the owner to its successor by itself: only for a succession that
 *  arrived while the owner had this conversation open live. One opened afterwards (the banner is
 *  already there) stays put, and so does a saved conversation previewed from history. */
export function shouldFollowSuccession(input: { succession: boolean; sawLiveConversation: boolean; followed: boolean; historical: boolean }): boolean {
  return input.succession && input.sawLiveConversation && !input.followed && !input.historical
}

export interface MovedDraft {
  /** The successor's draft after the move. */
  target: DraftParts
  /** What stays with the predecessor: attachments that did not fit, nothing else. */
  source: DraftParts
  /** Where the owner's caret lands in the successor's text. */
  caret: number
  moved: boolean
}

/** Moves a predecessor's unsent draft onto the successor's. Text the successor already holds
 *  stays first; attachments it already has are not doubled; ones past the limit stay behind
 *  rather than being dropped, so nothing the owner put in is ever discarded. */
export function mergeMovedDraft(source: DraftParts, target: DraftParts, sourceCaret?: number | null): MovedDraft {
  const known = new Set(target.attachments.map(attachment => attachment.id))
  const incoming = source.attachments.filter(attachment => !known.has(attachment.id))
  const room = Math.max(0, MAX_DRAFT_ATTACHMENTS - target.attachments.length)
  const fits = incoming.slice(0, room)
  const left = incoming.slice(room)
  const separator = target.message && source.message ? (target.message.endsWith('\n\n') ? '' : target.message.endsWith('\n') ? '\n' : '\n\n') : ''
  const prefix = source.message ? target.message + separator : target.message
  const offset = sourceCaret === null || sourceCaret === undefined || !Number.isFinite(sourceCaret) ? source.message.length : Math.min(Math.max(0, Math.trunc(sourceCaret)), source.message.length)
  if (!source.message && !fits.length && left.length === source.attachments.length) return { target, source, caret: target.message.length, moved: false }
  return {
    target: { message: prefix + source.message, attachments: [...target.attachments, ...fits] },
    source: { message: '', attachments: left },
    caret: prefix.length + offset,
    moved: true
  }
}

export interface SuccessionFollow {
  projectId: string
  fromSessionId: string
  toSessionId: string
  /** Whether the owner was in the predecessor's composer: the successor's composer takes focus. */
  focus: boolean
  /** The predecessor's caret, read when the draft moves; null puts it at the end. */
  caret: () => number | null
  /** Set once the draft moved: where the caret lands in the successor. */
  delivered?: { caret: number; moved: boolean }
}

const followKey = (projectId: string, sessionId: string): string => JSON.stringify([projectId, sessionId])
const follows = new Map<string, SuccessionFollow>()
const arrivalListeners = new Map<string, Set<() => void>>()

/** Registers that the owner is being taken from a predecessor to its successor. Returns a cancel
 *  that leaves the draft where it is (the switch did not happen); a delivered move stays. */
export function beginSuccessionFollow(follow: SuccessionFollow): () => void {
  const key = followKey(follow.projectId, follow.toSessionId)
  follows.set(key, follow)
  return () => { if (follows.get(key) === follow && !follow.delivered) follows.delete(key) }
}

/** The follow under way into this conversation, if any. */
export function successionFollowInto(projectId: string, toSessionId: string): SuccessionFollow | undefined {
  return follows.get(followKey(projectId, toSessionId))
}

/** The follow under way out of this conversation, if any. */
export function successionFollowFrom(projectId: string, fromSessionId: string): SuccessionFollow | undefined {
  for (const follow of follows.values()) if (follow.projectId === projectId && follow.fromSessionId === fromSessionId) return follow
  return undefined
}

/** Ends a follow once the successor took it (focused its composer). */
export function finishSuccessionFollow(follow: SuccessionFollow): void {
  const key = followKey(follow.projectId, follow.toSessionId)
  if (follows.get(key) === follow) follows.delete(key)
}

/** A mounted successor pane listens so a follow that delivers while it is already showing (a
 *  split view) still focuses it. */
export function subscribeSuccessionArrival(projectId: string, toSessionId: string, listener: () => void): () => void {
  const key = followKey(projectId, toSessionId)
  let set = arrivalListeners.get(key)
  if (!set) arrivalListeners.set(key, set = new Set())
  set.add(listener)
  return () => { set.delete(listener); if (!set.size && arrivalListeners.get(key) === set) arrivalListeners.delete(key) }
}

export function hasSuccessionArrivalListener(projectId: string, toSessionId: string): boolean {
  return Boolean(arrivalListeners.get(followKey(projectId, toSessionId))?.size)
}

export function notifySuccessionArrival(projectId: string, toSessionId: string): void {
  arrivalListeners.get(followKey(projectId, toSessionId))?.forEach(listener => listener())
}

/** For tests: forget every follow and listener. */
export function resetSuccessionFollows(): void {
  follows.clear()
  arrivalListeners.clear()
}
