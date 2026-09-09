import { Eye, ExternalLink, FileCode2, Folder, FolderOpen, Globe2 } from 'lucide-react'

export type FileLinkMenuAction = 'edit' | 'live-preview' | 'default-browser' | 'preview' | 'reveal-explorer' | 'show-os-explorer'
export interface FileLinkMenuEntry { action: FileLinkMenuAction; label: string; shortcut?: string }

/** One icon per action, shared by every host that renders this menu so they never fall out of sync. */
export const FILE_LINK_MENU_ICONS: Record<FileLinkMenuAction, typeof Eye> = { edit: FileCode2, 'live-preview': Globe2, 'default-browser': ExternalLink, preview: Eye, 'reveal-explorer': Folder, 'show-os-explorer': FolderOpen }

/** Mirrors the modifier-click behaviour already wired for an agent's file links
 * (plain click edits, Ctrl+Click opens the in-app browser view, Ctrl+Shift+Click opens the
 * OS default browser) so the menu teaches those shortcuts instead of hiding them. */
export function buildFileLinkMenuEntries(options: { includePreview?: boolean } = {}): FileLinkMenuEntry[] {
  const entries: FileLinkMenuEntry[] = [
    { action: 'edit', label: 'Edit', shortcut: 'Click' },
    { action: 'live-preview', label: 'Open in browser', shortcut: 'Ctrl+Click' },
    { action: 'default-browser', label: 'Open in default browser', shortcut: 'Ctrl+Shift+Click' }
  ]
  if (options.includePreview ?? true) entries.push({ action: 'preview', label: 'Preview' })
  entries.push({ action: 'reveal-explorer', label: 'Reveal in Conductor Explorer' })
  entries.push({ action: 'show-os-explorer', label: 'Show in Windows Explorer' })
  return entries
}
