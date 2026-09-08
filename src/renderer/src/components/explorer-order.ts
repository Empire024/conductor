import type { FileEntry } from '../../../shared/models'

export const isDotEntry = (entry: Pick<FileEntry, 'name'>): boolean => entry.name.startsWith('.')

/** Keep project content first, followed by a visible group of dotfiles and folders. */
export function orderExplorerEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (isDotEntry(a) !== isDotEntry(b)) return isDotEntry(a) ? 1 : -1
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
}
