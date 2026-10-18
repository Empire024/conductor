import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link2, Radio, Unlink, X } from 'lucide-react'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { WorkspaceLayout } from '../../../shared/models'
import { listGroups } from '../layout/layout-operations'
import './AgentControlLinks.css'

export type ControlRect = { x: number; y: number; width: number; height: number }
export type ControlRole = 'controller' | 'controlled' | 'both'
export type MarkerFit = 'full' | 'short' | 'dot'
export type ControlMarker = { id: string; tabId: string; role: ControlRole; x: number; y: number; color: string; title: string; count: number; main?: boolean; label: string; fit: MarkerFit; maxWidth: number }
export type ControlPopoverPosition = { left: number; top: number; width: number; maxHeight: number }
const MARKER_PALETTE = ['--accent', '--blue', '--accent-muted']
const hashIndex = (id: string, mod: number): number => { let hash = 0; for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0; return hash % mod }
/** A marker keeps this far from both edges of its own tab. */
export const MARKER_INSET = 6
/** The marker is a band along its tab's top edge (AgentControlLinks.css), above the tab's content. */
export const MARKER_HEIGHT = 11
// Rendered width at the 6.5px label font: letters, plus icon, padding, gap and border, plus the count.
const markerWidth = (label: string, counted: boolean): number => label.length * 5.2 + 21 + (counted ? 14 : 0)
/** The widest role label that fits inside a tab this wide: MAIN/COWORKER, then M/C, then a dot.
 *  A full strip shrinks every tab to its minimum, and a marker wider than its tab used to cover
 *  the neighbouring tab's title. */
export function fitMarkerLabel(role: ControlRole, main: boolean | undefined, count: number, tabWidth: number): Pick<ControlMarker, 'label' | 'fit' | 'maxWidth'> {
  const lead = main === false ? 'LEAD' : 'MAIN'
  const full = role === 'controller' ? lead : role === 'controlled' ? 'COWORKER' : `COWORKER · ${lead}`
  const short = role === 'controller' ? lead[0]! : role === 'controlled' ? 'C' : `C·${lead[0]}`
  const maxWidth = Math.max(0, Math.floor(tabWidth - MARKER_INSET * 2))
  const counted = role !== 'controlled' && count > 1
  if (markerWidth(full, counted) <= maxWidth) return { label: full, fit: 'full', maxWidth }
  if (markerWidth(short, counted) <= maxWidth) return { label: short, fit: 'short', maxWidth }
  return { label: '', fit: 'dot', maxWidth }
}
// One labelled relationship marker per tab replaces the old pile of anonymous dots.
export function computeMarkers(links: AgentControlLink[], rectFor: (id: string) => ControlRect | undefined, titleFor: (id: string, remote?: string) => string, mainTabId?: string | null): ControlMarker[] {
  const tabIds = [...new Set(links.flatMap(link => [link.controllerTabId, link.controlledTabId]))]
  return tabIds.flatMap(tabId => {
    const rect = rectFor(tabId)
    if (!rect) return []
    const controlling = links.filter(link => link.controllerTabId === tabId)
    const controlled = links.find(link => link.controlledTabId === tabId)
    const role = controlling.length && controlled ? 'both' as const : controlling.length ? 'controller' as const : 'controlled' as const
    const related = controlling.length ? controlling : controlled ? [controlled] : []
    const count = related.length
    const names = controlling.length
      ? controlling.map(link => titleFor(link.controlledTabId, link.controlledTitle))
      : controlled ? [titleFor(controlled.controllerTabId, controlled.controllerTitle)] : []
    const parentName = controlled ? titleFor(controlled.controllerTabId, controlled.controllerTitle) : undefined
    const ownTitle = titleFor(tabId, controlling[0]?.controllerTitle ?? controlled?.controlledTitle)
    const title = role === 'both'
      ? `${ownTitle} is a coworker controlled by ${parentName ?? 'another coordinating tab'} and is also a main coordinator for ${count} coworker${count === 1 ? '' : 's'}: ${names.join(', ')}`
      : role === 'controller'
      ? `${ownTitle} is the main coordinating tab and controls ${count} coworker${count === 1 ? '' : 's'}: ${names.join(', ')}`
      : `${ownTitle} is a coworker controlled by ${names[0] ?? 'the main coordinating tab'}`
    const identity = related[0]?.targetAgentSessionId ?? tabId
    // One MAIN per workspace (workspace clarity): any other controller leads its own coworkers.
    const main = mainTabId === undefined || mainTabId === tabId
    // Anchored by its right edge and vertical centre (translate(-100%, -50%)): its top edge sits
    // 1px inside the tab, above the title, which .has-control-markers moves down to make room.
    return [{ id: `${tabId}:${role}`, tabId, role, main, x: rect.x + rect.width - MARKER_INSET, y: rect.y + 1 + MARKER_HEIGHT / 2, color: MARKER_PALETTE[hashIndex(identity, MARKER_PALETTE.length)] ?? '--accent', title, count, ...fitMarkerLabel(role, main, count, rect.width) }]
  })
}

