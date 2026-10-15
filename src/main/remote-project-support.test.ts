import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../shared/models'
import { REMOTE_PROJECT_CHANNELS, offeredForRemoteProject, remoteProjectChannel } from '../shared/remote-project-support'
import { RemoteProjectError, findProjectRecord, localProject, routeProject } from './project-scope'
import { RemoteProjectActions } from './remote-project-actions'

/**
 * The whole class of "Error invoking remote method" in a "Remote: MAIN" project, pinned down.
 *
 * Each project-scoped handler in main used to make its own decision about a project that lives on a
 * paired machine, and most of them made it by accident: they looked the id up among this
 * computer's row ids only and refused anything remote, while the renderer offered the action anyway.
 * This test makes the decision explicit and complete:
 *
 * 1. every project-scoped handler in src/main/index.ts is listed in REMOTE_PROJECT_CHANNELS;
 * 2. every `host` entry is wired to the forwarded actions and reaches MAIN by MAIN's own id,
 *    whichever of the project's two ids it was called with;
 * 3. every entry that is refused for a remote project is refused as "that runs on MAIN" for both
 *    ids - never as "Project not found", which is what a host id used to produce.
 */
const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Each `ipcMain.handle('channel', ...)` in index.ts with the source up to the next registration. */
const handlers = (): Array<{ channel: string; body: string }> => {
  const found: Array<{ channel: string; body: string }> = []
  const pattern = /ipcMain\.(?:handle|on)\(\s*'([^']+)'/g
  const matches = [...source.matchAll(pattern)]
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.index ?? Math.min(source.length, match.index! + 4000)
    // A handler's body is indented past the registration; the next statement at that depth (a
    // registered module's wiring, say) is not part of it.
    const body = source.slice(match.index!, end).split(/\r?\n  (?![ })\]])/)[0]!
    found.push({ channel: match[1]!, body })
  })
  return found
}

