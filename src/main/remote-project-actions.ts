import type { ProjectRecord } from '../shared/models'
import type { ProjectBacklog, ProjectTaskDispatchOptions, ProjectTaskEdit, ProjectTaskListQuery } from '../shared/project-backlog'
import type { RemoteProjectSummary } from '../shared/remote-control'
import { readRemoteProjectSummaries } from '../shared/remote-control'
import type { SourceControlChangeSet, SourceControlStatus } from '../shared/source-control'
import { RemoteProjectError } from './project-scope'

/**
 * The actions of a project that lives on a paired machine, carried out on that machine.
 *
 * The laptop's renderer addresses a "Remote: MAIN" project the same way it addresses a local one:
 * the task list pane asks for `project-tasks:get`, the explorer's rename asks for
 * `projects:rename`. Those handlers used to refuse every remote project outright (and only knew the
 * row id), so the owner met "Error invoking remote method" on nearly everything they touched in
 * such a project. The handlers now resolve the project once and, for a remote one, end up here:
 * the host's own task list, the host's own folder rename, under the host's grant checks.
 *
 * Every answer is renamed back into this computer's id for the project before it reaches the
 * renderer, because the renderer keys its state by its own row and must never learn to compare
 * two kinds of id.
 */
export interface RemoteProjectTarget {
  /** This computer's row for the project; every local binding is kept under it. */
  localProjectId: string
  /** The host's id for it, the only one the host understands. */
  remoteProjectId: string
  machineId: string
  machineName: string
}

export interface RemoteProjectActionDependencies {
  /** Resolves either id of a project that lives on a paired machine; throws a sentence otherwise. */
  resolve(projectId: string): RemoteProjectTarget
  /** One authenticated call to that machine. */
  call(machineId: string, method: string, args: Record<string, unknown>): Promise<unknown>
  /** Refreshes this computer's row from what the host now says about the project. */
  adopt(target: RemoteProjectTarget, summary: RemoteProjectSummary): ProjectRecord | null
  /** A forwarded edit changed the task list, or the project row itself (its name and folder). */
  changed?(target: RemoteProjectTarget, what: 'tasks' | 'project'): void
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A host that predates a method answers this, and the owner should hear "update it", not a code. */
const unknownMethod = (error: unknown): boolean => error instanceof Error && /Unknown remote method/.test(error.message)

const outdated = (target: RemoteProjectTarget, feature: string): RemoteProjectError =>
  new RemoteProjectError(target.machineName, feature,
    `${target.machineName} runs an older Conductor that cannot do this from here yet: ${feature}. Update Conductor on ${target.machineName}, then try again.`)

export class RemoteProjectActions {
  constructor(private readonly deps: RemoteProjectActionDependencies) {}

  private async call(target: RemoteProjectTarget, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.deps.call(target.machineId, method, { ...args, projectId: target.remoteProjectId })
  }

  /** The host's board, named by this computer's id for the project. */
  private board(target: RemoteProjectTarget, value: unknown): ProjectBacklog {
    const board = record(value)
    if (!Array.isArray(board.tasks) || typeof board.revision !== 'string') throw new Error(`${target.machineName} returned an invalid task list.`)
    const sourceControl = record(board.sourceControl)
    return {
      ...(board as unknown as ProjectBacklog),
      projectId: target.localProjectId,
      owners: Array.isArray(board.owners) ? board.owners as ProjectBacklog['owners'] : [],
      sourceControl: { ...(sourceControl as unknown as SourceControlStatus), projectId: target.localProjectId, available: sourceControl.available === true, enabled: sourceControl.enabled === true }
    }
  }

  private static listArgs(query?: ProjectTaskListQuery): Record<string, unknown> {
    if (!query) return {}
    return {
      ...(typeof query.query === 'string' ? { query: query.query } : {}),
      ...(typeof query.kind === 'string' ? { kind: query.kind } : {}),
      includeDone: query.includeDone === true,
      includeArchived: query.includeArchived === true,
      ...(typeof query.offset === 'number' ? { offset: query.offset } : {}),
      ...(typeof query.limit === 'number' ? { limit: query.limit } : {})
    }
  }

  async tasks(projectId: string, query?: ProjectTaskListQuery): Promise<ProjectBacklog> {
    const target = this.deps.resolve(projectId)
    return this.board(target, await this.call(target, 'tasks.list', RemoteProjectActions.listArgs(query)))
  }

