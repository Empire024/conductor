import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { ComposerStarterChoice } from './composer-starters'

export function ComposerStarterMenu({ choices, disabled, loading, onOpen, onPrepare }: { choices: ComposerStarterChoice[]; disabled: boolean; loading: boolean; onOpen(): void; onPrepare(choice: ComposerStarterChoice): void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  const toggle = (): void => {
    if (disabled) return
    setOpen(value => {
      if (!value) onOpen()
      return !value
    })
  }
  return <div ref={host} className="sa-starter-control">
    <button type="button" aria-label="Composer helpers" title="Starter workflows and configured skills" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}><Sparkles size={14} /><ChevronDown size={10} /></button>
    {open && <div className="sa-starter-menu" role="menu" aria-label="Composer helpers">
      <header><Sparkles size={13} /><span>Prepare a draft</span>{loading && <small>Discovering configured skills…</small>}</header>
      <p>Nothing is sent and your model and permissions stay unchanged.</p>
      {choices.map((choice, index) => <button type="button" role="menuitem" key={choice.id} onClick={() => { onPrepare(choice); setOpen(false) }}>
        <span><strong>{choice.label}</strong><small>{choice.description}</small></span><em>{choice.kind === 'starter' ? 'Built in' : choice.kind === 'configured-skill' ? 'Skill' : 'Command'}</em>
        {index === 0 && <kbd>Recommended</kbd>}
      </button>)}
    </div>}
  </div>
}
