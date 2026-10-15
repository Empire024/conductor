import { describe, expect, it, vi } from 'vitest'
import type { ProjectRecord } from '../shared/models'
import type { RemoteProjectSummary } from '../shared/remote-control'
import { RemoteProjectError, routeProject } from './project-scope'
import { RemoteProjectActions, type RemoteProjectTarget } from './remote-project-actions'

/**
 * A "Remote: MAIN" project on the laptop. Its row here has this computer's id (`row-main-app`);
 * MAIN's own id for it (`main-app`) is what its origin records and what the launcher, file tree and
 * terminals send. Every action below must work by either id and must reach MAIN by MAIN's id only.
 */
const at = '2026-10-16T00:00:00.000Z'
const identity = { key: 'k'.repeat(32), keyCreatedAt: at, path: 'C:/Claude/app', name: 'App' }
const remoteRow: ProjectRecord = {
  id: 'row-main-app', name: 'App', path: 'C:/Claude/app', createdAt: at, updatedAt: at,
  remote: { machineId: 'main', machineName: 'MAIN', remoteProjectId: 'main-app', path: 'C:/Claude/app', identity }
}
const localRow: ProjectRecord = { id: 'here', name: 'Here', path: 'C:/Here', createdAt: at, updatedAt: at }
const rows = [remoteRow, localRow]
const lookup = { getProject: (id: string) => rows.find(row => row.id === id) ?? null, listProjects: () => rows }

const hostBoard = (revision = 'rev-1') => ({
  projectId: 'main-app', path: 'feature-list.md', revision,
  tasks: [{ id: 'one', title: 'From MAIN', kind: 'task', status: 'todo', priority: 'normal', weight: 'medium', line: 1, activity: [] }],
  owners: [], sourceControl: { projectId: 'main-app', available: true, enabled: true, branch: 'main' },
  page: { offset: 0, limit: 20, total: 1, hasMore: false }
})

function fixture(answer: (method: string, args: Record<string, unknown>) => unknown = () => hostBoard()) {
  const calls: Array<{ machineId: string; method: string; args: Record<string, unknown> }> = []
  const adopted: RemoteProjectSummary[] = []
  const changed = vi.fn()
  const actions = new RemoteProjectActions({
    // What RemoteControlService.remoteProjectTarget does, minus the pairing: the shared resolver.
    resolve: (projectId): RemoteProjectTarget => {
      const route = routeProject(lookup, projectId)
      if (route.kind === 'local') throw new Error('is a project on this computer')
      return { localProjectId: route.project.id, remoteProjectId: route.remoteProjectId, machineId: route.machineId, machineName: route.machineName }
    },
    call: async (machineId, method, args) => { calls.push({ machineId, method, args }); return answer(method, args) },
    adopt: (_target, summary) => { adopted.push(summary); return { ...remoteRow, name: summary.name, path: summary.path } },
    changed
  })
  return { actions, calls, adopted, changed }
}

