import { describe, expect, it, vi } from 'vitest'
import type { ProjectRecord } from '../shared/models'
import type { ProjectBacklogs } from './project-backlog'
import { PhoneProjectTasks } from './phone-project-tasks'

const local: ProjectRecord = { id: 'local-project', name: 'Local', path: 'C:\\work\\local', createdAt: 't', updatedAt: 't' }
const remote: ProjectRecord = { id: 'adopted-project', name: 'Remote', path: 'remote:host:origin-project', createdAt: 't', updatedAt: 't', remote: { machineId: 'host', machineName: 'MAIN', remoteProjectId: 'origin-project', path: 'D:\\work\\remote' } }
const input = { title: 'Phone report', kind: 'bug' as const, priority: 'high' as const, weight: 'heavy' as const }

describe('phone project task routing', () => {
  it('lists only a bounded open page locally and strips desktop-only task history', async () => {
    const get = vi.fn(async () => ({ revision: 'rev-1', tasks: [{ id: 'open', title: 'Open', kind: 'task', status: 'todo', priority: 'normal', weight: 'medium', line: 12, activity: [{ id: 'history' }] }], page: { offset: 0, limit: 20, total: 1, hasMore: false } }))
    const service = new PhoneProjectTasks({ backlogs: { get } as unknown as ProjectBacklogs, remote: { call: vi.fn() }, changed: vi.fn() })
    await expect(service.list(local, { offset: 0, limit: 20 })).resolves.toEqual({ projectId: local.id, tasks: [{ id: 'open', title: 'Open', kind: 'task', status: 'todo', priority: 'normal', weight: 'medium' }], page: { offset: 0, limit: 20, total: 1, hasMore: false } })
    expect(get).toHaveBeenCalledWith(local.id, { offset: 0, limit: 20, includeDone: false, includeArchived: false })
  })

  it('asks a remote host for the same filtered page instead of its whole checklist', async () => {
    const call = vi.fn(async () => ({ tasks: [], page: { offset: 20, limit: 20, total: 25, hasMore: false } }))
    const service = new PhoneProjectTasks({ backlogs: {} as ProjectBacklogs, remote: { call }, changed: vi.fn() })
    await service.list(remote, { offset: 20, limit: 20 })
    expect(call).toHaveBeenCalledWith('host', 'tasks.list', { projectId: 'origin-project', offset: 20, limit: 20, includeDone: false, includeArchived: false })
  })

  it('uses a fresh local revision, records the owner actor, and publishes the changed project', async () => {
    const get = vi.fn(async () => ({ revision: 'rev-1', tasks: [] }))
    const edit = vi.fn(async () => ({ tasks: [{ id: 'new-local', ...input }] }))
    const changed = vi.fn()
    const service = new PhoneProjectTasks({ backlogs: { get, edit } as unknown as ProjectBacklogs, remote: { call: vi.fn() }, changed })
    await expect(service.create(local, input)).resolves.toMatchObject({ id: 'new-local', projectId: local.id })
    expect(edit).toHaveBeenCalledWith(local.id, 'rev-1', { type: 'add', ...input }, { actor: 'you' })
    expect(changed).toHaveBeenCalledWith(local)
  })

  it('routes an adopted project to its exact origin and never falls back to local disk', async () => {
    const get = vi.fn()
    const edit = vi.fn()
    const call = vi.fn(async (_machineId: string, method: string) => method === 'tasks.list' ? { revision: 'remote-rev' } : { id: 'new-remote', ...input })
    const service = new PhoneProjectTasks({ backlogs: { get, edit } as unknown as ProjectBacklogs, remote: { call }, changed: vi.fn() })
    await expect(service.create(remote, input)).resolves.toMatchObject({ id: 'new-remote', projectId: remote.id })
    expect(call).toHaveBeenNthCalledWith(1, 'host', 'tasks.list', { projectId: 'origin-project', offset: 0, limit: 1, includeDone: false, includeArchived: false })
    expect(call).toHaveBeenNthCalledWith(2, 'host', 'tasks.create', { projectId: 'origin-project', revision: 'remote-rev', ...input })
    expect(get).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled()

    call.mockRejectedValueOnce(new Error('host offline'))
    await expect(service.create(remote, input)).rejects.toThrow(/offline/)
    expect(get).not.toHaveBeenCalled()
  })
})
