import { encodeRestartInitiator, encodeRestartRequest, launchRestartInitiator, parseRestartRequest, RESTART_INITIATOR_KEY, RESTART_REQUEST_KEY, wizardTabsToResume, type RestartInitiator, type RestartRequest } from './restart-initiator'
import { StopConfirmations, type StopDecision } from './stop-confirmation'
import { connectRuntimeHost } from './runtime-host/launcher'
import type { RuntimeHostClient } from './runtime-host/client'
import { setRuntimeHost } from './providers/transport'
import { ConversationHistory, registerConversationHistoryIpc } from './conversation-history'
import { guardLayoutSave } from './layout-save-guard'
import { WeeklyUsageSummaryService } from './weekly-usage-summary'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fs, readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { importPromptImage } from './prompt-images'
import { importPromptAttachmentPath, projectPromptAttachment } from './prompt-context'
import { moveExternalDropIntoProject, moveProjectDropWithinProject } from './file-drop-move'
import { ProjectBacklogs } from './project-backlog'
import type { ProjectTaskListQuery } from '../shared/project-backlog'
import { ProjectTaskDispatcher } from './project-task-dispatch'
import { SourceControl } from './source-control'
import { pruneDiffSnapshots } from './agent-artifacts'
import type { RevertScope } from '../shared/agent-change-history'
import { AgentControl } from './agent-control'
import { AgentControlServer } from './agent-control-server'
import { AgentControlUi } from './agent-control-ui'
import { BrowserMcpServer } from './browser-mcp'
import { startLocalAssist, type LocalAssist } from './local-assist/wiring'
import { BrowserViews } from './browser-views'
import { RemoteControlService } from './remote-control-ipc'
import { safeStorageCipher } from './safe-storage-vault'
import { ProjectFileChanges } from './project-file-changes'
import { isStructuredRendererUrl } from './structured-ipc-policy'
import { installContextMenu } from './context-menu'
import { app, BrowserWindow, clipboard, ipcMain, Menu, powerMonitor, screen, shell, webContents } from 'electron'
import * as testDialogs from './test-mode-dialogs'
import { startTestModeWatchdog } from './test-mode-watchdog'
import { SystemMetricsSampler } from './system-metrics.ts'
import type { SystemMetricsSnapshot } from '../shared/system-metrics.ts'
import { CloseConfirmation, hasRunningWork, hasSessionWork } from './close-confirmation'
import { readSessionArchive, writeSessionArchive } from './session-archive'
import type {
  AgentSpec,
  AgentSoundProfile,
  AppSettings,
  DebugConsoleSnapshot,
  PaneTab,
  ProjectRecord,
  RememberMemoryInput,
  TerminalSpec,
  ThemeId,
  ThemeVariant,
  WorkspaceRecoveryCheckpoint,
  UpdateMemoryInput,
  WorkspaceLayout
} from '../shared/models'
import { AGENT_SOUND_PROFILES, isMemoryKind, THEME_IDS, THEME_VARIANTS } from '../shared/models'
import type { LayoutNode } from '../shared/models'
import { wizardActive } from '../shared/structured-agent'
import type { AgentConfirmResponse } from '../shared/agent-confirm'
import { AgentConfirmBroker } from './agent-confirm-broker'
import { ConductorDatabase } from './database'
import { TerminalManager } from './terminal-manager'
import { AgentManager, onAgentStatusChange, onBroadcast } from './agent-manager'
import { aggregateProjectActivity } from './project-activity'
import type { ProjectActivitySnapshot } from '../shared/project-activity'
import {
  isPointOutsideBounds,
  isWindowPlacementVisible,
  parseSavedWindowLayout,
  type SavedWindowLayout,
  type SavedWindowPlacement
} from './window-geometry'
import { OrchestrationStore } from './orchestration-store'
import { registerOrchestrationIpc } from './orchestration-ipc'
import { ScheduleStore } from './schedule-store'
import { createDurableJobsService, DurableJobStore, structuredStageRuntime, type DurableJobsServiceImpl } from './durable-jobs'
import { durableJobPorts, gatedRuntime } from './durable-jobs/wiring'
import { LocalGenerationGate, createLlamaServerPorts } from './durable-jobs/server-lifecycle'
import { registerDurableJobsIpc } from './durable-jobs-ipc'
import { health as llamaHealth, processAlive as llamaProcessAlive, readRunRecord, stopServer as stopLlamaServer } from './local-models/llama'
import { runningLlamaProcesses } from './local-models/resource-guard'
import { listLocalServers, stopLocalServer, type LocalStopRequest } from './local-models/servers'
import { loadConfig as loadLocalConfig, readApiKey as readLocalApiKey } from './local-models/config'
import type { ScheduleRunner } from './schedule-runner'
import { createScheduledTasks, latestModelsBuiltin } from './schedule-wiring'
import { registerScheduleIpc } from './schedule-ipc'
import { registerIdeas, type IdeasRegistration } from './ideas/register'
import { normalizeNewFileExtension, normalizeThemeSettings } from './app-settings'
import { isProjectRoot, resolveWithinProject, safeEntryName } from './project-paths'
import { isRemoteProject, localProject, requireLocalProject } from './project-scope'
import { electronTray, installHostLifecycle, type HostLifecycleController } from './host-lifecycle'
import { ensureTrayIconFile } from './tray-icon'
import { PhoneAccessService } from './phone-access'
import { PhoneProjectTasks } from './phone-project-tasks'
import { PhoneAccessServer, requestTailscaleCertificate } from './phone-access-server'
import { registerPhoneAccessIpc } from './phone-access-ipc'
import { StoredSecretVault } from './secret-store'
import type { RemoteTerminalBindings } from './remote-terminals'
import { AgentCollaborationStore } from './agent-collaboration-store'
import { AgentCollaborationRuntime } from './agent-collaboration-runtime'
import { registerAgentCollaborationIpc } from './agent-collaboration-ipc'
import { ProjectPreviewServer } from './project-preview'
import { invalidateProjectFiles, searchProjectFiles, type FileSearchResult } from './project-file-search'
import { UpdateManager } from './update-manager'
import { testInstallProfile } from './update-install-seam'
import { LocalUpdateBuilder } from './local-update-build'
import { localEndpointOverride, localModelAvailability, localTurnsInFlight, onLocalTurnStart, releaseVerdict, setLocalEndpointOverride, slotsProcessing } from './providers/local'
import { DeliveryService } from './delivery'
import { COWORKER_AUTOCLOSE_SETTING, CoworkerAutoClose, coworkerAutoCloseMinutes, normalizeCoworkerAutoCloseMinutes } from './coworker-autoclose'
import { registerDeliveryIpc } from './delivery-ipc'
import { registerLogicLoopsIpc } from './logic-loops/ipc'
import { gitHubCredential } from './github-credential'
import { normalizeUpdateFeedUrl } from './update-config'
import { createUntitledEditorFile, EDITOR_CONFLICT_MESSAGE, readEditorFile, saveEditorCopy, writeEditorFile } from './editor-files'
import { readExistingTextFile, readTextFile } from './text-files'
import { resolveUsageCap, usageCapKey } from './usage-limit'
import { parseUsageCapSetting, type UsageCapScope, type UsageCapSnapshot } from '../shared/usage-accounting'
import { LOCAL_MACHINE_ID } from '../shared/remote-control'
import type { EditorDraft } from '../shared/models'
import type { BrowserPresentation, BrowserSurfaceCommand, BrowserSurfaceRequest } from '../shared/browser-surface'
import type { SessionArchive, SessionArchiveResult } from '../shared/session-archive'

const projectPreview = new ProjectPreviewServer()
/** Host telemetry for the performance chip. Nothing is sampled until a renderer asks, and
 *  Electron's own metrics attribute the window, GPU and utility children back to Conductor. */
const systemMetrics = new SystemMetricsSampler({
  appMetrics: () => app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, cpuPercent: metric.cpu.percentCPUUsage, memoryBytes: (metric.memory.workingSetSize ?? 0) * 1024 }))
})
let weeklyUsage: WeeklyUsageSummaryService
let database: ConductorDatabase
let terminals: TerminalManager
let agents: AgentManager
let orchestration: OrchestrationStore
let disposeOrchestrationIpc: (() => void) | undefined
let schedules: ScheduleStore
let scheduleRunner: ScheduleRunner
/** Scheduled tasks' runner and the host services its panel and app control use (schedule-wiring.ts). */
let scheduledTasks: ReturnType<typeof createScheduledTasks>
/** Durable overnight local-model jobs (src/main/durable-jobs); null until the app is ready. */
let durableJobs: DurableJobsServiceImpl | null = null
let disposeDurableJobsIpc: (() => void) | undefined
let disposeDurableJobsGate: (() => void) | undefined
let disposeScheduleIpc: (() => void) | undefined
let disposeDeliveryIpc: (() => void) | undefined
let coworkerAutoClose: CoworkerAutoClose | undefined
/** The owner's Ideas inbox (src/main/ideas/register.ts); undefined until the app is ready. */
let ideasRegistration: IdeasRegistration | undefined
let disposeIdeasIpc: (() => void) | undefined
let disposeLogicLoopsIpc: (() => void) | undefined
let collaboration: AgentCollaborationStore
let disposeCollaborationIpc: (() => void) | undefined
let disposeProjectActivity: (() => void) | undefined
let projectActivityTimer: NodeJS.Timeout | null = null
let projectBacklogs: ProjectBacklogs
let projectTaskDispatcher: ProjectTaskDispatcher
let sourceControl: SourceControl
let snapshotPruneTimer: NodeJS.Timeout | undefined
let agentControlServer: AgentControlServer | undefined
let remoteControl: RemoteControlService | undefined
let phoneAccess: PhoneAccessService | undefined
let phoneServer: PhoneAccessServer | undefined
let disposePhoneIpc: (() => void) | undefined
let disposePhoneBroadcast: (() => void) | undefined
let agentControlUi: AgentControlUi | undefined
let browserMcp: BrowserMcpServer | undefined
let localAssist: LocalAssist | undefined
let browserViews: BrowserViews | undefined
let projectFileChanges: ProjectFileChanges | undefined
/** The catalog a local update build records for its compatibility report: the configured model
 *  catalog models.list answers (runtime-discovered models need a caller's tabs). Read lazily,
 *  because the agent manager exists only once the app is ready. */
const configuredModelCatalog = (): unknown => agents?.listProviders().filter(provider => ['codex', 'claude', 'grok', 'local'].includes(provider.id)).map(provider => ({
  provider: provider.id, available: provider.available, source: 'configured',
  models: provider.models.filter(model => !['default', 'auto'].includes(model.id)).map(model => ({ ...model, effort: provider.efforts.map(effort => effort.id).filter(id => id !== 'auto') }))
})) ?? []
// A test instance's app.update publishes into its own profile's feed, never the installed app's.
const localUpdateBuilder = new LocalUpdateBuilder({ modelsList: configuredModelCatalog, feedDirectory: () => testInstallProfile({ isPackaged: app.isPackaged }) ? join(app.getPath('userData'), 'local-updates') : null })
const delivery = new DeliveryService({ githubToken: () => gitHubCredential(homedir()) })
let updates: UpdateManager
let mainWindow: BrowserWindow | null = null
const detachedWindows = new Map<string, BrowserWindow>()
// Native message boxes steal focus and freeze the process behind them; an agent's request to
// close a tab or forget a memory is routed through the renderer's own confirm UI instead, with
// this map resolving the owner's answer back to whichever AgentControl call is waiting on it.
// Agent requests are shown in the main window only: a detached window has no dialog to show them in.
const agentConfirms = new AgentConfirmBroker(() => {
  const window = mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() ? mainWindow : null
  if (!window) return null
  return {
    send: (channel, payload) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return false
      window.webContents.send(channel, payload)
      return true
    },
    reveal: () => {
      if (window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      revealWindow(window)
      // Windows refuses focus to an app that is not in the foreground, so the window may stay
      // behind whatever the owner is using; the flashing taskbar button is then the only sign.
      if (!backgroundWindows && !window.isFocused()) {
        window.flashFrame(true)
        window.once('focus', () => { if (!window.isDestroyed()) window.flashFrame(false) })
      }
    }
  }
})
const floatingDetachedIds = (): string[] => {
  try { const value: unknown = JSON.parse(database.getSetting('floatingDetachedWindows') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] }
  catch { return [] }
}
let debugWindow: BrowserWindow | null = null
let debugSourceWindow: BrowserWindow | null = null
let latestDebugSnapshot: DebugConsoleSnapshot | null = null
let lastDebugScreenshot: Electron.NativeImage | null = null
let isQuitting = false
/** The runtime host that keeps provider processes alive across a restart (docs/runtime-host.md). */
let runtimeHostClient: RuntimeHostClient | null = null
/** Keeps a hosting machine alive with no window, and asks before a quit would cut its peers off. */
let hostLifecycle: HostLifecycleController | null = null
let servicesDisposed = false
const closeConfirmation = new CloseConfirmation()
/** The open "Work is still running" dialog, answerable by a wizard through app.quit.confirm. */
const stopConfirmations = new StopConfirmations()
let archiveBusy = false
let replacingDesk = false
let quitRequest: Promise<void> | null = null

const DEFAULT_ZOOM = 1.1
const UPDATE_WINDOW_LAYOUT_KEY = 'updateWindowLayout'
const USAGE_LIMIT_DETECTION_VERSION_KEY = 'usageLimitDetectionVersion'
const RESTORE_WINDOWS_AFTER_UPDATE_KEY = 'restoreWindowsAfterUpdate'

app.setName('Conductor')
// Isolated automation profile is chosen before the single-instance lock.
if (!app.isPackaged && process.env.CONDUCTOR_TEST_USER_DATA) app.setPath('userData', resolve(process.env.CONDUCTOR_TEST_USER_DATA))
if (app.isPackaged) delete process.env.CONDUCTOR_OFFLINE_TESTS
/** An automation profile (CONDUCTOR_TEST_USER_DATA). Gates the watchdog below, the dialog guard in
 *  ./test-mode-dialogs, and routing main-process errors to a log instead of a native error box -
 *  none of which a real, owner-driven launch should ever behave differently for. */
const testMode = !app.isPackaged && !!process.env.CONDUCTOR_TEST_USER_DATA
if (testMode) {
  // A leaked overnight verifier left Electron and its fixture CLIs running for hours after the
  // smoke script that launched it was gone (feature-list.md: smoke-instances-never-leak). This
  // instance dies, tree and all, within one poll interval of that launcher disappearing.
  // Pin the launcher once: a relaunched instance (app.restart) inherits this env, so it and its
  // runtime host keep watching the smoke that started the run, not the previous app process.
  if (!process.env.CONDUCTOR_TEST_PARENT_PID) process.env.CONDUCTOR_TEST_PARENT_PID = String(process.ppid)
  startTestModeWatchdog()
  const mainErrorsLog = join(resolve(process.env.CONDUCTOR_TEST_USER_DATA!), 'main-errors.log')
  const logMainError = (kind: string, detail: string): void => {
    try { appendFileSync(mainErrorsLog, `${new Date().toISOString()} [${kind}] ${detail}\n`) } catch { /* logging never blocks anything */ }
  }
  // Electron's default handling for these is a modal "A JavaScript error occurred" dialog, which
  // is exactly the kind of native window a parked test instance must never put on a real screen.
  process.on('uncaughtException', error => logMainError('uncaughtException', error.stack ?? error.message))
  process.on('unhandledRejection', reason => logMainError('unhandledRejection', reason instanceof Error ? reason.stack ?? reason.message : String(reason)))
}
/** Smoke runs and probes drive a real window, but they must never take the desktop from whoever
 *  is working: an automation profile (CONDUCTOR_TEST_USER_DATA) parks its windows off-screen,
 *  out of the taskbar, and never activates or raises them. Set CONDUCTOR_BACKGROUND_WINDOWS=0 to
 *  watch a run, or =1 to park a normal launch. */
export const backgroundWindows = !app.isPackaged && (process.env.CONDUCTOR_BACKGROUND_WINDOWS ?? (process.env.CONDUCTOR_TEST_USER_DATA ? '1' : '0')) === '1'
/** Far enough left of every display that no part of a parked window is ever composited over the
 *  owner's screen, while the renderer keeps painting so CDP screenshots stay real. */
const parkedPosition = (): { x: number; y: number } => {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x - 6000, y: area.y }
}
/** Show without stealing activation. Used for every reveal so no code path can raise a parked window. */
const revealWindow = (window: BrowserWindow, activate = true): void => {
  if (window.isDestroyed()) return
  if (backgroundWindows) {
    window.setSkipTaskbar(true)
    const { x, y } = parkedPosition()
    window.setPosition(x, y)
    window.showInactive()
    return
  }
  window.show()
  if (activate) window.focus()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

const publishWindowMaximizedState = (window: BrowserWindow): void => {
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('window:maximized-changed', window.isMaximized() || window.isFullScreen())
  }
}

const installWindowStateEvents = (window: BrowserWindow): void => {
  window.on('maximize', () => publishWindowMaximizedState(window))
  window.on('unmaximize', () => publishWindowMaximizedState(window))
  window.on('enter-full-screen', () => publishWindowMaximizedState(window))
  window.on('leave-full-screen', () => publishWindowMaximizedState(window))
}

app.on('second-instance', () => {
  const window = mainWindow ?? detachedWindows.values().next().value
  if (!window) return
  if (window.isMinimized()) window.restore()
  revealWindow(window)
})

