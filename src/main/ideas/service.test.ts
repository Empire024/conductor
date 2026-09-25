import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMemory } from '../../shared/models'
import { ideaMethods, ideasCall, IDEA_MUTATION_METHODS, IDEA_READ_METHODS, type IdeasControlCaller } from './control'
import { IdeaExplorer } from './explore'
import { ideasPhoneRoute } from './phone'
import { IdeasService, type IdeasServiceDeps } from './service'
import { IdeaStore } from './store'

vi.mock('../phone-access', () => ({ PhoneAccessError: class PhoneAccessError extends Error { constructor(message: string, readonly status = 400) { super(message) } } }))

const memory = (id: string, gist: string, cues: string[]): AgentMemory => ({ id, projectId: 'project_1', kind: 'semantic', gist, cues, salience: 0.5, confidence: 0.8, strength: 1, recallCount: 0, occurredAt: '2026-09-01T00:00:00.000Z' } as unknown as AgentMemory)
const stores: IdeaStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture(overrides: Partial<IdeasServiceDeps> = {}) {
  const store = new IdeaStore(':memory:'); stores.push(store)
  const explorer = { start: vi.fn(async () => ({ id: 'exp' })) } as unknown as IdeaExplorer
  const openAgent = vi.fn(async (_request: Parameters<IdeasServiceDeps['openAgent']>[0]) => ({ agentSessionId: 'agent_new', tabId: 'tab_new' }))
  const addTask = vi.fn(async (_projectId: string, title: string) => ({ taskId: 'task_9', title }))
  const service = new IdeasService({
    store, explorer, openAgent, addTask, open: vi.fn(async () => undefined),
    memories: () => [memory('mem_1', 'Owner wants clothing drops tested in Prague first', ['clothing', 'prague']), memory('mem_2', 'Invoices use Fio exports', ['invoice'])],
    projectTitle: id => id === 'project_1' ? 'Shop' : null,
    ...overrides
  })
  return { store, explorer, openAgent, addTask, service }
}

const agent: IdeasControlCaller = { projectId: 'project_1', agentSessionId: 'agent_caller', title: 'Coworker', sovereign: false, readOnly: false }

describe('IdeasService', () => {
  it('works on an idea with its whole context and links the conversation and project', async () => {
    const { store, service, openAgent } = fixture()
    const idea = store.capture({ text: 'Clothing drops by city\nPrague first' }, { kind: 'owner' })
    store.addSection(idea.id, { kind: 'brief', title: 'Idea brief v1', body: 'b', brief: { concept: 'City-exclusive drops', openQuestions: ['Cost?'], nextStep: 'One Prague drop', relatedMemoryIds: [], observations: [] }, createdBy: { kind: 'job', model: 'qwen', machine: 'MAIN' } })
    const opened = await service.work({ ideaId: idea.id, projectId: 'project_1' })
    expect(opened).toEqual({ agentSessionId: 'agent_new', tabId: 'tab_new' })
    const prompt = openAgent.mock.calls[0]![0].prompt
    expect(prompt).toContain('Clothing drops by city\nPrague first')
    expect(prompt).toContain('Concept: City-exclusive drops')
    expect(prompt).toContain('Owner wants clothing drops tested in Prague first')
    expect(prompt).not.toContain('Fio exports')
    expect(prompt).toContain(`"ideaId":"${idea.id}"`)
    const detail = store.get(idea.id)
    expect(detail).toMatchObject({ workedOn: true, status: 'active', linkCounts: { project: 1, 'agent-session': 1 } })
    expect(detail.links.find(link => link.kind === 'agent-session')).toMatchObject({ targetId: 'agent_new', createdFromIdeaId: idea.id, projectId: 'project_1' })
    await expect(service.work({ ideaId: idea.id, projectId: 'nope' })).rejects.toThrow(/project/)
  })

  it('creates a project task from an idea and links it with provenance', async () => {
    const { store, service, addTask } = fixture()
    const idea = store.capture({ text: 'Research Czech manufacturers' }, { kind: 'owner' })
    const link = await service.createTask({ ideaId: idea.id, projectId: 'project_1' })
    expect(addTask).toHaveBeenCalledWith('project_1', 'Research Czech manufacturers')
    expect(link).toMatchObject({ kind: 'task', targetId: 'project_1:task_9', createdFromIdeaId: idea.id })
    expect(store.get(idea.id).workedOn).toBe(true)
  })
})

