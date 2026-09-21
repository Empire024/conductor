import type { ProjectRecord } from '../shared/models'
import type { PhoneProjectTaskRequest, PhoneProjectTaskResult } from '../shared/phone-access'
import type { ProjectBacklogs } from './project-backlog'

interface RemoteTaskClient { call(machineId: string, method: string, args?: Record<string, unknown>): Promise<unknown> }

export interface PhoneProjectTaskDependencies {
  backlogs: ProjectBacklogs
  remote: RemoteTaskClient
  changed(project: ProjectRecord): void
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Routes a phone-created task to the computer that owns the selected project's disk. */
export class PhoneProjectTasks {
  constructor(private readonly deps: PhoneProjectTaskDependencies) {}

  async create(project: ProjectRecord, input: Required<PhoneProjectTaskRequest>): Promise<PhoneProjectTaskResult> {
    let result: unknown
    if (project.remote) {
      // Use the origin's own project id. A remote project never falls back to a same-named local
      // folder when its host is offline, revoked, or no longer shares it.
      const listed = record(await this.deps.remote.call(project.remote.machineId, 'tasks.list', { projectId: project.remote.remoteProjectId }))
      if (typeof listed.revision !== 'string') throw new Error('That machine returned an invalid project task revision.')
      result = await this.deps.remote.call(project.remote.machineId, 'tasks.create', { projectId: project.remote.remoteProjectId, revision: listed.revision, ...input })
    } else {
      const board = await this.deps.backlogs.get(project.id)
      const before = new Set(board.tasks.map(task => task.id))
      const updated = await this.deps.backlogs.edit(project.id, board.revision, { type: 'add', ...input }, { actor: 'you' })
      result = updated.tasks.find(task => !before.has(task.id))
    }
    const task = record(result)
    if (typeof task.id !== 'string' || typeof task.title !== 'string' || task.kind !== input.kind || !['high', 'normal', 'low'].includes(String(task.priority)) || !['heavy', 'medium', 'light'].includes(String(task.weight))) {
      throw new Error('The project task was saved, but its result was invalid.')
    }
    this.deps.changed(project)
    return { id: task.id, projectId: project.id, title: task.title, kind: input.kind, priority: task.priority as PhoneProjectTaskResult['priority'], weight: task.weight as PhoneProjectTaskResult['weight'] }
  }
}
