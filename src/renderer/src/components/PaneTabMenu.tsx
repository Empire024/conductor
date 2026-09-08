import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Copy, ExternalLink, Maximize2, PanelBottom, PanelLeft, PanelRight, PanelTop, PictureInPicture2, TimerReset, Undo2, X } from 'lucide-react'
import type { PaneTab } from '../../../shared/models'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'

export function PaneTabMenu({ x, y, tab, maximized, continuation, canReopen, onAction, onDismiss }: {
  x: number; y: number; tab: PaneTab; maximized: boolean; continuation: boolean; canReopen: boolean
  onAction(action: WorkspaceTabAction): void; onDismiss(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: PointerEvent): void => { if (!menu.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.pane-menu-button'))) onDismiss() }
    const resize = (): void => onDismiss()
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', resize) }
  }, [])
  const run = (action: WorkspaceTabAction): void => { onDismiss(); onAction(action) }
  return createPortal(<div ref={ref} className="conductor-menu cursor-context-menu pane-context-menu" role="menu" aria-label={`${tab.title} tab actions`} style={{ left: x, top: y, width: 225, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }} onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.stopPropagation(); onDismiss() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }}>
    <div className="context-menu-label">{tab.title}</div>
    <button role="menuitem" onClick={() => run('show')}><PictureInPicture2 size={13} /> Show tab</button>
    <button role="menuitem" onClick={() => run('left')}><PanelLeft size={13} /> Split left</button>
    <button role="menuitem" onClick={() => run('right')}><PanelRight size={13} /> Split right</button>
    <button role="menuitem" onClick={() => run('above')}><PanelTop size={13} /> Split above</button>
    <button role="menuitem" onClick={() => run('below')}><PanelBottom size={13} /> Split below</button>
    <div role="separator" />
    <button role="menuitem" onClick={() => run('duplicate')}><Copy size={13} /> Duplicate tab</button>
    <button role="menuitem" onClick={() => run('detach')}><ExternalLink size={13} /> Open as window</button>
    <button role="menuitem" onClick={() => run('maximize')}><Maximize2 size={13} /> {maximized ? 'Restore layout' : 'Maximize tab'}</button>
    {tab.kind === 'agent' && <button role="menuitem" onClick={() => run('continuation')}><TimerReset size={13} /> {continuation ? 'Disable' : 'Enable'} limit continuation</button>}
    <button role="menuitem" disabled={!canReopen} onClick={() => run('reopen')}><Undo2 size={13} /> Retrieve closed tab</button>
    <div role="separator" />
    <button role="menuitem" className="danger" onClick={() => run('close')}><X size={13} /> Close tab</button>
  </div>, document.body)
}