// Electron ships no native right-click menu by default; every window and webview needs this.
app.on('web-contents-created', (_event, contents) => installContextMenu(contents))

const createWindow = (
  detachedId?: string,
  placeAtCursor = false,
  savedPlacement?: SavedWindowPlacement
): BrowserWindow => {
  const visibleSavedPlacement = savedPlacement && isWindowPlacementVisible(
    savedPlacement,
    screen.getAllDisplays().map((display) => display.workArea)
  ) ? savedPlacement : undefined
  const detachedBounds = detachedId && placeAtCursor ? (() => {
    const point = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    return {
      x: Math.min(area.x + Math.max(0, area.width - 1120), Math.max(area.x, point.x - 90)),
      y: Math.min(area.y + Math.max(0, area.height - 760), Math.max(area.y, point.y - 26))
    }
  })() : {}
  const window = new BrowserWindow({
    width: detachedId ? 1120 : 1540,
    height: detachedId ? 760 : 960,
    minWidth: detachedId ? 520 : 980,
    minHeight: detachedId ? 360 : 640,
    show: false,
    frame: false,
    backgroundColor: '#0b0d10',
    ...detachedBounds,
    ...visibleSavedPlacement?.bounds,
    // Last so a remembered placement can never pull a parked automation window back on screen.
    ...(backgroundWindows ? { skipTaskbar: true, ...parkedPosition() } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  // A parked window must not take the speakers either: a smoke run completes agent after agent,
  // and every one of them would ring the owner's "finished" cue while they work in another app.
  if (backgroundWindows) window.webContents.setAudioMuted(true)
  // Browser guests do not bubble keyboard events into the workspace renderer.
  window.webContents.on('did-attach-webview', (_event, guest) => {
    // Every browser guest is registered with the main process here, so the browser MCP bridge
    // only ever drives a view it watched attach to a workspace window it knows.
    browserViews?.attach(window, guest)
    guest.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'e') {
        event.preventDefault()
        window.webContents.focus()
        window.webContents.send('files:open-shortcut')
      }
      if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && !input.shift && input.key.toLowerCase() === 'w') {
        event.preventDefault()
        window.webContents.send('window:close-tab')
      }
    })
  })
  installWindowStateEvents(window)
  hostLifecycle?.windowOpened()
  // Consume the native accelerator before Electron's default Close Window role can run.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && !input.shift && input.key.toLowerCase() === 'w') {
      event.preventDefault()
      window.webContents.send('window:close-tab')
    }
  })
  let closeApproved = false
  let decidingClose = false
  window.on('close', (event) => {
    if (closeApproved || isQuitting) return
    event.preventDefault()
    if (!detachedId || !mainWindow && detachedWindows.size <= 1) { app.quit(); return }
    if (decidingClose) return
    decidingClose = true
    const record = detachedId ? database.getDetachedWindow(detachedId) : null
    const tabs: string[] = []
    const collect = (node: import('../shared/models').LayoutNode): void => { if (node.type === 'split') node.children.forEach(collect); else tabs.push(...node.tabs.filter(tab => tab.kind === 'code').map(tab => tab.id)) }
    if (record) collect(record.layout.root)
    void resolveUnsavedEditors(window, tabs).then((approved) => { decidingClose = false; if (approved && !window.isDestroyed()) { closeApproved = true; window.close() } })
  })

  window.once('ready-to-show', () => {
    if (visibleSavedPlacement?.maximized && !backgroundWindows) window.maximize()
    revealWindow(window, false)
  })
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomFactor(getAppSettings().zoomFactor)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || window.isDestroyed() || details.reason === 'clean-exit') return
    console.error(`Conductor renderer stopped (${details.reason}); restoring its last checkpoint.`)
    setTimeout(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload()
    }, 250)
  })
  window.on('closed', () => {
    browserViews?.releaseWindow(window, isQuitting)
    if (!detachedId) {
      if (mainWindow === window) mainWindow = null
      return
    }

    detachedWindows.delete(detachedId)
    if (isQuitting || replacingDesk) return
    try {
      const floatingIds = floatingDetachedIds()
      const closed = database.closeDetachedWindow(detachedId, floatingIds.includes(detachedId))
      if (floatingIds.includes(detachedId)) database.setSetting('floatingDetachedWindows', JSON.stringify(floatingIds.filter(id => id !== detachedId)))
      if (!closed) return
      for (const recipient of BrowserWindow.getAllWindows()) {
        if (!recipient.isDestroyed()) {
          recipient.webContents.send('detached:closed', { sessionId: closed.sessionId })
        }
      }
    } catch (error) {
      console.error(`Failed to close detached window ${detachedId}`, error)
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (detachedId) url.searchParams.set('detached', detachedId)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(
      join(__dirname, '../renderer/index.html'),
      detachedId ? { query: { detached: detachedId } } : undefined
    )
  }
  return window
}

const openDetachedWindow = (
  id: string,
  placeAtCursor = false,
  savedPlacement?: SavedWindowPlacement
): BrowserWindow | null => {
  const existing = detachedWindows.get(id)
  if (existing && !existing.isDestroyed()) {
    revealWindow(existing)
    return existing
  }
  if (!database.getDetachedWindow(id)) return null
  const window = createWindow(id, placeAtCursor, savedPlacement)
  if (floatingDetachedIds().includes(id) && !backgroundWindows) window.setAlwaysOnTop(true)
  detachedWindows.set(id, window)
  return window
}

/** A detached project browser is only a native host for the already-running main-owned view.
 * It has no renderer, partition or replacement page of its own, so reparenting never changes the
 * guest identity. showInactive() is called only after the view is attached. */
const createDetachedBrowserWindow = (projectId: string, onClosed: () => void): BrowserWindow => {
  const project = database.getProject(projectId)
  if (!project) throw new Error('Project not found')
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: `${project.name} — Browser`,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    ...(backgroundWindows ? { skipTaskbar: true, ...parkedPosition() } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  if (backgroundWindows) window.webContents.setAudioMuted(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once('closed', onClosed)
  return window
}

const openDebugWindow = (source: BrowserWindow, placeAtCursor = false): void => {
  debugSourceWindow = source
  if (debugWindow && !debugWindow.isDestroyed()) {
    if (debugWindow.isMinimized()) debugWindow.restore()
    revealWindow(debugWindow)
    return
  }
  const cursorBounds = placeAtCursor ? (() => {
    const point = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    return {
      x: Math.min(area.x + Math.max(0, area.width - 780), Math.max(area.x, point.x - 80)),
      y: Math.min(area.y + Math.max(0, area.height - 520), Math.max(area.y, point.y - 18))
    }
  })() : {}
  const window = new BrowserWindow({
    width: 780,
    height: 520,
    minWidth: 560,
    minHeight: 320,
    show: false,
    frame: false,
    title: 'Conductor Debug Console',
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    ...cursorBounds,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  installWindowStateEvents(window)
  debugWindow = window
  window.once('ready-to-show', () => revealWindow(window, false))
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomFactor(getAppSettings().zoomFactor)
  })
  window.on('closed', () => {
    if (debugWindow === window) debugWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('debug-console', '1')
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { 'debug-console': '1' } })
  }
}

const getAppSettings = (): AppSettings => {
  const storedZoom = Number(database.getSetting('zoomFactor'))
  const storedThemeId = database.getSetting('themeId')
  const storedThemeVariant = database.getSetting('themeVariant')
  const storedThemeAuto = database.getSetting('themeAuto')
  const legacyThemeMode = database.getSetting('themeMode')
  const { themeId, themeVariant, themeAuto } = normalizeThemeSettings({
    themeId: storedThemeId,
    themeVariant: storedThemeVariant,
    themeAuto: storedThemeAuto,
    legacyThemeMode
  })

  // Persist the normalized replacement keys the first time an older profile is read.
  if (!THEME_IDS.includes(storedThemeId as ThemeId)) database.setSetting('themeId', themeId)
  if (!THEME_VARIANTS.includes(storedThemeVariant as ThemeVariant)) database.setSetting('themeVariant', themeVariant)
  if (storedThemeAuto !== 'true' && storedThemeAuto !== 'false') database.setSetting('themeAuto', String(themeAuto))
  return {
    projectsRoot:
      process.env.CONDUCTOR_PROJECTS_ROOT ||
      database.getSetting('projectsRoot') ||
      join(app.getPath('home'), 'Conductor'),
    zoomFactor: Number.isFinite(storedZoom) && storedZoom >= 0.8 && storedZoom <= 1.5
      ? storedZoom
      : DEFAULT_ZOOM,
    themeId,
    themeVariant,
    themeAuto,
    debugLogging: database.getSetting('debugLogging') === 'true',
    showHiddenFiles: database.getSetting('showHiddenFiles') === 'true',
    defaultNewFileExtension: normalizeNewFileExtension(database.getSetting('defaultNewFileExtension')) ?? 'md',
    agentSoundProfile: AGENT_SOUND_PROFILES.includes(database.getSetting('agentSoundProfile') as AgentSoundProfile)
      ? database.getSetting('agentSoundProfile') as AgentSoundProfile
      : 'soft',
    updateFeedUrl: database.getSetting('updateFeedUrl') || process.env.CONDUCTOR_UPDATE_URL || '',
    includeLocalUpdates: database.getSetting('includeLocalUpdates') !== 'false',
    localUpdateDirectory: join(app.getPath('userData'), 'local-updates')
  }
}

const captureWindowPlacement = (window: BrowserWindow): SavedWindowPlacement => ({
  bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(),
  maximized: window.isMaximized()
})

const captureWindowLayout = (): SavedWindowLayout => {
  const detached: Record<string, SavedWindowPlacement> = {}
  for (const [id, window] of detachedWindows) {
    if (!window.isDestroyed()) detached[id] = captureWindowPlacement(window)
  }
  return {
    version: 1,
    ...(mainWindow && !mainWindow.isDestroyed() ? { main: captureWindowPlacement(mainWindow) } : {}),
    detached
  }
}

/** The authoritative cross-project view: persisted agent phases, scoped to the tabs each
 *  workspace still shows, rolled up per project. A project whose panes were never mounted this
 *  launch is answered from the database like any other. */
const projectActivitySnapshot = (): ProjectActivitySnapshot => {
  const projects = database.listProjects()
  return aggregateProjectActivity(
    projects.map((project) => project.id),
    projects.flatMap((project) => database.listSessions(project.id)),
    database.listAgentActivity(),
    database.listDetachedWindows()
  )
}

const disposeRuntimeServices = (): void => {
  if (servicesDisposed) return
  servicesDisposed = true
  const disposals: Array<[string, () => void]> = [
    // First: the job controller stops watching before the agents it drives are torn down, so an
    // app quit is never recorded as a failed stage. The jobs stay running and are reconciled on
    // the next launch.
    ['durable jobs', () => { durableJobs?.dispose(); disposeDurableJobsGate?.(); disposeDurableJobsIpc?.() }],
    ['ideas', () => { disposeIdeasIpc?.(); ideasRegistration?.dispose() }],
    ['agent control', () => { agentControlServer?.close(); agentControlUi?.close(); browserMcp?.close(); localAssist?.close(); browserViews?.dispose(); projectFileChanges?.close() }],
    ['coworker auto-close', () => coworkerAutoClose?.dispose()],
    ['terminals', () => terminals?.dispose()],
    ['agents', () => agents?.dispose()],
    ['schedule runner', () => scheduleRunner?.stop()],
    ['schedule IPC', () => disposeScheduleIpc?.()],
    ['delivery IPC', () => disposeDeliveryIpc?.()],
    ['logic loops IPC', () => disposeLogicLoopsIpc?.()],
    ['orchestration IPC', () => disposeOrchestrationIpc?.()],
    ['collaboration IPC', () => disposeCollaborationIpc?.()],
    ['project activity', () => { disposeProjectActivity?.(); if (projectActivityTimer) clearTimeout(projectActivityTimer); projectActivityTimer = null }],
    ['collaboration store', () => collaboration?.close()],
    ['orchestration store', () => orchestration?.close()],
    ['schedule store', () => schedules?.close()],
    ['workspace database', () => database?.close()]
  ]
  for (const [name, dispose] of disposals) {
    try {
      dispose()
    } catch (error) {
      console.error(`Failed to stop ${name} during shutdown`, error)
    }
  }
}

/** Only the wizard tab that initiated this restart, or asked the owner for it, is brought back and
 *  told to continue. Other owner restarts restore windows without starting any conversations. */
const resumeWizardTabs = async (initiator: RestartInitiator): Promise<void> => {
  for (const project of database.listDeskProjects()) for (const workspace of database.listSessions(project.id)) {
    const tabs: PaneTab[] = []
    const visit = (node: LayoutNode): void => { if (node.type === 'split') node.children.forEach(visit); else tabs.push(...node.tabs) }
    visit(workspace.layout.root)
    for (const detached of database.listDetachedWindows()) if (detached.sessionId === workspace.id) visit(detached.layout.root)
    for (const tab of wizardTabsToResume(tabs, initiator)) {
      if (tab.kind !== 'agent' || !tab.resourceId) continue
      const state = database.structured.snapshot(tab.resourceId), spec = database.structured.spec<AgentSpec>(tab.resourceId)
      if (!state || !spec || spec.provider === 'local' || !state.nativeSessionId || !wizardActive(state.settings, spec.provider)) continue
      // Its turn was kept running through the restart and has been told so on reattach.
      if (reattachedRuntimes.has(tab.resourceId)) continue
      try {
        await agents.structured.resume(tab.resourceId, state.settings)
        await agents.structured.submit(tab.resourceId, `[Conductor] ${initiator.method === 'app.restart.request' ? 'The owner restarted Conductor as you requested' : 'Conductor restarted itself'} (now ${app.getVersion()}) and brought this wizard tab back. Continue your work from where you left off; check app.state and agents.list first, since your coworkers may need resuming too.`, state.settings, [], { agentSessionId: 'owner', label: 'Conductor' })
        console.log(`Wizard tab ${tab.resourceId} resumed after the restart`)
      } catch (error) { console.warn(`Wizard tab ${tab.resourceId} could not be resumed after the restart`, error) }
    }
  }
}

/** A wizard's request that the owner restart (app.restart.request). It is kept in the settings so
 *  the next launch, however the owner restarts, resumes that wizard; the launch consumes it. */
const readRestartRequest = (): RestartRequest | null => parseRestartRequest(database.getSetting(RESTART_REQUEST_KEY), new Date())
const recordRestartRequest = (request: Omit<RestartRequest, 'at'>): RestartRequest => {
  const recorded = { ...request, at: new Date().toISOString() }
  database.setSetting(RESTART_REQUEST_KEY, encodeRestartRequest(recorded))
  updates?.setRestartRequest(recorded)
  return recorded
}

/** local.servers: the llama.cpp servers on this machine, Conductor-started ones first. */
const runningLocalServers = (): ReturnType<typeof listLocalServers> => {
  let models: ReturnType<typeof loadLocalConfig>['models'][string][] = []
  try { models = Object.values(loadLocalConfig().models) } catch { /* No local stack: only the process list can show a server. */ }
  return listLocalServers({ models: () => models, record: readRunRecord, alive: llamaProcessAlive, inventory: runningLlamaProcesses })
}
/** local.stop: one Conductor-started server, refused while a turn uses it unless forced. */
const stopRunningLocalServer = (request: LocalStopRequest): ReturnType<typeof stopLocalServer> => {
  const config = loadLocalConfig(), apiKey = readLocalApiKey()
  return stopLocalServer(runningLocalServers(), request, {
    busy: server => releaseVerdict(server, apiKey),
    stop: async model => {
      const target = config.models[model]
      if (!target) throw new Error(`${model} is not configured in the local model stack`)
      return stopLlamaServer(target)
    }
  })
}

/** Whether provider processes are kept by the runtime host. The owner's setting `runtimeHost`
 *  ('on' / 'off') decides; an automation profile (CONDUCTOR_TEST_USER_DATA) leaves it off unless
 *  CONDUCTOR_RUNTIME_HOST=1 asks for it, so smokes never leave a host behind. */
const runtimeHostEnabled = (): boolean => {
  if (process.env.CONDUCTOR_RUNTIME_HOST === '0') return false
  if (process.env.CONDUCTOR_RUNTIME_HOST === '1') return true
  const setting = database.getSetting('runtimeHost')
  if (setting === 'on' || setting === 'off') return setting === 'on'
  return !process.env.CONDUCTOR_TEST_USER_DATA
}
const runtimeHostLaunch = (start: boolean): Parameters<typeof connectRuntimeHost>[0] => ({
  userData: app.getPath('userData'), hostScript: join(__dirname, 'runtime-host.js'), packaged: app.isPackaged, start,
  log: message => console.log(`[runtime host] ${message}`)
})
const installRuntimeHost = (client: RuntimeHostClient): void => {
  runtimeHostClient = client
  setRuntimeHost(client)
  client.onLost(() => {
    if (runtimeHostClient !== client) return
    runtimeHostClient = null
    setRuntimeHost(null)
    console.warn('The runtime host connection was lost; new runtimes start inside Conductor until the next launch')
  })
}
/** Conversations this launch reattached to a turn the previous process kept running. */
const reattachedRuntimes = new Set<string>()
/** Rebinds every conversation whose turn the previous process kept running in the host, before
 *  any window asks for it; a record whose runtime is gone becomes an ordinary disconnect. */
const reattachKeptRuntimes = async (): Promise<void> => {
  const kept = agents.structured.detachedRuntimes()
  if (!kept.length) return
  let client: RuntimeHostClient | null = null
  try { client = await connectRuntimeHost(runtimeHostLaunch(false)) } catch (error) { console.warn('The runtime host holding kept turns is unreachable', error) }
  if (client) installRuntimeHost(client)
  const listed = client ? await client.list().catch(() => []) : []
  for (const { id, record } of kept) {
    const runtime = listed.find(entry => entry.runtimeId === record.adapter.transport.runtimeId)
    // A local turn has no process in the host: it paused at its checkpoint and resumes here.
    if (record.provider !== 'local' && (!client || !runtime)) {
      agents.structured.abandonDetached(id, 'The turn this conversation was running when Conductor closed ended while it was closed. Its native conversation resumes as usual.')
      continue
    }
    try {
      await agents.structured.reattach(id, runtime?.lostFrames ?? 0)
      reattachedRuntimes.add(id)
      console.log(`Conversation ${id} reattached to its kept runtime`)
    } catch (error) { console.warn(`Conversation ${id} could not be reattached to its kept runtime`, error) }
  }
}
/** A reattached turn still holds the previous process's app-control endpoint and credential, so it
 *  is told where app control lives now. */
const briefReattachedRuntimes = (): void => {
  for (const id of reattachedRuntimes) {
    const spec = database.structured.spec<AgentSpec>(id), state = database.structured.snapshot(id)
    if (!spec || spec.provider === 'local' || !state || !agentControlServer || !['running', 'waiting_approval', 'waiting_input'].includes(state.phase)) continue
    void agents.structured.steer(id, `[Conductor] Conductor restarted (now ${app.getVersion()}) while this turn kept running. App control moved to a new endpoint and credential; use these from now on.\n\n${agentControlServer.briefing(spec)}`, state.settings, [], { agentSessionId: 'owner', label: 'Conductor' })
      .catch(error => console.warn(`Reattached conversation ${id} could not be briefed`, error))
  }
}
/** Starts (or joins) the runtime host for runtimes started from now on. */
const startRuntimeHost = async (): Promise<void> => {
  if (!runtimeHostEnabled() || runtimeHostClient?.connected) return
  try {
    const client = await connectRuntimeHost(runtimeHostLaunch(true))
    if (!client) return
    installRuntimeHost(client)
    // A host runtime no conversation of this app owns was left by a process that could not save
    // how to continue it (a crash); nobody can, so it stops.
    const owned = new Set([...reattachedRuntimes].map(id => database.structured.snapshot(id)?.runtimeId))
    for (const runtime of await client.list()) if (!runtime.attached && !owned.has(runtime.runtimeId)) client.close(runtime.runtimeId)
  } catch (error) { console.warn('The runtime host could not start; runtimes stay inside Conductor', error) }
}
/** Hands every running turn to the runtime host for the next launch to continue. */
const keepRunningInBackground = async (): Promise<void> => {
  if (!runtimeHostClient?.connected) return
  try {
    const kept = await agents.structured.detachForRestart()
    await runtimeHostClient.flush()
    if (kept.length) console.log(`Kept ${kept.length} running turn(s) in the runtime host`)
  } catch (error) { console.warn('Running turns could not all be kept in the background', error) }
}

/** Restart Conductor the way app.restart does; a downloaded update installs on the way out. */
const relaunchConductor = async (force: boolean, initiator?: Omit<RestartInitiator, 'at'>): Promise<void> => {
  // A downloaded update installs and relaunches by itself; relaunching as well would start
  // Conductor twice.
  if (updates.getState().phase === 'ready') { await updates.install({ force }, initiator); return }
  await prepareForUpdateInstall(force, initiator)
  app.relaunch()
  app.quit()
}

/** Which wizard tab, if any, this launch brings back, consuming the records that name it. */
const takeLaunchInitiator = (): RestartInitiator | null => {
  const initiator = launchRestartInitiator(database.getSetting(RESTART_INITIATOR_KEY), database.getSetting(RESTART_REQUEST_KEY), new Date())
  database.setSetting(RESTART_INITIATOR_KEY, '')
  database.setSetting(RESTART_REQUEST_KEY, '')
  return initiator
}

/** `force` is the owner's own control credential restarting the app unattended: running work is
 *  stopped without the dialog, and dirty editors are flushed into their recovery drafts instead of
 *  being asked about, so nothing typed is lost and nothing on disk is overwritten. */
const prepareForUpdateInstall = async (force = false, initiator?: Omit<RestartInitiator, 'at'>): Promise<void> => {
  if (force) {
    try { await flushEditorWindows(editorWindows()) } catch (error) { console.warn('Editor drafts could not all be flushed before a forced restart', error) }
    // A wizard's or the owner credential's restart keeps running turns alive without asking.
    await keepRunningInBackground()
  } else {
    const decision = await confirmApplicationStop(mainWindow, 'restart')
    if (decision === 'cancel') throw Object.assign(new Error('Update restart cancelled. Running work is unchanged.'), { code: 'UPDATE_CANCELLED' })
    if (!await resolveUnsavedEditors(mainWindow)) throw Object.assign(new Error('Update restart cancelled. Your edits are still open.'), { code: 'UPDATE_CANCELLED' })
    if (decision === 'background') await keepRunningInBackground()
  }
  database.setSetting(UPDATE_WINDOW_LAYOUT_KEY, JSON.stringify(captureWindowLayout()))
  database.setSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY, 'true')
  database.setSetting(RESTART_INITIATOR_KEY, encodeRestartInitiator(initiator && { ...initiator, at: new Date().toISOString() }))
  // electron-updater closes windows before Electron emits before-quit. Mark the
  // close as intentional now so detached tabs remain detached for the relaunch.
  isQuitting = true
  disposeRuntimeServices()
}


const flushEditorWindows = async (windows: BrowserWindow[]): Promise<void> => {
  await Promise.all(windows.map(async (window) => {
    if (window.webContents.isDestroyed()) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        window.webContents.executeJavaScript("(() => { window.dispatchEvent(new Event('conductor:flush-session')); const event = new CustomEvent('conductor:flush-editors', { detail: { failed: false } }); window.dispatchEvent(event); if (event.detail.failed) throw new Error('An editor draft could not be preserved. Keep the window open and try again.'); })()"),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('An editor window did not respond. Try again after it recovers.')), 5000) })
      ])
    } finally { clearTimeout(timeout) }
  }))
}

