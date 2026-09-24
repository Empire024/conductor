/**
 * Ideas (docs/ideas.md). An idea is a durable record of something the owner jotted down: the
 * owner's own text, never rewritten by an agent, plus everything Conductor learns about it later —
 * links to projects, conversations, tasks, memories, artifacts and durable jobs, each with its
 * provenance; a timeline built from those events; and agent-generated sections (briefs) kept
 * apart from the owner's words.
 *
 * Ideas are not project-scoped: capture never asks for a project. A project is one kind of link.
 */

export const IDEA_STATUSES = ['inbox', 'untouched', 'exploring', 'active', 'parked', 'converted', 'archived'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]
export const IDEA_STATUS_LABELS: Readonly<Record<IdeaStatus, string>> = {
  inbox: 'Inbox', untouched: 'Untouched', exploring: 'Exploring', active: 'Active', parked: 'Parked', converted: 'Converted', archived: 'Archived'
}

export const IDEA_LINK_KINDS = ['project', 'agent-session', 'task', 'memory', 'artifact', 'job'] as const
export type IdeaLinkKind = (typeof IDEA_LINK_KINDS)[number]

/** Where a capture came from; shown on the timeline ("Idea created from phone"). */
export type IdeaCaptureSource = 'desktop' | 'phone' | 'agent'

/** Who did something to an idea. The owner is whoever holds the window or a paired phone. */
export interface IdeaActor {
  kind: 'owner' | 'agent' | 'job' | 'conductor'
  agentSessionId?: string
  jobId?: string
  /** Human label: a tab title, "Qwen on MAIN", "phone Pixel". */
  label?: string
}

/** Provenance a link carries: what it was created from and by whom. */
export interface IdeaProvenance {
  createdFromIdeaId?: string
  createdByAgentSessionId?: string
  createdByJobId?: string
}

export interface IdeaLink extends IdeaProvenance {
  id: string
  ideaId: string
  kind: IdeaLinkKind
  /** Project id, agent session id, `projectId:taskId`, memory id, file path or URL, job id. */
  targetId: string
  label: string
  /** Project the target lives in, when it has one (conversations, tasks, memories, artifacts). */
  projectId?: string
  createdAt: string
}

export type IdeaEventKind =
  | 'created' | 'edited' | 'status' | 'linked' | 'unlinked' | 'worked-on'
  | 'exploration-started' | 'explored' | 'exploration-stopped' | 'section' | 'note'

export interface IdeaEvent {
  id: string
  ideaId: string
  at: string
  kind: IdeaEventKind
  message: string
  actor: IdeaActor
  data?: Record<string, unknown>
}

/** A compact brief an agent wrote; interpretation, never replacement content. */
export interface IdeaBrief {
  concept: string
  openQuestions: string[]
  nextStep: string
  /** Memory ids the brief relates to (also recorded as memory links). */
  relatedMemoryIds: string[]
  /** Specific observations: overlaps, blockers, "this is really a task". */
  observations: string[]
}

export interface IdeaSection {
  id: string
  ideaId: string
  kind: 'brief' | 'note'
  title: string
  /** Markdown as the agent wrote it. */
  body: string
  brief?: IdeaBrief
  createdBy: IdeaActor & { model?: string; machine?: string }
  createdAt: string
}

export type IdeaExplorationStatus = 'running' | 'completed' | 'stopped'
export type IdeaIntensity = 'light' | 'explore'

export interface IdeaExploration {
  id: string
  ideaId: string
  jobId: string
  projectId: string
  model: string
  intensity: IdeaIntensity
  trigger: 'owner' | 'incubator' | 'agent'
  status: IdeaExplorationStatus
  /** Why it stopped, when it did not complete. */
  note?: string
  startedAt: string
  finishedAt?: string
}

/** One row of the list: enough to render without loading links and events. */
export interface IdeaSummary {
  id: string
  /** Inferred from the first non-empty line of the owner's text. */
  title: string
  /** First ~200 characters after the title line. */
  preview: string
  status: IdeaStatus
  workedOn: boolean
  capturedFrom: IdeaCaptureSource
  createdAt: string
  updatedAt: string
  lastExploredAt?: string
  exploring: boolean
  linkCounts: Partial<Record<IdeaLinkKind, number>>
  tags: string[]
}

export interface IdeaDetail extends IdeaSummary {
  /** The owner's current text. Only the owner edits it. */
  text: string
  /** The text as first captured (its first sitting); frozen afterwards and never rewritten. */
  originalText: string
  links: IdeaLink[]
  /** Newest first. */
  events: IdeaEvent[]
  /** Newest first. */
  sections: IdeaSection[]
  explorations: IdeaExploration[]
  /** The newest brief section, when there is one. */
  latestBrief?: IdeaSection
}

