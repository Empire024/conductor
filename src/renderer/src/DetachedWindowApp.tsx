import { ProjectBacklogPane } from './components/ProjectBacklogPane'
import { ListTodo } from 'lucide-react'
import { AppVersionButton } from './components/AppVersionButton'
import { WorkspaceFiles } from './components/WorkspaceFiles'
import { openWorkspaceFile } from './components/workspace-files-state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Bot, Braces, ExternalLink, FolderGit2, Gauge, LayoutGrid, MemoryStick, PanelLeft, PanelLeftOpen, PanelRight, Workflow, X } from 'lucide-react'
import type { AppSettings, DetachedWindowRecord, PaneKind, PaneTab, ProjectRecord, SessionRecord, WorkspaceLayout } from '../../shared/models'
import { makeLauncherTab } from '../../shared/models'
import { TitleBar } from './components/TitleBar'
import { PaneWorkspace } from './layout/PaneWorkspace'
import { activateTab, addTab, closeTab, findGroup, listGroups, stripWorkspaceUtilityTabs } from './layout/layout-operations'
import { createPaneTab } from './panes/pane-factory'
import { MemoryPane } from './panes/MemoryPane'
import { ProcessDashboardPane } from './panes/ProcessDashboardPane'
import { OrchestrationHub } from './components/OrchestrationHub'
import type { WorkspacePanel } from './components/Sidebar'
import { applyAppTheme, resolveThemeVariant } from './appearance'
import { migrateLegacyCodexModels } from './agent-models'
import { useAppUpdates } from './use-app-updates'
import { AppUpdateButton, isUpdateActionVisible } from './components/AppUpdateButton'

interface DetachedBundle {
  record: DetachedWindowRecord
  project: ProjectRecord
  session: SessionRecord
}