/** Only renderer windows own recovery/editor state. Browser presentation hosts and debug windows
 * are BrowserWindows too, but they must never participate in a desk flush. */
const editorWindows = (): BrowserWindow[] => {
  const windows = [mainWindow, ...detachedWindows.values()].filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
  return [...new Set(windows)]
}

let resolvingEditors: Promise<boolean> | null = null
const draftMachineId = (draft: Pick<EditorDraft, 'machineId'>): string => draft.machineId || LOCAL_MACHINE_ID
const sameEditorDraft = (current: EditorDraft | null, expected: EditorDraft): boolean => Boolean(current
  && draftMachineId(current) === draftMachineId(expected)
  && current.content === expected.content
  && current.baseContent === expected.baseContent)
const readDraftFile = async (draft: EditorDraft, target?: string): Promise<string | null> => {
  const machineId = draftMachineId(draft)
  if (machineId === LOCAL_MACHINE_ID) return readEditorFile(target ?? await resolveEditorPath(draft.projectId, draft.path))
  if (!remoteControl) throw new Error('Remote files are not available.')
  return (await remoteControl.files.read({ machineId, projectId: draft.projectId, path: draft.path })).content
}
const resolveUnsavedEditors = (owner: BrowserWindow | null, tabIds?: string[]): Promise<boolean> => {
  // Serialize decisions across windows. A caller with another scope checks again afterwards.
  if (resolvingEditors) return resolvingEditors.then((ok) => ok && resolveUnsavedEditors(owner, tabIds))
  const task = (async (): Promise<boolean> => {
    const windows = editorWindows()
    await flushEditorWindows(windows)
    const drafts = database.listEditorDrafts().filter((draft) => !tabIds || tabIds.includes(draft.tabId))
    const dirty: Array<{ draft: typeof drafts[number]; target?: string; disk: string | null }> = []
    for (const draft of drafts) {
      if (!database.getProject(draft.projectId)) continue
      // An edit retained when the owner detached from its host is deliberately not resolved here:
      // the host is not being talked to, and the same path on this computer is a different file,
      // so there is nothing to compare it against and nowhere it may be written. It survives every
      // close, is listed as a recovery draft, and only the owner saves it somewhere by hand.
      if (draft.recoveredAt) continue
      // Old clean buffers must not be mistaken for user edits when disk changed.
      if (draft.content === draft.baseContent) { database.removeEditorDraft(draft.tabId); continue }
      const target = draftMachineId(draft) === LOCAL_MACHINE_ID ? await resolveEditorPath(draft.projectId, draft.path) : undefined
      const disk = await readDraftFile(draft, target)
      const current = database.getEditorDraft(draft.tabId, draft.projectId, draft.path, draftMachineId(draft))
      if (!sameEditorDraft(current, draft)) return false
      if (disk === draft.content) { database.removeEditorDraft(draft.tabId); continue }
      dirty.push({ draft, target, disk })
    }
    if (!dirty.length) return true
    const options: Electron.MessageBoxOptions = {
      type: 'question', title: 'Save changes?', message: 'Save changes before closing?',
      detail: dirty.map(({ draft }) => (database.getProject(draft.projectId)?.name ?? '') + ' / ' + draft.path).join('\n'),
      buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true
    }
    const { response } = await testDialogs.showMessageBox(owner, options)
    if (response === 2) return false
    // Resolve again after the dialog: a file may have moved, changed or been
    // deleted while the owner was deciding. Validate all drafts before writing.
    for (const item of dirty) if (draftMachineId(item.draft) === LOCAL_MACHINE_ID) item.target = await resolveEditorPath(item.draft.projectId, item.draft.path)
    for (const { draft } of dirty) {
      const current = database.getEditorDraft(draft.tabId, draft.projectId, draft.path, draftMachineId(draft))
      if (!sameEditorDraft(current, draft)) return false
    }
    if (response === 0) {
      const versions = new Map<string, string>()
      for (const { draft, target } of dirty) {
        const rawKey = draftMachineId(draft) + '\u0000' + draft.projectId + '\u0000' + (target ?? draft.path)
        const key = process.platform === 'win32' ? rawKey.toLowerCase() : rawKey
        if (versions.has(key) && versions.get(key) !== draft.content) throw new Error('This file has different edits in multiple workspaces: ' + draft.path + '. Save a copy from each editor to preserve both versions.')
        versions.set(key, draft.content)
        const disk = await readDraftFile(draft, target)
        const current = database.getEditorDraft(draft.tabId, draft.projectId, draft.path, draftMachineId(draft))
        if (!sameEditorDraft(current, draft)) return false
        if (disk !== draft.content && (draft.baseContent === undefined || disk !== draft.baseContent)) {
          for (const window of windows) if (!window.isDestroyed()) window.webContents.send('files:draft-conflict', { tabId: draft.tabId, message: EDITOR_CONFLICT_MESSAGE })
          throw new Error(draft.path + ': ' + EDITOR_CONFLICT_MESSAGE)
        }
      }
    }
    for (const { draft, target, disk } of dirty) {
      if (response === 0) {
        const machineId = draftMachineId(draft)
        const result = machineId === LOCAL_MACHINE_ID
          ? writeEditorFile(target!, draft.content, draft.baseContent)
          : (await remoteControl!.files.write({ machineId, projectId: draft.projectId, path: draft.path, content: draft.content, expectedContent: draft.baseContent ?? null })).result
        if (result.status === 'conflict') {
          for (const window of windows) if (!window.isDestroyed()) window.webContents.send('files:draft-conflict', { tabId: draft.tabId, message: result.message })
          throw new Error(draft.path + ': ' + result.message)
        }
      }
      const current = database.getEditorDraft(draft.tabId, draft.projectId, draft.path, draftMachineId(draft))
      if (!sameEditorDraft(current, draft)) return false
      database.removeEditorDraft(draft.tabId)
      const content = response === 0 ? draft.content : disk
      for (const window of windows) if (!window.isDestroyed()) window.webContents.send('files:draft-resolved', { tabId: draft.tabId, submitted: draft.content, content, saved: response === 0 })
    }
    // Let renderer resolution handlers preserve any last edits before granting
    // close. A newer draft cancels this close without losing its original base.
    await flushEditorWindows(windows)
    return !database.listEditorDrafts().some((draft) => !draft.recoveredAt && (!tabIds || tabIds.includes(draft.tabId)))
  })().catch(async (reason: unknown) => {
    const options: Electron.MessageBoxOptions = { type: 'error', title: 'Could not close editor', message: reason instanceof Error ? reason.message : String(reason) }
    await testDialogs.showMessageBox(owner, options)
    return false
  })
  resolvingEditors = task
  void task.finally(() => { if (resolvingEditors === task) resolvingEditors = null })
  return task
}

const liveWindow = (owner?: BrowserWindow | null): BrowserWindow | null => owner && !owner.isDestroyed()
  ? owner
  : mainWindow && !mainWindow.isDestroyed() ? mainWindow : [...detachedWindows.values()].find(window => !window.isDestroyed()) ?? null

const showDecision = async (owner: BrowserWindow | null, options: Electron.MessageBoxOptions, testResponse?: number): Promise<number> => {
  const result = await testDialogs.showMessageBox(owner, options, testResponse)
  return result.response
}

const runningWork = (): ReturnType<ConductorDatabase['listProcesses']> => database.listProcesses().filter(process =>
  hasRunningWork(process, process.kind === 'agent' ? database.structured.snapshot(process.id) : null, process.kind === 'agent' ? agents.structured.hasRuntime(process.id) : undefined)
)

/** The work a quit or restart would ask the owner about now, or null when it would go ahead. */
const stopQuestion = (): Array<{ id: string; title: string }> | null => {
  const active = runningWork()
  return active.length || agents.nativeCli.hasSubmittedInput() ? active.slice(0, 8).map(process => ({ id: process.id, title: process.title })) : null
}

const confirmApplicationStop = async (owner: BrowserWindow | null, action: 'quit' | 'restart'): Promise<StopDecision> => {
  const active = runningWork()
  if (!active.length && !agents.nativeCli.hasSubmittedInput()) return 'stop'
  const running = active.slice(0, 8).map(process => ({ id: process.id, title: process.title }))
  // Conversation turns can outlive the app in the runtime host (docs/runtime-host.md); terminal
  // CLI tabs cannot, so they are named apart.
  const background = Boolean(runtimeHostClient?.connected) && active.some(process => process.kind === 'agent')
  const choices: StopDecision[] = background ? ['background', 'stop', 'cancel'] : ['stop', 'cancel']
  const verb = action === 'restart' ? 'restart' : 'quit'
  // A parked test instance must never sit on this dialog: a guarded run answers it itself, headless,
  // with the choice that actually lets the app go down ("stop"), not the button a live owner would
  // default to (background keeps it alive) or the cancel button smoke-lock's generic fallback would
  // otherwise pick (feature-list.md: smoke-instances-never-leak).
  // CONDUCTOR_TEST_STOP_DECISION=background lets a smoke take the keep-running answer instead, to
  // check a turn surviving a restart through the runtime host.
  const stopChoiceIndex = background ? (process.env.CONDUCTOR_TEST_STOP_DECISION === 'background' ? 0 : 1) : 0
  return closeConfirmation.decide(() => stopConfirmations.ask({ action, running, choices }, async signal => choices[await showDecision(liveWindow(owner), {
    type: 'warning', title: action === 'restart' ? 'Restart Conductor?' : 'Quit Conductor?',
    message: 'Work is still running in Conductor.',
    detail: `${running.length ? running.map(process => process.title).join('\n') : 'A native CLI command is still running.'}\n\n${background
      ? 'Keep running in background: the running turns carry on while Conductor is closed and reappear in their tabs when it starts again (local-model turns pause and continue then). Terminal CLI tabs still stop.\nStop all: interrupts work in every project and window.'
      : 'Stopping the application interrupts work in every project and window.'}`,
    buttons: background ? [`Keep running in background and ${verb}`, `Stop all and ${verb}`, 'Cancel'] : [`Stop work and ${verb}`, 'Cancel'],
    defaultId: background ? 0 : 1, cancelId: choices.length - 1, noLink: true, signal
  }, stopChoiceIndex)] ?? 'cancel', { running: stopQuestion }))
}

const broadcastSessionArchive = (result: SessionArchiveResult): void => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('session-archive:changed', result)
}

const sessionArchiveName = (): string => database.getSetting('sessionArchiveName')?.trim() || 'Untitled session'

const validateArchiveProjectPaths = async (archive: SessionArchive): Promise<void> => {
  for (const project of archive.projects) {
    let real: string
    try { real = await fs.realpath(project.path) }
    catch { throw new Error(`Project folder is unavailable: ${project.path}`) }
    if (!(await fs.stat(real)).isDirectory()) throw new Error(`Project path is not a folder: ${project.path}`)
  }
}

