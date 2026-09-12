import { useAgentControl } from './use-agent-control'
import { ListTodo } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Bot, Brain, Gauge, GitBranch, Globe2, HardDrive, LayoutPanelTop, PanelLeft, PanelRight, Plus, Radio, Workflow, X, Zap } from 'lucide-react'
import type {
  AgentActivityPhase,
  AgentProviderId,
  AgentSoundProfile,
  AppSettings,
  LayoutTemplateRecord,
  PaneKind,
  PaneTab,
  ProjectRecord,
  SessionRecord,
  ThemeId,
  ThemeVariant,
  WorkspaceDocumentState,
  WorkspaceRecoveryCheckpoint,
  WorkspaceLayout
} from '../../shared/models'
import { makeLauncherTab } from '../../shared/models'
import { TitleBar } from './components/TitleBar'
import { Sidebar, type WorkspacePanel } from './components/Sidebar'
import { SessionBar } from './components/SessionBar'
import { EmptyState } from './components/EmptyState'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { SettingsPanel } from './components/SettingsPanel'
import { PaneWorkspace } from './layout/PaneWorkspace'
import { applyTabGroupAction, applyWorkspaceTabAction, type WorkspaceTabAction } from './layout/workspace-tab-actions'
import { closePlacedTab } from './layout/machine-placement'
import type { TabGroupAction } from './layout/tab-groups'
import {
  activateTab,
  addTab,
  closeTab,
  findGroup,
  listGroups,
  replaceTab,
  instantiateLayout,
  splitGroup,
  stripWorkspaceUtilityTabs,
  type DockEdge
} from './layout/layout-operations'
import {
  CHORD_TIMEOUT_MS,
  TAB_CHORD,
  isEditingTarget,
  resizeFocusedGroup,
  moveFocusedTab,
  snapFocusedGroup,
  tabIdAtChromeIndex,
  tabIdByOffset,
  type ResizeDirection
} from './layout/tab-keyboard'
import { LOCAL_MODELS } from '../../shared/local-models'
import { createPaneTab } from './panes/pane-factory'
import { MemoryPane } from './panes/MemoryPane'
import { ProcessDashboardPane } from './panes/ProcessDashboardPane'
import { OrchestrationHub } from './components/OrchestrationHub'
import { WorkspaceFiles } from './components/WorkspaceFiles'
import { openWorkspaceFile, changeWorkspacePath, workspaceFileIds } from './components/workspace-files-state'
import { ProjectBacklogPane } from './components/ProjectBacklogPane'
import { AppVersionButton } from './components/AppVersionButton'
import { applyAppTheme, resolveThemeVariant } from './appearance'
import { DebugConsole } from './components/DebugConsole'
import {
  clearDebugEntries,
  debugLog,
  installDebugLogging,
  setDebugLoggingEnabled,
  subscribeToDebugEntries,
  type IssueReportContext
} from './debug-log'
import { getAttentionSessionIds, getProjectActivityStatuses, getSessionActivityStatuses, hasActiveSubagent, mergeProjectActivity, resolveActivityPhases, retainVisibleAttentionResources } from './attention'
import type { ProjectActivitySnapshot } from '../../shared/project-activity'
import { migrateLegacyCodexModels, migrateLegacyCodexTab } from './agent-models'
import { useAppUpdates } from './use-app-updates'
import { TabPerformancePopover } from './components/TabPerformancePopover'
import { playAgentSound } from './agent-sounds'
import { AppUpdateButton } from './components/AppUpdateButton'
import { UpdatePrompt } from './components/UpdatePrompt'
import { AgentConfirmDialog } from './components/AgentConfirmDialog'
import { useAgentConfirm } from './use-agent-confirm'
import { summarizeSubagents } from './panes/usage-summary'
import { spinPhaseStyle } from './spin-sync'
import { CONDUCTOR_FILE_DRAG, decodeConductorFileDrag } from './components/composer-file-drop'
import type { MachineDescriptor } from '../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../shared/remote-control'
import { checkRemoteProjectPlacement } from '../../shared/project-identity'
import { readPlacement } from './layout/machine-placement'
import { dispatchAgentContext } from './panes/StructuredAgentPane'

const workspaceDocumentsSnapshot = (): WorkspaceDocumentState[] => {
  const documents: WorkspaceDocumentState[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith('conductor.workspaceFiles.')) continue
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as { files?: unknown; activeId?: unknown } | null
      if (!value || !Array.isArray(value.files)) continue
      documents.push({ workspaceId: key.slice('conductor.workspaceFiles.'.length), files: value.files as WorkspaceDocumentState['files'], activeId: typeof value.activeId === 'string' ? value.activeId : null })
    } catch { /* a stale local record is ignored here and by WorkspaceFiles */ }
  }
  return documents
}

