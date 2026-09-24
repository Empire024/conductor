import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateDurableJobInput, DurableJob, DurableJobStage, DurableJobSummary } from '../../shared/durable-jobs'
import { IdeaExplorer, explorationJob, parseIdeaBrief, pickLocalModel, type IdeaExplorerDeps } from './explore'
import { IdeaStore } from './store'

const OWNER = { kind: 'owner' as const }
const ANSWER = [
  '**CONCEPT:** Location-exclusive clothing drops tied to specific cities.',
  'OPEN QUESTIONS:',
  '- Manufacturing economics of small runs?',
  '2. How is presence in the city verified?',
  'NEXT STEP: Design one Prague drop and test a landing page.',
  'RELATED MEMORIES: mem_1, mem_unknown',
  'OBSERVATIONS:',
  '- none',
  'JOB STATUS: DONE'
].join('\n')

describe('parseIdeaBrief', () => {
  it('reads the brief format, tolerating emphasis, numbering and unknown memory ids', () => {
    expect(parseIdeaBrief(ANSWER, ['mem_1', 'mem_2'])).toEqual({
      concept: 'Location-exclusive clothing drops tied to specific cities.',
      openQuestions: ['Manufacturing economics of small runs?', 'How is presence in the city verified?'],
      nextStep: 'Design one Prague drop and test a landing page.',
      relatedMemoryIds: ['mem_1'],
      observations: []
    })
  })
  it('returns null without a concept', () => { expect(parseIdeaBrief('I could not do it.\nJOB STATUS: DONE', [])).toBeNull() })
})

describe('pickLocalModel', () => {
  it('prefers the requested, then the loaded, then the first configured local model, and never a cloud one', () => {
    expect(pickLocalModel('local/b', { configured: ['a', 'b'], loaded: 'a' })).toBe('b')
    expect(pickLocalModel(undefined, { configured: ['a', 'b'], loaded: 'b' })).toBe('b')
    expect(pickLocalModel(undefined, { configured: ['a', 'b'], loaded: 'other' })).toBe('a')
    expect(() => pickLocalModel('claude/opus', { configured: ['a'], loaded: null })).toThrow(/local model/)
    expect(() => pickLocalModel(undefined, { configured: [], loaded: null })).toThrow(/No local model/)
  })
})

describe('explorationJob', () => {
  it('is a read-only, bounded job without a worktree', () => {
    const store = new IdeaStore(':memory:')
    const idea = store.capture({ text: 'Premium jam company using seasonal farm fruit' }, OWNER)
    const light = explorationJob(idea, [], 'light', 'project_1', 'qwen')
    expect(light).toMatchObject({ projectId: 'project_1', model: 'qwen', isolateWorktree: false, budgets: { maxStageAttempts: 2 } })
    expect(light.stages).toHaveLength(1)
    expect(light.stages![0]).toMatchObject({ kind: 'research' })
    expect(explorationJob(idea, [], 'explore', 'project_1', 'qwen').stages!.map(stage => stage.kind)).toEqual(['research', 'report'])
    expect(light.constraints!.join(' ')).toMatch(/Read only/)
    store.close()
  })
})

