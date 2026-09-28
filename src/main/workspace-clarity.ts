import type { LayoutNode, PaneTab } from '../shared/models'
import type { SessionProjection } from '../shared/structured-agent'
import { finishedCloseRefusal, finishedTabSweepHours, handedOffIn, tabPinned, tabSeenAt, type AgentTabFacts } from '../shared/workspace-clarity'
import { unsettledReason, type FinishTarget } from './coworker-autoclose'

/**
 * The main-process half of workspace clarity (src/shared/workspace-clarity.ts): the facts about
 * each agent tab the renderer cannot see (wizard, handed off, when it settled), the owner's
 * "Close finished tabs", and the sweep that closes finished tabs nobody looked at for the owner's
 * age (default a day). Both close through AgentControl.closeFinished, the route agents.finish
 * uses, so the tab lands in the workspace's closed tabs with history kept and a controller that
 * dispatched it still reaches it (agents.steer reopens it).
 */

const SWEEP_MS = 10 * 60_000

/** When a settled conversation last did anything: its newest timeline item's first-seen time.
 *  agent_sessions.updated_at is rewritten by every status flush, restarts included, so it is not. */
export function settledAt(state: SessionProjection | null | undefined): string | undefined {
  if (!state?.items.length || unsettledReason(state)) return undefined
  const last = state.items.reduce((latest, item) => item.sequence > latest.sequence ? item : latest)
  return Number.isFinite(Date.parse(last.timestamp)) ? last.timestamp : undefined
}

export function agentTabFacts(state: SessionProjection | null | undefined, wizard: boolean): AgentTabFacts {
  const settled = settledAt(state), busy = state ? unsettledReason(state) : null
  const live = busy ? (state!.phase === 'waiting_approval' || state!.phase === 'waiting_input' ? 'waiting' as const : 'running' as const) : undefined
  return { wizard, handedOff: state ? handedOffIn(state.items) : false, ...(settled ? { settledAt: settled } : {}), ...(live ? { live } : {}) }
}

/** Finished as main sees it, without the renderer's phase map: it ran, and nothing of it is still going. */
const finishedState = (state: SessionProjection | null | undefined): boolean =>
  Boolean(state?.items.length) && !unsettledReason(state) && state!.phase !== 'starting'

export const tabsIn = (root: LayoutNode): PaneTab[] => root.type === 'split' ? [...tabsIn(root.children[0]), ...tabsIn(root.children[1])] : root.tabs

export interface LayoutTab { tab: PaneTab; active: boolean }
export function findLayoutTab(root: LayoutNode, tabId: string): LayoutTab | undefined {
  if (root.type === 'split') return findLayoutTab(root.children[0], tabId) ?? findLayoutTab(root.children[1], tabId)
  const tab = root.tabs.find(candidate => candidate.id === tabId)
  return tab ? { tab, active: root.activeTabId === tabId } : undefined
}

export interface FinishedTabsDependencies {
  settings: { getSetting(key: string): string | null }
  snapshot(id: string): SessionProjection | null
  /** Every agent tab open in this window (AgentControl.finishTargets). */
  targets(): FinishTarget[]
  /** The tab as the workspace layout holds it; undefined for one in a detached window. */
  layoutTab(target: FinishTarget): LayoutTab | undefined
  /** AgentControl.closeFinished, then the CLI release (CoworkerAutoClose does both for coworkers). */
  close(target: FinishTarget): Promise<void>
  /** Test runs only: replaces the owner's hours. */
  ageOverrideMs?: number
  now?(): number
}

export interface CloseFinishedResult { closed: number; kept: Array<{ tabId: string; title: string; reason: string }> }

export class FinishedTabs {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<CloseFinishedResult>

  constructor(private readonly deps: FinishedTabsDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Null is Off. */
  ageMs(): number | null {
    const hours = finishedTabSweepHours(key => this.deps.settings.getSetting(key))
    if (!hours) return null
    return this.deps.ageOverrideMs ?? hours * 3_600_000
  }

  start(): void {
    if (this.timer) return
    const every = this.deps.ageOverrideMs ? Math.max(250, Math.min(SWEEP_MS, Math.floor(this.deps.ageOverrideMs / 2))) : SWEEP_MS
    this.timer = setInterval(() => { void this.sweep() }, every)
    this.timer.unref?.()
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  private refusal(target: FinishTarget, aged: boolean): string | null {
    const state = this.deps.snapshot(target.agentSessionId), placed = this.deps.layoutTab(target)
    const busy = unsettledReason(state)
    // A wizard whose last turn failed or was stopped, or that handed itself on, is ended work
    // (the sidebar says so), even while its wand is still set; only a live one is kept.
    const ended = state ? ['failed', 'interrupted', 'disconnected'].includes(state.phase) || handedOffIn(state.items) : false
    const base = { finished: finishedState(state), pinned: placed ? tabPinned(placed.tab) : false, wizard: target.wizard && !ended, controlsLiveCoworkers: target.controlsLiveCoworkers, remote: target.remote, busy }
    if (!aged) return finishedCloseRefusal(base)
    // A tab in a detached window is on screen as far as the sweep can tell.
    const settled = settledAt(state)
    return finishedCloseRefusal(base, { active: placed?.active ?? true, settledAt: settled ? Date.parse(settled) : undefined, seenAt: placed ? tabSeenAt(placed.tab) : undefined, now: this.now(), ageMs: this.ageMs() ?? Infinity })
  }

  /** The owner's "Close finished tabs" for one workspace. `tabIds` is what the owner confirmed;
   *  each is checked again here, and whatever may not close is named with the reason. */
  closeFinished(projectId: string, sessionId: string, tabIds: readonly string[]): Promise<CloseFinishedResult> {
    const wanted = new Set(tabIds)
    return this.serial(() => this.deps.targets().filter(target => target.projectId === projectId && target.sessionId === sessionId && wanted.has(target.tabId)), false)
  }

  /** One automatic pass over every workspace. */
  sweep(): Promise<CloseFinishedResult> {
    if (this.ageMs() === null) return Promise.resolve({ closed: 0, kept: [] })
    return this.serial(() => this.deps.targets(), true)
  }

  private serial(select: () => FinishTarget[], aged: boolean): Promise<CloseFinishedResult> {
    const previous = this.running ?? Promise.resolve({ closed: 0, kept: [] })
    const next = previous.catch(() => undefined).then(() => this.run(select(), aged))
    const tracked: Promise<CloseFinishedResult> = next.finally(() => { if (this.running === tracked) this.running = undefined })
    this.running = tracked
    return next
  }

  private async run(targets: FinishTarget[], aged: boolean): Promise<CloseFinishedResult> {
    const result: CloseFinishedResult = { closed: 0, kept: [] }
    // Coworkers first, each read again before it closes: a finished controller whose finished
    // coworkers close in the same pass no longer "controls open coworkers" by its turn.
    const ordered = [...targets].sort((a, b) => Number(!a.controller) - Number(!b.controller))
    for (const planned of ordered) {
      const target = this.deps.targets().find(candidate => candidate.tabId === planned.tabId)
      if (!target) continue
      const refused = this.refusal(target, aged)
      if (refused) { if (!aged) result.kept.push({ tabId: target.tabId, title: target.title, reason: refused }); continue }
      try { await this.deps.close(target); result.closed++ }
      catch (error) { result.kept.push({ tabId: target.tabId, title: target.title, reason: error instanceof Error ? error.message : String(error) }) }
    }
    return result
  }
}
