import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../../../shared/models'
import type { MachineConnection, MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { remoteExplorerView } from './remote-project-tree'

const at = '2026-09-16T00:00:00.000Z'
const local: ProjectRecord = { id: 'project', name: 'Conductor', path: 'C:/here', createdAt: at, updatedAt: at }
const remote: ProjectRecord = {
  ...local, id: 'remote-project',
  remote: { machineId: 'main-box', machineName: 'MAIN', remoteProjectId: 'project_9', path: 'C:/there' }
}
const here: MachineDescriptor = { id: LOCAL_MACHINE_ID, name: 'This laptop', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION }
const host = (connection: Partial<MachineConnection> = {}, status: MachineDescriptor['status'] = 'online'): MachineDescriptor => ({
  id: 'main-box', name: 'MAIN', kind: 'peer', status, accountLogin: 'owner', projects: [],
  connection: { state: 'connected', path: 'unknown', transport: null, failure: null, detail: null, generation: 1, ...connection }
})

describe('what the explorer shows for one project row', () => {
  it('leaves a project on this computer entirely alone', () => {
    expect(remoteExplorerView(local, [here, host()])).toEqual({ kind: 'local' })
    expect(remoteExplorerView(null, [here])).toEqual({ kind: 'local' })
    expect(remoteExplorerView({ remote: undefined }, [here])).toEqual({ kind: 'local' })
  })

  it('browses the host, keyed by the host\u2019s own project id rather than ours', () => {
    const view = remoteExplorerView(remote, [here, host()])
    expect(view).toMatchObject({ kind: 'remote', machineId: 'main-box', machineName: 'MAIN' })
    // Our id is private to this computer; naming it to MAIN would ask about a project it has
    // never heard of.
    expect(view).toMatchObject({ projectId: 'project_9' })
    expect(view.kind === 'remote' && view.badge.label).toBe('Remote: MAIN')
  })

  it('is unavailable, not an error, while the owner is using this computer independently', () => {
    const view = remoteExplorerView(remote, [here, host({ state: 'detached' })])
    expect(view.kind).toBe('unavailable')
    expect(view.kind === 'unavailable' && view.message).toMatch(/until you attach again/)
    expect(view.kind === 'unavailable' && view.badge.label).toBe('MAIN unavailable')
  })

  it('is unavailable when the host cannot be reached, and says which kind of failure it is', () => {
    const view = remoteExplorerView(remote, [here, host({ state: 'offline', failure: 'host-not-running' }, 'offline')])
    expect(view.kind).toBe('unavailable')
    expect(view.kind === 'unavailable' && view.message).toMatch(/host not running/)
  })

  it('is unavailable rather than local when the pairing is gone entirely', () => {
    // The dangerous fallback would be browsing this computer's folder of the same path instead.
    const view = remoteExplorerView(remote, [here])
    expect(view.kind).toBe('unavailable')
    expect(view.kind === 'unavailable' && view.message).toMatch(/no longer paired/)
  })

  it('never reports local for a project that lives elsewhere, whatever the machine list says', () => {
    for (const machines of [[], [here], [here, host({ state: 'detached' })], [here, host({}, 'revoked')]]) {
      expect(remoteExplorerView(remote, machines).kind).not.toBe('local')
    }
  })

  it('still names the machine when the host name was never recorded', () => {
    const nameless = { remote: { machineId: 'main-box', machineName: '', remoteProjectId: 'p', path: 'C:/x' } }
    const view = remoteExplorerView(nameless, [here])
    expect(view.kind === 'unavailable' && view.machineName).toBe('another machine')
  })
})
