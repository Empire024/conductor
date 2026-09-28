import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, FileText, RotateCcw, Search, TerminalSquare, Trash2, X } from 'lucide-react'
import type { SessionRecord } from '../../../shared/models'
import type { ArchivedTab } from '../../../shared/tab-archive'
import { EMPTY_SELECTION, orderedSelection, selectAll, selectionClick, type TabSelection } from '../layout/tab-selection'
import { ProviderIcon } from './ProviderIcon'
import './TabArchiveDialog.css'

const OPEN_EVENT = 'conductor:open-tab-archive'
/** Tells a window that holds this workspace's reopen list to drop tabs deleted for good. */
export const FORGET_CLOSED_EVENT = 'conductor:closed-tabs-forget'

/** Opens the archive of a workspace (the one on screen when none is named). */
export function openTabArchive(sessionId?: string, query?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { sessionId, query } }))
}

const ago = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString()
}

/** Mounted once per window: shows the archive of whichever workspace asked for it. */
export function TabArchiveHost({ sessions, activeSessionId }: { sessions: readonly SessionRecord[]; activeSessionId: string | null }): React.JSX.Element | null {
  const [open, setOpen] = useState<{ sessionId: string; query: string } | null>(null)
  const activeRef = useRef(activeSessionId)
  activeRef.current = activeSessionId
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string; query?: string }>).detail
      const sessionId = detail?.sessionId ?? activeRef.current
      if (sessionId) setOpen({ sessionId, query: detail?.query ?? '' })
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])
  if (!open) return null
  const session = sessions.find(item => item.id === open.sessionId)
  return <TabArchiveDialog key={open.sessionId} sessionId={open.sessionId} workspaceName={session?.name ?? 'this workspace'} initialQuery={open.query} onClose={() => setOpen(null)} />
}

