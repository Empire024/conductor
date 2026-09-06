import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, screen, shell, webContents } from 'electron'
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
import { normalizeThemeSettings } from './app-settings'
import { isProjectRoot, resolveWithinProject, safeEntryName } from './project-paths'
import { AgentCollaborationStore } from './agent-collaboration-store'
import { AgentCollaborationRuntime } from './agent-collaboration-runtime'
import { registerAgentCollaborationIpc } from './agent-collaboration-ipc'
import { UpdateManager } from './update-manager'
import { normalizeUpdateFeedUrl } from './update-config'

let database: ConductorDatabase
let terminals: TerminalManager
let agents: AgentManager
let orchestration: OrchestrationStore
let disposeOrchestrationIpc: (() => void) | undefined
let collaboration: AgentCollaborationStore
let disposeCollaborationIpc: (() => void) | undefined
let updates: UpdateManager
let mainWindow: BrowserWindow | null = null
const detachedWindows = new Map<string, BrowserWindow>()
let debugWindow: BrowserWindow | null = null
let debugSourceWindow: BrowserWindow | null = null
let latestDebugSnapshot: DebugConsoleSnapshot | null = null
let lastDebugScreenshot: Electron.NativeImage | null = null
let isQuitting = false
let servicesDisposed = false

const DEFAULT_ZOOM = 1.1
const UPDATE_WINDOW_LAYOUT_KEY = 'updateWindowLayout'
const RESTORE_WINDOWS_AFTER_UPDATE_KEY = 'restoreWindowsAfterUpdate'

app.setName('Conductor')

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
  installWindowStateEvents(window)

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
      const closed = database.closeDetachedWindow(detachedId)
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
    agentSoundProfile: AGENT_SOUND_PROFILES.includes(database.getSetting('agentSoundProfile') as AgentSoundProfile)
      ? database.getSetting('agentSoundProfile') as AgentSoundProfile
      : 'soft',
    updateFeedUrl: database.getSetting('updateFeedUrl') || process.env.CONDUCTOR_UPDATE_URL || ''
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

