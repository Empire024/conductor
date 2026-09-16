import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link2, Radio, Unlink, X } from 'lucide-react'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { WorkspaceLayout } from '../../../shared/models'
import { listGroups } from '../layout/layout-operations'
import './AgentControlLinks.css'

export type ControlRect = { x: number; y: number; width: number; height: number }
export type ControlMarker = { id: string; tabId: string; role: 'controller' | 'controlled' | 'both'; x: number; y: number; color: string; title: string; count: number }
export type ControlPopoverPosition = { left: number; top: number; width: number; maxHeight: number }
const MARKER_PALETTE = ['--accent', '--blue', '--accent-muted']
const hashIndex = (id: string, mod: number): number => { let hash = 0; for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0; return hash % mod }
// One labelled relationship marker per tab replaces the old pile of anonymous dots.
export function computeMarkers(links: AgentControlLink[], rectFor: (id: string) => ControlRect | undefined, titleFor: (id: string, remote?: string) => string): ControlMarker[] {
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
    return [{ id: `${tabId}:${role}`, tabId, role, x: rect.x + rect.width - 8, y: rect.y + 7, color: MARKER_PALETTE[hashIndex(identity, MARKER_PALETTE.length)] ?? '--accent', title, count }]
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
export function AgentControlLinks({ projectId, sessionId, layout }: { projectId: string; sessionId: string; layout: WorkspaceLayout }): React.JSX.Element | null {
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
        setMarkers(computeMarkers(links, rect, titleFor))
      })
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(document.body)
    document.querySelectorAll('[data-control-tab-id]').forEach(node => observer.observe(node))
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [links, layout])
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
    <div className="agent-control-markers" aria-label="Agent tab relationships">{markers.map(marker => <button type="button" key={marker.id} className={'agent-control-marker ' + marker.role} style={{ left: marker.x, top: marker.y, color: 'var(' + marker.color + ')', borderColor: 'var(' + marker.color + ')' }} title={`${marker.title}. Select for relationship details.`} aria-label={`${marker.title}; show relationship details`} aria-expanded={openMarkerTabId === marker.tabId} onClick={() => setOpenMarkerTabId(current => current === marker.tabId ? null : marker.tabId)}><span aria-hidden="true">{marker.role === 'controlled' ? <Link2 size={8} /> : <Radio size={8} />}</span><b>{marker.role === 'controller' ? 'MAIN' : marker.role === 'controlled' ? 'COWORKER' : 'COWORKER · MAIN'}</b>{marker.role !== 'controlled' && marker.count > 1 && <em>{marker.count}</em>}</button>)}</div>
    {openMarker && popoverPosition && <div className="agent-control-popover" role="dialog" aria-label={`Agent tab relationships for ${titleFor(openMarker.tabId)}`} style={popoverPosition}>
      <header><Link2 size={12} aria-hidden="true" /><strong>{openMarker.role === 'controller' ? 'Main coordinator' : openMarker.role === 'controlled' ? 'Coworker' : 'Coworker and main coordinator'}</strong><button type="button" aria-label="Close agent tab relationships" title="Close relationship details" onClick={() => setOpenMarkerTabId(null)}><X size={12} /></button></header>
      <div className="agent-control-link-list">{openLinks.map(link => <div className="agent-control-link" key={link.targetAgentSessionId}>
      <em>MAIN</em><button type="button" title="Show main coordinating tab" onClick={() => focus(link.controllerTabId)}>{titleFor(link.controllerTabId, link.controllerTitle)}</button><span>controls</span><em>COWORKER</em><button type="button" title="Show coworker tab" onClick={() => focus(link.controlledTabId)}>{titleFor(link.controlledTabId, link.controlledTitle)}</button><button type="button" className="agent-control-release" aria-label={'Disconnect control of ' + titleFor(link.controlledTabId, link.controlledTitle)} title="Disconnect control; running work continues" onClick={() => release(link.targetAgentSessionId)}><Unlink size={12} /></button>
      </div>)}</div>{error && <small role="alert">{error}</small>}
    </div>}
  </>
}
