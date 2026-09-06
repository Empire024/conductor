export type PaneKind =
  | 'launcher'
  | 'agent'
  | 'terminal'
  | 'file-tree'
  | 'code'
  | 'preview'
  | 'browser'
  | 'diff'
  | 'tasks'
  | 'memory'
  | 'routine'
  | 'logs'

export type AgentProviderId = 'codex' | 'claude' | 'gemini' | 'qwen' | 'kimi'
export type AgentEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const THEME_IDS = ['night-owl', 'obsidian', 'nord'] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const THEME_VARIANTS = ['day', 'night'] as const
export type ThemeVariant = (typeof THEME_VARIANTS)[number]

export const AGENT_SOUND_PROFILES = ['off', 'soft', 'minimal'] as const
export type AgentSoundProfile = (typeof AGENT_SOUND_PROFILES)[number]
export type AgentSoundCue = 'complete' | 'question' | 'input'

export const THEME_OPTIONS: ReadonlyArray<{
  id: ThemeId
  label: string
  description: string
}> = [
  { id: 'night-owl', label: 'Night Owl', description: 'Deep blue with bright cyan accents' },
  { id: 'obsidian', label: 'Obsidian', description: 'Near-black with crisp lime accents' },
  { id: 'nord', label: 'Nord', description: 'Cool arctic blues with soft contrast' }
]

/** @deprecated Persisted only for migration from versions before theme families. */
export type ThemeMode = 'dark' | 'light' | 'auto'
export type AgentActivityPhase = 'idle' | 'working' | 'waiting_input' | 'limited' | 'complete' | 'error'

export interface PaneTab {
  id: string
  kind: PaneKind
  title: string
  icon?: string
  resourceId?: string
  state?: Record<string, unknown>
}

export interface PaneGroupNode {
  type: 'group'
  id: string
  tabs: PaneTab[]
  activeTabId: string
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: [LayoutNode, LayoutNode]
  sizes: [number, number]
}

export type LayoutNode = PaneGroupNode | SplitNode

export interface WorkspaceLayout {
  version: 1
  root: LayoutNode
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface AppSettings {
  projectsRoot: string
  zoomFactor: number
  themeId: ThemeId
  themeVariant: ThemeVariant
  themeAuto: boolean
  debugLogging: boolean
  agentSoundProfile: AgentSoundProfile
  updateFeedUrl: string
}

export type AppUpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion?: string
  progress?: number
  message?: string
  configured: boolean
  lastCheckedAt?: string
}

export interface AppDiagnostics {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
}

export interface AppProcessPerformance {
  cpuPercent: number
  memoryMb: number
}

export interface AppPerformanceSnapshot extends AppProcessPerformance {
  capturedAt: string
  processCount: number
  browserTabs: Record<string, AppProcessPerformance>
}

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DebugLogEntry {
  id: number
  createdAt: string
  level: DebugLogLevel
  scope: string
  message: string
  detail?: string
}

export interface IssueReportContext {
  projectCount: number
  sessionCount: number
  activeSessionId: string | null
  activeSessionName: string | null
  activeTabKinds: string[]
  attentionCount: number
  theme: string
  zoomFactor: number
}

export interface DebugConsoleSnapshot {
  entries: DebugLogEntry[]
  context: IssueReportContext
}

export interface DebugScreenshot {
  dataUrl: string
  width: number
  height: number
  capturedAt: string
}

export interface SessionRecord {
  id: string
  projectId: string
  name: string
  layout: WorkspaceLayout
  maximizedGroupId: string | null
  closedTabs: PaneTab[]
  continueOnLimit: boolean
  createdAt: string
  updatedAt: string
}

/** A compact, renderer-owned desk snapshot written continuously for crash recovery. */
export interface SessionCheckpoint {
  id: string
  layout: WorkspaceLayout
  maximizedGroupId: string | null
  closedTabs: PaneTab[]
}

