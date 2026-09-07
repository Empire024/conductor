import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Bot, Brain, Gauge, GitBranch, Globe2, HardDrive, LayoutPanelTop, PanelLeft, PanelRight, Plus, Radio, Workflow, X, Zap } from 'lucide-react'
import type {
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
import { createPaneTab } from './panes/pane-factory'
import { MemoryPane } from './panes/MemoryPane'
import { ProcessDashboardPane } from './panes/ProcessDashboardPane'
import { OrchestrationHub } from './components/OrchestrationHub'
import { WorkspaceFiles } from './components/WorkspaceFiles'
import { openWorkspaceFile, changeWorkspacePath, workspaceFileIds } from './components/workspace-files-state'
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
import { getAttentionSessionIds, retainVisibleAttentionResources } from './attention'
import { migrateLegacyCodexModels, migrateLegacyCodexTab } from './agent-models'
import { useAppUpdates } from './use-app-updates'
import { TabPerformancePopover } from './components/TabPerformancePopover'
import { playAgentSound } from './agent-sounds'
import { AppUpdateButton } from './components/AppUpdateButton'
import { UpdatePrompt } from './components/UpdatePrompt'

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [focusedGroupId, setFocusedGroupId] = useState('')
  const [templates, setTemplates] = useState<LayoutTemplateRecord[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [utilityPanel, setUtilityPanel] = useState<WorkspacePanel | null>(() => {
    const saved = localStorage.getItem('conductor.utilityPanel')
    return ['agents', 'tasks', 'routines', 'memory', 'processes'].includes(saved ?? '')
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
  const [debugConsoleOpen, setDebugConsoleOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const { updateState, autoDownload, setAutoDownload, runUpdateAction, checkForUpdates } = useAppUpdates()
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null)

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null
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
  const recoveryReadyRef = useRef(false)
  const checkpointTimerRef = useRef<number | null>(null)
  const saveRevisionRef = useRef(0)
  const soundProfileRef = useRef(appSettings.agentSoundProfile)
  sessionsRef.current = sessions
  activeProjectIdRef.current = activeProjectId
  activeSessionIdRef.current = activeSessionId
  soundProfileRef.current = appSettings.agentSoundProfile
  if (activeSessionId && focusedGroupId) focusedGroupIdsRef.current[activeSessionId] = focusedGroupId

  const recoveryCheckpoint = useCallback((): WorkspaceRecoveryCheckpoint => ({
    activeProjectId: activeProjectIdRef.current,
    activeSessionId: activeSessionIdRef.current,
    focusedGroupIds: { ...focusedGroupIdsRef.current },
    sessions: sessionsRef.current.map((session) => ({
      id: session.id,
      layout: session.layout,
      maximizedGroupId: session.maximizedGroupId,
      closedTabs: session.closedTabs
    }))
  }), [])
  const utilityMeta = utilityPanel === 'memory'
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
    const next = loaded.find((session) => session.id === preferredSessionId) ?? loaded[0]
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
      if (settings.debugLogging) setDebugConsoleOpen(true)
      focusedGroupIdsRef.current = recovery.focusedGroupIds
      const project = loaded.find((item) => item.id === recovery.activeProjectId) ?? loaded[0]
      if (project) await loadProject(project.id, recovery.activeSessionId ?? undefined)
    }).catch((reason: unknown) => {
      setToast(reason instanceof Error ? reason.message : 'Conductor could not restore the workspace')
    }).finally(() => {
      recoveryReadyRef.current = true
      setLoading(false)
    })
  }, [loadProject])

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
    const onActivity = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; phase: string }>).detail
      if (phases.get(detail.id) === detail.phase) return
      phases.set(detail.id, detail.phase)
      debugLog('agent', `Activity changed to ${detail.phase}`, { resourceId: detail.id })
      setAttentionResourceIds((current) => {
        const next = new Set(current)
        if (detail.phase === 'waiting_input') next.add(detail.id)
        else next.delete(detail.id)
        return next
      })
    }
    window.addEventListener('conductor:agent-activity', onActivity)
    return () => window.removeEventListener('conductor:agent-activity', onActivity)
  }, [])

  useEffect(() => {
    setAttentionResourceIds((current) => {
      const next = retainVisibleAttentionResources(sessions, current)
      return next.size === current.size ? current : next
    })
  }, [sessions])

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
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribeUpdate = window.conductor.updates.onPrepareInstall(({ requestId }) => {
      flushRecovery()
      window.conductor.updates.acknowledgePrepare(requestId)
    })
    return () => {
      window.removeEventListener('pagehide', flushRecovery)
      window.removeEventListener('beforeunload', flushRecovery)
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
    const closingIndex = sessions.findIndex((session) => session.id === sessionId)
    if (closingIndex < 0 || !activeProject) return

    debugLog('workspace', 'Workspace close requested', { sessionId }, 'info')
    const remaining = sessions.filter((session) => session.id !== sessionId)
    const fallback = remaining[Math.min(closingIndex, remaining.length - 1)]
    window.dispatchEvent(new Event('conductor:flush-editors'))
    if (!await window.conductor.files.confirmClose(workspaceFileIds(undefined, sessionId))) return
    await window.conductor.sessions.delete(sessionId)
    const apply = (): void => {
      setSessions(remaining)
      if (activeSessionId === sessionId) {
        if (fallback) selectSession(fallback)
        else {
          setActiveSessionId(null)
          setFocusedGroupId('')
        }
      }
    }
    const transitionDocument = document as Document & { startViewTransition?: (update: () => void) => unknown }
    if (transitionDocument.startViewTransition) transitionDocument.startViewTransition(() => flushSync(apply))
    else apply()
    debugLog('workspace', 'Workspace closed', { sessionId }, 'info')
  }, [activeProject, activeSessionId, selectSession, sessions])

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

  const makeTab = (kind: PaneKind, provider?: AgentProviderId): PaneTab =>
    createPaneTab(kind, { provider })

  const openInFocused = useCallback((kind: PaneKind, provider?: AgentProviderId): void => {
    if (!['launcher', 'agent', 'terminal'].includes(kind)) return
    if (!activeSession) return
    const group = findGroup(activeSession.layout.root, focusedGroupId) ?? listGroups(activeSession.layout.root)[0]
    if (!group) return
    const tab = kind === 'launcher' ? makeLauncherTab() : makeTab(kind, provider)
    const activeTab = group.tabs.find((item) => item.id === group.activeTabId)
    const layout = activeTab?.kind === 'launcher'
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

  const detachTab = useCallback((groupId: string, tab: PaneTab): void => {
    if (!activeProject || !activeSession) return
    const result = closeTab(activeSession.layout, groupId, tab.id)
    if (!result.closed) return
    setLayout(result.layout)
    void window.conductor.window.detach(activeProject.id, activeSession.id, result.closed, result.layout)
  }, [activeProject, activeSession, setLayout])

  useEffect(() => window.conductor.window.onDetachedClosed(({ sessionId }) => {
    if (!activeProjectId || !sessions.some((session) => session.id === sessionId)) return
    void window.conductor.sessions.list(activeProjectId).then(setSessions)
  }), [activeProjectId, sessions])

  const commands = useMemo<PaletteCommand[]>(() => [
    { id: 'open-claude', label: 'Open Claude Code', detail: 'Open in the focused tab group', category: 'Agents', icon: 'agent', run: () => openInFocused('agent', 'claude') },
    { id: 'open-codex', label: 'Open Codex', detail: 'Open in the focused tab group', category: 'Agents', icon: 'agent', run: () => openInFocused('agent', 'codex') },
    { id: 'open-qwen', label: 'Open Qwen Code', detail: 'Open the real local Qwen runtime', category: 'Agents', icon: 'agent', run: () => openInFocused('agent', 'qwen') },
    { id: 'open-kimi', label: 'Open Kimi Code', detail: 'Open the real local Moonshot runtime', category: 'Agents', icon: 'agent', run: () => openInFocused('agent', 'kimi') },
    { id: 'open-gemini', label: 'Open Gemini CLI', detail: 'Open the real local Google runtime', category: 'Agents', icon: 'agent', run: () => openInFocused('agent', 'gemini') },
    { id: 'open-terminal', label: 'Open PowerShell', detail: 'Create a persistent PTY', category: 'Tools', icon: 'terminal', shortcut: 'Ctrl `', run: () => openInFocused('terminal') },
    { id: 'open-files', label: 'Open Explorer', detail: 'Browse the active project', category: 'Workspace', icon: 'file', run: () => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'explorer' })) },
    { id: 'open-browser', label: 'Open responsive browser', detail: 'Mobile-first Chromium preview', category: 'Workspace', icon: 'browser', run: () => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' })) },
    { id: 'open-memory', label: 'Open project memory', detail: 'Open the workspace memory drawer', category: 'Workspace', icon: 'file', run: () => setUtilityPanel('memory') },
    { id: 'open-processes', label: 'Open process dashboard', detail: 'Open the workspace process drawer', category: 'Workspace', icon: 'layout', run: () => setUtilityPanel('processes') },
    { id: 'split-right', label: 'Split tab right', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Alt →', run: () => splitFocused('right') },
    { id: 'split-below', label: 'Split tab below', category: 'Layout', icon: 'layout', shortcut: 'Ctrl Alt ↓', run: () => splitFocused('below') },
    { id: 'split-claude', label: 'Split Claude Code right', detail: 'Create and launch in one action', category: 'Agents', icon: 'agent', run: () => splitFocused('right', makeTab('agent', 'claude')) },
    { id: 'split-codex', label: 'Split Codex right', detail: 'Create and launch in one action', category: 'Agents', icon: 'agent', run: () => splitFocused('right', makeTab('agent', 'codex')) },
    { id: 'split-terminal', label: 'Split PowerShell below', detail: 'Create and launch in one action', category: 'Tools', icon: 'terminal', run: () => splitFocused('below', makeTab('terminal')) },
    { id: 'reopen', label: 'Reopen closed tab', category: 'Layout', icon: 'layout', run: reopenClosed }
  ], [openInFocused, reopenClosed, splitFocused])

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
        if (!closeFocusedTab() && activeSession) void closeSession(activeSession.id)
        return
      }
      if ((event.ctrlKey && event.shiftKey && key === 'p') || (event.ctrlKey && key === 'k')) {
        event.preventDefault()
        setPaletteOpen((value) => !value)
        return
      }
      if (event.ctrlKey && event.altKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        event.preventDefault()
        const edge = ({ arrowleft: 'left', arrowright: 'right', arrowup: 'above', arrowdown: 'below' } as const)[key as 'arrowleft']
        splitFocused(edge)
        return
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const target = sessions[Number(event.key) - 1]
        if (target) { event.preventDefault(); selectSession(target) }
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'Enter' && activeSession) {
        event.preventDefault()
        setMaximized(activeSession.maximizedGroupId ? null : focusedGroupId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeSession, appSettings.zoomFactor, closeFocusedTab, closeSession, focusedGroupId, selectSession, sessions, setMaximized, setZoom, splitFocused])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const focusProcess = (event: Event): void => {
      const process = (event as CustomEvent<{ id: string; sessionId: string }>).detail
      const session = sessions.find((item) => item.id === process.sessionId)
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
        setUtilityPanel(null)
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
        setUtilityPanel(null)
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
        themeVariant={resolvedThemeVariant}
        themeAuto={appSettings.themeAuto}
        themeId={appSettings.themeId}
        onTheme={(id) => void window.conductor.settings.setTheme(id).then(setAppSettings)}
        onThemeAuto={(enabled) => void window.conductor.settings.setThemeAuto(enabled).then(setAppSettings)}
        onThemeVariant={(variant) => void chooseManualThemeVariant(variant)}
        onNewProject={() => void createManagedProject()}
        onOpenProject={() => void openExistingProject()}
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
          onRemoveProject={(id) => void removeProject(id)}
          onRevealProject={(path) => void window.conductor.projects.reveal(path)}
          onNewSession={() => void newSession()}
          onCloseSession={(id) => void closeSession(id)}
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
        />
        <div className="main-stage">
          {activeProject ? (
            <>
              <SessionBar
                sessions={sessions}
                activeId={activeSession?.id ?? ''}
                canReopen={Boolean(activeSession?.closedTabs.length)}
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
                      <div className="runtime-document-stage">
                        <PaneWorkspace
                          key={activeSession.id}
                          layout={activeSession.layout}
                          project={activeProject}
                          session={activeSession}
                          focusedGroupId={focusedGroupId}
                          maximizedGroupId={activeSession.maximizedGroupId}
                          onLayout={setLayout}
                          onFocus={setFocusedGroupId}
                          onMaximize={setMaximized}
                          onClosed={rememberClosed}
                          onDetach={detachTab}
                          canReopen={activeSession.closedTabs.length > 0}
                          onReopen={reopenClosed}
                          onOpenFile={(path, line) => openWorkspaceFile(activeProject.id, path, 'editor', line)}
                        />
                        <WorkspaceFiles key={'files:' + activeSession.id} projects={projects} projectId={activeProject.id} workspaceId={activeSession.id} />
                      </div>
                    </>
                  ) : (
                    <div className="runtime-document-stage"><div className="no-workspace-state">
                      <div className="empty-orbit"><LayoutPanelTop size={30} /></div>
                      <strong>No workspace open</strong>
                      <button onClick={() => void newSession()}><Plus size={17} /> New workspace</button>
                    </div><WorkspaceFiles key={'files:project:' + activeProject.id} projects={projects} projectId={activeProject.id} workspaceId={'project:' + activeProject.id} /></div>
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
                      {utilityPanel === 'memory'
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
            <div className="app-loading"><i /><span>Restoring your workspace</span></div>
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
