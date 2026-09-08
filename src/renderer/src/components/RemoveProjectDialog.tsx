import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Trash2, X } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'

export function RemoveProjectDialog({ project, onRemove, onDismiss }: { project: ProjectRecord; onRemove(): Promise<void>; onDismiss(): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  return createPortal(<div className="dialog-backdrop project-remove-backdrop" onMouseDown={() => { if (!busy) onDismiss() }}>
    <section ref={ref} className="project-remove-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-project-title" aria-describedby="remove-project-description" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onDismiss() }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        if (!buttons.length) { event.preventDefault(); return }
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
      }
    }}>
      <header><FolderOpen size={18} /><strong id="remove-project-title">Remove {project.name}?</strong><button aria-label="Cancel removal" disabled={busy} onClick={onDismiss}><X size={15} /></button></header>
      <p id="remove-project-description">Remove this project and its workspaces from Conductor. Your files stay on disk and you can open the folder again later.</p>
      <code>{project.path}</code>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <footer><button disabled={busy} onClick={onDismiss}>Cancel</button><button className="danger" disabled={busy} onClick={() => {
        setBusy(true); setError(''); void onRemove().then(onDismiss).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) })
      }}><Trash2 size={13} />{busy ? 'Removing…' : 'Remove project'}</button></footer>
    </section>
  </div>, document.body)
}
