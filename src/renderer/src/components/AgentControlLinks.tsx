import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link2, Unlink } from 'lucide-react'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { WorkspaceLayout } from '../../../shared/models'
import { listGroups } from '../layout/layout-operations'
import './AgentControlLinks.css'

type Path = { id: string; path: string; x: number; y: number; title: string }
export function AgentControlLinks({ projectId, sessionId, layout }: { projectId: string; sessionId: string; layout: WorkspaceLayout }): React.JSX.Element | null {
  const [links, setLinks] = useState<AgentControlLink[]>([])
  const [paths, setPaths] = useState<Path[]>([])
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
    if (!links.length) { setPaths([]); return }
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const headers = [...document.querySelectorAll<HTMLElement>('[data-control-tab-id]')]
        const rect = (id: string): DOMRect | undefined => { const node = headers.find(header => header.dataset.controlTabId === id); return node?.getClientRects().length ? node.getBoundingClientRect() : undefined }
        setPaths(links.flatMap(link => {
          const from = rect(link.controllerTabId), to = rect(link.controlledTabId)
          if (!from || !to) return []
          const x1 = from.x + from.width / 2, x2 = to.x + to.width / 2, y1 = from.bottom - 2, y2 = to.bottom - 2
          const bend = Math.min(38, 12 + Math.abs(x2 - x1) / 8)
          return [{ id: link.targetAgentSessionId, path: 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + bend) + ', ' + x2 + ' ' + (y2 + bend) + ', ' + x2 + ' ' + y2, x: x2, y: y2, title: titleFor(link.controllerTabId, link.controllerTitle) + ' controls ' + titleFor(link.controlledTabId, link.controlledTitle) }]
        }))
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
  return <>
    <svg className="agent-control-cables" aria-label="Agent control connections">{paths.map(path => <g key={path.id}><title>{path.title}</title><path d={path.path} /><circle cx={path.x} cy={path.y} r="3" /></g>)}</svg>
    <div className="agent-control-links" role="region" aria-label="Connected agent tabs">{relevant.map(link => <div className="agent-control-link" key={link.targetAgentSessionId}>
      <Link2 size={12} aria-hidden="true" /><button type="button" title="Show controller tab" onClick={() => focus(link.controllerTabId)}>{titleFor(link.controllerTabId, link.controllerTitle)}</button><span>controls</span><button type="button" title="Show controlled tab" onClick={() => focus(link.controlledTabId)}>{titleFor(link.controlledTabId, link.controlledTitle)}</button><button type="button" className="agent-control-release" aria-label={'Disconnect control of ' + titleFor(link.controlledTabId, link.controlledTitle)} title="Disconnect control; running work continues" onClick={() => release(link.targetAgentSessionId)}><Unlink size={12} /></button>
    </div>)}{error && <small role="alert">{error}</small>}</div>
  </>
}
