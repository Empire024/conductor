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
/** What a tab's activity indicator is reporting. The three unhappy states are kept apart
 * because the runtime genuinely distinguishes them (see SessionPhase in structured-agent.ts)
 * and they call for different responses: 'failed' is a run that errored, 'disconnected' is a
 * lost runtime connection, 'stopped' is a run the user interrupted. They were once flattened
 * into a single 'error', which told nobody anything. */
export type AgentActivityPhase =
  | 'idle'
  | 'working'
  | 'waiting_input'
  | 'limited'
  | 'complete'
  | 'stopped'
  | 'disconnected'
  | 'failed'

/** Rows persisted before the unhappy states were split still say 'error'; read them as the
 * generic failure they meant. */
export const readActivityPhase = (value: string): AgentActivityPhase =>
  value === 'error' ? 'failed' : (value as AgentActivityPhase)

/** Chrome's tab-group palette, in Chrome's own order. Stored by name rather than by hex so
 * a group keeps its identity across the light and dark themes, which resolve these
 * differently (see --tab-group-* in styles.css). */
export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

/** A Chrome-style tab group: a named, coloured run of tabs inside one pane's strip. Named
 * `TabGroup` rather than `group` because `PaneGroupNode` already means a pane. Membership
 * lives on the tabs (`PaneTab.tabGroupId`); this record only carries the presentation and
 * the collapsed flag, so a group exists exactly as long as some tab points at it. */
export interface TabGroup {
  id: string
  title: string
  color: TabGroupColor
  collapsed: boolean
}

export interface PaneTab {
  id: string
  kind: PaneKind
  title: string
  icon?: string
  resourceId?: string
  state?: Record<string, unknown>
  /** The TabGroup in this tab's own pane that it belongs to, if any. */
  tabGroupId?: string
  /** True once `title` has been deliberately set: by hand through the "Rename conversation"
   *  dialog, or once by the first-message auto-name (see bindConversationTab). Guards both the
   *  same way, so neither a later resume/fork nor a second message ever overwrites the title
   *  again — without this flag there would be no way to tell "still the generic default" apart
   *  from "already named" other than guessing from the string. */
  titleLocked?: boolean
}

export interface PaneGroupNode {
  type: 'group'
  id: string
  tabs: PaneTab[]
  activeTabId: string
  /** Optional so layouts persisted before tab groups load unchanged. */
  tabGroups?: TabGroup[]
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
  defaultNewFileExtension: string
  zoomFactor: number
  themeId: ThemeId
  themeVariant: ThemeVariant
  themeAuto: boolean
  debugLogging: boolean
  showHiddenFiles: boolean
  agentSoundProfile: AgentSoundProfile
  updateFeedUrl: string
  includeLocalUpdates?: boolean
  localUpdateDirectory?: string
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
  source?: 'local' | 'release'
  localBuildWarning?: string
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
  sessionIdsByProject: Record<string, string>
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
  /** Disk contents before editing. Undefined means an older draft has no baseline. */
  baseContent?: string | null
  viewState: unknown | null
  updatedAt: string
}

export type EditorFileWriteResult = { status: 'saved' } | { status: 'conflict'; message: string }

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

/** The canonical kind list. Every menu, validator and grouping derives from this one array. */
export const MEMORY_KINDS = ['episodic', 'semantic', 'procedural'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]
export const isMemoryKind = (value: unknown): value is MemoryKind =>
  MEMORY_KINDS.includes(value as MemoryKind)

/** Who committed a memory. Only agent-written episodes are ever auto-forgotten. */
export type MemorySource = 'human' | 'agent'

/** The conversation a memory came out of, so a memory that turns out to be wrong can be
 *  traced back to the turn that wrote it instead of standing there unattributed. */
export interface MemoryOrigin {
  agentSessionId: string
  /** Workspace session that owned the conversation; needed to reopen the right tab. */
  workspaceId?: string
  title?: string
  provider?: AgentProviderId
}

export interface AgentMemory {
  id: string
  projectId: string
  agentKey: string | null
  kind: MemoryKind
  source: MemorySource
  origin: MemoryOrigin | null
  gist: string
  cues: string[]
  salience: number
  strength: number
  confidence: number
  occurredAt: string
  lastRecalledAt: string | null
  recallCount: number
  /** When a person last edited or re-weighted this memory by hand. A corrected memory is
   *  vouched for, so it stops being a candidate for automatic forgetting. */
  correctedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RememberMemoryInput {
  projectId: string
  agentKey?: string
  kind: MemoryKind
  source?: MemorySource
  origin?: MemoryOrigin
  gist: string
  cues?: string[]
  salience?: number
  confidence?: number
}

/** A hand correction. Every field is optional: re-weighting alone must not force a rewrite. */
export interface UpdateMemoryInput {
  id: string
  kind?: MemoryKind
  gist?: string
  cues?: string[]
  salience?: number
  confidence?: number
  strength?: number
}

/** One row of the visible prune, ranked by how little standing a memory still has. */
export interface MemoryPruneCandidate {
  memory: AgentMemory
  standing: number
  retrievability: number
  reason: string
}

/** What memory actually reached the agent for one submitted turn, resolved back to the
 *  memories themselves so a wrong one can be corrected from the conversation. */
export interface TurnMemoryRecall {
  itemId: string
  agentSessionId: string
  prompt: string
  createdAt: string
  memories: AgentMemory[]
  /** Recalled memories that have since been deleted; the count keeps the record honest. */
  forgotten: number
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
