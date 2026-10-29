import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, FolderGit2, FolderInput, MessageSquareDashed, MoreHorizontal, Plus } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { GENERAL_PROJECT_NAME, threadAge, threadStateLabel, type ThreadSummary, type ThreadView } from '../../../shared/threads'
import './ThreadList.css'

const COLLAPSED_KEY = 'conductor.threadsCollapsed'
const POLL_MS = 5000

interface ThreadListProps {
  projects: ProjectRecord[]
  /** The conversation in the focused tab, highlighted in the list. */
  activeAgentSessionId?: string | null
  /** Changes whenever a conversation's phase changes, so the list follows without waiting for the poll. */
  refreshKey: string
  onNewThread(): void
  onOpenThread(thread: ThreadSummary): void
  onContinueInProject(thread: ThreadSummary, projectId: string): void
  onPromoteGeneral(name: string): Promise<void>
}

const readCollapsed = (): boolean => { try { return localStorage.getItem(COLLAPSED_KEY) === 'true' } catch { return false } }

/**
 * Threads (t3code's sidebar, Conductor's phone list): every open conversation in every project,
 * grouped by what needs the owner, what is working, and recency, newest first. A thread started
 * without a project is labelled "General". Main builds the view (src/shared/threads.ts); this only
 * shows it.
 */
export const ThreadList = memo(function ThreadList(props: ThreadListProps): React.JSX.Element {
  const [view, setView] = useState<ThreadView | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [menu, setMenu] = useState<{ thread: ThreadSummary | null; x: number; y: number } | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const now = useRef(Date.now())
  const refresh = useCallback(() => {
    void window.conductor.threads.list(query).then(next => { now.current = Date.parse(next.observedAt) || Date.now(); setView(next) }).catch(() => undefined)
  }, [query])
  useEffect(() => { if (!collapsed) refresh() }, [collapsed, refresh, props.refreshKey])
  useEffect(() => {
    if (collapsed) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh() }, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [collapsed, refresh])
  useEffect(() => {
    if (!menu) return
    const close = (event: Event): void => { if (event.target instanceof Element && event.target.closest('.thread-menu')) return; setMenu(null) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape) }
  }, [menu])

  const toggle = (): void => {
    setCollapsed(current => { const next = !current; try { localStorage.setItem(COLLAPSED_KEY, String(next)) } catch { /* per-window convenience */ } return next })
  }
  const openMenu = (event: React.MouseEvent, thread: ThreadSummary | null): void => {
    event.preventDefault(); event.stopPropagation()
    setMenu({ thread, x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 260) })
  }
  const finishPromote = async (commit: boolean): Promise<void> => {
    const name = promoting?.trim()
    setPromoting(null)
    if (!commit || !name) return
    try { await props.onPromoteGeneral(name); setNote(''); refresh() } catch (error) { setNote(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)) }
  }
  // A project on another machine runs its threads there; continuing into one is a later slice.
  const targets = props.projects.filter(project => !project.general && !project.remote)
  const hasGeneral = Boolean(view?.generalProjectId)
  const total = view?.total ?? 0

  return (
    <section className="sidebar-section threads-section" aria-label="Threads" data-thread-count={total}>
      <div className="sidebar-heading">
        <button type="button" className="threads-toggle" onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span>Threads</span>
          {total > 0 && <small>{total}</small>}
        </button>
        <div className="heading-actions">
          <button type="button" className="threads-new" title="New thread, no project needed (Ctrl+Alt+N)" aria-label="New thread" onClick={props.onNewThread}><Plus size={14} /></button>
          {hasGeneral && <button type="button" title="More thread actions" aria-label="More thread actions" onClick={event => openMenu(event, null)}><MoreHorizontal size={14} /></button>}
        </div>
      </div>
      {!collapsed && (
        <div className="threads-body">
          {promoting !== null && (
            <input className="threads-promote-input" autoFocus aria-label="Name for the new project" placeholder="Project name" value={promoting}
              onChange={event => setPromoting(event.target.value)} onBlur={() => void finishPromote(false)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void finishPromote(true) } if (event.key === 'Escape') { event.preventDefault(); void finishPromote(false) } }} />
          )}
          {(total > 6 || query) && (
            <input className="threads-search" type="search" placeholder="Search threads" aria-label="Search threads" value={query} onChange={event => setQuery(event.target.value)} />
          )}
          {view?.groups.map(group => (
            <div key={group.bucket} className={`thread-group thread-group-${group.bucket}`}>
              <div className="thread-group-label">{group.label}</div>
              {group.threads.map(thread => {
                const pill = threadStateLabel(thread)
                return (
                  <button key={thread.id} type="button"
                    className={`thread-row${thread.id === props.activeAgentSessionId ? ' active' : ''}`}
                    data-thread-id={thread.id} data-thread-state={thread.state} data-thread-general={thread.general || undefined}
                    title={`${thread.title}\n${thread.general ? `${GENERAL_PROJECT_NAME} (no project)` : thread.projectName} / ${thread.workspaceName} · ${thread.machineName}${thread.lastText ? `\n${thread.lastRole === 'user' ? 'You: ' : ''}${thread.lastText}` : ''}`}
                    onClick={() => props.onOpenThread(thread)}
                    onContextMenu={event => openMenu(event, thread)}>
                    <span className={`thread-dot ${thread.state}`} aria-hidden="true" />
                    <span className="thread-title ellipsis">{thread.wizard ? '✦ ' : ''}{thread.title}</span>
                    {pill ? <em className={`thread-pill ${thread.state}`}>{pill}</em> : <time dateTime={thread.updatedAt}>{threadAge(thread.updatedAt, now.current)}</time>}
                    <small className="thread-meta ellipsis">
                      {thread.general ? <><MessageSquareDashed size={10} aria-hidden="true" /> {GENERAL_PROJECT_NAME}</> : thread.projectName}
                      {thread.coworkers ? ` · +${thread.coworkers} coworker${thread.coworkers === 1 ? '' : 's'}` : ''}
                    </small>
                  </button>
                )
              })}
            </div>
          ))}
          {view && view.hidden > 0 && <p className="threads-note">{view.hidden} more; search to find them.</p>}
          {view && !total && (
            <p className="threads-empty">{query ? 'No thread matches.' : <>No open threads. <button type="button" onClick={props.onNewThread}>Start one</button> — no project needed.</>}</p>
          )}
          {note && <p className="threads-note" role="status">{note}</p>}
        </div>
      )}
      {menu && createPortal(
        <div className="cursor-context-menu project-context-menu thread-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={event => event.stopPropagation()}>
          {menu.thread ? (
            <>
              <div className="context-menu-label">{menu.thread.title}</div>
              {menu.thread.general && targets.length > 0 && <>
                <div className="context-menu-label">Continue in project</div>
                {targets.map(project => (
                  <button key={project.id} type="button" data-continue-project={project.id} onClick={() => { const thread = menu.thread!; setMenu(null); props.onContinueInProject(thread, project.id) }}>
                    <FolderGit2 size={14} /> {project.name}
                  </button>
                ))}
              </>}
              {menu.thread.general && !targets.length && <div className="context-menu-label">Open a project to continue this thread there</div>}
            </>
          ) : (
            <button type="button" data-promote-general onClick={() => { setMenu(null); setPromoting('') }}>
              <FolderInput size={14} /> Turn General into a project…
            </button>
          )}
        </div>,
        document.body
      )}
    </section>
  )
})
