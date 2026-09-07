import { contextBridge, ipcRenderer } from 'electron'
import type { ConductorBridge } from '../shared/ipc'
import type {
  AgentSpec,
  NormalizedAgentEvent,
  PaneTab,
  RuntimeStatusEvent,
  TerminalSpec,
  WorkspaceRecoveryCheckpoint,
  WorkspaceLayout
} from '../shared/models'
import { orchestrationBridge } from './orchestration'
import { agentCollaborationBridge } from './agent-collaboration'

const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: ConductorBridge = {
  orchestration: orchestrationBridge,
  collaboration: agentCollaborationBridge,
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    openFolder: () => ipcRenderer.invoke('projects:open-folder'),
    create: (name) => ipcRenderer.invoke('projects:create', name),
    remove: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
    rename: (projectId, name) => ipcRenderer.invoke('projects:rename', projectId, name),
    move: (projectId) => ipcRenderer.invoke('projects:move', projectId),
    reveal: (path) => ipcRenderer.invoke('projects:reveal', path)
  },
  settings: {
    getStartup: () => ipcRenderer.sendSync('settings:get-startup'),
    get: () => ipcRenderer.invoke('settings:get'),
    chooseProjectsRoot: () => ipcRenderer.invoke('settings:choose-projects-root'),
    setZoom: (zoomFactor) => ipcRenderer.invoke('settings:set-zoom', zoomFactor),
    setTheme: (themeId) => ipcRenderer.invoke('settings:set-theme', themeId),
    setThemeVariant: (themeVariant) => ipcRenderer.invoke('settings:set-theme-variant', themeVariant),
    setThemeAuto: (enabled) => ipcRenderer.invoke('settings:set-theme-auto', enabled),
    setDebugLogging: (enabled) => ipcRenderer.invoke('settings:set-debug-logging', enabled),
    setAgentSoundProfile: (profile) => ipcRenderer.invoke('settings:set-agent-sound-profile', profile),
    setUpdateFeedUrl: (url) => ipcRenderer.invoke('settings:set-update-feed-url', url)
  },
  updates: {
    getState: () => ipcRenderer.invoke('updates:get-state'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    acknowledgePrepare: (requestId) => ipcRenderer.send('updates:prepare-ack', requestId),
    onState: (callback) => subscribe('updates:state', callback),
    onPrepareInstall: (callback) => subscribe('updates:prepare-install', callback)
  },
  sessions: {
    list: (projectId) => ipcRenderer.invoke('sessions:list', projectId),
    create: (projectId, name) => ipcRenderer.invoke('sessions:create', projectId, name),
    delete: (sessionId) => ipcRenderer.invoke('sessions:delete', sessionId),
    rename: (sessionId, name) => ipcRenderer.invoke('sessions:rename', sessionId, name),
    setContinuation: (sessionId, enabled) => ipcRenderer.invoke('sessions:set-continuation', sessionId, enabled),
    save: (
      sessionId: string,
      layout: WorkspaceLayout,
      maximizedGroupId: string | null,
      closedTabs: PaneTab[]
    ) => ipcRenderer.invoke('sessions:save', sessionId, layout, maximizedGroupId, closedTabs),
    listTemplates: (projectId) => ipcRenderer.invoke('sessions:list-templates', projectId),
    saveTemplate: (projectId, name, layout) =>
      ipcRenderer.invoke('sessions:save-template', projectId, name, layout)
  },
  recovery: {
    get: () => ipcRenderer.invoke('recovery:get'),
    checkpoint: (snapshot: WorkspaceRecoveryCheckpoint) => ipcRenderer.invoke('recovery:checkpoint', snapshot),
    flush: (snapshot: WorkspaceRecoveryCheckpoint) => ipcRenderer.sendSync('recovery:flush', snapshot) === true
  },
  files: {
    list: (projectId, relativePath) => ipcRenderer.invoke('files:list', projectId, relativePath),
    read: (projectId, relativePath) => ipcRenderer.invoke('files:read', projectId, relativePath),
    readDataUrl: (projectId, relativePath) => ipcRenderer.invoke('files:read-data-url', projectId, relativePath),
    write: (projectId, relativePath, content) =>
      ipcRenderer.invoke('files:write', projectId, relativePath, content),
    create: (projectId, directory, name, kind) =>
      ipcRenderer.invoke('files:create', projectId, directory, name, kind),
    rename: (projectId, relativePath, name) =>
      ipcRenderer.invoke('files:rename', projectId, relativePath, name),
    move: (projectId, relativePath, destinationDirectory) =>
      ipcRenderer.invoke('files:move', projectId, relativePath, destinationDirectory),
    trash: (projectId, relativePath) => ipcRenderer.invoke('files:trash', projectId, relativePath),
    reveal: (projectId, relativePath) => ipcRenderer.invoke('files:reveal', projectId, relativePath),
    openExternal: (projectId, relativePath) =>
      ipcRenderer.invoke('files:open-external', projectId, relativePath),
    getDraft: (tabId, projectId, relativePath) =>
      ipcRenderer.invoke('files:get-draft', tabId, projectId, relativePath),
    checkpointDraft: (tabId, projectId, relativePath, content, viewState) =>
      ipcRenderer.send('files:checkpoint-draft', tabId, projectId, relativePath, content, viewState),
    flushDraft: (tabId, projectId, relativePath, content, viewState) => {
      ipcRenderer.sendSync('files:flush-draft', tabId, projectId, relativePath, content, viewState)
    },
    removeDraft: (tabId) => ipcRenderer.invoke('files:remove-draft', tabId)
  },
  terminals: {
    ensure: (spec: TerminalSpec) => ipcRenderer.invoke('terminal:ensure', spec),
    write: (id, data) => ipcRenderer.send('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    restart: (spec: TerminalSpec) => ipcRenderer.invoke('terminal:restart', spec),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (callback) => subscribe('terminal:data', callback),
    onStatus: (callback: (payload: RuntimeStatusEvent) => void) =>
      subscribe('terminal:status', callback)
  },
  agents: {
    ensure: (spec: AgentSpec) => ipcRenderer.invoke('agent:ensure', spec),
    write: (id, data) => ipcRenderer.send('agent:write', id, data),
    respond: (id, data) => ipcRenderer.send('agent:respond', id, data),
    reportInteraction: (id, kind) => ipcRenderer.send('agent:report-interaction', id, kind),
    submit: (id, message, mode) => ipcRenderer.invoke('agent:submit', id, message, mode),
    captureVisual: (id, body, active, settled) => ipcRenderer.send('agent:capture-visual', id, body, active, settled),
    resize: (id, cols, rows) => ipcRenderer.send('agent:resize', id, cols, rows),
    restart: (spec: AgentSpec) => ipcRenderer.invoke('agent:restart', spec),
    interrupt: (id) => ipcRenderer.send('agent:interrupt', id),
    listEvents: (id) => ipcRenderer.invoke('agent:list-events', id),
    onData: (callback) => subscribe('agent:data', callback),
    onStatus: (callback: (payload: RuntimeStatusEvent) => void) => subscribe('agent:status', callback),
    onEvent: (callback: (payload: NormalizedAgentEvent) => void) => subscribe('agent:event', callback),
    listProviders: () => ipcRenderer.invoke('agent:list-providers'),
    listProcesses: (projectId) => ipcRenderer.invoke('runtime:list-processes', projectId)
  },
  memory: {
    list: (projectId, agentKey) => ipcRenderer.invoke('memory:list', projectId, agentKey),
    remember: (input) => ipcRenderer.invoke('memory:remember', input),
    recall: (projectId, query, agentKey, limit) => ipcRenderer.invoke('memory:recall', projectId, query, agentKey, limit),
    remove: (id) => ipcRenderer.invoke('memory:remove', id)
  },
  system: {
    openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
    getDiagnostics: () => ipcRenderer.invoke('system:get-diagnostics'),
    getPerformance: (browserWebContents) => ipcRenderer.invoke('system:get-performance', browserWebContents)
  },
  debug: {
    openWindow: (placeAtCursor) => ipcRenderer.invoke('debug:open-window', placeAtCursor),
    captureScreenshot: () => ipcRenderer.invoke('debug:capture-screenshot'),
    openIssue: (url) => ipcRenderer.invoke('debug:open-issue', url),
    publishSnapshot: (snapshot) => ipcRenderer.send('debug:publish-snapshot', snapshot),
    getSnapshot: () => ipcRenderer.invoke('debug:get-snapshot'),
    clearSource: () => ipcRenderer.send('debug:clear-source'),
    onSnapshot: (callback) => subscribe('debug:snapshot', callback),
    onClearSource: (callback) => subscribe('debug:clear', callback)
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => subscribe('window:maximized-changed', callback),
    isCursorOutside: () => ipcRenderer.invoke('window:is-cursor-outside'),
    detach: (projectId, sessionId, tab, sourceLayout) =>
      ipcRenderer.invoke('window:detach', projectId, sessionId, tab, sourceLayout),
    getDetached: (id) => ipcRenderer.invoke('window:get-detached', id),
    saveDetached: (id, layout, maximizedGroupId) =>
      ipcRenderer.invoke('window:save-detached', id, layout, maximizedGroupId),
    flushDetached: (id, layout, maximizedGroupId) => {
      ipcRenderer.sendSync('window:flush-detached', id, layout, maximizedGroupId)
    },
    onDetachedClosed: (callback) => subscribe('detached:closed', callback)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('conductor', bridge)
