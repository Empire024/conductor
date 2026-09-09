import { isDotEntry, orderExplorerEntries } from './explorer-order'
import { planReveal } from './explorer-reveal'
import { copyText } from '../clipboard'
import { cleanIpcError } from '../ipc-errors'
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
  FilePenLine,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Scissors,
  Trash2,
  X
} from 'lucide-react'
import type { FileEntry, ProjectRecord } from '../../../shared/models'
import { fileTypeStyle } from '../file-types'
import {
  classifyExplorerFile,
  defaultExplorerOpenMode,
  type ExplorerOpenMode
} from './workspace-sidebar-types'
import './ExplorerSidebar.css'

interface ExplorerSidebarProps {
  project: ProjectRecord
  defaultCollapsed?: boolean
  onOpenFile?(relativePath: string, mode: ExplorerOpenMode): void
  onProjectRenamed?(project: ProjectRecord): void
  onPathChanged?(previousPath: string, nextPath: string, kind: FileEntry['kind']): void
  onPathRemoved?(relativePath: string, kind: FileEntry['kind']): void
  refreshIntervalMs?: number
}

type RefreshPhase = 'idle' | 'refreshing' | 'complete'
type ContextTarget = { kind: 'project' } | { kind: 'entry'; entry: FileEntry }

const notify = (message: string): void => {
  window.dispatchEvent(new CustomEvent('conductor:toast', { detail: message }))
}

const iconFor = (entry: FileEntry): { Icon: typeof File; className?: string } => {
  if (entry.kind === 'directory') return { Icon: Folder }
  const style = fileTypeStyle(entry.name)
  return { Icon: style.icon, className: style.colorClass }
}

