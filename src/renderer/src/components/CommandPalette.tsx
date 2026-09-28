import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Bot, Braces, ChevronRight, FolderTree, Monitor, PanelsTopLeft, Search, Terminal } from 'lucide-react'
import { focusDirectoryEntry, matchConversationTabs, refreshConversationDirectory, useConversationDirectory, type DirectoryEntry } from '../conversation-directory'
import type { ArchivedTab } from '../../../shared/tab-archive'

export interface PaletteCommand {
  id: string
  label: string
  detail?: string
  category: string
  icon: 'agent' | 'terminal' | 'file' | 'browser' | 'layout' | 'code' | 'archive'
  shortcut?: string
  run(): void
}

const icons = {
  agent: Bot,
  terminal: Terminal,
  file: FolderTree,
  browser: Monitor,
  layout: PanelsTopLeft,
  code: Braces,
  archive: Archive
}

/** A tab found by id or title, as a palette entry that jumps to it (switching project/workspace,
 *  and raising the window it lives in). `currentDetachedId` is set in a detached window. */
export function tabCommand(entry: DirectoryEntry, currentProjectId: string | null, currentDetachedId?: string): PaletteCommand {
  const foreign = entry.projectId !== currentProjectId
  const place = entry.detachedId === currentDetachedId ? null : entry.detachedId ? 'separate window' : 'main window'
  return {
    id: 'tab:' + entry.tabId,
    label: foreign ? `${entry.title} (${entry.projectName})` : entry.title,
    detail: [foreign ? entry.projectName : null, entry.workspaceName, place, entry.agentSessionId ?? entry.tabId].filter(Boolean).join(' · '),
    category: 'Tabs',
    icon: entry.kind === 'agent' ? 'agent' : entry.kind === 'terminal' ? 'terminal' : entry.kind === 'browser' ? 'browser' : 'layout',
    run: () => { void focusDirectoryEntry(entry).catch((reason: unknown) => console.warn('The tab could not be shown', reason)) }
  }
}

/** A closed tab from a workspace archive (src/shared/tab-archive.ts): Enter reopens it where it was. */
export function archivedTabCommand(entry: ArchivedTab): PaletteCommand {
  return {
    id: 'archived:' + entry.sessionId + ':' + entry.tab.id,
    label: entry.tab.title,
    detail: ['Archived', entry.workspaceName, entry.tab.resourceId ?? entry.tab.id].filter(Boolean).join(' · '),
    category: 'Archived tabs',
    icon: 'archive',
    run: () => { void window.conductor.tabArchive.reopen(entry.sessionId, [entry.tab.id]).catch((reason: unknown) => console.warn('The archived tab could not be reopened', reason)) }
  }
}

export function CommandPalette({
  commands,
  currentProjectId,
  currentDetachedId,
  onClose
}: {
  commands: PaletteCommand[]
  /** Set to search every open tab in every window by agent id, tab id or title as well. */
  currentProjectId?: string | null
  /** The detached window this palette opened in; tabs elsewhere name the window they live in. */
  currentDetachedId?: string
  onClose(): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const directory = useConversationDirectory()
  const searchTabs = currentProjectId !== undefined
  // Closed tabs are found too, from every open workspace's archive; open ones come first.
  const [archived, setArchived] = useState<ArchivedTab[]>([])
  useEffect(() => {
    const q = query.trim()
    if (!searchTabs || q.length < 2 || !window.conductor.tabArchive) { setArchived([]); return }
    let live = true
    const timer = window.setTimeout(() => { void window.conductor.tabArchive.search(q, 10).then(found => { if (live) setArchived(found) }).catch(() => undefined) }, 120)
    return () => { live = false; window.clearTimeout(timer) }
  }, [query, searchTabs])
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    const matching = q ? commands.filter((item) => `${item.label} ${item.category}`.toLowerCase().includes(q)) : commands
    if (!searchTabs || !q) return matching
    const open = matchConversationTabs(directory, q)
    const openIds = new Set(directory.entries.map(entry => entry.tabId))
    return [...matching, ...open.map(entry => tabCommand(entry, currentProjectId ?? null, currentDetachedId)), ...archived.filter(entry => !openIds.has(entry.tab.id)).map(archivedTabCommand)]
  }, [commands, query, directory, searchTabs, currentProjectId, currentDetachedId, archived])

  useEffect(() => inputRef.current?.focus(), [])
  // Tabs opened in another project or window since the last read are found too.
  useEffect(() => { if (searchTabs) void refreshConversationDirectory(true) }, [searchTabs])
  useEffect(() => setSelected(0), [query])

  const execute = (index: number): void => {
    const command = filtered[index]
    if (!command) return
    command.run()
    onClose()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((value) => Math.min(value + 1, filtered.length - 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((value) => Math.max(value - 1, 0))
              }
              if (event.key === 'Enter') execute(selected)
            }}
            placeholder={searchTabs ? 'Type a command, a tab name or an agent id...' : 'Type a command or open a tool...'}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">{query.trim() || commands.length ? 'No matching commands' : 'Type a tab name or an agent id'}</div>}
          {filtered.map((item, index) => {
            const Icon = icons[item.icon]
            return (
              <button
                key={item.id}
                className={index === selected ? 'selected' : ''}
                onMouseEnter={() => setSelected(index)}
                onClick={() => execute(index)}
              >
                <span className="palette-icon"><Icon size={16} /></span>
                <span className="palette-label"><strong>{item.label}</strong><small>{item.detail ?? item.category}</small></span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : <ChevronRight size={14} />}
              </button>
            )
          })}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></footer>
      </div>
    </div>
  )
}