  async editTask(projectId: string, revision: string, edit: ProjectTaskEdit, query?: ProjectTaskListQuery): Promise<ProjectBacklog> {
    const target = this.deps.resolve(projectId)
    if (!edit || typeof edit !== 'object' || typeof revision !== 'string') throw new Error('Invalid task edit')
    let result: unknown
    try {
      result = await this.call(target, 'tasks.edit', { revision, edit, ...(query ? { query: RemoteProjectActions.listArgs(query) } : {}) })
    } catch (error) {
      if (!unknownMethod(error)) throw error
      // A host from before `tasks.edit` still serves the two edits the phone always could.
      if (edit.type === 'add') {
        await this.call(target, 'tasks.create', { revision, title: edit.title, kind: edit.kind, ...(edit.priority ? { priority: edit.priority } : {}), ...(edit.weight ? { weight: edit.weight } : {}) })
      } else if (edit.type === 'update' && edit.kind === undefined && edit.weight === undefined && edit.agentId === undefined) {
        await this.call(target, 'tasks.update', { revision, id: edit.id, ...(edit.status ? { status: edit.status } : {}), ...(edit.title === undefined ? {} : { title: edit.title }), ...(edit.priority ? { priority: edit.priority } : {}) })
      } else {
        throw outdated(target, edit.type === 'remove' ? 'Removing a task' : 'Changing that part of a task')
      }
      result = await this.call(target, 'tasks.list', RemoteProjectActions.listArgs(query))
    }
    this.deps.changed?.(target, 'tasks')
    return this.board(target, result)
  }

  async taskChanges(projectId: string, taskId: string): Promise<SourceControlChangeSet> {
    const target = this.deps.resolve(projectId)
    try {
      const changes = record(await this.call(target, 'tasks.changes', { taskId: String(taskId ?? '') }))
      if (!Array.isArray(changes.commits) || !Array.isArray(changes.files)) throw new Error(`${target.machineName} returned invalid task changes.`)
      return changes as unknown as SourceControlChangeSet
    } catch (error) {
      if (unknownMethod(error)) throw outdated(target, 'Reviewing a task\'s changes')
      throw error
    }
  }

  async setSourceControl(projectId: string, enabled: boolean): Promise<SourceControlStatus> {
    const target = this.deps.resolve(projectId)
    try {
      const status = record(await this.call(target, 'tasks.sourceControl', { enabled: enabled === true }))
      return { ...(status as unknown as SourceControlStatus), projectId: target.localProjectId, available: status.available === true, enabled: status.enabled === true }
    } catch (error) {
      if (unknownMethod(error)) throw outdated(target, 'Repository links')
      throw error
    }
  }

  /**
   * Nothing to dispatch to from here. Dispatching opens agents on the host under the host's own
   * permission rules, which the remote tab path enforces and the task dispatcher does not; until it
   * is carried over, the pane offers no targets rather than throwing when it asks.
   */
  dispatchOptions(projectId: string): ProjectTaskDispatchOptions {
    this.deps.resolve(projectId)
    return { workspaces: [], targets: [], providers: [] }
  }

  dispatch(projectId: string): never {
    const target = this.deps.resolve(projectId)
    throw new RemoteProjectError(target.machineName, 'Dispatching a task',
      `This project lives on ${target.machineName}. Dispatch its tasks from a tab you open in it, or from ${target.machineName}.`)
  }

  /**
   * Renames the project's folder on the host, as the owner renaming it there would, and brings
   * this computer's row up to date from the host's answer rather than from the name typed here.
   */
  async rename(projectId: string, name: string): Promise<ProjectRecord> {
    const target = this.deps.resolve(projectId)
    const requested = String(name ?? '').trim()
    if (!requested) throw new Error('Name the project.')
    let answer: unknown
    try { answer = await this.call(target, 'projects.rename', { name: requested }) }
    catch (error) {
      if (unknownMethod(error)) throw outdated(target, 'Renaming the project')
      throw error
    }
    const summary = readRemoteProjectSummaries([answer])[0]
    if (!summary || summary.id !== target.remoteProjectId) throw new Error(`${target.machineName} renamed the project but did not say what it is called now.`)
    const row = this.deps.adopt(target, summary)
    if (!row) throw new Error(`${target.machineName} renamed the project but it could not be refreshed here.`)
    this.deps.changed?.(target, 'project')
    return row
  }
}
