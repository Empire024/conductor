import type { PaneTab } from '../shared/models'
import type { SessionProjection } from '../shared/structured-agent'
import type { ArchiveResult } from '../shared/tab-archive'
import { unsettledReason, type FinishTarget } from './coworker-autoclose'

/**
 * Whether a tab may go to the workspace archive right now, decided in one place and applied
 * atomically (TabArchiver.archive re-reads every tab immediately before closing it, one request at
 * a time). A tab is refused when closing it would cut off work or lose a result:
 *
 * - its turn is running or being interrupted, it waits on an approval or a question, it waits out a
 *   usage limit, it has queued or in-flight steered messages (a coworker report that reached a
 *   busy controller waits here, uncollected), or background tasks still run (coworker-autoclose.ts
 *   unsettledReason, the rule agents.finish and the finished-tab sweep use);
 * - a delivery or other job it started has not finished, so its result has nowhere to go;
 * - it is a finished coworker whose report its controller has not collected yet: the report still
 *   sits, undelivered, in the controller's durable queue or pending steering (a report delivered
 *   as a turn leaves both, and only then is it collected; see uncollectedReportReason);
 * - it is the live wizard, still controls open coworkers, waits for other conversations' results
 *   (src/shared/awaiting-results.ts), or runs on another machine.
 *
 * A tab with no conversation (a terminal, a file, an agent tab that never started) is never busy.
 * The race with a turn starting is closed by a latch (StructuredSessions.beginArchive), taken
 * before the last check and held through the close and its UI acknowledgement: a submit or steer
 * that arrives meanwhile is refused with "The tab is being archived; no message was sent", never
 * queued and never run. A refusal or a failed close releases it; so does reopening the tab.
 * The owner's own close (the tab strip, the sidebar, Ctrl+W) keeps its confirm-and-undo instead:
 * the owner may close a working tab on purpose; this rule is for closes nobody confirms.
 */
export function archiveRefusal(
  target: Pick<FinishTarget, 'wizard' | 'controlsLiveCoworkers' | 'remote' | 'awaiting'> | undefined,
  state: SessionProjection | null | undefined,
  pendingWork: string | null = null,
  uncollectedReport: string | null = null
): string | null {
  if (state) { const busy = unsettledReason(state); if (busy) return busy }
  if (pendingWork) return pendingWork
  if (uncollectedReport) return uncollectedReport
  if (target?.wizard) return 'it is the live wizard'
  if (target?.controlsLiveCoworkers) return 'it still controls open coworkers; finish or release them first'
  if (target?.awaiting) return target.awaiting
  if (target?.remote) return 'it runs on another machine'
  return null
}

/**
 * A child's report is uncollected while one of the conversations it reports to (its controller,
 * or the successor that took over) still holds it undelivered: a queued prompt, or a pending steer
 * in any state short of delivered (sending, accepted, cancelled, uncertain), whose origin is the
 * child. agents.report sends through steerOrStart, so a report either starts a turn at once (a
 * delivered turn: collected) or waits in exactly those persisted lists until it is delivered.
 */
export function uncollectedReportReason(childId: string, controllers: ReadonlyArray<{ title: string; state: SessionProjection | null | undefined }>): string | null {
  for (const { title, state } of controllers) {
    if (!state) continue
    const waiting = [...(state.queuedPrompts ?? (state.queued ? [state.queued] : [])), ...(state.pendingSteering ?? [])]
    if (waiting.some(input => input.origin?.agentSessionId === childId)) return `its report to ${title} has not been collected yet`
  }
  return null
}

/** What a refusal says, e.g. “Coworker: llama slots” was not archived: its turn is still running. */
export const archiveRefusalMessage = (title: string, reason: string): string => `“${title}” was not archived: ${reason}.`

export type { ArchiveResult }

export interface TabArchiverDependencies {
  /** The tab as its workspace layout holds it now; undefined once it is gone. */
  layoutTab(projectId: string, sessionId: string, tabId: string): PaneTab | undefined
  /** Every agent tab open in this window (AgentControl.finishTargets). */
  targets(): FinishTarget[]
  snapshot(agentSessionId: string): SessionProjection | null
  /** A job this conversation started that has not finished (a git.ship delivery), as a reason. */
  pendingWork?(agentSessionId: string, projectId: string): string | null
  /** uncollectedReportReason for this conversation against the controllers it reports to. */
  uncollectedReport?(agentSessionId: string, target: FinishTarget | undefined): string | null
  /** Closes an agent tab with its history kept (AgentControl.closeFinished via CoworkerAutoClose). */
  closeAgent(target: FinishTarget): Promise<void>
  /** Closes any other tab through the window that shows it. */
  closeOther(projectId: string, sessionId: string, tabId: string): Promise<void>
  /** StructuredSessions.beginArchive/endArchive: no prompt reaches a conversation while it is set. */
  latch?: { begin(agentSessionId: string): void; end(agentSessionId: string): void }
}

export class TabArchiver {
  private running: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: TabArchiverDependencies) {}

  /** Closes each eligible tab into the archive and names each refused one with its reason. Calls
   *  run one after another, and every tab is checked again just before it closes. */
  archive(projectId: string, sessionId: string, tabIds: readonly string[]): Promise<ArchiveResult> {
    const next = this.running.catch(() => undefined).then(() => this.run(projectId, sessionId, [...new Set(tabIds)]))
    this.running = next
    return next
  }

  private async run(projectId: string, sessionId: string, tabIds: string[]): Promise<ArchiveResult> {
    const result: ArchiveResult = { archived: [], refused: [] }
    const refuse = (tabId: string, title: string, reason: string): void => { result.refused.push({ tabId, title, reason, message: archiveRefusalMessage(title, reason) }) }
    for (const tabId of tabIds) {
      const tab = this.deps.layoutTab(projectId, sessionId, tabId)
      if (!tab) { refuse(tabId, tabId, 'it is not open in this workspace'); continue }
      const title = tab.title || 'Untitled tab'
      const target = tab.kind === 'agent' ? this.deps.targets().find(candidate => candidate.tabId === tabId && candidate.sessionId === sessionId) : undefined
      const agentSessionId = tab.kind === 'agent' ? tab.resourceId : undefined
      // Latched before the last check, so nothing can start between the check and the close; a
      // successful close keeps the latch (the conversation's tab is gone) until it is reopened.
      if (agentSessionId) this.deps.latch?.begin(agentSessionId)
      const release = (): void => { if (agentSessionId) this.deps.latch?.end(agentSessionId) }
      const reason = agentSessionId ? archiveRefusal(target, this.deps.snapshot(agentSessionId), this.deps.pendingWork?.(agentSessionId, projectId) ?? null, this.deps.uncollectedReport?.(agentSessionId, target) ?? null) : null
      if (reason) { release(); refuse(tabId, title, reason); continue }
      try {
        if (target) await this.deps.closeAgent(target)
        else await this.deps.closeOther(projectId, sessionId, tabId)
        result.archived.push({ tabId, title })
      } catch (error) { release(); refuse(tabId, title, error instanceof Error ? error.message : String(error)) }
    }
    return result
  }
}