const saveSessionArchive = async (owner?: BrowserWindow | null): Promise<SessionArchiveResult | null> => {
  if (archiveBusy) throw new Error('Another session archive operation is already running.')
  archiveBusy = true
  try {
    await flushEditorWindows(editorWindows())
    const current = sessionArchiveName()
    const options: Electron.SaveDialogOptions = {
      title: 'Save Conductor session', buttonLabel: 'Save session',
      defaultPath: current === 'Untitled session' ? 'Conductor session.conductor-session' : current + '.conductor-session',
      filters: [{ name: 'Conductor session', extensions: ['conductor-session'] }]
    }
    const result = await testDialogs.showSaveDialog(liveWindow(owner), options)
    if (result.canceled || !result.filePath) return null
    const name = basename(result.filePath, extname(result.filePath)).trim().slice(0, 200) || 'Conductor session'
    const archive = database.sessionArchive(name)
    await writeSessionArchive(result.filePath, archive)
    database.setSetting('sessionArchiveName', name)
    const saved = { name, selection: archive.selection }
    broadcastSessionArchive(saved)
    return saved
  } finally { archiveBusy = false }
}

const stopReplacedDesk = async (archive: SessionArchive, activeIds: Set<string>): Promise<string[]> => {
  const failures: string[] = []
  for (const agent of archive.agents) {
    if (!activeIds.has(agent.spec.id) || !remoteControl?.mirror.isRemote(agent.spec.id)) continue
    try { await remoteControl.mirror.interrupt(agent.spec.id) }
    catch { failures.push(agent.spec.title) }
  }
  for (const workspace of archive.workspaces) {
    agents.killSession(workspace.id)
    terminals.killSession(workspace.id)
  }
  for (const project of archive.projects) browserViews?.releaseProject(project.id)
  return failures
}

