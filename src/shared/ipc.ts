import type { UsageCapScope, UsageCapSetting, UsageCapSnapshot } from './usage-accounting'
import type {
  AppSettings,
  AgentSoundProfile,
  AppUpdateState,
  AppDiagnostics,
  AppPerformanceSnapshot,
  DebugConsoleSnapshot,
  DebugScreenshot,
  AgentMemory,
  AgentProviderInfo,
  AgentSpec,
  EditorDraft,
  EditorFileWriteResult,
  FileEntry,
  FileDataResource,
  DetachedWindowRecord,
  LayoutTemplateRecord,
  NormalizedAgentEvent,
  PaneTab,
  ProjectRecord,
  RuntimeEnsureResult,
  RuntimeProcessSummary,
  RuntimeStatusEvent,
  SessionRecord,
  TerminalSpec,
  ThemeId,
  ThemeVariant,
  MemoryPruneCandidate,
  RememberMemoryInput,
  TurnMemoryRecall,
  UpdateMemoryInput,
  WorkspaceRecoveryCheckpoint,
  WorkspaceRecoveryState,
  WorkspaceLayout
} from './models'
import type { ProjectActivitySnapshot } from './project-activity'
import type { OrchestrationBridge } from './orchestration'
import type { AgentCollaborationBridge } from './agent-collaboration'
import type { StructuredAgentBridge } from './structured-agent'

export interface FileSearchOptions { showHidden?: boolean; activeProjectId?: string; recentPaths?: Array<{ projectId: string; path: string }> }