export function TabArchiveDialog({ sessionId, workspaceName, initialQuery = '', onClose }: { sessionId: string; workspaceName: string; initialQuery?: string; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState(initialQuery)
  const [entries, setEntries] = useState<ArchivedTab[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selection, setSelection] = useState<TabSelection>(EMPTY_SELECTION)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [note, setNote] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const now = Date.now()

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await window.conductor.tabArchive.list(sessionId, query, 500)
      setEntries(page.tabs); setTotal(page.total)
    } catch (reason) { setNote(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [sessionId, query])
  useEffect(() => { const timer = window.setTimeout(() => void load(), 120); return () => window.clearTimeout(timer) }, [load])
  useEffect(() => window.conductor.tabArchive.onChanged(change => { if (change.sessionId === sessionId) void load() }), [sessionId, load])
  useEffect(() => inputRef.current?.focus(), [])
  // Esc wherever focus is (a button that just unmounted leaves it on the page): clears a selection, then closes.
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (selectionRef.current.ids.size) setSelection(EMPTY_SELECTION)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const order = useMemo(() => entries.map(entry => entry.tab.id), [entries])
  const chosen = orderedSelection(selection, order)

  const reopen = (tabIds: string[]): void => {
    if (!tabIds.length) return
    setNote('')
    void window.conductor.tabArchive.reopen(sessionId, tabIds)
      .then(() => onClose())
      .catch(reason => setNote(reason instanceof Error ? reason.message : String(reason)))
  }
  const remove = (tabIds: string[]): void => {
    setConfirmDelete(false)
    void window.conductor.tabArchive.remove(sessionId, tabIds)
      .then(result => {
        window.dispatchEvent(new CustomEvent(FORGET_CLOSED_EVENT, { detail: { sessionId, tabIds } }))
        setSelection(EMPTY_SELECTION)
        setNote(`Deleted ${result.removed} for good.`)
        void load()
      })
      .catch(reason => setNote(reason instanceof Error ? reason.message : String(reason)))
  }

  const keyDown = (event: React.KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && event.target !== inputRef.current) { event.preventDefault(); setSelection(selectAll(order)) }
    if (event.key === 'Enter' && chosen.length && event.target !== inputRef.current) { event.preventDefault(); reopen(chosen) }
    if (event.key === 'Delete' && chosen.length) { event.preventDefault(); setConfirmDelete(true) }
  }

  return createPortal(<div className="palette-backdrop tab-archive-backdrop" onMouseDown={onClose}>
    <div className="tab-archive" role="dialog" aria-label={`Closed tabs of ${workspaceName}`} onMouseDown={event => event.stopPropagation()} onKeyDown={keyDown}>
      <header>
        <Archive size={15} />
        <strong>Archive</strong>
        <span>{workspaceName} · {total} closed tab{total === 1 ? '' : 's'}</span>
        <button type="button" className="tab-archive-close" aria-label="Close archive" onClick={onClose}><X size={14} /></button>
      </header>
      <label className="tab-archive-search"><Search size={13} /><input ref={inputRef} value={query} placeholder="Search closed tabs by title or agent id" aria-label="Search closed tabs" onChange={event => { setQuery(event.target.value); setSelection(EMPTY_SELECTION) }} /></label>
      <div className="tab-archive-list" role="listbox" aria-multiselectable="true" aria-label="Closed tabs" tabIndex={0}>
        {!loading && !entries.length && <p className="tab-archive-empty">{query.trim() ? 'No closed tab matches.' : 'No closed tabs yet. Every tab you close lands here.'}</p>}
        {entries.map(entry => {
          const { tab } = entry, selected = selection.ids.has(tab.id)
          return <div key={tab.id} role="option" aria-selected={selected} data-archived-tab-id={tab.id} className={`tab-archive-row${selected ? ' selected' : ''}`}
            onClick={event => setSelection(current => selectionClick(order, current, tab.id, null, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }))}
            onDoubleClick={() => reopen([tab.id])}>
            {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} model={tab.state?.model as string | undefined} size={13} /> : tab.kind === 'terminal' ? <TerminalSquare size={13} /> : <FileText size={13} />}
            <span className="tab-archive-title" title={tab.title}>{tab.title}</span>
            <small title={tab.resourceId ?? tab.id}>{tab.kind === 'agent' ? 'conversation' : tab.kind} · {ago(entry.closedAt, now)}</small>
            <button type="button" title="Reopen in its workspace" aria-label={`Reopen ${tab.title}`} onClick={event => { event.stopPropagation(); reopen([tab.id]) }}><RotateCcw size={12} /></button>
            <button type="button" className="danger" title="Delete for good" aria-label={`Delete ${tab.title} for good`} onClick={event => { event.stopPropagation(); setSelection({ ids: new Set([tab.id]), anchor: tab.id }); setConfirmDelete(true) }}><Trash2 size={12} /></button>
          </div>
        })}
      </div>
      <footer>
        {confirmDelete && chosen.length > 0
          ? <div className="tab-archive-confirm" role="alertdialog" aria-label="Delete for good">
              <span>Delete {chosen.length} closed tab{chosen.length === 1 ? '' : 's'} for good? {entries.some(entry => chosen.includes(entry.tab.id) && entry.tab.kind === 'agent') ? 'Coworkers and reports that name a conversation still reach it; it just leaves this list.' : ''}</span>
              <button type="button" className="danger" onClick={() => remove(chosen)}>Delete {chosen.length}</button>
              <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          : <>
              <span className="tab-archive-hint">{chosen.length ? `${chosen.length} selected` : 'Click, Ctrl+click, Shift+click to select · double-click reopens'}</span>
              <button type="button" disabled={!chosen.length} onClick={() => reopen(chosen)}><RotateCcw size={12} /> Reopen{chosen.length > 1 ? ` ${chosen.length}` : ''}</button>
              <button type="button" className="danger" disabled={!chosen.length} onClick={() => setConfirmDelete(true)}><Trash2 size={12} /> Delete forever</button>
            </>}
        {note && <small className="tab-archive-note" role="status">{note}</small>}
      </footer>
    </div>
  </div>, document.body)
}
