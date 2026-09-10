import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, FileCode2, Globe2, Plus, X } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { fileTypeStyle } from '../file-types'
import { CodePane } from '../panes/CodePane'
import { FilePreviewPane } from '../panes/FilePreviewPane'
import { BrowserPane } from '../panes/BrowserPane'
import { FilePicker } from './FilePicker'
import { runFileLinkAction } from './file-link-actions'
import { buildFileLinkMenuEntries, FILE_LINK_MENU_ICONS, type FileLinkMenuAction } from './file-link-menu'
import { changeWorkspacePath, loadWorkspaceFiles, openWorkspaceFile, recentWorkspaceFiles, type OpenWorkspaceFile, type WorkspaceFile } from './workspace-files-state'
import { recordRecentFile } from './recent-files-store'
import './WorkspaceFiles.css'

const notify = (message: string): void => { window.dispatchEvent(new CustomEvent('conductor:toast', { detail: message })) }

function FileBrowser({ project, file }: { project: ProjectRecord; file: WorkspaceFile }): React.JSX.Element {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => { let live = true; void window.conductor.files.browserUrl(project.id, file.path).then((value) => { if (live) setUrl(value) }).catch((reason: unknown) => { if (live) setError(String(reason)) }); return () => { live = false } }, [project.id, file.path])
  return url ? <BrowserPane key={url} initialUrl={url} compact performanceTabId={file.id} /> : <p className="editor-loading">{error || 'Opening browser…'}</p>
}
export function WorkspaceFiles({ projects, projectId, workspaceId, showHiddenFilesDefault }: { projects: ProjectRecord[]; projectId: string; workspaceId: string; showHiddenFilesDefault?: boolean }): React.JSX.Element | null {
  const [state, setState] = useState(() => loadWorkspaceFiles(workspaceId))
  const [width, setWidth] = useState(() => Number(localStorage.getItem('conductor.documentWidth')) || 620)
  const [picker, setPicker] = useState(false), [creating, setCreating] = useState(false), [error, setError] = useState('')
  const [naming, setNaming] = useState<{ file: WorkspaceFile; value: string } | null>(null)
  const [menu, setMenu] = useState<{ file: WorkspaceFile; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const namingRef = useRef(naming); namingRef.current = naming
  const namingInput = useRef<HTMLInputElement>(null)
  const creatingRef = useRef(false), renamingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set())
  const host = useRef<HTMLElement>(null)
  const stateRef = useRef(state); stateRef.current = state
  const active = state.files.find((file) => file.id === state.activeId) ?? state.files[0]
  const open = (file: OpenWorkspaceFile): void => {
    // Only a real editor open counts as "opened" — previews and browser links must not skew recency.
    if (file.mode === 'editor') recordRecentFile(file.projectId, file.path)
    setState((current) => {
      const existing = current.files.find((item) => item.projectId === file.projectId && item.path === file.path)
      const next = { ...file, id: existing?.id ?? 'document:' + workspaceId + ':' + crypto.randomUUID() }
      return { files: existing ? current.files.map((item) => item.id === existing.id ? { ...item, ...next } : item) : [...current.files, next], activeId: next.id }
    })
  }
  const focusEditor = (): void => { requestAnimationFrame(() => { host.current?.querySelector<HTMLTextAreaElement>('.file-tab-content:not([hidden]) .monaco-editor textarea')?.focus() }) }
  const showFileMenu = (event: React.MouseEvent, file: WorkspaceFile): void => {
    event.preventDefault(); event.stopPropagation()
    setMenu({ file, x: Math.min(event.clientX, window.innerWidth - 226), y: Math.max(6, Math.min(event.clientY, window.innerHeight - 250)) })
  }
  const runFileMenuAction = (action: FileLinkMenuAction, file: WorkspaceFile): void => {
    setMenu(null)
    runFileLinkAction(action, { projectId: file.projectId, path: file.path, line: file.line }, (path, line) => open({ projectId: file.projectId, path, mode: 'editor', line, allowBinary: file.allowBinary }), notify)
  }
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onEscape)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('resize', close); window.removeEventListener('keydown', onEscape) }
  }, [menu])
  const stopNaming = (): void => { namingRef.current = null; setNaming(null); setError('') }
  const finishNaming = async (): Promise<void> => {
    const entry = namingRef.current
    if (!entry || renamingRef.current) return
    const name = entry.value.trim()
    if (!name || name === entry.file.path.split('/').pop()) { stopNaming(); return }
    renamingRef.current = true; setRenaming(true); setError('')
    try {
      window.dispatchEvent(new Event('conductor:flush-editors'))
      const renamed = await window.conductor.files.rename(entry.file.projectId, entry.file.path, name)
      changeWorkspacePath(entry.file.projectId, entry.file.path, renamed.relativePath, 'file')
      window.dispatchEvent(new Event('conductor:refresh-files'))
      if (namingRef.current?.file.id === entry.file.id) stopNaming()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { renamingRef.current = false; setRenaming(false) }
  }
  const createFile = async (): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true; setCreating(true); setError('')
    try {
      const owner = active?.projectId ?? projectId
      const directory = active?.path.includes('/') ? active.path.slice(0, active.path.lastIndexOf('/')) : ''
      const created = await window.conductor.files.createUntitled(owner, directory)
      const file: WorkspaceFile = { id: 'document:' + workspaceId + ':' + crypto.randomUUID(), projectId: owner, path: created.relativePath, mode: 'editor' }
      // A workspace may change while the file is being created. Persist its
      // new tab under the original workspace even if this view was unmounted.
      const current = mounted.current ? stateRef.current : loadWorkspaceFiles(workspaceId)
      const next = { files: [...current.files, file], activeId: file.id }
      localStorage.setItem('conductor.workspaceFiles.' + workspaceId, JSON.stringify(next))
      if (mounted.current) { stateRef.current = next; setState(next); setNaming({ file, value: created.name }) }
      window.dispatchEvent(new Event('conductor:refresh-files'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { creatingRef.current = false; setCreating(false) }
  }
  useEffect(() => {
    if (!naming) return
    const frame = requestAnimationFrame(() => {
      const input = namingInput.current
      input?.focus()
      input?.setSelectionRange(0, Math.max(0, naming.value.lastIndexOf('.')) || naming.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [naming?.file.id])
  const close = async (id: string): Promise<void> => {
    window.dispatchEvent(new Event('conductor:flush-editors'))
    if (!await window.conductor.files.confirmClose([id])) return
    setState((current) => {
      const index = current.files.findIndex((file) => file.id === id)
      const files = current.files.filter((file) => file.id !== id)
      return { files, activeId: current.activeId === id ? files[Math.min(index, files.length - 1)]?.id ?? null : current.activeId }
    })
  }
  useEffect(() => {
    localStorage.setItem('conductor.workspaceFiles.' + workspaceId, JSON.stringify(state))
    window.dispatchEvent(new CustomEvent('conductor:browser-files', { detail: state.files.filter((file) => file.mode === 'browser') }))
  }, [state, workspaceId])
  useEffect(() => {
    const receive = (event: Event): void => open((event as CustomEvent<OpenWorkspaceFile>).detail)
    const pathChanged = (): void => setState(loadWorkspaceFiles(workspaceId))
    const agentFile = (event: Event): void => {
      const detail = (event as CustomEvent<{ cwd: string; path: string; mode: 'browser' | 'external'; line?: number }>).detail
      const project = projects.find((item) => item.path.replaceAll('\\', '/').toLowerCase() === detail.cwd.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase())
      if (!project) return
      if (detail.mode === 'external') void window.conductor.files.openInBrowser(project.id, detail.path).catch((reason: unknown) => notify(String(reason)))
      else open({ projectId: project.id, path: detail.path, mode: 'browser', line: detail.line })
    }
    const key = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (event.key.toLowerCase() === 'e') { event.preventDefault(); event.stopImmediatePropagation(); setPicker((current) => !current) }
      if (event.key.toLowerCase() === 'w' && host.current?.contains(document.activeElement) && stateRef.current.activeId) { event.preventDefault(); event.stopImmediatePropagation(); void close(stateRef.current.activeId) }
    }
    const dirty = (event: Event): void => { const detail = (event as CustomEvent<{ id: string; dirty: boolean }>).detail; setDirtyIds((current) => { const next = new Set(current); if (detail.dirty) next.add(detail.id); else next.delete(detail.id); return next }) }
    const offShortcut = window.conductor.files.onOpenShortcut(() => setPicker((current) => !current))
    const storageChanged = (event: StorageEvent): void => { if (event.key === 'conductor.workspaceFiles.' + workspaceId) pathChanged() }
    window.addEventListener('storage', storageChanged)
    const offResolved = window.conductor.files.onDraftResolved(({ tabId }) => setDirtyIds((current) => { const next = new Set(current); next.delete(tabId); return next }))
    window.addEventListener('conductor:open-file', receive)
    window.addEventListener('conductor:agent-file', agentFile)
    window.addEventListener('conductor:files-path-changed', pathChanged)
    window.addEventListener('conductor:editor-dirty', dirty)
    window.addEventListener('keydown', key, true)
    return () => {
      offResolved(); offShortcut(); window.removeEventListener('storage', storageChanged)
      window.removeEventListener('conductor:open-file', receive); window.removeEventListener('conductor:agent-file', agentFile)
      window.removeEventListener('conductor:files-path-changed', pathChanged); window.removeEventListener('conductor:editor-dirty', dirty); window.removeEventListener('keydown', key, true)
    }
  }, [projects, workspaceId])
  const resize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    const x = event.clientX, initial = width, element = event.currentTarget
    const move = (next: PointerEvent): void => { const size = Math.max(320, Math.min(window.innerWidth - 300, initial + x - next.clientX)); setWidth(size); localStorage.setItem('conductor.documentWidth', String(size)) }
    const stop = (): void => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('lostpointercapture', stop) }
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('lostpointercapture', stop)
  }
  return <>
    {active && <aside ref={host} className="workspace-document workspace-files" style={{ width }} aria-label="Open files">
      <button className="workspace-document-resizer" onPointerDown={resize} aria-label="Resize editor" />
      <div className="file-tabs" role="tablist" aria-label="File tabs">
        {state.files.map((file) => <div className={'file-tab' + (file.id === active.id ? ' active' : '')} key={file.id}>
          {naming?.file.id === file.id ? <div className="file-tab-naming">{(() => { const { icon: NamingIcon, colorClass } = fileTypeStyle(naming.value); return <NamingIcon size={13} className={colorClass} /> })()}<input ref={namingInput} className="file-tab-name" aria-label="New file name" value={naming.value} disabled={renaming} onChange={(event) => { const next = { ...naming, value: event.target.value }; namingRef.current = next; setNaming(next) }} onBlur={() => void finishNaming()} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stopNaming(); focusEditor() }
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void finishNaming().then(focusEditor) }
          }} /></div> : <button role="tab" aria-selected={file.id === active.id} title={projects.find((item) => item.id === file.projectId)?.name + ' / ' + file.path + (file.mode === 'browser' ? ' · Open in browser' : '')}
            onClick={() => setState((current) => ({ ...current, activeId: file.id }))} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); void close(file.id) } }} onContextMenu={(event) => showFileMenu(event, file)} data-autoscroll="off">
            {file.mode === 'browser' ? <Globe2 size={13} /> : (() => { const { icon: TabIcon, colorClass } = fileTypeStyle(file.path); return <TabIcon size={13} className={colorClass} /> })()}<span>{file.path.split('/').pop()}</span>{dirtyIds.has(file.id) && <i className="file-dirty-dot" aria-label="Unsaved changes" />}
          </button>}<button className="file-tab-close" aria-label={'Close ' + file.path} onMouseDown={() => { if (namingRef.current?.file.id === file.id) stopNaming() }} onClick={() => void close(file.id)}><X size={12} /></button>
        </div>)}
        <button className="file-new" title="New file" aria-label="New file" disabled={creating || renaming} onClick={() => void createFile()}><Plus size={15} /></button>
      </div>
      {error && <p className="file-create-error" role="alert">{error}</p>}
      <div className="file-view-toolbar"><span title={active.path}>{active.path}</span>
        {([['editor', FileCode2, 'Edit'], ['preview', Eye, 'Preview'], ['browser', Globe2, 'Open in browser']] as const).map(([mode, Icon, label]) => <button key={mode} title={label} aria-label={label} aria-pressed={active.mode === mode} onClick={() => open({ ...active, mode })}><Icon size={14} /></button>)}
      </div>
      <div className="workspace-document-body">
        {state.files.map((file) => {
          const project = projects.find((item) => item.id === file.projectId)
          if (!project) return file.id === active.id ? <p key={file.id}>This project is no longer loaded.</p> : null
          return <div className="file-tab-content" key={file.id} hidden={file.id !== active.id}>
            {file.mode === 'editor' ? <CodePane project={project} tabId={file.id} path={file.path} line={file.line} allowBinary={file.allowBinary} autoFocus={naming?.file.id !== file.id} /> : file.mode === 'browser' ? <FileBrowser project={project} file={file} /> : <FilePreviewPane project={project} path={file.path} onOpenEditor={(path, allowBinary) => open({ projectId: project.id, path, mode: 'editor', allowBinary })} />}
          </div>
        })}
      </div>
    </aside>}
    {picker && <FilePicker projects={projects} activeProjectId={projectId} recentPaths={recentWorkspaceFiles()} showHiddenDefault={showHiddenFilesDefault} onClose={() => setPicker(false)} onPick={(file) => openWorkspaceFile(file.projectId, file.path)} />}
    {menu && createPortal(
      <div className="cursor-context-menu file-tab-context-menu" role="menu" aria-label={'Actions for ' + menu.file.path} style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="context-menu-label">{menu.file.path.split('/').pop()}</div>
        {buildFileLinkMenuEntries().map((entry) => { const Icon = FILE_LINK_MENU_ICONS[entry.action]; return <button key={entry.action} role="menuitem" onClick={() => runFileMenuAction(entry.action, menu.file)}><Icon size={14} /> {entry.label}{entry.shortcut && <span className="context-shortcut">{entry.shortcut}</span>}</button> })}
      </div>,
      document.body
    )}
  </>
}
