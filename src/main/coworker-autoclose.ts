import type { AgentSpec } from '../shared/models'
import type { DeliveryRun } from '../shared/delivery'
import type { SessionProjection } from '../shared/structured-agent'
import { hasSessionWork } from './close-confirmation'

/**
 * Finished coworkers close themselves (feature-list `auto-close-finished-coworkers`). On
 * 2026-09-25 the owner found 30 finished coworker tabs in one workspace, each holding a `claude`
 * CLI alive: 36 processes, 10 GB. Three routes out:
 *
 * - agents.finish({agentSessionId}): a controller closes a settled coworker it controls, at once;
 * - agents.finish({}): a coworker closes itself as its last act, once its turn has settled;
 * - this sweep: a coworker whose git.ship ended `delivered` and that has sat settled, with no
 *   background tasks, for the owner's timeout is closed. Separately, any settled Claude or Codex
 *   runtime idle that long gives its CLI process back; the next message reconnects the same
 *   native conversation lazily (StructuredSessions.killWhere keeps a settled conversation's phase).
 *
 * A close keeps history: the tab goes to the workspace's closed tabs through the same renderer
 * route tabs.close uses, so it reopens from the usual closed-tab list.
 */

/** Minutes; '0' is Off. */
export const COWORKER_AUTOCLOSE_SETTING = 'coworkerAutoCloseMinutes'
export const DEFAULT_COWORKER_AUTOCLOSE_MINUTES = 10
export const COWORKER_AUTOCLOSE_CHOICES = [0, 5, 10, 20, 30, 60] as const
/** Set by AgentControl.open on a tab a controller opened (tabs.open, router.dispatch, a handoff):
 *  the mark of a coworker, as opposed to the owner's own tab a controller later took over. */
export const COWORKER_OPENED_PREFIX = 'coworkerOpenedBy:'
/** A git.ship this conversation requested ended `delivered`. */
export const COWORKER_DELIVERED_PREFIX = 'coworkerDelivered:'

const SWEEP_MS = 60_000
const SELF_FINISH_POLL_MS = 2_000

type Settings = { getSetting(key: string): string | null; setSetting(key: string, value: string): void; removeSetting(key: string): void }

export function coworkerAutoCloseMinutes(getSetting: (key: string) => string | null): number {
  const stored = Number(getSetting(COWORKER_AUTOCLOSE_SETTING))
  return getSetting(COWORKER_AUTOCLOSE_SETTING) !== null && (COWORKER_AUTOCLOSE_CHOICES as readonly number[]).includes(stored) ? stored : DEFAULT_COWORKER_AUTOCLOSE_MINUTES
}

export function normalizeCoworkerAutoCloseMinutes(value: unknown): number {
  if (typeof value !== 'number' || !(COWORKER_AUTOCLOSE_CHOICES as readonly number[]).includes(value)) throw new Error(`Choose one of ${COWORKER_AUTOCLOSE_CHOICES.join(', ')} minutes (0 is Off)`)
  return value
}

/** One agent tab as the finish rules see it. */
export interface FinishTarget {
  agentSessionId: string
  projectId: string
  sessionId: string
  tabId: string
  title: string
  provider?: string
  /** Who controls this tab through a live control link, if anyone. */
  controller: string | null
  /** A controller opened it (COWORKER_OPENED_PREFIX). */
  opened: boolean
  wizard: boolean
  /** It is itself a controller whose coworkers still have open tabs. */
  controlsLiveCoworkers: boolean
  /** It runs on, or is driven by, another machine. */
  remote: boolean
}

/** Why this conversation is not settled, in words for a refusal; null when it is. */
export function unsettledReason(state: SessionProjection | null | undefined): string | null {
  if (!state) return 'it has no conversation state here'
  if (state.phase === 'running' || state.phase === 'interrupting') return 'its turn is still running'
  if (state.phase === 'waiting_approval') return 'it is waiting on an approval'
  if (state.phase === 'waiting_input') return 'it is waiting on an answer to a question'
  if (state.limitResumeAt) return 'it waits out a usage limit and continues at the reset'
  if (state.queued || state.queuedPrompts?.length) return 'it has queued messages'
  if (state.pendingSteering?.some(input => input.status === 'sending' || input.status === 'accepted')) return 'a message is being steered into it'
  if ((state.backgroundTasks ?? 0) > 0) return `it has ${state.backgroundTasks} background task${state.backgroundTasks === 1 ? '' : 's'} still running`
  return hasSessionWork(state) ? 'it has background tasks still running' : null
}