describe('ideas.* control', () => {
  it('lists every method as read or mutation', () => {
    expect(new Set([...IDEA_READ_METHODS, ...IDEA_MUTATION_METHODS])).toEqual(ideaMethods)
  })

  it('lets a writable agent link work and add notes with its session as provenance, never touching the note', async () => {
    const { store, service } = fixture()
    const idea = store.capture({ text: 'Landing page idea' }, { kind: 'owner' })
    await ideasCall(service, agent, 'ideas.link', { ideaId: idea.id, kind: 'artifact', targetId: 'docs/landing.html', label: 'Prototype page' })
    await ideasCall(service, agent, 'ideas.note', { ideaId: idea.id, title: 'Finding', body: 'Stripe supports CZK' })
    const detail = await ideasCall(service, agent, 'ideas.get', { ideaId: idea.id }) as ReturnType<IdeaStore['get']>
    expect(detail.text).toBe('Landing page idea')
    expect(detail.links[0]).toMatchObject({ kind: 'artifact', targetId: 'docs/landing.html', createdByAgentSessionId: 'agent_caller', createdFromIdeaId: idea.id, projectId: 'project_1' })
    expect(detail.sections[0]).toMatchObject({ kind: 'note', body: 'Stripe supports CZK', createdBy: { kind: 'agent', agentSessionId: 'agent_caller' } })
    await expect(ideasCall(service, agent, 'ideas.link', { ideaId: idea.id, kind: 'job', targetId: 'job_1' })).rejects.toThrow(/kind must be/)
    await expect(ideasCall(service, agent, 'ideas.get', { ideaId: idea.id, extra: 1 })).rejects.toThrow(/does not accept extra/)
  })

  it('keeps a local model or read-only conversation to reads', async () => {
    const { store, service } = fixture()
    const idea = store.capture({ text: 'Read only idea' }, { kind: 'owner' })
    const local = { ...agent, readOnly: true }
    expect(await ideasCall(service, local, 'ideas.list', {})).toHaveLength(1)
    await expect(ideasCall(service, local, 'ideas.capture', { text: 'x' })).rejects.toThrow(/may only read/)
    await expect(ideasCall(service, local, 'ideas.explore', { ideaId: idea.id })).rejects.toThrow(/may only read/)
  })

  it('works in the caller\'s own project', async () => {
    const { store, service, openAgent } = fixture()
    const idea = store.capture({ text: 'Agent-started work' }, { kind: 'owner' })
    await ideasCall(service, agent, 'ideas.work', { ideaId: idea.id, provider: 'codex' })
    expect(openAgent.mock.calls[0]![0]).toMatchObject({ projectId: 'project_1', provider: 'codex' })
    // An agent's ideas.work opens the conversation without taking the owner's focus (FX21).
    expect(openAgent.mock.calls[0]![0]).toMatchObject({ background: true })
    await service.work({ ideaId: idea.id, projectId: 'project_1', provider: 'codex' })
    expect(openAgent.mock.calls[1]![0]).not.toHaveProperty('background')
  })
})

describe('phone /api/ideas', () => {
  const device = { id: 'dev', name: 'Pixel' }
  it('captures from the phone, lists, reads and updates', async () => {
    const { service } = fixture()
    const created = await ideasPhoneRoute(service, 'POST', '/api/ideas', { text: 'Idea typed on the phone' }, new URLSearchParams(), device) as { id: string; capturedFrom: string }
    expect(created.capturedFrom).toBe('phone')
    const listed = await ideasPhoneRoute(service, 'GET', '/api/ideas', {}, new URLSearchParams('search=phone'), device) as { ideas: Array<{ id: string }> }
    expect(listed.ideas.map(idea => idea.id)).toEqual([created.id])
    const updated = await ideasPhoneRoute(service, 'POST', `/api/ideas/${created.id}`, { text: 'Idea typed on the phone, edited', status: 'parked' }, new URLSearchParams(), device) as { status: string; text: string }
    expect(updated).toMatchObject({ status: 'parked', text: 'Idea typed on the phone, edited' })
    await expect(ideasPhoneRoute(service, 'GET', '/api/ideas/idea_missing', {}, new URLSearchParams(), device)).rejects.toMatchObject({ status: 404 })
    await expect(ideasPhoneRoute(service, 'POST', '/api/ideas', { text: '   ' }, new URLSearchParams(), device)).rejects.toThrow(/empty/)
  })

  it('starts work and tasks from the phone', async () => {
    const { service, openAgent, addTask } = fixture()
    const created = await ideasPhoneRoute(service, 'POST', '/api/ideas', { text: 'Phone idea' }, new URLSearchParams(), device) as { id: string }
    await ideasPhoneRoute(service, 'POST', `/api/ideas/${created.id}/work`, { projectId: 'project_1' }, new URLSearchParams(), device)
    await ideasPhoneRoute(service, 'POST', `/api/ideas/${created.id}/task`, { projectId: 'project_1' }, new URLSearchParams(), device)
    expect(openAgent).toHaveBeenCalledOnce()
    expect(addTask).toHaveBeenCalledOnce()
  })
})