const parentPath = (relativePath: string): string => {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

const isSameOrChildPath = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`)

const canMoveTo = (entry: FileEntry, directory: string): boolean =>
  parentPath(entry.relativePath) !== directory &&
  !(entry.kind === 'directory' && isSameOrChildPath(directory, entry.relativePath))

const sortEntries = orderExplorerEntries

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
  selectedPath,
  movingPath,
  draggingPath,
  dropTarget,
  highlightPath,
  onToggle,
  onOpen,
  onContextMenu,
  onSelect,
  onRename,
  onRemove,
  onStartMove,
  onMoveHere,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: {
  directory: string
  depth: number
  entriesByDirectory: Record<string, FileEntry[]>
  expanded: Set<string>
  query: string
  selectedPath: string | null
  movingPath: string | null
  draggingPath: string | null
  dropTarget: string | null
  highlightPath: { path: string; strong: boolean } | null
  onToggle(entry: FileEntry): void
  onOpen(entry: FileEntry): void
  onContextMenu(event: React.MouseEvent, entry: FileEntry): void
  onSelect(entry: FileEntry): void
  onRename(entry: FileEntry): void
  onRemove(entry: FileEntry): void
  onStartMove(entry: FileEntry): void
  onMoveHere(directory: string): void
  onDragStart(event: React.DragEvent, entry: FileEntry): void
  onDragEnd(): void
  onDragOver(event: React.DragEvent, directory: string): void
  onDrop(event: React.DragEvent, directory: string): void
}): React.JSX.Element {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = orderExplorerEntries(entriesByDirectory[directory] ?? []).filter((entry) =>
    !normalizedQuery || entry.kind === 'directory' || entry.name.toLocaleLowerCase().includes(normalizedQuery)
  )

  return (
    <>
      {entries.map((entry, index) => {
        const open = entry.kind === 'directory' && expanded.has(entry.relativePath)
        const { Icon, className: iconClassName } = entry.kind === 'directory' && open ? { Icon: FolderOpen, className: undefined } : iconFor(entry)
        return (
          <div key={entry.relativePath}>
            {isDotEntry(entry) && (index === 0 || !isDotEntry(entries[index - 1]!)) && <div className="explorer-dotfile-heading" style={{ paddingLeft: 20 + depth * 13 }} title="Dotfiles and folders hold project configuration and hidden content">Configuration &amp; hidden</div>}
            <button
              className={`explorer-row ${entry.kind}${isDotEntry(entry) ? ' dot-entry' : ''}${selectedPath === entry.relativePath ? ' selected' : ''}${movingPath === entry.relativePath ? ' moving' : ''}${draggingPath === entry.relativePath ? ' dragging' : ''}${entry.kind === 'directory' && dropTarget === entry.relativePath ? ' drop-target' : ''}${highlightPath?.path === entry.relativePath ? (highlightPath.strong ? ' reveal-highlight-strong' : ' reveal-highlight') : ''}`}
              style={{ paddingLeft: 7 + depth * 13 }}
              title={entry.relativePath}
              data-explorer-path={entry.relativePath}
              draggable
              onClick={() => { onSelect(entry); entry.kind === 'directory' ? onToggle(entry) : onOpen(entry) }}
              onContextMenu={(event) => onContextMenu(event, entry)}
              onKeyDown={(event) => {
                if (event.key === 'F2') { event.preventDefault(); onRename(entry) }
                if (event.key === 'Delete') { event.preventDefault(); onRemove(entry) }
                if (event.ctrlKey && event.key.toLocaleLowerCase() === 'x') { event.preventDefault(); onStartMove(entry) }
                if (event.ctrlKey && event.key.toLocaleLowerCase() === 'v' && entry.kind === 'directory') { event.preventDefault(); onMoveHere(entry.relativePath) }
              }}
              onDragStart={(event) => onDragStart(event, entry)}
              onDragEnd={onDragEnd}
              onDragOver={(event) => {
                event.stopPropagation()
                onDragOver(event, entry.kind === 'directory' ? entry.relativePath : directory)
              }}
              onDrop={(event) => onDrop(event, entry.kind === 'directory' ? entry.relativePath : directory)}
            >
              {entry.kind === 'directory'
                ? open ? <ChevronDown className="explorer-chevron" size={12} /> : <ChevronRight className="explorer-chevron" size={12} />
                : <span className="explorer-chevron" />}
              <Icon size={14} className={iconClassName} />
              <span className="ellipsis">{entry.name}</span>
            </button>
            {open && (
              <ExplorerRows
                directory={entry.relativePath}
                depth={depth + 1}
                entriesByDirectory={entriesByDirectory}
                expanded={expanded}
                query={query}
                selectedPath={selectedPath}
                movingPath={movingPath}
                draggingPath={draggingPath}
                dropTarget={dropTarget}
                highlightPath={highlightPath}
                onToggle={onToggle}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                onSelect={onSelect}
                onRename={onRename}
                onRemove={onRemove}
                onStartMove={onStartMove}
                onMoveHere={onMoveHere}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOver={onDragOver}
                onDrop={onDrop}
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
  defaultCollapsed = false,
  onOpenFile,
  onProjectRenamed,
  onPathChanged,
  onPathRemoved,
  refreshIntervalMs = 5000
}: ExplorerSidebarProps): React.JSX.Element {
  const [rootCollapsed, setRootCollapsed] = useState(defaultCollapsed)
  useEffect(() => { if (!defaultCollapsed) setRootCollapsed(false) }, [defaultCollapsed])
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<RefreshPhase>('idle')
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [menu, setMenu] = useState<{ target: ContextTarget; x: number; y: number } | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<{ path: string; strong: boolean } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [movingEntry, setMovingEntry] = useState<FileEntry | null>(null)
  const [draggingEntry, setDraggingEntry] = useState<FileEntry | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [createTarget, setCreateTarget] = useState<{
    directory: string
    kind: FileEntry['kind']
    value: string
  } | null>(null)
  const [renameTarget, setRenameTarget] = useState<
    | { kind: 'project'; value: string }
    | { kind: 'entry'; entry: FileEntry; value: string }
    | null
  >(null)
  const expandedRef = useRef(expanded)
  const refreshRequestRef = useRef(0)
  const completeTimerRef = useRef<number | undefined>(undefined)
  const draggingEntryRef = useRef<FileEntry | null>(null)
  expandedRef.current = expanded

  const refresh = useCallback(async (): Promise<void> => {
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
    completeTimerRef.current = window.setTimeout(() => setPhase('idle'), 900)
  }, [project.id])

  useEffect(() => {
    refreshRequestRef.current += 1
    setEntriesByDirectory({})
    setExpanded(new Set())
    expandedRef.current = new Set()
    setQuery('')
    setSelectedPath(null)
    setMovingEntry(null)
    setDraggingEntry(null)
    draggingEntryRef.current = null
    setDropTarget(null)
    setCreateTarget(null)
    setRenameTarget(null)
    setLastRefreshed(null)
    void refresh()
  }, [project.id, refresh])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, Math.max(2000, refreshIntervalMs))
    const onFocus = (): void => { void refresh() }
    const onVisibility = (): void => { if (!document.hidden) void refresh() }
    window.addEventListener('conductor:refresh-files', onFocus)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(completeTimerRef.current)
      window.removeEventListener('conductor:refresh-files', onFocus)
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
    const close = (event?: Event): void => { if (event?.target instanceof Element && event.target.closest('[data-explorer-menu-trigger]')) return; setMenu(null) }
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

  // "Reveal in Conductor Explorer" from a file link elsewhere in the app: expand whatever
  // ancestors are missing, then flash the row. A stronger flash means the row was already
  // visible before this ran, per the checklist's ask for extra emphasis in that case.
  useEffect(() => {
    const onReveal = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId: string; relativePath: string }>).detail
      if (!detail || detail.projectId !== project.id) return
      const plan = planReveal(expandedRef.current, detail.relativePath)
      if (plan.parentsToExpand.length) {
        setExpanded((current) => {
          const next = new Set(current)
          plan.parentsToExpand.forEach((dir) => next.add(dir))
          expandedRef.current = next
          return next
        })
        void Promise.all(plan.parentsToExpand.map(async (dir) => {
          try {
            const children = await window.conductor.files.list(project.id, dir)
            setEntriesByDirectory((current) => ({ ...current, [dir]: children }))
          } catch (reason) { setError(cleanIpcError(reason)) }
        }))
      }
      // A collapsed project root hides everything below it, so the file was not actually
      // visible yet even if its own ancestor folders happened to already be expanded.
      const strong = plan.alreadyVisible && !rootCollapsed
      setRootCollapsed(false)
      setQuery('')
      setSelectedPath(detail.relativePath)
      setHighlight({ path: detail.relativePath, strong })
    }
    window.addEventListener('conductor:reveal-in-explorer', onReveal)
    return () => window.removeEventListener('conductor:reveal-in-explorer', onReveal)
  }, [project.id, rootCollapsed])

  useEffect(() => {
    if (!highlight) return
    const frame = requestAnimationFrame(() => {
      treeRef.current?.querySelector<HTMLElement>(`[data-explorer-path="${CSS.escape(highlight.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
    const timer = window.setTimeout(() => setHighlight(null), highlight.strong ? 1700 : 1150)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [highlight])

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
    if (onOpenFile) onOpenFile(entry.relativePath, mode)
    else {
      window.dispatchEvent(new CustomEvent('conductor:open-resource', {
        detail: { projectId: project.id, relativePath: entry.relativePath, mode }
      }))
    }
  }

  const beginCreate = (directory: string, kind: FileEntry['kind']): void => {
    setMenu(null)
    setRenameTarget(null)
    setQuery('')
    setCreateTarget({ directory, kind, value: kind === 'file' ? 'untitled.txt' : 'new-folder' })
    if (!directory) return
    setExpanded((current) => {
      const next = new Set(current).add(directory)
      expandedRef.current = next
      return next
    })
    if (!entriesByDirectory[directory]) {
      const requestId = refreshRequestRef.current
      void window.conductor.files.list(project.id, directory)
        .then((entries) => {
          if (requestId === refreshRequestRef.current) {
            setEntriesByDirectory((current) => ({ ...current, [directory]: entries }))
          }
        })
        .catch((reason) => notify(cleanIpcError(reason)))
    }
  }

  const finishCreate = async (): Promise<void> => {
    if (!createTarget) return
    const target = createTarget
    const name = target.value.trim()
    if (!name) return
    try {
      const created = await window.conductor.files.create(project.id, target.directory, name, target.kind)
      setCreateTarget(null)
      setEntriesByDirectory((current) => ({
        ...current,
        [target.directory]: sortEntries([...(current[target.directory] ?? []), created])
      }))
      setSelectedPath(created.relativePath)
      await refresh()
      notify(`Created ${created.kind} ${created.name}`)
      if (created.kind === 'file') open(created, 'editor')
    } catch (reason) {
      notify(cleanIpcError(reason))
    }
  }

  const remapExpandedPaths = (previousPath: string, nextPath: string): void => {
    setExpanded((current) => {
      const next = new Set([...current].map((path) =>
        isSameOrChildPath(path, previousPath) ? `${nextPath}${path.slice(previousPath.length)}` : path
      ))
      expandedRef.current = next
      return next
    })
  }

  const remapCachedPaths = (previousPath: string, moved: FileEntry): void => {
    const nextPath = moved.relativePath
    const previousParent = parentPath(previousPath)
    const nextParent = parentPath(nextPath)
    setEntriesByDirectory((current) => {
      const next: Record<string, FileEntry[]> = {}
      for (const [directory, entries] of Object.entries(current)) {
        const mappedDirectory = isSameOrChildPath(directory, previousPath)
          ? `${nextPath}${directory.slice(previousPath.length)}`
          : directory
        next[mappedDirectory] = entries
          .filter((entry) => entry.relativePath !== previousPath || directory !== previousParent)
          .map((entry) => {
            if (!isSameOrChildPath(entry.relativePath, previousPath)) return entry
            if (entry.relativePath === previousPath) return moved
            return { ...entry, relativePath: `${nextPath}${entry.relativePath.slice(previousPath.length)}` }
          })
      }
      if (next[nextParent]) {
        next[nextParent] = sortEntries([
          ...next[nextParent].filter((entry) => entry.relativePath !== nextPath),
          moved
        ])
      }
      return next
    })
  }

  const renameEntry = async (entry: FileEntry, name: string): Promise<void> => {
    if (!name || name === entry.name) return
    try {
      const renamed = await window.conductor.files.rename(project.id, entry.relativePath, name)
      remapExpandedPaths(entry.relativePath, renamed.relativePath)
      remapCachedPaths(entry.relativePath, renamed)
      setSelectedPath(renamed.relativePath)
      onPathChanged?.(entry.relativePath, renamed.relativePath, entry.kind)
      await refresh()
      notify(`Renamed ${entry.name} to ${renamed.name}`)
    } catch (reason) {
      notify(cleanIpcError(reason))
    }
  }

  const moveEntry = async (entry: FileEntry, directory: string): Promise<void> => {
    if (!canMoveTo(entry, directory)) return
    try {
      const moved = await window.conductor.files.move(project.id, entry.relativePath, directory)
      remapExpandedPaths(entry.relativePath, moved.relativePath)
      remapCachedPaths(entry.relativePath, moved)
      setMovingEntry(null)
      setDraggingEntry(null)
      draggingEntryRef.current = null
      setDropTarget(null)
      setSelectedPath(moved.relativePath)
      onPathChanged?.(entry.relativePath, moved.relativePath, entry.kind)
      await refresh()
      notify(`Moved ${entry.name} to ${directory || project.name}`)
    } catch (reason) {
      setDraggingEntry(null)
      draggingEntryRef.current = null
      setDropTarget(null)
      notify(cleanIpcError(reason))
    }
  }

  const removeEntry = async (entry: FileEntry): Promise<void> => {
    const confirmed = window.confirm(`Move “${entry.name}” to the Recycle Bin?`)
    if (!confirmed) return
    try {
      await window.conductor.files.trash(project.id, entry.relativePath)
      setEntriesByDirectory((current) => {
        const next: Record<string, FileEntry[]> = {}
        for (const [directory, entries] of Object.entries(current)) {
          if (isSameOrChildPath(directory, entry.relativePath)) continue
          next[directory] = entries.filter((item) => !isSameOrChildPath(item.relativePath, entry.relativePath))
        }
        return next
      })
      setExpanded((current) => {
        const next = new Set([...current].filter((path) => !isSameOrChildPath(path, entry.relativePath)))
        expandedRef.current = next
        return next
      })
      if (movingEntry && isSameOrChildPath(movingEntry.relativePath, entry.relativePath)) setMovingEntry(null)
      setSelectedPath(null)
      onPathRemoved?.(entry.relativePath, entry.kind)
      await refresh()
      notify(`Moved ${entry.name} to the Recycle Bin`)
    } catch (reason) {
      notify(cleanIpcError(reason))
    }
  }

  const beginMove = (entry: FileEntry): void => {
    setMenu(null)
    setMovingEntry(entry)
    setSelectedPath(entry.relativePath)
    notify(`Choose a destination for ${entry.name}`)
  }

  const moveHere = (directory: string): void => {
    if (movingEntry && canMoveTo(movingEntry, directory)) void moveEntry(movingEntry, directory)
  }

  const startDrag = (event: React.DragEvent, entry: FileEntry): void => {
    setDraggingEntry(entry)
    draggingEntryRef.current = entry
    setSelectedPath(entry.relativePath)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', entry.relativePath)
  }

  const dragOver = (event: React.DragEvent, directory: string): void => {
    const entry = draggingEntryRef.current
    if (!entry || !canMoveTo(entry, directory)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(directory)
  }

  const drop = (event: React.DragEvent, directory: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const entry = draggingEntryRef.current
    if (entry && canMoveTo(entry, directory)) void moveEntry(entry, directory)
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
    notify(await copyText(path) ? 'Copied relative path' : 'Could not copy to the clipboard')
  }

  const showMenu = (event: React.MouseEvent, target: ContextTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      target,
      x: Math.min(event.clientX, window.innerWidth - 224),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - 410))
    })
    if (target.kind === 'entry') setSelectedPath(target.entry.relativePath)
  }

  const lastRefreshText = refreshedLabel(lastRefreshed, clock)

  return (
    <section data-project-id={project.id} className={'workspace-sidebar-pane explorer-sidebar explorer-root' + (rootCollapsed ? ' root-collapsed' : '')} aria-label={project.name}>
      <div className="workspace-sidebar-title explorer-project-toolbar">
        <div>
          <button title="New file" aria-label="New file" onClick={() => beginCreate('', 'file')}>
            <FilePlus2 size={13} />
          </button>
          <button title="New folder" aria-label="New folder" onClick={() => beginCreate('', 'directory')}>
            <FolderPlus size={13} />
          </button>
          <button
            className={`explorer-refresh ${phase}`}
            title={`${lastRefreshText}. Refresh now`}
            aria-label={`${lastRefreshText}. Refresh now`}
            onClick={() => void refresh()}
          >
            {phase === 'complete' ? <Check size={13} /> : <RefreshCw className={phase === 'refreshing' ? 'spin' : ''} size={13} />}
          </button>
          <button data-explorer-menu-trigger title="Project actions" aria-label="Project actions" onClick={(event) => { if (menu?.target.kind === 'project') setMenu(null); else showMenu(event, { kind: 'project' }) }}>
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
      <div role="button" tabIndex={0} aria-expanded={!rootCollapsed}
        onClick={() => setRootCollapsed((current) => !current)}
        className={`explorer-project${dropTarget === '' ? ' drop-target' : ''}`}
        title={project.path}
        onDoubleClick={() => { setCreateTarget(null); setRenameTarget({ kind: 'project', value: project.name }) }}
        onContextMenu={(event) => showMenu(event, { kind: 'project' })}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); setRootCollapsed((current) => !current) }
          if (event.ctrlKey && event.key.toLocaleLowerCase() === 'v') { event.preventDefault(); moveHere('') }
        }}
        onDragOver={(event) => dragOver(event, '')}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => drop(event, '')}
      >
        {rootCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <FolderOpen size={14} />
        {renameTarget?.kind === 'project' ? <form className="explorer-project-rename" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setRenameTarget(null) }}
          onSubmit={(event) => { event.preventDefault(); void finishRename() }}>
          <input autoFocus aria-label="Rename project" value={renameTarget.value} onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameTarget({ kind: 'project', value: event.target.value })}
            onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setRenameTarget(null) }} />
        </form> : <strong className="ellipsis">{project.name}</strong>}
      </div>
      <div className="explorer-filter">
        <Search size={12} />
        <input aria-label="Filter files" placeholder="Filter files" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button title="Clear filter" onClick={() => setQuery('')}><X size={11} /></button>}
      </div>
      {createTarget && (
        <form className="explorer-rename-bar explorer-create-bar" onSubmit={(event) => { event.preventDefault(); void finishCreate() }}>
          {createTarget.kind === 'file' ? <FilePlus2 size={13} /> : <FolderPlus size={13} />}
          <label>
            <span>New {createTarget.kind} in {createTarget.directory || project.name}</span>
            <input
              autoFocus
              value={createTarget.value}
              onFocus={(event) => {
                const dot = createTarget.kind === 'file' ? event.currentTarget.value.lastIndexOf('.') : -1
                event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length)
              }}
              onChange={(event) => setCreateTarget({ ...createTarget, value: event.target.value })}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setCreateTarget(null) } }}
            />
          </label>
          <button type="submit" title={`Create ${createTarget.kind}`}><Check size={13} /></button>
          <button type="button" title="Cancel" onClick={() => setCreateTarget(null)}><X size={13} /></button>
        </form>
      )}
      {renameTarget?.kind === 'entry' && (
        <form className="explorer-rename-bar" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setRenameTarget(null) }} onSubmit={(event) => { event.preventDefault(); void finishRename() }}>
          <FilePenLine size={13} />
          <label>
            <span>Rename {renameTarget.entry.kind}</span>
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
      <div
        ref={treeRef}
        className="explorer-tree"
        onContextMenu={(event) => showMenu(event, { kind: 'project' })}
        onDragOver={(event) => dragOver(event, '')}
        onDrop={(event) => drop(event, '')}
      >
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
          selectedPath={selectedPath}
          movingPath={movingEntry?.relativePath ?? null}
          draggingPath={draggingEntry?.relativePath ?? null}
          dropTarget={dropTarget}
          highlightPath={highlight}
          onToggle={(entry) => void toggle(entry)}
          onOpen={open}
          onContextMenu={(event, entry) => showMenu(event, { kind: 'entry', entry })}
          onSelect={(entry) => setSelectedPath(entry.relativePath)}
          onRename={(entry) => { setCreateTarget(null); setRenameTarget({ kind: 'entry', entry, value: entry.name }) }}
          onRemove={(entry) => void removeEntry(entry)}
          onStartMove={beginMove}
          onMoveHere={moveHere}
          onDragStart={startDrag}
          onDragEnd={() => { setDraggingEntry(null); draggingEntryRef.current = null; setDropTarget(null) }}
          onDragOver={dragOver}
          onDrop={drop}
        />
      </div>
      {movingEntry && (
        <div className="explorer-move-bar">
          <Scissors size={12} />
          <span className="ellipsis"><strong>{movingEntry.name}</strong><small>Drag it, or right-click a folder → Move here</small></span>
          <button title="Cancel move" aria-label="Cancel move" onClick={() => setMovingEntry(null)}><X size={12} /></button>
        </div>
      )}
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
              <button onClick={() => beginCreate('', 'file')}><FilePlus2 size={14} /> New file…</button>
              <button onClick={() => beginCreate('', 'directory')}><FolderPlus size={14} /> New folder…</button>
              {movingEntry && (
                <button disabled={!canMoveTo(movingEntry, '')} onClick={() => { setMenu(null); moveHere('') }}><Scissors size={14} /> Move {movingEntry.name} here</button>
              )}
              <div />
              <button onClick={() => { setMenu(null); setCreateTarget(null); setRenameTarget({ kind: 'project', value: project.name }) }}><Pencil size={14} /> Rename project…</button>
              <button onClick={() => { setMenu(null); void window.conductor.files.reveal(project.id).catch((reason) => notify(cleanIpcError(reason))) }}><FolderOpen size={14} /> Reveal in File Explorer</button>
            </>
          ) : (() => {
            const entry = menu.target.entry
            const kind = classifyExplorerFile(entry.relativePath)
            return (
              <>
                <div className="context-menu-label">{entry.name}</div>
                {entry.kind === 'directory' && (
                  <>
                    <button onClick={() => beginCreate(entry.relativePath, 'file')}><FilePlus2 size={14} /> New file…</button>
                    <button onClick={() => beginCreate(entry.relativePath, 'directory')}><FolderPlus size={14} /> New folder…</button>
                    {movingEntry && movingEntry.relativePath !== entry.relativePath && (
                      <button disabled={!canMoveTo(movingEntry, entry.relativePath)} onClick={() => { setMenu(null); moveHere(entry.relativePath) }}><Scissors size={14} /> Move {movingEntry.name} here</button>
                    )}
                    <div />
                  </>
                )}
                {entry.kind === 'file' && ['markdown', 'image', 'media', 'pdf'].includes(kind) && (
                  <button onClick={() => { setMenu(null); open(entry, 'preview') }}><Eye size={14} /> Preview</button>
                )}
                {entry.kind === 'file' && (
                  <button onClick={() => { setMenu(null); open(entry, 'editor') }}>
                    <FilePenLine size={14} /> {kind === 'markdown' || kind === 'text' ? 'Open in editor' : 'Open as text'}
                  </button>
                )}
                {entry.kind === 'file' && (
                  <button onClick={() => { setMenu(null); void window.conductor.files.openExternal(project.id, entry.relativePath).catch((reason) => notify(cleanIpcError(reason))) }}><ExternalLink size={14} /> Open with default app</button>
                )}
                <div />
                <button onClick={() => { setMenu(null); setCreateTarget(null); setRenameTarget({ kind: 'entry', entry, value: entry.name }) }}><Pencil size={14} /> Rename… <span className="context-shortcut">F2</span></button>
                <button onClick={() => beginMove(entry)}><Scissors size={14} /> Move… <span className="context-shortcut">Ctrl+X</span></button>
                <button onClick={() => { setMenu(null); void window.conductor.files.reveal(project.id, entry.relativePath).catch((reason) => notify(cleanIpcError(reason))) }}><FolderOpen size={14} /> Reveal in File Explorer</button>
                <button onClick={() => { setMenu(null); void copyPath(entry.relativePath) }}><Copy size={14} /> Copy relative path</button>
                <div />
                <button className="danger" onClick={() => { setMenu(null); void removeEntry(entry) }}><Trash2 size={14} /> Move to Recycle Bin <span className="context-shortcut">Del</span></button>
              </>
            )
          })()}
        </div>,
        document.body
      )}
    </section>
  )
}
