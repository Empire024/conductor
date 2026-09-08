import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { importPromptImage } from './prompt-images'
import { ProjectBacklogs } from './project-backlog'
import { AgentControl } from './agent-control'
import { AgentControlServer } from './agent-control-server'
import { AgentControlUi } from './agent-control-ui'
import { ProjectFileChanges } from './project-file-changes'
import { isStructuredRendererUrl } from './structured-ipc-policy'
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell, webContents } from 'electron'
import type {
  AgentSpec,
  AgentSoundProfile,
  AppSettings,
  DebugConsoleSnapshot,
  PaneTab,
  TerminalSpec,
  ThemeId,
  ThemeVariant,
  WorkspaceRecoveryCheckpoint,
  WorkspaceLayout
} from '../shared/models'
import { AGENT_SOUND_PROFILES, THEME_IDS, THEME_VARIANTS } from '../shared/models'
import { ConductorDatabase } from './database'
import { TerminalManager } from './terminal-manager'
import { AgentManager } from './agent-manager'
import {
  isPointOutsideBounds,
  isWindowPlacementVisible,
  parseSavedWindowLayout,
  type SavedWindowLayout,
  type SavedWindowPlacement
} from './window-geometry'
import { OrchestrationStore } from './orchestration-store'
import { registerOrchestrationIpc } from './orchestration-ipc'
import { normalizeNewFileExtension, normalizeThemeSettings } from './app-settings'
import { isProjectRoot, resolveWithinProject, safeEntryName } from './project-paths'
import { AgentCollaborationStore } from './agent-collaboration-store'
import { AgentCollaborationRuntime } from './agent-collaboration-runtime'
import { registerAgentCollaborationIpc } from './agent-collaboration-ipc'
import { ProjectPreviewServer } from './project-preview'
import { invalidateProjectFiles, searchProjectFiles } from './project-file-search'
import { UpdateManager } from './update-manager'
import { normalizeUpdateFeedUrl } from './update-config'
import { createUntitledEditorFile, EDITOR_CONFLICT_MESSAGE, readEditorFile, saveEditorCopy, writeEditorFile } from './editor-files'

const projectPreview = new ProjectPreviewServer()
let database: ConductorDatabase
let terminals: TerminalManager
let agents: AgentManager
let orchestration: OrchestrationStore
let disposeOrchestrationIpc: (() => void) | undefined
let collaboration: AgentCollaborationStore
let disposeCollaborationIpc: (() => void) | undefined
let projectBacklogs: ProjectBacklogs
let agentControlServer: AgentControlServer | undefined
let agentControlUi: AgentControlUi | undefined
let projectFileChanges: ProjectFileChanges | undefined
let updates: UpdateManager
let mainWindow: BrowserWindow | null = null
const detachedWindows = new Map<string, BrowserWindow>()
const floatingDetachedIds = (): string[] => {
  try { const value: unknown = JSON.parse(database.getSetting('floatingDetachedWindows') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] }
  catch { return [] }
}
let debugWindow: BrowserWindow | null = null
let debugSourceWindow: BrowserWindow | null = null
let latestDebugSnapshot: DebugConsoleSnapshot | null = null
let lastDebugScreenshot: Electron.NativeImage | null = null
let isQuitting = false
let servicesDisposed = false

const DEFAULT_ZOOM = 1.1
const UPDATE_WINDOW_LAYOUT_KEY = 'updateWindowLayout'
const USAGE_LIMIT_DETECTION_VERSION_KEY = 'usageLimitDetectionVersion'
const RESTORE_WINDOWS_AFTER_UPDATE_KEY = 'restoreWindowsAfterUpdate'

