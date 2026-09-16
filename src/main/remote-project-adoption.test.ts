import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../shared/models'
import type { RemoteProjectSummary } from '../shared/remote-control'
import type { ProjectIdentity, RemoteProjectGrant } from '../shared/project-identity'
import { adoptRemoteProject, adoptRemoteProjects, type RemoteProjectAdoptionDependencies } from './remote-project-adoption'

const at = '2026-09-16T00:00:00.000Z'
const identity = (key: string, path: string, name: string, createdAt = '2026-01-01T00:00:00.000Z'): ProjectIdentity =>
  ({ key: key.repeat(32).slice(0, 32), keyCreatedAt: createdAt, path, name })

const summary = (id: string, name: string, path: string, value: ProjectIdentity | null): RemoteProjectSummary =>
  ({ id, name, path, identity: value, identityError: value ? null : 'MAIN cannot read that project identity.' })

/**
 * A stand-in for the two things adoption touches: this computer's project list and the grants
 * recorded against a paired machine. Both behave the way the real ones do for the cases that
 * matter - one row per host project, and a grant that replaces the one it is written over.
 */
function fixture(options: { dismissed?: Array<[string, string]> } = {}) {
  const projects: ProjectRecord[] = []
  const grants = new Map<string, RemoteProjectGrant>()
  const confirmed: RemoteProjectGrant[] = []
  const desk: string[] = []
  const dismissed = new Set((options.dismissed ?? []).map(([machineId, projectId]) => `${machineId}:${projectId}`))
  let sequence = 0
  const deps: RemoteProjectAdoptionDependencies = {
    listProjects: () => projects.map(project => ({ ...project })),
    addRemoteProject: request => {
      const key = `${request.remote.machineId}:${request.remote.remoteProjectId}`
      const existing = projects.find(project => project.remote && `${project.remote.machineId}:${project.remote.remoteProjectId}` === key)
      if (existing) {
        existing.name = request.name
        existing.remote = { ...request.remote }
        return { ...existing }
      }
      const record: ProjectRecord = { id: `project_${++sequence}`, name: request.name, path: key, createdAt: at, updatedAt: at, remote: { ...request.remote } }
      projects.push(record)
      return { ...record }
    },
    includeInDesk: projectId => { desk.push(projectId) },
    isDismissed: (machineId, remoteProjectId) => dismissed.has(`${machineId}:${remoteProjectId}`),
    grantFor: (machineId, localProjectId) => grants.get(`${machineId}:${localProjectId}`),
    confirmProject: (machineId, grant) => { grants.set(`${machineId}:${grant.localProjectId}`, grant); confirmed.push(grant) }
  }
  return { deps, projects, grants, confirmed, desk, dismiss: (machineId: string, projectId: string) => dismissed.add(`${machineId}:${projectId}`) }
}

const MAIN = [
  summary('p1', 'Conductor', 'C:/Claude/conductor', identity('a', 'C:/Claude/conductor', 'Conductor')),
  summary('p2', 'Renders', 'C:/Claude/renders', identity('b', 'C:/Claude/renders', 'Renders'))
]

describe('a paired machine\u2019s projects, in this computer\u2019s list', () => {
  it('appear as that machine\u2019s projects, with no project here standing in for them', () => {
    const fix = fixture()
    const result = adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', MAIN)
    expect(result.changed).toBe(true)
    expect(result.adopted.map(project => project.name)).toEqual(['Conductor', 'Renders'])
    expect(fix.projects.every(project => project.remote?.machineId === 'main-box')).toBe(true)
    // A desk saved with an explicit project list shows only those, so an adopted project has to be
    // put on it or it would arrive in a list the owner cannot see.
    expect(fix.desk).toEqual(result.adopted.map(project => project.id))
    // The grant maps the adopted row onto the host's own project id - never onto a local project.
    expect(fix.confirmed.map(grant => grant.remoteProjectId)).toEqual(['p1', 'p2'])
    expect(fix.confirmed.map(grant => grant.localProjectId)).toEqual(result.adopted.map(project => project.id))
  })

  it('are adopted once, not once per probe, so calls in flight are not cancelled every minute', () => {
    const fix = fixture()
    adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', MAIN)
    const again = adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', MAIN)
    expect(again.changed).toBe(false)
    expect(fix.projects).toHaveLength(2)
    expect(fix.confirmed).toHaveLength(2)
  })

  it('follow a project the host renamed or moved, rather than appearing twice', () => {
    const fix = fixture()
    adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', MAIN)
    const moved = summary('p1', 'Conductor (moved)', 'D:/work/conductor', identity('a', 'D:/work/conductor', 'Conductor'))
    const result = adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', [moved, MAIN[1]!])
    expect(result.changed).toBe(true)
    expect(fix.projects).toHaveLength(2)
    expect(fix.projects[0]).toMatchObject({ name: 'Conductor (moved)', remote: { path: 'D:/work/conductor' } })
    expect(fix.confirmed).toHaveLength(3)
    expect(fix.confirmed.at(-1)).toMatchObject({ remoteProjectId: 'p1', remote: { path: 'D:/work/conductor' } })
  })

  it('skip a project whose identity that machine cannot read, rather than adopting a blank one', () => {
    const fix = fixture()
    const result = adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', [summary('p3', 'Unreadable', 'C:/x', null), ...MAIN])
    expect(result.adopted.map(project => project.name)).toEqual(['Conductor', 'Renders'])
    expect(fix.projects.some(project => project.name === 'Unreadable')).toBe(false)
    expect(adoptRemoteProject(fix.deps, 'main-box', 'MAIN', summary('p3', 'Unreadable', 'C:/x', null))).toBeNull()
  })

  it('stay off the list once the owner removes one, however many times that machine is reached', () => {
    const fix = fixture({ dismissed: [['main-box', 'p2']] })
    const result = adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', MAIN)
    expect(result.adopted.map(project => project.name)).toEqual(['Conductor'])
    adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', MAIN)
    expect(fix.projects).toHaveLength(1)
  })

  it('keep two machines\u2019 projects apart, even when both share the same folder and id', () => {
    const fix = fixture()
    adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', [MAIN[0]!])
    adoptRemoteProjects(fix.deps, 'studio', 'Studio', [MAIN[0]!])
    expect(fix.projects).toHaveLength(2)
    expect(fix.projects.map(project => project.remote?.machineName)).toEqual(['MAIN', 'Studio'])
  })

  it('reports no change when a machine shares nothing, so nothing is redrawn', () => {
    const fix = fixture()
    expect(adoptRemoteProjects(fix.deps, 'main-box', 'MAIN', []).changed).toBe(false)
  })
})
