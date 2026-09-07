import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Plus, Undo2, X } from 'lucide-react'
import './WorkspaceSessionMenu.css'

export interface WorkspaceSessionMenuProps {
  x: number
  y: number
  canRestore: boolean
  onRename?(): void
  onNew(): void
  onRestore(): void
  onCloseWorkspace?(): void
  onDismiss(): void
}

/** The sidebar and workspace tabs share the same actions and keyboard behavior. */
export function WorkspaceSessionMenu(props: WorkspaceSessionMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(true)
  useEffect(() => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const dismiss = (event: PointerEvent): void => { if (!menu.current?.contains(event.target as Node)) props.onDismiss() }
    const resize = (): void => props.onDismiss()
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', resize); if (restoreFocus.current) focused?.focus() }
  }, [])
  const action = (run: (() => void) | undefined): void => { restoreFocus.current = false; props.onDismiss(); run?.() }
  return createPortal(<div ref={menu} className="conductor-menu workspace-session-menu" role="menu" aria-label="Workspace actions" style={{ left: Math.max(8, Math.min(props.x, window.innerWidth - 252)), top: Math.max(8, Math.min(props.y, window.innerHeight - 180)) }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onDismiss() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }}>
    <button role="menuitem" disabled={!props.onRename} onClick={() => action(props.onRename)}><Pencil size={13} /><span>Rename workspace</span></button>
    <button role="menuitem" onClick={() => action(props.onNew)}><Plus size={13} /><span>New workspace</span></button>
    <button role="menuitem" disabled={!props.canRestore} onClick={() => action(props.onRestore)}><Undo2 size={13} /><span>Bring back workspace</span><kbd>Ctrl Shift Z</kbd></button>
    <div className="workspace-menu-separator" role="separator" />
    <button role="menuitem" disabled={!props.onCloseWorkspace} onClick={() => action(props.onCloseWorkspace)}><X size={13} /><span>Close workspace</span></button>
  </div>, document.body)
}
