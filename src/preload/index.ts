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
  agentControl: {
    openUri: uri => ipcRenderer.invoke('agent-control:open-uri', uri),
    focusTab: (projectId, sessionId, tabId) => ipcRenderer.invoke('agent-control:focus-tab', projectId, sessionId, tabId),
    links: (projectId, sessionId) => ipcRenderer.invoke('agent-control:links', projectId, sessionId),
    release: agentSessionId => ipcRenderer.invoke('agent-control:release', agentSessionId),
    onLinksChanged: callback => subscribe('agent-control:links-changed', callback),
    onRequest: callback => subscribe('agent-control:request', callback),
    respond: response => ipcRenderer.send('agent-control:response', response)
  },
  agentConfirm: {
    onRequest: callback => subscribe('agent-confirm:request', callback),
    respond: response => ipcRenderer.send('agent-confirm:response', response)
  },
  remote: {
    githubState: () => ipcRenderer.invoke('remote:github-state'),
    signIn: () => ipcRenderer.invoke('remote:github-sign-in'),
    cancelSignIn: () => ipcRenderer.invoke('remote:github-cancel'),
    signOut: () => ipcRenderer.invoke('remote:github-sign-out'),
    onGitHubState: (callback) => subscribe('remote:github-changed', callback),
    state: () => ipcRenderer.invoke('remote:state'),
    setSettings: (patch) => ipcRenderer.invoke('remote:set-settings', patch),
    createTicket: () => ipcRenderer.invoke('remote:ticket'),
    approve: (pendingId, grantedProjectIds) => ipcRenderer.invoke('remote:approve', pendingId, grantedProjectIds),
    reshareProject: (peerId, projectId) => ipcRenderer.invoke('remote:reshare-project', peerId, projectId),
    deny: (pendingId) => ipcRenderer.invoke('remote:deny', pendingId),
    revoke: (peerId) => ipcRenderer.invoke('remote:revoke', peerId),
    connect: (ticket) => ipcRenderer.invoke('remote:connect', ticket),
    forget: (machineId) => ipcRenderer.invoke('remote:forget', machineId),
    remoteProjects: (machineId) => ipcRenderer.invoke('remote:remote-projects', machineId),
    confirmProject: (machineId, localProjectId, remoteProjectId) => ipcRenderer.invoke('remote:confirm-project', machineId, localProjectId, remoteProjectId),
    releaseProject: (machineId, localProjectId) => ipcRenderer.invoke('remote:release-project', machineId, localProjectId),
    machines: () => ipcRenderer.invoke('remote:machines'),
    openTab: (request) => ipcRenderer.invoke('remote:open-tab', request),
    releaseTab: (localSessionId) => ipcRenderer.invoke('remote:release-tab', localSessionId),
    onState: (callback) => subscribe('remote:changed', callback)
  },
  projectTasks: {
    get: (projectId) => ipcRenderer.invoke('project-tasks:get', projectId),
    edit: (projectId, revision, edit) => ipcRenderer.invoke('project-tasks:edit', projectId, revision, edit),
    setSourceControl: (projectId, enabled) => ipcRenderer.invoke('project-tasks:set-source-control', projectId, enabled),
    changes: (projectId, taskId) => ipcRenderer.invoke('project-tasks:changes', projectId, taskId),
    dispatchOptions: projectId => ipcRenderer.invoke('project-tasks:dispatch-options', projectId),
    dispatch: (projectId, revision, request) => ipcRenderer.invoke('project-tasks:dispatch', projectId, revision, request)
  },
  nativeCli: {
    ensure: (id) => ipcRenderer.invoke('native-cli:ensure', id),
    chat: (id) => ipcRenderer.invoke('native-cli:chat', id),
    write: (id, data) => ipcRenderer.send('native-cli:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('native-cli:resize', id, cols, rows),
    onData: (callback) => subscribe('native-cli:data', callback),
    onStatus: (callback) => subscribe('native-cli:status', callback)
  },
  structured: {
    bindWorkspace: (id, sessionId) => ipcRenderer.invoke('structured:bind-workspace', id, sessionId),
    queue: (id, text, settings, attachments) => ipcRenderer.invoke('structured:queue', id, text, settings, attachments),
    steer: (id, text, settings, attachments) => ipcRenderer.invoke('structured:steer', id, text, settings, attachments),
    cancelQueued: (id, promptId) => ipcRenderer.invoke('structured:cancel-queued', id, promptId),
    connect: (id) => ipcRenderer.invoke('structured:connect', id),
    snapshot: (id) => ipcRenderer.invoke('structured:snapshot', id),
    events: (id, after) => ipcRenderer.invoke('structured:events', id, after),
    submit: (id, text, settings, attachments) => ipcRenderer.invoke('structured:submit', id, text, settings, attachments),
    respond: (response) => ipcRenderer.invoke('structured:respond', response),
    interrupt: (id, expediteSubmittedInput) => ipcRenderer.invoke('structured:interrupt', id, expediteSubmittedInput),
    resume: (id, settings) => ipcRenderer.invoke('structured:resume', id, settings),
    saveSettings: (id, settings) => ipcRenderer.invoke('structured:settings', id, settings),
    fork: (id) => ipcRenderer.invoke('structured:fork', id),
    discover: (id) => ipcRenderer.invoke('structured:discover', id),
    rename: (id, title) => ipcRenderer.invoke('structured:rename', id, title),
    archive: (id, archived) => ipcRenderer.invoke('structured:archive', id, archived),
    history: (projectId, query) => ipcRenderer.invoke('structured:history', projectId, query),
    artifact: (id, artifactId) => ipcRenderer.invoke('structured:artifact', id, artifactId),
    output: (id, artifactId) => ipcRenderer.invoke('structured:output', id, artifactId),
    review: (id, artifactId, action) => ipcRenderer.invoke('structured:review', id, artifactId, action),
    changeHistory: (id) => ipcRenderer.invoke('structured:change-history', id),
    revertChanges: (id, scope) => ipcRenderer.invoke('structured:revert-changes', id, scope),
    onEvents: (callback) => subscribe('structured:events', callback)
  },
  orchestration: orchestrationBridge,
  collaboration: agentCollaborationBridge,
  projects: {
    reorder: (ids) => ipcRenderer.invoke('projects:reorder', ids),
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
    setShowHiddenFiles: (enabled) => ipcRenderer.invoke('settings:set-show-hidden-files', enabled),
    setAgentSoundProfile: (profile) => ipcRenderer.invoke('settings:set-agent-sound-profile', profile),
    setDefaultNewFileExtension: (extension) => ipcRenderer.invoke('settings:set-default-file-extension', extension),
    setUpdateFeedUrl: (url) => ipcRenderer.invoke('settings:set-update-feed-url', url),
    setLocalUpdates: (enabled) => ipcRenderer.invoke('settings:set-local-updates', enabled)
  },
  updates: {
    openLocalFolder: () => ipcRenderer.invoke('updates:open-local-folder'),
    getState: () => ipcRenderer.invoke('updates:get-state'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    acknowledgePrepare: (requestId) => ipcRenderer.send('updates:prepare-ack', requestId),
    onState: (callback) => subscribe('updates:state', callback),
    onPrepareInstall: (callback) => subscribe('updates:prepare-install', callback)
  },
  sessions: {
    closed: () => ipcRenderer.invoke('sessions:closed'),
    onRestored: (callback) => subscribe('sessions:restored', callback),
    restore: (sessionId) => ipcRenderer.invoke('sessions:restore', sessionId),
    reorder: (projectId, ids) => ipcRenderer.invoke('sessions:reorder', projectId, ids),
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
    onChanged: callback => subscribe('files:changed', callback),
    importImage: (projectId, name, bytes) => ipcRenderer.invoke('files:import-image', projectId, name, bytes),
    onOpenShortcut: (callback) => subscribe('files:open-shortcut', callback),
    browserUrl: (projectId, path) => ipcRenderer.invoke('files:browser-url', projectId, path),
    openInBrowser: (projectId, path) => ipcRenderer.invoke('files:open-in-browser', projectId, path),
    confirmClose: (tabIds) => ipcRenderer.invoke('files:confirm-close', tabIds),
    onDraftResolved: (callback) => subscribe('files:draft-resolved', callback),
    onDraftConflict: (callback) => subscribe('files:draft-conflict', callback),
    search: (projectIds, query, options) => ipcRenderer.invoke('files:search', projectIds, query, options),
    list: (projectId, relativePath) => ipcRenderer.invoke('files:list', projectId, relativePath),
    read: (projectId, relativePath) => ipcRenderer.invoke('files:read', projectId, relativePath),
    stat: (projectId, relativePath) => ipcRenderer.invoke('files:stat', projectId, relativePath),
    readForEditor: (projectId, relativePath, allowBinary) => ipcRenderer.invoke('files:read-for-editor', projectId, relativePath, allowBinary),
    readDataUrl: (projectId, relativePath) => ipcRenderer.invoke('files:read-data-url', projectId, relativePath),
    write: (projectId, relativePath, content, expectedContent) =>
      ipcRenderer.invoke('files:write', projectId, relativePath, content, expectedContent),
    saveCopy: (projectId, relativePath, content) => ipcRenderer.invoke('files:save-copy', projectId, relativePath, content),
    createUntitled: (projectId, directory) => ipcRenderer.invoke('files:create-untitled', projectId, directory),
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
    checkpointDraft: (tabId, projectId, relativePath, content, viewState, baseContent) =>
      ipcRenderer.send('files:checkpoint-draft', tabId, projectId, relativePath, content, viewState, baseContent),
    flushDraft: (tabId, projectId, relativePath, content, viewState, baseContent) =>
      ipcRenderer.sendSync('files:flush-draft', tabId, projectId, relativePath, content, viewState, baseContent),
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
  usageCaps: {
    read: (agentSessionId, workspaceId) => ipcRenderer.invoke('usage-cap:read', agentSessionId, workspaceId),
    write: (scope, id, setting) => ipcRenderer.invoke('usage-cap:write', scope, id, setting)
  },
  activity: {
    projects: () => ipcRenderer.invoke('activity:projects'),
    onProjectsChanged: (callback) => subscribe('activity:projects', callback)
  },
  memory: {
    list: (projectId, agentKey) => ipcRenderer.invoke('memory:list', projectId, agentKey),
    remember: (input) => ipcRenderer.invoke('memory:remember', input),
    update: (input) => ipcRenderer.invoke('memory:update', input),
    recall: (projectId, query, agentKey, limit) => ipcRenderer.invoke('memory:recall', projectId, query, agentKey, limit),
    remove: (id) => ipcRenderer.invoke('memory:remove', id),
    pruneCandidates: (projectId, limit) => ipcRenderer.invoke('memory:prune-candidates', projectId, limit),
    turnRecalls: (agentSessionId) => ipcRenderer.invoke('memory:turn-recalls', agentSessionId)
  },
  system: {
    openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
    copyText: (value) => ipcRenderer.invoke('system:copy-text', value),
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
    detach: (projectId, sessionId, tab, sourceLayout, options) =>
      ipcRenderer.invoke('window:detach', projectId, sessionId, tab, sourceLayout, options),
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
