import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  File,
  FileCode2,
  FileJson,
  FilePenLine,
  FileText,
  Folder,
  FolderOpen,
  Image,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import type { FileEntry, ProjectRecord } from '../../../shared/models'
import {
  classifyExplorerFile,
  defaultExplorerOpenMode,
  type ExplorerOpenMode
} from './workspace-sidebar-types'
import './ExplorerSidebar.css'

interface ExplorerSidebarProps {
  project: ProjectRecord
  onOpenFile?(relativePath: string, mode: ExplorerOpenMode): void
  onProjectRenamed?(project: ProjectRecord): void
  refreshIntervalMs?: number
}

type RefreshPhase = 'idle' | 'refreshing' | 'complete'
type ContextTarget = { kind: 'project' } | { kind: 'entry'; entry: FileEntry }

const cleanIpcError = (reason: unknown): string => {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

const notify = (message: string): void => {
  window.dispatchEvent(new CustomEvent('conductor:toast', { detail: message }))
}

const iconFor = (entry: FileEntry): typeof File => {
  if (entry.kind === 'directory') return Folder
  const kind = classifyExplorerFile(entry.name)
  if (kind === 'markdown') return FileText
  if (kind === 'image') return Image
  if (/\.(json|jsonc|ya?ml)$/i.test(entry.name)) return FileJson
  if (kind === 'text') return FileCode2
  return File
}

const parentPath = (relativePath: string): string => {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

const refreshedLabel = (lastRefreshed: Date | null, now: number): string => {
  if (!lastRefreshed) return 'Not refreshed yet'
  const seconds = Math.max(0, Math.floor((now - lastRefreshed.getTime()) / 1000))
  if (seconds < 10) return 'Refreshed just now'
  if (seconds < 60) return `Refreshed ${seconds} seconds ago`
  const minutes = Math.floor(seconds / 60)
  return `Refreshed ${minutes} minute${minutes === 1 ? '' : 's'} ago`
}

function ExplorerRows({
  directory,
  depth,
  entriesByDirectory,
  expanded,
  query,
  onToggle,
  onOpen,
  onContextMenu
}: {
  directory: string
  depth: number
  entriesByDirectory: Record<string, FileEntry[]>
  expanded: Set<string>
  query: string
  onToggle(entry: FileEntry): void
  onOpen(entry: FileEntry): void
  onContextMenu(event: React.MouseEvent, entry: FileEntry): void
}): React.JSX.Element {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = (entriesByDirectory[directory] ?? []).filter((entry) =>
    !normalizedQuery || entry.kind === 'directory' || entry.name.toLocaleLowerCase().includes(normalizedQuery)
  )

  return (
    <>
      {entries.map((entry) => {
        const open = entry.kind === 'directory' && expanded.has(entry.relativePath)
        const Icon = entry.kind === 'directory' && open ? FolderOpen : iconFor(entry)
        return (
          <div key={entry.relativePath}>
            <button
              className={`explorer-row ${entry.kind}`}
              style={{ paddingLeft: 7 + depth * 13 }}
              title={entry.relativePath}
              onClick={() => entry.kind === 'directory' ? onToggle(entry) : onOpen(entry)}
              onContextMenu={(event) => onContextMenu(event, entry)}
            >
              {entry.kind === 'directory'
                ? open ? <ChevronDown className="explorer-chevron" size={12} /> : <ChevronRight className="explorer-chevron" size={12} />
                : <span className="explorer-chevron" />}
              <Icon size={14} />
              <span className="ellipsis">{entry.name}</span>
            </button>
            {open && (
              <ExplorerRows
                directory={entry.relativePath}
                depth={depth + 1}
                entriesByDirectory={entriesByDirectory}
                expanded={expanded}
                query={query}
                onToggle={onToggle}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export function ExplorerSidebar({
  project,
  onOpenFile,
  onProjectRenamed,
  refreshIntervalMs = 5000
}: ExplorerSidebarProps): React.JSX.Element {
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<RefreshPhase>('idle')
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [menu, setMenu] = useState<{ target: ContextTarget; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<
    | { kind: 'project'; value: string }
    | { kind: 'entry'; entry: FileEntry; value: string }
    | null
  >(null)
  const expandedRef = useRef(expanded)
  const refreshingRef = useRef(false)
  const refreshRequestRef = useRef(0)
  const completeTimerRef = useRef<number | undefined>(undefined)
  expandedRef.current = expanded

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    const requestId = ++refreshRequestRef.current
    window.clearTimeout(completeTimerRef.current)
    setPhase('refreshing')
    setError('')
    const directories = ['', ...expandedRef.current]
    const results = await Promise.allSettled(
      directories.map(async (directory) => ({
        directory,
        entries: await window.conductor.files.list(project.id, directory)
      }))
    )
    if (requestId !== refreshRequestRef.current) return
    setEntriesByDirectory((current) => {
      const next = { ...current }
      for (const result of results) {
        if (result.status === 'fulfilled') next[result.value.directory] = result.value.entries
      }
      return next
    })
    const rootFailure = results[0]?.status === 'rejected' ? results[0].reason : null
    if (rootFailure) setError(cleanIpcError(rootFailure))
    setLastRefreshed(new Date())
    setClock(Date.now())
    setPhase('complete')
    refreshingRef.current = false
    completeTimerRef.current = window.setTimeout(() => setPhase('idle'), 900)
  }, [project.id])

  useEffect(() => {
    refreshRequestRef.current += 1
    refreshingRef.current = false
    setEntriesByDirectory({})
    setExpanded(new Set())
    expandedRef.current = new Set()
    setQuery('')
    setLastRefreshed(null)
    void refresh()
  }, [project.id, refresh])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, Math.max(2000, refreshIntervalMs))
    const onFocus = (): void => { void refresh() }
    const onVisibility = (): void => { if (!document.hidden) void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(completeTimerRef.current)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, refreshIntervalMs])

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 30000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onEscape)
    }
  }, [menu])

  const toggle = async (entry: FileEntry): Promise<void> => {
    const opening = !expanded.has(entry.relativePath)
    setExpanded((current) => {
      const next = new Set(current)
      opening ? next.add(entry.relativePath) : next.delete(entry.relativePath)
      expandedRef.current = next
      return next
    })
    if (opening && !entriesByDirectory[entry.relativePath]) {
      try {
        const children = await window.conductor.files.list(project.id, entry.relativePath)
        setEntriesByDirectory((current) => ({ ...current, [entry.relativePath]: children }))
      } catch (reason) {
        setError(cleanIpcError(reason))
      }
    }
  }

  const open = (entry: FileEntry, requestedMode?: ExplorerOpenMode): void => {
    const mode = requestedMode ?? defaultExplorerOpenMode(entry.relativePath)
    if (!mode) {
      void window.conductor.files.openExternal(project.id, entry.relativePath).catch((reason) => notify(cleanIpcError(reason)))
      return
    }
    if (onOpenFile) onOpenFile(entry.relativePath, mode)
    else {
      window.dispatchEvent(new CustomEvent('conductor:open-resource', {
        detail: { projectId: project.id, relativePath: entry.relativePath, mode }
      }))
    }
  }

  const renameEntry = async (entry: FileEntry, name: string): Promise<void> => {
    if (!name || name === entry.name) return
    try {
      await window.conductor.files.rename(project.id, entry.relativePath, name)
      setExpanded(new Set())
      expandedRef.current = new Set()
      await refresh()
      notify(`Renamed ${entry.name} to ${name}`)
    } catch (reason) {
      notify(cleanIpcError(reason))
    }
  }

  const renameProject = async (name: string): Promise<void> => {
    if (!name || name === project.name) return
    try {
      const renamed = await window.conductor.projects.rename(project.id, name)
      onProjectRenamed?.(renamed)
      notify(`Renamed project to ${renamed.name}`)
    } catch (reason) {
      notify(cleanIpcError(reason))
    }
  }

  const finishRename = async (): Promise<void> => {
    if (!renameTarget) return
    const target = renameTarget
    const name = target.value.trim()
    setRenameTarget(null)
    if (!name) return
    if (target.kind === 'project') await renameProject(name)
    else await renameEntry(target.entry, name)
  }

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      notify('Copied relative path')
    } catch (reason) {
      notify(cleanIpcError(reason))
    }
  }

  const showMenu = (event: React.MouseEvent, target: ContextTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      target,
      x: Math.min(event.clientX, window.innerWidth - 224),
      y: Math.min(event.clientY, window.innerHeight - 250)
    })
  }

  const lastRefreshText = refreshedLabel(lastRefreshed, clock)

  return (
    <section className="workspace-sidebar-pane explorer-sidebar" aria-label="Explorer">
      <header className="workspace-sidebar-title">
        <span>Explorer</span>
        <div>
          <button
            className={`explorer-refresh ${phase}`}
            title={`${lastRefreshText}. Refresh now`}
            aria-label={`${lastRefreshText}. Refresh now`}
            onClick={() => void refresh()}
          >
            {phase === 'complete' ? <Check size={13} /> : <RefreshCw className={phase === 'refreshing' ? 'spin' : ''} size={13} />}
          </button>
          <button title="Project actions" aria-label="Project actions" onClick={(event) => showMenu(event, { kind: 'project' })}>
            <MoreHorizontal size={14} />
          </button>
        </div>
      </header>
      <button className="explorer-project" title={project.path} onDoubleClick={() => setRenameTarget({ kind: 'project', value: project.name })} onContextMenu={(event) => showMenu(event, { kind: 'project' })}>
        <ChevronDown size={12} />
        <FolderOpen size={14} />
        <strong className="ellipsis">{project.name}</strong>
      </button>
      <div className="explorer-filter">
        <Search size={12} />
        <input aria-label="Filter files" placeholder="Filter files" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button title="Clear filter" onClick={() => setQuery('')}><X size={11} /></button>}
      </div>
      {renameTarget && (
        <form className="explorer-rename-bar" onSubmit={(event) => { event.preventDefault(); void finishRename() }}>
          <FilePenLine size={13} />
          <label>
            <span>Rename {renameTarget.kind === 'project' ? 'project' : renameTarget.entry.kind}</span>
            <input
              autoFocus
              value={renameTarget.value}
              onFocus={(event) => {
                const dot = renameTarget.kind === 'entry' && renameTarget.entry.kind === 'file' ? event.currentTarget.value.lastIndexOf('.') : -1
                event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length)
              }}
              onChange={(event) => setRenameTarget({ ...renameTarget, value: event.target.value })}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setRenameTarget(null) } }}
            />
          </label>
          <button type="submit" title="Apply rename"><Check size={13} /></button>
          <button type="button" title="Cancel rename" onClick={() => setRenameTarget(null)}><X size={13} /></button>
        </form>
      )}
      <div className="explorer-tree">
        {error && <div className="explorer-error">{error}</div>}
        {!error && phase !== 'refreshing' && (entriesByDirectory['']?.length ?? 0) === 0 && (
          <div className="explorer-empty">This project is empty.</div>
        )}
        <ExplorerRows
          directory=""
          depth={0}
          entriesByDirectory={entriesByDirectory}
          expanded={expanded}
          query={query}
          onToggle={(entry) => void toggle(entry)}
          onOpen={open}
          onContextMenu={(event, entry) => showMenu(event, { kind: 'entry', entry })}
        />
      </div>
      <footer className="explorer-footer" title={lastRefreshed?.toLocaleString()}>
        <span>{entriesByDirectory['']?.length ?? 0} root items</span>
        <span>{lastRefreshText}</span>
      </footer>

      {menu && createPortal(
        <div
          className="cursor-context-menu explorer-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menu.target.kind === 'project' ? (
            <>
              <div className="context-menu-label">{project.name}</div>
              <button onClick={() => { setMenu(null); setRenameTarget({ kind: 'project', value: project.name }) }}><Pencil size={14} /> Rename project…</button>
              <button onClick={() => { setMenu(null); void window.conductor.files.reveal(project.id).catch((reason) => notify(cleanIpcError(reason))) }}><FolderOpen size={14} /> Reveal in File Explorer</button>
            </>
          ) : (() => {
            const entry = menu.target.entry
            const kind = classifyExplorerFile(entry.relativePath)
            return (
              <>
                <div className="context-menu-label">{entry.name}</div>
                {entry.kind === 'file' && ['markdown', 'image', 'media', 'pdf'].includes(kind) && (
                  <button onClick={() => { setMenu(null); open(entry, 'preview') }}><Eye size={14} /> Preview</button>
                )}
                {entry.kind === 'file' && (kind === 'markdown' || kind === 'text') && (
                  <button onClick={() => { setMenu(null); open(entry, 'editor') }}><FilePenLine size={14} /> Open in editor</button>
                )}
                {entry.kind === 'file' && (
                  <button onClick={() => { setMenu(null); void window.conductor.files.openExternal(project.id, entry.relativePath).catch((reason) => notify(cleanIpcError(reason))) }}><ExternalLink size={14} /> Open with default app</button>
                )}
                <div />
                <button onClick={() => { setMenu(null); setRenameTarget({ kind: 'entry', entry, value: entry.name }) }}><Pencil size={14} /> Rename…</button>
                <button onClick={() => { setMenu(null); void window.conductor.files.reveal(project.id, entry.relativePath).catch((reason) => notify(cleanIpcError(reason))) }}><FolderOpen size={14} /> Reveal in File Explorer</button>
                <button onClick={() => { setMenu(null); void copyPath(entry.relativePath) }}><Copy size={14} /> Copy relative path</button>
              </>
            )
          })()}
        </div>,
        document.body
      )}
    </section>
  )
}