/** What makes a tab one Conductor never closes on its own or at a coworker's own request. */
function protectedReason(target: FinishTarget): string | null {
  if (target.wizard) return 'it is a wizard tab'
  if (target.controlsLiveCoworkers) return 'it still controls open coworkers; finish or release them first'
  if (target.remote) return 'it runs on another machine'
  return null
}

export interface FinishResult {
  agentSessionId: string
  tabId: string
  finished: boolean
  note: string
}

export interface CoworkerAutoCloseDependencies {
  settings: Settings
  snapshot(id: string): SessionProjection | null
  /** Every agent tab in the workspaces open in this window. */
  targets(): FinishTarget[]
  /** Closes the tab with its history kept and drops its control link; rejects with the reason it
   *  could not (the renderer refuses a tab with an unsent draft). */
  close(target: FinishTarget): Promise<void>
  /** Stops the live runtimes the predicate selects (StructuredSessions.killWhere). */
  release(select: (spec: AgentSpec) => boolean): void
  notice?(id: string, message: string): void
  /** Test runs only: replaces the owner's minutes so a smoke need not wait ten of them. */
  timeoutOverrideMs?: number
  now?(): number
}

export class CoworkerAutoClose {
  /** When each settled conversation was first seen settled at its current sequence. */
  private readonly idle = new Map<string, { sequence: number; since: number }>()
  private readonly selfFinish = new Map<string, FinishTarget>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private pollTimer?: ReturnType<typeof setTimeout>
  private sweeping?: Promise<void>
  private disposed = false