const openSessionArchive = async (owner?: BrowserWindow | null): Promise<SessionArchiveResult | null> => {
  if (archiveBusy) throw new Error('Another session archive operation is already running.')
  archiveBusy = true
  try {
    const options: Electron.OpenDialogOptions = { title: 'Open Conductor session', buttonLabel: 'Open session', properties: ['openFile'], filters: [{ name: 'Conductor session', extensions: ['conductor-session'] }] }
    const selected = await testDialogs.showOpenDialog(liveWindow(owner), options)
    if (selected.canceled || !selected.filePaths[0]) return null
    const importedArchive = await readSessionArchive(selected.filePaths[0])
    await validateArchiveProjectPaths(importedArchive)
    const windows = editorWindows()
    await flushEditorWindows(windows)
    const dirty = database.listEditorDrafts().filter(draft => draft.content !== draft.baseContent)
    const active = runningWork()
    const nativeActive = agents.nativeCli.hasSubmittedInput()
    if (dirty.length || active.length || nativeActive) {
      const confirmed = await closeConfirmation.request(async () => (await showDecision(liveWindow(owner), {
        type: 'warning', title: 'Open saved session?', message: `Replace this desk with “${importedArchive.name}”?`,
        detail: `${dirty.length ? `${dirty.length} unsaved editor draft${dirty.length === 1 ? '' : 's'} will be kept in the recovery snapshot.\n` : ''}${active.length || nativeActive ? 'Running work in every project and window will be interrupted after the current desk is safely archived.\n' : ''}\nCancel keeps the current desk and all work unchanged.`,
        buttons: ['Open session', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
      })) === 0)
      if (!confirmed) return null
    }

    // Capture the exact current desk after the decision and preserve it before any replacement.
    const previous = database.sessionArchive(sessionArchiveName())
    const recoveryDirectory = join(app.getPath('userData'), 'session-recovery')
    await fs.mkdir(recoveryDirectory, { recursive: true })
    await writeSessionArchive(join(recoveryDirectory, 'previous.conductor-session'), previous)
    const activeIds = new Set(runningWork().map(process => process.id))
    const result = database.importSessionArchive(importedArchive)

    const stopFailures = await stopReplacedDesk(previous, activeIds)
    replacingDesk = true
    try {
      for (const window of [...detachedWindows.values()]) if (!window.isDestroyed()) window.destroy()
      detachedWindows.clear()
    } finally { replacingDesk = false }

    const nextProjects = database.listDeskProjects()
    const nextProjectIds = new Set(nextProjects.map(project => project.id))
    for (const project of previous.projects) if (!nextProjectIds.has(project.id)) projectFileChanges?.forget(project.id)
    for (const project of nextProjects) {
      projectFileChanges?.watch(project)
      void projectBacklogs.ensure(project.id).catch(error => console.warn('Imported project task file unavailable', error))
    }
    for (const record of database.listDeskDetachedWindows()) openDetachedWindow(record.id)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
    broadcastSessionArchive(result)
    if (stopFailures.length) await showDecision(liveWindow(mainWindow), { type: 'warning', title: 'Some remote work could not be stopped', message: 'The saved session opened, but these remote conversations may still be running:', detail: stopFailures.join('\n'), buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true })
    return result
  } finally { archiveBusy = false }
}

const reportMenuError = async (reason: unknown): Promise<void> => {
  await showDecision(liveWindow(), { type: 'error', title: 'Session operation failed', message: reason instanceof Error ? reason.message : String(reason), buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true })
}

const installApplicationMenu = (): void => {
  const target = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? liveWindow()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { id: 'open-session', label: 'Open Session…', accelerator: 'CmdOrCtrl+Shift+O', click: () => { void openSessionArchive(target()).catch(reportMenuError) } },
      { id: 'save-session', label: 'Save Session…', accelerator: 'CmdOrCtrl+Shift+S', click: () => { void saveSessionArchive(target()).catch(reportMenuError) } },
      { type: 'separator' },
      { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => target()?.webContents.send('window:close-tab') },
      { type: 'separator' },
      { label: 'Quit', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', click: () => app.quit() }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]))
}

const folderExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

const safeProjectFolderName = (name: string): string => {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 100)
  if (!cleaned) throw new Error('Enter a project name')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`
  return cleaned
}

/**
 * A new project on this computer's disk, from the owner's own "New project" and from a paired
 * machine's `projects.create` alike. One path for both, so a project the laptop asks MAIN to make
 * is the same kind of project as one made on MAIN - same folder, same backlog, same watcher - and
 * so a project made here reaches the machines already linked to this one instead of being
 * invisible on them.
 */
/** An existing folder becomes (or already is) a project on this desk: the open-folder dialog and
 *  the owner control credential's projects.open share this one path. */
const registerProjectFolder = async (requested: string, name?: string): Promise<ProjectRecord> => {
  const path = resolve(requested)
  if (!(await folderExists(path))) throw new Error(`Project folder is unavailable: ${path}`)
  const project = database.upsertProject(path, name?.trim() || basename(path))
  database.includeDeskProject(project.id)
  await projectBacklogs.ensure(project.id)
  projectFileChanges?.watch(project)
  remoteControl?.shareNewProject(project.id)
  return project
}

const addLocalProject = async (name: string): Promise<ProjectRecord> => {
  const settings = getAppSettings()
  const folderName = safeProjectFolderName(name)
  await fs.mkdir(settings.projectsRoot, { recursive: true })
  let target = join(settings.projectsRoot, folderName)
  let suffix = 2
  while (await folderExists(target)) {
    target = join(settings.projectsRoot, `${folderName} ${suffix}`)
    suffix += 1
  }
  await fs.mkdir(target)
  const project = database.upsertProject(target, basename(target))
  database.includeDeskProject(project.id)
  await projectBacklogs.ensure(project.id)
  projectFileChanges?.watch(project)
  remoteControl?.shareNewProject(project.id)
  return project
}

/**
 * Every path this process resolves is a path on this computer's disk, so a project that lives on
 * another machine can never reach one. The refusal is here, at the resolver, rather than only at
 * each of the two dozen handlers above it: a handler added later inherits the guard instead of
 * being one review away from quietly reading this disk for MAIN's project. See project-scope.ts.
 */
const resolveProjectPath = (projectId: string, requested = '', feature = 'Files'): string => {
  const project = localProject(database, projectId, feature)
  return resolveWithinProject(project.path, requested)
}

const resolveExistingProjectPath = async (projectId: string, requested = '', feature = 'Files'): Promise<string> => {
  const project = localProject(database, projectId, feature)
  const target = resolveWithinProject(project.path, requested)
  const [realRoot, realTarget] = await Promise.all([fs.realpath(project.path), fs.realpath(target)])
  resolveWithinProject(realRoot, realTarget)
  return target
}

const resolveEditorPath = async (projectId: string, requested: string): Promise<string> => {
  const target = resolveProjectPath(projectId, requested, 'The code editor')
  try {
    await resolveExistingProjectPath(projectId, requested, 'The code editor')
    return await fs.realpath(target)
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
    const parent = await resolveExistingProjectPath(projectId, dirname(requested), 'The code editor')
    return join(await fs.realpath(parent), basename(target))
  }
}

/** Every renderer persistence route uses the same live-tab protection. */
const guardSessionLayout = (sessionId: string, layout: WorkspaceLayout, closedTabs: PaneTab[]): ReturnType<typeof guardLayoutSave> => {
  const previous = database.getSession(sessionId)?.layout ?? null
  const hasLiveWork = (id: string): boolean => {
    if (database.structured.spec<AgentSpec>(id)?.sessionId !== sessionId) return false
    const state = database.structured.snapshot(id)
    return Boolean(state && hasSessionWork(state))
  }
  // Almost every save drops nothing live, so the other layouts are only read when one would be restored.
  const candidate = guardLayoutSave({ previous, next: layout, closedTabs, elsewhereTabIds: new Set(), hasLiveWork })
  if (!candidate.restoredTabIds.length) return candidate
  const elsewhereTabIds = new Set<string>(), elsewhereResourceIds = new Set<string>()
  const collect = (node: LayoutNode): void => {
    if (node.type === 'split') { node.children.forEach(collect); return }
    for (const tab of node.tabs) {
      elsewhereTabIds.add(tab.id)
      if (tab.kind === 'agent' && tab.resourceId) elsewhereResourceIds.add(tab.resourceId)
    }
  }
  for (const project of database.listProjects()) for (const session of database.listSessions(project.id)) {
    if (session.id !== sessionId) collect(session.layout.root)
  }
  for (const detached of database.listDetachedWindows()) collect(detached.layout.root)
  const repaired = guardLayoutSave({ previous, next: layout, closedTabs, elsewhereTabIds, elsewhereResourceIds, hasLiveWork })
  if (repaired.restoredTabIds.length) console.warn('Restored live tabs dropped by a layout save:', repaired.restoredTabIds.join(', '))
  return repaired
}

const guardRecoveryCheckpoint = (snapshot: WorkspaceRecoveryCheckpoint): { checkpoint: WorkspaceRecoveryCheckpoint; restored: Array<{ sessionId: string; restoredTabIds: string[]; layout: WorkspaceLayout }> } => {
  const restored: Array<{ sessionId: string; restoredTabIds: string[]; layout: WorkspaceLayout }> = []
  const sessions = snapshot.sessions.map(session => {
    const repaired = guardSessionLayout(session.id, session.layout, session.closedTabs)
    if (repaired.restoredTabIds.length) restored.push({ sessionId: session.id, ...repaired })
    return { ...session, layout: repaired.layout }
  })
  return { checkpoint: { ...snapshot, sessions }, restored }
}

const registerIpc = (): void => {
  /** A restore names a turn, a file or one recorded edit. Nothing else reaches the disk. */
  const revertScope = (value: unknown): RevertScope => {
    const scope = value as Partial<RevertScope> & { kind?: string }
    if (!scope || typeof scope !== 'object') throw new Error('Invalid revert request')
    if (scope.kind === 'turn' && typeof (scope as { turnKey?: unknown }).turnKey === 'string') return { kind: 'turn', turnKey: (scope as { turnKey: string }).turnKey.slice(0, 200) }
    if (scope.kind === 'file' && typeof (scope as { path?: unknown }).path === 'string') return { kind: 'file', path: (scope as { path: string }).path.slice(0, 1024) }
    if (scope.kind === 'edit' && typeof (scope as { itemId?: unknown }).itemId === 'string' && Number.isSafeInteger((scope as { index?: unknown }).index)) return { kind: 'edit', itemId: (scope as { itemId: string }).itemId.slice(0, 200), index: (scope as { index: number }).index }
    throw new Error('Invalid revert request')
  }
  const structuredId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid session identifier')
    return value
  }
  const trustedStructured = (event: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>): void => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const known = owner && (owner === mainWindow || owner === debugWindow || [...detachedWindows.values()].includes(owner))
    const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
    if (!known || owner.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame || !isStructuredRendererUrl(event.senderFrame.url, rendererUrl)) throw new Error('Structured controls require the trusted Conductor document')
  }
  const browserProject = (projectId: unknown): string => {
    const id = structuredId(projectId)
    // The guest is an isolated view scoped by its partition, not by a folder: for a project that
    // lives on a host it loads a loopback tunnel on this computer and reads nothing here. The
    // genuinely local surfaces - the file preview server and "open in browser" - keep their guard.
    if (!database.getProject(id)) throw new Error('That project is not registered on this machine.')
    return id
  }
  ipcMain.handle('session-archive:name', (event) => {
    trustedStructured(event)
    return sessionArchiveName()
  })
  ipcMain.handle('session-archive:save', (event) => {
    trustedStructured(event)
    return saveSessionArchive(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('session-archive:open', (event) => {
    trustedStructured(event)
    return openSessionArchive(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('session-archive:activate-resource', (event, kind: unknown, id: unknown) => {
    trustedStructured(event)
    if (kind !== 'agent' && kind !== 'terminal') throw new Error('Invalid saved resource kind')
    database.activateImportedResource(kind, structuredId(id))
  })
  ipcMain.handle('browser:mount', (event, request: BrowserSurfaceRequest) => {
    trustedStructured(event)
    if (!request || browserProject(request.projectId) !== request.projectId) throw new Error('Invalid browser project')
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error('Browser surface window is unavailable')
    return browserViews!.mount(owner, request)
  })
  ipcMain.handle('browser:update', (event, request: BrowserSurfaceRequest) => {
    trustedStructured(event)
    if (!request || browserProject(request.projectId) !== request.projectId) throw new Error('Invalid browser project')
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error('Browser surface window is unavailable')
    return browserViews!.update(owner, request)
  })
  ipcMain.handle('browser:command', (event, projectId: string, command: BrowserSurfaceCommand) => {
    trustedStructured(event); return browserViews!.command(browserProject(projectId), command)
  })
  ipcMain.handle('browser:present', (event, projectId: string, presentation: BrowserPresentation) => {
    trustedStructured(event); return browserViews!.present(browserProject(projectId), presentation)
  })
  ipcMain.handle('structured:snapshot', (event, id) => { trustedStructured(event); return database.structured.snapshot(structuredId(id)) })
  ipcMain.handle('structured:connect', (event, id) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.connect(sessionId)
    return agents.structured.connectSession(sessionId)
  })
  ipcMain.handle('structured:events', (event, id, after = 0) => { trustedStructured(event); if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid sequence'); return database.structured.events(structuredId(id), after) })
  ipcMain.handle('files:import-image', async (event, projectId: string, name: unknown, bytes: unknown) => {
    trustedStructured(event)
    const project = localProject(database, projectId, 'Importing an image into the project')
    const attachment = await importPromptImage(project.path, name, bytes)
    invalidateProjectFiles(project.path)
    return attachment
  })
  ipcMain.handle('files:attach-context', async (event, projectId: string, requested: string) => {
    trustedStructured(event)
    const project = localProject(database, projectId, 'Attaching a project file')
    return projectPromptAttachment(project.path, requested)
  })
  ipcMain.handle('files:import-context-path', async (event, projectId: string, sourcePath: string, name: string, mimeType: string) => {
    trustedStructured(event)
    const project = localProject(database, projectId, 'Importing a file into the project')
    const attachment = await importPromptAttachmentPath(project.path, sourcePath, name, mimeType)
    invalidateProjectFiles(project.path)
    return attachment
  })
  ipcMain.handle('files:move-external-drop', async (event, projectId: string, sourcePath: string, requestedDirectory: string) => {
    trustedStructured(event)
    const project = localProject(database, projectId, 'Dropping a file into the project')
    const moved = await moveExternalDropIntoProject(project.path, sourcePath, requestedDirectory)
    invalidateProjectFiles(project.path)
    return { ...moved, relativePath: relative(project.path, moved.path).replaceAll('\\', '/'), kind: 'file' as const }
  })
  ipcMain.handle('structured:queue', (event, id, text, settings, attachments) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.queue(sessionId, String(text), settings, attachments)
    return agents.structured.queue(sessionId, text, settings, attachments)
  })
  ipcMain.handle('structured:steer', (event, id, text, settings, attachments) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.submit(sessionId, String(text), 'agents.steer', settings, attachments)
    return agents.structured.steer(sessionId, text, settings, attachments)
  })
  ipcMain.handle('structured:cancel-queued', (event, id, promptId?: string) => {
    trustedStructured(event)
    if (promptId !== undefined && typeof promptId !== 'string') throw new Error('Invalid queued prompt')
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.cancelQueued(sessionId, promptId)
    return agents.structured.cancelQueued(sessionId, promptId)
  })
  ipcMain.handle('native-cli:ensure', (event, id) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Native CLI handoff')
    return agents.nativeCli.ensure(sessionId)
  })
  ipcMain.handle('native-cli:chat', (event, id) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Native CLI handoff')
    return agents.nativeCli.switchToChat(sessionId)
  })
  ipcMain.on('native-cli:write', (event, id, data) => { try { trustedStructured(event); const sessionId = structuredId(id); if (!remoteControl?.mirror.isRemote(sessionId)) agents.nativeCli.write(sessionId, data) } catch { /* reject untrusted/invalid input */ } })
  ipcMain.on('native-cli:resize', (event, id, cols, rows) => { try { trustedStructured(event); const sessionId = structuredId(id); if (!remoteControl?.mirror.isRemote(sessionId)) agents.nativeCli.resize(sessionId, cols, rows) } catch { /* reject untrusted/invalid input */ } })
  ipcMain.handle('structured:submit', (event, id, text, settings, attachments) => {
    trustedStructured(event)
    // A tab placed on another machine has no local runtime; the prompt belongs to that machine.
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.submit(sessionId, String(text), 'agents.submit', settings, attachments)
    return agents.structured.submit(sessionId, text, settings, attachments)
  })
  ipcMain.handle('structured:respond', (event, response) => {
    trustedStructured(event)
    const sessionId = structuredId(response?.sessionId)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.respond({ ...response, sessionId })
    return agents.structured.respond(response)
  })
  ipcMain.handle('structured:interrupt', (event, id, expediteSubmittedInput?: boolean) => {
    trustedStructured(event)
    if (expediteSubmittedInput !== undefined && typeof expediteSubmittedInput !== 'boolean') throw new Error('Invalid interrupt option')
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.interrupt(sessionId, expediteSubmittedInput === true)
    return agents.structured.interrupt(sessionId, expediteSubmittedInput === true)
  })
  ipcMain.handle('structured:bind-workspace', (event, id, sessionId) => {
    trustedStructured(event)
    if (typeof sessionId !== 'string' || sessionId.length > 160) throw new Error('Invalid workspace')
    const agentSessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(agentSessionId)) return remoteControl.mirror.bindWorkspace(agentSessionId, sessionId)
    return agents.structured.bindWorkspace(agentSessionId, sessionId)
  })
  ipcMain.handle('structured:resume', (event, id, settings) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.resume(sessionId, settings)
    return agents.structured.resume(sessionId, settings)
  })
  ipcMain.handle('structured:settings', (event, id, settings) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.saveSettings(sessionId, settings)
    return agents.structured.saveSettings(sessionId, settings)
  })
  ipcMain.handle('structured:fork', (event, id) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Forking')
    return agents.structured.fork(sessionId)
  })
  ipcMain.handle('structured:discover', (event, id) => {
    trustedStructured(event)
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.discover(sessionId)
    return agents.structured.discover(sessionId)
  })
  ipcMain.handle('structured:rename', (event, id, title) => {
    trustedStructured(event)
    if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error('Invalid title')
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.rename(sessionId, title.trim())
    return agents.structured.rename(sessionId, title.trim())
  })
  ipcMain.handle('structured:archive', (event, id, archived) => {
    trustedStructured(event)
    if (typeof archived !== 'boolean') throw new Error('Invalid archive setting')
    const sessionId = structuredId(id)
    if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.archive(sessionId, archived)
    return agents.structured.archive(sessionId, archived)
  })
  ipcMain.handle('structured:history', (event, projectId, query) => { trustedStructured(event); if (query !== undefined && (typeof query !== 'string' || query.length > 500)) throw new Error('Invalid search'); return database.structured.history(structuredId(projectId), query) })
  registerConversationHistoryIpc(ipcMain, new ConversationHistory(database.structured), { trusted: trustedStructured, id: structuredId })
  ipcMain.handle('structured:search-messages', (event, projectId, query, excludeId) => { trustedStructured(event); if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid search'); return database.structured.searchMessages(structuredId(projectId), query, excludeId === undefined ? undefined : structuredId(excludeId)) })
  ipcMain.handle('structured:artifact', (event, id, artifactId) => { trustedStructured(event); const sessionId = structuredId(id); if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Remote change artifacts'); return database.structured.artifact(sessionId, structuredId(artifactId)) })
  ipcMain.handle('structured:output', (event, id, artifactId) => { trustedStructured(event); const sessionId = structuredId(id); if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Remote output artifacts'); return database.structured.output(sessionId, structuredId(artifactId)) })
  ipcMain.handle('structured:review', (event, id, artifactId, action) => { trustedStructured(event); const sessionId = structuredId(id); if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Remote change review'); return agents.structured.review(sessionId, structuredId(artifactId), action) })
  ipcMain.handle('structured:change-history', (event, id) => { trustedStructured(event); const sessionId = structuredId(id); if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Remote change history'); return agents.structured.changeHistory(sessionId) })
  ipcMain.handle('structured:revert-changes', (event, id, scope) => { trustedStructured(event); const sessionId = structuredId(id); if (remoteControl?.mirror.isRemote(sessionId)) return remoteControl.mirror.unsupported(sessionId, 'Reverting remote changes'); return agents.structured.revertChanges(sessionId, revertScope(scope)) })
  ipcMain.on('settings:get-startup', (event) => {
    event.returnValue = getAppSettings()
  })
  // The backlog is a file in the project folder and source control is git in it, so both belong to
  // the machine that holds the working copy. The renderer routes a remote project's tasks to the
  // host instead; reaching here with one is the mistake these guards make loud.
  ipcMain.handle('project-tasks:dispatch-options', (event, projectId) => { trustedStructured(event); requireLocalProject(database, projectId, 'The task list'); return projectTaskDispatcher.options(projectId) })
  ipcMain.handle('project-tasks:dispatch', (event, projectId, revision, request) => { trustedStructured(event); requireLocalProject(database, projectId, 'Dispatching a task'); return projectTaskDispatcher.dispatch(projectId, revision, request) })
  ipcMain.handle('project-tasks:get', (event, projectId: string, query?: ProjectTaskListQuery) => { trustedStructured(event); requireLocalProject(database, projectId, 'The task list'); return projectBacklogs.get(projectId, query) })
  ipcMain.handle('project-tasks:edit', async (event, projectId, revision, edit, query?: ProjectTaskListQuery) => { trustedStructured(event); const project = localProject(database, projectId, 'Editing the task list'); const result = await projectBacklogs.edit(projectId, revision, edit, { actor: 'you' }, query); invalidateProjectFiles(project.path); return result })
  ipcMain.handle('project-tasks:set-source-control', (event, projectId: string, enabled: boolean) => { trustedStructured(event); requireLocalProject(database, projectId, 'Source control'); sourceControl.setEnabled(projectId, enabled === true); return sourceControl.describe(projectId) })
  ipcMain.handle('project-tasks:changes', (event, projectId: string, taskId: string) => { trustedStructured(event); requireLocalProject(database, projectId, 'Reviewing changes'); return projectBacklogs.changes(projectId, taskId) })
  disposeScheduleIpc = registerScheduleIpc({ store: schedules, runner: scheduleRunner,
    agents: projectId => scheduledTasks.agents(projectId), openConversation: (projectId, id, title) => scheduledTasks.openConversation(projectId, id, title),
    assignScripts: (projectId, schedule) => scheduledTasks.assignScripts(projectId, schedule), changed: projectId => scheduledTasks.control.changed(projectId),
    authorize: (event, projectId) => { trustedStructured(event); requireLocalProject(database, projectId, 'Schedules') },
    reveal: path => shell.showItemInFolder(path) })
  disposeDeliveryIpc = registerDeliveryIpc({ service: delivery,
    authorize: (event, projectId) => { trustedStructured(event); requireLocalProject(database, projectId, 'Source control') },
    projectPath: projectId => localProject(database, projectId, 'Source control').path })
  disposeLogicLoopsIpc = registerLogicLoopsIpc({ database, usage: () => agents.structured.usageLimits(),
    authorize: (event, projectId) => { trustedStructured(event); requireLocalProject(database, projectId, 'Logic loops') },
    projectPath: projectId => localProject(database, projectId, 'Logic loops').path,
    changed: projectId => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('logic-loops:changed', projectId) } })
  ipcMain.handle('projects:list', () => database.listDeskProjects())
  ipcMain.handle('projects:open-folder', async () => {
    const result = await testDialogs.showOpenDialog(null, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return registerProjectFolder(result.filePaths[0])
  })
  ipcMain.handle('projects:create', async (_event, name: string) => addLocalProject(name))
  ipcMain.handle('projects:remove', (_event, projectId: string) => {
    const project = database.getProject(projectId)
    if (!project) return
    terminals.killProject(projectId)
    agents.killProject(projectId)
    browserViews?.releaseProject(projectId)
    // A project that lives on a paired machine is adopted back from that machine on its next
    // probe, so removing the row is only half of removing it: the other half is remembering that
    // the owner does not want it here.
    if (project.remote) remoteControl?.forgetRemoteProject(project)
    database.removeProject(projectId)
  })
  ipcMain.handle('projects:move', async (event, projectId: string) => {
    const project = localProject(database, projectId, 'Moving the project folder')
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: `Move ${project.name} — choose the destination folder`,
      defaultPath: dirname(project.path),
      buttonLabel: 'Move here',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = await testDialogs.showOpenDialog(owner, options)
    if (result.canceled || !result.filePaths[0]) return null

    const destinationParent = resolve(result.filePaths[0])
    const source = resolve(project.path)
    const target = resolve(destinationParent, basename(source))
    if (target.toLowerCase() === source.toLowerCase()) return project
    const targetRelativeToSource = relative(source, target)
    if (!targetRelativeToSource.startsWith('..') && !isAbsolute(targetRelativeToSource)) {
      throw new Error('A project cannot be moved inside itself')
    }
    if (await folderExists(target)) {
      throw new Error(`The destination already contains a folder named ${basename(source)}`)
    }

    terminals.killProject(projectId)
    agents.killProject(projectId)
    try {
      await fs.rename(source, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
      await fs.rm(source, { recursive: true, force: false })
    }
    return database.updateProjectPath(projectId, target)
  })
  ipcMain.handle('projects:rename', async (_event, projectId: string, requestedName: string) => {
    const project = localProject(database, projectId, 'Renaming the project folder')
    const name = safeEntryName(requestedName)
    const source = resolve(project.path)
    const target = join(dirname(source), name)
    if (target === source) return project

    if (target.toLowerCase() !== source.toLowerCase() && await folderExists(target)) {
      throw new Error(`A folder named ${name} already exists`)
    }

    terminals.killProject(projectId)
    agents.killProject(projectId)
    await fs.rename(source, target)
    try {
      return database.updateProjectLocation(projectId, target, name)
    } catch (error) {
      await fs.rename(target, source).catch(() => undefined)
      throw error
    }
  })
  ipcMain.handle('projects:reveal', (_event, path: string) => shell.showItemInFolder(path))

  ipcMain.handle('settings:get', () => getAppSettings())
  ipcMain.handle('settings:choose-projects-root', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where Conductor creates new projects',
      defaultPath: getAppSettings().projectsRoot,
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = await testDialogs.showOpenDialog(owner, options)
    if (!result.canceled && result.filePaths[0]) {
      database.setSetting('projectsRoot', resolve(result.filePaths[0]))
    }
    return getAppSettings()
  })
  ipcMain.handle('settings:set-zoom', (event, requestedZoom: number) => {
    const zoomFactor = Math.min(1.5, Math.max(0.8, Math.round(requestedZoom * 20) / 20))
    database.setSetting('zoomFactor', String(zoomFactor))
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(zoomFactor)
    BrowserWindow.fromWebContents(event.sender)?.webContents.setZoomFactor(zoomFactor)
    return getAppSettings()
  })
  ipcMain.handle('settings:set-theme', (_event, requestedTheme: ThemeId) => {
    const themeId: ThemeId = THEME_IDS.includes(requestedTheme) ? requestedTheme : 'night-owl'
    database.setSetting('themeId', themeId)
    return getAppSettings()
  })
  ipcMain.handle('settings:set-theme-variant', (_event, requestedVariant: ThemeVariant) => {
    const themeVariant: ThemeVariant = THEME_VARIANTS.includes(requestedVariant) ? requestedVariant : 'night'
    database.setSetting('themeVariant', themeVariant)
    return getAppSettings()
  })
  ipcMain.handle('settings:set-theme-auto', (_event, enabled: boolean) => {
    database.setSetting('themeAuto', String(Boolean(enabled)))
    return getAppSettings()
  })
  ipcMain.handle('settings:set-debug-logging', (_event, enabled: boolean) => {
    database.setSetting('debugLogging', String(Boolean(enabled)))
    return getAppSettings()
  })
  ipcMain.handle('settings:set-show-hidden-files', (_event, enabled: boolean) => {
    database.setSetting('showHiddenFiles', String(Boolean(enabled)))
    return getAppSettings()
  })
  ipcMain.handle('settings:set-default-file-extension', (event, requested: string) => {
    trustedStructured(event)
    const extension = normalizeNewFileExtension(requested)
    if (!extension) throw new Error('Enter a file extension such as md, txt or ts.')
    database.setSetting('defaultNewFileExtension', extension)
    return getAppSettings()
  })
  ipcMain.handle('settings:set-agent-sound-profile', (_event, requestedProfile: AgentSoundProfile) => {
    const profile: AgentSoundProfile = AGENT_SOUND_PROFILES.includes(requestedProfile) ? requestedProfile : 'soft'
    database.setSetting('agentSoundProfile', profile)
    return getAppSettings()
  })
  ipcMain.handle('settings:set-update-feed-url', (event, requestedUrl: unknown) => {
    trustedStructured(event)
    if (typeof requestedUrl !== 'string') throw new Error('Invalid update feed URL')
    const updateFeedUrl = normalizeUpdateFeedUrl(requestedUrl)
    const effectiveUrl = updateFeedUrl || process.env.CONDUCTOR_UPDATE_URL || ''
    updates.configure(effectiveUrl, getAppSettings().includeLocalUpdates)
    database.setSetting('updateFeedUrl', updateFeedUrl)
    void updates.check()
    return getAppSettings()
  })

  ipcMain.handle('settings:coworker-autoclose', (event) => { trustedStructured(event); return coworkerAutoCloseMinutes(key => database.getSetting(key)) })
  ipcMain.handle('settings:set-coworker-autoclose', (event, minutes: unknown) => {
    trustedStructured(event)
    database.setSetting(COWORKER_AUTOCLOSE_SETTING, String(normalizeCoworkerAutoCloseMinutes(minutes)))
    return coworkerAutoCloseMinutes(key => database.getSetting(key))
  })
  ipcMain.handle('settings:set-local-updates', (event, enabled: unknown) => {
    trustedStructured(event)
    if (typeof enabled !== 'boolean') throw new Error('Invalid local update setting')
    updates.configure(getAppSettings().updateFeedUrl, enabled)
    database.setSetting('includeLocalUpdates', String(enabled))
    void updates.check()
    return getAppSettings()
  })
  ipcMain.handle('updates:open-local-folder', async (event) => {
    trustedStructured(event)
    const path = join(app.getPath('userData'), 'local-updates')
    await fs.mkdir(path, { recursive: true })
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  ipcMain.handle('updates:get-state', (event) => { trustedStructured(event); return updates.getState() })
  ipcMain.handle('updates:check', (event) => { trustedStructured(event); return updates.check() })
  ipcMain.handle('updates:versions', (event) => { trustedStructured(event); return updates.versions() })
  ipcMain.handle('updates:pin-version', (event, version: string, pinned: boolean) => { trustedStructured(event); return updates.pinVersion(version, pinned) })
  ipcMain.handle('updates:rollback', (event, version: string) => { trustedStructured(event); return updates.rollback(version) })
  ipcMain.handle('updates:download', (event) => { trustedStructured(event); return updates.download() })
  ipcMain.handle('updates:install', (event) => { trustedStructured(event); return updates.install() })
  // The owner answering a wizard's restart request when no update is waiting to install.
  ipcMain.handle('updates:restart', async (event) => {
    trustedStructured(event)
    try { await relaunchConductor(false) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'UPDATE_CANCELLED') return
      throw error
    }
  })
  ipcMain.on('updates:prepare-ack', (event, requestId: string) => {
    updates.acknowledgePrepare(event.sender.id, requestId)
  })

  ipcMain.handle('sessions:list', (_event, projectId: string) => database.listSessions(projectId))
  ipcMain.handle('sessions:closed', (event) => { trustedStructured(event); return database.listClosedSessions() })
  ipcMain.handle('sessions:restore', (event, sessionId?: string) => {
    trustedStructured(event)
    if (sessionId !== undefined && typeof sessionId !== 'string') throw new Error('Invalid workspace ID')
    const restored = database.restoreSession(sessionId)
    if (restored) {
      for (const record of database.listDetachedWindows()) if (record.sessionId === restored.id) openDetachedWindow(record.id)
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (event.sender.id !== mainWindow.webContents.id) mainWindow.webContents.send('sessions:restored', restored)
        revealWindow(mainWindow)
      }
    }
    return restored
  })
  ipcMain.handle('sessions:create', (_event, projectId: string, name?: string) =>
    database.createSession(projectId, name)
  )
  ipcMain.handle('sessions:delete', (_event, sessionId: string) => {
    terminals.killSession(sessionId)
    agents.killSession(sessionId)
    for (const record of database.listDetachedWindows()) if (record.sessionId === sessionId) detachedWindows.get(record.id)?.hide()
    database.closeSession(sessionId)
  })
  ipcMain.handle('sessions:rename', (_event, sessionId: string, name: string) =>
    database.renameSession(sessionId, name)
  )
  ipcMain.handle('sessions:set-continuation', (_event, sessionId: string, enabled: boolean) =>
    database.setSessionContinuation(sessionId, enabled)
  )
  ipcMain.handle(
    'sessions:save',
    (
      _event,
      sessionId: string,
      layout: WorkspaceLayout,
      maximizedGroupId: string | null,
      closedTabs: PaneTab[]
      ) => {
      const repaired = guardSessionLayout(sessionId, layout, closedTabs)
      database.saveSession(sessionId, repaired.layout, maximizedGroupId, closedTabs)
      // A paired machine showing this workspace learns its tabs changed the way it learns anything.
      const projectId = database.getSession(sessionId)?.projectId
      if (projectId) remoteControl?.transport.host.notifyTabs(projectId, sessionId)
      return repaired.restoredTabIds.length ? repaired : undefined
    }
  )
  ipcMain.handle('sessions:list-templates', (_event, projectId: string) =>
    database.listLayoutTemplates(projectId)
  )
  ipcMain.handle(
    'sessions:save-template',
    (_event, projectId: string, name: string, layout: WorkspaceLayout) =>
      database.saveLayoutTemplate(projectId, name, layout)
  )
  ipcMain.handle('recovery:get', () => database.getWorkspaceRecoveryState())
  ipcMain.handle('recovery:checkpoint', (_event, snapshot: WorkspaceRecoveryCheckpoint) => {
    const guarded = guardRecoveryCheckpoint(snapshot)
    database.saveRecoveryCheckpoint(guarded.checkpoint)
    return guarded.restored
  })
  ipcMain.on('recovery:flush', (event, snapshot: WorkspaceRecoveryCheckpoint) => {
    try {
      database.saveRecoveryCheckpoint(guardRecoveryCheckpoint(snapshot).checkpoint)
      event.returnValue = true
    } catch (error) {
      console.error('Failed to flush the workspace recovery checkpoint', error)
      event.returnValue = false
    }
  })

  ipcMain.handle('files:confirm-close', (event, tabIds: string[]) => { trustedStructured(event); if (!Array.isArray(tabIds) || tabIds.some((id) => typeof id !== 'string')) throw new Error('Invalid editor tabs'); return resolveUnsavedEditors(BrowserWindow.fromWebContents(event.sender), tabIds) })
  ipcMain.handle('projects:reorder', (event, ids: string[]) => {
    trustedStructured(event)
    const visibleIds = new Set(database.listDeskProjects().map(project => project.id))
    const hiddenIds = database.listProjects().map(project => project.id).filter(id => !visibleIds.has(id))
    database.reorderProjects([...ids, ...hiddenIds])
    return database.listDeskProjects()
  })
  ipcMain.handle('sessions:reorder', (event, projectId: string, ids: string[]) => { trustedStructured(event); return database.reorderSessions(projectId, ids) })
  ipcMain.handle('files:search', async (event, projectIds: string[], query: string, options: { showHidden?: boolean; activeProjectId?: string; recentPaths?: FileSearchResult[] } = {}) => {
    trustedStructured(event)
    if (!Array.isArray(projectIds) || projectIds.length > 200 || typeof query !== 'string' || query.length > 512) throw new Error('Invalid file search')
    const recentPaths = Array.isArray(options.recentPaths) ? options.recentPaths.filter((file) => file && typeof file.projectId === 'string' && typeof file.path === 'string').slice(0, 500) : undefined
    // A search across projects is the one place a remote project must not throw: the owner asked
    // about several projects at once and one of them living on MAIN is not a mistake. It is simply
    // not searched from here, because there is nothing on this disk to search.
    return searchProjectFiles(database.listProjects().filter((project) => projectIds.includes(project.id) && !isRemoteProject(project)), query, { showHidden: Boolean(options.showHidden), activeProjectId: typeof options.activeProjectId === 'string' ? options.activeProjectId : undefined, recentPaths })
  })
  ipcMain.handle('files:browser-url', async (event, projectId: string, requested: string) => { trustedStructured(event); return projectPreview.url(localProject(database, projectId, 'Previewing a file'), requested) })
  ipcMain.handle('files:open-in-browser', async (event, projectId: string, requested: string) => { trustedStructured(event); await shell.openExternal(await projectPreview.url(localProject(database, projectId, 'Opening a file in your browser'), requested)) })
  ipcMain.handle('files:list', async (_event, projectId: string, requested = '') => {
    const root = localProject(database, projectId, 'The file tree')
    const target = await resolveExistingProjectPath(projectId, requested)
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries
      .filter((entry) => !['.git', 'node_modules', 'out', 'dist'].includes(entry.name))
      .map((entry) => {
        const fullPath = join(target, entry.name)
        return {
          name: entry.name,
          path: fullPath,
          relativePath: relative(root.path, fullPath).replaceAll('\\', '/'),
          kind: entry.isDirectory() ? ('directory' as const) : ('file' as const)
        }
      })
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
  })
  ipcMain.handle('files:read', async (_event, projectId: string, requested: string) =>
    readExistingTextFile(await resolveExistingProjectPath(projectId, requested))
  )
  ipcMain.handle('files:read-for-editor', async (event, projectId: string, requested: string, allowBinary?: boolean) => {
    trustedStructured(event)
    return readTextFile(await resolveEditorPath(projectId, requested), { allowBinary: allowBinary === true })
  })
  ipcMain.handle('files:stat', async (_event, projectId: string, requested: string) => {
    const target = await resolveExistingProjectPath(projectId, requested)
    const stat = await fs.stat(target)
    return { size: stat.size, isFile: stat.isFile(), modifiedAt: stat.mtime.toISOString() }
  })
  ipcMain.handle('files:read-data-url', async (_event, projectId: string, requested: string) => {
    const target = await resolveExistingProjectPath(projectId, requested)
    const stat = await fs.stat(target)
    if (!stat.isFile()) throw new Error('Preview target is not a file')
    if (stat.size > 50 * 1024 * 1024) throw new Error('Preview is limited to files smaller than 50 MB')
    const mimeType = ({
      '.apng': 'image/apng', '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif',
      '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
    } as Record<string, string>)[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const data = await fs.readFile(target)
    return {
      name: basename(target),
      relativePath: relative(database.getProject(projectId)!.path, target).replaceAll('\\', '/'),
      mimeType,
      size: stat.size,
      dataUrl: `data:${mimeType};base64,${data.toString('base64')}`
    }
  })
  ipcMain.handle(
    'files:write',
    async (event, projectId: string, requested: string, content: string, expectedContent?: string | null) => {
      trustedStructured(event)
      if (typeof content !== 'string' || expectedContent !== undefined && expectedContent !== null && typeof expectedContent !== 'string') throw new Error('Invalid editor content')
      return writeEditorFile(await resolveEditorPath(projectId, requested), content, expectedContent)
    }
  )
  ipcMain.handle('files:save-copy', async (event, projectId: string, requested: string, content: string) => {
    trustedStructured(event)
    if (typeof content !== 'string') throw new Error('Invalid editor content')
    const target = await resolveEditorPath(projectId, requested)
    const copy = saveEditorCopy(target, content)
    const root = await fs.realpath(database.getProject(projectId)!.path)
    invalidateProjectFiles(root)
    return relative(root, copy).replaceAll('\\', '/')
  })
  ipcMain.handle('files:create-untitled', async (event, projectId: string, requestedDirectory: string) => {
    trustedStructured(event)
    const project = localProject(database, projectId, 'Creating a file')
    const directory = await resolveExistingProjectPath(projectId, requestedDirectory)
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Choose a destination folder')
    const target = createUntitledEditorFile(directory, getAppSettings().defaultNewFileExtension)
    invalidateProjectFiles(project.path)
    return { name: basename(target), path: target, relativePath: relative(project.path, target).replaceAll('\\', '/'), kind: 'file' as const }
  })
  ipcMain.handle(
    'files:create',
    async (
      _event,
      projectId: string,
      requestedDirectory: string,
      requestedName: string,
      kind: 'file' | 'directory'
    ) => {
      const project = database.getProject(projectId)
      if (!project) throw new Error('Project not found')
      if (kind !== 'file' && kind !== 'directory') throw new Error('Unsupported item type')

      const name = safeEntryName(requestedName)
      const directory = await resolveExistingProjectPath(projectId, requestedDirectory)
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('Choose a destination folder')
      const target = resolveWithinProject(project.path, join(requestedDirectory, name))
      if (await folderExists(target)) throw new Error(`An item named ${name} already exists`)

      try {
        if (kind === 'directory') await fs.mkdir(target)
        else await fs.writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`An item named ${name} already exists`)
        }
        throw reason
      }

      invalidateProjectFiles(project.path)
      return {
        name,
        path: target,
        relativePath: relative(project.path, target).replaceAll('\\', '/'),
        kind
      }
    }
  )
  ipcMain.handle(
    'files:rename',
    async (_event, projectId: string, requested: string, requestedName: string) => {
      const project = localProject(database, projectId, 'Renaming a file')
      if (isProjectRoot(project.path, requested)) throw new Error('Use project rename for the project root')

      const name = safeEntryName(requestedName)
      const source = resolveProjectPath(projectId, requested)
      await resolveExistingProjectPath(projectId, dirname(requested))
      const target = resolveWithinProject(project.path, join(dirname(requested), name))
      if (target !== source) {
        if (target.toLowerCase() !== source.toLowerCase() && await folderExists(target)) {
          throw new Error(`An item named ${name} already exists`)
        }
        await fs.rename(source, target)
      }
      const stat = await fs.lstat(target)
      invalidateProjectFiles(project.path)
      database.remapEditorDrafts(projectId, requested.replaceAll('\\', '/'), relative(project.path, target).replaceAll('\\', '/'), stat.isDirectory())
      return {
        name,
        path: target,
        relativePath: relative(project.path, target).replaceAll('\\', '/'),
        kind: stat.isDirectory() ? ('directory' as const) : ('file' as const)
      }
    }
  )
  ipcMain.handle(
    'files:move',
    async (_event, projectId: string, requested: string, requestedDirectory: string) => {
      const project = localProject(database, projectId, 'Moving a file')
      if (isProjectRoot(project.path, requested)) throw new Error('The project root cannot be moved')

      const source = await resolveExistingProjectPath(projectId, requested)
      const destination = await resolveExistingProjectPath(projectId, requestedDirectory)
      if (!(await fs.stat(destination)).isDirectory()) throw new Error('Choose a destination folder')

      const sourceStat = await fs.lstat(source)
      const destinationRelation = relative(
        sourceStat.isDirectory() ? await fs.realpath(source) : source,
        await fs.realpath(destination)
      )
      const destinationIsInsideSource = destinationRelation === '' || (
        !isAbsolute(destinationRelation) &&
        destinationRelation !== '..' &&
        !destinationRelation.startsWith(`..${sep}`)
      )
      if (sourceStat.isDirectory() && destinationIsInsideSource) {
        throw new Error('A folder cannot be moved inside itself')
      }

      const target = resolveWithinProject(project.path, join(requestedDirectory, basename(source)))
      if (target !== source) {
        if (sourceStat.isFile()) await moveProjectDropWithinProject(project.path, requested, requestedDirectory)
        else {
          if (await folderExists(target)) throw new Error(`An item named ${basename(source)} already exists`)
          await fs.rename(source, target)
        }
      }
      invalidateProjectFiles(project.path)
      database.remapEditorDrafts(projectId, requested.replaceAll('\\', '/'), relative(project.path, target).replaceAll('\\', '/'), sourceStat.isDirectory())
      return {
        name: basename(target),
        path: target,
        relativePath: relative(project.path, target).replaceAll('\\', '/'),
        kind: sourceStat.isDirectory() ? ('directory' as const) : ('file' as const)
      }
    }
  )
  ipcMain.handle('files:trash', async (_event, projectId: string, requested: string) => {
    const project = localProject(database, projectId, 'Deleting a file')
    if (isProjectRoot(project.path, requested)) throw new Error('The project root cannot be deleted')
    await shell.trashItem(await resolveExistingProjectPath(projectId, requested))
    invalidateProjectFiles(project.path)
  })
  ipcMain.handle('files:reveal', async (_event, projectId: string, requested = '') => {
    const target = await resolveExistingProjectPath(projectId, requested)
    shell.showItemInFolder(target)
  })
  ipcMain.handle('files:open-external', async (_event, projectId: string, requested: string) => {
    const target = await resolveExistingProjectPath(projectId, requested)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })
  const editorMachine = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : LOCAL_MACHINE_ID
  /**
   * An unsaved edit is the one thing about a host's file that lives on this computer, so drafts are
   * the single project-scoped store a remote project may use. What is skipped for one is only the
   * local containment check - there is no local root to contain it - and the draft still never
   * becomes a write to this disk: `resolveUnsavedEditors` sends it back to the host, or, once the
   * owner has detached, keeps it as a labelled recovery draft and saves it nowhere at all.
   */
  const checkDraftPath = (projectId: string, requested: string, machineId: string): void => {
    if (machineId === LOCAL_MACHINE_ID) { resolveProjectPath(projectId, requested, 'The code editor'); return }
    if (typeof requested !== 'string' || !requested || requested.length > 4096) throw new Error('Invalid editor path')
  }
  ipcMain.handle('files:get-draft', (_event, tabId: string, projectId: string, requested: string, machineId?: string) => {
    const machine = editorMachine(machineId)
    checkDraftPath(projectId, requested, machine)
    return database.getEditorDraft(tabId, projectId, requested, machine)
  })
  ipcMain.on(
    'files:checkpoint-draft',
    (event, tabId: string, projectId: string, requested: string, content: string, viewState: unknown, baseContent?: string | null, machineId?: string) => {
      trustedStructured(event)
      const machine = editorMachine(machineId)
      checkDraftPath(projectId, requested, machine)
      database.saveEditorDraft(tabId, projectId, requested, content, viewState, baseContent, machine)
    }
  )
  ipcMain.on(
    'files:flush-draft',
    (event, tabId: string, projectId: string, requested: string, content: string, viewState: unknown, baseContent?: string | null, machineId?: string) => {
      try {
        trustedStructured(event)
        const machine = editorMachine(machineId)
        checkDraftPath(projectId, requested, machine)
        database.saveEditorDraft(tabId, projectId, requested, content, viewState, baseContent, machine)
        event.returnValue = true
      } catch (error) {
        console.error(`Failed to flush editor draft ${tabId}`, error)
        event.returnValue = false
      }
    }
  )
  ipcMain.handle('files:remove-draft', (_event, tabId: string) => database.removeEditorDraft(tabId))

  // A terminal id bound to a paired machine is that machine's shell: the pane speaks the same
  // channels, and the binding carries every one of them there instead of to a PTY here.
  const remoteTerminal = (id: string): RemoteTerminalBindings | null =>
    remoteControl?.terminalBindings.isRemote(id) ? remoteControl.terminalBindings : null
  ipcMain.handle('terminal:ensure', (_event, spec: TerminalSpec) => remoteTerminal(spec.id)?.ensure(spec) ?? terminals.ensure(spec))
  ipcMain.handle('terminal:restart', (_event, spec: TerminalSpec) => {
    const remote = remoteTerminal(spec.id)
    if (remote) throw new Error(`Restarting a shell that runs on ${remote.get(spec.id)?.machineName || 'another machine'} is not supported yet. Close it and open a new one there.`)
    return terminals.restart(spec)
  })
  ipcMain.handle('terminal:kill', async (_event, id: string) => {
    const remote = remoteTerminal(id)
    if (remote) await remote.kill(id)
    else terminals.kill(id)
  })
  ipcMain.on('terminal:write', (_event, id: string, data: string) => {
    const remote = remoteTerminal(id)
    if (remote) remote.write(id, data)
    else terminals.write(id, data)
  })
  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
    const remote = remoteTerminal(id)
    if (remote) remote.resize(id, cols, rows)
    else terminals.resize(id, cols, rows)
  })

  // Legacy entry points also reach the structured owner. Apply the same document
  // boundary here so an embedded or navigated web page cannot bypass its IPC.
  ipcMain.handle('agent:ensure', (event, spec: AgentSpec) => {
    trustedStructured(event)
    // A mirrored session already runs on the host; only the local branch would start a process
    // here, which for a project that lives on MAIN means an agent loose in the wrong folder.
    if (remoteControl?.mirror.isRemote(spec.id)) return remoteControl.mirror.mount(spec)
    requireLocalProject(database, spec.projectId, 'Running an agent')
    return agents.ensure(spec)
  })
  ipcMain.handle('agent:activity-phases', (event, ids: string[]) => {
    trustedStructured(event)
    if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string')) throw new Error('Invalid agent ids')
    const wanted = new Set(ids)
    return Object.fromEntries(database.listAgentActivity().filter(row => wanted.has(row.id)).map(row => [row.id, row.activityPhase]))
  })
  ipcMain.handle('agent:restart', (event, spec: AgentSpec) => { trustedStructured(event); requireLocalProject(database, spec.projectId, 'Running an agent'); return agents.restart(spec) })
  ipcMain.handle('agent:submit', (event, id: string, message: string, mode?: 'manual' | 'edit' | 'plan' | 'auto') => {
    trustedStructured(event)
    return agents.submit(id, message, mode)
  })
  ipcMain.on('agent:capture-visual', (_event, id: string, body: string, active: boolean, settled: boolean) =>
    agents.captureVisual(id, body, active, settled)
  )
  ipcMain.handle('agent:list-events', (_event, id: string) => database.listAgentEvents(id))
  ipcMain.handle('agent:list-providers', () => agents.listProviders())
  ipcMain.handle('runtime:list-processes', (_event, projectId?: string) => database.listProcesses(projectId))
  ipcMain.handle('usage:weekly', async () => {
    const report = await weeklyUsage.readAsync(), saved = localAssist?.savings(report.days)
    return saved ? { ...report, localSavings: { tokensSaved: saved.tokensSaved, calls: saved.calls, modelCalls: saved.modelCalls, localInputTokens: saved.localInputTokens, localOutputTokens: saved.localOutputTokens } } : report
  })
  ipcMain.handle('activity:projects', () => projectActivitySnapshot())
  // A smoke run has to be able to show the chip a machine it is not on: an idle host, then a
  // loaded one. The fixture is re-read per call so one launch can walk through both.
  ipcMain.handle('system:metrics', () => {
    const fixture = process.env.CONDUCTOR_TEST_SYSTEM_METRICS
    if (fixture) return JSON.parse(readFileSync(fixture, 'utf8')) as SystemMetricsSnapshot
    return systemMetrics.sample()
  })
  const usageCapSnapshot = (agentSessionId: string, workspaceId: string): UsageCapSnapshot => {
    const stored = {
      tab: database.getSetting(usageCapKey('tab', agentSessionId)),
      workspace: database.getSetting(usageCapKey('workspace', workspaceId)),
      default: database.getSetting(usageCapKey('default'))
    }
    return {
      tab: parseUsageCapSetting(stored.tab), workspace: parseUsageCapSetting(stored.workspace), default: parseUsageCapSetting(stored.default),
      effective: resolveUsageCap(stored)
    }
  }
  ipcMain.handle('usage-cap:read', (_event, agentSessionId?: string, workspaceId?: string) => {
    if ([agentSessionId, workspaceId].some(id => id !== undefined && typeof id !== 'string')) throw new Error('A usage cap is read for one conversation in one workspace')
    return usageCapSnapshot(agentSessionId ?? '', workspaceId ?? '')
  })
  ipcMain.handle('usage-cap:write', (_event, scope: UsageCapScope, id: string | null, setting: unknown) => {
    if (!['tab', 'workspace', 'default'].includes(scope)) throw new Error('Unknown usage cap scope')
    if (scope !== 'default' && (typeof id !== 'string' || !id)) throw new Error('A tab or workspace cap needs its owner id')
    // A rejected cap is never stored as "no cap": that would silently disable the owner's rule.
    const parsed = setting === null || setting === undefined ? null : parseUsageCapSetting(setting)
    if (setting !== null && setting !== undefined && !parsed) throw new Error('Usage cap must be a token count or a percentage between 0 and 100')
    const key = usageCapKey(scope, id ?? undefined)
    database.setSetting(key, parsed ? JSON.stringify(parsed) : '')
  })
  ipcMain.on('agent:write', (event, id: string, data: string) => {
    try { trustedStructured(event) } catch { return }
    agents.write(id, data)
  })
  ipcMain.on('agent:respond', (event, id: string, data: string) => {
    try { trustedStructured(event) } catch { return }
    agents.respond(id, data)
  })
  ipcMain.on('agent:report-interaction', (_event, id: string, kind: 'directory_trust') => agents.reportInteraction(id, kind))
  ipcMain.on('agent:resize', (_event, id: string, cols: number, rows: number) =>
    agents.resize(id, cols, rows)
  )
  ipcMain.on('agent:interrupt', (event, id: string) => {
    try { trustedStructured(event) } catch { return }
    agents.interrupt(id)
  })
  ipcMain.on('agent-confirm:response', (event, response: AgentConfirmResponse) => {
    try { trustedStructured(event) } catch { return }
    if (typeof response?.id === 'string') agentConfirms.respond(response.id, response.allow === true)
  })
  ipcMain.on('agent-confirm:received', (event, id: unknown) => {
    try { trustedStructured(event) } catch { return }
    if (typeof id === 'string') agentConfirms.received(id)
  })
  ipcMain.handle('agent-confirm:pending', (event) => {
    trustedStructured(event)
    return agentConfirms.list()
  })

  // Memory is written about a working copy by the agents that worked on it, so it belongs to the
  // machine that runs them. A remote project's memory is MAIN's, and is read there.
  ipcMain.handle('memory:list', (_event, projectId: string, agentKey?: string) => {
    requireLocalProject(database, projectId, 'Memory')
    return database.listMemories(projectId, agentKey)
  })
  ipcMain.handle('memory:remember', (_event, input: RememberMemoryInput) => {
    if (!input || typeof input.gist !== 'string' || !isMemoryKind(input.kind)) throw new Error('A memory needs a gist and a known kind')
    requireLocalProject(database, input.projectId, 'Memory')
    // The pane writes on the owner's behalf; only the agent control surface may claim
    // agent authorship, so provenance in the pane cannot be forged from the renderer.
    return database.remember({ ...input, source: 'human', origin: undefined })
  })
  ipcMain.handle('memory:update', (_event, input: UpdateMemoryInput) => {
    if (!input || typeof input.id !== 'string') throw new Error('A memory id is required')
    return database.updateMemory(input)
  })
  ipcMain.handle('memory:prune-candidates', (_event, projectId: string, limit?: number) => {
    requireLocalProject(database, projectId, 'Memory')
    return database.memoryPruneCandidates(projectId, limit)
  })
  ipcMain.handle('memory:turn-recalls', (_event, agentSessionId: string) =>
    database.listMemoryRecalls(agentSessionId)
  )
  ipcMain.handle(
    'memory:recall',
    (_event, projectId: string, query: string, agentKey?: string, limit?: number) => {
      requireLocalProject(database, projectId, 'Memory')
      return database.recall(projectId, query, agentKey, limit)
    }
  )
  ipcMain.handle('memory:remove', (_event, id: string) => database.removeMemory(id))
  ipcMain.handle('system:open-external', (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened')
    return shell.openExternal(url)
  })
  // Chromium refuses navigator.clipboard while the document is unfocused, which
  // is exactly when a report is being copied out of a stuck window.
  ipcMain.handle('system:copy-text', (_event, value: string) => {
    if (typeof value !== 'string') throw new Error('Only text can be copied')
    clipboard.writeText(value)
  })
  ipcMain.handle('system:get-diagnostics', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }))
  ipcMain.handle('system:get-performance', (_event, browserWebContents: Record<string, number>) => {
    const metrics = app.getAppMetrics()
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]))
    const browserTabs: Record<string, { cpuPercent: number; memoryMb: number }> = {}
    for (const [tabId, webContentsId] of Object.entries(browserWebContents ?? {})) {
      if (!Number.isInteger(webContentsId) || !tabId) continue
      const guest = webContents.fromId(webContentsId)
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') continue
      const metric = byPid.get(guest.getOSProcessId())
      if (!metric) continue
      browserTabs[tabId] = {
        cpuPercent: Math.max(0, metric.cpu.percentCPUUsage),
        memoryMb: Math.max(0, metric.memory.workingSetSize / 1024)
      }
    }
    return {
      capturedAt: new Date().toISOString(),
      cpuPercent: metrics.reduce((total, metric) => total + Math.max(0, metric.cpu.percentCPUUsage), 0),
      memoryMb: metrics.reduce((total, metric) => total + Math.max(0, metric.memory.workingSetSize / 1024), 0),
      processCount: metrics.length,
      browserTabs
    }
  })
  ipcMain.handle('debug:open-window', (event, placeAtCursor = false) => {
    const source = BrowserWindow.fromWebContents(event.sender)
    if (source && source !== debugWindow) openDebugWindow(source, Boolean(placeAtCursor))
  })
  ipcMain.handle('debug:capture-screenshot', async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const source = sender === debugWindow ? debugSourceWindow : sender
    if (!source || source.isDestroyed() || source.webContents.isDestroyed()) {
      throw new Error('The source Conductor window is no longer available')
    }
    const image = await source.webContents.capturePage()
    lastDebugScreenshot = image
    const size = image.getSize()
    return {
      dataUrl: image.toDataURL(),
      width: size.width,
      height: size.height,
      capturedAt: new Date().toISOString()
    }
  })
  ipcMain.handle('debug:open-issue', async (_event, url: string) => {
    const issueUrl = new URL(url)
    if (
      issueUrl.protocol !== 'https:' ||
      issueUrl.hostname !== 'github.com' ||
      issueUrl.pathname !== '/Empire024/conductor/issues/new'
    ) {
      throw new Error('Issue reports can only be sent to the Conductor GitHub repository')
    }
    if (lastDebugScreenshot) clipboard.writeImage(lastDebugScreenshot)
    await shell.openExternal(issueUrl.toString())
    return { screenshotCopied: Boolean(lastDebugScreenshot) }
  })
  ipcMain.on('debug:publish-snapshot', (event, snapshot: DebugConsoleSnapshot) => {
    if (BrowserWindow.fromWebContents(event.sender) === debugWindow) return
    latestDebugSnapshot = {
      entries: Array.isArray(snapshot?.entries) ? snapshot.entries.slice(-300) : [],
      context: snapshot.context
    }
    if (debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.webContents.send('debug:snapshot', latestDebugSnapshot)
    }
  })
  ipcMain.handle('debug:get-snapshot', () => latestDebugSnapshot)
  ipcMain.on('debug:clear-source', () => {
    latestDebugSnapshot = latestDebugSnapshot ? { ...latestDebugSnapshot, entries: [] } : null
    if (debugSourceWindow && !debugSourceWindow.isDestroyed()) debugSourceWindow.webContents.send('debug:clear')
    if (debugWindow && !debugWindow.isDestroyed() && latestDebugSnapshot) {
      debugWindow.webContents.send('debug:snapshot', latestDebugSnapshot)
    }
  })

  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    window.isMaximized() ? window.unmaximize() : window.maximize()
  })
  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('window:is-maximized', (event) =>
    Boolean((() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      return window && (window.isMaximized() || window.isFullScreen())
    })())
  )
  ipcMain.handle('window:is-cursor-outside', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow || senderWindow.isDestroyed()) return false
    return isPointOutsideBounds(screen.getCursorScreenPoint(), senderWindow.getBounds())
  })
  ipcMain.handle(
    'window:detach',
    (_event, projectId: string, sessionId: string, tab: PaneTab, sourceLayout?: WorkspaceLayout, options?: { alwaysOnTop?: boolean }) => {
      const record = database.createDetachedWindow(projectId, sessionId, tab, sourceLayout)
      const window = openDetachedWindow(record.id, true)
      if (options?.alwaysOnTop) {
        database.setSetting('floatingDetachedWindows', JSON.stringify([...new Set([...floatingDetachedIds(), record.id])]))
        if (!backgroundWindows) window?.setAlwaysOnTop(true)
      }
      return record
    }
  )
  ipcMain.handle('window:get-detached', (_event, id: string) => {
    const record = database.getDetachedWindow(id)
    if (!record) return null
    const project = database.getProject(record.projectId)
    const session = database.getSession(record.sessionId)
    return project && session ? { record, project, session } : null
  })
  ipcMain.handle(
    'window:save-detached',
    (
      _event,
      id: string,
      layout: WorkspaceLayout,
      maximizedGroupId: string | null
    ) => database.saveDetachedWindow(id, layout, maximizedGroupId)
  )
  ipcMain.on(
    'window:flush-detached',
    (event, id: string, layout: WorkspaceLayout, maximizedGroupId: string | null) => {
      try {
        database.saveDetachedWindow(id, layout, maximizedGroupId)
        event.returnValue = true
      } catch (error) {
        console.error(`Failed to flush secondary window ${id}`, error)
        event.returnValue = false
      }
    }
  )
  if (durableJobs) {
    disposeDurableJobsIpc = registerDurableJobsIpc({
      service: durableJobs,
      authorize: (event, projectId) => { trustedStructured(event); requireLocalProject(database, structuredId(projectId), 'Durable jobs') },
      localModels: () => agents.listProviders().find(provider => provider.id === 'local')?.models.map(model => model.id) ?? [],
      publish: (channel, payload) => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload) },
      reveal: path => shell.showItemInFolder(path)
    })
  }
  if (ideasRegistration) disposeIdeasIpc = ideasRegistration.registerIpc(event => trustedStructured(event))
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  app.setAppUserModelId('io.conductor.desktop')
  const databasePath = join(app.getPath('userData'), 'conductor.db')
  database = new ConductorDatabase(databasePath)
  weeklyUsage = new WeeklyUsageSummaryService(database)
  database.reconcileInterruptedRuntimes()
  // v1 could mistake Codex's "usage limit resets available" credit notice for
  // an exhausted quota. Clear those persisted waits once; a genuinely limited
  // CLI will immediately report its real reset time again.
  if (database.getSetting(USAGE_LIMIT_DETECTION_VERSION_KEY) !== '2') {
    database.clearPendingContinuations()
    database.setSetting(USAGE_LIMIT_DETECTION_VERSION_KEY, '2')
  }
  orchestration = new OrchestrationStore(databasePath)
  schedules = new ScheduleStore(databasePath)
  collaboration = new AgentCollaborationStore(databasePath)
  const projectArgument = process.argv.find((argument) => argument.startsWith('--project-path='))
  if (projectArgument) {
    const projectPath = resolve(projectArgument.slice('--project-path='.length))
    const project = database.upsertProject(projectPath, basename(projectPath))
    database.includeDeskProject(project.id)
  }
  const conductorProject = database.listProjects().find(project => {
    try { return (JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')) as {name?:string}).name === 'conductor-desktop' } catch { return false }
  })
  if (conductorProject) schedules.ensureBuiltin(conductorProject.id, latestModelsBuiltin())
  // A project that already had the old fixed check (added from its Schedules panel) keeps it, now with its scripts.
  for (const schedule of schedules.all()) if (schedule.kind === 'latest-models-methods' && schedule.projectId !== conductorProject?.id) schedules.ensureBuiltin(schedule.projectId, latestModelsBuiltin())
  sourceControl = new SourceControl(database)
  projectBacklogs = new ProjectBacklogs(database, sourceControl)
  for (const project of database.listDeskProjects()) void projectBacklogs.ensure(project.id).catch(error => console.warn('Project task file unavailable', error))
  terminals = new TerminalManager(database)
  // The browser bridge resolves views out of the caller's own workspace through AgentControl,
  // so a session can only reach the browser tabs its own project and workspace own. It is built
  // before AgentManager because every Claude session is handed its --mcp-config at launch.
  browserViews = new BrowserViews({
    tabs: scope => control.tabs(scope),
    openBrowserTab: async scope => { await control.call(scope, 'tabs.open', { kind: 'browser', title: 'Browser' }) },
    rendererPath: join(__dirname, '../renderer/index.html'),
    createDetachedWindow: createDetachedBrowserWindow,
    publishState: state => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('browser:state', state) }
  })
  browserMcp = new BrowserMcpServer(browserViews)
  agents = new AgentManager(database, new AgentCollaborationRuntime(collaboration), spec => agentControlServer?.briefing(spec) ?? '', browserMcp)
  // What a window is told about a conversation, the owner's phone is told too: session events
  // and phase changes come from the agent manager's own broadcast, mirrored-machine events and
  // structural changes through publish below.
  const phoneObserve = (channel: string, payload: unknown): void => {
    if (channel === 'structured:events' && Array.isArray(payload)) phoneAccess?.observeEvents(payload as Array<{ sessionId: string; sequence: number; data: { type: string } }>)
    else if (channel === 'agent:status' && payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string') phoneAccess?.noteActivity((payload as { id: string }).id)
    else if (channel === 'projects:changed' || channel === 'remote:changed') phoneAccess?.refresh()
  }
  disposePhoneBroadcast = onBroadcast(phoneObserve)
  const publish = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload)
    // What the windows hear about this machine's own work, a paired machine subscribed to that
    // workspace hears as a notice - and then fetches, through the same signed calls it always used.
    phoneObserve(channel, payload)
    const host = remoteControl?.transport.host
    if (!host) return
    if (channel === 'structured:events' && Array.isArray(payload)) {
      for (const event of payload as Array<{ projectId: string; workspaceId: string; sessionId: string; sequence: number }>) {
        if (event?.projectId && event.workspaceId && event.sessionId) host.notifyAgents(event.projectId, event.workspaceId, event.sessionId, event.sequence)
      }
    } else if (channel === 'files:changed') {
      const change = payload as { projectId?: string; path?: string; machineId?: string }
      // A change relayed from a host is already the host's notice; only this machine's own changes go out.
      if (change?.projectId && change.path && !change.machineId) {
        host.notifyFiles(change.projectId, change.path)
        if (change.path === 'feature-list.md') host.notifyTasks(change.projectId)
      }
    } else if (channel === 'remote:changed') {
      hostLifecycle?.refresh()
    }
  }
  // A phase change can land in bursts (a turn ends, its queued follow-up starts); one coalesced
  // snapshot per burst keeps every project row current without re-querying per event.
  const publishProjectActivity = (): void => {
    if (projectActivityTimer) return
    projectActivityTimer = setTimeout(() => {
      projectActivityTimer = null
      try { publish('activity:projects', projectActivitySnapshot()) }
      catch (error) { console.warn('Project activity unavailable', error) }
    }, 120)
  }
  disposeProjectActivity = onAgentStatusChange(publishProjectActivity)
  projectFileChanges = new ProjectFileChanges(change => publish('files:changed', change))
  for (const project of database.listDeskProjects()) projectFileChanges.watch(project)
  agentControlUi = new AgentControlUi(join(__dirname, '../renderer/index.html'), request => {
    const tabs = control.tabs(request)
    const target = typeof request.params.tabId === 'string' ? tabs.find(tab => tab.id === request.params.tabId) : undefined
    if (target?.detachedId) return detachedWindows.get(target.detachedId) ?? null
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    const source = tabs.find(tab => tab.resourceId === request.agentSessionId)
    return source?.detachedId ? detachedWindows.get(source.detachedId) ?? null : null
  })
  remoteControl = new RemoteControlService({
    database, sessions: agents.structured, backlogs: projectBacklogs, terminals,
    providers: () => agents.listProviders(), ui: agentControlUi.request,
    fileChanged: change => projectFileChanges?.changed(change),
    cipher: safeStorageCipher,
    // What a paired machine's "New project on this machine" actually runs. It is this machine's
    // own project creation, so the folder lands where this machine's owner said projects go.
    createProject: name => addLocalProject(name),
    chooseRemoteDownloadPath: async description => {
      const options: Electron.SaveDialogOptions = {
        title: `Save ${basename(description.file.path)}`,
        buttonLabel: 'Save',
        defaultPath: basename(description.file.path)
      }
      const result = await testDialogs.showSaveDialog(liveWindow(), options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    publish: (channel, payload) => publish(channel, payload)
  })
  agents.structured.setPromptDispatchAuthorityGuard((authority, spec) => remoteControl!.assertPromptDispatchAuthority(authority, spec))
  // A machine hosting its other computer keeps serving with every window closed, from the tray;
  // quitting while a peer is attached is asked about, once, in the same flow as any other quit.
  hostLifecycle = installHostLifecycle(app, {
    hosting: () => {
      const state = remoteControl!.state()
      const streaming = new Set(remoteControl!.transport.host.connectedPeers())
      const phone = phoneAccess?.listenerStatus()
      return {
        enabled: state.settings.enabled || Boolean(phoneAccess?.getSettings().enabled),
        listening: state.listening || Boolean(phone?.listening),
        attachedPeers: [...state.peers.filter(peer => !peer.revokedAt && streaming.has(peer.id)).map(peer => peer.machineName), ...(phoneAccess?.connectedDeviceNames() ?? [])]
      }
    },
    showWindow: () => {
      const window = liveWindow(mainWindow) ?? (mainWindow = createWindow())
      if (window.isMinimized()) window.restore()
      window.show(); window.focus()
    },
    confirm: async message => (await showDecision(liveWindow(mainWindow), { type: 'question', buttons: ['Stop hosting and quit', 'Keep running'], defaultId: 1, cancelId: 1, message })) === 0,
    quit: () => { isQuitting = true; app.quit() },
    createTray: () => electronTray(ensureTrayIconFile(app.getPath('userData')))
  })
  // A failed delivery marks this build's restore point, once per run.
  const failedShips = new Set<string>()
  delivery.onChanged(run => {
    publish('delivery:changed', run)
    if (run.state === 'failed' && !failedShips.has(run.id)) { failedShips.add(run.id); updates?.recordFailedShip() }
  })
  // Annotated because the browser bridge is built earlier and reaches back through this handle;
  // without it the two initializers form an inference cycle.
  const control: AgentControl = new AgentControl({ database, sessions: agents.structured, orchestration, collaboration, backlogs: projectBacklogs,
    localUpdates: localUpdateBuilder,
    // The owner credential's reach into the app itself. `updates` is assigned further down this
    // function and only read at call time, so the closures are safe.
    host: {
      version: app.getVersion(), pid: process.pid,
      openProject: registerProjectFolder,
      updates: { state: () => updates.getState(), check: () => updates.check(), download: () => updates.download(), install: (force, initiator) => updates.install({ force }, initiator) },
      relaunch: relaunchConductor,
      requestRestart: recordRestartRequest,
      restartRequest: readRestartRequest,
      stopConfirmation: { pending: () => stopConfirmations.pending(), answer: stopWork => stopConfirmations.answer(stopWork), wouldAsk: stopQuestion }
    },
    delivery,
    localModels: { availability: localModelAvailability, servers: runningLocalServers, stop: stopRunningLocalServer },
    providers: () => agents.listProviders(), ui: agentControlUi.request,
    machines: () => remoteControl!.machines(),
    openRemote: (machineId, request) => remoteControl!.openRemote(machineId, request),
    confirm: (scope, message) => agentConfirms.request(scope.agentSessionId, message),
    fileChanged: change => projectFileChanges?.changed(change),
    linksChanged: scope => publish('agent-control:links-changed', { projectId: scope.projectId, sessionId: scope.sessionId })
  })
  projectTaskDispatcher = new ProjectTaskDispatcher({ database, backlogs: projectBacklogs, sessions: agents.structured, control, providers: () => agents.listProviders(), ui: agentControlUi.request, workspaceCreated: session => publish('sessions:restored', session), changed: projectId => { const project = database.getProject(projectId); if (project) invalidateProjectFiles(project.path); projectFileChanges?.changed({ projectId, path: 'feature-list.md' }) } })
  agentControlUi.register(control)
  agents.structured.setLocalControl((spec, method, args) => control.call({ projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id }, method, args))
  // Durable overnight jobs run in this process on the same structured runtime as every tab; a
  // renderer only views their stage conversations.
  // An unpackaged build may point every local conversation at a stand-in endpoint (the
  // durable-jobs smoke's stub model); a packaged app ignores the variable.
  if (!app.isPackaged && process.env.CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT) setLocalEndpointOverride(process.env.CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT)
  const durableJobStore = new DurableJobStore(databasePath)
  // One process-wide gate: one job generation at a time, and none while an interactive local
  // turn is in flight (llama-server runs a single slot).
  const generationGate = new LocalGenerationGate({ now: () => Date.now(), sleep: ms => new Promise(done => setTimeout(done, ms).unref?.()), interactiveActive: async () => localTurnsInFlight() ? 'an interactive local conversation is mid-turn' : null })
  const localModel = (modelId: string): ReturnType<typeof loadLocalConfig>['models'][string] | null => { try { return loadLocalConfig().models[modelId] ?? null } catch { return null } }
  const stageRuntime = gatedRuntime(structuredStageRuntime({ sessions: agents.structured, database }), generationGate, onLocalTurnStart)
  disposeDurableJobsGate = () => stageRuntime.dispose()
  durableJobs = createDurableJobsService({
    store: durableJobStore,
    runtime: stageRuntime,
    logRoot: join(app.getPath('userData'), 'durable-jobs'),
    projectPath: projectId => database.getProject(projectId)?.path ?? null,
    // The local adapter falls back to its default model for an unknown id; a job must not.
    validateModel: model => { if (!localModel(model)) throw new Error(`${model} is not a configured local model on this machine`) },
    ...durableJobPorts({
      store: durableJobStore,
      gate: generationGate,
      snapshot: id => database.structured.snapshot(id),
      modelConfig: modelId => { const model = localModel(modelId); return model ? { id: model.id, contextTokens: model.contextTokens } : null },
      endpointOverride: localEndpointOverride,
      serverPorts: (modelId, emit) => createLlamaServerPorts(modelId, emit),
      probeHealth: async modelId => {
        const model = localModel(modelId)
        if (!model) return { healthy: false, detail: `${modelId} is not configured` }
        const apiKey = readLocalApiKey()
        const port = readRunRecord(model)?.port ?? model.port
        const result = await llamaHealth(port, apiKey, 4000)
        return { healthy: result.ok, processing: result.ok ? await slotsProcessing(port, apiKey) : false, ...(result.detail ? { detail: result.detail } : {}) }
      }
    })
  })
  control.setDurableJobs(durableJobs)
  // Finished coworkers close themselves, and a settled CLI is released after the owner's idle
  // timeout (src/main/coworker-autoclose.ts). A test launch may shorten the timeout to seconds.
  const autoCloseOverride = !app.isPackaged && process.env.CONDUCTOR_TEST_USER_DATA ? Number(process.env.CONDUCTOR_TEST_COWORKER_AUTOCLOSE_MS) || undefined : undefined
  coworkerAutoClose = new CoworkerAutoClose({
    settings: database, snapshot: id => database.structured.snapshot(id),
    targets: () => control.finishTargets(), close: target => control.closeFinished(target),
    release: select => agents.structured.killWhere(select),
    notice: (id, message) => { agents.structured.notice(id, message) },
    ...(autoCloseOverride ? { timeoutOverrideMs: autoCloseOverride } : {})
  })
  control.setCoworkerAutoClose(coworkerAutoClose)
  delivery.onChanged(run => coworkerAutoClose?.noteDelivery(run))
  coworkerAutoClose.start()
  // Scheduled tasks (docs/schedules.md): scripts at night and in idle windows, local churn through
  // the same generation gate as durable jobs, bounded frontier reviews only on changed evidence.
  scheduledTasks = createScheduledTasks({
    store: schedules, userData: app.getPath('userData'), database, sessions: agents.structured, control, ui: agentControlUi.request,
    providers: () => agents.listProviders(), metrics: () => systemMetrics.sample(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(), screenLocked: () => powerMonitor.getSystemIdleState(1) === 'locked',
    deliveryRunning: () => database.listDeskProjects().some(project => delivery.current(project.id)?.state === 'running'),
    localUpdateBuilding: () => localUpdateBuilder.status().state === 'running',
    durableJobsRunning: () => durableJobs?.list({ status: ['running', 'recovering'] }).length ?? 0,
    generationGate, localTurnsInFlight: () => localTurnsInFlight() > 0,
    changed: projectId => publish('schedules:changed', projectId)
  })
  scheduleRunner = scheduledTasks.runner
  control.setSchedules(scheduledTasks.control)
  // The owner's Ideas inbox (docs/ideas.md): capture shortcut, phone route, Idea Incubator
  // schedule and the local-model explorer, plus ideas.* app control.
  ideasRegistration = registerIdeas({
    databasePath, database, control, ui: agentControlUi.request,
    jobs: () => durableJobs ?? undefined,
    backlogs: projectBacklogs, schedules,
    publish: (channel, payload) => publish(channel, payload),
    window: () => liveWindow(mainWindow),
    background: backgroundWindows,
    machine: () => remoteControl!.machineName()
  })
  control.setIdeas(ideasRegistration.control)
  // The owner's own credential lives beside the app's data (docs/overseer.md): a supervisor
  // outside the app reads it to drive this Conductor with the window's authority and finds a fresh
  // one after every restart.
  agentControlServer = new AgentControlServer(control, undefined, spec => remoteControl?.machineNote(spec) ?? '', { path: join(app.getPath('userData'), 'control-owner.json'), appVersion: app.getVersion(), packaged: app.isPackaged })
  await agentControlServer.start()
  await browserMcp.start()
  // conductor-local MCP tools (src/main/local-assist): every Claude and Codex launch from here on.
  localAssist = await startLocalAssist({ structured: database.structured, userData: app.getPath('userData'), sessions: agents.structured })
    .catch(error => { console.warn('Local assist is unavailable', error); return undefined })
  control.setLocalAssist(localAssist)
  remoteControl.registerIpc()
  await remoteControl.start()
  // Phones reach this Conductor through their own listener, built on the same stores and the
  // same tab-opening path an agent uses; a conversation on a paired machine is driven through
  // that machine's mirror, exactly as the window drives it.
  phoneAccess = new PhoneAccessService({
    store: database,
    vault: new StoredSecretVault(database, safeStorageCipher),
    database,
    sessions: agents.structured,
    remote: {
      isRemote: id => remoteControl!.mirror.isRemote(id),
      openTab: request => remoteControl!.openRemoteTab(request),
      connect: id => remoteControl!.mirror.connect(id),
      submit: (id, prompt, method, settings) => remoteControl!.mirror.submit(id, prompt, method, settings),
      queue: (id, prompt, settings) => remoteControl!.mirror.queue(id, prompt, settings),
      respond: response => remoteControl!.mirror.respond(response),
      interrupt: (id, expedite) => remoteControl!.mirror.interrupt(id, expedite),
      resume: (id, settings) => remoteControl!.mirror.resume(id, settings)
    },
    providers: () => agents.listProviders(),
    machines: () => remoteControl!.machines(),
    machineName: () => remoteControl!.machineName(),
    version: app.getVersion(),
    ui: agentControlUi.request,
    metrics: () => systemMetrics.sample(),
    weeklyUsage,
    projectTasks: new PhoneProjectTasks({
      backlogs: projectBacklogs,
      remote: remoteControl.client,
      changed: project => { if (!project.remote) invalidateProjectFiles(project.path); projectFileChanges?.changed({ projectId: project.id, path: 'feature-list.md' }) }
    }),
    changed: () => { publish('phone:changed', phoneAccess!.desktopState()); hostLifecycle?.refresh() }
  })
  phoneServer = new PhoneAccessServer({
    service: phoneAccess,
    tailscale: remoteControl.tailscale,
    tailscaleCert: dnsName => {
      const executable = remoteControl!.tailscale.locate()
      if (!executable) throw new Error('Tailscale is not installed on this machine.')
      return requestTailscaleCertificate(executable, dnsName, join(app.getPath('userData'), 'phone-access'))
    }
  })
  disposePhoneIpc = registerPhoneAccessIpc({ ipcMain, service: phoneAccess, server: phoneServer, window: () => liveWindow(mainWindow), showSaveDialog: (owner, options) => testDialogs.showSaveDialog(owner, options) })
  void phoneServer.apply().catch(error => console.warn('Phone access did not start', error))
  updates = new UpdateManager({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    allowDevelopmentUpdates: process.env.CONDUCTOR_UPDATE_DEV === '1',
    localBuildDirectory: join(app.getPath('userData'), 'local-updates'),
    beforeInstall: prepareForUpdateInstall
  })
  updates.setRestartRequest(readRestartRequest())
  try {
    updates.configure(getAppSettings().updateFeedUrl, getAppSettings().includeLocalUpdates)
  } catch (error) {
    console.error('Ignoring invalid update feed configuration', error)
    updates.configure('')
  }
  registerIpc()
  installApplicationMenu()
  // Local snapshots are the only pre-git safety net, so they are kept generously but not
  // forever: age them out on launch and once a day, the way the event journal is compacted.
  const pruneSnapshots = (): void => { try { pruneDiffSnapshots(database.structured.artifactDirectory) } catch (error) { console.error('Ignoring agent snapshot prune failure', error) } }
  pruneSnapshots()
  snapshotPruneTimer = setInterval(pruneSnapshots, 24 * 60 * 60 * 1000)
  snapshotPruneTimer.unref?.()
  disposeOrchestrationIpc = registerOrchestrationIpc(orchestration)
  scheduleRunner.start()
  disposeCollaborationIpc = registerAgentCollaborationIpc(collaboration)
  // Turns the previous process kept running are rebound before any window asks for their tabs.
  try { await reattachKeptRuntimes() } catch (error) { console.error('Kept runtimes could not be reattached', error) }
  briefReattachedRuntimes()
  void startRuntimeHost()
  const initiator = takeLaunchInitiator()
  const restoreAfterUpdate = database.getSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY) === 'true'
  const savedWindowLayout = restoreAfterUpdate
    ? parseSavedWindowLayout(database.getSetting(UPDATE_WINDOW_LAYOUT_KEY))
    : null
  const detachedRecords = database.listDeskDetachedWindows()
  const restoreWithoutMain = Boolean(restoreAfterUpdate && savedWindowLayout && !savedWindowLayout.main && detachedRecords.length)
  mainWindow = restoreWithoutMain ? null : createWindow(undefined, false, savedWindowLayout?.main)
  for (const record of detachedRecords) {
    openDetachedWindow(record.id, false, savedWindowLayout?.detached[record.id])
  }
  if (restoreAfterUpdate) database.setSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY, 'false')
  // The windows first, then the wizards: the panes must exist for the resumed turns to show in.
  // A requested restart resumes its wizard however the owner restarted, even by quitting by hand.
  if (initiator) setTimeout(() => { void resumeWizardTabs(initiator) }, 4000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  // Jobs the previous process left running are reconciled and resumed once the windows are up.
  setTimeout(() => { void durableJobs?.start().catch(error => console.error('Durable jobs could not be reconciled', error)) }, 3000)
})

// 'window-all-closed' is owned by the host lifecycle: it quits exactly as before unless this machine
// is hosting its other computer, in which case the process stays up behind the tray.

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  if (quitRequest) return
  const request = (async (): Promise<void> => {
    if (hostLifecycle && !await hostLifecycle.confirmStopHosting()) return
    const decision = await confirmApplicationStop(mainWindow, 'quit')
    if (decision === 'cancel') return
    if (!await resolveUnsavedEditors(mainWindow)) return
    if (decision === 'background') await keepRunningInBackground()
    isQuitting = true
    app.quit()
  })().finally(() => { if (quitRequest === request) quitRequest = null })
  quitRequest = request
})

app.on('will-quit', () => {
  hostLifecycle?.dispose()
  void remoteControl?.dispose().catch(error => console.warn('Remote control did not shut down cleanly', error))
  disposePhoneIpc?.()
  disposePhoneBroadcast?.()
  phoneAccess?.dispose()
  void phoneServer?.dispose().catch(error => console.warn('Phone access did not shut down cleanly', error))
  if (snapshotPruneTimer) clearInterval(snapshotPruneTimer)
  projectPreview.close()
  updates?.dispose()
  disposeRuntimeServices()
  // After the agents: every runtime not kept has been told to close, and the host ends any that
  // were not by itself once this client is gone.
  setRuntimeHost(null)
  runtimeHostClient?.dispose()
})
