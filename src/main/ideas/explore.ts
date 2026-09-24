import type { CreateDurableJobInput, DurableJobsService, DurableJobSummary } from '../../shared/durable-jobs'
import { TERMINAL_JOB_STATUSES } from '../../shared/durable-jobs'
import type { ExploreIdeaInput, IdeaBrief, IdeaDetail, IdeaExploration, IdeaIntensity } from '../../shared/ideas'
import type { RelatedMemory } from './context'
import type { IdeaStore } from './store'

type JobsPort = Pick<DurableJobsService, 'create' | 'get' | 'status' | 'cancel' | 'onChange'>

export interface IdeaExplorerDeps {
  store: IdeaStore
  /** The durable-jobs service; undefined while it is not running. */
  jobs(): JobsPort | undefined
  /** Configured local model ids in preference order, and the one a server holds right now. */
  localModels(): { configured: string[]; loaded: string | null }
  /** The project a job runs in when the idea links none: the Conductor checkout, else a desk project. */
  homeProjectId(): string | null
  projectExists(projectId: string): boolean
  relatedMemories(text: string): RelatedMemory[]
  /** The final answer of a finished stage conversation. */
  lastAnswer(agentSessionId: string): string
  /** This machine's name for "explored by Qwen on MAIN". */
  machine: string
}

const LIGHT_MS = 20 * 60_000
const EXPLORE_MS = 45 * 60_000

export const BRIEF_FORMAT = [
  'Your final answer is the idea brief, in exactly this format (plain text, no preamble, no Markdown headings):',
  'CONCEPT: <one or two sentences: what the idea actually is, stated better than the note>',
  'OPEN QUESTIONS:',
  '- <a specific question that decides whether or how to pursue it> (3 to 6 lines)',
  'NEXT STEP: <one small, concrete action that would teach the owner the most>',
  'RELATED MEMORIES: <ids from the memory list that genuinely relate, comma separated, or none>',
  'OBSERVATIONS:',
  '- <only specific ones: overlap with existing work, a contradiction with an earlier decision, an obvious blocker, a simpler variant, "this is really a task"> (0 to 4 lines)',
  'No generic advice such as "consider your target audience". Mark a guess as a guess.'
].join('\n')

/** Chooses the local model: the requested one when configured, else the one already loaded
 *  (never switch a server someone may be using), else the first configured. Never a cloud model. */
export function pickLocalModel(requested: string | undefined, models: { configured: string[]; loaded: string | null }): string {
  const configured = models.configured
  if (requested) {
    const id = requested.startsWith('local/') ? requested.slice('local/'.length) : requested
    if (!configured.includes(id)) throw new Error(`${requested} is not a configured local model; an idea is only explored by a local model`)
    return id
  }
  if (models.loaded && configured.includes(models.loaded)) return models.loaded
  if (configured[0]) return configured[0]
  throw new Error('No local model is configured on this machine; an idea is only explored by a local model, never a cloud one')
}

