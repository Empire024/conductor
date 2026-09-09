import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Link2, Radio, Unlink } from 'lucide-react'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { WorkspaceLayout } from '../../../shared/models'
import { listGroups } from '../layout/layout-operations'
import './AgentControlLinks.css'

export type ControlRect = { x: number; y: number; width: number; height: number }
export type ControlMarker = { id: string; tabId: string; role: 'controller' | 'controlled'; x: number; y: number; color: string; title: string; extra?: number }
/** One orchestrating tab can drive a dozen others at once. Past this many badges a tab header is
 *  just a row of dots, so the last one becomes a "+N" stand-in for the rest. */
const MAX_MARKERS_PER_TAB = 3
const MARKER_PALETTE = ['--accent', '--blue', '--accent-muted']
const hashIndex = (id: string, mod: number): number => { let hash = 0; for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0; return hash % mod }
// Anchors a marker inside the tab header's own rect (top-right corner) so it always sits on tab chrome, never over pane content below it.
export function computeMarkers(links: AgentControlLink[], rectFor: (id: string) => ControlRect | undefined, titleFor: (id: string, remote?: string) => string): ControlMarker[] {
  const placed = new Map<string, number>()
  const anchor = (rect: ControlRect, tabId: string): { x: number; y: number } => { const n = placed.get(tabId) ?? 0; placed.set(tabId, n + 1); return { x: rect.x + rect.width - 6 - n * 10, y: rect.y + 6 } }
  const total = new Map<string, number>()
  for (const link of links) for (const tabId of [link.controllerTabId, link.controlledTabId]) if (rectFor(tabId)) total.set(tabId, (total.get(tabId) ?? 0) + 1)
  const used = new Map<string, number>()
  /** Whether this end still gets its own badge, becomes the "+N" stand-in, or is folded into it. */
  const slotFor = (tabId: string): 'badge' | 'count' | 'none' => {
    const seen = used.get(tabId) ?? 0
    const all = total.get(tabId) ?? 0
    if (all <= MAX_MARKERS_PER_TAB) return 'badge'
    if (seen < MAX_MARKERS_PER_TAB - 1) return 'badge'
    return seen === MAX_MARKERS_PER_TAB - 1 ? 'count' : 'none'
  }
  const end = (tabId: string, rect: ControlRect, role: 'controller' | 'controlled', id: string, color: string, title: string): ControlMarker | null => {
    const slot = slotFor(tabId)
    used.set(tabId, (used.get(tabId) ?? 0) + 1)
    if (slot === 'none') return null
    const point = anchor(rect, tabId)
    const rest = (total.get(tabId) ?? 0) - MAX_MARKERS_PER_TAB + 1
    if (slot === 'count') return { id, tabId, role, x: point.x, y: point.y, color, title: rest + ' more linked tabs', extra: rest }
    return { id, tabId, role, x: point.x, y: point.y, color, title }
  }
  return links.flatMap(link => {
    const from = rectFor(link.controllerTabId), to = rectFor(link.controlledTabId)
    const title = titleFor(link.controllerTabId, link.controllerTitle) + ' controls ' + titleFor(link.controlledTabId, link.controlledTitle)
    const color = MARKER_PALETTE[hashIndex(link.targetAgentSessionId, MARKER_PALETTE.length)] ?? '--accent'
    const markers: ControlMarker[] = []
    if (from) { const marker = end(link.controllerTabId, from, 'controller', link.targetAgentSessionId + ':controller', color, title); if (marker) markers.push(marker) }
    if (to) { const marker = end(link.controlledTabId, to, 'controlled', link.targetAgentSessionId + ':controlled', color, title); if (marker) markers.push(marker) }
    return markers
  })
}
export function AgentControlLinks({ projectId, sessionId, layout }: { projectId: string; sessionId: string; layout: WorkspaceLayout }): React.JSX.Element | null {
  const [links, setLinks] = useState<AgentControlLink[]>([])
  const [expanded, setExpanded] = useState(false)
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
  // A dozen orchestrated coworkers used to stack a dozen full-width rows over the workspace. The
  // list now collapses behind one chip naming who is driving and how many, and even opened it is
  // bounded and scrollable rather than free to grow up the screen.
  const controllers = new Set(relevant.map(link => titleFor(link.controllerTabId, link.controllerTitle)))
  const collapsible = relevant.length > 1
  const summary = controllers.size === 1
    ? [...controllers][0] + ' controls ' + relevant.length + ' tabs'
    : relevant.length + ' control links across ' + controllers.size + ' tabs'
  return <>
    <div className="agent-control-markers" aria-hidden="true">{markers.map(marker => <span key={marker.id} className={'agent-control-marker ' + marker.role} style={{ left: marker.x, top: marker.y, color: 'var(' + marker.color + ')', borderColor: 'var(' + marker.color + ')' }} title={marker.title}>{marker.extra ? <b>+{marker.extra}</b> : marker.role === 'controller' ? <Radio size={8} /> : <Link2 size={8} />}</span>)}</div>
    <div className={'agent-control-links' + (collapsible ? ' collapsible' : '')} role="region" aria-label="Connected agent tabs">
    {collapsible && <button type="button" className="agent-control-summary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <Link2 size={12} aria-hidden="true" /><span>{summary}</span>{expanded ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
    </button>}
    {(!collapsible || expanded) && <div className="agent-control-link-list">{relevant.map(link => <div className="agent-control-link" key={link.targetAgentSessionId}>
      <Link2 size={12} aria-hidden="true" /><button type="button" title="Show controller tab" onClick={() => focus(link.controllerTabId)}>{titleFor(link.controllerTabId, link.controllerTitle)}</button><span>controls</span><button type="button" title="Show controlled tab" onClick={() => focus(link.controlledTabId)}>{titleFor(link.controlledTabId, link.controlledTitle)}</button><button type="button" className="agent-control-release" aria-label={'Disconnect control of ' + titleFor(link.controlledTabId, link.controlledTitle)} title="Disconnect control; running work continues" onClick={() => release(link.targetAgentSessionId)}><Unlink size={12} /></button>
    </div>)}</div>}{error && <small role="alert">{error}</small>}</div>
  </>
}
