import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../shared/models'
import { RemoteProjectError, isRemoteProject, localProject, requireLocalProject, requireLocalProjectIfGiven } from './project-scope'

const at = '2026-09-16T00:00:00.000Z'
const local: ProjectRecord = { id: 'here', name: 'Conductor', path: 'C:/Claude/conductor', createdAt: at, updatedAt: at }
const remote: ProjectRecord = {
  id: 'there', name: 'Conductor', path: 'C:/Claude/conductor', createdAt: at, updatedAt: at,
  remote: { machineId: 'main-box', machineName: 'MAIN', remoteProjectId: 'project_9', path: 'C:/Claude/conductor' }
}
const lookup = { getProject: (id: string): ProjectRecord | null => id === 'here' ? local : id === 'there' ? remote : null }

describe('scoping a project to the computer that owns it', () => {
  it('recognises a project that lives on another machine, and only by its origin', () => {
    expect(isRemoteProject(remote)).toBe(true)
    expect(isRemoteProject(local)).toBe(false)
    expect(isRemoteProject(null)).toBe(false)
    // A path that happens to match a host's path is not a remote project, and never becomes one.
    expect(isRemoteProject({ remote: undefined })).toBe(false)
  })

  it('returns the record for a project that really is on this computer', () => {
    expect(localProject(lookup, 'here', 'Git')).toBe(local)
  })

  it('refuses local work for a remote project instead of doing it on this disk', () => {
    expect(() => localProject(lookup, 'there', 'Git')).toThrow(RemoteProjectError)
    try { localProject(lookup, 'there', 'Git') } catch (reason) {
      const error = reason as RemoteProjectError
      expect(error.message).toBe('This project lives on MAIN. Git runs there; it is not available from this computer yet.')
      expect(error.machineName).toBe('MAIN')
      expect(error.feature).toBe('Git')
      expect(error.code).toBe('remote-project')
      // `name` is what survives the structured clone across IPC, so the renderer can still tell.
      expect(error.name).toBe('RemoteProjectError')
    }
  })

  it('never falls back to the local path even though the two paths are identical', () => {
    expect(remote.path).toBe(local.path)
    expect(() => localProject(lookup, 'there', 'Terminals')).toThrow(/lives on MAIN/)
  })

  it('tells a missing project apart from a remote one', () => {
    expect(() => localProject(lookup, 'nowhere')).toThrow('Project not found')
    expect(() => localProject(lookup, 'nowhere')).not.toThrow(RemoteProjectError)
  })

  it('guards without the record, and lets an absent project id through', () => {
    expect(() => requireLocalProject(lookup, 'there', 'Snapshots')).toThrow(/Snapshots runs there/)
    expect(() => requireLocalProject(lookup, 'here', 'Snapshots')).not.toThrow()
    expect(() => requireLocalProjectIfGiven(lookup, null, 'Memory')).not.toThrow()
    expect(() => requireLocalProjectIfGiven(lookup, '', 'Memory')).not.toThrow()
    expect(() => requireLocalProjectIfGiven(lookup, 'there', 'Memory')).toThrow(/Memory runs there/)
  })

  it('still names somewhere when the host name was never recorded', () => {
    const nameless = { getProject: (): ProjectRecord => ({ ...remote, remote: { machineId: 'm', machineName: '', remoteProjectId: 'p', path: 'C:/x' } }) }
    expect(() => localProject(nameless, 'there', 'Git')).toThrow('This project lives on the other machine. Git runs there; it is not available from this computer yet.')
  })
})
