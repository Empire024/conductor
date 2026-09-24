import { useCallback, useEffect, useRef, useState } from 'react'
import { Lightbulb, Loader2, PanelRightClose, PanelRightOpen, Search, Settings2, SquarePen, X } from 'lucide-react'
import type { IdeaDetail, IdeaIncubatorSettings, IdeaStatus, IdeaSummary } from '../../../../shared/ideas'
import { IDEA_CAPTURE_SHORTCUT_LABEL, IDEA_STATUS_LABELS, ideaPreview, inferIdeaTitle } from '../../../../shared/ideas'
import type { ProjectRecord } from '../../../../shared/models'
import { IdeaEditor } from './IdeaEditor'
import { IdeaDetailPanel, type IdeaAction, type IdeaWorkProvider } from './IdeaDetailPanel'
import {
  IDEA_FILTERS, IdeaAutosave, clampMaxPerNight, ideaErrorMessage, ideaListQuery, ideaProgress, isExploring, relativeAge,
  type IdeaFilter, type IdeaSaveState
} from './ideas-model'
import './IdeasView.css'

const PANEL_KEY = 'conductor.ideas.panelOpen'
/** Overlays that sit above Ideas and own Esc while they are open. */
const OVERLAYS_ABOVE = '.settings-scrim, .palette-backdrop, .dialog-backdrop, .update-prompt-backdrop'

/**
 * The capture counter the view last turned into a new note. Module-level so a view that is closed
 * and reopened by the title bar does not mistake an old capture for a new one.
 */
let lastHandledCapture = 0

interface IdeasViewProps {
  onClose(): void
  /** Bumped by App for every capture (Ctrl+Alt+I, palette): each bump opens a fresh note. */
  captureRequest: number
}

