import { describe, expect, it, vi } from 'vitest'
import type { AgentSpec, ProjectRecord, SessionRecord } from '../shared/models'
import type { PhoneSessionSummary } from '../shared/phone-access'
import type { TimelineItem } from '../shared/structured-agent'
import type { GeneralThreads } from './general-threads'
import { conversationMessages, registerThreadsIpc, THREAD_CHANNELS, threadHandoff, type ThreadsIpcDeps } from './threads-ipc'

const project = (id: string, name: string, path: string): ProjectRecord => ({ id, name, path, createdAt: '', updatedAt: '' })
const projects = new Map([
  ['project_general', project('project_general', 'General', '/home/o/Conductor/General')],
  ['project_brand', project('project_brand', 'Brand', '/home/o/Conductor/Brand')]
])
const text = (id: string, role: 'user' | 'assistant' | 'status', value: string, parentId?: string): TimelineItem =>
  ({ id, runtimeId: 'r', sequence: 1, timestamp: '2026-10-29T10:00:00.000Z', ...(parentId ? { parentId } : {}), data: { type: 'text', role, text: value, mode: 'snapshot' } }) as TimelineItem
const items: TimelineItem[] = [
  text('1', 'user', 'Sketch three logo directions'),
  text('2', 'status', 'Thinking…'),
  text('3', 'assistant', 'Here are three directions.'),
  text('4', 'assistant', 'subagent chatter', 'tool_1'),
  { id: '5', runtimeId: 'r', sequence: 2, timestamp: '', data: { type: 'usage' } } as unknown as TimelineItem
]
const specs: Record<string, AgentSpec> = {
  agent_general: { id: 'agent_general', projectId: 'project_general', sessionId: 'ws_g', provider: 'claude', model: 'default', title: 'Claude', cwd: '/home/o/Conductor/General' },
  agent_brand: { id: 'agent_brand', projectId: 'project_brand', sessionId: 'ws_b', provider: 'codex', model: 'gpt-6.1', title: 'Codex', cwd: '/home/o/Conductor/Brand' }
}
const general = (id: string | null = 'project_general'): GeneralThreads => ({
  projectId: () => id,
  ensure: vi.fn(async () => ({ project: { ...projects.get('project_general')!, general: true as const }, workspace: { id: 'ws_g', projectId: 'project_general' } as SessionRecord })),
  promote: vi.fn((name: string) => ({ ...projects.get('project_general')!, name }))
}) as unknown as GeneralThreads
const deps = (overrides: Partial<ThreadsIpcDeps> = {}): Omit<ThreadsIpcDeps, 'ipcMain'> => ({
  trusted: vi.fn(), general: general(), sessions: () => [],
  spec: id => specs[id] ?? null, items: () => items, title: id => id === 'agent_general' ? 'Logo ideas' : null,
  getProject: id => projects.get(id) ?? null, projectsChanged: vi.fn(), now: () => Date.parse('2026-10-29T12:00:00.000Z'), ...overrides
})

describe('threadHandoff', () => {
  it('drafts the first message for the same provider from top-level messages only', () => {
    const handoff = threadHandoff(deps(), 'agent_general', 'project_brand')!
    expect(handoff.provider).toBe('claude')
    expect(handoff).not.toHaveProperty('model')
    expect(handoff.text).toContain('"Logo ideas"')
    expect(handoff.text).toContain('/home/o/Conductor/General')
    expect(handoff.text).toContain('Me: Sketch three logo directions')
    expect(handoff.text).toContain('Agent: Here are three directions.')
    expect(handoff.text).not.toContain('Thinking')
    expect(handoff.text).not.toContain('subagent chatter')
    expect(conversationMessages(items)).toHaveLength(2)
  })

  it('continues only a General thread, into another open project', () => {
    expect(() => threadHandoff(deps(), 'agent_brand', 'project_general')).toThrow(/started without a project/)
    expect(() => threadHandoff(deps(), 'agent_general', 'project_general')).toThrow(/another project/)
    expect(() => threadHandoff(deps(), 'agent_general', 'project_gone')).toThrow(/another project/)
    expect(() => threadHandoff(deps({ general: general(null) }), 'agent_general', 'project_brand')).toThrow(/started without a project/)
    expect(() => threadHandoff(deps(), '../etc', 'project_brand')).toThrow(/Choose a thread/)
    expect(threadHandoff(deps(), 'agent_unknown', 'project_brand')).toBeNull()
  })
})

describe('registerThreadsIpc', () => {
  it('checks the sender on every channel, announces project changes and removes its handlers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = { handle: vi.fn((channel: string, run: (...args: unknown[]) => unknown) => { handlers.set(channel, run) }), removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }) }
    const summary = { id: 'agent_general', projectId: 'project_general', projectName: 'General', workspaceId: 'ws_g', workspaceName: 'Workspace', tabId: 'pane_1', title: 'Logo ideas', provider: 'claude', machineId: 'local', machineName: 'MAIN', phase: 'idle', activity: 'idle', state: 'done', needs: null, updatedAt: '2026-10-29T11:59:00.000Z', queued: 0, archived: false } as PhoneSessionSummary
    const wiring = deps({ sessions: () => [summary] })
    const dispose = registerThreadsIpc({ ...wiring, ipcMain } as unknown as ThreadsIpcDeps)
    expect([...handlers.keys()].sort()).toEqual([...THREAD_CHANNELS].sort())
    const event = {}
    const target = await handlers.get('threads:new-general')!(event) as { project: ProjectRecord }
    expect(target.project.general).toBe(true)
    expect(wiring.projectsChanged).toHaveBeenCalledTimes(1)
    expect(await handlers.get('threads:general-id')!(event)).toBe('project_general')
    const view = await handlers.get('threads:list')!(event, 'logo') as { groups: Array<{ threads: Array<{ general: boolean }> }>; total: number }
    expect(view.total).toBe(1)
    expect(view.groups[0]!.threads[0]!.general).toBe(true)
    expect(await handlers.get('threads:list')!(event, 42)).toMatchObject({ total: 1 })
    expect(await handlers.get('threads:promote')!(event, 'Brand spike')).toMatchObject({ name: 'Brand spike' })
    expect(wiring.projectsChanged).toHaveBeenCalledTimes(2)
    expect(await handlers.get('threads:handoff')!(event, 'agent_general', 'project_brand')).toMatchObject({ provider: 'claude' })
    expect(wiring.trusted).toHaveBeenCalledTimes(6)
    const refused = deps({ trusted: () => { throw new Error('Structured controls require the trusted Conductor document') } })
    registerThreadsIpc({ ...refused, ipcMain } as unknown as ThreadsIpcDeps)
    await expect(Promise.resolve().then(() => handlers.get('threads:new-general')!(event))).rejects.toThrow(/trusted/)
    expect(refused.general.ensure).not.toHaveBeenCalled()
    dispose()
    expect(handlers.size).toBe(0)
  })
})
