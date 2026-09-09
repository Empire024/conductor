export type RecentFilesStore = Pick<Storage, 'getItem' | 'setItem'>
interface RecentFileEntry { path: string; at: number }
const PREFIX = 'conductor.recentFiles.'
const LIMIT = 20
const browserStore = (): RecentFilesStore | undefined => { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
const isEntry = (value: unknown): value is RecentFileEntry => !!value && typeof value === 'object' && typeof (value as RecentFileEntry).path === 'string' && typeof (value as RecentFileEntry).at === 'number'
const read = (projectId: string, store: RecentFilesStore | undefined): RecentFileEntry[] => {
  try { const parsed: unknown = JSON.parse(store?.getItem(PREFIX + projectId) ?? 'null'); return Array.isArray(parsed) ? parsed.filter(isEntry) : [] } catch { return [] }
}
/** Recorded only when a file actually lands in an editor tab, so picker keystrokes and previews never pollute recency. Per-project storage keeps one project's history from evicting another's. */
export function recordRecentFile(projectId: string, path: string, store = browserStore(), now = Date.now()): void {
  if (!store || !projectId || !path) return
  const next = [{ path, at: now }, ...read(projectId, store).filter((entry) => entry.path !== path)].slice(0, LIMIT)
  try { store.setItem(PREFIX + projectId, JSON.stringify(next)) } catch { /* storage quota or a blocked origin */ }
}
/** Most-recent-first across every requested project, so the picker can merge history from all loaded projects like VS Code's Go to File. */
export function recentFiles(projectIds: string[], store = browserStore()): { projectId: string; path: string }[] {
  return projectIds.flatMap((projectId) => read(projectId, store).map((entry) => ({ projectId, path: entry.path, at: entry.at })))
    .sort((a, b) => b.at - a.at).map(({ projectId, path }) => ({ projectId, path }))
}
