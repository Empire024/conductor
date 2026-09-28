import type { PaneTab } from './models'

/**
 * The per-workspace tab archive (feature-list 4538163d). Every tab the owner or an agent closes
 * lands here, not only the last 20 the reopen list (`SessionRecord.closedTabs`) keeps: searchable,
 * reopened into its own workspace, or deleted for good. An agent tab keeps its conversation, so
 * reopening it shows the history it had.
 */
export interface ArchivedTab {
  tab: PaneTab
  projectId: string
  sessionId: string
  /** The workspace's name, for a match found across workspaces (Ctrl+K). */
  workspaceName?: string
  /** ISO time it was archived. */
  closedAt: string
}

export interface ArchivedTabPage { tabs: ArchivedTab[]; total: number }

/**
 * Where a tab an agent opened came from, rendered as its first line at zero model tokens:
 * "continued from" for a handoff successor, "opened by" for a coworker or any other tab an agent
 * opened. `open` says where the opener's tab is now; `archived` is set when it was closed and can
 * be brought back from the archive.
 */
export interface TabLineage {
  relation: 'continued' | 'opened'
  agentSessionId: string
  title: string
  archived?: { projectId: string; sessionId: string; tabId: string }
}

/** The setting that records which agent opened an agent tab: `tabOpenedBy:<agentSessionId>`. */
export const TAB_OPENED_BY_PREFIX = 'tabOpenedBy:'

/** How many closed tabs the quick reopen list (Ctrl+Shift+T) keeps; the archive keeps them all. */
export const CLOSED_TABS_LIMIT = 20

/** tabArchive.archive: what closed into the archive, and each tab refused with its reason
 *  (src/main/tab-archive-eligibility.ts). `message` reads “<title>” was not archived: <reason>. */
export interface ArchiveResult {
  archived: Array<{ tabId: string; title: string }>
  refused: Array<{ tabId: string; title: string; reason: string; message: string }>
}

export interface TabArchiveBridge {
  /** Closes these tabs into the archive unless one is busy (a turn, an approval or question, a
   *  limit wait, queued messages, background tasks, an unfinished delivery it started) or protected
   *  (the live wizard, a controller with open coworkers, a tab on another machine). Atomic per tab. */
  archive(projectId: string, sessionId: string, tabIds: string[]): Promise<ArchiveResult>
  list(sessionId: string, query?: string, limit?: number): Promise<ArchivedTabPage>
  /** Archived tabs of every open workspace whose title (or agent/tab id) matches, newest first. */
  search(query: string, limit?: number): Promise<ArchivedTab[]>
  /** Puts these tabs back into their workspace (switching to it) and out of the archive. */
  reopen(sessionId: string, tabIds: string[]): Promise<{ reopened: number }>
  /** Deletes these entries for good. A conversation's history stays in Conductor's journal. */
  remove(sessionId: string, tabIds: string[]): Promise<{ removed: number }>
  /** Archives tabs just closed, for closes that bypass the saved reopen list (a bulk close, a detached window). */
  record(sessionId: string, tabs: PaneTab[]): Promise<void>
  lineage(agentSessionId: string): Promise<TabLineage | null>
  onChanged(callback: (change: { sessionId: string }) => void): () => void
}