export function explorationJob(idea: IdeaDetail, memories: RelatedMemory[], intensity: IdeaIntensity, projectId: string, model: string): CreateDurableJobInput {
  const memoryList = memories.length ? memories.map(memory => `- ${memory.id} [${memory.kind}] ${memory.gist}`).join('\n') : '(none found)'
  const objective = [
    `Explore one of the owner's ideas a little and write a compact brief. This is small, bounded progress, not a project: do not build anything.`,
    `The owner's note (idea ${idea.id}, captured ${idea.createdAt.slice(0, 10)}):\n"""\n${idea.text.trim().slice(0, 6_000)}\n"""`,
    `Possibly related memories from the owner's projects:\n${memoryList}`,
    idea.links.length ? `Work already linked to it:\n${idea.links.map(link => `- ${link.kind}: ${link.label}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
  const brief = { title: 'Idea brief', kind: 'report' as const, objective: `Write the brief for the idea.\n\n${BRIEF_FORMAT}`, completionCriteria: ['The final answer follows the brief format'] }
  const stages = intensity === 'explore'
    ? [{ title: 'Think the idea through', kind: 'research' as const, objective: 'Identify what the idea really is, what it depends on, what already exists in the owner\'s work that it connects to (read project files only if they obviously help), and the questions that decide it. Keep notes short.', completionCriteria: ['Concept, dependencies and deciding questions identified'] }, brief]
    : [{ ...brief, kind: 'research' as const }]
  return {
    projectId, title: `Explore idea: ${idea.title}`.slice(0, 200), objective, model, stages, isolateWorktree: false,
    budgets: { maxStageAttempts: 2, maxElapsedMs: intensity === 'explore' ? EXPLORE_MS : LIGHT_MS, stageTimeoutMs: intensity === 'explore' ? 25 * 60_000 : LIGHT_MS },
    constraints: [
      'Read only: do not create, edit or delete any file, and run no command that changes anything.',
      'Answer from the note, the listed memories and what you can read; never invent facts about the owner.'
    ]
  }
}

const STATUS_LINE = /^\s*JOB STATUS:.*$/gim

/** Parses the brief format; tolerant of Markdown emphasis, bullets and missing sections. Null
 *  when there is not even a concept. Memory ids are kept only when they were offered. */
export function parseIdeaBrief(answer: string, offeredMemoryIds: Iterable<string>): IdeaBrief | null {
  const text = answer.replace(STATUS_LINE, '').replace(/\*\*/g, '').replace(/\r/g, '')
  const offered = new Set(offeredMemoryIds)
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of text.split('\n')) {
    const heading = raw.match(/^\s*#*\s*(CONCEPT|OPEN QUESTIONS|NEXT STEP|RELATED MEMORIES|OBSERVATIONS)\s*:?\s*(.*)$/i)
    if (heading) { current = heading[1]!.toUpperCase(); sections.set(current, heading[2]!.trim() ? [heading[2]!.trim()] : []); continue }
    if (current && raw.trim()) sections.get(current)!.push(raw.trim())
  }
  const list = (key: string): string[] => (sections.get(key) ?? []).map(line => line.replace(/^([-*•]|\d+[.)])\s*/, '').trim()).filter(line => line && !/^\(?none\)?\.?$/i.test(line))
  const concept = (sections.get('CONCEPT') ?? []).join(' ').trim()
  if (!concept) return null
  const related = (sections.get('RELATED MEMORIES') ?? []).join(' ').split(/[\s,;]+/).map(id => id.replace(/[^\w-]/g, '')).filter(id => offered.has(id))
  return {
    concept: concept.slice(0, 1_000),
    openQuestions: list('OPEN QUESTIONS').slice(0, 8).map(line => line.slice(0, 300)),
    nextStep: (sections.get('NEXT STEP') ?? []).join(' ').trim().slice(0, 600),
    relatedMemoryIds: [...new Set(related)],
    observations: list('OBSERVATIONS').slice(0, 6).map(line => line.slice(0, 400))
  }
}

export function briefMarkdown(brief: IdeaBrief): string {
  const lines = [`**Concept:** ${brief.concept}`]
  if (brief.openQuestions.length) lines.push('', '**Open questions**', ...brief.openQuestions.map(question => `- ${question}`))
  if (brief.nextStep) lines.push('', `**Next step:** ${brief.nextStep}`)
  if (brief.observations.length) lines.push('', '**Observations**', ...brief.observations.map(observation => `- ${observation}`))
  return lines.join('\n')
}

/**
 * Starts bounded local explorations as durable jobs and folds their outcome back into the idea.
 * The link between an idea and its job is a database row, so a restart (or a crash of the model)
 * never loses it: `attach()` reconciles every running exploration against its job.
 */
export class IdeaExplorer {
  private detach: (() => void) | null = null
  private readonly settling = new Set<string>()
  private readonly starting = new Set<string>()

  constructor(private readonly deps: IdeaExplorerDeps) {}

  async start(input: ExploreIdeaInput, trigger: IdeaExploration['trigger'], agentSessionId?: string): Promise<IdeaExploration> {
    if (this.starting.has(input.ideaId)) throw new Error('This idea is already being explored')
    this.starting.add(input.ideaId)
    try { return await this.create(input, trigger, agentSessionId) } finally { this.starting.delete(input.ideaId) }
  }

