import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronsLeftRight, Copy, ExternalLink, FolderPlus, Maximize2, Minus, PanelBottom, PanelLeft, PanelRight, PanelTop, PictureInPicture2, Plus, TimerReset, Trash2, Undo2, X } from 'lucide-react'
import type { PaneTab, TabGroup, TabGroupColor } from '../../../shared/models'
import { TAB_GROUP_COLORS } from '../../../shared/models'
import type { TabGroupAction } from '../layout/tab-groups'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'

/** Shared chrome for the two pane menus: clamped to the viewport, focus on the first item,
 * arrow-key roving, and dismissal on Escape, resize, or a pointer landing outside. */
function MenuShell({ x, y, label, ignoreSelector, onDismiss, children }: {
  x: number; y: number; label: string; ignoreSelector: string
  onDismiss(): void; children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: PointerEvent): void => { if (!menu.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest(ignoreSelector))) onDismiss() }
    const resize = (): void => onDismiss()
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', resize) }
  }, [])
  return createPortal(<div ref={ref} className="conductor-menu cursor-context-menu pane-context-menu" role="menu" aria-label={label} style={{ left: x, top: y, width: 225, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }} onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.stopPropagation(); onDismiss() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }}>{children}</div>, document.body)
}

const colorLabel = (color: TabGroupColor): string => color.charAt(0).toUpperCase() + color.slice(1)

/** Chrome's colour row: nine swatches, the current one ticked. */
function ColorRow({ selected, onPick }: { selected: TabGroupColor; onPick(color: TabGroupColor): void }): React.JSX.Element {
  return (
    <div className="tab-group-color-row" role="group" aria-label="Group colour">
      {TAB_GROUP_COLORS.map(color => (
        <button
          key={color}
          role="menuitemradio"
          aria-checked={color === selected}
          className={`tab-group-swatch ${color === selected ? 'selected' : ''}`}
          data-tab-group-color={color}
          title={colorLabel(color)}
          aria-label={colorLabel(color)}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  )
}

export function PaneTabMenu({ x, y, tab, maximized, continuation, canReopen, groups, onAction, onGroupAction, onDismiss }: {
  x: number; y: number; tab: PaneTab; maximized: boolean; continuation: boolean; canReopen: boolean
  groups: TabGroup[]
  onAction(action: WorkspaceTabAction): void; onGroupAction(action: TabGroupAction): void; onDismiss(): void
}): React.JSX.Element {
  const run = (action: WorkspaceTabAction): void => { onDismiss(); onAction(action) }
  const runGroup = (action: TabGroupAction): void => { onDismiss(); onGroupAction(action) }
  const others = groups.filter(group => group.id !== tab.tabGroupId)
  return (
    <MenuShell x={x} y={y} label={`${tab.title} tab actions`} ignoreSelector=".pane-menu-button" onDismiss={onDismiss}>
      <div className="context-menu-label">{tab.title}</div>
      <button role="menuitem" onClick={() => run('show')}><PictureInPicture2 size={13} /> Show tab</button>
      <button role="menuitem" onClick={() => run('left')}><PanelLeft size={13} /> Split left</button>
      <button role="menuitem" onClick={() => run('right')}><PanelRight size={13} /> Split right</button>
      <button role="menuitem" onClick={() => run('above')}><PanelTop size={13} /> Split above</button>
      <button role="menuitem" onClick={() => run('below')}><PanelBottom size={13} /> Split below</button>
      <div role="separator" />
      <button role="menuitem" onClick={() => runGroup({ kind: 'new-group' })}><FolderPlus size={13} /> Add tab to new group</button>
      {others.map(group => (
        <button key={group.id} role="menuitem" onClick={() => runGroup({ kind: 'join-group', tabGroupId: group.id })}>
          <i className="tab-group-dot" data-tab-group-color={group.color} /> Add to {group.title || 'unnamed group'}
        </button>
      ))}
      {tab.tabGroupId && <button role="menuitem" onClick={() => runGroup({ kind: 'leave-group' })}><Minus size={13} /> Remove from group</button>}
      <div role="separator" />
      <button role="menuitem" onClick={() => run('duplicate')}><Copy size={13} /> Duplicate tab</button>
      <button role="menuitem" onClick={() => run('detach')}><ExternalLink size={13} /> Open as window</button>
      <button role="menuitem" onClick={() => run('maximize')}><Maximize2 size={13} /> {maximized ? 'Restore layout' : 'Maximize tab'}</button>
      {tab.kind === 'agent' && <button role="menuitem" onClick={() => run('continuation')}><TimerReset size={13} /> {continuation ? 'Disable' : 'Enable'} limit continuation</button>}
      <button role="menuitem" disabled={!canReopen} onClick={() => run('reopen')}><Undo2 size={13} /> Retrieve closed tab</button>
      <div role="separator" />
      <button role="menuitem" className="danger" onClick={() => run('close')}><X size={13} /> Close tab</button>
    </MenuShell>
  )
}

/** Right-clicking a group's chip, following Chrome's own group menu: name it, recolour it,
 * add a tab, collapse it, or take the group apart. */
export function TabGroupMenu({ x, y, group, tabCount, onAction, onDismiss }: {
  x: number; y: number; group: TabGroup; tabCount: number
  onAction(action: TabGroupAction): void; onDismiss(): void
}): React.JSX.Element {
  const [title, setTitle] = useState(group.title)
  const run = (action: TabGroupAction): void => { onDismiss(); onAction(action) }
  /** Chrome commits a group's name as you leave the field, not only on Enter. */
  const commit = (): void => {
    if (title.trim() !== group.title) onAction({ kind: 'rename', tabGroupId: group.id, title: title.trim() })
  }
  return (
    <MenuShell x={x} y={y} label={`${group.title || 'Unnamed'} group actions`} ignoreSelector=".tab-group-chip" onDismiss={onDismiss}>
      <div className="context-menu-label">{tabCount} tab{tabCount === 1 ? '' : 's'} in group</div>
      <input
        className="tab-group-name-input"
        value={title}
        placeholder="Name this group"
        aria-label="Group name"
        onChange={event => setTitle(event.target.value)}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') { commit(); onDismiss() }
          if (event.key === 'Escape') onDismiss()
        }}
        onBlur={commit}
      />
      <ColorRow selected={group.color} onPick={color => run({ kind: 'recolor', tabGroupId: group.id, color })} />
      <div role="separator" />
      <button role="menuitem" onClick={() => run({ kind: 'new-tab-in-group', tabGroupId: group.id })}><Plus size={13} /> New tab in group</button>
      <button role="menuitem" onClick={() => run({ kind: 'collapse', tabGroupId: group.id, collapsed: !group.collapsed })}><ChevronsLeftRight size={13} /> {group.collapsed ? 'Expand group' : 'Collapse group'}</button>
      <button role="menuitem" onClick={() => run({ kind: 'ungroup', tabGroupId: group.id })}><Trash2 size={13} /> Ungroup</button>
      <div role="separator" />
      <button role="menuitem" className="danger" onClick={() => run({ kind: 'close-group', tabGroupId: group.id })}><X size={13} /> Close group</button>
    </MenuShell>
  )
}