export interface WorkspaceRecoveryState {
  activeProjectId: string | null
  activeSessionId: string | null
  focusedGroupIds: Record<string, string>
}

export interface WorkspaceRecoveryCheckpoint extends WorkspaceRecoveryState {
  sessions: SessionCheckpoint[]
}

export interface LayoutTemplateRecord {
  id: string
  projectId: string | null
  name: string
  layout: WorkspaceLayout
  createdAt: string
  updatedAt: string
}

export interface DetachedWindowRecord {
  id: string
  projectId: string
  sessionId: string
  layout: WorkspaceLayout
  maximizedGroupId: string | null
  createdAt: string
  updatedAt: string
}

export interface FileEntry {
  name: string
  path: string
  relativePath: string
  kind: 'file' | 'directory'
  gitStatus?: string
}

export interface FileDataResource {
  name: string
  relativePath: string
  mimeType: string
  size: number
  dataUrl: string
}

export interface EditorDraft {
  tabId: string
  projectId: string
  path: string
  content: string
  viewState: unknown | null
  updatedAt: string
}

export interface TerminalSpec {
  id: string
  projectId: string
  sessionId: string
  title: string
  cwd: string
  shell?: string
  startupCommand?: string
}

export interface RuntimeEnsureResult {
  id: string
  available: boolean
  status: 'starting' | 'running' | 'exited' | 'unavailable' | 'error' | 'limited' | 'waiting_input' | 'complete'
  transcript: string
  message?: string
  executable?: string
  model?: string
  resumeAt?: string
}

export interface AgentSpec {
  id: string
  projectId: string
  sessionId: string
  provider: AgentProviderId
  title: string
  cwd: string
  resume?: boolean
  model?: string
  effort?: AgentEffort
  continueOnLimit?: boolean
}

export interface AgentProviderInfo {
  id: AgentProviderId
  displayName: string
  available: boolean
  executable?: string
  installUrl: string
  models: Array<{ id: string; label: string }>
  efforts: Array<{ id: AgentEffort; label: string }>
}

export interface RuntimeProcessSummary {
  id: string
  projectId: string
  sessionId: string
  kind: 'agent' | 'terminal'
  title: string
  provider?: AgentProviderId
  model?: string
  status: RuntimeEnsureResult['status']
  activityPhase?: AgentActivityPhase
  needsInput: boolean
  progress: number | null
  resumeAt?: string
  updatedAt: string
}

export type MemoryKind = 'episodic' | 'semantic' | 'procedural'

export interface AgentMemory {
  id: string
  projectId: string
  agentKey: string | null
  kind: MemoryKind
  gist: string
  cues: string[]
  salience: number
  strength: number
  confidence: number
  occurredAt: string
  lastRecalledAt: string | null
  recallCount: number
  createdAt: string
  updatedAt: string
}

export interface RememberMemoryInput {
  projectId: string
  agentKey?: string
  kind: MemoryKind
  gist: string
  cues?: string[]
  salience?: number
  confidence?: number
}

export type NormalizedAgentEventType =
  | 'text'
  | 'activity'
  | 'shell_command'
  | 'file_change'
  | 'tool_call'
  | 'question'
  | 'error'
  | 'task_complete'
  | 'artifact'
  | 'review_finding'

export interface NormalizedAgentEvent {
  id: string
  agentSessionId: string
  type: NormalizedAgentEventType
  message: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface RuntimeStatusEvent {
  id: string
  status: RuntimeEnsureResult['status']
  message?: string
  exitCode?: number
  phase?: AgentActivityPhase
  resumeAt?: string
  model?: string
}

export const makeId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`

export const makeLauncherTab = (): PaneTab => ({
  id: makeId('pane'),
  kind: 'launcher',
  title: 'New tab'
})

export const createDefaultLayout = (): WorkspaceLayout => {
  const tab = makeLauncherTab()
  return {
    version: 1,
    root: {
      type: 'group',
      id: makeId('group'),
      tabs: [tab],
      activeTabId: tab.id
    }
  }
}
