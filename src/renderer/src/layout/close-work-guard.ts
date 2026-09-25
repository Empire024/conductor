import type { AgentActivityPhase, PaneTab } from '../../../shared/models'
import type { SessionProjection } from '../../../shared/structured-agent'
import { describeSessionWork, hasSessionWork } from '../../../shared/session-work'

/** How long a confirmed close of working tabs can be undone. Their turns stop only after it. */
export const CLOSE_UNDO_MS = 6000

export interface WorkingTab { tab: PaneTab; work: string }
export interface CloseWorkRequest { id: number; working: WorkingTab[]; closing: number; message: string }
export interface CloseUndoOffer { id: number; message: string; deadline: number }
export interface CloseWorkState { request: CloseWorkRequest | null; undo: CloseUndoOffer | null }

type Snapshot = (agentSessionId: string) => Promise<SessionProjection | null>
type PhaseOf = (tab: PaneTab) => AgentActivityPhase | undefined

const quote = (title: string): string => '“' + (title.trim() || 'This tab') + '”'

/** Agent tabs among `tabs` that still have work, by the same rule app-control tabs.close and the
 *  quit dialog use (hasSessionWork). A tab whose conversation cannot be read falls back to its
 *  activity phase, so an unreadable snapshot never silently closes a turn in front of the owner. */
export async function findWorkingTabs(tabs: PaneTab[], snapshot: Snapshot, phaseOf?: PhaseOf): Promise<WorkingTab[]> {
  const checks = tabs.filter(tab => tab.kind === 'agent' && tab.resourceId).map(async (tab): Promise<WorkingTab | null> => {
    let state: SessionProjection | null = null
    try { state = await snapshot(tab.resourceId!) } catch { state = null }
    if (state) return hasSessionWork(state) ? { tab, work: describeSessionWork(state) } : null
    const phase = phaseOf?.(tab)
    return phase === 'working' || phase === 'waiting_background' || phase === 'waiting_input' ? { tab, work: 'still working' } : null
  })
  return (await Promise.all(checks)).filter((item): item is WorkingTab => item !== null)
}

export function closeWorkMessage(working: WorkingTab[]): string {
  if (working.length === 1) return `${quote(working[0]!.tab.title)} is still working — close and stop it?`
  return `${working.length} tabs are still working — close and stop them?`
}

let state: CloseWorkState = { request: null, undo: null }
let nextId = 1
let answer: ((ok: boolean) => void) | null = null
let pendingUndo: { restore(): void; expire(): void; timer: ReturnType<typeof setTimeout> } | null = null
const listeners = new Set<(state: CloseWorkState) => void>()
const publish = (next: CloseWorkState): void => { state = next; for (const listener of listeners) listener(state) }

/** The confirmation host (CloseWorkConfirm) subscribes; without one the browser's confirm asks. */
export function subscribeCloseWork(listener: (state: CloseWorkState) => void): () => void {
  listeners.add(listener)
  listener(state)
  return () => { listeners.delete(listener) }
}
export const closeWorkState = (): CloseWorkState => state

/** One question at a time: a second close while the owner is deciding is declined, not queued. */
export function confirmCloseWork(working: WorkingTab[], closing: number): Promise<boolean> {
  if (state.request) return Promise.resolve(false)
  const message = closeWorkMessage(working)
  if (!listeners.size) return Promise.resolve(typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false)
  return new Promise(resolve => {
    answer = resolve
    publish({ ...state, request: { id: nextId++, working, closing, message } })
  })
}
export function answerCloseWork(ok: boolean): void {
  const resolve = answer
  answer = null
  publish({ ...state, request: null })
  resolve?.(ok)
}

/** Every owner close path calls this first. null: the owner kept the tabs. Otherwise the working
 *  tabs (possibly none), which the caller hands to offerCloseUndo once they are closed. */
export async function guardTabClose(tabs: PaneTab[], phaseOf?: PhaseOf, snapshot: Snapshot = id => window.conductor.structured.snapshot(id)): Promise<WorkingTab[] | null> {
  const working = await findWorkingTabs(tabs, snapshot, phaseOf)
  if (!working.length) return []
  return await confirmCloseWork(working, tabs.length) ? working : null
}

/** After a confirmed close the owner has CLOSE_UNDO_MS to take it back: undo restores the tabs,
 *  whose conversations are still running and reattach. Only when the offer lapses are the turns of
 *  tabs that are still closed stopped. A newer offer settles the older one at once. */
export function offerCloseUndo(working: WorkingTab[], actions: { restore(): void; stop(tab: PaneTab): void; stillClosed(tab: PaneTab): boolean }, ms = CLOSE_UNDO_MS): void {
  if (!working.length) return
  settleUndo(false)
  const expire = (): void => { for (const { tab } of working) if (actions.stillClosed(tab)) actions.stop(tab) }
  pendingUndo = { restore: actions.restore, expire, timer: setTimeout(() => settleUndo(false), ms) }
  const message = working.length === 1 ? `Closed ${quote(working[0]!.tab.title)} — its turn stops in a few seconds.` : `Closed ${working.length} working tabs — their turns stop in a few seconds.`
  publish({ ...state, undo: { id: nextId++, message, deadline: Date.now() + ms } })
}
/** true: restore the closed tabs; false: let the close stand now. */
export function settleUndo(restore: boolean): void {
  const pending = pendingUndo
  if (!pending) return
  pendingUndo = null
  clearTimeout(pending.timer)
  publish({ ...state, undo: null })
  if (restore) pending.restore()
  else pending.expire()
}
