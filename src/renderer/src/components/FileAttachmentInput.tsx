import { useEffect, useId, useRef, useState } from 'react'
import { File } from 'lucide-react'
export function FileAttachmentInput({ projectId, value, onChange, onAttach, onClose }: { projectId: string; value: string; onChange(value: string): void; onAttach(path: string): void; onClose(): void }): React.JSX.Element {
  const [paths, setPaths] = useState<string[]>([]), [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null), id = useId()
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => { void window.conductor.files.search([projectId], value).then((files) => { if (live) { setPaths(files.slice(0, 8).map((file) => file.path)); setSelected(0) } }).catch(() => { if (live) setPaths([]) }) }, 100)
    return () => { live = false; clearTimeout(timer) }
  }, [projectId, value])
  return <div className="sa-file-attachment">
    <div className="sa-file-attach"><input ref={input} aria-label="Context file path" role="combobox" aria-expanded={paths.length > 0} aria-autocomplete="list"
      aria-controls={id} aria-activedescendant={paths[selected] ? id + '-' + selected : undefined} placeholder="Find a file to attach…" value={value} onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((current) => Math.max(0, Math.min(paths.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))) }
        if (event.key === 'Enter') { event.preventDefault(); onAttach(paths[selected] ?? value) }
      }} /><button type="button" onClick={() => onAttach(paths[selected] ?? value)}>Attach</button></div>
    {paths.length > 0 && <div className="sa-file-suggestions" role="listbox" aria-label="Matching files" id={id}>{paths.map((path, index) => <button id={id + '-' + index} type="button" role="option" aria-selected={index === selected} key={path}
      onMouseDown={(event) => event.preventDefault()} onClick={() => onAttach(path)}><File size={12} /><span>{path}</span></button>)}</div>}
  </div>
}
