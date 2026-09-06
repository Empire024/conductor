import { useEffect, useRef, useState } from 'react'
import { FolderPlus, X } from 'lucide-react'
import type { AppSettings } from '../../../shared/models'

export function CreateProjectDialog({
  settings,
  onClose,
  onCreate
}: {
  settings: AppSettings
  onClose(): void
  onCreate(name: string): Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const create = async (): Promise<void> => {
    if (!name.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      await onCreate(name.trim())
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setCreating(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="create-project-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="dialog-icon"><FolderPlus size={18} /></div>
          <div><strong>Create a project</strong><span>Conductor will create and open its folder.</span></div>
          <button onClick={onClose}><X size={15} /></button>
        </header>
        <label>
          <span>Project name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') onClose()
            }}
            placeholder="My new project"
          />
        </label>
        <div className="project-destination">
          <span>Created inside</span>
          <code>{settings.projectsRoot}</code>
        </div>
        {error && <div className="dialog-error">{error}</div>}
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim() || creating} onClick={() => void create()}>
            {creating ? 'Creating…' : 'Create project'}
          </button>
        </footer>
      </section>
    </div>
  )
}
