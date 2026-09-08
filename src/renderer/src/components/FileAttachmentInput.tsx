import { useEffect, useId, useRef, useState } from 'react'
import { File, LoaderCircle, Search, X } from 'lucide-react'
export function FileAttachmentInput({ projectId, value, onChange, onAttach, onClose }: { projectId: string; value: string; onChange(value: string): void; onAttach(path: string): void; onClose(): void }): React.JSX.Element {
  const [paths, setPaths] = useState<string[]>([]), [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null), host = useRef<HTMLDivElement>(null), id = useId()
  const currentQuery = useRef(value); currentQuery.current = value
  const resultsQuery = useRef<string | null>(null)
  const pendingAttach = useRef<string | null>(null)
  const callbacks = useRef({ onAttach, onClose }); callbacks.current = { onAttach, onClose }
  useEffect(() => {
    input.current?.focus()
    const outside = (event: PointerEvent): void => {
      const target = event.target as HTMLElement
      if (!host.current?.contains(target) && !host.current?.parentElement?.querySelector('[aria-label="Attach file context"]')?.contains(target)) callbacks.current.onClose()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    const timer = setTimeout(() => { void window.conductor.files.search([projectId], value).then((files) => {
      if (!live) return
      const next = files.slice(0, 30).map((file) => file.path)
      resultsQuery.current = value; setPaths(next); setSelected(0); setLoading(false)
      if (pendingAttach.current === value) { pendingAttach.current = null; const path = next[0] ?? value.trim(); if (path) callbacks.current.onAttach(path) }
    }).catch((reason: unknown) => { if (live) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); pendingAttach.current = null } }) }, 100)
    return () => { live = false; clearTimeout(timer) }
  }, [projectId, value])
  useEffect(() => { host.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const attach = (): void => {
    if (resultsQuery.current !== currentQuery.current || loading) { pendingAttach.current = currentQuery.current; return }
    const path = paths[selected] ?? value.trim()
    if (path) onAttach(path)
  }
  return <div ref={host} className="sa-file-attachment" role="group" aria-label="Attach file context picker">
    <div className="sa-file-attach"><Search size={14} aria-hidden="true" /><input ref={input} aria-label="Context file path" role="combobox" aria-expanded={true} aria-autocomplete="list"
      aria-controls={id} aria-activedescendant={paths[selected] ? id + '-' + selected : undefined} placeholder="Find a file to attach?" value={value} onChange={(event) => { pendingAttach.current = null; onChange(event.target.value) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((current) => paths.length ? (current + (event.key === 'ArrowDown' ? 1 : paths.length - 1)) % paths.length : 0) }
        if (event.key === 'Enter' || event.key === 'Tab' && paths.length > 0) { event.preventDefault(); event.stopPropagation(); attach() }
      }} />{loading && <LoaderCircle size={13} className="spin" aria-label="Searching files" />}<button type="button" onClick={attach} disabled={!paths.length && !value.trim()}>Attach</button><button type="button" aria-label="Close file picker" onClick={onClose}><X size={13} /></button></div>
    <div className="sa-file-suggestions" role="listbox" aria-label="Matching files" id={id} aria-busy={loading}>{paths.map((path, index) => <button id={id + '-' + index} type="button" role="option" aria-selected={index === selected} key={path}
      onMouseDown={(event) => event.preventDefault()} onPointerMove={() => setSelected(index)} onClick={() => { if (resultsQuery.current === value && !loading) onAttach(path) }}><File size={14} /><span title={path}>{path}</span></button>)}</div>
    {error ? <p role="alert" className="sa-file-picker-status">{error}</p> : !paths.length && <p role="status" className="sa-file-picker-status">{loading ? 'Searching workspace files?' : value ? 'No matching files' : 'This workspace has no files yet'}</p>}
    <small className="sa-file-picker-hint">?? Navigate ? Enter / Tab Attach ? Esc Close</small>
  </div>
}
