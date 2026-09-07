import { useEffect, useId, useRef, useState } from 'react'
import { File, Search } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { AgentDialog } from '../panes/StructuredAgentRenderers'

export type PickedFile = { projectId: string; path: string }
export function FilePicker({ projects, onPick, onClose }: { projects: ProjectRecord[]; onPick(file: PickedFile): void; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PickedFile[]>([])
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const keyboardNavigation = useRef(false)
  const pendingSelection = useRef(0)
  const ids = projects.map((project) => project.id).join(',')
  useEffect(() => {
    let live = true
    setBusy(true)
    const timer = window.setTimeout(() => {
      void window.conductor.files.search(ids.split(',').filter(Boolean), query).then((files) => {
        if (!live) return
        setResults(files); setSelected(Math.max(0, Math.min(files.length - 1, pendingSelection.current))); setError('')
      }).catch((reason: unknown) => { if (live) { setError(String(reason)); setResults([]) } }).finally(() => { if (live) setBusy(false) })
    }, query ? 100 : 0)
    return () => { live = false; window.clearTimeout(timer) }
  }, [ids, query])
  useEffect(() => { list.current?.children[selected]?.scrollIntoView({ block: 'nearest' }) }, [selected, results])
  return <AgentDialog title="Open file" onClose={onClose}>
    <div className="file-picker" onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation(); keyboardNavigation.current = true
        const next = Math.max(0, (busy && !results.length ? pendingSelection.current : selected) + (event.key === 'ArrowDown' ? 1 : -1))
        pendingSelection.current = busy && !results.length ? next : Math.min(Math.max(0, results.length - 1), next)
        setSelected(pendingSelection.current)
      }
      if (event.key === 'Enter' && results[selected]) { event.preventDefault(); event.stopPropagation(); onPick(results[selected]!); onClose() }
    }}>
      <label className="file-picker-input"><Search size={17} /><input autoFocus placeholder="Search files in loaded projects…" aria-label="Search files"
        role="combobox" aria-expanded aria-autocomplete="list" aria-controls={listId} aria-activedescendant={results[selected] ? listId + '-' + selected : undefined}
        value={query} onChange={(event) => { setQuery(event.target.value); setResults([]); setSelected(0); setBusy(true); pendingSelection.current = 0 }} /><kbd>Ctrl E</kbd></label>
      <div className="file-picker-results" id={listId} role="listbox" aria-label="Files" ref={list} aria-busy={busy}>
        {results.map((file, index) => <button key={file.projectId + ':' + file.path} id={listId + '-' + index} role="option" tabIndex={-1} aria-selected={selected === index}
          className={selected === index ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onMouseMove={(event) => { if (event.movementX || event.movementY) keyboardNavigation.current = false; if (!keyboardNavigation.current) { pendingSelection.current = index; setSelected(index) } }} onClick={() => { onPick(file); onClose() }}>
          <File size={16} /><span><strong>{file.path.split('/').pop()}</strong><small>{file.path}</small></span><small>{projects.find((project) => project.id === file.projectId)?.name}</small>
        </button>)}
        {!results.length && <p role="status">{error || (busy ? 'Finding files…' : projects.length ? 'No matching files.' : 'Add a project to browse its files.')}</p>}
      </div>
      <footer><span>↑ ↓ to navigate · Enter to open · Esc to close</span><small>Up to 100 matches · Dependencies and build folders excluded</small></footer>
    </div>
  </AgentDialog>
}