export interface IdeaListQuery {
  /** Default: every status except archived. */
  statuses?: IdeaStatus[]
  /** Matches the owner's text, tags, brief sections and link labels. */
  search?: string
  limit?: number
}

export interface CaptureIdeaInput { text: string; source?: IdeaCaptureSource }
export interface UpdateIdeaInput { text?: string; status?: IdeaStatus; tags?: string[] }

export interface IdeaIncubatorSettings {
  enabled: boolean
  /** At most this many ideas explored per night (rolling 20 h). */
  maxPerNight: number
  intensity: IdeaIntensity
}
export const DEFAULT_INCUBATOR_SETTINGS: IdeaIncubatorSettings = { enabled: true, maxPerNight: 3, intensity: 'light' }

export interface WorkOnIdeaInput {
  ideaId: string
  projectId: string
  /** Defaults to Claude's default model. */
  provider?: 'claude' | 'codex' | 'grok' | 'local'
  model?: string
}

export interface ExploreIdeaInput { ideaId: string; intensity?: IdeaIntensity; /** Local model id; default: the loaded one, else the first configured. */ model?: string }

export interface CreateIdeaTaskInput { ideaId: string; projectId: string; title?: string }

export type IdeasChange = { ideaId: string | null }

/** Renderer bridge (window.conductor.ideas). */
export interface IdeasBridge {
  list(query?: IdeaListQuery): Promise<IdeaSummary[]>
  get(ideaId: string): Promise<IdeaDetail>
  capture(input: CaptureIdeaInput): Promise<IdeaDetail>
  update(ideaId: string, input: UpdateIdeaInput): Promise<IdeaDetail>
  /** Opens a visible agent tab in the project, briefed with the idea's context, and links it. */
  work(input: WorkOnIdeaInput): Promise<{ agentSessionId: string; tabId: string }>
  /** Starts a bounded local exploration as a durable job; never a cloud model. */
  explore(input: ExploreIdeaInput): Promise<IdeaExploration>
  createTask(input: CreateIdeaTaskInput): Promise<IdeaLink>
  unlink(ideaId: string, linkId: string): Promise<IdeaDetail>
  incubator(): Promise<IdeaIncubatorSettings>
  setIncubator(settings: Partial<IdeaIncubatorSettings>): Promise<IdeaIncubatorSettings>
  /** Opens a linked conversation, job or file in the workspace. */
  openLink(ideaId: string, linkId: string): Promise<void>
  onChanged(callback: (change: IdeasChange) => void): () => void
  /** The global capture shortcut (and the menu / palette entry) asks the view to open a new note. */
  onCapture(callback: () => void): () => void
}

/** IPC channel names, shared by main and preload. */
export const IDEAS_IPC = {
  list: 'ideas:list', get: 'ideas:get', capture: 'ideas:capture', update: 'ideas:update', work: 'ideas:work',
  explore: 'ideas:explore', createTask: 'ideas:create-task', unlink: 'ideas:unlink', incubator: 'ideas:incubator',
  setIncubator: 'ideas:set-incubator', openLink: 'ideas:open-link', changed: 'ideas:changed', captureRequested: 'ideas:capture-requested'
} as const

/** The desktop capture shortcut, registered globally (docs/ideas.md). */
export const IDEA_CAPTURE_ACCELERATOR = 'CommandOrControl+Alt+I'
export const IDEA_CAPTURE_SHORTCUT_LABEL = 'Ctrl+Alt+I'

export const IDEA_TEXT_MAX = 100_000
export const IDEA_TITLE_MAX = 120

/** Title of a note: its first non-empty line, trimmed of Markdown heading/list markers. */
export function inferIdeaTitle(text: string): string {
  const line = text.split(/\r?\n/).map(value => value.trim()).find(Boolean) ?? ''
  const clean = line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim()
  if (!clean) return 'New idea'
  return clean.length > IDEA_TITLE_MAX ? `${clean.slice(0, IDEA_TITLE_MAX - 1).trimEnd()}…` : clean
}

/** The text after the title line, collapsed to one line for a list row. */
export function ideaPreview(text: string, limit = 200): string {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex(line => line.trim())
  const rest = (first < 0 ? [] : lines.slice(first + 1)).join(' ').replace(/\s+/g, ' ').trim()
  return rest.length > limit ? `${rest.slice(0, limit - 1).trimEnd()}…` : rest
}