  private async create(input: ExploreIdeaInput, trigger: IdeaExploration['trigger'], agentSessionId?: string): Promise<IdeaExploration> {
    const jobs = this.deps.jobs()
    if (!jobs) throw new Error('Durable jobs are not running in this Conductor, so an idea cannot be explored right now')
    const { store } = this.deps
    const idea = store.get(input.ideaId)
    if (idea.exploring) throw new Error('This idea is already being explored')
    const intensity: IdeaIntensity = input.intensity === 'explore' ? 'explore' : input.intensity === undefined ? store.incubatorSettings().intensity : 'light'
    const model = pickLocalModel(input.model, this.deps.localModels())
    const projectId = idea.links.find(link => link.kind === 'project' && this.deps.projectExists(link.targetId))?.targetId ?? this.deps.homeProjectId()
    if (!projectId) throw new Error('Open a project first: an exploration job runs inside a project (read-only)')
    const memories = this.deps.relatedMemories(idea.text)
    const job = await jobs.create({ ...explorationJob(idea, memories, intensity, projectId, model), ...(trigger === 'agent' && agentSessionId ? { createdBy: { kind: 'agent', agentSessionId, title: 'ideas.explore' } } : {}) })
    const exploration = store.startExploration({ ideaId: idea.id, jobId: job.id, projectId, model, intensity, trigger })
    store.link(idea.id, { kind: 'job', targetId: job.id, label: `${intensity === 'explore' ? 'Exploration' : 'Light exploration'} on ${model}`, projectId, createdFromIdeaId: idea.id, createdByJobId: job.id }, { kind: 'job', jobId: job.id, label: model }, { message: `Exploration job ${job.id} created` })
    return exploration
  }

  /** Subscribes to job changes and settles explorations whose job ended while Conductor was closed. */
  attach(): () => void {
    this.detach?.()
    const jobs = this.deps.jobs()
    if (!jobs) return () => undefined
    const off = jobs.onChange(summary => { void this.observe(summary) })
    for (const exploration of this.deps.store.runningExplorations()) {
      let summary: DurableJobSummary | null = null
      try { summary = jobs.status(exploration.jobId) } catch { summary = null }
      if (summary) void this.observe(summary)
      else this.deps.store.finishExploration(exploration.id, 'stopped', 'Its durable job no longer exists')
    }
    this.detach = off
    return () => { off(); if (this.detach === off) this.detach = null }
  }

  /** Settles the exploration of a job that completed, failed, was cancelled or blocked. */
  async observe(summary: DurableJobSummary): Promise<void> {
    const terminal = TERMINAL_JOB_STATUSES.includes(summary.status)
    if (!terminal && summary.status !== 'blocked') return
    const exploration = this.deps.store.explorationForJob(summary.id)
    if (!exploration || exploration.status !== 'running' || this.settling.has(exploration.id)) return
    this.settling.add(exploration.id)
    try {
      if (summary.status === 'completed') this.complete(exploration)
      else if (summary.status === 'blocked') {
        // An unattended exploration never waits for an approval or a stuck server: it stops,
        // says why, and the owner decides whether a cloud agent should continue.
        const reason = summary.statusReason ?? 'the job was blocked'
        await this.deps.jobs()?.cancel(summary.id, 'Idea exploration stops instead of waiting for the owner').catch(() => undefined)
        this.deps.store.finishExploration(exploration.id, 'stopped', `${reason}. It was not handed to a cloud model.`)
      } else this.deps.store.finishExploration(exploration.id, 'stopped', `${summary.status === 'cancelled' ? 'Cancelled' : 'Failed'}${summary.statusReason ? `: ${summary.statusReason}` : ''}`)
    } catch (error) {
      console.warn('Idea exploration could not be settled', error)
    } finally { this.settling.delete(exploration.id) }
  }

  private complete(exploration: IdeaExploration): void {
    const { store } = this.deps
    const job = this.deps.jobs()?.get(exploration.jobId)
    const stage = job?.stages.filter(item => item.status === 'completed').sort((a, b) => b.index - a.index)[0]
    const answer = (stage?.agentSessionId ? this.deps.lastAnswer(stage.agentSessionId) : '') || stage?.result || ''
    const idea = store.get(exploration.ideaId)
    const offered = this.deps.relatedMemories(idea.text)
    const brief = parseIdeaBrief(answer, offered.map(memory => memory.id))
    const body = answer.replace(STATUS_LINE, '').trim()
    if (!brief && !body) { store.finishExploration(exploration.id, 'stopped', `${exploration.model} finished without writing a brief`); return }
    const createdBy = { kind: 'job' as const, jobId: exploration.jobId, model: exploration.model, machine: this.deps.machine, label: `${exploration.model} on ${this.deps.machine}` }
    store.addSection(idea.id, { kind: 'brief', title: `Idea brief v${idea.sections.filter(section => section.kind === 'brief').length + 1}`, body: brief ? briefMarkdown(brief) : body, ...(brief ? { brief } : {}), createdBy })
    for (const id of brief?.relatedMemoryIds ?? []) {
      const memory = offered.find(item => item.id === id)
      if (memory) store.link(idea.id, { kind: 'memory', targetId: id, label: memory.gist.slice(0, 200), projectId: memory.projectId, createdByJobId: exploration.jobId }, createdBy)
    }
    store.finishExploration(exploration.id, 'completed')
  }
}