const prepareForUpdateInstall = (): void => {
  database.setSetting(UPDATE_WINDOW_LAYOUT_KEY, JSON.stringify(captureWindowLayout()))
  database.setSetting(RESTORE_WINDOWS_AFTER_UPDATE_KEY, 'true')
  // electron-updater closes windows before Electron emits before-quit. Mark the
  // close as intentional now so detached tabs remain detached for the relaunch.
  isQuitting = true
  disposeRuntimeServices()
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

const registerIpc = (): void => {
  ipcMain.on('settings:get-startup', (event) => {
    event.returnValue = getAppSettings()
  })
  ipcMain.handle('projects:list', () => database.listProjects())
  ipcMain.handle('projects:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = resolve(result.filePaths[0])
    return database.upsertProject(path, basename(path))
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
    return database.upsertProject(target, basename(target))
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
  ipcMain.handle('settings:set-agent-sound-profile', (_event, requestedProfile: AgentSoundProfile) => {
    const profile: AgentSoundProfile = AGENT_SOUND_PROFILES.includes(requestedProfile) ? requestedProfile : 'soft'
    database.setSetting('agentSoundProfile', profile)
    return getAppSettings()
  })
  ipcMain.handle('settings:set-update-feed-url', (_event, requestedUrl: string) => {
    const updateFeedUrl = normalizeUpdateFeedUrl(requestedUrl)
    database.setSetting('updateFeedUrl', updateFeedUrl)
    const effectiveUrl = updateFeedUrl || process.env.CONDUCTOR_UPDATE_URL || ''
    updates.configure(effectiveUrl)
    if (effectiveUrl) void updates.check()
    return getAppSettings()
  })

  ipcMain.handle('updates:get-state', () => updates.getState())
  ipcMain.handle('updates:check', () => updates.check())
  ipcMain.handle('updates:download', () => updates.download())
  ipcMain.handle('updates:install', () => updates.install())
  ipcMain.on('updates:prepare-ack', (event, requestId: string) => {
    updates.acknowledgePrepare(event.sender.id, requestId)
  })

  ipcMain.handle('sessions:list', (_event, projectId: string) => database.listSessions(projectId))
  ipcMain.handle('sessions:create', (_event, projectId: string, name?: string) =>
    database.createSession(projectId, name)
  )
  ipcMain.handle('sessions:delete', (_event, sessionId: string) => {
    terminals.killSession(sessionId)
    agents.killSession(sessionId)
    database.deleteSession(sessionId)
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
    async (_event, projectId: string, requested: string, content: string) => {
      const target = resolveProjectPath(projectId, requested)
      if (await folderExists(target)) await resolveExistingProjectPath(projectId, requested)
      else await resolveExistingProjectPath(projectId, dirname(requested))
      await fs.writeFile(target, content, 'utf8')
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
      return {
        name,
        path: target,
        relativePath: relative(project.path, target).replaceAll('\\', '/'),
        kind: stat.isDirectory() ? ('directory' as const) : ('file' as const)
      }
    }
  )
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
    (_event, tabId: string, projectId: string, requested: string, content: string, viewState: unknown) => {
      resolveProjectPath(projectId, requested)
      database.saveEditorDraft(tabId, projectId, requested, content, viewState)
    }
  )
  ipcMain.on(
    'files:flush-draft',
    (event, tabId: string, projectId: string, requested: string, content: string, viewState: unknown) => {
      try {
        resolveProjectPath(projectId, requested)
        database.saveEditorDraft(tabId, projectId, requested, content, viewState)
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

  ipcMain.handle('agent:ensure', (_event, spec: AgentSpec) => agents.ensure(spec))
  ipcMain.handle('agent:restart', (_event, spec: AgentSpec) => agents.restart(spec))
  ipcMain.handle('agent:submit', (_event, id: string, message: string, mode?: 'manual' | 'edit' | 'plan' | 'auto') =>
    agents.submit(id, message, mode)
  )
  ipcMain.on('agent:capture-visual', (_event, id: string, body: string, active: boolean, settled: boolean) =>
    agents.captureVisual(id, body, active, settled)
  )
  ipcMain.handle('agent:list-events', (_event, id: string) => database.listAgentEvents(id))
  ipcMain.handle('agent:list-providers', () => agents.listProviders())
  ipcMain.handle('runtime:list-processes', (_event, projectId?: string) => database.listProcesses(projectId))
  ipcMain.on('agent:write', (_event, id: string, data: string) => agents.write(id, data))
  ipcMain.on('agent:respond', (_event, id: string, data: string) => agents.respond(id, data))
  ipcMain.on('agent:report-interaction', (_event, id: string, kind: 'directory_trust') => agents.reportInteraction(id, kind))
  ipcMain.on('agent:resize', (_event, id: string, cols: number, rows: number) =>
    agents.resize(id, cols, rows)
  )
  ipcMain.on('agent:interrupt', (_event, id: string) => agents.interrupt(id))

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
  ipcMain.handle('debug:save-screenshot', async (event) => {
    if (!lastDebugScreenshot) return null
    const owner = BrowserWindow.fromWebContents(event.sender)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const options: Electron.SaveDialogOptions = {
      title: 'Save debug screenshot',
      defaultPath: join(app.getPath('pictures'), `Conductor-debug-${timestamp}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, lastDebugScreenshot.toPNG())
    return result.filePath
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
    (_event, projectId: string, sessionId: string, tab: PaneTab, sourceLayout?: WorkspaceLayout) => {
      const record = database.createDetachedWindow(projectId, sessionId, tab, sourceLayout)
      openDetachedWindow(record.id, true)
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

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  app.setAppUserModelId('io.conductor.desktop')
  const databasePath = join(app.getPath('userData'), 'conductor.db')
  database = new ConductorDatabase(databasePath)
  database.reconcileInterruptedRuntimes()
  orchestration = new OrchestrationStore(databasePath)
  collaboration = new AgentCollaborationStore(databasePath)
  const projectArgument = process.argv.find((argument) => argument.startsWith('--project-path='))
  if (projectArgument) {
    const projectPath = resolve(projectArgument.slice('--project-path='.length))
    database.upsertProject(projectPath, basename(projectPath))
  }
  terminals = new TerminalManager(database)
  agents = new AgentManager(database, new AgentCollaborationRuntime(collaboration))
  updates = new UpdateManager({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    allowDevelopmentUpdates: process.env.CONDUCTOR_UPDATE_DEV === '1',
    beforeInstall: prepareForUpdateInstall
  })
  try {
    updates.configure(getAppSettings().updateFeedUrl)
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

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  updates?.dispose()
  disposeRuntimeServices()
})