const restoreWorkspaceDocuments = (documents: WorkspaceDocumentState[] | undefined): void => {
  for (const state of documents ?? []) localStorage.setItem('conductor.workspaceFiles.' + state.workspaceId, JSON.stringify({ files: state.files, activeId: state.activeId }))
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [sessionName, setSessionName] = useState('Untitled session')
  const [machines, setMachines] = useState<MachineDescriptor[]>([])
  const [selectedMachineId, setSelectedMachineId] = useState(LOCAL_MACHINE_ID)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [closedWorkspaces, setClosedWorkspaces] = useState<SessionRecord[]>([])
  const workspaceRestoreBusy = useRef(false)
  const workspaceCloseBusy = useRef(new Set<string>())
  useEffect(() => {
    const refresh = (): void => { void window.conductor.sessions.closed().then(setClosedWorkspaces).catch(() => {}) }
    refresh(); window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [focusedGroupId, setFocusedGroupId] = useState('')
  const [templates, setTemplates] = useState<LayoutTemplateRecord[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [utilityPanel, setUtilityPanel] = useState<WorkspacePanel | null>(() => {
    const saved = localStorage.getItem('conductor.utilityPanel')
    return ['agents', 'tasks', 'routines', 'memory', 'processes', 'backlog'].includes(saved ?? '')
      ? saved as WorkspacePanel
      : null
  })
  const [utilitySide, setUtilitySide] = useState<'left' | 'right'>(() =>
    localStorage.getItem('conductor.utilitySide') === 'left' ? 'left' : 'right'
  )
  const [utilityDragging, setUtilityDragging] = useState(false)
  const [utilityResizing, setUtilityResizing] = useState(false)
  const [utilityDockPreview, setUtilityDockPreview] = useState<'left' | 'right' | null>(null)
  const [utilityWidths, setUtilityWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem('conductor.utilityWidths') ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })
  const [appSettings, setAppSettings] = useState<AppSettings>(() => window.conductor.settings.getStartup())
  const [resolvedThemeVariant, setResolvedThemeVariant] = useState<ThemeVariant>(() => resolveThemeVariant(appSettings))
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('conductor.sidebarCollapsed') === 'true')
  const [attentionResourceIds, setAttentionResourceIds] = useState<Set<string>>(() => new Set())
  const [activityPhases, setActivityPhases] = useState<Map<string, AgentActivityPhase>>(() => new Map())
  // Resources whose subagents (Task-tool children) are still running, preparing, or awaiting
  // approval even though the resource's own turn already reported 'complete'.
  const [subagentActiveIds, setSubagentActiveIds] = useState<Set<string>>(() => new Set())
  // Agent activity for every project, computed in the main process: this renderer only holds the
  // active project's workspaces, so no other project's row could be resolved here.
  const [backendProjectActivity, setBackendProjectActivity] = useState<ProjectActivitySnapshot>({})
  const [debugConsoleOpen, setDebugConsoleOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const { updateState, autoDownload, setAutoDownload, runUpdateAction, checkForUpdates } = useAppUpdates()
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null)

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null
  const selectedRemoteMachine = useMemo(() => {
    if (!activeProject || selectedMachineId === LOCAL_MACHINE_ID) return null
    const machine = machines.find(item => item.id === selectedMachineId)
    const link = machine?.projects.find(item => item.grant.localProjectId === activeProject.id)
    if (!machine || machine.status !== 'online' || !checkRemoteProjectPlacement({ grant: link?.grant, advertised: link?.observed, machineName: machine.name }).ok) return null
    return machine
  }, [activeProject, machines, selectedMachineId])
  const activeWorkspaceGroups = useMemo(
    () => activeSession ? listGroups(activeSession.layout.root) : [],
    [activeSession]
  )
  const activeWorkspaceTabs = useMemo(
    () => activeWorkspaceGroups.flatMap((group) => group.tabs),
    [activeWorkspaceGroups]
  )
  const activeWorkspaceTabIds = useMemo(
    () => new Set(activeWorkspaceGroups.map((group) => group.activeTabId)),
    [activeWorkspaceGroups]
  )
  const attentionSessionIds = useMemo(
    () => getAttentionSessionIds(sessions, attentionResourceIds),
    [attentionResourceIds, sessions]
  )
  // A tab must not show 'complete' while it still owns active subagent work; every consumer of
  // activity phases (the top tab strip, the workspace sidebar list, session and project dots)
  // reads this corrected map instead of the raw one dispatched by the running conversation.
  const correctedActivityPhases = useMemo(
    () => subagentActiveIds.size ? resolveActivityPhases(activityPhases, subagentActiveIds) : activityPhases,
    [activityPhases, subagentActiveIds]
  )
  const sessionActivityStatuses = useMemo(
    () => getSessionActivityStatuses(sessions, correctedActivityPhases),
    [correctedActivityPhases, sessions]
  )
  const projectActivityStatuses = useMemo(
    () => mergeProjectActivity(
      backendProjectActivity,
      getProjectActivityStatuses(sessions, attentionSessionIds, sessionActivityStatuses)
    ),
    [attentionSessionIds, backendProjectActivity, sessionActivityStatuses, sessions]
  )
  const debugContext = useMemo<IssueReportContext>(() => ({
    projectCount: projects.length,
    sessionCount: sessions.length,
    activeSessionId: activeSession?.id ?? null,
    activeSessionName: activeSession?.name ?? null,
    activeTabKinds: activeSession
      ? listGroups(activeSession.layout.root).flatMap((group) => group.tabs.map((tab) => tab.kind))
      : [],
    attentionCount: attentionResourceIds.size,
    theme: `${appSettings.themeId}/${resolvedThemeVariant}`,
    zoomFactor: appSettings.zoomFactor
  }), [activeSession, appSettings.themeId, appSettings.zoomFactor, attentionResourceIds, projects.length, resolvedThemeVariant, sessions.length])

  useEffect(() => {
    if (!appSettings.debugLogging) return
    const unsubscribeEntries = subscribeToDebugEntries((entries) => {
      window.conductor.debug.publishSnapshot({ entries, context: debugContext })
    })
    const unsubscribeClear = window.conductor.debug.onClearSource(clearDebugEntries)
    return () => {
      unsubscribeEntries()
      unsubscribeClear()
    }
  }, [appSettings.debugLogging, debugContext])
  const sessionsRef = useRef<SessionRecord[]>(sessions)
  const activeProjectIdRef = useRef<string | null>(activeProjectId)
  const activeSessionIdRef = useRef<string | null>(activeSessionId)
  const focusedGroupIdsRef = useRef<Record<string, string>>({})
  const sessionIdsByProjectRef = useRef<Record<string, string>>({})
  const recoveryReadyRef = useRef(false)
  const checkpointTimerRef = useRef<number | null>(null)
  const saveRevisionRef = useRef(0)
  const soundProfileRef = useRef(appSettings.agentSoundProfile)
  sessionsRef.current = sessions
  activeProjectIdRef.current = activeProjectId
  activeSessionIdRef.current = activeSessionId
  soundProfileRef.current = appSettings.agentSoundProfile
  if (activeSessionId && focusedGroupId) focusedGroupIdsRef.current[activeSessionId] = focusedGroupId
  if (activeProjectId && activeSessionId) sessionIdsByProjectRef.current[activeProjectId] = activeSessionId

  const recoveryCheckpoint = useCallback((): WorkspaceRecoveryCheckpoint => ({
    activeProjectId: activeProjectIdRef.current,
    activeSessionId: activeSessionIdRef.current,
    focusedGroupIds: { ...focusedGroupIdsRef.current },
    sessionIdsByProject: { ...sessionIdsByProjectRef.current },
    documents: workspaceDocumentsSnapshot(),
    sessions: sessionsRef.current.map((session) => ({
      id: session.id,
      layout: session.layout,
      maximizedGroupId: session.maximizedGroupId,
      closedTabs: session.closedTabs
    }))
  }), [])
  const utilityMeta = utilityPanel === 'backlog'
    ? { label: 'Project tasks', aria: 'Project bugs and features', icon: ListTodo }
    : utilityPanel === 'memory'
    ? { label: 'Project memory', aria: 'Project memory', icon: Brain }
    : utilityPanel === 'processes'
      ? { label: 'Processes', aria: 'Process dashboard', icon: Gauge }
      : utilityPanel === 'routines'
        ? { label: 'Automation', aria: 'Project automation', icon: Workflow }
      : { label: 'Automation', aria: 'Agents, tasks, and routines', icon: Bot }
  const utilityWidthKey = utilityPanel && ['agents', 'tasks', 'routines'].includes(utilityPanel)
    ? 'automation'
    : utilityPanel
  const activeUtilityWidth = utilityWidthKey
    ? utilityWidths[utilityWidthKey] ?? (utilityWidthKey === 'automation' ? 610 : 430)
    : 430

  const openDroppedProjectFile = (event: React.DragEvent): void => {
    const dropped = decodeConductorFileDrag(event.dataTransfer.getData(CONDUCTOR_FILE_DRAG))
    if (!dropped || dropped.kind !== 'file' || !projects.some(project => project.id === dropped.projectId)) return
    event.preventDefault(); event.stopPropagation()
    openWorkspaceFile(dropped.projectId, dropped.path, 'editor')
  }

  const selectSession = useCallback((session: SessionRecord) => {
    debugLog('workspace', 'Selecting workspace', { sessionId: session.id, name: session.name }, 'info')
    setActiveSessionId(session.id)
    const remembered = focusedGroupIdsRef.current[session.id]
    setFocusedGroupId(remembered && findGroup(session.layout.root, remembered)
      ? remembered
      : listGroups(session.layout.root)[0]?.id ?? '')
  }, [])

  const loadProject = useCallback(async (projectId: string, preferredSessionId?: string) => {
    if (recoveryReadyRef.current) window.conductor.recovery.flush(recoveryCheckpoint())
    setActiveProjectId(projectId)
    setActiveSessionId(null)
    setFocusedGroupId('')
    const persisted = await window.conductor.sessions.list(projectId)
    const loaded = persisted.map((session) => {
      const layout = migrateLegacyCodexModels(stripWorkspaceUtilityTabs(session.layout))
      const retainedClosedTabs = session.closedTabs.filter((tab) => ['launcher', 'agent', 'terminal'].includes(tab.kind))
      const closedTabs = retainedClosedTabs.map(migrateLegacyCodexTab)
      const closedTabsChanged = closedTabs.some((tab, index) => tab !== retainedClosedTabs[index])
      if (layout === session.layout && closedTabs.length === session.closedTabs.length && !closedTabsChanged) return session
      void window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, closedTabs)
      return { ...session, layout, closedTabs }
    })
    const layouts = await window.conductor.sessions.listTemplates(projectId)
    setSessions(loaded)
    setTemplates(layouts)
    const remembered = sessionIdsByProjectRef.current[projectId]
    const next = loaded.find((session) => session.id === preferredSessionId)
      ?? loaded.find((session) => session.id === remembered)
      ?? loaded[0]
    if (next) selectSession(next)
  }, [selectSession])

  useEffect(() => {
    void Promise.all([
      window.conductor.projects.list(),
      window.conductor.settings.get(),
      window.conductor.recovery.get()
    ]).then(async ([loaded, settings, recovery]) => {
      setProjects(loaded)
      setAppSettings(settings)
      restoreWorkspaceDocuments(recovery.documents)
      if (settings.debugLogging) setDebugConsoleOpen(true)
      focusedGroupIdsRef.current = recovery.focusedGroupIds
      sessionIdsByProjectRef.current = { ...recovery.sessionIdsByProject }
      const project = loaded.find((item) => item.id === recovery.activeProjectId) ?? loaded[0]
      if (project) await loadProject(project.id, recovery.activeSessionId ?? undefined)
    }).catch((reason: unknown) => {
      setToast(reason instanceof Error ? reason.message : 'Conductor could not restore the workspace')
    }).finally(() => {
      recoveryReadyRef.current = true
      setLoading(false)
    })
  }, [loadProject])

  useEffect(() => {
    void window.conductor.sessionArchive.name().then(setSessionName).catch(() => {})
    return window.conductor.sessionArchive.onChanged(result => setSessionName(result.name))
  }, [])

  useEffect(() => {
    const refresh = (): void => { void window.conductor.remote.machines().then(setMachines).catch(() => setMachines([])) }
    refresh()
    return window.conductor.remote.onState(refresh)
  }, [])

  useEffect(() => setSelectedMachineId(activeSession ? readPlacement(activeSession.id) : LOCAL_MACHINE_ID), [activeSession?.id])

  useEffect(() => installDebugLogging(), [])

  useEffect(() => {
    setDebugLoggingEnabled(appSettings.debugLogging)
  }, [appSettings.debugLogging])

  useEffect(() => {
    localStorage.setItem('conductor.utilityPanel', utilityPanel ?? '')
  }, [utilityPanel])

  useEffect(() => {
    const phases = new Map<string, string>()
    const pendingInputSounds = new Map<string, number>()
    const recentAttentionSounds = new Map<string, number>()
    const lastPlayed = new Map<string, number>()
    const play = (id: string, cue: 'complete' | 'question' | 'input'): void => {
      const key = `${id}:${cue}`
      const now = Date.now()
      if (now - (lastPlayed.get(key) ?? 0) < 900) return
      lastPlayed.set(key, now)
      playAgentSound(soundProfileRef.current, cue)
    }
    const cancelPendingInput = (id: string): void => {
      const timer = pendingInputSounds.get(id)
      if (timer !== undefined) window.clearTimeout(timer)
      pendingInputSounds.delete(id)
    }
    const offStatus = window.conductor.agents.onStatus((event) => {
      const nextPhase = event.phase ?? event.status
      const previousPhase = phases.get(event.id)
      phases.set(event.id, nextPhase)
      if (nextPhase === 'complete' && previousPhase === 'working') play(event.id, 'complete')
      if (nextPhase === 'waiting_input' && previousPhase !== 'waiting_input') {
        cancelPendingInput(event.id)
        pendingInputSounds.set(event.id, window.setTimeout(() => {
          pendingInputSounds.delete(event.id)
          if (Date.now() - (recentAttentionSounds.get(event.id) ?? 0) >= 500) play(event.id, 'input')
        }, 180))
      } else if (nextPhase !== 'waiting_input') cancelPendingInput(event.id)
    })
    const offEvent = window.conductor.agents.onEvent((event) => {
      if (event.type !== 'question') return
      cancelPendingInput(event.agentSessionId)
      recentAttentionSounds.set(event.agentSessionId, Date.now())
      play(event.agentSessionId, /waiting for input/i.test(event.message) ? 'input' : 'question')
    })
    return () => {
      offStatus()
      offEvent()
      for (const timer of pendingInputSounds.values()) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const phases = new Map<string, string>()
    const recordPhase = (id: string, phase: AgentActivityPhase): void => {
      if (phases.get(id) === phase) return
      phases.set(id, phase)
      debugLog('agent', `Activity changed to ${phase}`, { resourceId: id })
      setAttentionResourceIds((current) => {
        const next = new Set(current)
        if (phase === 'waiting_input') next.add(id)
        else next.delete(id)
        return next
      })
      setActivityPhases((current) => new Map(current).set(id, phase))
    }
    const onActivity = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; phase: AgentActivityPhase }>).detail
      recordPhase(detail.id, detail.phase)
    }
    window.addEventListener('conductor:agent-activity', onActivity)
    // A tab an agent opens away from the workspace the owner is looking at never mounts the pane
    // that would otherwise dispatch conductor:agent-activity, so its own needs-attention/working
    // dot would never light up. This backend broadcast carries the same phases regardless of
    // which window or tab is mounted, which is what lets that indicator reach it unobtrusively.
    const offStatus = window.conductor.agents.onStatus((event) => {
      if (event.phase) recordPhase(event.id, event.phase)
    })
    return () => {
      window.removeEventListener('conductor:agent-activity', onActivity)
      offStatus()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const recheckSubagents = async (resourceId: string): Promise<void> => {
      const projection = await window.conductor.structured.snapshot(resourceId)
      if (disposed || !projection) return
      const statuses = summarizeSubagents(projection.items, projection.runtimeId, projection.phase, false).map((agent) => agent.status)
      const active = hasActiveSubagent(statuses)
      setSubagentActiveIds((current) => {
        if (current.has(resourceId) === active) return current
        const next = new Set(current)
        if (active) next.add(resourceId)
        else next.delete(resourceId)
        return next
      })
    }
    // The exact moment a tab's own phase settles to 'complete' is when a stale subagent check
    // matters most; every later subagent event keeps that check honest as subagents finish.
    const onActivity = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; phase: AgentActivityPhase }>).detail
      if (detail.phase === 'complete') void recheckSubagents(detail.id)
    }
    const offEvents = window.conductor.structured.onEvents((events) => {
      const resourceIds = new Set(events.filter((event) => event.data.type === 'subagent').map((event) => event.sessionId))
      for (const resourceId of resourceIds) void recheckSubagents(resourceId)
    })
    window.addEventListener('conductor:agent-activity', onActivity)
    return () => {
      disposed = true
      offEvents()
      window.removeEventListener('conductor:agent-activity', onActivity)
    }
  }, [])

  useEffect(() => {
    setAttentionResourceIds((current) => {
      const next = retainVisibleAttentionResources(sessions, current)
      return next.size === current.size ? current : next
    })
  }, [sessions])

  const refreshProjectActivity = useCallback((): void => {
    void window.conductor.activity.projects().then(setBackendProjectActivity).catch(() => {})
  }, [])

  useEffect(() => {
    refreshProjectActivity()
    return window.conductor.activity.onProjectsChanged(setBackendProjectActivity)
  }, [refreshProjectActivity])

  // The main process announces phase changes; opening or closing a tab, a workspace or a project
  // changes which agents speak for a project without any phase moving, so re-ask on those too.
  // Moving or renaming a tab does not, hence the resource key rather than the sessions array.
  const workspaceResourceKey = useMemo(
    () => sessions.map((session) => `${session.id}:${listGroups(session.layout.root).flatMap((group) => group.tabs.flatMap((tab) => tab.resourceId ? [tab.resourceId] : [])).sort().join(',')}`).join('|'),
    [sessions]
  )
  useEffect(() => {
    refreshProjectActivity()
  }, [projects.length, refreshProjectActivity, workspaceResourceKey])

  useEffect(() => {
    const applyTheme = (): void => setResolvedThemeVariant(applyAppTheme(appSettings))
    applyTheme()
    const timer = window.setInterval(applyTheme, 60_000)
    return () => window.clearInterval(timer)
  }, [appSettings.themeAuto, appSettings.themeId, appSettings.themeVariant])

  useEffect(() => {
    const onToast = (event: Event): void => setToast((event as CustomEvent<string>).detail)
    window.addEventListener('conductor:toast', onToast)
    return () => {
      window.removeEventListener('conductor:toast', onToast)
    }
  }, [])

  useEffect(() => {
    if (loading || !recoveryReadyRef.current) return
    if (checkpointTimerRef.current !== null) window.clearTimeout(checkpointTimerRef.current)
    const revision = ++saveRevisionRef.current
    setSaveStatus('unsaved')
    checkpointTimerRef.current = window.setTimeout(async () => {
      checkpointTimerRef.current = null
      setSaveStatus('saving')
      try {
        await window.conductor.recovery.checkpoint(recoveryCheckpoint())
        if (saveRevisionRef.current === revision) {
          setLastSavedAt(Date.now())
          setSaveStatus('saved')
        }
      } catch (reason) {
        if (saveRevisionRef.current === revision) setSaveStatus('error')
        debugLog('workspace', 'Autosave failed', reason, 'error')
      }
    }, 100)
  }, [activeProjectId, activeSessionId, loading, recoveryCheckpoint, sessions])

  useEffect(() => {
    const flushRecovery = (): void => {
      if (!recoveryReadyRef.current) return
      if (checkpointTimerRef.current !== null) {
        window.clearTimeout(checkpointTimerRef.current)
        checkpointTimerRef.current = null
      }
      if (window.conductor.recovery.flush(recoveryCheckpoint())) {
        saveRevisionRef.current += 1
        setLastSavedAt(Date.now())
        setSaveStatus('saved')
      } else setSaveStatus('error')
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushRecovery()
    }
    window.addEventListener('pagehide', flushRecovery)
    window.addEventListener('beforeunload', flushRecovery)
    window.addEventListener('conductor:flush-session', flushRecovery)
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribeUpdate = window.conductor.updates.onPrepareInstall(({ requestId }) => {
      flushRecovery()
      window.conductor.updates.acknowledgePrepare(requestId)
    })
    return () => {
      window.removeEventListener('pagehide', flushRecovery)
      window.removeEventListener('beforeunload', flushRecovery)
      window.removeEventListener('conductor:flush-session', flushRecovery)
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribeUpdate()
      flushRecovery()
    }
  }, [recoveryCheckpoint])

  const saveWorkspaceNow = useCallback(async (): Promise<void> => {
    if (!recoveryReadyRef.current) return
    if (checkpointTimerRef.current !== null) {
      window.clearTimeout(checkpointTimerRef.current)
      checkpointTimerRef.current = null
    }
    const revision = ++saveRevisionRef.current
    setSaveStatus('saving')
    try {
      await window.conductor.recovery.checkpoint(recoveryCheckpoint())
      if (saveRevisionRef.current === revision) {
        setLastSavedAt(Date.now())
        setSaveStatus('saved')
        setToast('Workspace saved')
      }
    } catch (reason) {
      if (saveRevisionRef.current === revision) setSaveStatus('error')
      setToast('Workspace save failed')
      debugLog('workspace', 'Manual save failed', reason, 'error')
    }
  }, [recoveryCheckpoint])

  useEffect(() => {
    if (!activeSession) return
    if (!findGroup(activeSession.layout.root, focusedGroupId)) {
      setFocusedGroupId(listGroups(activeSession.layout.root)[0]?.id ?? '')
    }
  }, [activeSession, focusedGroupId])

  const patchActiveSession = useCallback((update: (session: SessionRecord) => SessionRecord) => {
    setSessions((current) => current.map((session) => session.id === activeSessionId ? update(session) : session))
  }, [activeSessionId])

  const setLayout = useCallback((layout: WorkspaceLayout) => {
    patchActiveSession((session) => ({ ...session, layout }))
  }, [patchActiveSession])

  const setMaximized = useCallback((maximizedGroupId: string | null) => {
    patchActiveSession((session) => ({ ...session, maximizedGroupId }))
  }, [patchActiveSession])

  const rememberClosed = useCallback((tab: PaneTab) => {
    patchActiveSession((session) => ({ ...session, closedTabs: [...session.closedTabs, tab].slice(-20) }))
  }, [patchActiveSession])

  const openExistingProject = async (): Promise<void> => {
    const project = await window.conductor.projects.openFolder()
    if (!project) return
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
    await loadProject(project.id)
  }

  const createManagedProject = async (name = 'Untitled project'): Promise<void> => {
    const project = await window.conductor.projects.create(name)
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
    await loadProject(project.id)
    setToast(`Created ${project.name}`)
    setRenameProjectId(project.id)
  }

  const renameProject = async (projectId: string, name: string): Promise<void> => {
    const current = projects.find((item) => item.id === projectId)
    if (!current || current.name === name.trim()) return
    try {
      const renamed = await window.conductor.projects.rename(projectId, name)
      setProjects((items) => items.map((item) => item.id === renamed.id ? renamed : item))
      setToast(`Renamed project to ${renamed.name}`)
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const moveProject = async (projectId: string): Promise<void> => {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    setToast(`Moving ${project.name}…`)
    try {
      const moved = await window.conductor.projects.move(projectId)
      if (!moved) {
        setToast('Move cancelled')
        return
      }
      setProjects((current) => current.map((item) => item.id === moved.id ? moved : item))
      setToast(`Moved ${moved.name} to ${moved.path}`)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setToast(message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }

  const removeProject = async (projectId: string): Promise<void> => {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    try {
      window.dispatchEvent(new Event('conductor:flush-editors'))
      if (!await window.conductor.files.confirmClose(workspaceFileIds(projectId))) return
      await window.conductor.projects.remove(projectId)
      const remaining = projects.filter((item) => item.id !== projectId)
      setProjects(remaining)
      if (activeProjectId === projectId) {
        const next = remaining[0]
        if (next) await loadProject(next.id)
        else {
          setActiveProjectId(null)
          setActiveSessionId(null)
          setFocusedGroupId('')
          setSessions([])
          setTemplates([])
        }
      }
      setToast(`Removed ${project.name} from Conductor. Its files remain at ${project.path}`)
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : 'Could not remove project')
      throw reason
    }
  }

  const setZoom = useCallback(async (requested: number): Promise<void> => {
    const zoomFactor = Math.min(1.5, Math.max(0.8, Math.round(requested * 20) / 20))
    setAppSettings((current) => ({ ...current, zoomFactor }))
    const saved = await window.conductor.settings.setZoom(zoomFactor)
    setAppSettings(saved)
  }, [])

  const setTheme = useCallback(async (themeId: ThemeId): Promise<void> => {
    setAppSettings((current) => ({ ...current, themeId }))
    setAppSettings(await window.conductor.settings.setTheme(themeId))
  }, [])

  const setThemeVariant = useCallback(async (themeVariant: ThemeVariant): Promise<void> => {
    setAppSettings((current) => ({ ...current, themeVariant }))
    setAppSettings(await window.conductor.settings.setThemeVariant(themeVariant))
  }, [])

  const setThemeAuto = useCallback(async (themeAuto: boolean): Promise<void> => {
    setAppSettings((current) => ({ ...current, themeAuto }))
    setAppSettings(await window.conductor.settings.setThemeAuto(themeAuto))
  }, [])

  const setDebugLogging = useCallback(async (debugLogging: boolean): Promise<void> => {
    setAppSettings((current) => ({ ...current, debugLogging }))
    if (debugLogging) setDebugConsoleOpen(true)
    setAppSettings(await window.conductor.settings.setDebugLogging(debugLogging))
  }, [])

  const setShowHiddenFiles = useCallback(async (showHiddenFiles: boolean): Promise<void> => {
    setAppSettings((current) => ({ ...current, showHiddenFiles }))
    setAppSettings(await window.conductor.settings.setShowHiddenFiles(showHiddenFiles))
  }, [])

  const setAgentSoundProfile = useCallback(async (agentSoundProfile: AgentSoundProfile): Promise<void> => {
    setAppSettings((current) => ({ ...current, agentSoundProfile }))
    setAppSettings(await window.conductor.settings.setAgentSoundProfile(agentSoundProfile))
  }, [])

  const chooseManualThemeVariant = useCallback(async (themeVariant: ThemeVariant): Promise<void> => {
    setAppSettings((current) => ({ ...current, themeAuto: false, themeVariant }))
    if (appSettings.themeAuto) await window.conductor.settings.setThemeAuto(false)
    setAppSettings(await window.conductor.settings.setThemeVariant(themeVariant))
  }, [appSettings.themeAuto])

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

  const beginUtilityResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!utilityWidthKey) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? activeUtilityWidth
    const side = utilitySide
    const key = utilityWidthKey
    const minimum = key === 'automation' ? 360 : 260
    const maximum = Math.max(minimum, Math.min(920, window.innerWidth - 380))
    setUtilityResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const move = (pointerEvent: PointerEvent): void => {
      const delta = side === 'right' ? startX - pointerEvent.clientX : pointerEvent.clientX - startX
      const width = Math.round(Math.min(maximum, Math.max(minimum, startWidth + delta)))
      setUtilityWidths((current) => {
        const next = { ...current, [key]: width }
        localStorage.setItem('conductor.utilityWidths', JSON.stringify(next))
        return next
      })
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setUtilityResizing(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const newSession = async (): Promise<void> => {
    if (!activeProject) return
    const created = await window.conductor.sessions.create(activeProject.id, `Workspace ${sessions.length + 1}`)
    debugLog('workspace', 'Created workspace', { sessionId: created.id, name: created.name }, 'info')
    setSessions((current) => [...current, created])
    selectSession(created)
  }

  const closeSession = useCallback(async (sessionId: string): Promise<void> => {
    const closing = sessionsRef.current.find(session => session.id === sessionId)
    if (!closing || workspaceCloseBusy.current.has(sessionId)) return
    workspaceCloseBusy.current.add(sessionId)
    try {
      window.dispatchEvent(new Event('conductor:flush-editors'))
      if (!await window.conductor.files.confirmClose(workspaceFileIds(undefined, sessionId))) return
      // Commit the exact current layout before hiding the workspace, retaining its IDs and drafts.
      const latest = sessionsRef.current.find(session => session.id === sessionId) ?? closing
      await window.conductor.sessions.save(sessionId, latest.layout, latest.maximizedGroupId, latest.closedTabs)
      await window.conductor.sessions.delete(sessionId)
      setClosedWorkspaces(await window.conductor.sessions.closed())
      if (activeProjectIdRef.current === closing.projectId) {
        const current = sessionsRef.current
        const remaining = current.filter(session => session.id !== sessionId)
        const fallback = remaining[Math.min(current.findIndex(session => session.id === sessionId), remaining.length - 1)]
        setSessions(remaining)
        if (activeSessionIdRef.current === sessionId) {
          if (fallback) selectSession(fallback)
          else { setActiveSessionId(null); setFocusedGroupId('') }
        }
      }
      debugLog('workspace', 'Workspace closed and available to restore', { sessionId }, 'info')
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not close workspace')
    } finally { workspaceCloseBusy.current.delete(sessionId) }
  }, [selectSession])

  const showRestoredWorkspace = useCallback(async (restored: SessionRecord): Promise<void> => {
    setClosedWorkspaces(await window.conductor.sessions.closed())
    if (activeProjectIdRef.current === restored.projectId) {
      const ordered = await window.conductor.sessions.list(restored.projectId)
      setSessions(current => ordered.map(session => session.id === restored.id ? restored : current.find(existing => existing.id === session.id) ?? session))
      selectSession(restored)
    } else await loadProject(restored.projectId, restored.id)
    setToast(`Brought back ${restored.name}`)
  }, [loadProject, selectSession])

  const restoreWorkspace = useCallback(async (): Promise<void> => {
    if (workspaceRestoreBusy.current) return
    workspaceRestoreBusy.current = true
    try {
      const restored = await window.conductor.sessions.restore()
      if (restored) await showRestoredWorkspace(restored)
      else { setClosedWorkspaces([]); setToast('No closed workspace to bring back') }
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not bring back workspace') }
    finally { workspaceRestoreBusy.current = false }
  }, [showRestoredWorkspace])

  useEffect(() => window.conductor.sessions.onRestored(session => { void showRestoredWorkspace(session) }), [showRestoredWorkspace])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return
      event.preventDefault(); event.stopPropagation(); void restoreWorkspace()
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  }, [restoreWorkspace])
  const renameSession = useCallback(async (sessionId: string, name: string): Promise<void> => {
    const normalized = name.trim()
    if (!normalized) return
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, name: normalized } : session))
    try {
      await window.conductor.sessions.rename(sessionId, normalized)
    } catch (error) {
      if (activeProjectId) setSessions(await window.conductor.sessions.list(activeProjectId))
      setToast(error instanceof Error ? error.message : 'Could not rename workspace')
    }
  }, [activeProjectId])

  const closeFocusedTab = useCallback((): boolean => {
    if (!activeSession) return false
    const group = findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
    const tab = group?.tabs.find((item) => item.id === group.activeTabId) ?? group?.tabs[0]
    if (!group || !tab) return false
    const result = closeTab(activeSession.layout, group.id, tab.id)
    const apply = (): void => patchActiveSession((session) => ({
        ...session,
        layout: result.layout,
        closedTabs: result.closed ? [...session.closedTabs, result.closed].slice(-20) : session.closedTabs
      }))
    const transitionDocument = document as Document & { startViewTransition?: (update: () => void) => unknown }
    if (transitionDocument.startViewTransition) transitionDocument.startViewTransition(() => flushSync(apply))
    else apply()
    return true
  }, [activeSession, focusedGroupId, patchActiveSession])

  useEffect(() => {
    const closeRequested = (): void => { closeFocusedTab() }
    window.addEventListener('conductor:close-tab', closeRequested)
    return () => window.removeEventListener('conductor:close-tab', closeRequested)
  }, [closeFocusedTab])

  const saveNamedSession = useCallback(async (): Promise<void> => {
    try {
      const result = await window.conductor.sessionArchive.save()
      if (result) { setSessionName(result.name); setToast(`Saved ${result.name}`) }
    } catch (reason) { setToast(reason instanceof Error ? reason.message : 'Could not save session') }
  }, [])

  const openNamedSession = useCallback(async (): Promise<void> => {
    try {
      const result = await window.conductor.sessionArchive.open()
      if (result) setSessionName(result.name)
    } catch (reason) { setToast(reason instanceof Error ? reason.message : 'Could not open session') }
  }, [])

  const saveTemplate = async (name: string): Promise<void> => {
    if (!activeProject || !activeSession || !name.trim()) return
    const template = await window.conductor.sessions.saveTemplate(activeProject.id, name, activeSession.layout)
    setTemplates((current) => [template, ...current])
  }

  const applyTemplate = (template: LayoutTemplateRecord): void => {
    const layout = instantiateLayout(template.layout)
    setLayout(layout)
    setMaximized(null)
    setFocusedGroupId(listGroups(layout.root)[0]?.id ?? '')
  }

  const makeTab = (kind: PaneKind, provider?: AgentProviderId, model?: string): PaneTab =>
    createPaneTab(kind, { provider, model })

  const openInFocused = useCallback((kind: PaneKind, provider?: AgentProviderId, model?: string): void => {
    if (!['launcher', 'agent', 'terminal'].includes(kind)) return
    if (!activeSession) return
    const group = findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
    if (!group) return
    const tab = kind === 'launcher' ? makeLauncherTab() : makeTab(kind, provider, model)
    const activeTab = group.tabs.find((item) => item.id === group.activeTabId)
    // A chosen runtime takes the open launcher's place; asking for another launcher must
    // still add a tab, or Ctrl+T on a new tab would silently swap it for an identical one.
    const layout = kind !== 'launcher' && activeTab?.kind === 'launcher'
      ? replaceTab(activeSession.layout, group.id, activeTab.id, tab)
      : addTab(activeSession.layout, group.id, tab)
    setLayout(layout)
    setFocusedGroupId(group.id)
  }, [activeSession, focusedGroupId, setLayout])

  const openExplorerFile = useCallback((relativePath: string, mode: 'editor' | 'preview', projectId?: string): void => {
    const owner = projectId ?? activeProjectIdRef.current
    if (owner) openWorkspaceFile(owner, relativePath, mode)
  }, [])

  const handleExplorerPathChanged = useCallback((previousPath: string, nextPath: string, kind: 'file' | 'directory', projectId?: string): void => {
    const owner = projectId ?? activeProjectIdRef.current
    if (owner) changeWorkspacePath(owner, previousPath, nextPath, kind)
  }, [])

  const handleExplorerPathRemoved = useCallback((path: string, kind: 'file' | 'directory', projectId?: string): void => {
    const owner = projectId ?? activeProjectIdRef.current
    if (owner) changeWorkspacePath(owner, path, null, kind)
  }, [])

  const splitFocused = useCallback((edge: Exclude<DockEdge, 'center'>, tab?: PaneTab): void => {
    if (!activeSession) return
    const group = findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
    if (!group) return
    const nextTab = tab ?? makeLauncherTab()
    if (group.tabs.length === 0) {
      setLayout(addTab(activeSession.layout, group.id, nextTab))
      setFocusedGroupId(group.id)
      return
    }
    const next = splitGroup(activeSession.layout, group.id, edge, nextTab)
    setLayout(next)
    const created = listGroups(next.root).find((item) => item.tabs.some((candidate) => candidate.id === nextTab.id))
    if (created) setFocusedGroupId(created.id)
  }, [activeSession, focusedGroupId, setLayout])

  const cycleFocusedTab = useCallback((offset: number): void => {
    if (!activeSession) return
    const group = findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
    if (!group) return
    const next = tabIdByOffset(group, offset)
    if (!next) return
    setLayout(activateTab(activeSession.layout, group.id, next))
    setFocusedGroupId(group.id)
  }, [activeSession, focusedGroupId, setLayout])

  const nudgeFocusedGroup = useCallback((direction: ResizeDirection, snap = false): void => {
    if (!activeSession) return
    const next = (snap ? snapFocusedGroup : resizeFocusedGroup)(activeSession.layout, focusedGroupId, direction)
    if (next !== activeSession.layout) setLayout(next)
  }, [activeSession, focusedGroupId, setLayout])

  const moveFocusedTabTo = useCallback((direction: ResizeDirection): void => {
    if (!activeSession) return
    const move = moveFocusedTab(activeSession.layout, focusedGroupId, direction)
    if (move.layout === activeSession.layout) return
    setLayout(move.layout)
    setFocusedGroupId(move.groupId)
  }, [activeSession, focusedGroupId, setLayout])

  const reopenClosed = useCallback((targetGroupId?: string) => {
    if (!activeSession || activeSession.closedTabs.length === 0) return
    const tab = activeSession.closedTabs.at(-1)!
    const target = findGroup(activeSession.layout.root, targetGroupId ?? focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
    if (!target) return
    patchActiveSession((session) => ({
      ...session,
      layout: addTab(session.layout, target.id, tab),
      closedTabs: session.closedTabs.slice(0, -1)
    }))
  }, [activeSession, focusedGroupId, patchActiveSession])

  const detachTab = useCallback((groupId: string, tab: PaneTab, options?: { alwaysOnTop?: boolean }): void => {
    if (!activeProject || !activeSession) return
    const result = closeTab(activeSession.layout, groupId, tab.id)
    if (!result.closed) return
    setLayout(result.layout)
    void window.conductor.window.detach(activeProject.id, activeSession.id, result.closed, result.layout, options)
  }, [activeProject, activeSession, setLayout])

  const sidebarTabAction = useCallback(async (sessionId: string, groupId: string, tabId: string, action: WorkspaceTabAction): Promise<void> => {
    const session = sessions.find(item => item.id === sessionId)
    if (!session) return
    const tab = findGroup(session.layout.root, groupId)?.tabs.find(item => item.id === tabId)
    if (!tab) return
    try {
      const result = applyWorkspaceTabAction(session, groupId, tabId, action)
      if (action === 'detach' || action === 'show') await window.conductor.window.detach(session.projectId, session.id, tab, result.session.layout, { alwaysOnTop: action === 'show' })
      // Closing from the sidebar closes a placed tab where it runs, exactly as closing its chip does.
      if (action === 'close') closePlacedTab(tab, setToast)
      setSessions(current => current.map(item => item.id === sessionId ? result.session : item))
      if (action !== 'detach' && action !== 'show') { selectSession(result.session); setFocusedGroupId(result.focusedGroupId); setUtilityPanel(null) }
      if (action === 'show') setToast(`${tab.title} is shown in a floating window. Close it to return the tab to its workspace.`)
    } catch (reason) { setToast(reason instanceof Error ? reason.message : String(reason)) }
  }, [sessions, selectSession])

  const sidebarTabGroupAction = useCallback((sessionId: string, groupId: string, tabId: string, action: TabGroupAction): void => {
    const session = sessions.find(item => item.id === sessionId)
    if (!session) return
    try {
      const result = applyTabGroupAction(session, groupId, tabId, action)
      setSessions(current => current.map(item => item.id === sessionId ? result.session : item))
      selectSession(result.session)
      void window.conductor.sessions.save(result.session.id, result.session.layout, result.session.maximizedGroupId, result.session.closedTabs)
    } catch (reason) { setToast(reason instanceof Error ? reason.message : String(reason)) }
  }, [sessions, selectSession])

  useAgentControl({
    resolve: async request => {
      const available = activeProjectIdRef.current === request.projectId ? sessionsRef.current : await window.conductor.sessions.list(request.projectId)
      const session = available.find(item => item.id === request.sessionId)
      if (!session) throw new Error('This workspace is no longer open.')
      return session
    },
    commit: async (session, groupId, reveal) => {
      if (activeProjectIdRef.current === session.projectId) {
        sessionsRef.current = sessionsRef.current.map(item => item.id === session.id ? session : item)
        flushSync(() => setSessions(sessionsRef.current))
      }
      await window.conductor.sessions.save(session.id, session.layout, session.maximizedGroupId, session.closedTabs)
      if (reveal) {
        if (activeProjectIdRef.current !== session.projectId) await loadProject(session.projectId, session.id)
        flushSync(() => { selectSession(session); setFocusedGroupId(groupId); setUtilityPanel(null) })
      }
    },
    detach: async (session, tab, layout) => window.conductor.window.detach(session.projectId, session.id, tab, layout),
    openFile: (projectId, path) => openWorkspaceFile(projectId, path)
  })

  const agentConfirm = useAgentConfirm()

  useEffect(() => window.conductor.window.onDetachedClosed(({ sessionId }) => {
    if (!activeProjectId || !sessions.some((session) => session.id === sessionId)) return
    void window.conductor.sessions.list(activeProjectId).then(setSessions)
  }), [activeProjectId, sessions])

  const commands = useMemo<PaletteCommand[]>(() => [
    { id: 'open-claude', label: 'Open Claude Code', detail: 'Open in the focused tab group', category: 'Agents', icon: 'agent', shortcut: 'Ctrl T then C', run: () => openInFocused('agent', 'claude') },
    { id: 'open-codex', label: 'Open Codex', detail: 'Open in the focused tab group', category: 'Agents', icon: 'agent', shortcut: 'Ctrl T then X', run: () => openInFocused('agent', 'codex') },
    ...LOCAL_MODELS.map(model => ({ id: 'open-' + model.id, label: `Open Local · ${model.label}`, detail: 'Runs on this machine through llama.cpp', category: 'Agents', icon: 'agent' as const, run: () => openInFocused('agent', 'local', model.id) })),
    { id: 'open-qwen', label: 'Open Qwen Code', detail: 'Open the real local Qwen runtime', category: 'Agents', icon: 'agent', shortcut: 'Ctrl T then Q', run: () => openInFocused('agent', 'qwen') },
    { id: 'open-kimi', label: 'Open Kimi Code', detail: 'Open the real local Moonshot runtime', category: 'Agents', icon: 'agent', shortcut: 'Ctrl T then K', run: () => openInFocused('agent', 'kimi') },
    { id: 'open-gemini', label: 'Open Gemini CLI', detail: 'Open the real local Google runtime', category: 'Agents', icon: 'agent', shortcut: 'Ctrl T then G', run: () => openInFocused('agent', 'gemini') },
    { id: 'open-terminal', label: 'Open PowerShell', detail: 'Create a persistent PTY', category: 'Tools', icon: 'terminal', shortcut: 'Ctrl T then T', run: () => openInFocused('terminal') },
    { id: 'open-files', label: 'Open Explorer', detail: 'Browse the active project', category: 'Workspace', icon: 'file', run: () => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'explorer' })) },
    { id: 'open-browser', label: 'Open responsive browser', detail: 'Mobile-first Chromium preview', category: 'Workspace', icon: 'browser', run: () => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' })) },
    { id: 'open-memory', label: 'Open project memory', detail: 'Open the workspace memory drawer', category: 'Workspace', icon: 'file', run: () => setUtilityPanel('memory') },
    { id: 'open-processes', label: 'Open process dashboard', detail: 'Open the workspace process drawer', category: 'Workspace', icon: 'layout', run: () => setUtilityPanel('processes') },
    { id: 'split-right', label: 'Split tab right', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Alt →', run: () => splitFocused('right') },
    { id: 'split-below', label: 'Split tab below', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Alt ↓', run: () => splitFocused('below') },
    { id: 'split-claude', label: 'Split Claude Code right', detail: 'Create and launch in one action', category: 'Agents', icon: 'agent', run: () => splitFocused('right', makeTab('agent', 'claude')) },
    { id: 'split-codex', label: 'Split Codex right', detail: 'Create and launch in one action', category: 'Agents', icon: 'agent', run: () => splitFocused('right', makeTab('agent', 'codex')) },
    { id: 'split-terminal', label: 'Split PowerShell below', detail: 'Create and launch in one action', category: 'Tools', icon: 'terminal', run: () => splitFocused('below', makeTab('terminal')) },
    { id: 'reopen', label: 'Reopen closed tab', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Shift T', run: reopenClosed },
    { id: 'next-tab', label: 'Next tab', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Tab', run: () => cycleFocusedTab(1) },
    { id: 'previous-tab', label: 'Previous tab', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Shift Tab', run: () => cycleFocusedTab(-1) },
    { id: 'grow-tab', label: 'Grow tab area', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Shift →', run: () => nudgeFocusedGroup('right') },
    { id: 'shrink-tab', label: 'Shrink tab area', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Shift ←', run: () => nudgeFocusedGroup('left') },
    { id: 'snap-tab', label: 'Snap tab area to the next stop', detail: 'Preset widths instead of a 5% nudge', category: 'Layout', icon: 'layout', run: () => nudgeFocusedGroup('right', true) },
    { id: 'move-tab-right', label: 'Move tab right', detail: 'Relocate the tab itself, not the divider', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Shift Alt →', run: () => moveFocusedTabTo('right') },
    { id: 'move-tab-left', label: 'Move tab left', detail: 'Relocate the tab itself, not the divider', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Shift Alt ←', run: () => moveFocusedTabTo('left') }
  ], [cycleFocusedTab, moveFocusedTabTo, nudgeFocusedGroup, openInFocused, reopenClosed, splitFocused])

  // The subagent roster links a background task back to the runtime it is driving.
  useEffect(() => {
    const openRuntime = (event: Event): void => {
      const provider = (event as CustomEvent<AgentProviderId>).detail
      if (provider) openInFocused('agent', provider)
    }
    window.addEventListener('conductor:open-runtime', openRuntime)
    return () => window.removeEventListener('conductor:open-runtime', openRuntime)
  }, [openInFocused])

  const chordArmed = useRef(false)
  const chordTimer = useRef(0)
  const disarmChord = useCallback((): void => {
    chordArmed.current = false
    if (chordTimer.current) { window.clearTimeout(chordTimer.current); chordTimer.current = 0 }
  }, [])
  const armChord = useCallback((): void => {
    disarmChord()
    chordArmed.current = true
    chordTimer.current = window.setTimeout(disarmChord, CHORD_TIMEOUT_MS)
  }, [disarmChord])
  useEffect(() => disarmChord, [disarmChord])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (event.ctrlKey && !event.altKey && !event.shiftKey && (key === '+' || key === '=' || event.code === 'NumpadAdd')) {
        event.preventDefault()
        void setZoom(appSettings.zoomFactor + 0.05)
        return
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && (key === '-' || event.code === 'NumpadSubtract')) {
        event.preventDefault()
        void setZoom(appSettings.zoomFactor - 0.05)
        return
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === '0') {
        event.preventDefault()
        void setZoom(1.1)
        return
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'w') {
        event.preventDefault()
        event.stopPropagation()
        closeFocusedTab()
        return
      }
      if ((event.ctrlKey && event.shiftKey && key === 'p') || (event.ctrlKey && key === 'k')) {
        event.preventDefault()
        setPaletteOpen((value) => !value)
        return
      }
      if (event.ctrlKey && event.altKey && !event.shiftKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        event.preventDefault()
        const edge = ({ arrowleft: 'left', arrowright: 'right', arrowup: 'above', arrowdown: 'below' } as const)[key as 'arrowleft']
        splitFocused(edge)
        return
      }
      // Ctrl+T opens the launcher immediately; a follow-up key swaps that launcher for
      // the chosen runtime, so the chord never leaves the user staring at a dead shortcut.
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 't') {
        event.preventDefault()
        openInFocused('launcher')
        armChord()
        return
      }
      // The launcher prints these keys on its own buttons, so they keep working for as long
      // as it is the focused tab; the timed chord only covers the moment right after Ctrl+T.
      const focusedTab = activeSession
        ? (() => {
            const focused = findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
            return focused?.tabs.find((tab) => tab.id === focused.activeTabId) ?? null
          })()
        : null
      if ((chordArmed.current || focusedTab?.kind === 'launcher') && !event.ctrlKey && !event.altKey && !event.metaKey && !isEditingTarget(event.target)) {
        const target = TAB_CHORD[key]
        const armed = chordArmed.current
        disarmChord()
        if (target) {
          event.preventDefault()
          openInFocused(target.kind, target.provider, target.model)
          return
        }
        // Escape only cancels a chord that is actually pending; a focused launcher must not
        // swallow the key that closes dialogs and stops runs.
        if (armed && key === 'escape') { event.preventDefault(); return }
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && key === 't') {
        event.preventDefault()
        reopenClosed()
        return
      }
      const group = activeSession ? findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0] : null
      if (event.ctrlKey && !event.altKey && key === 'tab' && group) {
        event.preventDefault()
        event.stopPropagation()
        cycleFocusedTab(event.shiftKey ? -1 : 1)
        return
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && (key === 'pageup' || key === 'pagedown')) {
        event.preventDefault()
        cycleFocusedTab(key === 'pagedown' ? 1 : -1)
        return
      }
      // Chrome semantics: plain Ctrl+digit picks a tab, so workspaces move to Ctrl+Shift+digit.
      if (event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key) && group && activeSession) {
        const next = tabIdAtChromeIndex(group, Number(event.key))
        if (next) {
          event.preventDefault()
          setLayout(activateTab(activeSession.layout, group.id, next))
          setFocusedGroupId(group.id)
          return
        }
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && /^[1-9]$/.test(event.code.replace('Digit', ''))) {
        const target = sessions[Number(event.code.replace('Digit', '')) - 1]
        if (target) { event.preventDefault(); selectSession(target); return }
      }
      // Ctrl+Shift+Arrow collides with word selection, so it stays out of text surfaces.
      // Adding Alt relocates the tab; without it the arrow resizes the pane.
      if (event.ctrlKey && event.shiftKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && !isEditingTarget(event.target)) {
        event.preventDefault()
        const direction = ({ arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down' } as const)[key as 'arrowleft']
        if (event.altKey) moveFocusedTabTo(direction)
        else nudgeFocusedGroup(direction)
        return
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'Enter' && activeSession) {
        event.preventDefault()
        setMaximized(activeSession.maximizedGroupId ? null : focusedGroupId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeSession, appSettings.zoomFactor, armChord, closeFocusedTab, closeSession, cycleFocusedTab, disarmChord, focusedGroupId, moveFocusedTabTo, nudgeFocusedGroup, openInFocused, reopenClosed, selectSession, sessions, setLayout, setMaximized, setZoom, splitFocused])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const focusProcess = (event: Event): void => {
      const process = (event as CustomEvent<{ id: string; sessionId: string }>).detail
      const session = sessions.find((item) => item.id === process.sessionId)
      // The drawer sits beside the panes, so Project tasks stays open across the jump; a
      // short pulse is what tells you which tab just took the focus.
      const spotlightTab = (tabId: string): void => { window.dispatchEvent(new CustomEvent('conductor:spotlight-tab', { detail: { tabId } })) }
      if (!session) {
        setToast('That runtime belongs to a workspace that is not currently available.')
        return
      }
      const containingGroup = listGroups(session.layout.root).find((group) =>
        group.tabs.some((tab) => tab.resourceId === process.id)
      )
      if (containingGroup) {
        const tab = containingGroup.tabs.find((item) => item.resourceId === process.id)!
        const layout = activateTab(session.layout, containingGroup.id, tab.id)
        setSessions((current) => current.map((item) => item.id === session.id ? { ...item, layout } : item))
        selectSession({ ...session, layout })
        setFocusedGroupId(containingGroup.id)
        spotlightTab(tab.id)
        return
      }
      const closed = [...session.closedTabs].reverse().find((tab: PaneTab) => tab.resourceId === process.id)
      const target = listGroups(session.layout.root)[0]
      if (closed && target) {
        const layout = addTab(session.layout, target.id, closed)
        const reopened = { ...session, layout, closedTabs: session.closedTabs.filter((tab) => tab.id !== closed.id) }
        setSessions((current) => current.map((item) => item.id === session.id ? reopened : item))
        selectSession(reopened)
        setFocusedGroupId(target.id)
        spotlightTab(closed.id)
        setToast(`Reopened ${closed.title}`)
      } else setToast('This process no longer has an open runtime tab.')
    }
    window.addEventListener('conductor:focus-process', focusProcess)
    return () => window.removeEventListener('conductor:focus-process', focusProcess)
  }, [selectSession, sessions])

  return (
    <div className="app-shell">
      <TitleBar
        projectName={activeProject?.name}
        sessionName={sessionName}
        themeVariant={resolvedThemeVariant}
        themeAuto={appSettings.themeAuto}
        themeId={appSettings.themeId}
        onTheme={(id) => void window.conductor.settings.setTheme(id).then(setAppSettings)}
        onThemeAuto={(enabled) => void window.conductor.settings.setThemeAuto(enabled).then(setAppSettings)}
        onThemeVariant={(variant) => void chooseManualThemeVariant(variant)}
        onNewProject={() => void createManagedProject()}
        onOpenProject={() => void openExistingProject()}
        onOpenSession={() => void openNamedSession()}
        onSaveSession={() => void saveNamedSession()}
        onOpenWorkspace={activeProject ? () => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'workspace' })) : undefined}
        onNewWorkspace={activeProject ? () => void newSession() : undefined}
        onNewTab={activeSession ? () => openInFocused('launcher') : undefined}
        onCloseWorkspace={activeSession ? () => void closeSession(activeSession.id) : undefined}
        onSettings={() => setSettingsOpen(true)}
        updateState={updateState}
      />
      <div className="app-body">
        <Sidebar
          projects={projects}
          sessions={sessions}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          onSelectProject={(id) => void loadProject(id)}
          onSelectSession={(id) => { const session = sessions.find((item) => item.id === id); if (session) selectSession(session) }}
          onCreateProject={() => void createManagedProject()}
          renameProjectId={renameProjectId}
          onRenameProject={renameProject}
          onProjectRenameComplete={() => setRenameProjectId(null)}
          onOpenExistingProject={() => void openExistingProject()}
          onMoveProject={(id) => void moveProject(id)}
          onRemoveProject={removeProject}
          onTabAction={(sessionId, groupId, tabId, action) => void sidebarTabAction(sessionId, groupId, tabId, action)}
          onTabGroupAction={sidebarTabGroupAction}
          onRevealProject={(path) => void window.conductor.projects.reveal(path)}
          onNewSession={() => void newSession()}
          onCloseSession={(id) => void closeSession(id)}
          onRenameSession={(id, name) => void renameSession(id, name)}
          canRestoreWorkspace={closedWorkspaces.length > 0}
          onRestoreWorkspace={() => void restoreWorkspace()}
          onReorderProjects={(ids) => { void window.conductor.projects.reorder(ids).then(setProjects).catch((reason: unknown) => setToast(String(reason))) }}
          onReorderSessions={(ids) => { if (activeProjectId) { const projectId = activeProjectId; void window.conductor.sessions.reorder(projectId, ids).then((ordered) => { if (activeProjectIdRef.current === projectId) setSessions((current) => ordered.map((item) => current.find((existing) => existing.id === item.id) ?? item)) }).catch((reason: unknown) => setToast(String(reason))) } }}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((current) => {
            localStorage.setItem('conductor.sidebarCollapsed', String(!current))
            return !current
          })}
          onOpenTab={(kind) => openInFocused(kind)}
          onOpenFile={openExplorerFile}
          onPathChanged={handleExplorerPathChanged}
          onPathRemoved={handleExplorerPathRemoved}
          onProjectRenamed={(project) => setProjects((current) => current.map((item) => item.id === project.id ? project : item))}
          utilityPanel={utilityPanel}
          onUtilityPanel={setUtilityPanel}
          attentionIds={attentionSessionIds}
          sessionActivity={sessionActivityStatuses}
          activityPhases={correctedActivityPhases}
          projectActivity={projectActivityStatuses}
          remoteFiles={selectedRemoteMachine && activeProject ? {
            machineId: selectedRemoteMachine.id,
            machineName: selectedRemoteMachine.name,
            projectId: activeProject.id,
            onOpenFile: file => openWorkspaceFile(file.projectId, file.path, 'editor', undefined, undefined, file.machineId),
            onAttachFile: attachment => { if (!dispatchAgentContext(activeProject.id, attachment)) setToast('Focus a conversation in this project before attaching a remote file.') }
          } : undefined}
        />
        <div className="main-stage">
          {activeProject ? (
            <>
              <SessionBar
                sessions={sessions}
                activeId={activeSession?.id ?? ''}
                canReopen={Boolean(activeSession?.closedTabs.length)}
                canRestoreWorkspace={closedWorkspaces.length > 0}
                onRestoreWorkspace={() => void restoreWorkspace()}
                templates={templates}
                onSelect={(id) => { const session = sessions.find((item) => item.id === id); if (session) selectSession(session) }}
                onNew={() => void newSession()}
                onClose={(id) => closeSession(id)}
                onRename={(id, name) => void renameSession(id, name)}
                onReopen={reopenClosed}
                onPalette={() => setPaletteOpen(true)}
                onSaveTemplate={(name) => void saveTemplate(name)}
                onApplyTemplate={applyTemplate}
                continueOnLimit={Boolean(activeSession?.continueOnLimit)}
                attentionIds={attentionSessionIds}
                saveStatus={saveStatus}
                lastSavedAt={lastSavedAt}
                onSave={() => void saveWorkspaceNow()}
                onContinuation={(enabled) => {
                  if (!activeSession) return
                  patchActiveSession((session) => ({ ...session, continueOnLimit: enabled }))
                  void window.conductor.sessions.setContinuation(activeSession.id, enabled)
                }}
              />
              <div className={`workspace-content-shell utility-${utilitySide} ${utilityPanel ? 'has-utility' : ''} ${utilityDragging ? 'utility-is-dragging' : ''} ${utilityResizing ? 'utility-is-resizing' : ''}`}>
                <div className="workspace-content-main">
                  {activeSession ? (
                    <>
                      <div className="runtime-document-stage" onDragOver={event => { if (event.dataTransfer.types.includes(CONDUCTOR_FILE_DRAG)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDrop={openDroppedProjectFile}>
                        <PaneWorkspace
                          key={activeSession.id}
                          layout={activeSession.layout}
                          project={activeProject}
                          session={activeSession}
                          focusedGroupId={focusedGroupId}
                          maximizedGroupId={activeSession.maximizedGroupId}
                          onLayout={setLayout}
                          onPersistLayout={layout => window.conductor.sessions.save(activeSession.id, layout, activeSession.maximizedGroupId, activeSession.closedTabs)}
                          onFocus={setFocusedGroupId}
                          onMaximize={setMaximized}
                          onClosed={rememberClosed}
                          onDetach={detachTab}
                          canReopen={activeSession.closedTabs.length > 0}
                          onReopen={reopenClosed}
                          onOpenFile={(path, line, mode, allowBinary) => openWorkspaceFile(activeProject.id, path, mode ?? 'auto', line, allowBinary)}
                          onMachinePlacement={setSelectedMachineId}
                          correctedActivityPhases={correctedActivityPhases}
                        />
                        <WorkspaceFiles key={'files:' + activeSession.id} projects={projects} projectId={activeProject.id} workspaceId={activeSession.id} showHiddenFilesDefault={appSettings.showHiddenFiles} />
                      </div>
                    </>
                  ) : (
                    <div className="runtime-document-stage" onDragOver={event => { if (event.dataTransfer.types.includes(CONDUCTOR_FILE_DRAG)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDrop={openDroppedProjectFile}><div className="no-workspace-state">
                      <div className="empty-orbit"><LayoutPanelTop size={30} /></div>
                      <strong>No workspace open</strong>
                      <button onClick={() => void newSession()}><Plus size={17} /> New workspace</button>
                    </div><WorkspaceFiles key={'files:project:' + activeProject.id} projects={projects} projectId={activeProject.id} workspaceId={'project:' + activeProject.id} showHiddenFilesDefault={appSettings.showHiddenFiles} /></div>
                  )}
                </div>
                {utilityPanel && (
                  <aside
                    className={`workspace-utility-drawer utility-${utilitySide} ${['agents', 'tasks', 'routines'].includes(utilityPanel) ? 'orchestration-drawer' : ''}`}
                    aria-label={utilityMeta.aria}
                    style={{ width: activeUtilityWidth, flexBasis: activeUtilityWidth }}
                  >
                    <button
                      className="utility-column-resizer"
                      onPointerDown={beginUtilityResize}
                      title={`Resize ${utilityMeta.label}`}
                      aria-label={`Resize ${utilityMeta.label} column`}
                    />
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
                        <utilityMeta.icon size={19} />
                        <span>
                          <strong>{utilityMeta.label}</strong>
                        </span>
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
                        ? <ProjectBacklogPane key={activeProject.id} project={activeProject} />
                        : utilityPanel === 'memory'
                        ? <MemoryPane project={activeProject} />
                        : utilityPanel === 'processes'
                          ? <ProcessDashboardPane project={activeProject} />
                          : <OrchestrationHub
                              key={utilityPanel}
                              projectId={activeProject.id}
                              initialView={utilityPanel}
                            />}
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
              </div>
            </>
          ) : !loading ? (
            <EmptyState onOpen={() => void createManagedProject()} />
          ) : (
            <div className="app-loading"><i style={spinPhaseStyle(Date.now())} /><span>Restoring your workspace</span></div>
          )}
        </div>
      </div>
      <footer className="statusbar app-statusbar">
        {activeProject && activeSession && <>
          <span><GitBranch size={12} /> working tree</span>
          <span><Radio size={11} /> local</span>
          <button
            className="statusbar-link"
            onClick={() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: { mode: 'browser', toggle: true } }))}
            title="Toggle responsive browser"
          ><Globe2 size={11} /> Browser</button>
        </>}
        <span className="status-spacer" />
        <AppUpdateButton state={updateState} onAction={() => void runUpdateAction()} />
        {activeProject && activeSession && <>
          <TabPerformancePopover
            tabs={activeWorkspaceTabs}
            activeTabIds={activeWorkspaceTabIds}
            projectId={activeProject.id}
            sessionId={activeSession.id}
          />
          <span><HardDrive size={12} /> SQLite</span>
          <span className="accent-status"><Zap size={11} /> ready</span>
        </>}
        {updateState.currentVersion && <AppVersionButton state={updateState} onCheck={checkForUpdates} />}
      </footer>
      {paletteOpen && activeSession && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && (
        <SettingsPanel
          settings={appSettings}
          onClose={() => setSettingsOpen(false)}
          onChooseProjectsRoot={() => {
            void window.conductor.settings.chooseProjectsRoot().then(setAppSettings)
          }}
          onSetZoom={(value) => void setZoom(value)}
          onSetTheme={(value) => void setTheme(value)}
          onSetThemeVariant={(value) => void setThemeVariant(value)}
          onSetThemeAuto={(enabled) => void setThemeAuto(enabled)}
          onSetAgentSoundProfile={(profile) => void setAgentSoundProfile(profile)}
          onSetDebugLogging={(enabled) => void setDebugLogging(enabled)}
          onSetShowHiddenFiles={(enabled) => void setShowHiddenFiles(enabled)}
          onSetDefaultNewFileExtension={(extension) => window.conductor.settings.setDefaultNewFileExtension(extension).then((saved) => { setAppSettings(saved); return saved })}
          updateState={updateState}
          onSetLocalUpdates={(enabled) => void window.conductor.settings.setLocalUpdates(enabled).then(setAppSettings).catch((error: unknown) => setToast(String(error)))}
          onCheckForUpdates={() => void checkForUpdates()}
          onOpenDebugConsole={() => {
            setDebugConsoleOpen(true)
            setSettingsOpen(false)
          }}
        />
      )}
      {updateState.availableVersion && updateState.availableVersion !== dismissedUpdateVersion && ['available', 'downloading', 'ready', 'installing', 'error'].includes(updateState.phase) && (
        <UpdatePrompt
          state={updateState}
          autoDownload={autoDownload}
          onAutoDownload={setAutoDownload}
          onAction={() => void runUpdateAction()}
          onDismiss={() => setDismissedUpdateVersion(updateState.availableVersion ?? null)}
        />
      )}
      {agentConfirm.request && <AgentConfirmDialog request={agentConfirm.request} onRespond={agentConfirm.respond} />}
      {appSettings.debugLogging && debugConsoleOpen && (
        <DebugConsole
          context={debugContext}
          onClose={() => setDebugConsoleOpen(false)}
          onCopied={() => setToast('Issue report copied')}
          onDetach={() => {
            void window.conductor.debug.openWindow(true).then(() => setDebugConsoleOpen(false))
          }}
        />
      )}
      {appSettings.debugLogging && !debugConsoleOpen && (
        <button className="debug-console-launcher" onClick={() => setDebugConsoleOpen(true)}>Debug</button>
      )}
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  )
}