app.setName('Conductor')
// Isolated automation profile is chosen before the single-instance lock.
if (!app.isPackaged && process.env.CONDUCTOR_TEST_USER_DATA) app.setPath('userData', resolve(process.env.CONDUCTOR_TEST_USER_DATA))
if (app.isPackaged) delete process.env.CONDUCTOR_OFFLINE_TESTS

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
  window.show()
  window.focus()
})

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  // Browser guests do not bubble keyboard events into the workspace renderer.
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'e') {
        event.preventDefault()
        window.webContents.focus()
        window.webContents.send('files:open-shortcut')
      }
    })
  })
  installWindowStateEvents(window)
  let closeApproved = false
  let decidingClose = false
  window.on('close', (event) => {
    if (closeApproved || isQuitting) return
    event.preventDefault()
    if (decidingClose) return
    decidingClose = true
    void resolveUnsavedEditors(window).then((approved) => { decidingClose = false; if (approved && !window.isDestroyed()) { closeApproved = true; window.close() } })
  })

  window.once('ready-to-show', () => {
    if (visibleSavedPlacement?.maximized) window.maximize()
    window.show()
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
    if (!detachedId) {
      if (mainWindow === window) mainWindow = null
      return
    }

    detachedWindows.delete(detachedId)
    if (isQuitting) return
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
    existing.show()
    existing.focus()
    return existing
  }
  if (!database.getDetachedWindow(id)) return null
  const window = createWindow(id, placeAtCursor, savedPlacement)
  if (floatingDetachedIds().includes(id)) window.setAlwaysOnTop(true)
  detachedWindows.set(id, window)
  return window
}

const openDebugWindow = (source: BrowserWindow, placeAtCursor = false): void => {
  debugSourceWindow = source
  if (debugWindow && !debugWindow.isDestroyed()) {
    if (debugWindow.isMinimized()) debugWindow.restore()
    debugWindow.show()
    debugWindow.focus()
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
  window.once('ready-to-show', () => window.show())
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

const disposeRuntimeServices = (): void => {
  if (servicesDisposed) return
  servicesDisposed = true
  const disposals: Array<[string, () => void]> = [
    ['agent control', () => { agentControlServer?.close(); agentControlUi?.close(); projectFileChanges?.close() }],
    ['terminals', () => terminals?.dispose()],
    ['agents', () => agents?.dispose()],
    ['orchestration IPC', () => disposeOrchestrationIpc?.()],
    ['collaboration IPC', () => disposeCollaborationIpc?.()],
    ['collaboration store', () => collaboration?.close()],
    ['orchestration store', () => orchestration?.close()],
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

const prepareForUpdateInstall = async (): Promise<void> => {
  if (!await resolveUnsavedEditors(mainWindow)) throw Object.assign(new Error('Update restart cancelled. Your edits are still open.'), { code: 'UPDATE_CANCELLED' })
  database.setSetting(UPDATE_WINDOW_LAYOUT_KEY, JSON.stringify(captureWindowLayout()))
  database.setSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY, 'true')
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
        window.webContents.executeJavaScript("(() => { const event = new CustomEvent('conductor:flush-editors', { detail: { failed: false } }); window.dispatchEvent(event); if (event.detail.failed) throw new Error('An editor draft could not be preserved. Keep the window open and try again.'); })()"),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('An editor window did not respond. Try again after it recovers.')), 5000) })
      ])
    } finally { clearTimeout(timeout) }
  }))
}