class FakeJobs {
  created: CreateDurableJobInput[] = []
  statuses = new Map<string, DurableJobSummary>()
  stages = new Map<string, DurableJobStage[]>()
  listeners = new Set<(summary: DurableJobSummary) => void>()
  cancel = vi.fn(async (jobId: string) => this.set(jobId, 'cancelled'))
  async create(input: CreateDurableJobInput): Promise<DurableJobSummary> {
    this.created.push(input)
    const id = `job_${this.created.length}`
    return this.set(id, 'queued')
  }
  set(id: string, status: DurableJobSummary['status'], statusReason?: string): DurableJobSummary {
    const summary = { id, projectId: 'project_1', title: 't', status, ...(statusReason ? { statusReason } : {}), model: 'qwen', stagesCompleted: 0, stagesTotal: 1, elapsedMs: 0, activeMs: 0, counters: {} as never, updatedAt: '' } as DurableJobSummary
    this.statuses.set(id, summary)
    return summary
  }
  emit(summary: DurableJobSummary): void { for (const listener of this.listeners) listener(summary) }
  status(id: string): DurableJobSummary { const summary = this.statuses.get(id); if (!summary) throw new Error('missing'); return summary }
  get(id: string): DurableJob & { stages: DurableJobStage[] } { return { stages: this.stages.get(id) ?? [] } as never }
  onChange(listener: (summary: DurableJobSummary) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

const stores: IdeaStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture(overrides: Partial<IdeaExplorerDeps> = {}) {
  const store = new IdeaStore(':memory:'); stores.push(store)
  const jobs = new FakeJobs()
  const deps: IdeaExplorerDeps = {
    store, jobs: () => jobs as never, localModels: () => ({ configured: ['qwen'], loaded: null }), homeProjectId: () => 'project_home',
    projectExists: id => id === 'project_linked', relatedMemories: () => [{ id: 'mem_1', projectId: 'project_home', kind: 'semantic', gist: 'Owner likes Prague' }],
    lastAnswer: () => ANSWER, machine: 'MAIN', ...overrides
  }
  return { store, jobs, explorer: new IdeaExplorer(deps) }
}

describe('IdeaExplorer', () => {
  it('starts a local job, links it, and turns the completed answer into a brief with memory links', async () => {
    const { store, jobs, explorer } = fixture()
    const idea = store.capture({ text: 'Clothing drops by city' }, OWNER)
    store.link(idea.id, { kind: 'project', targetId: 'project_linked', label: 'Shop' }, OWNER)
    explorer.attach()
    const exploration = await explorer.start({ ideaId: idea.id }, 'owner')
    expect(jobs.created[0]).toMatchObject({ projectId: 'project_linked', model: 'qwen', isolateWorktree: false })
    expect(store.get(idea.id)).toMatchObject({ status: 'exploring', exploring: true, linkCounts: { job: 1 } })
    await expect(explorer.start({ ideaId: idea.id }, 'owner')).rejects.toThrow(/already/)

    jobs.stages.set(exploration.jobId, [{ id: 's1', index: 0, status: 'completed', agentSessionId: 'agent_stage' } as DurableJobStage])
    jobs.emit(jobs.set(exploration.jobId, 'completed'))
    await Promise.resolve()
    const detail = store.get(idea.id)
    expect(detail).toMatchObject({ status: 'inbox', exploring: false, workedOn: false })
    expect(detail.latestBrief).toMatchObject({ title: 'Idea brief v1', brief: { concept: 'Location-exclusive clothing drops tied to specific cities.' }, createdBy: { model: 'qwen', machine: 'MAIN' } })
    expect(detail.links.find(link => link.kind === 'memory')).toMatchObject({ targetId: 'mem_1', createdByJobId: exploration.jobId })
    expect(detail.text).toBe('Clothing drops by city')
  })

  it('cancels a blocked job and records why, without escalating', async () => {
    const { store, jobs, explorer } = fixture()
    const idea = store.capture({ text: 'Blocked idea text' }, OWNER)
    explorer.attach()
    const exploration = await explorer.start({ ideaId: idea.id }, 'incubator')
    jobs.emit(jobs.set(exploration.jobId, 'blocked', 'Stage 1 exhausted its attempts'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(jobs.cancel).toHaveBeenCalledWith(exploration.jobId, expect.any(String))
    expect(store.exploration(exploration.id)).toMatchObject({ status: 'stopped', note: expect.stringMatching(/exhausted.*not handed to a cloud model/) })
    expect(store.get(idea.id).status).toBe('inbox')
  })

  it('reconciles explorations whose job finished or vanished while Conductor was closed', async () => {
    const { store, jobs, explorer } = fixture()
    const done = store.capture({ text: 'Finished while closed' }, OWNER)
    const gone = store.capture({ text: 'Job deleted meanwhile' }, OWNER)
    const first = store.startExploration({ ideaId: done.id, jobId: 'job_done', projectId: 'p', model: 'qwen', intensity: 'light', trigger: 'incubator' })
    const second = store.startExploration({ ideaId: gone.id, jobId: 'job_gone', projectId: 'p', model: 'qwen', intensity: 'light', trigger: 'incubator' })
    jobs.set('job_done', 'completed')
    jobs.stages.set('job_done', [{ id: 's', index: 0, status: 'completed', result: ANSWER } as DurableJobStage])
    explorer.attach()
    await Promise.resolve()
    expect(store.exploration(first.id)?.status).toBe('completed')
    expect(store.exploration(second.id)).toMatchObject({ status: 'stopped', note: 'Its durable job no longer exists' })
  })

  it('refuses without a local model or without the jobs service', async () => {
    const none = fixture({ localModels: () => ({ configured: [], loaded: null }) })
    const idea = none.store.capture({ text: 'Needs a model' }, OWNER)
    await expect(none.explorer.start({ ideaId: idea.id }, 'owner')).rejects.toThrow(/No local model/)
    const off = fixture({ jobs: () => undefined })
    const other = off.store.capture({ text: 'No jobs service' }, OWNER)
    await expect(off.explorer.start({ ideaId: other.id }, 'owner')).rejects.toThrow(/Durable jobs/)
  })
})
