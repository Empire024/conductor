import type { ProjectRecord } from '../shared/models'
import type { PhoneProjectTaskPage, PhoneProjectTaskRequest, PhoneProjectTaskResult } from '../shared/phone-access'
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

  async list(project:ProjectRecord,query:{offset:number;limit:number}):Promise<PhoneProjectTaskPage> {
    const request={offset:query.offset,limit:query.limit,includeDone:false,includeArchived:false}
    const value=project.remote
      ? await this.deps.remote.call(project.remote.machineId,'tasks.list',{projectId:project.remote.remoteProjectId,...request})
      : await this.deps.backlogs.get(project.id,request)
    const board=record(value), page=record(board.page)
    if(!Array.isArray(board.tasks) || !Number.isInteger(page.offset) || !Number.isInteger(page.limit) || !Number.isInteger(page.total) || typeof page.hasMore!=='boolean')throw new Error('That machine returned an invalid project task page.')
    const tasks=board.tasks.map(record).map(task=> {
      if(typeof task.id!=='string' || typeof task.title!=='string' || !['task','bug','feature','idea'].includes(String(task.kind)) || !['todo','doing'].includes(String(task.status)) || !['high','normal','low'].includes(String(task.priority)) || !['heavy','medium','light'].includes(String(task.weight)))throw new Error('That machine returned an invalid project task.')
      return {id:task.id,title:task.title,kind:task.kind as PhoneProjectTaskPage['tasks'][number]['kind'],status:task.status as PhoneProjectTaskPage['tasks'][number]['status'],priority:task.priority as PhoneProjectTaskPage['tasks'][number]['priority'],weight:task.weight as PhoneProjectTaskPage['tasks'][number]['weight']}
    })
    return {projectId:project.id,tasks,page:{offset:Number(page.offset),limit:Number(page.limit),total:Number(page.total),hasMore:page.hasMore as boolean}}
  }

  async create(project: ProjectRecord, input: Required<PhoneProjectTaskRequest>): Promise<PhoneProjectTaskResult> {
    let result: unknown
    if (project.remote) {
      // Use the origin's own project id. A remote project never falls back to a same-named local
      // folder when its host is offline, revoked, or no longer shares it.
      const listed = record(await this.deps.remote.call(project.remote.machineId, 'tasks.list', { projectId: project.remote.remoteProjectId, offset: 0, limit: 1, includeDone: false, includeArchived: false }))
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
