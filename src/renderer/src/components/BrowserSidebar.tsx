import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, PanelLeftClose, PictureInPicture2 } from 'lucide-react'
import { projectBrowserViewId } from '../../../shared/browser-view-identity'
import { BrowserPane } from '../panes/BrowserPane'
import { persistBrowserPresentation, savedBrowserPresentation, type BrowserPresentation } from './browser-presentation'

export function BrowserSidebar({ projectId, active = true }: { projectId: string | undefined; active?: boolean }): React.JSX.Element {
  const boundProjectId = projectId?.trim() ?? ''
  const [presentation, setPresentation] = useState<BrowserPresentation>(() => boundProjectId ? savedBrowserPresentation(boundProjectId) : 'pane')
  const wasActive = useRef(false)
  useEffect(() => { setPresentation(boundProjectId ? savedBrowserPresentation(boundProjectId) : 'pane') }, [boundProjectId])
  useEffect(() => window.conductor.browser.onState(state => {
    if (state.projectId !== boundProjectId || state.presentation === presentation) return
    setPresentation(state.presentation)
    persistBrowserPresentation(boundProjectId, state.presentation)
  }), [boundProjectId, presentation])
  useEffect(() => {
    const newlyActive = active && !wasActive.current
    wasActive.current = active
    if (!newlyActive || presentation !== 'background' || !boundProjectId) return
    setPresentation('pane')
    persistBrowserPresentation(boundProjectId, 'pane')
    void window.conductor.browser.present(boundProjectId, 'pane').catch(() => {})
  }, [active, boundProjectId, presentation])
  if (!boundProjectId) return <p className="editor-loading" hidden={!active}>Select a project to open the browser.</p>
  const storageKey = `conductor.browserSidebar.${boundProjectId}`
  const choosePresentation = (next: BrowserPresentation): void => {
    setPresentation(next)
    persistBrowserPresentation(boundProjectId, next)
    void window.conductor.browser.present(boundProjectId, next).catch(error => window.dispatchEvent(new CustomEvent('conductor:toast', { detail: error instanceof Error ? error.message : String(error) })))
  }
  // "Background" is an action, not a trap: choosing Browser from the activity rail brings the
  // existing guest back as a pane without constructing a second browsing session.
  const expanded = active && presentation === 'expanded'
  return (
    <section className={`workspace-sidebar-pane browser-sidebar${expanded ? ' browser-sidebar-expanded' : ''}`} aria-label="Browser" hidden={!active}>
      <header className="workspace-sidebar-title"><span>Browser</span><span className="browser-presentation-actions">
        <button type="button" aria-label={expanded ? 'Collapse browser to left pane' : 'Expand browser across workspace'} title={expanded ? 'Collapse to left pane' : 'Expand across workspace'} onClick={() => choosePresentation(expanded ? 'pane' : 'expanded')}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        <button type="button" aria-label="Detach browser without taking focus" title="Detach browser" onClick={() => choosePresentation('detached')}><PictureInPicture2 size={13} /></button>
        <button type="button" aria-label="Keep browser running in background" title="Keep running in background" onClick={() => { choosePresentation('background'); window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'workspace' })) }}><PanelLeftClose size={13} /></button>
      </span></header>
      <BrowserPane
        projectId={boundProjectId}
        compact
        browserViewId={projectBrowserViewId(boundProjectId) ?? undefined}
        viewportStorageKey={`${storageKey}.viewport`}
        initialUrl={localStorage.getItem(storageKey) || 'http://localhost:3000'}
        visible={active && presentation !== 'background' && presentation !== 'detached'}
        presentation={presentation}
        onUrlChange={(url) => localStorage.setItem(storageKey, url)}
      />
    </section>
  )
}
