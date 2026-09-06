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
  RememberMemoryInput,
  WorkspaceRecoveryCheckpoint,
  WorkspaceRecoveryState,
  WorkspaceLayout
} from './models'
import type { OrchestrationBridge } from './orchestration'
import type { AgentCollaborationBridge } from './agent-collaboration'

export interface ConductorBridge {
  orchestration: OrchestrationBridge
  collaboration: AgentCollaborationBridge
  projects: {
    list(): Promise<ProjectRecord[]>
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
    setAgentSoundProfile(profile: AgentSoundProfile): Promise<AppSettings>
    setUpdateFeedUrl(url: string): Promise<AppSettings>
  }
  updates: {
    getState(): Promise<AppUpdateState>
    check(): Promise<AppUpdateState>
    download(): Promise<AppUpdateState>
    install(): Promise<void>
    acknowledgePrepare(requestId: string): void
    onState(callback: (state: AppUpdateState) => void): () => void
    onPrepareInstall(callback: (payload: { requestId: string }) => void): () => void
  }
  sessions: {
    list(projectId: string): Promise<SessionRecord[]>
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
    list(projectId: string, relativePath?: string): Promise<FileEntry[]>
    read(projectId: string, relativePath: string): Promise<string>
    readDataUrl(projectId: string, relativePath: string): Promise<FileDataResource>
    write(projectId: string, relativePath: string, content: string): Promise<void>
    rename(projectId: string, relativePath: string, name: string): Promise<FileEntry>
    reveal(projectId: string, relativePath?: string): Promise<void>
    openExternal(projectId: string, relativePath: string): Promise<void>
    getDraft(tabId: string, projectId: string, relativePath: string): Promise<EditorDraft | null>
    checkpointDraft(tabId: string, projectId: string, relativePath: string, content: string, viewState: unknown): void
    flushDraft(tabId: string, projectId: string, relativePath: string, content: string, viewState: unknown): void
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
  memory: {
    list(projectId: string, agentKey?: string): Promise<AgentMemory[]>
    remember(input: RememberMemoryInput): Promise<AgentMemory>
    recall(projectId: string, query: string, agentKey?: string, limit?: number): Promise<AgentMemory[]>
    remove(id: string): Promise<void>
  }
  system: {
    openExternal(url: string): Promise<void>
    getDiagnostics(): Promise<AppDiagnostics>
    getPerformance(browserWebContents: Record<string, number>): Promise<AppPerformanceSnapshot>
  }
  debug: {
    openWindow(placeAtCursor?: boolean): Promise<void>
    captureScreenshot(): Promise<DebugScreenshot>
    saveScreenshot(): Promise<string | null>
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
    detach(projectId: string, sessionId: string, tab: PaneTab, sourceLayout?: WorkspaceLayout): Promise<DetachedWindowRecord>
    getDetached(id: string): Promise<{ record: DetachedWindowRecord; project: ProjectRecord; session: SessionRecord } | null>
    saveDetached(id: string, layout: WorkspaceLayout, maximizedGroupId: string | null): Promise<void>
    flushDetached(id: string, layout: WorkspaceLayout, maximizedGroupId: string | null): void
    onDetachedClosed(callback: (payload: { sessionId: string }) => void): () => void
  }
  platform: NodeJS.Platform
}
