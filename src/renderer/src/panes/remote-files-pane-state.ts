import type { RemoteFileEntry, RemoteFileIdentity, RemoteFilePreviewKind, RemotePromptFileAttachment } from '../../../shared/remote-files'
import type { AgentFileChange } from '../../../shared/agent-control'

const normalizeDirectory = (path: string): string => path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/')

export const remoteTreeKey = (file: RemoteFileIdentity): string =>
  `${file.machineId}\0${file.projectId}\0${normalizeDirectory(file.path)}`

export function acceptRemoteTreeResponse(
  requested: RemoteFileIdentity,
  currentKey: string,
  entries: RemoteFileEntry[]
): RemoteFileEntry[] | null {
  if (remoteTreeKey(requested) !== currentKey) return null
  const directory = normalizeDirectory(requested.path)
  if (!Array.isArray(entries) || entries.length > 5000) throw new Error('The remote file list is invalid.')
  return entries.map(entry => {
    const path = normalizeDirectory(entry?.file?.path ?? '')
    const parts = path.split('/')
    const parent = parts.slice(0, -1).join('/')
    if (!entry || entry.file.machineId !== requested.machineId || entry.file.projectId !== requested.projectId
      || entry.name !== parts.at(-1) || parent !== directory || !entry.name || entry.name === '.' || entry.name === '..'
      || entry.name.includes('/') || entry.name.includes('\\') || !['file', 'directory'].includes(entry.kind)) {
      throw new Error('The remote machine returned a file outside the requested directory.')
    }
    return { ...entry, file: { ...entry.file, path } }
  })
}

export function remotePreviewKind(path: string): RemoteFilePreviewKind | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(extension)) return 'image'
  if (['.mp4', '.webm', '.mov'].includes(extension)) return 'video'
  return null
}

export function parentRemoteDirectory(path: string): string {
  return normalizeDirectory(path).split('/').slice(0, -1).join('/')
}

export function remotePromptFileAttachment(file: RemoteFileIdentity, name: string, id: string): RemotePromptFileAttachment {
  return { id, kind: 'file', name, remoteFile: { ...file } }
}

/**
 * Keeping a host's file tree honest while the host changes underneath it.
 *
 * A pane showing MAIN's files is a view of a machine that is still being worked on - by an agent
 * running there, by a build, by the owner at that keyboard. Until now it only ever showed what was
 * true at the moment it was opened, which for a tree is a particular kind of wrong: the owner acts
 * on it. So it follows `files:changed`, which main now also delivers for host changes.
 */

/** How the pane identifies itself against a change notice. */
export interface RemoteTreeScope {
  machineId: string
  /**
   * Whichever id this pane was opened with. A pane for a project that *lives* on the host is keyed
   * by the host's own project id; one for a paired working copy is keyed by ours. Both are matched,
   * because the pane genuinely cannot tell which kind it is from the id alone.
   */
  projectId: string
}

/**
 * Whether a change notice is about the project this pane is showing, on the machine it is showing.
 *
 * The machine has to match first and always: two computers hold two working copies, and a local
 * change to a paired project must never repaint a pane pointed at the host's copy. A notice with no
 * machineId is a change on this computer and is never a match for a host pane.
 */
export function remoteChangeMatches(change: Pick<AgentFileChange, 'projectId' | 'machineId' | 'remoteProjectId'>, scope: RemoteTreeScope): boolean {
  if (!scope.machineId || !change.machineId || change.machineId !== scope.machineId) return false
  return change.projectId === scope.projectId || change.remoteProjectId === scope.projectId
}

/**
 * Whether this change can alter what the visible directory lists.
 *
 * A change directly inside it obviously can. So can one deeper down, because the directories on the
 * way to it may not have existed a moment ago - a build writing `dist/assets/app.js` is how a
 * missing `dist` appears. Re-listing one directory is cheap and coalesced, so erring towards
 * re-listing costs a request, while erring the other way leaves the owner acting on a stale tree.
 */
export function remoteChangeAffectsDirectory(changedPath: string, visibleDirectory: string): boolean {
  const changed = normalizeDirectory(changedPath)
  const visible = normalizeDirectory(visibleDirectory)
  if (!changed) return false
  if (!visible) return true
  return changed.startsWith(visible + '/')
}

/** Both questions together: the one predicate the pane actually asks. */
export function shouldRelistRemoteDirectory(
  change: Pick<AgentFileChange, 'projectId' | 'path' | 'machineId' | 'remoteProjectId'>,
  scope: RemoteTreeScope,
  visibleDirectory: string
): boolean {
  return remoteChangeMatches(change, scope) && remoteChangeAffectsDirectory(change.path, visibleDirectory)
}

/**
 * Collapses a burst of change notices into one re-list.
 *
 * `npm install`, a branch switch or a formatter touches hundreds of paths in a second, and one
 * request per notice would turn a tree into a denial-of-service against the host that owns it. The
 * timer restarts on every notice, so a burst settles once rather than re-listing throughout it.
 */
export class CoalescedRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly delayMs: number, private readonly run: () => void) {}

  /** True while a re-list is waiting to happen, for tests and for not stacking spinners. */
  get pending(): boolean { return this.timer !== null }

  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.run() }, this.delayMs)
  }

  /** Unmounting, or changing what the pane points at, must not fire a re-list for the old thing. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

/** Long enough to swallow a burst, short enough that a saved file appears while the owner waits. */
export const REMOTE_TREE_REFRESH_MS = 250