let resolvingEditors: Promise<boolean> | null = null
const resolveUnsavedEditors = (owner: BrowserWindow | null, tabIds?: string[]): Promise<boolean> => {
  // Serialize decisions across windows. A caller with another scope checks again afterwards.
  if (resolvingEditors) return resolvingEditors.then((ok) => ok && resolveUnsavedEditors(owner, tabIds))
  const task = (async (): Promise<boolean> => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    await flushEditorWindows(windows)
    const drafts = database.listEditorDrafts().filter((draft) => !tabIds || tabIds.includes(draft.tabId))
    const dirty: Array<{ draft: typeof drafts[number]; target: string }> = []
    for (const draft of drafts) {
      if (!database.getProject(draft.projectId)) continue
      // Old clean buffers must not be mistaken for user edits when disk changed.
      if (draft.content === draft.baseContent) { database.removeEditorDraft(draft.tabId); continue }
      const target = await resolveEditorPath(draft.projectId, draft.path)
      const current = database.getEditorDraft(draft.tabId, draft.projectId, draft.path)
      if (current?.content !== draft.content || current?.baseContent !== draft.baseContent) return false
      const disk = readEditorFile(target)
      if (disk === draft.content) { database.removeEditorDraft(draft.tabId); continue }
      dirty.push({ draft, target })
    }
    if (!dirty.length) return true
    const options: Electron.MessageBoxOptions = {
      type: 'question', title: 'Save changes?', message: 'Save changes before closing?',
      detail: dirty.map(({ draft }) => (database.getProject(draft.projectId)?.name ?? '') + ' / ' + draft.path).join('\n'),
      buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true
    }
    const { response } = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (response === 2) return false
    // Resolve again after the dialog: a file may have moved, changed or been
    // deleted while the owner was deciding. Validate all drafts before writing.
    for (const item of dirty) item.target = await resolveEditorPath(item.draft.projectId, item.draft.path)
    for (const { draft } of dirty) {
      const current = database.getEditorDraft(draft.tabId, draft.projectId, draft.path)
      if (current?.content !== draft.content || current?.baseContent !== draft.baseContent) return false
    }
    if (response === 0) {
      const versions = new Map<string, string>()
      for (const { draft, target } of dirty) {
        const key = process.platform === 'win32' ? target.toLowerCase() : target
        if (versions.has(key) && versions.get(key) !== draft.content) throw new Error('This file has different edits in multiple workspaces: ' + draft.path + '. Save a copy from each editor to preserve both versions.')
        versions.set(key, draft.content)
        const disk = readEditorFile(target)
        if (disk !== draft.content && (draft.baseContent === undefined || disk !== draft.baseContent)) {
          for (const window of windows) if (!window.isDestroyed()) window.webContents.send('files:draft-conflict', { tabId: draft.tabId, message: EDITOR_CONFLICT_MESSAGE })
          throw new Error(draft.path + ': ' + EDITOR_CONFLICT_MESSAGE)
        }
      }
    }
    for (const { draft, target } of dirty) {
      if (response === 0) {
        const result = writeEditorFile(target, draft.content, draft.baseContent)
        if (result.status === 'conflict') {
          for (const window of windows) if (!window.isDestroyed()) window.webContents.send('files:draft-conflict', { tabId: draft.tabId, message: result.message })
          throw new Error(draft.path + ': ' + result.message)
        }
      }
      // No awaited work between validation and commit; another editor cannot
      // replace this draft during the decision's final main-process turn.
      database.removeEditorDraft(draft.tabId)
      const content = response === 0 ? draft.content : readEditorFile(target)
      for (const window of windows) if (!window.isDestroyed()) window.webContents.send('files:draft-resolved', { tabId: draft.tabId, submitted: draft.content, content, saved: response === 0 })
    }
    // Let renderer resolution handlers preserve any last edits before granting
    // close. A newer draft cancels this close without losing its original base.
    await flushEditorWindows(windows)
    return !database.listEditorDrafts().some((draft) => !tabIds || tabIds.includes(draft.tabId))
  })().catch(async (reason: unknown) => {
    const options: Electron.MessageBoxOptions = { type: 'error', title: 'Could not close editor', message: reason instanceof Error ? reason.message : String(reason) }
    if (owner && !owner.isDestroyed()) await dialog.showMessageBox(owner, options)
    else await dialog.showMessageBox(options)
    return false
  })
  resolvingEditors = task
  void task.finally(() => { if (resolvingEditors === task) resolvingEditors = null })
  return task
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

const resolveProjectPath = (projectId: string, requested = ''): string => {
  const project = database.getProject(projectId)
  if (!project) throw new Error('Project not found')
  return resolveWithinProject(project.path, requested)
}

const resolveExistingProjectPath = async (projectId: string, requested = ''): Promise<string> => {
  const project = database.getProject(projectId)
  if (!project) throw new Error('Project not found')
  const target = resolveWithinProject(project.path, requested)
  const [realRoot, realTarget] = await Promise.all([fs.realpath(project.path), fs.realpath(target)])
  resolveWithinProject(realRoot, realTarget)
  return target
}

