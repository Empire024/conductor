import type { AgentMemory } from '../../shared/models'
import {
  IDEA_LINK_KINDS, type CaptureIdeaInput, type CreateIdeaTaskInput, type ExploreIdeaInput, type IdeaActor, type IdeaDetail, type IdeaExploration,
  type IdeaIncubatorSettings, type IdeaLink, type IdeaLinkKind, type IdeaListQuery, type IdeaSection, type IdeaSummary, type UpdateIdeaInput, type WorkOnIdeaInput
} from '../../shared/ideas'
import { relatedMemories, workOnIdeaBrief } from './context'
import type { IdeaExplorer } from './explore'
import type { IdeaStore, LinkInput } from './store'

export interface IdeasServiceDeps {
  store: IdeaStore
  explorer: IdeaExplorer
  /** Every project's memories (read without recall side effects). */
  memories(): AgentMemory[]
  projectTitle(projectId: string): string | null
  /** Opens a visible agent tab in the project and submits the prompt. */
  openAgent(request: { projectId: string; provider: NonNullable<WorkOnIdeaInput['provider']>; model?: string; title: string; prompt: string }): Promise<{ agentSessionId: string; tabId: string }>
  /** Adds a Project task and returns its id. */
  addTask(projectId: string, title: string): Promise<{ taskId: string; title: string }>
  /** Shows a linked conversation, job or file. */
  open(link: IdeaLink): Promise<void>
}

const OWNER: IdeaActor = { kind: 'owner' }
const LINKABLE_BY_AGENTS: IdeaLinkKind[] = ['artifact', 'task', 'memory', 'project', 'agent-session']

/**
 * Everything the view, the phone and app control do with ideas, in one place, so each surface
 * enforces the same rules: the owner's text changes only through capture/update, agent output
 * goes into sections and links with provenance, and exploration is local only.
 */
export class IdeasService {
  constructor(private readonly deps: IdeasServiceDeps) {}

  get store(): IdeaStore { return this.deps.store }

  list(query?: IdeaListQuery): IdeaSummary[] { return this.deps.store.list(query) }
  get(ideaId: string): IdeaDetail { return this.deps.store.get(String(ideaId)) }
  capture(input: CaptureIdeaInput, actor: IdeaActor = OWNER): IdeaDetail { return this.deps.store.capture(input, actor) }
  update(ideaId: string, input: UpdateIdeaInput, actor: IdeaActor = OWNER): IdeaDetail { return this.deps.store.update(String(ideaId), input ?? {}, actor) }
  unlink(ideaId: string, linkId: string, actor: IdeaActor = OWNER): IdeaDetail { return this.deps.store.unlink(String(ideaId), String(linkId), actor) }
  incubator(): IdeaIncubatorSettings { return this.deps.store.incubatorSettings() }
  setIncubator(settings: Partial<IdeaIncubatorSettings>): IdeaIncubatorSettings { return this.deps.store.setIncubatorSettings(settings ?? {}) }

  relatedMemories(text: string): ReturnType<typeof relatedMemories> { return relatedMemories(text, this.deps.memories()) }

  /** "Work on this idea": a visible conversation briefed with the idea's whole context. */
  async work(input: WorkOnIdeaInput, actor: IdeaActor = OWNER): Promise<{ agentSessionId: string; tabId: string }> {
    const idea = this.get(input.ideaId)
    const projectId = String(input.projectId ?? '')
    const projectTitle = this.deps.projectTitle(projectId)
    if (!projectTitle) throw new Error('Choose a project to work in')
    const provider = input.provider ?? 'claude'
    if (!['claude', 'codex', 'grok', 'local'].includes(provider)) throw new Error('provider must be claude, codex, grok or local')
    const opened = await this.deps.openAgent({ projectId, provider, ...(input.model ? { model: String(input.model) } : {}), title: `Idea: ${idea.title}`.slice(0, 120), prompt: workOnIdeaBrief(idea, this.relatedMemories(idea.text)) })
    const { store } = this.deps
    store.link(idea.id, { kind: 'project', targetId: projectId, label: projectTitle, projectId }, actor)
    store.link(idea.id, { kind: 'agent-session', targetId: opened.agentSessionId, label: `${provider} conversation "Idea: ${idea.title}"`.slice(0, 300), projectId, createdFromIdeaId: idea.id, createdByAgentSessionId: opened.agentSessionId }, actor, { workedOn: true, message: `Work started in a ${provider} conversation in ${projectTitle}` })
    return opened
  }

  explore(input: ExploreIdeaInput, trigger: IdeaExploration['trigger'] = 'owner', agentSessionId?: string): Promise<IdeaExploration> {
    return this.deps.explorer.start({ ...input, ideaId: String(input.ideaId) }, trigger, agentSessionId)
  }

  async createTask(input: CreateIdeaTaskInput, actor: IdeaActor = OWNER): Promise<IdeaLink> {
    const idea = this.get(input.ideaId)
    const projectId = String(input.projectId ?? '')
    const projectTitle = this.deps.projectTitle(projectId)
    if (!projectTitle) throw new Error('Choose a project for the task')
    const title = String(input.title ?? '').trim() || idea.title
    const task = await this.deps.addTask(projectId, title.slice(0, 500))
    this.deps.store.link(idea.id, { kind: 'project', targetId: projectId, label: projectTitle, projectId }, actor)
    return this.deps.store.link(idea.id, { kind: 'task', targetId: `${projectId}:${task.taskId}`, label: task.title, projectId, createdFromIdeaId: idea.id, ...(actor.agentSessionId ? { createdByAgentSessionId: actor.agentSessionId } : {}) }, actor, { workedOn: true, message: `Task created in ${projectTitle}: ${task.title}` })
  }

  /** Records related work an agent (or the owner) made; the caller's session is the provenance. */
  link(ideaId: string, input: Omit<LinkInput, 'createdByAgentSessionId' | 'createdByJobId'>, actor: IdeaActor): IdeaLink {
    if (!IDEA_LINK_KINDS.includes(input.kind) || (actor.kind === 'agent' && !LINKABLE_BY_AGENTS.includes(input.kind))) throw new Error(`kind must be one of ${LINKABLE_BY_AGENTS.join(', ')}`)
    const idea = this.get(ideaId)
    return this.deps.store.link(idea.id, { ...input, createdFromIdeaId: idea.id, ...(actor.agentSessionId ? { createdByAgentSessionId: actor.agentSessionId } : {}) }, actor, { workedOn: input.kind !== 'memory' })
  }

  /** An agent's short finding, kept as its own section; the owner's note is never touched. */
  note(ideaId: string, input: { title?: unknown; body?: unknown }, actor: IdeaActor & { model?: string }): IdeaSection {
    const body = String(input.body ?? '').trim()
    if (!body) throw new Error('body is required')
    if (body.length > 20_000) throw new Error('body is at most 20,000 characters')
    const title = String(input.title ?? '').trim().slice(0, 200) || 'Note'
    return this.deps.store.addSection(this.get(ideaId).id, { kind: 'note', title, body, createdBy: actor })
  }

  async openLink(ideaId: string, linkId: string): Promise<void> {
    const link = this.deps.store.links(String(ideaId)).find(item => item.id === linkId)
    if (!link) throw new Error('No such link on this idea')
    await this.deps.open(link)
  }
}
