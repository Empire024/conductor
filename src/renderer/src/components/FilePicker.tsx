import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, Search } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { fileTypeStyle } from '../file-types'
import { AgentDialog } from '../panes/StructuredAgentRenderers'
import { recentFiles } from './recent-files-store'

export type PickedFile = { projectId: string; path: string }
export function FilePicker({ projects, activeProjectId, recentPaths, showHiddenDefault, onPick, onClose }: { projects: ProjectRecord[]; activeProjectId?: string; recentPaths?: PickedFile[]; showHiddenDefault?: boolean; onPick(file: PickedFile): void; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PickedFile[]>([])
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(() => Boolean(showHiddenDefault))
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const keyboardNavigation = useRef(false)
  const pendingSelection = useRef(0)
  const pendingOpen = useRef(false)
  const ids = projects.map((project) => project.id).join(',')
  useEffect(() => {
    let live = true
    setBusy(true)
    const apply = (files: PickedFile[]): void => {
      if (!live) return
      const index = Math.max(0, Math.min(files.length - 1, pendingSelection.current))
      setResults(files); setSelected(index); setError('')
      if (pendingOpen.current) { pendingOpen.current = false; if (files[index]) { onPick(files[index]!); onClose() } }
    }
    const timer = window.setTimeout(() => {
      // An empty query shows what the user actually opened before, most-recent-first, like VS Code's Go to File.
      if (!query) { apply(recentFiles(ids.split(',').filter(Boolean)).slice(0, 100)); setBusy(false); return }
      void window.conductor.files.search(ids.split(',').filter(Boolean), query, { showHidden, activeProjectId, recentPaths }).then(apply)
        .catch((reason: unknown) => { if (live) { setError(String(reason)); setResults([]); pendingOpen.current = false } }).finally(() => { if (live) setBusy(false) })
    }, query ? 100 : 0)
    return () => { live = false; window.clearTimeout(timer) }
  }, [ids, query, showHidden, activeProjectId])
  useEffect(() => { list.current?.children[selected]?.scrollIntoView({ block: 'nearest' }) }, [selected, results])
  return <AgentDialog title="Open file" onClose={onClose}>
    <div className="file-picker" onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation(); keyboardNavigation.current = true
        const next = Math.max(0, (busy ? pendingSelection.current : selected) + (event.key === 'ArrowDown' ? 1 : -1))
        pendingSelection.current = busy ? next : Math.min(Math.max(0, results.length - 1), next)
        setSelected(Math.min(Math.max(0, results.length - 1), pendingSelection.current))
      }
      if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation()
        if (busy) pendingOpen.current = true
        else if (results[selected]) { onPick(results[selected]!); onClose() }
      }
    }}>
      <label className="file-picker-input"><Search size={17} /><input autoFocus placeholder="Search files in loaded projects…" aria-label="Search files"
        role="combobox" aria-expanded aria-autocomplete="list" aria-controls={listId} aria-activedescendant={results[selected] ? listId + '-' + selected : undefined}
        value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); setBusy(true); pendingSelection.current = 0; pendingOpen.current = false }} />
        <button type="button" className="file-picker-hidden-toggle" title={showHidden ? 'Hide hidden files' : 'Show hidden files'} aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'} aria-pressed={showHidden}
          onMouseDown={(event) => event.preventDefault()} onClick={() => setShowHidden((current) => !current)}>{showHidden ? <Eye size={15} /> : <EyeOff size={15} />}</button><kbd>Ctrl E</kbd></label>
      <div className="file-picker-results" id={listId} role="listbox" aria-label="Files" ref={list} aria-busy={busy}>
        {results.map((file, index) => { const { icon: Icon, colorClass } = fileTypeStyle(file.path); return <button key={file.projectId + ':' + file.path} id={listId + '-' + index} role="option" tabIndex={-1} aria-selected={selected === index}
          className={selected === index ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onMouseMove={(event) => { if (busy) return; if (event.movementX || event.movementY) keyboardNavigation.current = false; if (!keyboardNavigation.current) { pendingSelection.current = index; setSelected(index) } }} onClick={() => { onPick(file); onClose() }}>
          <Icon size={16} className={colorClass} /><span><strong>{file.path.split('/').pop()}</strong><small>{file.path}</small></span><small>{projects.find((project) => project.id === file.projectId)?.name}</small>
        </button> })}
        {!results.length && <p role="status">{error || (busy ? 'Finding files…' : projects.length ? (query ? 'No matching files.' : 'No recently opened files.') : 'Add a project to browse its files.')}</p>}
      </div>
      <footer><span>↑ ↓ to navigate · Enter to open · Esc to close</span><small role="status">{busy && results.length ? 'Updating results…' : query ? 'Up to 100 matches · Dependencies and build folders excluded' : 'Recently opened files'}</small></footer>
    </div>
  </AgentDialog>
}