const resolveEditorPath = async (projectId: string, requested: string): Promise<string> => {
  const target = resolveProjectPath(projectId, requested)
  try {
    await resolveExistingProjectPath(projectId, requested)
    return await fs.realpath(target)
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
    const parent = await resolveExistingProjectPath(projectId, dirname(requested))
    return join(await fs.realpath(parent), basename(target))
  }
}

const registerIpc = (): void => {
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
  ipcMain.handle('structured:snapshot', (event, id) => { trustedStructured(event); return database.structured.snapshot(structuredId(id)) })
  ipcMain.handle('structured:connect', (event, id) => { trustedStructured(event); return agents.structured.connectSession(structuredId(id)) })
  ipcMain.handle('structured:events', (event, id, after = 0) => { trustedStructured(event); if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid sequence'); return database.structured.events(structuredId(id), after) })
  ipcMain.handle('files:import-image', async (event, projectId: string, name: unknown, bytes: unknown) => {
    trustedStructured(event)
    const project = database.getProject(projectId)
    if (!project) throw new Error('Project not found')
    const attachment = await importPromptImage(project.path, name, bytes)
    invalidateProjectFiles(project.path)
    return attachment
  })
  ipcMain.handle('structured:queue', (event, id, text, settings, attachments) => { trustedStructured(event); return agents.structured.queue(structuredId(id), text, settings, attachments) })
  ipcMain.handle('structured:steer', (event, id, text, settings, attachments) => { trustedStructured(event); return agents.structured.steer(structuredId(id), text, settings, attachments) })
  ipcMain.handle('structured:cancel-queued', (event, id, promptId?: string) => { trustedStructured(event); if (promptId !== undefined && typeof promptId !== 'string') throw new Error('Invalid queued prompt'); return agents.structured.cancelQueued(structuredId(id), promptId) })
  ipcMain.handle('native-cli:ensure', (event, id) => { trustedStructured(event); return agents.nativeCli.ensure(structuredId(id)) })
  ipcMain.handle('native-cli:chat', (event, id) => { trustedStructured(event); return agents.nativeCli.switchToChat(structuredId(id)) })
  ipcMain.on('native-cli:write', (event, id, data) => { try { trustedStructured(event); agents.nativeCli.write(structuredId(id), data) } catch { /* reject untrusted/invalid input */ } })
  ipcMain.on('native-cli:resize', (event, id, cols, rows) => { try { trustedStructured(event); agents.nativeCli.resize(structuredId(id), cols, rows) } catch { /* reject untrusted/invalid input */ } })
  ipcMain.handle('structured:submit', (event, id, text, settings, attachments) => { trustedStructured(event); return agents.structured.submit(structuredId(id), text, settings, attachments) })
  ipcMain.handle('structured:respond', (event, response) => { trustedStructured(event); return agents.structured.respond(response) })
  ipcMain.handle('structured:interrupt', (event, id) => { trustedStructured(event); return agents.structured.interrupt(structuredId(id)) })
  ipcMain.handle('structured:bind-workspace', (event, id, sessionId) => { trustedStructured(event); if (typeof sessionId !== 'string' || sessionId.length > 160) throw new Error('Invalid workspace'); return agents.structured.bindWorkspace(structuredId(id), sessionId) })
  ipcMain.handle('structured:resume', (event, id, settings) => { trustedStructured(event); return agents.structured.resume(structuredId(id), settings) })
  ipcMain.handle('structured:fork', (event, id) => { trustedStructured(event); return agents.structured.fork(structuredId(id)) })
  ipcMain.handle('structured:discover', (event, id) => { trustedStructured(event); return agents.structured.discover(structuredId(id)) })
  ipcMain.handle('structured:rename', (event, id, title) => { trustedStructured(event); if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error('Invalid title'); return agents.structured.rename(structuredId(id), title.trim()) })
  ipcMain.handle('structured:archive', (event, id, archived) => { trustedStructured(event); if (typeof archived !== 'boolean') throw new Error('Invalid archive setting'); return agents.structured.archive(structuredId(id), archived) })
  ipcMain.handle('structured:history', (event, projectId, query) => { trustedStructured(event); if (query !== undefined && (typeof query !== 'string' || query.length > 500)) throw new Error('Invalid search'); return database.structured.history(structuredId(projectId), query) })
  ipcMain.handle('structured:artifact', (event, id, artifactId) => { trustedStructured(event); return database.structured.artifact(structuredId(id), structuredId(artifactId)) })
  ipcMain.handle('structured:output', (event, id, artifactId) => { trustedStructured(event); return database.structured.output(structuredId(id), structuredId(artifactId)) })
  ipcMain.handle('structured:review', (event, id, artifactId, action) => { trustedStructured(event); return agents.structured.review(structuredId(id), structuredId(artifactId), action) })
  ipcMain.on('settings:get-startup', (event) => {
    event.returnValue = getAppSettings()
  })
  ipcMain.handle('project-tasks:get', (event, projectId: string) => { trustedStructured(event); return projectBacklogs.get(projectId) })
  ipcMain.handle('project-tasks:edit', async (event, projectId, revision, edit) => { trustedStructured(event); const result = await projectBacklogs.edit(projectId, revision, edit); const project = database.getProject(projectId); if (project) invalidateProjectFiles(project.path); return result })
  ipcMain.handle('projects:list', () => database.listProjects())
  ipcMain.handle('projects:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = resolve(result.filePaths[0])
    const project = database.upsertProject(path, basename(path))
    await projectBacklogs.ensure(project.id)
    projectFileChanges?.watch(project)
    return project
  })
  ipcMain.handle('projects:create', async (_event, name: string) => {
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
    await projectBacklogs.ensure(project.id)
    projectFileChanges?.watch(project)
    return project
  })
  ipcMain.handle('projects:remove', (_event, projectId: string) => {
    const project = database.getProject(projectId)
    if (!project) return
    terminals.killProject(projectId)
    agents.killProject(projectId)
    database.removeProject(projectId)
  })
  ipcMain.handle('projects:move', async (event, projectId: string) => {
    const project = database.getProject(projectId)
    if (!project) throw new Error('Project not found')
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: `Move ${project.name} — choose the destination folder`,
      defaultPath: dirname(project.path),
      buttonLabel: 'Move here',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
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
    const project = database.getProject(projectId)
    if (!project) throw new Error('Project not found')
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
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
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
  ipcMain.handle('updates:download', (event) => { trustedStructured(event); return updates.download() })
  ipcMain.handle('updates:install', (event) => { trustedStructured(event); return updates.install() })
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
        mainWindow.show(); mainWindow.focus()
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
      ) => database.saveSession(sessionId, layout, maximizedGroupId, closedTabs)
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
    database.saveRecoveryCheckpoint(snapshot)
  })
  ipcMain.on('recovery:flush', (event, snapshot: WorkspaceRecoveryCheckpoint) => {
    try {
      database.saveRecoveryCheckpoint(snapshot)
      event.returnValue = true
    } catch (error) {
      console.error('Failed to flush the workspace recovery checkpoint', error)
      event.returnValue = false
    }
  })

  ipcMain.handle('files:confirm-close', (event, tabIds: string[]) => { trustedStructured(event); if (!Array.isArray(tabIds) || tabIds.some((id) => typeof id !== 'string')) throw new Error('Invalid editor tabs'); return resolveUnsavedEditors(BrowserWindow.fromWebContents(event.sender), tabIds) })
  ipcMain.handle('projects:reorder', (event, ids: string[]) => { trustedStructured(event); return database.reorderProjects(ids) })
  ipcMain.handle('sessions:reorder', (event, projectId: string, ids: string[]) => { trustedStructured(event); return database.reorderSessions(projectId, ids) })
  ipcMain.handle('files:search', async (event, projectIds: string[], query: string) => {
    trustedStructured(event)
    if (!Array.isArray(projectIds) || projectIds.length > 200 || typeof query !== 'string' || query.length > 512) throw new Error('Invalid file search')
    return searchProjectFiles(database.listProjects().filter((project) => projectIds.includes(project.id)), query)
  })
  ipcMain.handle('files:browser-url', async (event, projectId: string, requested: string) => { trustedStructured(event); const project = database.getProject(projectId); if (!project) throw new Error('Project not found'); return projectPreview.url(project, requested) })
  ipcMain.handle('files:open-in-browser', async (event, projectId: string, requested: string) => { trustedStructured(event); const project = database.getProject(projectId); if (!project) throw new Error('Project not found'); await shell.openExternal(await projectPreview.url(project, requested)) })
  ipcMain.handle('files:list', async (_event, projectId: string, requested = '') => {
    const root = database.getProject(projectId)
    if (!root) throw new Error('Project not found')
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
    fs.readFile(await resolveExistingProjectPath(projectId, requested), 'utf8')
  )
  ipcMain.handle('files:read-for-editor', async (event, projectId: string, requested: string) => {
    trustedStructured(event)
    return readEditorFile(await resolveEditorPath(projectId, requested))
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
    const project = database.getProject(projectId)
    if (!project) throw new Error('Project not found')
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
      const project = database.getProject(projectId)
      if (!project) throw new Error('Project not found')
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
      const project = database.getProject(projectId)
      if (!project) throw new Error('Project not found')
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
        if (await folderExists(target)) throw new Error(`An item named ${basename(source)} already exists`)
        await fs.rename(source, target)
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
    const project = database.getProject(projectId)
    if (!project) throw new Error('Project not found')
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
  ipcMain.handle('files:get-draft', (_event, tabId: string, projectId: string, requested: string) => {
    resolveProjectPath(projectId, requested)
    return database.getEditorDraft(tabId, projectId, requested)
  })
  ipcMain.on(
    'files:checkpoint-draft',
    (event, tabId: string, projectId: string, requested: string, content: string, viewState: unknown, baseContent?: string | null) => {
      trustedStructured(event)
      resolveProjectPath(projectId, requested)
      database.saveEditorDraft(tabId, projectId, requested, content, viewState, baseContent)
    }
  )
  ipcMain.on(
    'files:flush-draft',
    (event, tabId: string, projectId: string, requested: string, content: string, viewState: unknown, baseContent?: string | null) => {
      try {
        trustedStructured(event)
        resolveProjectPath(projectId, requested)
        database.saveEditorDraft(tabId, projectId, requested, content, viewState, baseContent)
        event.returnValue = true
      } catch (error) {
        console.error(`Failed to flush editor draft ${tabId}`, error)
        event.returnValue = false
      }
    }
  )
  ipcMain.handle('files:remove-draft', (_event, tabId: string) => database.removeEditorDraft(tabId))

  ipcMain.handle('terminal:ensure', (_event, spec: TerminalSpec) => terminals.ensure(spec))
  ipcMain.handle('terminal:restart', (_event, spec: TerminalSpec) => terminals.restart(spec))
  ipcMain.handle('terminal:kill', (_event, id: string) => terminals.kill(id))
  ipcMain.on('terminal:write', (_event, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )

  // Legacy entry points also reach the structured owner. Apply the same document
  // boundary here so an embedded or navigated web page cannot bypass its IPC.
  ipcMain.handle('agent:ensure', (event, spec: AgentSpec) => { trustedStructured(event); return agents.ensure(spec) })
  ipcMain.handle('agent:restart', (event, spec: AgentSpec) => { trustedStructured(event); return agents.restart(spec) })
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

  ipcMain.handle('memory:list', (_event, projectId: string, agentKey?: string) =>
    database.listMemories(projectId, agentKey)
  )
  ipcMain.handle('memory:remember', (_event, input) => database.remember(input))
  ipcMain.handle(
    'memory:recall',
    (_event, projectId: string, query: string, agentKey?: string, limit?: number) =>
      database.recall(projectId, query, agentKey, limit)
  )
  ipcMain.handle('memory:remove', (_event, id: string) => database.removeMemory(id))
  ipcMain.handle('system:open-external', (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened')
    return shell.openExternal(url)
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
        window?.setAlwaysOnTop(true)
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
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  app.setAppUserModelId('io.conductor.desktop')
  const databasePath = join(app.getPath('userData'), 'conductor.db')
  database = new ConductorDatabase(databasePath)
  database.reconcileInterruptedRuntimes()
  // v1 could mistake Codex's "usage limit resets available" credit notice for
  // an exhausted quota. Clear those persisted waits once; a genuinely limited
  // CLI will immediately report its real reset time again.
  if (database.getSetting(USAGE_LIMIT_DETECTION_VERSION_KEY) !== '2') {
    database.clearPendingContinuations()
    database.setSetting(USAGE_LIMIT_DETECTION_VERSION_KEY, '2')
  }
  orchestration = new OrchestrationStore(databasePath)
  collaboration = new AgentCollaborationStore(databasePath)
  const projectArgument = process.argv.find((argument) => argument.startsWith('--project-path='))
  if (projectArgument) {
    const projectPath = resolve(projectArgument.slice('--project-path='.length))
    database.upsertProject(projectPath, basename(projectPath))
  }
  projectBacklogs = new ProjectBacklogs(database)
  for (const project of database.listProjects()) void projectBacklogs.ensure(project.id).catch(error => console.warn('Project task file unavailable', error))
  terminals = new TerminalManager(database)
  agents = new AgentManager(database, new AgentCollaborationRuntime(collaboration), spec => agentControlServer?.briefing(spec) ?? '')
  const publish = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }
  projectFileChanges = new ProjectFileChanges(change => publish('files:changed', change))
  for (const project of database.listProjects()) projectFileChanges.watch(project)
  agentControlUi = new AgentControlUi(join(__dirname, '../renderer/index.html'), request => {
    const tabs = control.tabs(request)
    const target = typeof request.params.tabId === 'string' ? tabs.find(tab => tab.id === request.params.tabId) : undefined
    if (target?.detachedId) return detachedWindows.get(target.detachedId) ?? null
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    const source = tabs.find(tab => tab.resourceId === request.agentSessionId)
    return source?.detachedId ? detachedWindows.get(source.detachedId) ?? null : null
  })
  const control = new AgentControl({ database, sessions: agents.structured, orchestration, collaboration, backlogs: projectBacklogs,
    providers: () => agents.listProviders(), ui: agentControlUi.request,
    confirm: async (_scope, message) => {
      const options: Electron.MessageBoxOptions = { type: 'question', title: 'Agent request', message, buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, noLink: true }
      const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
      return result.response === 1
    },
    fileChanged: change => projectFileChanges?.changed(change),
    linksChanged: scope => publish('agent-control:links-changed', { projectId: scope.projectId, sessionId: scope.sessionId })
  })
  agentControlUi.register(control)
  agentControlServer = new AgentControlServer(control)
  await agentControlServer.start()
  updates = new UpdateManager({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    allowDevelopmentUpdates: process.env.CONDUCTOR_UPDATE_DEV === '1',
    localBuildDirectory: join(app.getPath('userData'), 'local-updates'),
    beforeInstall: prepareForUpdateInstall
  })
  try {
    updates.configure(getAppSettings().updateFeedUrl, getAppSettings().includeLocalUpdates)
  } catch (error) {
    console.error('Ignoring invalid update feed configuration', error)
    updates.configure('')
  }
  registerIpc()
  disposeOrchestrationIpc = registerOrchestrationIpc(orchestration)
  disposeCollaborationIpc = registerAgentCollaborationIpc(collaboration)
  const restoreAfterUpdate = database.getSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY) === 'true'
  const savedWindowLayout = restoreAfterUpdate
    ? parseSavedWindowLayout(database.getSetting(UPDATE_WINDOW_LAYOUT_KEY))
    : null
  const detachedRecords = database.listDetachedWindows()
  const restoreWithoutMain = Boolean(restoreAfterUpdate && savedWindowLayout && !savedWindowLayout.main && detachedRecords.length)
  mainWindow = restoreWithoutMain ? null : createWindow(undefined, false, savedWindowLayout?.main)
  for (const record of detachedRecords) {
    openDetachedWindow(record.id, false, savedWindowLayout?.detached[record.id])
  }
  if (restoreAfterUpdate) database.setSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY, 'false')
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  void resolveUnsavedEditors(mainWindow).then((approved) => { if (approved) { isQuitting = true; app.quit() } })
})

app.on('will-quit', () => {
  projectPreview.close()
  updates?.dispose()
  disposeRuntimeServices()
})