  constructor(private readonly deps: CoworkerAutoCloseDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  start(): void {
    if (this.sweepTimer || this.disposed) return
    const override = this.deps.timeoutOverrideMs
    const every = override ? Math.max(250, Math.min(SWEEP_MS, Math.floor(override / 2))) : SWEEP_MS
    this.sweepTimer = setInterval(() => { void this.sweep() }, every)
    this.sweepTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.sweepTimer = this.pollTimer = undefined
  }

  /** Null is Off: nothing closes or is released on a timer. */
  timeoutMs(): number | null {
    const minutes = coworkerAutoCloseMinutes(key => this.deps.settings.getSetting(key))
    if (minutes === 0) return null
    return this.deps.timeoutOverrideMs ?? minutes * 60_000
  }

  /** DeliveryService.onChanged: a coworker's delivered ship makes it finished work. */
  noteDelivery(run: DeliveryRun): void {
    if (run.state !== 'delivered' || run.requestedBy.kind !== 'agent') return
    this.deps.settings.setSetting(COWORKER_DELIVERED_PREFIX + run.requestedBy.agentSessionId, run.finishedAt ?? new Date(this.now()).toISOString())
  }

  delivered(id: string): boolean { return this.deps.settings.getSetting(COWORKER_DELIVERED_PREFIX + id) !== null }

  /** agents.finish({agentSessionId}) from its controller: close now, or refuse naming why. */
  async finish(target: FinishTarget): Promise<FinishResult> {
    const refused = protectedReason(target)
    if (refused) throw new Error(`Conductor will not finish “${target.title}”: ${refused}`)
    const busy = unsettledReason(this.deps.snapshot(target.agentSessionId))
    if (busy) throw new Error(`“${target.title}” cannot be finished yet: ${busy}. Finish it once agents.status shows it settled with no background tasks`)
    await this.closeAndRelease(target)
    return { agentSessionId: target.agentSessionId, tabId: target.tabId, finished: true, note: `“${target.title}” is closed with its history kept (reopen it from the closed tabs) and its CLI process is released.` }
  }

  /** agents.finish({}) from the coworker itself, in its last turn: closes once that turn settles. */
  requestSelfFinish(target: FinishTarget): FinishResult {
    if (!target.controller && !target.opened) throw new Error('This is the owner’s own tab, not a coworker a controller opened; only a coworker finishes itself')
    const refused = protectedReason(target)
    if (refused) throw new Error(`Conductor will not finish this tab: ${refused}`)
    const state = this.deps.snapshot(target.agentSessionId)
    const background = state?.backgroundTasks ?? 0
    if (background > 0) throw new Error(`This tab cannot finish yet: it has ${background} background task${background === 1 ? '' : 's'} still running. Finish once they are done`)
    this.selfFinish.set(target.agentSessionId, target)
    this.schedulePoll()
    return { agentSessionId: target.agentSessionId, tabId: target.tabId, finished: false, note: 'Conductor closes this tab (history kept) and releases its CLI as soon as this turn settles. End your turn now; do not start more work.' }
  }

  private schedulePoll(): void {
    if (this.pollTimer || this.disposed || !this.selfFinish.size) return
    this.pollTimer = setTimeout(() => { this.pollTimer = undefined; void this.pollSelfFinish() }, SELF_FINISH_POLL_MS)
    this.pollTimer.unref?.()
  }

  private async pollSelfFinish(): Promise<void> {
    const open = new Map(this.deps.targets().map(target => [target.agentSessionId, target]))
    for (const [id, requested] of [...this.selfFinish]) {
      const target = open.get(id)
      if (!target) { this.selfFinish.delete(id); continue }
      if (unsettledReason(this.deps.snapshot(id))) continue
      this.selfFinish.delete(id)
      try { await this.closeAndRelease(target) }
      catch (error) { this.deps.notice?.(id, `Conductor kept “${requested.title}” open after agents.finish: ${reason(error)}.`) }
    }
    this.schedulePoll()
  }

  /** One pass of the automatic rules. Overlapping calls share the pass in flight. */
  sweep(): Promise<void> {
    return this.sweeping ??= this.runSweep().finally(() => { this.sweeping = undefined })
  }

  private async runSweep(): Promise<void> {
    const timeout = this.timeoutMs()
    if (timeout === null) { this.idle.clear(); return }
    const now = this.now(), seen = new Set<string>()
    const idleFor = (id: string, state: SessionProjection | null): number | null => {
      seen.add(id)
      if (unsettledReason(state)) { this.idle.delete(id); return null }
      const entry = this.idle.get(id)
      if (!entry || entry.sequence !== state!.sequence) { this.idle.set(id, { sequence: state!.sequence, since: now }); return 0 }
      return now - entry.since
    }
    for (const target of this.deps.targets()) {
      const id = target.agentSessionId
      const idle = idleFor(id, this.deps.snapshot(id))
      if (idle === null || idle < timeout || this.selfFinish.has(id)) continue
      if (!target.opened || protectedReason(target) || !this.delivered(id)) continue
      try { await this.closeAndRelease(target) } catch { /* An unsent draft keeps it; the next pass asks again. */ }
    }
    // Idle CLI release: any settled Claude or Codex runtime, open tab or not. The conversation
    // keeps its phase and reconnects its native session on the next message.
    this.deps.release(spec => {
      if (spec.provider !== 'claude' && spec.provider !== 'codex') return false
      // A conversation handed to the terminal CLI is run by that process, not by this runtime.
      if (this.deps.settings.getSetting('cliHandoff:' + spec.id) !== null) return false
      const idle = idleFor(spec.id, this.deps.snapshot(spec.id))
      return idle !== null && idle >= timeout
    })
    for (const id of [...this.idle.keys()]) if (!seen.has(id)) this.idle.delete(id)
  }

  private async closeAndRelease(target: FinishTarget): Promise<void> {
    const id = target.agentSessionId
    await this.deps.close(target)
    // Closed means done: a runtime that settled is stopped now rather than after the idle timeout.
    this.deps.release(spec => spec.id === id && !unsettledReason(this.deps.snapshot(id)))
    this.deps.settings.removeSetting(COWORKER_DELIVERED_PREFIX + id)
    // Reopened from history it is the owner's tab again, never closed on a timer.
    this.deps.settings.removeSetting(COWORKER_OPENED_PREFIX + id)
    this.idle.delete(id)
    this.selfFinish.delete(id)
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