/** What marks a handler as project-scoped: it reaches a project's disk, or forwards it. */
const PROJECT_SCOPED = /\b(?:localProject|requireLocalProject|resolveProjectPath|resolveExistingProjectPath|resolveEditorPath|remoteProjectActions|findProjectRecord)\(/

const at = '2026-10-16T00:00:00.000Z'
const remoteRow: ProjectRecord = {
  id: 'row-main-app', name: 'App', path: 'C:/Claude/app', createdAt: at, updatedAt: at,
  remote: { machineId: 'main', machineName: 'MAIN', remoteProjectId: 'main-app', path: 'C:/Claude/app' }
}
const localRow: ProjectRecord = { id: 'here', name: 'Here', path: 'C:/Here', createdAt: at, updatedAt: at }
const lookup = { getProject: (id: string) => [remoteRow, localRow].find(row => row.id === id) ?? null, listProjects: () => [remoteRow, localRow] }
const BOTH_IDS = ['row-main-app', 'main-app'] as const

/** How each `host` channel is driven through the forwarded actions, as its handler does. */
const DRIVERS: Record<string, (actions: RemoteProjectActions, projectId: string) => unknown> = {
  'projects:rename': (actions, id) => actions.rename(id, 'Renamed'),
  'project-tasks:get': (actions, id) => actions.tasks(id),
  'project-tasks:edit': (actions, id) => actions.editTask(id, 'rev-1', { type: 'remove', id: 'one' }),
  'project-tasks:changes': (actions, id) => actions.taskChanges(id, 'one'),
  'project-tasks:set-source-control': (actions, id) => actions.setSourceControl(id, true)
}

function forwarded(): { actions: RemoteProjectActions; calls: Array<{ machineId: string; method: string; projectId: unknown }> } {
  const calls: Array<{ machineId: string; method: string; projectId: unknown }> = []
  const actions = new RemoteProjectActions({
    resolve: projectId => {
      const route = routeProject(lookup, projectId)
      if (route.kind !== 'remote') throw new Error('local')
      return { localProjectId: route.project.id, remoteProjectId: route.remoteProjectId, machineId: route.machineId, machineName: route.machineName }
    },
    call: async (machineId, method, args) => {
      calls.push({ machineId, method, projectId: args.projectId })
      if (method === 'projects.rename') return { id: 'main-app', name: 'Renamed', path: 'C:/Claude/Renamed', identity: { key: 'k'.repeat(32), keyCreatedAt: at, path: 'C:/Claude/Renamed', name: 'Renamed' }, identityError: null }
      if (method === 'tasks.changes') return { taskId: 'one', commits: [], files: [] }
      if (method === 'tasks.sourceControl') return { projectId: 'main-app', available: true, enabled: true }
      return { projectId: 'main-app', revision: 'rev-2', tasks: [], owners: [], sourceControl: { projectId: 'main-app', available: false, enabled: false } }
    },
    adopt: (_target, summary) => ({ ...remoteRow, name: summary.name })
  })
  return { actions, calls }
}

describe('every project-scoped handler decides what a Remote: MAIN project gets', () => {
  it('finds project-scoped handlers to check at all', () => {
    expect(handlers().filter(handler => PROJECT_SCOPED.test(handler.body)).length).toBeGreaterThan(25)
  })

  it('lists every project-scoped handler in main, so none can refuse a remote project by accident', () => {
    const unlisted = handlers()
      .filter(handler => PROJECT_SCOPED.test(handler.body))
      .map(handler => handler.channel)
      .filter(channel => !remoteProjectChannel(channel))
    expect(unlisted).toEqual([])
  })

  it('lists every registered module whose one guard refuses remote projects', () => {
    const guarded = [...source.matchAll(/authorize: \(event, projectId\) => \{[^}]*requireLocalProject\(database, [^,]+, '([^']+)'\)/g)].map(match => match[1]!)
    expect(guarded.length).toBeGreaterThan(5)
    const listed = new Set(Object.values(REMOTE_PROJECT_CHANNELS).filter(entry => entry.handling === 'local-only').map(entry => entry.feature))
    expect(guarded.filter(feature => !listed.has(feature))).toEqual([])
  })

  const hosted = Object.entries(REMOTE_PROJECT_CHANNELS).filter(([, entry]) => entry.handling === 'host')
  it.each(hosted)('%s is wired to the host in main', channel => {
    const handler = handlers().find(entry => entry.channel === channel)
    expect(handler, `${channel} is registered in index.ts`).toBeDefined()
    expect(handler!.body).toMatch(/remoteProjectActions\(/)
    expect(DRIVERS[channel], `${channel} has a driver in this test`).toBeDefined()
  })

  for (const [channel] of hosted) {
    for (const id of BOTH_IDS) {
      it(`${channel} reaches MAIN by MAIN's own id when named by ${id}`, async () => {
        const { actions, calls } = forwarded()
        await DRIVERS[channel]!(actions, id)
        expect(calls.length).toBeGreaterThan(0)
        expect(calls.every(call => call.machineId === 'main' && call.projectId === 'main-app')).toBe(true)
      })
    }
  }

  const refused = Object.entries(REMOTE_PROJECT_CHANNELS).filter(([, entry]) => entry.handling === 'local-only' || entry.handling === 'counterpart')
  for (const [channel, entry] of refused) {
    for (const id of BOTH_IDS) {
      it(`${channel} is refused as "${entry.feature} runs on MAIN" when named by ${id}, never as a missing project`, () => {
        let error: unknown
        try { localProject(lookup, id, entry.feature) } catch (reason) { error = reason }
        expect(error).toBeInstanceOf(RemoteProjectError)
        expect((error as Error).message).toBe(`This project lives on MAIN. ${entry.feature} runs there; it is not available from this computer yet.`)
      })
    }
  }

  it('names each refused handler\'s feature the way its own guard does', () => {
    const mismatched: string[] = []
    for (const handler of handlers()) {
      const entry = REMOTE_PROJECT_CHANNELS[handler.channel]
      if (!entry || entry.handling === 'host') continue
      const guard = /\b(?:localProject|requireLocalProject)\(database, [^,]+, '([^']+)'\)/.exec(handler.body)
      if (guard && guard[1] !== entry.feature && !Object.values(REMOTE_PROJECT_CHANNELS).some(other => other.feature === guard[1])) mismatched.push(`${handler.channel}: ${guard[1]}`)
    }
    expect(mismatched).toEqual([])
  })

  it('withholds only local-only actions from a remote project in the renderer', () => {
    expect(offeredForRemoteProject('projects:rename')).toBe(true)
    expect(offeredForRemoteProject('project-tasks:get')).toBe(true)
    expect(offeredForRemoteProject('files:list')).toBe(true)
    expect(offeredForRemoteProject('projects:move')).toBe(false)
    expect(offeredForRemoteProject('projects:reveal')).toBe(false)
    expect(offeredForRemoteProject('schedules:snapshot')).toBe(false)
    expect(offeredForRemoteProject('delivery:status')).toBe(false)
  })

  it('resolves the rows that the remove and forwarding paths act on by either id', () => {
    for (const id of BOTH_IDS) expect(findProjectRecord(lookup, id)?.id).toBe('row-main-app')
    expect(findProjectRecord(lookup, 'here')?.id).toBe('here')
  })
})