describe('the task list of a project that lives on MAIN', () => {
  for (const id of ['row-main-app', 'main-app']) {
    it(`opens from MAIN's own task list when named by ${id === 'main-app' ? "MAIN's id" : "this computer's id"}`, async () => {
      const f = fixture()
      const board = await f.actions.tasks(id, { includeDone: false, includeArchived: false, offset: 0, limit: 20 })
      expect(f.calls).toEqual([{ machineId: 'main', method: 'tasks.list', args: { includeDone: false, includeArchived: false, offset: 0, limit: 20, projectId: 'main-app' } }])
      // The renderer keys its state by its own row and must never see MAIN's id for it.
      expect(board.projectId).toBe('row-main-app')
      expect(board.sourceControl.projectId).toBe('row-main-app')
      expect(board.tasks[0]?.title).toBe('From MAIN')
    })
  }

  it('lists by MAIN\'s id even when a caller smuggles another project id into the query', async () => {
    const f = fixture()
    await f.actions.tasks('row-main-app', { query: 'bug', kind: 'bug', projectId: 'someone-else' } as never)
    expect(f.calls[0]?.args.projectId).toBe('main-app')
  })

  it('updates a task on MAIN with the pane\'s own edit and answers MAIN\'s board', async () => {
    const f = fixture(() => hostBoard('rev-2'))
    const board = await f.actions.editTask('main-app', 'rev-1', { type: 'update', id: 'one', status: 'done' }, { includeDone: true })
    expect(f.calls).toEqual([{ machineId: 'main', method: 'tasks.edit', args: { revision: 'rev-1', edit: { type: 'update', id: 'one', status: 'done' }, query: { includeDone: true, includeArchived: false }, projectId: 'main-app' } }])
    expect(board).toMatchObject({ projectId: 'row-main-app', revision: 'rev-2' })
    expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ localProjectId: 'row-main-app' }), 'tasks')
  })

  it('adds and removes tasks on MAIN', async () => {
    const f = fixture()
    await f.actions.editTask('row-main-app', 'rev-1', { type: 'add', title: 'New', kind: 'bug', priority: 'high', weight: 'light' })
    await f.actions.editTask('row-main-app', 'rev-1', { type: 'remove', id: 'one' })
    expect(f.calls.map(call => [call.method, (call.args.edit as { type: string }).type])).toEqual([['tasks.edit', 'add'], ['tasks.edit', 'remove']])
  })

  it('still adds and moves tasks on a MAIN that predates tasks.edit, and says to update it for the rest', async () => {
    const f = fixture(method => {
      if (method === 'tasks.edit' || method === 'tasks.changes') throw new Error('Unknown remote method; use tools.list.')
      return hostBoard()
    })
    await f.actions.editTask('row-main-app', 'rev-1', { type: 'add', title: 'New', kind: 'bug' })
    await f.actions.editTask('row-main-app', 'rev-1', { type: 'update', id: 'one', status: 'doing' })
    expect(f.calls.map(call => call.method)).toEqual(['tasks.edit', 'tasks.create', 'tasks.list', 'tasks.edit', 'tasks.update', 'tasks.list'])
    expect(f.calls[1]?.args).toEqual({ revision: 'rev-1', title: 'New', kind: 'bug', projectId: 'main-app' })
    expect(f.calls[4]?.args).toEqual({ revision: 'rev-1', id: 'one', status: 'doing', projectId: 'main-app' })
    await expect(f.actions.editTask('row-main-app', 'rev-1', { type: 'remove', id: 'one' })).rejects.toThrow(/older Conductor.*Update Conductor on MAIN/)
    await expect(f.actions.taskChanges('row-main-app', 'one')).rejects.toBeInstanceOf(RemoteProjectError)
  })

  it('passes MAIN\'s own refusal through rather than retrying it some other way', async () => {
    const f = fixture(() => { throw new Error('The task list changed on disk. Your edit was not saved; refresh and try again.') })
    await expect(f.actions.editTask('row-main-app', 'stale', { type: 'remove', id: 'one' })).rejects.toThrow(/changed on disk/)
    expect(f.calls.map(call => call.method)).toEqual(['tasks.edit'])
  })

  it('reads a task\'s changes and toggles repository links on MAIN', async () => {
    const f = fixture(method => method === 'tasks.changes' ? { taskId: 'one', commits: [], files: [] } : { projectId: 'main-app', available: true, enabled: false })
    await expect(f.actions.taskChanges('main-app', 'one')).resolves.toMatchObject({ taskId: 'one' })
    await expect(f.actions.setSourceControl('row-main-app', false)).resolves.toEqual({ projectId: 'row-main-app', available: true, enabled: false })
    expect(f.calls.map(call => [call.method, call.args.projectId])).toEqual([['tasks.changes', 'main-app'], ['tasks.sourceControl', 'main-app']])
  })

  it('offers nothing to dispatch to, and refuses dispatching with a sentence that names MAIN', async () => {
    const f = fixture()
    expect(f.actions.dispatchOptions('main-app')).toEqual({ workspaces: [], targets: [], providers: [] })
    expect(() => f.actions.dispatch('row-main-app')).toThrow(/lives on MAIN/)
    expect(f.calls).toEqual([])
  })

  it('refuses a malformed answer from MAIN instead of handing it to the pane', async () => {
    const f = fixture(() => ({ tasks: 'nope' }))
    await expect(f.actions.tasks('row-main-app')).rejects.toThrow(/invalid task list/)
  })

  it('never forwards a project of this computer\'s own', async () => {
    const f = fixture()
    await expect(f.actions.tasks('here')).rejects.toThrow(/on this computer/)
    expect(f.calls).toEqual([])
  })
})

describe('renaming a project that lives on MAIN', () => {
  const renamed = { id: 'main-app', name: 'Renamed', path: 'C:/Claude/Renamed', identity: { ...identity, path: 'C:/Claude/Renamed', name: 'Renamed' }, identityError: null }

  for (const id of ['row-main-app', 'main-app']) {
    it(`renames MAIN's folder and refreshes this row from MAIN's answer (named by ${id})`, async () => {
      const f = fixture(() => renamed)
      const row = await f.actions.rename(id, '  Renamed ')
      expect(f.calls).toEqual([{ machineId: 'main', method: 'projects.rename', args: { name: 'Renamed', projectId: 'main-app' } }])
      expect(f.adopted.map(summary => summary.path)).toEqual(['C:/Claude/Renamed'])
      expect(row).toMatchObject({ id: 'row-main-app', name: 'Renamed' })
      expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'main' }), 'project')
    })
  }

  it('refuses an answer about a different project than the one it asked to rename', async () => {
    const f = fixture(() => ({ ...renamed, id: 'some-other-project' }))
    await expect(f.actions.rename('row-main-app', 'Renamed')).rejects.toThrow(/did not say/)
    expect(f.adopted).toEqual([])
  })

  it('asks for a name before it asks MAIN anything', async () => {
    const f = fixture(() => renamed)
    await expect(f.actions.rename('row-main-app', '   ')).rejects.toThrow(/Name the project/)
    expect(f.calls).toEqual([])
  })

  it('says to update MAIN when MAIN cannot rename from here yet', async () => {
    const f = fixture(() => { throw new Error('Unknown remote method; use tools.list.') })
    await expect(f.actions.rename('row-main-app', 'Renamed')).rejects.toThrow(/Update Conductor on MAIN/)
  })
})