export function DetachedWindowApp({ detachedId }: { detachedId: string }): React.JSX.Element {
  useEffect(() => {
    const restore = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return
      event.preventDefault(); event.stopPropagation(); void window.conductor.sessions.restore().catch((error: unknown) => window.dispatchEvent(new CustomEvent('conductor:toast', { detail: String(error) })))
    }
    window.addEventListener('keydown', restore, true)
    return () => window.removeEventListener('keydown', restore, true)
  }, [])
  const [loadedProjects, setLoadedProjects] = useState<ProjectRecord[]>([])
  useEffect(() => { const refresh = (): void => { void window.conductor.projects.list().then(setLoadedProjects) }; refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh) }, [])
  const [bundle, setBundle] = useState<DetachedBundle | null>(null)
  const [layout, setLayout] = useState<WorkspaceLayout | null>(null)
  const [maximizedGroupId, setMaximizedGroupId] = useState<string | null>(null)
  const [focusedGroupId, setFocusedGroupId] = useState('')
  const [closedTabs, setClosedTabs] = useState<PaneTab[]>([])
  const [settings, setSettings] = useState<AppSettings>(() => window.conductor.settings.getStartup())
  const [contextSidebarOpen, setContextSidebarOpen] = useState(false)
  const [utilityPanel, setUtilityPanel] = useState<WorkspacePanel | null>(null)
  const [utilitySide, setUtilitySide] = useState<'left' | 'right'>(() =>
    localStorage.getItem('conductor.utilitySide') === 'left' ? 'left' : 'right'
  )
  const [utilityDragging, setUtilityDragging] = useState(false)
  const [utilityDockPreview, setUtilityDockPreview] = useState<'left' | 'right' | null>(null)
  const layoutRef = useRef<WorkspaceLayout | null>(layout)
  const maximizedGroupIdRef = useRef<string | null>(maximizedGroupId)
  const checkpointTimerRef = useRef<number | null>(null)
  const { updateState, runUpdateAction, checkForUpdates } = useAppUpdates()
  layoutRef.current = layout
  maximizedGroupIdRef.current = maximizedGroupId

  useEffect(() => {
    void Promise.all([window.conductor.window.getDetached(detachedId), window.conductor.settings.get()]).then(([loaded, appSettings]) => {
      setSettings(appSettings)
      if (!loaded) return
      const codingLayout = migrateLegacyCodexModels(stripWorkspaceUtilityTabs(loaded.record.layout))
      setBundle(loaded)
      setLayout(codingLayout)
      setMaximizedGroupId(loaded.record.maximizedGroupId)
      setFocusedGroupId(listGroups(codingLayout.root)[0]?.id ?? '')
      if (codingLayout !== loaded.record.layout) {
        void window.conductor.window.saveDetached(detachedId, codingLayout, loaded.record.maximizedGroupId)
      }
    })
  }, [detachedId])

  useEffect(() => {
    const apply = (): void => {
      applyAppTheme(settings)
    }
    apply()
    const timer = window.setInterval(apply, 60_000)
    return () => window.clearInterval(timer)
  }, [settings.themeAuto, settings.themeId, settings.themeVariant])

  useEffect(() => {
    const focus = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; sessionId: string }>).detail
      const current = layoutRef.current
      const group = current && listGroups(current.root).find(group => group.tabs.some(tab => tab.resourceId === detail.id))
      const tab = group?.tabs.find(tab => tab.resourceId === detail.id)
      if (current && group && tab) { setLayout(activateTab(current, group.id, tab.id)); setFocusedGroupId(group.id); setUtilityPanel(null) }
      else window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'This agent is in another workspace window.' }))
    }
    window.addEventListener('conductor:focus-process', focus)
    return () => window.removeEventListener('conductor:focus-process', focus)
  }, [])

  useEffect(() => {
    if (!layout) return
    if (checkpointTimerRef.current !== null) window.clearTimeout(checkpointTimerRef.current)
    checkpointTimerRef.current = window.setTimeout(() => {
      checkpointTimerRef.current = null
      void window.conductor.window.saveDetached(detachedId, layout, maximizedGroupId)
    }, 100)
  }, [detachedId, layout, maximizedGroupId])

  useEffect(() => {
    const flush = (): void => {
      if (!layoutRef.current) return
      if (checkpointTimerRef.current !== null) {
        window.clearTimeout(checkpointTimerRef.current)
        checkpointTimerRef.current = null
      }
      window.conductor.window.flushDetached(detachedId, layoutRef.current, maximizedGroupIdRef.current)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribeUpdate = window.conductor.updates.onPrepareInstall(({ requestId }) => {
      flush()
      window.conductor.updates.acknowledgePrepare(requestId)
    })
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribeUpdate()
      flush()
    }
  }, [detachedId])

  const detachAgain = useCallback((groupId: string, tab: PaneTab): void => {
    if (!bundle || !layout) return
    const result = closeTab(layout, groupId, tab.id)
    if (!result.closed) return
    setLayout(result.layout)
    void window.conductor.window.detach(bundle.project.id, bundle.session.id, result.closed)
  }, [bundle, layout])

  const openTab = useCallback((kind: PaneKind): void => {
    if (!layout) return
    if (!['launcher', 'agent', 'terminal'].includes(kind)) return
    const group = findGroup(layout.root, focusedGroupId) ?? listGroups(layout.root)[0]
    if (!group) return
    const tab = kind === 'launcher' ? makeLauncherTab() : createPaneTab(kind)
    setLayout(addTab(layout, group.id, tab))
    setFocusedGroupId(group.id)
    setUtilityPanel(null)
  }, [focusedGroupId, layout])

  const moveUtility = useCallback((side: 'left' | 'right'): void => {
    const apply = (): void => {
      setUtilitySide(side)
      localStorage.setItem('conductor.utilitySide', side)
    }
    const transitionDocument = document as Document & {
      startViewTransition?: (update: () => void) => { finished: Promise<void> }
    }
    if (transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(() => flushSync(apply))
    } else apply()
  }, [])

  if (!bundle || !layout) {
    return <div className="detached-loading"><ExternalLink size={24} /><span>Restoring window…</span></div>
  }

  return (
    <div className="app-shell detached-shell">
      <TitleBar
        projectName={bundle.project.name}
        themeVariant={resolveThemeVariant(settings)}
        themeAuto={settings.themeAuto}
        themeId={settings.themeId}
        onTheme={(id) => void window.conductor.settings.setTheme(id).then(setSettings)}
        onThemeAuto={(enabled) => void window.conductor.settings.setThemeAuto(enabled).then(setSettings)}
        onThemeVariant={(themeVariant) => {
          setSettings((current) => ({ ...current, themeAuto: false, themeVariant }))
          void (async () => {
            if (settings.themeAuto) await window.conductor.settings.setThemeAuto(false)
            setSettings(await window.conductor.settings.setThemeVariant(themeVariant))
          })()
        }}
        onNewTab={() => openTab('launcher')}
        updateState={updateState}
      />
      <div className="detached-body">
        <nav className="activity-rail detached-activity-rail" aria-label="Window menu">
          <div className="rail-primary">
            <button
              className={!utilityPanel && contextSidebarOpen ? 'active' : ''}
              title="Workspace"
              aria-label="Workspace"
              onClick={() => {
                setUtilityPanel(null)
                setContextSidebarOpen((current) => utilityPanel ? true : !current)
              }}
            ><LayoutGrid size={18} /></button>
            <button title="New agent or tool tab" aria-label="New agent or tool tab" onClick={() => openTab('launcher')}><Bot size={18} /></button>
            <button title="Project tasks" aria-label="Project tasks" className={utilityPanel === 'backlog' ? 'active' : ''} onClick={() => setUtilityPanel(current => current === 'backlog' ? null : 'backlog')}><ListTodo size={18} /></button>
            <button className={utilityPanel === 'memory' ? 'active' : ''} title="Memory" aria-label="Memory" onClick={() => setUtilityPanel((current) => current === 'memory' ? null : 'memory')}><MemoryStick size={18} /></button>
            <button className={utilityPanel === 'processes' ? 'active' : ''} title="Processes" aria-label="Processes" onClick={() => setUtilityPanel((current) => current === 'processes' ? null : 'processes')}><Gauge size={18} /></button>
          </div>
          <div className="rail-bottom">
            <button title={contextSidebarOpen ? 'Close workspace sidebar' : 'Open workspace sidebar'} aria-label={contextSidebarOpen ? 'Close workspace sidebar' : 'Open workspace sidebar'} onClick={() => setContextSidebarOpen((current) => !current)}><PanelLeftOpen size={18} /></button>
          </div>
        </nav>
        {contextSidebarOpen && (
          <aside className="detached-context-sidebar">
            <header><span>Workspace</span><button onClick={() => setContextSidebarOpen(false)} title="Close sidebar"><X size={17} /></button></header>
            <section>
              <div className="detached-project-mark"><FolderGit2 size={18} /></div>
              <strong>{bundle.project.name}</strong>
              <span>{bundle.session.name}</span>
              <small title={bundle.project.path}>{bundle.project.path}</small>
            </section>
            <div className="detached-sidebar-actions">
              <button onClick={() => openTab('launcher')}><Bot size={16} /><span><strong>Agent or tool</strong><small>Open a new tab</small></span></button>
              <button onClick={() => { setUtilityPanel('agents'); setContextSidebarOpen(false) }}><Bot size={16} /><span><strong>Automation</strong><small>Agents, tasks, and reusable routines</small></span></button>
              <button onClick={() => { setUtilityPanel('memory'); setContextSidebarOpen(false) }}><MemoryStick size={16} /><span><strong>Memory</strong><small>Workspace drawer</small></span></button>
              <button onClick={() => { setUtilityPanel('processes'); setContextSidebarOpen(false) }}><Gauge size={16} /><span><strong>Processes</strong><small>Workspace drawer</small></span></button>
            </div>
          </aside>
        )}
        <main className={`detached-stage workspace-content-shell utility-${utilitySide} ${utilityPanel ? 'has-utility' : ''} ${utilityDragging ? 'utility-is-dragging' : ''}`}>
          <div className="workspace-content-main runtime-document-stage">
            <PaneWorkspace
              layout={layout}
              project={bundle.project}
              session={bundle.session}
              focusedGroupId={focusedGroupId}
              maximizedGroupId={maximizedGroupId}
              onLayout={setLayout}
              onFocus={setFocusedGroupId}
              onMaximize={setMaximizedGroupId}
              onClosed={(tab) => setClosedTabs((current) => [...current, tab].slice(-20))}
              onDetach={detachAgain}
              onOpenFile={(path, line) => openWorkspaceFile(bundle.project.id, path, 'editor', line)}
              canReopen={closedTabs.length > 0}
              onReopen={(groupId) => {
                const tab = closedTabs.at(-1)
                const group = findGroup(layout.root, groupId) ?? listGroups(layout.root)[0]
                if (!tab || !group) return
                setLayout(addTab(layout, group.id, tab))
                setClosedTabs((current) => current.slice(0, -1))
              }}
            />
            <WorkspaceFiles key={detachedId} projects={loadedProjects} projectId={bundle.project.id} workspaceId={'detached:' + detachedId} />
          </div>
          {utilityPanel && (
            <aside className={`workspace-utility-drawer detached-utility-drawer utility-${utilitySide} ${['agents', 'tasks', 'routines'].includes(utilityPanel) ? 'orchestration-drawer' : ''}`}>
              <header
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('application/x-conductor-utility', utilityPanel)
                  setUtilityDragging(true)
                  setUtilityDockPreview(utilitySide)
                }}
                onDragEnd={() => {
                  setUtilityDragging(false)
                  setUtilityDockPreview(null)
                }}
                title="Drag to dock this view on the left or right"
              >
                <div>
                  {utilityPanel === 'memory' ? <MemoryStick size={19} /> : utilityPanel === 'processes' ? <Gauge size={19} /> : utilityPanel === 'routines' ? <Workflow size={19} /> : <Bot size={19} />}
                  <span><strong>{utilityPanel === 'backlog' ? 'Project tasks' : utilityPanel === 'memory' ? 'Project memory' : utilityPanel === 'processes' ? 'Processes' : utilityPanel === 'routines' ? 'Routines' : 'Agents & tasks'}</strong><small>Drag this header to dock left or right</small></span>
                </div>
                <div className="utility-header-actions">
                  <button onClick={() => moveUtility(utilitySide === 'right' ? 'left' : 'right')} title={`Move to ${utilitySide === 'right' ? 'left' : 'right'} side`}>
                    {utilitySide === 'right' ? <PanelLeft size={18} /> : <PanelRight size={18} />}
                  </button>
                  <button onClick={() => setUtilityPanel(null)} title="Close workspace view"><X size={18} /></button>
                </div>
              </header>
              <div className="workspace-utility-content">
                {utilityPanel === 'backlog'
                  ? <ProjectBacklogPane key={bundle.project.id} project={bundle.project} />
                  : utilityPanel === 'memory'
                  ? <MemoryPane project={bundle.project} />
                  : utilityPanel === 'processes'
                    ? <ProcessDashboardPane project={bundle.project} />
                    : <OrchestrationHub key={utilityPanel} projectId={bundle.project.id} initialView={utilityPanel} />}
              </div>
            </aside>
          )}
          {utilityDragging && (['left', 'right'] as const).map((side) => (
            <div
              key={side}
              className={`utility-dock-target utility-dock-${side} ${utilityDockPreview === side ? 'active' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault()
                setUtilityDockPreview(side)
                if (side !== utilitySide) moveUtility(side)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                event.preventDefault()
                moveUtility(side)
                setUtilityDragging(false)
                setUtilityDockPreview(null)
              }}
            >
              {side === 'left' ? <PanelLeft size={22} /> : <PanelRight size={22} />}
              <span>Dock {side}</span>
            </div>
          ))}
        </main>
      </div>
      {(isUpdateActionVisible(updateState) || updateState.currentVersion) && (
        <footer className="statusbar detached-statusbar">
          <span className="status-spacer" />
          <AppUpdateButton state={updateState} onAction={() => void runUpdateAction()} />
          {updateState.currentVersion && <AppVersionButton state={updateState} onCheck={checkForUpdates} />}
        </footer>
      )}
    </div>
  )
}