export interface ConductorBridge {
  agentControl: import('./agent-control').AgentControlBridge
  remote: import('./remote-control').RemoteControlBridge
  projectTasks: import('./project-backlog').ProjectBacklogBridge
  nativeCli: {
    ensure(id: string): Promise<RuntimeEnsureResult & { sequence: number }>
    chat(id: string): Promise<void>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    onData(callback: (data: { id: string; data: string; sequence: number }) => void): () => void
    onStatus(callback: (state: { id: string; status: string; exitCode?: number }) => void): () => void
  }
  structured: StructuredAgentBridge
  orchestration: OrchestrationBridge
  collaboration: AgentCollaborationBridge
  projects: {
    list(): Promise<ProjectRecord[]>
    reorder(ids: string[]): Promise<ProjectRecord[]>
    openFolder(): Promise<ProjectRecord | null>
    create(name: string): Promise<ProjectRecord>
    remove(projectId: string): Promise<void>
    rename(projectId: string, name: string): Promise<ProjectRecord>
    move(projectId: string): Promise<ProjectRecord | null>
    reveal(path: string): Promise<void>
  }
  settings: {
    getStartup(): AppSettings
    get(): Promise<AppSettings>
    chooseProjectsRoot(): Promise<AppSettings>
    setZoom(zoomFactor: number): Promise<AppSettings>
    setTheme(themeId: ThemeId): Promise<AppSettings>
    setThemeVariant(themeVariant: ThemeVariant): Promise<AppSettings>
    setThemeAuto(enabled: boolean): Promise<AppSettings>
    setDebugLogging(enabled: boolean): Promise<AppSettings>
    setShowHiddenFiles(enabled: boolean): Promise<AppSettings>
    setAgentSoundProfile(profile: AgentSoundProfile): Promise<AppSettings>
    setDefaultNewFileExtension(extension: string): Promise<AppSettings>
    setUpdateFeedUrl(url: string): Promise<AppSettings>
    setLocalUpdates(enabled: boolean): Promise<AppSettings>
  }
  updates: {
    openLocalFolder(): Promise<void>
    getState(): Promise<AppUpdateState>
    check(): Promise<AppUpdateState>
    download(): Promise<AppUpdateState>
    install(): Promise<void>
    acknowledgePrepare(requestId: string): void
    onState(callback: (state: AppUpdateState) => void): () => void
    onPrepareInstall(callback: (payload: { requestId: string }) => void): () => void
  }
  sessions: {
    onRestored(callback: (session: SessionRecord) => void): () => void
    closed(): Promise<SessionRecord[]>
    restore(sessionId?: string): Promise<SessionRecord | null>
    list(projectId: string): Promise<SessionRecord[]>
    reorder(projectId: string, ids: string[]): Promise<SessionRecord[]>
    create(projectId: string, name?: string): Promise<SessionRecord>
    delete(sessionId: string): Promise<void>
    rename(sessionId: string, name: string): Promise<void>
    setContinuation(sessionId: string, enabled: boolean): Promise<void>
    save(
      sessionId: string,
      layout: WorkspaceLayout,
      maximizedGroupId: string | null,
      closedTabs: PaneTab[]
    ): Promise<void>
    listTemplates(projectId: string): Promise<LayoutTemplateRecord[]>
    saveTemplate(projectId: string, name: string, layout: WorkspaceLayout): Promise<LayoutTemplateRecord>
  }
  recovery: {
    get(): Promise<WorkspaceRecoveryState>
    checkpoint(snapshot: WorkspaceRecoveryCheckpoint): Promise<void>
    flush(snapshot: WorkspaceRecoveryCheckpoint): boolean
  }
  files: {
    onChanged(callback: (event: import('./agent-control').AgentFileChange) => void): () => void
    importImage(projectId: string, name: string, bytes: Uint8Array): Promise<import('./structured-agent').ContextAttachment>
    onOpenShortcut(callback: () => void): () => void
    browserUrl(projectId: string, path: string): Promise<string>
    openInBrowser(projectId: string, path: string): Promise<void>
    confirmClose(tabIds: string[]): Promise<boolean>
    onDraftResolved(callback: (result: { tabId: string; submitted: string; content: string | null; saved: boolean }) => void): () => void
    onDraftConflict(callback: (result: { tabId: string; message: string }) => void): () => void
    search(projectIds: string[], query: string, options?: FileSearchOptions): Promise<Array<{ projectId: string; path: string }>>
    list(projectId: string, relativePath?: string): Promise<FileEntry[]>
    read(projectId: string, relativePath: string): Promise<string>
    stat(projectId: string, relativePath: string): Promise<{ size: number; isFile: boolean; modifiedAt: string }>
    readForEditor(projectId: string, relativePath: string, allowBinary?: boolean): Promise<string | null>
    readDataUrl(projectId: string, relativePath: string): Promise<FileDataResource>
    write(projectId: string, relativePath: string, content: string, expectedContent?: string | null): Promise<EditorFileWriteResult>
    saveCopy(projectId: string, relativePath: string, content: string): Promise<string>
    create(projectId: string, directory: string, name: string, kind: FileEntry['kind']): Promise<FileEntry>
    createUntitled(projectId: string, directory: string): Promise<FileEntry>
    rename(projectId: string, relativePath: string, name: string): Promise<FileEntry>
    move(projectId: string, relativePath: string, destinationDirectory: string): Promise<FileEntry>
    trash(projectId: string, relativePath: string): Promise<void>
    reveal(projectId: string, relativePath?: string): Promise<void>
    openExternal(projectId: string, relativePath: string): Promise<void>
    getDraft(tabId: string, projectId: string, relativePath: string): Promise<EditorDraft | null>
    checkpointDraft(tabId: string, projectId: string, relativePath: string, content: string, viewState: unknown, baseContent?: string | null): void
    flushDraft(tabId: string, projectId: string, relativePath: string, content: string, viewState: unknown, baseContent?: string | null): boolean
    removeDraft(tabId: string): Promise<void>
  }
  terminals: {
    ensure(spec: TerminalSpec): Promise<RuntimeEnsureResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    restart(spec: TerminalSpec): Promise<RuntimeEnsureResult>
    kill(id: string): Promise<void>
    onData(callback: (payload: { id: string; data: string }) => void): () => void
    onStatus(callback: (payload: RuntimeStatusEvent) => void): () => void
  }
  agents: {
    ensure(spec: AgentSpec): Promise<RuntimeEnsureResult>
    write(id: string, data: string): void
    respond(id: string, data: string): void
    reportInteraction(id: string, kind: 'directory_trust'): void
    submit(id: string, message: string, mode?: 'manual' | 'edit' | 'plan' | 'auto'): Promise<void>
    captureVisual(id: string, body: string, active: boolean, settled: boolean): void
    resize(id: string, cols: number, rows: number): void
    restart(spec: AgentSpec): Promise<RuntimeEnsureResult>
    interrupt(id: string): void
    listEvents(id: string): Promise<NormalizedAgentEvent[]>
    onData(callback: (payload: { id: string; data: string }) => void): () => void
    onStatus(callback: (payload: RuntimeStatusEvent) => void): () => void
    onEvent(callback: (payload: NormalizedAgentEvent) => void): () => void
    listProviders(): Promise<AgentProviderInfo[]>
    listProcesses(projectId?: string): Promise<RuntimeProcessSummary[]>
  }
  /** Owner-set stop rules, evaluated against provider-reported usage. */
  usageCaps: {
    /** Omit both ids to read only the account-wide default. */
    read(agentSessionId?: string, workspaceId?: string): Promise<UsageCapSnapshot>
    write(scope: UsageCapScope, id: string | null, setting: UsageCapSetting | null): Promise<void>
  }
  /** Agent activity for every project, including those whose panes are not mounted. */
  activity: {
    projects(): Promise<ProjectActivitySnapshot>
    onProjectsChanged(callback: (snapshot: ProjectActivitySnapshot) => void): () => void
  }
  memory: {
    list(projectId: string, agentKey?: string): Promise<AgentMemory[]>
    remember(input: RememberMemoryInput): Promise<AgentMemory>
    update(input: UpdateMemoryInput): Promise<AgentMemory>
    recall(projectId: string, query: string, agentKey?: string, limit?: number): Promise<AgentMemory[]>
    remove(id: string): Promise<void>
    pruneCandidates(projectId: string, limit?: number): Promise<MemoryPruneCandidate[]>
    turnRecalls(agentSessionId: string): Promise<TurnMemoryRecall[]>
  }
  system: {
    openExternal(url: string): Promise<void>
    copyText(value: string): Promise<void>
    getDiagnostics(): Promise<AppDiagnostics>
    getPerformance(browserWebContents: Record<string, number>): Promise<AppPerformanceSnapshot>
  }
  debug: {
    openWindow(placeAtCursor?: boolean): Promise<void>
    captureScreenshot(): Promise<DebugScreenshot>
    openIssue(url: string): Promise<{ screenshotCopied: boolean }>
    publishSnapshot(snapshot: DebugConsoleSnapshot): void
    getSnapshot(): Promise<DebugConsoleSnapshot | null>
    clearSource(): void
    onSnapshot(callback: (snapshot: DebugConsoleSnapshot) => void): () => void
    onClearSource(callback: () => void): () => void
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizedChange(callback: (maximized: boolean) => void): () => void
    isCursorOutside(): Promise<boolean>
    detach(projectId: string, sessionId: string, tab: PaneTab, sourceLayout?: WorkspaceLayout, options?: { alwaysOnTop?: boolean }): Promise<DetachedWindowRecord>
    getDetached(id: string): Promise<{ record: DetachedWindowRecord; project: ProjectRecord; session: SessionRecord } | null>
    saveDetached(id: string, layout: WorkspaceLayout, maximizedGroupId: string | null): Promise<void>
    flushDetached(id: string, layout: WorkspaceLayout, maximizedGroupId: string | null): void
    onDetachedClosed(callback: (payload: { sessionId: string }) => void): () => void
  }
  platform: NodeJS.Platform
}
