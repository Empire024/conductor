import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, MoreHorizontal, TerminalSquare } from 'lucide-react'
import type { PaneTab, SessionRecord } from '../../../shared/models'
import { listGroups } from '../layout/layout-operations'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'
import { PaneTabMenu } from './PaneTabMenu'
import { ProviderIcon } from './ProviderIcon'

export function WorkspaceTabList({ session, active, onAction }: { session: SessionRecord; active: boolean; onAction(groupId: string, tabId: string, action: WorkspaceTabAction): void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(active)
  const [menu, setMenu] = useState<{ x: number; y: number; groupId: string; tab: PaneTab } | null>(null)
  const groups = listGroups(session.layout.root)
  const count = groups.reduce((total, group) => total + group.tabs.length, 0)
  return <div className="workspace-tab-tree" onContextMenu={event => event.stopPropagation()}>
    <button className="workspace-tab-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'List'} tabs in ${session.name}`} onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<span>{count} {count === 1 ? 'tab' : 'tabs'}</span>
    </button>
    {expanded && groups.flatMap(group => group.tabs.map(tab => <div key={tab.id} className={`workspace-tab-row${active && group.activeTabId === tab.id ? ' selected' : ''}`} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, groupId: group.id, tab }) }}>
      <button className="workspace-tab-select" title={tab.title} onClick={() => onAction(group.id, tab.id, 'focus')}>
        {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} size={12} /> : tab.kind === 'terminal' ? <TerminalSquare size={12} /> : <FileText size={12} />}
        <span className="ellipsis">{tab.title}</span>
      </button>
      <button className="workspace-tab-more" aria-label={`${tab.title} tab actions`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right, y: rect.top, groupId: group.id, tab }) }}><MoreHorizontal size={12} /></button>
    </div>))}
    {menu && <PaneTabMenu x={menu.x} y={menu.y} tab={menu.tab} maximized={session.maximizedGroupId === menu.groupId} continuation={menu.tab.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(menu.tab.state.continueOnLimit)} canReopen={session.closedTabs.length > 0} onDismiss={() => setMenu(null)} onAction={action => onAction(menu.groupId, menu.tab.id, action)} />}
  </div>
}