/** Ideas (docs/ideas.md): a full-stage section over the workspace, which stays mounted beneath. */
export function IdeasView({ onClose, captureRequest }: IdeasViewProps): React.JSX.Element {
  const bridge = window.conductor.ideas
  const [filter, setFilter] = useState<IdeaFilter>('active')
  const [search, setSearch] = useState('')
  const [ideas, setIdeas] = useState<IdeaSummary[]>([])
  const [listLoaded, setListLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<IdeaDetail | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorReady, setEditorReady] = useState(false)
  const [saveState, setSaveState] = useState<IdeaSaveState>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<IdeaAction | null>(null)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== 'false')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [incubator, setIncubatorState] = useState<IdeaIncubatorSettings | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Decided on the first render, before any effect records the capture as handled (StrictMode
  // replays mount effects, and the replay must not mistake the handled capture for "no capture").
  const openedForCapture = useRef(captureRequest > lastHandledCapture)
  const selectedIdRef = useRef<string | null>(null)
  const saverRef = useRef<IdeaAutosave | null>(null)
  const flushing = useRef(new Set<Promise<void>>())
  const loadSeq = useRef(0)
  const refreshSeq = useRef(0)
  const discardArmed = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)

  // ---- list --------------------------------------------------------------------------------
  const listSeq = useRef(0)
  const reloadList = useCallback(async (): Promise<IdeaSummary[]> => {
    const seq = ++listSeq.current
    try {
      const list = await bridge.list(ideaListQuery(filter, search))
      if (seq === listSeq.current) { setIdeas(list); setListLoaded(true); setNow(Date.now()) }
      return list
    } catch (reason) {
      if (seq === listSeq.current) { setError(ideaErrorMessage(reason)); setListLoaded(true) }
      return []
    }
  }, [bridge, filter, search])
  const reloadListRef = useRef(reloadList)
  reloadListRef.current = reloadList
  useEffect(() => {
    const timer = window.setTimeout(() => void reloadList(), search ? 200 : 0)
    return () => window.clearTimeout(timer)
  }, [reloadList, search])

  // ---- autosave ----------------------------------------------------------------------------
  const focusEditor = useCallback((): void => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }, [])

  const makeSaver = useCallback((ideaId: string | null, text: string): IdeaAutosave => {
    const saver: IdeaAutosave = new IdeaAutosave({
      capture: value => bridge.capture({ text: value, source: 'desktop' }),
      update: (id, value) => bridge.update(id, { text: value })
    }, ideaId, text, {
      onState: state => { if (saverRef.current === saver) setSaveState(state) },
      onError: reason => setError(`Could not save “${inferIdeaTitle(saver.text)}”: ${ideaErrorMessage(reason)}`),
      onSaved: (saved, info) => {
        void reloadListRef.current()
        if (saverRef.current !== saver) return
        if (info.created) { selectedIdRef.current = saved.id; setSelectedId(saved.id) }
        // The response only refreshes the metadata; the editor keeps whatever the owner has typed since.
        if (selectedIdRef.current === saved.id) setDetail(saved)
        setError('')
      }
    })
    return saver
  }, [bridge])

  /** Starts saving the current note now; the promise is tracked so a reload can wait for it. */
  const flushCurrent = useCallback((): Promise<boolean> => {
    const saver = saverRef.current
    if (!saver) return Promise.resolve(true)
    const pending = saver.flush()
    flushing.current.add(pending)
    return pending.finally(() => flushing.current.delete(pending)).then(() => !(saver.dirty && saver.text.trim()))
  }, [])

  const startNewNote = useCallback((): void => {
    const current = saverRef.current
    if (current && current.ideaId === null && !current.text.trim()) { setEditorReady(true); focusEditor(); return }
    void flushCurrent()
    loadSeq.current++
    saverRef.current = makeSaver(null, '')
    selectedIdRef.current = null
    setSelectedId(null)
    setDetail(null)
    setEditorText('')
    setEditorReady(true)
    setSaveState('idle')
    setNotice('')
    discardArmed.current = false
    focusEditor()
  }, [flushCurrent, focusEditor, makeSaver])

  const selectIdea = useCallback(async (id: string): Promise<void> => {
    if (id === selectedIdRef.current && saverRef.current?.ideaId === id) return
    const seq = ++loadSeq.current
    setEditorReady(false)
    void flushCurrent()
    saverRef.current = null
    selectedIdRef.current = id
    setSelectedId(id)
    setDetail(null)
    setError('')
    setNotice('')
    setSaveState('idle')
    discardArmed.current = false
    // A save of this very note may still be landing (switch away and straight back).
    await Promise.allSettled([...flushing.current])
    try {
      const loaded = await bridge.get(id)
      if (seq !== loadSeq.current) return
      saverRef.current = makeSaver(id, loaded.text)
      setDetail(loaded)
      setEditorText(loaded.text)
      setEditorReady(true)
      focusEditor()
    } catch (reason) {
      if (seq === loadSeq.current) setError(ideaErrorMessage(reason))
    }
  }, [bridge, flushCurrent, focusEditor, makeSaver])

  const refreshDetail = useCallback(async (id: string): Promise<void> => {
    const seq = ++refreshSeq.current
    const saver = saverRef.current
    const revision = saver?.revision
    try {
      const loaded = await bridge.get(id)
      if (seq !== refreshSeq.current || selectedIdRef.current !== id) return
      setDetail(loaded)
      const current = saverRef.current
      if (current && current === saver && current.ideaId === id && current.text !== loaded.text && current.acceptServerText(loaded.text, revision)) {
        setEditorText(loaded.text)
      }
    } catch { /* the next change refreshes again */ }
  }, [bridge])

  const onEdit = useCallback((text: string): void => {
    setEditorText(text)
    discardArmed.current = false
    saverRef.current?.edit(text)
  }, [])

  // ---- open, capture, live refresh, close ---------------------------------------------------
  const close = useCallback(async (): Promise<void> => {
    const saved = await flushCurrent()
    if (!saved && !discardArmed.current) {
      discardArmed.current = true
      setError('The latest text could not be saved. Press Esc again to close without it.')
      return
    }
    onClose()
  }, [flushCurrent, onClose])
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    // Open on a blank note; without a capture request, show the newest idea unless typing began.
    startNewNote()
    if (openedForCapture.current) return
    let cancelled = false
    void bridge.list(ideaListQuery('active', '')).then(list => {
      const current = saverRef.current
      if (cancelled || selectedIdRef.current || (current && current.text.trim())) return
      if (list[0]) void selectIdea(list[0].id)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (captureRequest <= lastHandledCapture) return
    lastHandledCapture = captureRequest
    startNewNote()
  }, [captureRequest, startNewNote])

  useEffect(() => () => { void saverRef.current?.flush() }, [])

  useEffect(() => bridge.onChanged(change => {
    void reloadListRef.current()
    const id = selectedIdRef.current
    if (id && (change.ideaId === null || change.ideaId === id)) void refreshDetail(id)
  }), [bridge, refreshDetail])

  useEffect(() => {
    void window.conductor.projects.list().then(setProjects).catch(() => undefined)
    return window.conductor.projects.onChanged(setProjects)
  }, [])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(tick)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector(OVERLAYS_ABOVE)) return
      event.preventDefault()
      if (settingsOpen) { setSettingsOpen(false); return }
      void closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  // ---- incubator settings ------------------------------------------------------------------
  useEffect(() => {
    if (!settingsOpen) return
    void bridge.incubator().then(setIncubatorState).catch(reason => setError(ideaErrorMessage(reason)))
    const closeOutside = (event: MouseEvent): void => { if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false) }
    window.addEventListener('mousedown', closeOutside)
    return () => window.removeEventListener('mousedown', closeOutside)
  }, [bridge, settingsOpen])
  const changeIncubator = (patch: Partial<IdeaIncubatorSettings>): void => {
    if (incubator) setIncubatorState({ ...incubator, ...patch })
    void bridge.setIncubator(patch).then(setIncubatorState).catch(reason => setError(ideaErrorMessage(reason)))
  }

  // ---- actions -----------------------------------------------------------------------------
  const runAction = async (action: IdeaAction, work: (ideaId: string) => Promise<void>): Promise<void> => {
    const ideaId = selectedIdRef.current
    if (!ideaId || busy) return
    setBusy(action)
    setError('')
    setNotice('')
    try {
      await flushCurrent()
      await work(ideaId)
    } catch (reason) {
      setError(ideaErrorMessage(reason))
    } finally {
      setBusy(null)
    }
  }
  const projectName = (id: string): string => projects.find(project => project.id === id)?.name ?? 'the project'
  const applyDetail = (next: IdeaDetail): void => { if (selectedIdRef.current === next.id) setDetail(next) }

  const setStatus = (status: IdeaStatus): Promise<void> => runAction('status', async id => applyDetail(await bridge.update(id, { status })))
  const archive = (): Promise<void> => runAction('archive', async id => {
    applyDetail(await bridge.update(id, { status: 'archived' }))
    setNotice('Archived. It stays searchable under Archived.')
  })
  const workOn = (projectId: string, provider: IdeaWorkProvider): Promise<void> => runAction('work', async id => {
    await bridge.work({ ideaId: id, projectId, provider })
    setNotice(`Opened a ${provider === 'codex' ? 'Codex' : 'Claude'} tab in ${projectName(projectId)}, briefed with this idea. Close Ideas to see it.`)
  })
  const explore = (): Promise<void> => runAction('explore', async id => {
    const exploration = await bridge.explore({ ideaId: id })
    setNotice(`Exploring with ${exploration.model} as a background job. The brief appears here when it finishes.`)
    void refreshDetail(id)
  })
  const createTask = (projectId: string): Promise<void> => runAction('task', async id => {
    const link = await bridge.createTask({ ideaId: id, projectId })
    setNotice(`Task added to ${projectName(projectId)}: ${link.label}`)
    void refreshDetail(id)
  })
  const openLink = (linkId: string): Promise<void> => runAction('link', id => bridge.openLink(id, linkId))
  const unlink = (linkId: string): Promise<void> => runAction('link', async id => applyDetail(await bridge.unlink(id, linkId)))

  // ---- render ------------------------------------------------------------------------------
  const togglePanel = (): void => setPanelOpen(open => { localStorage.setItem(PANEL_KEY, String(!open)); return !open })
  const liveTitle = inferIdeaTitle(editorText)
  const livePreview = ideaPreview(editorText)
  const rows = ideas
  const newNoteVisible = selectedId === null
  const saveLabel = saveState === 'saving' ? 'Saving…' : saveState === 'pending' ? 'Edited' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''

  return (
    <section className="ideas-view" aria-label="Ideas">
      <aside className="ideas-sidebar">
        <header className="ideas-sidebar-head">
          <h2><Lightbulb size={15} /> Ideas</h2>
          <button className="ideas-new" onClick={startNewNote} title={`New idea (${IDEA_CAPTURE_SHORTCUT_LABEL} from anywhere)`}>
            <SquarePen size={13} /> New idea <kbd>{IDEA_CAPTURE_SHORTCUT_LABEL}</kbd>
          </button>
        </header>
        <div className="ideas-filters">
          <label className="ideas-search">
            <Search size={12} />
            <input type="search" placeholder="Search ideas" value={search} onChange={event => setSearch(event.target.value)} aria-label="Search ideas" />
          </label>
          <select aria-label="Status filter" value={filter} onChange={event => setFilter(event.target.value as IdeaFilter)}>
            {IDEA_FILTERS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </div>
        <ul className="ideas-list">
          {newNoteVisible && (
            <li>
              <button className="ideas-row active" onClick={focusEditor}>
                <span className="ideas-row-title">{editorText.trim() ? liveTitle : 'New idea'}</span>
                <span className="ideas-row-meta"><span className="ideas-row-preview">{livePreview || (saveState === 'saving' ? 'Saving…' : 'Not saved until you type')}</span></span>
              </button>
            </li>
          )}
          {rows.map(idea => {
            const selected = idea.id === selectedId
            const progress = ideaProgress(idea)
            const title = selected && editorReady ? liveTitle : idea.title
            const preview = selected && editorReady ? livePreview : idea.preview
            return (
              <li key={idea.id}>
                <button className={selected ? 'ideas-row active' : 'ideas-row'} onClick={() => void selectIdea(idea.id)}>
                  <span className="ideas-row-title">{title}</span>
                  <span className="ideas-row-meta">
                    <time dateTime={idea.updatedAt}>{relativeAge(idea.updatedAt, now)}</time>
                    <span className="ideas-row-preview">{preview}</span>
                  </span>
                  <span className="ideas-row-foot">
                    <span className={`ideas-progress tone-${progress.tone}`}>{progress.label}</span>
                    {isExploring(idea) && <span className="ideas-exploring"><Loader2 size={10} className="ideas-spin" /> Exploring</span>}
                    {idea.status !== 'inbox' && idea.status !== 'exploring' && <span className="ideas-status">{IDEA_STATUS_LABELS[idea.status]}</span>}
                  </span>
                </button>
              </li>
            )
          })}
          {listLoaded && !rows.length && !newNoteVisible && <li className="ideas-empty">{search || filter !== 'active' ? 'No ideas match.' : 'No ideas yet.'}</li>}
          {listLoaded && !rows.length && newNoteVisible && !search && filter === 'active' && (
            <li className="ideas-empty">Your ideas collect here. Press {IDEA_CAPTURE_SHORTCUT_LABEL} anywhere to jot one down.</li>
          )}
        </ul>
        <footer className="ideas-sidebar-foot" ref={settingsRef}>
          <button className="ideas-quiet" onClick={() => setSettingsOpen(open => !open)} aria-expanded={settingsOpen}><Settings2 size={12} /> Incubator</button>
          {settingsOpen && (
            <div className="ideas-settings" role="dialog" aria-label="Idea incubator">
              <strong>Idea incubator</strong>
              <p>At night, a local model explores a few untouched ideas and leaves a brief. It never uses a cloud model.</p>
              {incubator ? <>
                <label className="ideas-check"><input type="checkbox" checked={incubator.enabled} onChange={event => changeIncubator({ enabled: event.target.checked })} /> Explore untouched ideas at night</label>
                <label className="ideas-field"><span>Max per night</span>
                  <input type="number" min={1} max={10} value={incubator.maxPerNight} disabled={!incubator.enabled}
                    onChange={event => changeIncubator({ maxPerNight: clampMaxPerNight(Number(event.target.value)) })} />
                </label>
                <label className="ideas-field"><span>Intensity</span>
                  <select value={incubator.intensity} disabled={!incubator.enabled} onChange={event => changeIncubator({ intensity: event.target.value as IdeaIncubatorSettings['intensity'] })}>
                    <option value="light">Light (research, 20 min)</option>
                    <option value="explore">Explore (research and report, 45 min)</option>
                  </select>
                </label>
              </> : <p className="ideas-muted">Loading…</p>}
            </div>
          )}
        </footer>
      </aside>

      <div className="ideas-main">
        <header className="ideas-main-head">
          <span className="ideas-save-state" aria-live="polite">
            {detail && <span className="ideas-status">{IDEA_STATUS_LABELS[detail.status]}</span>}
            {saveLabel}
          </span>
          <span className="ideas-spacer" />
          {selectedId && (
            <button className="ideas-icon" onClick={togglePanel} aria-label={panelOpen ? 'Hide details' : 'Show details'} title={panelOpen ? 'Hide details' : 'Show details'}>
              {panelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          )}
          <button className="ideas-icon" onClick={() => void close()} aria-label="Close Ideas" title="Close Ideas (Esc)"><X size={16} /></button>
        </header>
        {(error || notice) && (
          <div className={error ? 'ideas-banner error' : 'ideas-banner'} role={error ? 'alert' : 'status'}>
            <span>{error || notice}</span>
            <button className="ideas-icon" aria-label="Dismiss" onClick={() => { setError(''); setNotice('') }}><X size={12} /></button>
          </div>
        )}
        <div className="ideas-body">
          <div className="ideas-editor-wrap">
            <IdeaEditor
              text={editorText}
              readOnly={!editorReady}
              textareaRef={textareaRef}
              onChange={onEdit}
              onBlur={() => void flushCurrent()}
            />
          </div>
          {panelOpen && detail && (
            <IdeaDetailPanel
              key={detail.id}
              idea={detail}
              projects={projects}
              now={now}
              busy={busy}
              onStatus={status => void setStatus(status)}
              onWork={(projectId, provider) => void workOn(projectId, provider)}
              onExplore={() => void explore()}
              onCreateTask={projectId => void createTask(projectId)}
              onArchive={() => void archive()}
              onOpenLink={linkId => void openLink(linkId)}
              onUnlink={linkId => void unlink(linkId)}
            />
          )}
        </div>
      </div>
    </section>
  )
}