/** Keep optional relationship details beside the selected tab marker, including in narrow panes. */
export function computeControlPopoverPosition(marker: Pick<ControlMarker, 'x' | 'y'>, viewport: { width: number; height: number }): ControlPopoverPosition {
  const gutter = 8
  const width = Math.min(360, Math.max(220, viewport.width - gutter * 2))
  const maxHeight = Math.min(300, Math.max(120, viewport.height - gutter * 2))
  return {
    left: Math.max(gutter, Math.min(marker.x - width / 2, viewport.width - width - gutter)),
    top: Math.max(gutter, Math.min(marker.y + 14, viewport.height - maxHeight - gutter)),
    width,
    maxHeight
  }
}
export function AgentControlLinks({ projectId, sessionId, layout, mainTabId }: { projectId: string; sessionId: string; layout: WorkspaceLayout; mainTabId?: string | null }): React.JSX.Element | null {
  const [links, setLinks] = useState<AgentControlLink[]>([])
  const [openMarkerTabId, setOpenMarkerTabId] = useState<string | null>(null)
  const [markers, setMarkers] = useState<ControlMarker[]>([])
  const [error, setError] = useState('')
  const tabs = useMemo(() => listGroups(layout.root).flatMap(group => group.tabs), [layout])
  const identities = tabs.map(tab => tab.id + ':' + (tab.resourceId ?? '')).join('|')
  useEffect(() => {
    let disposed = false, loading = false
    const refresh = async (): Promise<void> => {
      if (loading) return
      loading = true
      try { const next = await window.conductor.agentControl.links(projectId, sessionId); if (!disposed) setLinks(next) }
      catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { loading = false }
    }
    void refresh()
    const off = window.conductor.agentControl.onLinksChanged(scope => { if (scope.projectId === projectId && scope.sessionId === sessionId) void refresh() })
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
    return () => { disposed = true; off(); clearInterval(interval) }
  }, [projectId, sessionId, identities])
  const relevant = links.filter(link => tabs.some(tab => tab.id === link.controllerTabId || tab.id === link.controlledTabId))
  const titleFor = (id: string, remote?: string): string => tabs.find(tab => tab.id === id)?.title ?? remote ?? 'Agent tab'
  useLayoutEffect(() => {
    if (!links.length) { setMarkers([]); return }
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const headers = [...document.querySelectorAll<HTMLElement>('[data-control-tab-id]')]
        const rect = (id: string): ControlRect | undefined => { const node = headers.find(header => header.dataset.controlTabId === id); return node?.getClientRects().length ? node.getBoundingClientRect() : undefined }
        setMarkers(computeMarkers(links, rect, titleFor, mainTabId))
      })
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(document.body)
    document.querySelectorAll('[data-control-tab-id]').forEach(node => observer.observe(node))
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [links, layout, mainTabId])
  const focus = (tabId: string): void => { void window.conductor.agentControl.focusTab(projectId, sessionId, tabId).catch(reason => setError(String(reason))) }
  const release = (id: string): void => { void window.conductor.agentControl.release(id).then(() => { setLinks(current => current.filter(link => link.targetAgentSessionId !== id)); setError('') }).catch(reason => setError(String(reason))) }
  if (!relevant.length) return null
  const openMarker = markers.find(marker => marker.tabId === openMarkerTabId)
  const openLinks = openMarker
    ? relevant.filter(link => link.controllerTabId === openMarker.tabId || link.controlledTabId === openMarker.tabId)
    : []
  const popoverPosition = openMarker
    ? computeControlPopoverPosition(openMarker, { width: window.innerWidth, height: window.innerHeight })
    : undefined
  return <>
    {markers.map(marker => {
      const header = [...document.querySelectorAll<HTMLElement>('[data-control-tab-id]')].find(node => node.dataset.controlTabId === marker.tabId)
      const container = header?.closest<HTMLElement>('.pane-tabs')
      if (!container) return null
      const bounds = container.getBoundingClientRect()
      return createPortal(<button type="button" key={marker.id} data-marker-tab-id={marker.tabId} className={`agent-control-marker ${marker.role} ${marker.fit}`} style={{ left: marker.x - bounds.left + container.scrollLeft, top: marker.y - bounds.top + container.scrollTop, maxWidth: marker.maxWidth, color: 'var(' + marker.color + ')', borderColor: 'var(' + marker.color + ')' }} title={`${marker.title}. Select for relationship details.`} aria-label={`${marker.title}; show relationship details`} aria-expanded={openMarkerTabId === marker.tabId} onClick={() => setOpenMarkerTabId(current => current === marker.tabId ? null : marker.tabId)}>{marker.fit !== 'dot' && <><span aria-hidden="true">{marker.role === 'controlled' ? <Link2 size={8} /> : <Radio size={8} />}</span><b>{marker.label}</b>{marker.role !== 'controlled' && marker.count > 1 && <em>{marker.count}</em>}</>}</button>, container, marker.id)
    })}
    {openMarker && popoverPosition && <div className="agent-control-popover" role="dialog" aria-label={`Agent tab relationships for ${titleFor(openMarker.tabId)}`} style={popoverPosition}>
      <header><Link2 size={12} aria-hidden="true" /><strong>{openMarker.role === 'controller' ? 'Main coordinator' : openMarker.role === 'controlled' ? 'Coworker' : 'Coworker and main coordinator'}</strong><button type="button" aria-label="Close agent tab relationships" title="Close relationship details" onClick={() => setOpenMarkerTabId(null)}><X size={12} /></button></header>
      <div className="agent-control-link-list">{openLinks.map(link => <div className="agent-control-link" key={link.targetAgentSessionId}>
      <em>MAIN</em><button type="button" title="Show main coordinating tab" onClick={() => focus(link.controllerTabId)}>{titleFor(link.controllerTabId, link.controllerTitle)}</button><span>controls</span><em>COWORKER</em><button type="button" title="Show coworker tab" onClick={() => focus(link.controlledTabId)}>{titleFor(link.controlledTabId, link.controlledTitle)}</button><button type="button" className="agent-control-release" aria-label={'Disconnect control of ' + titleFor(link.controlledTabId, link.controlledTitle)} title="Disconnect control; running work continues" onClick={() => release(link.targetAgentSessionId)}><Unlink size={12} /></button>
      </div>)}</div>{error && <small role="alert">{error}</small>}
    </div>}
  </>
}
